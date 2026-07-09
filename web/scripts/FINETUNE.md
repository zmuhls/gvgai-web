# Fine-tune runbook (Legion GPU)

The arcade captures human play traces with per-tick game state (SSO). This
runbook takes those traces through training on the Legion (NVIDIA, 24 GB VRAM)
and back into the arcade's model picker. The whole pipeline also runs
automatically via `POST /api/finetune/trigger` when the server machine has a
GPU + python env; this document is the manual path for the current split setup
(arcade on the Mac, GPU on the Legion).

## 1. Prepare training data (arcade machine)

```bash
cd web
npm run finetune:prepare -- --gameId=0        # aliens; prints stats JSON
# output: web/data/finetune/game-0-train.jsonl
```

Needs human traces with SSO for that game (play a few rounds first). Options:
`--player-type=llm|all` to include LLM traces (distillation),
`--min-examples=N` (default 20), `--max-nil-ratio=0.3`.

## 2. One-time Legion setup

```bash
python3 -m venv ~/gvgai-ft && source ~/gvgai-ft/bin/activate
pip install -r scripts/requirements.txt   # from a copy of web/scripts/
python3 -c "import torch; print(torch.cuda.is_available())"   # must print True
# GGUF export compiles llama.cpp on first use: needs cmake + gcc/clang
```

## 3. Train (Legion)

Copy `web/scripts/finetune.py` and the JSONL over, then:

```bash
python3 finetune.py \
  --data game-0-train.jsonl \
  --game-id 0 --game-name aliens \
  --run-id legion-$(date +%s) \
  --trained-on-plays <human play count from step 1 stats> \
  --registry finetune-models.json \
  --output-dir models
```

~5–15 min for Gemma 3 4B QLoRA on a handful of plays. Progress streams as JSON
lines (`train_step` carries step/loss). Outputs:
- `models/<model-id>/lora/` — the adapter
- `models/<model-id>/*.gguf` — q4_k_m export for Ollama
- `finetune-models.json` — the registry entry (`"models": [...]`)

Knobs: `--epochs 2` (default), `--max-steps N` overrides epochs,
`--base-model unsloth/gemma-3-4b-it`, `--quant q4_k_m`.

### Legion vLLM adapter path

For the model-native arcade path, train a stable adapter name and skip GGUF
export. vLLM serves the PEFT `lora/` directory directly:

```bash
python3 finetune.py \
  --data game-0-train.jsonl \
  --game-id 0 --game-name aliens \
  --run-id legion-$(date +%s) \
  --trained-on-plays <human play count from step 1 stats> \
  --registry finetune-models.json \
  --output-dir /srv/adapters \
  --provider legion-vllm \
  --model-id gvgai-aliens \
  --no-gguf
```

The server-side trigger uses the same shape when configured with:

```bash
FINETUNE_PROVIDER=legion-vllm
FINETUNE_OUTPUT_DIR=/srv/adapters
LEGION_MODEL_ID_PREFIX=gvgai
```

That keeps the adapter id equal to the vLLM request model, for example
`gvgai-aliens`.

## 4. Bring the model back to the arcade machine

```bash
# copy the model dir into the repo (gitignored)
scp -r legion:models/<model-id> web/models/
# merge the registry entry into web/data/finetune-models.json — either copy the
# file wholesale (if the Mac one is empty) or append the entry to "models": []

# load the GGUF into local Ollama and verify
node web/scripts/load-finetuned-model.js --id <model-id> --gguf web/models/<model-id>/<file>.gguf
```

Restart is not required: the catalog merges the registry on read, so the model
appears in the picker (`GET /api/models`) and routes to local Ollama
(`provider: "ollama-local"`, http://localhost:11434).

## 5. Watch it play

Pick the `gvgai-<game>-ft-*` model in the arcade picker and start the game. It
answers from local Ollama; the tote board and narration panel treat it like any
other model.

When the server-side pipeline loads a non-dry model into local Ollama, it adds
that tuned model and game to the marble-run playlist, so scored comparison uses
the existing single Java process. Manual Legion imports through this runbook do
not notify the running Node process; restart the server or trigger a server-side
load if you need the marble playlist to pick the model up automatically.

## Dry-run (no GPU, any machine)

```bash
python3 scripts/finetune.py --dry-run --data test/fixtures/finetune/sample-train.jsonl \
  --game-id 0 --game-name aliens --run-id t1 --registry /tmp/reg.json
```

Emits the full stage sequence and writes a `dryRun: true` registry entry;
stdlib only. The server-side equivalent is `POST /api/finetune/trigger` with
`{"dryRun": true}`.
