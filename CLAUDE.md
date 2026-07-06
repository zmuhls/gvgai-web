# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GVGAI (General Video Game AI) framework with a web-based LLM agent integration layer. A Java game engine runs 122+ 2D grid games defined in VGDL, while a Node.js server connects LLMs as game-playing agents via TCP socket, with a browser-based dashboard for prompt configuration and real-time visualization.

**Provenance.** This is a fork of [GAIGResearch/GVGAI](https://github.com/GAIGResearch/GVGAI). The Java engine, VGDL definitions, and `examples/` are **upstream code** (treat as a stable dependency, not "our code" to refactor). The local addition is everything under `web/` — the Node server, dashboard, and LLM connectivity. The Learning-track code lives in a separate repo (GVGAI_GYM), not here.

**`web/README.md` is partly stale** — it predates the current work and describes OpenRouter-only routing, browser-side API-key entry, and a "35ms timeout with fallback" that no longer match the code. For LLM routing, the prompt pipeline, and the frontend flow, **this file and `web/lib/` are authoritative**; the README's game-id pointers and prerequisites are still fine.

## Git Workflow

- **Location.** This repo belongs at `~/Projects/gvgai` (outside iCloud). Do **not** keep it under `~/Desktop` or `~/Documents` — those are iCloud-synced with "Optimize Mac Storage," which evicts `.git` refs/objects to dataless placeholders mid-operation and corrupts git commands. The failure signature on an iCloud clone: ordinary git commands hang for minutes, killed commands leave stale `.git/*.lock` files that block everything after (delete the lock files and retry), and git processes get stuck in uninterruptible sleep. If you hit this, finish the immediate task with background commands and long timeouts, then move the clone.
- **Push when finished.** When a task is complete and you have committed work, push to `origin` without waiting to be asked. "Finished" means the requested change is done, committed, and verified — not after every intermediate commit. If the push is not a fast-forward, stop and report rather than force-pushing.

## Build & Run Commands

### Java Engine

```bash
# environment setup (required before any java commands)
export PATH="/opt/homebrew/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@11"

# full compile
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt

# recompile single file (after full compile)
javac -cp "gson-2.6.2.jar:out" -d out src/tracks/singlePlayer/Test.java

# run standalone demo (no web frontend)
java -cp "out:gson-2.6.2.jar:." tracks.singlePlayer.Test
```

### Web Frontend + LLM Agent

```bash
cd web
npm install
npm start        # production (port 3000)
npm run dev      # development with nodemon auto-reload

npm test                 # full suite: node --test test/*.test.js (no extra deps)
node --test test/state-converter.test.js   # run a single test file
node --test --test-name-pattern="adherence" test/*.test.js  # filter by test name

npm run java:prepare         # stage a portable Java runtime (scripts/prepare-java-runtime.js)
npm run eval:arcade          # dry-run arcade eval plan (--dry-run --all)
npm run eval:arcade:execute  # actually run the arcade eval batch (spawns Java + LLM calls)
npm run telemetry:check      # verify Supabase telemetry connectivity
npm run telemetry:backfill   # replay local telemetry-events.jsonl into Supabase

node scripts/classify-games.js --dry-run --all   # print archetype/pace for all 122 games
node scripts/classify-games.js --write --all     # backfill classification blocks into data/games/*.json
node scripts/generate-strategy-memory.js --featured   # (re)build candidate memory records
node scripts/evaluate-strategy-memory.js --featured --model gemma3:27b --strategy-id puzzle --max-actions 150
                             # real A/B gate (spawns Java + live LLM calls; flips record statuses)
```

The web frontend spawns the Java process automatically via `game-manager.js` when a game is started from the browser. Tests use Node's built-in runner only — no Jest/Mocha; name new files `web/test/*.test.js`.

### Frontend assets are `public/`; API routes are the `-local` variants

The `public-local/` static split was removed (commit ccf1c10b) — `web/public/` is served directly and is the only copy. But `server.js` still mounts the **`-local` route variants** (`routes/{games,models,prompts,traces}-local.js`) for those four API groups; the plain `routes/games.js`/`models.js`/`prompts.js` files still exist and have **diverged** from their `-local` counterparts. Editing the plain files does not change live behavior — edit the `-local` ones. When a route change "doesn't take," check which variant `server.js` actually requires.

`.gitignore` has aggressive global patterns (`*.html`, `*.xml`, `*.gif`). Tracked HTML under `web/public/` survives only via explicit `!` exceptions — currently `!web/public/index.html` and `!web/public/marquee.html`. **Any new HTML page needs its own exception** or it silently falls out of version control.

`sources.txt` is a build artifact (the Java source list) that the compile step regenerates — don't commit its churn.

(Historical note: an earlier state of this tree had many untracked-but-required `lib/`/`routes/` modules that broke a clean clone; they are committed now, so a fresh clone boots. `npm test` is a reasonable shippability signal again.)

## Architecture

### Two-Layer System

```
Browser (localhost:3000)
  ↕ HTTP + Socket.IO (WebSocket)
Node.js Server (web/server.js)
  ↕ TCP Socket (port 8080, message format: msgId#payload\n)
Java Process (tracks.singleLearning.utils.JavaServer)
  ↕ Forward Model
GVGAI Game Engine
```

### Critical Timing Constraint

The Java engine requires action responses within **40ms** per tick. LLMs take 200-2000ms. The solution in `llm-client.js`:
- Respond immediately with `pendingLLMAction` (from previous async call) or `ACTION_NIL`
- Fire async LLM call in background, gated to ≥400ms since the last call
- When LLM responds, store result for the *next* tick
- This means every LLM decision is applied ~10 ticks after the state it was computed from. **This staleness is not solved — it is curated around** (featured games are slow/puzzle games where it doesn't dominate; see `web/data/featured.json`).

**Three action modes.** The async/stale behavior above is the **walk-up live** path. The **eval and marble-run** paths instead set `synchronousActions` on the `LLMClient`, which blocks each Java tick until the LLM answers — no staleness, but each tick waits ~0.5–2s (a slow but faithful playthrough, capped by `maxActions`, default 40; on reaching the cap the client sends `ABORT` **and** proactively calls `emitCloseSummary()` so the case finalizes instead of hanging on the timeout). **Macro-action plans** (opt-in per game via a `macroActions` block in the game config) bridge latency a third way: the model returns a short *plan* of steps that `response-parser.js` parses, and `llm-client.js` drains a step queue over several ticks while the next plan computes in the background (`MAX_PLAN_STEPS`, `ticksPerStep`, stale-plan invalidation).

### Socket Protocol Phases

1. **START** → Java signals ready, Node responds `START_DONE`
2. **INIT** → Per-level init with full SSO JSON, Node responds `INIT_DONE#BOTH`
3. **ACT** → Per-tick game state, Node responds `msgId#ACTION_NAME#IMAGE` (must be <40ms)
4. **END** → Level complete, Node responds `END_DONE`
5. **FINISH** → All levels done, session cleanup

### Layered Prompt System (state-converter.js)

Prompts are assembled from layers in `buildPrompt(sso, promptConfig, stateTracker, sessionStrategy)`:
0. **Player Directive** — the *ephemeral* per-session strategy (see below); only present when `sessionStrategy` is set
1. **System** — base LLM instructions (from template)
2. **Game context** — game-specific strategy (from template or customOverride)
3. **Progression** — level-specific hints
4. **History** — last 3 actions with score/health/position deltas
5. **Loop detection** — warns if same action repeated with no progress
6. **Spatial context** — player position; nearest NPCs/threats and goals as signed axis-split offsets ("3 left, 1 up (4 away)"); blocked directions
7. **ASCII grid map** — full observation grid rendered as characters (with a one-line orientation legend)
8. **Tick state** — current score, health, available actions, and the closing instruction

**Ephemeral session strategy (key invariant).** The walk-up user's strategy is threaded `server.js` start request → `llmClient.connect(..., strategy)` → `this.sessionStrategy` (a runtime-only field on the client instance). It is injected as Layer 0 and **never written to `web/data/games/{id}.json`** — `saveGameConfig` is only reachable from the dashboard PUT route. The persistent dashboard config is the base; the strategy layers on top at runtime only.

**Closing contract.** When a strategy is active the tick state ends with a structured `REASON: <one sentence> / ACTION: <action>` format (`ACTION:` last, truncation-safe), so the model both narrates and acts. With no strategy it falls back to the legacy "respond with ONLY the action word".

**Untrusted-input floor.** The walk-up strategy is free text a stranger typed, so `sanitizeStrategy()` (state-converter.js) runs at the single storage point (`llm-client.js` `connect`): caps length (~240), collapses newlines, and defangs forged `ACTION:`/`REASON:`/`ANS=` markers, override stems, and role prefixes. Layer 0 is then **fenced and demoted below the game rules** in the assembly order, so a hostile note cannot outrank the rules or forge the closing contract; the closed action space (`availableActions`) is the hard backstop. The frontend adds a non-blocking soft-warn, and `GET /api/games/:id/digest` serves each game's VGDL-derived rule facets for the "unfold the rules" scaffold (a user composes a tactic from code-sourced chips). `buildPrompt` also returns `promptLayers` (labeled prompt slices) which ride the `llm-reasoning` payload for the frontend "decision autopsy."

Template variables resolved at runtime: `{{gameName}}`, `{{gameScore}}`, `{{availableActions}}`, `{{playerPosition}}`, `{{gridSize}}`, `{{blockedDirections}}`, `{{asciiGrid}}`, `{{lastAction}}`, etc.

`GameStateTracker` (rolling history, loop detection, run accumulation) is instantiated **on the `LLMClient` instance** and passed into `buildPrompt`; `recordTick` runs every ACT tick and `recordAction` on every LLM decision.

### Action Parsing (response-parser.js)

Three-tier priority for extracting actions from LLM text:
1. **Exact match** — response is literally an action name
2. **Canonical** — `ACTION_UP`, `ACTION_USE`, etc. (last match wins for verbose responses)
3. **Bare words** — `UP`, `SHOOT`, `WAIT`, etc. (last match wins)

Per-game `actionAliases` in game configs map internal actions to game-appropriate labels (e.g., `ACTION_USE` → `SHOOT` for Aliens). These aliases are used in prompt display AND parsed back on response.

`parseStructured(text, availableActions)` is used when narration is on: it extracts the `REASON:` rationale and runs `parseAction` only on the text **after the last `ACTION:` marker** — this scoping prevents prose direction words ("the LEFT enemy, so go right") from hijacking the bare-word tier. Returns `{ action, reason }`. A reply truncated before `ACTION:` yields `ACTION_NIL` (the model never concluded).

### ASCII Grid Renderer (grid-renderer.js)

Converts the `observationGrid[x][y][sprites]` 3D array from the SSO JSON into a character map. Category-based defaults: `@`=avatar, `E`=NPC, `#`=static, `$`=resource, `O`=portal, `*`=projectile, `M`=movable, `.`=empty. Background sprites auto-detected (category 4 in >90% of cells) and cached per level in `GameStateTracker.backgroundItypes`. Per-game `gridSymbolMap` overrides available in game config.

### Multimodal Support

Models matching patterns in `config.json:multimodalPatterns` automatically get the `gameStateByBytes.png` screenshot attached as a base64 image content block. The Java engine writes this PNG to disk each frame; `server.js` also streams it to the browser via Socket.IO for visualization.

### Game classification & class-derived runtime defaults

Every game gets a computed classification (`lib/game-classifier.js`, pure rules over the VGDL digest): an **archetype** (`shooter-lane`, `shooter-roaming`, `pusher-puzzle`, `collector`, `chaser`, `survivor`, `reflex-pilot`, `navigator`), **subtypes** (`hazard-dense`, `timed`, `transform`, …), and a **pace** (`twitch` | `reactive` | `deliberate`) keyed to the staleness constraint above. Classification is stored in each game config (backfilled by `scripts/classify-games.js`) and computed lazily for configs without one. It must never be added to the hashed digest object itself — that would churn every `digestHash`, which is the strategy-memory key.

`web/data/class-defaults.json` maps archetypes (plus a `twitch` pace overlay) to runtime defaults — `macroActions`, `llmSettings`, per-class eval thresholds (`eval`), and memory-gate thresholds (`memoryGate`). `lib/class-defaults.js` `applyClassDefaults()` merges them beneath explicit config inside `prompt-store.js` `resolveGamePromptConfig` — the single merge site feeding prompt shape, plan contract, and executor. Consequences: pusher-puzzle/collector games get macro plans by default, and effective `maxTokens` is floored at 320 whenever macro is enabled (the PLAN reply truncates below that). Code-protocol games never inherit macro defaults.

Precedence, most binding first: env kill switches (`MACRO_ACTIONS_DISABLED=1`, `CLASS_DEFAULTS_DISABLED=1`, `STRATEGY_MEMORY_DISABLED=1`) > explicit per-game config keys (an explicit `"enabled": false` survives the merge) > `config.classification.archetypeOverride` (manual pin for misclassified games) > archetype entry > pace overlay > code constants. `/api/games` serves `archetype`/`pace` per game; the digest endpoint serves the full block; the frontend re-ranks strategy preset cards by archetype affinity.

### Web Frontend — the "Arcade" walk-up flow

`web/public/` (vanilla JS, no framework) drives a kiosk-style flow for the Inference Arcade showcase: pick a game (featured grid + browse-all-122) → tap a preset strategy card that pre-fills an editable text box → watch the game with a **live narration panel** (the model's `reason` per decision + a "following your strategy" badge + the answering `provider`) → an **end-of-run summary card** (score, echoed strategy, stated-adherence label, highlight decisions). The Prompt Dashboard (`dashboard.js`) is the separate power-user config editor. Browser Socket.IO events: `game-state`, `game-frame` (PNG), `llm-reasoning` (now carries `reason`/`strategy`/`provider`), `level-end`, `run-summary` (the summary card payload), `session-end`, `llm-error`.

### Attract mode: the marble run + spectator marquee

When no walk-up player is active, an always-on **marble run** (`lib/attract-coordinator.js`, a singleton state machine) plays the eval playlist on the single Java process, broadcasts it live, and loops. It reuses the eval harness: each case runs through `runEvalCase` (`batch-evaluator.js`) with a **broadcast tee** — `createEventSink(broadcastIo)` forwards the buffered sink events to the real Socket.IO server, and `onCaseStart` hands the coordinator a live `{processId, llmClient}` handle. A walk-up has priority: `server.js` `/api/game/start` calls `coordinator.beginWalkup()` (disconnect the live case — which resolves the `run-summary` the eval was awaiting, so it unwinds through its own `finally` — then await `game-manager.stopGameAndWait()` to free port 8080), plays, then `endWalkup()` resumes the loop. Auto-starts on boot; disable with `MARBLE_RUN_AUTOSTART=false`. Control surface: `routes/marble.js` (`POST /api/marble/start|stop`, `GET /api/marble/state`). New events: `marble-run-state`, `case-started`, `case-completed`.

The **spectator page** (`public/marquee.html` + `js/marquee.js`, served at `/marquee`, iframe-embeddable) is a read-only consumer of that stream — because all Socket.IO emits are **global** (no rooms), any tab already sees the live run. The **Tote Board** on the telemetry dashboard shows per-model standings + strategy effect from a `marbleRun` block on `getDashboardSnapshot` (aggregated from `marble_case_completed` events).

The single-session constraint still holds (one Java process, fixed port 8080, one global screenshot path), so the marble run is a **serial playlist on one broadcast channel**, not parallel lanes — including on the deployed instance, where all visitors share the one session. Multi-tablet concurrency remains out of scope; Docker/Railway packaging now exists (see Deployment).

The walk-up handoff only protects sessions that go through the server. **Standalone eval scripts (`evaluate-strategy-memory.js`, `run-arcade-eval.js`) spawn their own Java on the same port 8080 and will race an active marble run** — cross-connected sockets kill the script with no output while the marble run keeps going. Before a script-driven eval, stop the marble run (`curl -X POST localhost:3000/api/marble/stop`) and confirm the port is clear (`pgrep -fl JavaServer`); restart it after. A related symptom: a JavaServer whose client died can linger orphaned (parent = launchd, socket CLOSED) spinning at 100% CPU — check with `ps -o pid,ppid,%cpu,etime -p $(pgrep -f JavaServer)` and kill orphans.

## Key Files

### Node.js Backend (web/lib/)
| File | Purpose |
|------|---------|
| `llm-client.js` | TCP socket, async LLM calls, primary→fallback routing (`callProvider`), `GameStateTracker` ownership, run-summary accumulation, message protocol |
| `models.js` | Shared model catalog + `resolveModel()` routing (provider + fallback metadata) |
| `state-converter.js` | Layered prompt builder, `GameStateTracker` class, `computeAdherence()`, template resolution |
| `grid-renderer.js` | `renderAsciiGrid()` + `detectBackgroundItypes()` |
| `response-parser.js` | `parseAction` (3-tier) + `parseStructured` (REASON/ACTION) |
| `prompt-store.js` | Template + game config CRUD with 30s read cache; `saveGameConfig` is the ONLY config writer (dashboard PUT route only) |
| `game-manager.js` | Java process spawn/kill (portable `JAVA_BIN`/env resolution), stdout monitoring for socket-ready signal |
| `runtime-config.js` | `getConfig()` — loads `config.json` (timeout-guarded subprocess read), merges `DEFAULT_CONFIG`, applies env overrides (`PORT`, `GVGAI_*`), derives `projectRoot`. The single source of resolved config |
| `code-protocol.js` | Optional compact-action prompt mode (`buildCodePrompt`): single-letter action codes (U/D/L/R/F/X/N), forward-model dodge lookahead, policy heuristics. Active only when a game config sets `codeProtocol.enabled` (consumed by `state-converter.js`) |
| `game-registry.js` | Reads `examples/all_games_sp.csv` + `featured.json`; `selectGames()` picks the eval/showcase set |
| `screenshot-path.js` | `resolveScreenshotPath(gvgaiConfig)` — single resolver for the per-frame PNG path |
| `vgdl-digest.js` | Parses a VGDL `.txt` into a structural "strategic digest" (sprites/interactions/termination) with a content hash; feeds strategy-memory |
| `game-classifier.js` | `classifyDigest()`/`getCachedClassification()` — archetype/subtypes/pace from the digest (see Game classification section) |
| `class-defaults.js` | `applyClassDefaults()` — merges `data/class-defaults.json` archetype/pace defaults beneath explicit game config; `CLASS_DEFAULTS_DISABLED=1` bypass |
| `telemetry-store.js` | Event capture (`track`), batched async flush to Supabase, local `data/telemetry-events.jsonl` fallback, dashboard read models (`getDashboardSnapshot`) |
| `usage-guardrail.js` | Light call caps on the Ollama Cloud key (hourly/daily/session, env-tunable, persisted buckets); enforced in `llm-client.js` `callProvider` — see LLM Routing |
| `strategy-memory-store.js` + `strategy-memory-evaluator.js` | Per-game strategy "memory" records (built from VGDL digest), cached CRUD under `data/strategy-memory/`, and A/B evaluation (baseline vs digest-memory prompt) |
| `eval-plan.js` + `batch-evaluator.js` + `offline-game-evaluator.js` | Arcade eval harness: build game×model×strategy plans, run batches (spawns Java + real LLM via `game-manager`/`llm-client`), and an offline scripted-policy evaluator for prompt-pipeline tests without a live model. `createEventSink(broadcastIo)` + `runEvalCase`'s `onCaseStart` are the seams the marble run reuses to broadcast live |
| `attract-coordinator.js` | Attract-mode "marble run" singleton: serial playlist broadcast on the single Java process, walk-up interrupt/resume state machine, consecutive-error backstop; emits `marble-run-state`/`case-started`/`case-completed` |

### Data (web/data/)
| Path | Purpose |
|------|---------|
| `templates/*.json` | Reusable prompt layers (system, strategy, etc.) |
| `templates/_index.json` | Template registry |
| `games/{gameId}.json` | Per-game config: prompt assembly, LLM settings, `actionAliases`, `gridSymbolMap`, `classification` |
| `featured.json` | `{ "featured": [gameIds] }` — the curated showcase set; `routes/games.js` merges a `featured` flag into `/api/games`. Curation is data, no redeploy. |
| `class-defaults.json` | Per-archetype runtime defaults + `twitch` pace overlay (macro settings, token floors, eval/memory-gate thresholds) |
| `strategy-memory/` | Per-game strategy-memory records + `_index.json` (written by the strategy-memory scripts) |
| `traces/` | Imported human-play trace exports (browser `arcade-trace-*.json` downloads) + `human-vs-slm-analysis.md`. Distinct from `play-traces/` (the server-side store with its own schema/index; gitignored) |
| `telemetry-events.jsonl` + `eval-runs/` | Offline telemetry fallback log and persisted arcade-eval output artifacts |

### Java Entry Points
| File | Purpose |
|------|---------|
| `src/tracks/singlePlayer/Test.java` | Standalone demo (no web) — game/level/agent selection |
| `src/tracks/singleLearning/utils/JavaServer.java` | Socket server for web LLM integration |
| `src/core/game/SerializableStateObservation.java` | Game state → JSON serialization (includes `observationGrid`) |

### Config
- `web/config.json` — ports, `ollamaCloud`/`ollama`/`openrouter` API URLs, `multimodalPatterns`. `gvgai.projectRoot` and `gvgai.javaPath` are **derived at runtime** when blank/missing (root from `server.js`'s location; java from PATH) so the app is portable across machines/Docker/Railway — don't hardcode absolute paths.
- `.env` (repo root, not committed) — `OLLAMA_API_KEY` (primary) + `OPENROUTER_API_KEY` (fallback). Telemetry is also configured here (written by `setup-supabase-telemetry.sh`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD` (for psql/migrations), `SUPABASE_TELEMETRY_TABLE`, plus `TELEMETRY_ENABLED` / `TELEMETRY_BATCH_SIZE` / `TELEMETRY_FLUSH_MS` / `TELEMETRY_FALLBACK_MODE` / `TELEMETRY_STORE_PROMPTS`. See `.env.example` for the full list. The `STRATEGY_MEMORY_DIR` env var can relocate the strategy-memory store; `OLLAMA_GUARDRAIL_HOURLY/DAILY/SESSION/DISABLED/STATE` tune the Ollama-key usage guardrail (see LLM Routing).

## Game Config Schema (web/data/games/{id}.json)

```json
{
  "gameId": 0,
  "gameName": "aliens",
  "systemTemplateId": "default-system",
  "gameContext": { "templateId": "aliens-strategy", "customOverride": "..." },
  "progressionContexts": { "0": { "customOverride": "..." } },
  "llmSettings": { "maxTokens": 100, "temperature": 0.8 },
  "actionAliases": { "ACTION_USE": "SHOOT", "ACTION_NIL": "WAIT" },
  "gridSymbolMap": {},
  "gridLegend": "@ = ship, E = alien, # = base, . = empty"
}
```

`customOverride` takes precedence over `templateId`. Both are optional per layer. (`maxTokens` defaults to 160 in code when unset, 200 on featured games — reasoning models need headroom; keep `customOverride` free of output-format instructions since the closing contract now governs that.)

Two optional per-game blocks change the response contract: `codeProtocol` (compact single-letter action codes + policy heuristics, see `code-protocol.js`) and `macroActions` (`{ enabled, maxSteps, ticksPerStep }` — the multi-step plan queue described under Critical Timing Constraint). `macroActions` and `llmSettings` are also filled in by class defaults when the config leaves them unset (see Game classification section) — explicit config keys always win. Configs also carry a `classification` block written by `scripts/classify-games.js`; add `archetypeOverride` inside it to pin a misclassified game.

## LLM Routing (web/lib/models.js)

`lib/models.js` is the shared model catalog (consumed by `routes/models-local.js` — the mounted variant — and `llm-client.js`). Each entry declares a `provider` and optional `fallback`. **Ollama Cloud is the primary inference provider; OpenRouter is the per-call fallback.**

- **Roster policy (since 2026-07-05): open-weight small models only, all hosted on Ollama Cloud, and none with the `thinking` capability flag** (check via Ollama's `/api/show`; reasoning models burn hidden tokens and return empty `content` at arcade `max_tokens` budgets). Current roster: `gemma3:27b` (default, featured), `gemma3:12b` (featured), `qwen3-coder-next`, `ministral-3:14b/8b/3b`, `devstral-small-2:24b`. There is no non-reasoning Qwen ≤31B on Ollama Cloud — `qwen3-coder-next` (~80B MoE) is the stand-in.
- **The default model lives in two homes that must move together**: `config.json` `openrouter.defaultModel` and the `featured` flags in the catalog (the frontend picker defaults to the first featured model; `eval-plan.js` and the marble-run playlist use the featured set). `runtime-config.js` has a third built-in fallback default.
- `resolveModel(id)` returns the catalog entry, or infers for ad-hoc ids: `/` in the name → OpenRouter; otherwise → Ollama Cloud.
- `llm-client.js` calls the primary provider via `callProvider()`; on any non-OK response it automatically retries the model's `fallback` slug through OpenRouter. The provider that actually answered is reported back on the `llm-reasoning` socket event (`provider`/`modelUsed`).
- **Usage guardrail on the Ollama key** (`lib/usage-guardrail.js`): light call caps enforced in `callProvider`'s ollama-cloud branch — hourly 3000 / daily 15000 / per-session 1500, env-tunable via `OLLAMA_GUARDRAIL_HOURLY/DAILY/SESSION`, kill switch `OLLAMA_GUARDRAIL_DISABLED=1`. A tripped guardrail **blocks** the call (deliberately skipping the OpenRouter fallback so spend doesn't silently shift), emits `llm-error`, and tracks a `system`/`guardrail_block` telemetry event. Hour/day buckets persist in `web/data/usage-guardrail.json` (gitignored).
- Provider → endpoint + auth: `ollama-cloud` → `config.ollamaCloud.apiUrl` + `OLLAMA_API_KEY`; `openrouter` → `config.openrouter.apiUrl` + `OPENROUTER_API_KEY`; `ollama-local` → `config.ollama.apiUrl` (no key).
- All providers use the OpenAI-compatible `/chat/completions` shape (`messages`, `max_tokens`, `temperature`).
- Known gap: on GV1 code-protocol games (ids 0, 4, 13, 15, 18) the current roster replies in prose the compact parser rejects, so actions come from the encoded-policy fallback rather than the model (see TODO.md).

## Telemetry, Strategy Memory & Eval Harness

These three subsystems are all newer than the original arcade core loop and live entirely under `web/`.

- **Telemetry (`telemetry-store.js`, `routes/telemetry.js`, `supabase/migrations/`)** — server- and browser-emitted events (`evaluation`, `user_experience`, `clickthrough`, `model_telemetry`, `trace`, `system`). Events are buffered and flushed in batches to Supabase; if Supabase is unconfigured/unreachable they append to `web/data/telemetry-events.jsonl` (the offline fallback that `npm run telemetry:backfill` later replays). `server.js` wraps non-`/api/telemetry` API requests in a timing middleware that auto-emits `api_request` events. Read models for dashboards come from the SQL views in `supabase/migrations/` (see `web/SUPABASE_TELEMETRY.md`). All of this is gated by env vars and degrades to no-op/JSONL when unset — but the cloud store is now configured and live (see Deployment); `web/scripts/setup-supabase-telemetry.sh` is the one-shot provisioning path.
- **Strategy memory (`strategy-memory-store.js`, `vgdl-digest.js`)** — derives a structural digest from each game's VGDL and stores a per-game "memory" record under `web/data/strategy-memory/` (schema v2 records carry the game's `classification`). `strategy-memory-evaluator.js` A/B-tests a `baseline` prompt vs a `digest-memory` prompt and flips each record's `evaluationStatus` to accepted/rejected; gate thresholds come per-archetype from `class-defaults.json` `memoryGate`. **The live path is gated**: `server.js` constructs the walk-up `LLMClient` with `strategyMemory: 'accepted'`, so only accepted records replace the game-context prompt layer (candidates are invisible; `STRATEGY_MEMORY_DISABLED=1` switches injection off; code-protocol games never inject). Generate/evaluate via `scripts/generate-strategy-memory.js` and `scripts/evaluate-strategy-memory.js` (the evaluator loads root `.env` itself and takes `--max-actions` — the default 40-action eval cap makes tick/score gains hard to observe on puzzle games).
- **Eval harness (`eval-plan.js`, `batch-evaluator.js`, `offline-game-evaluator.js`, `routes/evals.js`)** — `buildArcadeEvalPlan()` enumerates game × model × strategy cases (each carries the game's `archetype`, with a `byArchetype` rollup on the plan); `runArcadeBatchEvaluation()` executes them by spawning real Java game sessions and real LLM calls (slow, costs tokens — `npm run eval:arcade:execute`). Survival/nil-loop thresholds in `normalizeEvalResult` resolve per-archetype from `class-defaults.json` before falling back to the global constants, and the eval report groups results by archetype (cross-archetype score averages aren't comparable). `offline-game-evaluator.js` is the scripted-policy stand-in used by tests and dry runs so the prompt/parse pipeline can be exercised without a live model. Output artifacts land in `web/evals/` and `web/data/eval-runs/`; the `/api/evals/arcade` route serves the plan and `/api/evals/arcade/run` triggers a batch.

## Deployment (Railway + Cloudflare + Supabase)

The arcade is live at **https://inference-arcade.com** (Cloudflare-proxied apex CNAME → `gaaqisv1.up.railway.app`; the Railway-generated domain is `inference-arcade-production.up.railway.app`).

- **Railway**: project/service `inference-arcade`, built from the root `Dockerfile` per `railway.json` (healthcheck `/api/games`). GitHub push-to-deploy is connected (since July 5 2026): the service's source is `zmuhls/gvgai-web` branch `master`, so every push to master triggers a full rebuild and deploy — including docs-only commits. `railway up --service inference-arcade --detach` from the repo root still works for deploying uncommitted local state.
- **The Railway↔GitHub link runs through the `milwrite` identity, not `zmuhls`.** The Railway account's GitHub OAuth is `milwrite`; the repo owner is `zmuhls`. The connection works because `milwrite` has collaborator (write) access on `zmuhls/gvgai-web`. If Railway ever stops seeing the repo (empty repo picker, failed source connect), check that collaborator grant first — and note Railway's repo list caches, so a fresh grant may not appear immediately even though a direct source-connect succeeds.
- **`PORT=3000` is a pinned Railway variable — do not remove it.** Railway injects `PORT=8080` by default, which collides with the Java engine's fixed socket port 8080 and makes every game start fail with `BindException: Address already in use`.
- **`MARBLE_RUN_AUTOSTART=false`** is set on Railway so the attract-mode marble run doesn't burn LLM tokens continuously; enable deliberately via `POST /api/marble/start`.
- **Dockerfile shape**: stage 1 compiles the engine with JDK 11; stage 2 (JRE 11 + Node 22) bakes the hydrated runtime layout at `web/.gvgai-runtime/` (classes + source tree + `runtime.json`) so `game-manager.js` never runs the git-dependent prepare script, **and** copies `examples/` to the project root a second time — the Node layer (`game-registry.js`, `vgdl-digest.js`) reads the game CSV and VGDL files from the project root, not the runtime dir.
- **Supabase telemetry is live**: project ref `akkchqkausfwabyqbiye` (us-east-1), credentials in root `.env` and mirrored into Railway service variables. `web/scripts/setup-supabase-telemetry.sh` is the one-shot setup (create/reuse project → apply migrations → write `.env` → readiness check → backfill JSONL); it needs a prior `supabase login`. Note: the direct DB host `db.<ref>.supabase.co` does not resolve (new projects are pooler-only) — use the session pooler (`aws-0-us-east-1.pooler.supabase.com:5432`, user `postgres.<ref>`) or the REST API. The root-level `supabase/.temp/` dir is a Supabase CLI link artifact, not project code.

## Development Notes

- `imageArray` in SSO JSON is stripped before `JSON.parse` in `llm-client.js` (it's megabytes of base64 PNG)
- `extractQuickState()` does fast field extraction from raw JSON strings to avoid full parsing on every tick — only LLM calls do full `JSON.parse`
- The `observationGrid` is `[x][y][sprites]` (columns-first) — iterate `y` as outer loop for row-by-row display
- `Observation` objects have `category` (0-6) and `itype` (game-specific sprite ID)
- `POST /api/game/start` takes the model id in a **`model`** field — passing `modelId` (the name used on socket/telemetry payloads) silently yields `this.model = undefined` and every Ollama call 404s with `model "" not found`. Also note the marble run auto-starts on a local boot (`MARBLE_RUN_AUTOSTART` unset) and plays the featured models on the same log stream, which can masquerade as your walk-up session when debugging.
- Game index: `examples/all_games_sp.csv` (line number = gameId). `JavaServer.java` resolves gameId from this same CSV (falling back to its legacy hardcoded array). Before July 2026 it used only the hardcoded array, whose entries diverge from the CSV at id 20 — so ids 20+ played the wrong game through the web layer (e.g. "doorkoban" (32) actually ran enemycitadel). Telemetry and tuning recorded before that fix mislabel those games. After changing the Java side, re-stage the portable runtime with `npm run java:prepare`.
- VGDL game definitions: `examples/gridphysics/{gameName}.txt` with levels at `{gameName}_lvl{0-4}.txt`
- Java agents must return actions within `ElapsedCpuTimer` budget
- Framework loads agents via reflection from class path strings
- `.gitignore` has aggressive global patterns (`*.html`, `*.xml`, `*.gif`); `web/public/index.html` is the frontend entry point and is tracked only via an explicit `!web/public/index.html` exception — don't remove it or new HTML assets under `web/public/` will silently fall out of version control
- `AGENTS.md` (repo root) holds the same project conventions plus a writing-style rule that applies to prose/comments here: write plainly; avoid coined noun phrases, choppy sentence chains, and broad claims not grounded in files, commands, game ids, or observed behavior
