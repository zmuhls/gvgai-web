# Legion vLLM serving runbook

The Legion (Linux, CUDA, 24 GB VRAM) serves **one Gemma-3-4B base + up to five LoRA
adapters**, hot-swappable per request via vLLM's OpenAI-compatible API. Each arcade room
selects its adapter by the `model` field. This is the serving half of the fine-tune loop;
the training half is in `../FINETUNE.md`.

**Identity that ties it together:** `vLLM --lora-modules NAME=/path` **NAME** == request
`model` == arcade registry `id` (e.g. `gvgai`, `cloze-reader`, `jeopardy-lm`, `haggle`,
`exquisite-corpse`).

## Day 0 — bring-up

```bash
# on the Legion
sudo mkdir -p /srv/legion /srv/adapters && sudo chown "$USER" /srv/legion /srv/adapters
scp web/scripts/legion/{bootstrap.sh,serve-vllm.sh,vllm.service} legion:/srv/legion/   # from the Mac

bash /srv/legion/bootstrap.sh          # venv + vllm + warm the base model cache
bash /srv/legion/serve-vllm.sh         # foreground smoke test (base only is fine)
```

Verify from the Mac (over Tailscale):

```bash
curl http://<legion>.<tailnet>.ts.net:8000/v1/models          # lists base + any adapters
curl http://<legion>.<tailnet>.ts.net:8000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"unsloth/gemma-3-4b-it","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'
```

Point the arcade at it (on the Mac): set `LEGION_VLLM_URL` in `web/.env`:

```
LEGION_VLLM_URL=http://<legion>.<tailnet>.ts.net:8000/v1/chat/completions
```

### HTTPS for the browser-direct room (JeopardyLM static build)

```bash
# on the Legion — publishes vLLM as https://<legion>.<tailnet>.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:8000
```

Use the `https://…ts.net` origin for Jeopardy's static build to avoid mixed-content; the
local `pages/api/llm.ts` proxy avoids CORS entirely for the `npm run dev` demo.

## Train an adapter so it lands where the server looks

Run training with `--output-dir /srv/adapters --model-id <name>` so the PEFT adapter is
written directly to `/srv/adapters/<name>/lora` (exactly what `serve-vllm.sh` discovers):

```bash
# on the Legion, in the TRAINING venv (~/gvgai-ft, see ../FINETUNE.md)
python3 finetune.py --data <game>-train.jsonl \
  --game-id 0 --game-name gvgai --run-id legion-$(date +%s) \
  --provider legion-vllm --model-id gvgai --no-gguf \
  --output-dir /srv/adapters --registry finetune-models.json
```

New flags (added for this path): `--provider legion-vllm` (registry routing),
`--model-id <name>` (stable adapter name), `--no-gguf` (vLLM loads the PEFT dir directly —
skips the multi-minute GGUF merge).

## Add an adapter without restarting

```bash
curl http://<legion>.<tailnet>.ts.net:8000/v1/load_lora_adapter \
  -H 'content-type: application/json' \
  -d '{"lora_name":"cloze-reader","lora_path":"/srv/adapters/cloze-reader/lora"}'
```

(`serve-vllm.sh` sets `VLLM_ALLOW_RUNTIME_LORA_UPDATING=1`, which this requires.) A restart
also picks up every adapter present, since discovery is directory-based.

## Persistence

Edit `User=` in `vllm.service`, then:

```bash
sudo cp /srv/legion/vllm.service /etc/systemd/system/vllm.service
sudo systemctl daemon-reload && sudo systemctl enable --now vllm
journalctl -u vllm -f     # per-request LoRA selection shows here
```

## Routing check (proves adapters differ)

```bash
for m in gvgai cloze-reader jeopardy-lm; do
  echo "== $m =="
  curl -s http://<legion>.<tailnet>.ts.net:8000/v1/chat/completions \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":16}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["choices"][0]["message"]["content"])'
done
```
