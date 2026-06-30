# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GVGAI (General Video Game AI) framework with a web-based LLM agent integration layer. A Java game engine runs 122+ 2D grid games defined in VGDL, while a Node.js server connects LLMs as game-playing agents via TCP socket, with a browser-based dashboard for prompt configuration and real-time visualization.

**Provenance.** This is a fork of [GAIGResearch/GVGAI](https://github.com/GAIGResearch/GVGAI). The Java engine, VGDL definitions, and `examples/` are **upstream code** (treat as a stable dependency, not "our code" to refactor). The local addition is everything under `web/` — the Node server, dashboard, and LLM connectivity. The Learning-track code lives in a separate repo (GVGAI_GYM), not here.

**`web/README.md` is partly stale** — it predates the current work and describes OpenRouter-only routing, browser-side API-key entry, and a "35ms timeout with fallback" that no longer match the code. For LLM routing, the prompt pipeline, and the frontend flow, **this file and `web/lib/` are authoritative**; the README's game-id pointers and prerequisites are still fine.

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
```

The web frontend spawns the Java process automatically via `game-manager.js` when a game is started from the browser. Tests use Node's built-in runner only — no Jest/Mocha; name new files `web/test/*.test.js`.

### Working tree ≠ git: much of the running app is uncommitted (verify before you commit)

The current branch's working tree is a large in-progress refactor whose required files are **untracked** (not gitignored, just never `git add`ed). This has two consequences a future agent must internalize:

1. **A clean clone of `HEAD` does not even boot.** `lib/grid-renderer.js` exists in **no commit on any branch**, yet the committed `lib/state-converter.js` does `require('./grid-renderer')`. So `git clone` → `npm start` crashes with `Cannot find module './grid-renderer'`. The app runs here only because the file exists as an untracked working-tree file. Verified by reconstructing `HEAD` into a clean tree and loading `state-converter.js`.

2. **The working-tree refactor adds many more untracked-but-required modules.** The modified-and-tracked `server.js`, `llm-client.js`, `game-manager.js` now `require` untracked `lib/runtime-config.js`, `lib/screenshot-path.js`, `lib/telemetry-store.js`, `scripts/load-root-env.js`, and `routes/{games,models,prompts}-local.js`, `routes/{evals,telemetry}.js`. Untracked counts at last check: ~9 `lib/`, 5 `routes/`, 6 `scripts/`, 17 `test/`, 114 `data/games/*.json`.

**Practical rules:**
- `npm test` passing is **not** evidence the committed repo works — the tests exercise untracked modules. To check shippability, reconstruct `HEAD` (`git archive HEAD | tar -x -C <tmp>`) and load the entry points there.
- Before committing, `git status` the full set and `git add` every module the tracked code `require`s. Don't commit `server.js`/`state-converter.js` without the untracked files they depend on, or you ship a tree that crashes on boot.
- The running server serves `public-local/` **before** `public/` and registers the `*-local` route variants. `public-local/js/app.js` has diverged from the tracked `public/js/app.js`, and `public-local/` is gitignored (the `*.html` rule, with no `!`-exception like `public/index.html` has). So **editing the tracked `public/js/app.js` or `routes/games.js` does not change live behavior** — edit the `-local` copy, then mirror it back into the tracked file. When a change "doesn't take," check which variant the running `server.js` actually requires/serves.

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

### Web Frontend — the "Arcade" walk-up flow

`web/public/` (vanilla JS, no framework) drives a kiosk-style flow for the Inference Arcade showcase: pick a game (featured grid + browse-all-122) → tap a preset strategy card that pre-fills an editable text box → watch the game with a **live narration panel** (the model's `reason` per decision + a "following your strategy" badge + the answering `provider`) → an **end-of-run summary card** (score, echoed strategy, stated-adherence label, highlight decisions). The Prompt Dashboard (`dashboard.js`) is the separate power-user config editor. Browser Socket.IO events: `game-state`, `game-frame` (PNG), `llm-reasoning` (now carries `reason`/`strategy`/`provider`), `level-end`, `run-summary` (the summary card payload), `session-end`, `llm-error`.

Architecturally this is **Sub-project A** (the single-tablet core loop) of a larger plan; concurrency/multi-tablet, leaderboard, and Docker/Railway packaging are deliberately out of scope here and run on the existing single-session architecture (one Java process, fixed port 8080, global screenshot path).

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
| `grid-renderer.js` | `renderAsciiGrid()` + `detectBackgroundItypes()` (listed above) |
| `game-registry.js` | Reads `examples/all_games_sp.csv` + `featured.json`; `selectGames()` picks the eval/showcase set |
| `screenshot-path.js` | `resolveScreenshotPath(gvgaiConfig)` — single resolver for the per-frame PNG path |
| `vgdl-digest.js` | Parses a VGDL `.txt` into a structural "strategic digest" (sprites/interactions/termination) with a content hash; feeds strategy-memory |
| `telemetry-store.js` | Event capture (`track`), batched async flush to Supabase, local `data/telemetry-events.jsonl` fallback, dashboard read models (`getDashboardSnapshot`) |
| `strategy-memory-store.js` + `strategy-memory-evaluator.js` | Per-game strategy "memory" records (built from VGDL digest), cached CRUD under `data/strategy-memory/`, and A/B evaluation (baseline vs digest-memory prompt) |
| `eval-plan.js` + `batch-evaluator.js` + `offline-game-evaluator.js` | Arcade eval harness: build game×model×strategy plans, run batches (spawns Java + real LLM via `game-manager`/`llm-client`), and an offline scripted-policy evaluator for prompt-pipeline tests without a live model |

### Data (web/data/)
| Path | Purpose |
|------|---------|
| `templates/*.json` | Reusable prompt layers (system, strategy, etc.) |
| `templates/_index.json` | Template registry |
| `games/{gameId}.json` | Per-game config: prompt assembly, LLM settings, `actionAliases`, `gridSymbolMap` |
| `featured.json` | `{ "featured": [gameIds] }` — the curated showcase set; `routes/games.js` merges a `featured` flag into `/api/games`. Curation is data, no redeploy. |
| `strategy-memory/` | Per-game strategy-memory records + `_index.json` (written by the strategy-memory scripts) |
| `telemetry-events.jsonl` + `eval-runs/` | Offline telemetry fallback log and persisted arcade-eval output artifacts |

### Java Entry Points
| File | Purpose |
|------|---------|
| `src/tracks/singlePlayer/Test.java` | Standalone demo (no web) — game/level/agent selection |
| `src/tracks/singleLearning/utils/JavaServer.java` | Socket server for web LLM integration |
| `src/core/game/SerializableStateObservation.java` | Game state → JSON serialization (includes `observationGrid`) |

### Config
- `web/config.json` — ports, `ollamaCloud`/`ollama`/`openrouter` API URLs, `multimodalPatterns`. `gvgai.projectRoot` and `gvgai.javaPath` are **derived at runtime** when blank/missing (root from `server.js`'s location; java from PATH) so the app is portable across machines/Docker/Railway — don't hardcode absolute paths.
- `.env` (repo root, not committed) — `OLLAMA_API_KEY` (primary) + `OPENROUTER_API_KEY` (fallback). Telemetry is optional and also configured here: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TELEMETRY_TABLE`, plus `TELEMETRY_ENABLED` / `TELEMETRY_BATCH_SIZE` / `TELEMETRY_FLUSH_MS` / `TELEMETRY_FALLBACK_MODE` / `TELEMETRY_STORE_PROMPTS`. See `.env.example` for the full list. The `STRATEGY_MEMORY_DIR` env var can relocate the strategy-memory store.

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

## LLM Routing (web/lib/models.js)

`lib/models.js` is the shared model catalog (consumed by both `routes/models.js` and `llm-client.js`). Each entry declares a `provider` and optional `fallback`. **Ollama Cloud is the primary inference provider; OpenRouter is the per-call fallback.**

- `resolveModel(id)` returns the catalog entry, or infers for ad-hoc ids: `/` in the name → OpenRouter; otherwise → Ollama Cloud.
- `llm-client.js` calls the primary provider via `callProvider()`; on any non-OK response it automatically retries the model's `fallback` slug through OpenRouter. The provider that actually answered is reported back on the `llm-reasoning` socket event (`provider`/`modelUsed`).
- Provider → endpoint + auth: `ollama-cloud` → `config.ollamaCloud.apiUrl` + `OLLAMA_API_KEY`; `openrouter` → `config.openrouter.apiUrl` + `OPENROUTER_API_KEY`; `ollama-local` → `config.ollama.apiUrl` (no key).
- Ollama Cloud calls send `reasoning_effort: 'low'` — many cloud models (e.g. `gpt-oss:120b`) are reasoning models that otherwise burn the token budget on hidden reasoning and return empty `content` (the code falls back to the `reasoning` field if so).
- All providers use the OpenAI-compatible `/chat/completions` shape (`messages`, `max_tokens`, `temperature`).

## Telemetry, Strategy Memory & Eval Harness

These three subsystems are all newer than the original arcade core loop and live entirely under `web/`.

- **Telemetry (`telemetry-store.js`, `routes/telemetry.js`, `supabase/migrations/`)** — server- and browser-emitted events (`evaluation`, `user_experience`, `clickthrough`, `model_telemetry`, `trace`, `system`). Events are buffered and flushed in batches to Supabase; if Supabase is unconfigured/unreachable they append to `web/data/telemetry-events.jsonl` (the offline fallback that `npm run telemetry:backfill` later replays). `server.js` wraps non-`/api/telemetry` API requests in a timing middleware that auto-emits `api_request` events. Read models for dashboards come from the SQL views in `supabase/migrations/` (see `web/SUPABASE_TELEMETRY.md`). All of this is gated by env vars and degrades to no-op/JSONL when unset.
- **Strategy memory (`strategy-memory-store.js`, `vgdl-digest.js`)** — derives a structural digest from each game's VGDL and stores a per-game "memory" record under `web/data/strategy-memory/`. `strategy-memory-evaluator.js` A/B-tests a `baseline` prompt vs a `digest-memory` prompt to measure whether injecting the digest helps. Generate/evaluate via `scripts/generate-strategy-memory.js` and `scripts/evaluate-strategy-memory.js`.
- **Eval harness (`eval-plan.js`, `batch-evaluator.js`, `offline-game-evaluator.js`, `routes/evals.js`)** — `buildArcadeEvalPlan()` enumerates game × model × strategy cases; `runArcadeBatchEvaluation()` executes them by spawning real Java game sessions and real LLM calls (slow, costs tokens — `npm run eval:arcade:execute`). `offline-game-evaluator.js` is the scripted-policy stand-in used by tests and dry runs so the prompt/parse pipeline can be exercised without a live model. Output artifacts land in `web/evals/` and `web/data/eval-runs/`; the `/api/evals/arcade` route serves the plan and `/api/evals/arcade/run` triggers a batch.

## Development Notes

- `imageArray` in SSO JSON is stripped before `JSON.parse` in `llm-client.js` (it's megabytes of base64 PNG)
- `extractQuickState()` does fast field extraction from raw JSON strings to avoid full parsing on every tick — only LLM calls do full `JSON.parse`
- The `observationGrid` is `[x][y][sprites]` (columns-first) — iterate `y` as outer loop for row-by-row display
- `Observation` objects have `category` (0-6) and `itype` (game-specific sprite ID)
- Game index: `examples/all_games_sp.csv` (line number = gameId)
- VGDL game definitions: `examples/gridphysics/{gameName}.txt` with levels at `{gameName}_lvl{0-4}.txt`
- Java agents must return actions within `ElapsedCpuTimer` budget
- Framework loads agents via reflection from class path strings
- `.gitignore` has aggressive global patterns (`*.html`, `*.xml`, `*.gif`); `web/public/index.html` is the frontend entry point and is tracked only via an explicit `!web/public/index.html` exception — don't remove it or new HTML assets under `web/public/` will silently fall out of version control
- `AGENTS.md` (repo root) holds the same project conventions plus a writing-style rule that applies to prose/comments here: write plainly; avoid coined noun phrases, choppy sentence chains, and broad claims not grounded in files, commands, game ids, or observed behavior
