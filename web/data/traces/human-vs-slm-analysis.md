# Human play traces vs the SLM roster

Three human-play exports from the arcade frontend (aliens, level 0, `playerType: "human"`), captured 2026-07-06 and imported from `~/Desktop/traces`. This note reads them against how the LLM agent path plays the same game, and against the open-weight small-model roster in `web/lib/models.js`.

## What the traces show

| trace | duration | decisions | rate | USE | LEFT | RIGHT |
|---|---|---|---|---|---|---|
| `…1783301269632` | 55s | 109 | 2.0/s | 87 (80%) | 13 | 9 |
| `…1783301319810` | 32s | 97 | 3.0/s | 83 (86%) | 7 | 7 |
| `…1783301351461` | 24s | 95 | 3.9/s | 85 (89%) | 5 | 5 |

Human aliens play is fire-dominant and fast: 80–89% `ACTION_USE` with thin LEFT/RIGHT positioning jitter, at 2–4 decisions per second, speeding up run over run as the player learned the level. The strategy text ("pursue points, collect resources, take measured risks") had no visible effect on the input stream — humans key-mash the dominant verb and steer occasionally.

## How the SLM path differs

The LLM agent plays the same game through a different physics of decision-making (`web/lib/llm-client.js`):

- **Rate.** Walk-up live play gates LLM calls to one per ≥400ms (`MIN_LLM_INTERVAL_MS`), so the model contributes at most ~2.5 decisions/s of *new* intent — the same order as the human rate — but each decision is computed from a state ~10 ticks stale, and the tick loop replays `pendingLLMAction` (or `ACTION_NIL`) between refreshes. The human's 2–4/s inputs are all fresh; the model's are batched intent.
- **Distribution.** A human converges on the dominant verb (fire) and holds it. Models distribute actions according to the prompt: history layers, loop-detection warnings, and the closing `REASON:/ACTION:` contract push them to justify direction changes, so their action mix is flatter and more narrated. On a shooter-lane archetype like aliens the human's fire-spam is close to optimal, which is why the twitch/reactive games flatter humans and the deliberate puzzle games flatter models.
- **Modes.** Eval and marble-run cases run `synchronousActions` (each Java tick blocks on the model, 0.5–2s/tick) — a faithful but slow playthrough no human would produce. Macro plans (`PLAN: LEFT, LEFT, SHOOT`) are the middle path: the model emits a short burst of intent that drains over ticks, which is structurally the closest thing to the human's key-mash bursts visible in these traces.

## Why the roster change matters here

The previous catalog leaned on reasoning models (`gpt-oss:120b`, `deepseek-v3.1:671b`, `qwen3-coder:480b`). Those burn hidden reasoning tokens before emitting content — at arcade `maxTokens` budgets (100–320) they often returned empty `content` and fell back to the `reasoning` field, and their per-call latency sat at the slow end of the 200–2000ms band, deepening staleness.

The new roster (`gemma3:27b/12b`, `qwen3-coder-next`, `ministral-3:14b/8b/3b`, `devstral-small-2:24b`) is all non-reasoning on Ollama Cloud (no `thinking` capability): every output token is answer, `max_tokens` behaves honestly, and smaller models answer faster — which directly narrows the gap this document describes, since lower latency means fresher state per decision and more decisions surviving the 400ms gate.

What it does not change: no SLM will match the human's 4/s fire cadence with fresh state on a twitch game. The curated-featured-games approach (slow/puzzle games where staleness doesn't dominate) remains the right frame; these traces are the human baseline showing why.

## Recorder bug found in the traces

Every human decision logs `tick: 0, score: 0` across all three files, even in runs that clearly progressed (aliens scores on every kill). The human-play export path in `web/public/js/app.js` never syncs the live tick/score into recorded decisions — human traces currently carry action sequence and ordering only, no per-decision game-state alignment, so tick-aligned human-vs-model comparisons aren't possible until that's fixed. Tracked in `TODO.md`.

Also of note: the exports carry `model: "google/gemini-2.5-flash"` despite `playerType: "human"` — the recorder stamps the selected model chip even when no model is playing. Harmless, but worth ignoring in any analysis tooling.
