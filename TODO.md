# TODO — SLM roster, traces, guardrail (2026-07-05)

## Done

- [x] **Import human play traces** — copied `~/Desktop/traces/arcade-trace-aliens-*.json` (3 files) into `web/data/traces/`
- [x] **Human-vs-SLM analysis** — `web/data/traces/human-vs-slm-analysis.md`: human aliens play is 80–89% fire at 2–4 decisions/s with fresh state; SLM path is 400ms-gated stale-state intent; roster notes
- [x] **Model catalog overhaul** (`web/lib/models.js`) — open-weight, non-reasoning, Ollama Cloud-only roster:
  - [x] gemma3:27b (featured, default), gemma3:12b (featured)
  - [x] qwen3-coder-next (only non-thinking Qwen on Ollama Cloud; ~80B MoE)
  - [x] ministral-3:14b / 8b / 3b, devstral-small-2:24b
  - [x] removed residue big models (gpt-oss:120b, deepseek-v3.1:671b, qwen3-coder:480b), OpenRouter frontier entries (gemini-2.5-flash, gpt-4o, claude-sonnet-4.5), and ollama-local entries
  - [x] OpenRouter fallback slugs verified against /api/v1/models 2026-07-05 (devstral has no unambiguous slug → fallback null)
  - [x] default model moved in both homes: `web/config.json` `defaultModel` + `featured` flags; stale fallback in `lib/runtime-config.js` updated
  - [x] frontend `PREVIEW_MODELS` fallback list (`web/public/js/app.js`) updated
  - [x] tests updated: `eval-plan.test.js` featured assertions, `llm-client.test.js` model literals
- [x] **Ollama key usage guardrail** — `web/lib/usage-guardrail.js`, light rule-of-thumb caps on ollama-cloud calls:
  - [x] hourly 3000 / daily 15000 / per-session 1500, env-tunable (`OLLAMA_GUARDRAIL_HOURLY/DAILY/SESSION`), `OLLAMA_GUARDRAIL_DISABLED=1` kill switch
  - [x] hour/day buckets persisted to `web/data/usage-guardrail.json` (gitignored)
  - [x] enforced at the single Ollama Cloud request site (`llm-client.js` `callProvider`); a block skips the OpenRouter fallback (no silent spend shift), emits `llm-error`, tracks a `system`/`guardrail_block` telemetry event
  - [x] unit + integration tests in `web/test/usage-guardrail.test.js`

## Deploy

- [ ] commit + push, `railway up --service inference-arcade --detach`
- [ ] verify live: `curl https://inference-arcade.com/api/models` shows the 7-model roster; one walk-up run answers with `provider: ollama-cloud`

## Follow-ups

- [ ] **Human-trace recorder bug** — human decisions export with `tick: 0, score: 0` (export path in `web/public/js/app.js` never syncs live tick/score); also stamps the selected model id on human runs. Fix before doing tick-aligned human-vs-model comparisons.
- [ ] **Qwen slot** — revisit when Ollama Cloud hosts a small (≤31B) non-thinking Qwen; qwen3-coder-next is the placeholder representative
- [ ] **Devstral fallback** — OpenRouter only lists `mistralai/devstral-2512` (size ambiguous); add a fallback slug if a clear devstral-small appears
- [ ] **Guardrail visibility** — consider surfacing hour/day counters on the telemetry dashboard tote board
- [ ] **Code-protocol games vs gemma3** — on GV1 games (0, 4, 13, 15, 18) gemma3:27b replies in verbose prose the compact parser rejects, so actions come from the encoded-policy fallback, not the model (observed on aliens, dev run 2026-07-05). Either tune the GV1 prompt for the new roster or disable `codeProtocol.enabled` on those configs
