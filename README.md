# Inference Arcade

Language models play classic video games in real time. You read the reasoning behind each move, hand the model a strategy in plain English, and watch where it follows the plan or breaks from it. The arcade runs itself between visitors. A fine-tune pipeline captures human gameplay, trains models via Unsloth QLoRA on a local GPU, and reloads them into the cabinet so visitors see their own play patterns reflected back in the next run.

A fork of the [GVGAI framework](https://github.com/GAIGResearch/GVGAI) supplying a Java engine for 122 2D grid games written in VGDL, with everything under `web/` built new. A Node server bridges an LLM to the engine over TCP. A browser frontend renders the canvas, the model's per-move reasoning, a telemetry dashboard with live standings, and a training pipeline that captures human traces to fine-tune models via Unsloth QLoRA.

Part of the CUNY AI Lab's Inference Arcade initiative fostering critical play with large language models by retrofitting them to the design grammar of classic games.

Live at **[inference-arcade.com](https://inference-arcade.com)**.

---

## What you see

Pick a game, tap a strategy card or write your own tactic in plain English, then watch the model play under real-time pressure with one decision per tick.

A live panel beside the game canvas surfaces each decision as it happens, displaying the action, the model's stated reason, which provider answered, and an expandable **decision autopsy** that dissects the prompt layers behind the move. A running adherence ribbon tracks whether the model's stated reasoning references your strategy's keywords. When the run ends a summary card reports the score, echoes the strategy, rates how closely the model followed it, and highlights the decisions that gained the most points.

When nobody is at the cabinet an **attract-mode marble run** cycles the featured models through the featured games under contrasting strategies, broadcasting live so the cabinet is never dark. A spectator feed lives at `/marquee` for embedding. The marble run yields to any walk-up player, resuming when the visitor stops. Live standings appear on the Telemetry tab with per-model win rate, mean score, fallback rate, strong-adherence rate, and a per-strategy breakdown.

## How a decision gets made

The browser talks to the Node server over HTTP and WebSocket. The Node server spawns the Java engine and communicates over a TCP socket with one message per game tick. The engine serializes the full game state as JSON, sends it to the server, which assembles an 8-layer prompt and calls the model. The model replies with an action and a one-sentence reason. The server sends the action back to Java within the tick budget.

The engine demands an action within 40ms per tick but a model takes 200-2000ms to answer. The server bridges this gap by responding to each tick immediately with the previous decision while the next one computes in the background, so decisions land a few ticks late. That lag is why the showcase favors slower puzzle games over twitch games, why a macro-action plan executor queues multi-step plans that drain deterministically across ticks while the next LLM call is in flight.

### Prompt layers

The assembler (`state-converter.js`) builds the prompt from eight layers, each optional, each carrying a specific job in the assembled context the model receives.

1. **System** — the game's system prompt template
2. **Game rules** — derived from the VGDL definition or replaced by an accepted strategy-memory digest
3. **Play history** — compressed summary of human traces for this game serving as a reward signal showing what high-scoring players did and what led to losses
4. **Progression** — per-level context
5. **Player tactic** — the visitor's plain-English strategy sanitized and fenced below the game rules
6. **History** — rolling recent actions with score and health deltas
7. **Spatial + grid** — ASCII grid map with orientation legend plus nearest threats, hazards, and goals in component-distance format
8. **Tick state** — current score, health, tick, last action, available actions, loop-detection warning

A separate **Prompt Dashboard** tab exposes every layer for editing. The visitor's in-session tactic never overwrites the saved config because it layers on top at runtime, discarded when the run ends. A preview button assembles the full prompt without running the game so you can inspect what the model will receive.

### Strategy sanitization

The visitor's free-text tactic is untrusted input that enters the prompt only after length capping at 240 chars, control-character collapse, contract-marker defanging, injection-stem removal, and role-prefix stripping. The cleaned text is fenced inside `<<<PLAYER_TACTIC>>>` markers, ordered below the game rules so a hostile note cannot override the action contract.

## Model routing

Seven open-weight small language models all hosted on Ollama Cloud with none carrying reasoning-token capability, keeping every output token as answer rather than hidden thinking overhead.

| Model | Provider | Fallback (OpenRouter) |
|---|---|---|
| Gemma 3 27B (featured, default) | Ollama Cloud | `google/gemma-3-27b-it` |
| Gemma 3 12B (featured) | Ollama Cloud | `google/gemma-3-12b-it` |
| Qwen3 Coder Next | Ollama Cloud | `qwen/qwen3-coder-next` |
| Ministral 3 14B | Ollama Cloud | `mistralai/ministral-14b-2512` |
| Ministral 3 8B | Ollama Cloud | `mistralai/ministral-8b-2512` |
| Ministral 3 3B | Ollama Cloud | `mistralai/ministral-3b-2512` |
| Devstral Small 2 24B | Ollama Cloud | none |

The server calls the primary provider, retrying the fallback slug through OpenRouter on any error. The provider that actually answered is reported on the `llm-reasoning` socket event and on the telemetry dashboard. A usage guardrail caps Ollama Cloud calls at 3000 per hour and 15000 per day with counters persisted across restarts. A tripped guardrail blocks the call rather than silently shifting spend to OpenRouter.

Fine-tuned models appear in the catalog automatically once registered, routing through the local Ollama daemon at `localhost:11434`, separate from the cloud API.

## Fine-tune pipeline

The arcade captures every game state and human action during play. A data prep script converts those captures into training pairs. A Python script fine-tunes a small base model via Unsloth QLoRA on a local GPU. The resulting model loads into Ollama, registers in the catalog, and appears in the frontend picker alongside the eval plan and the marble run playlist. The whole cycle can fire from 3-5 human plays.

### The cycle

```
Human plays Aliens
  → HumanPlayClient receives full game state (SSO) per tick
  → trace stored with { tick, action, score, sso } per decision
  → play-trace-store persists to disk

Trigger (manual button or auto after 10 new traces)
  → prepare-finetune-data.js replays buildPrompt() over stored SSO
  → outputs chat-message JSONL pairs
  → finetune.py loads Gemma 3 4B, applies QLoRA, trains, exports GGUF, and writes the registry entry
  → ollama-loader runs `ollama create` to serve the model locally
  → catalog reloads and the picker includes the new model
  → marble run adds the tuned model and game to its existing playlist
  → tote board shows the score delta
```

### Three tiers of impact

**Tier 1 is 1 play with no training.** The play-history prompt layer activates after the first human trace. The model sees what high-scoring players did, what actions they used. This shifts behavior through in-context learning with no GPU, no fine-tuning, no new model.

**Tier 2 is 3-10 plays with aggressive QLoRA.** With 300-1000 training pairs at rank 4 on a 4B model across 5 epochs at high learning rate, training takes 3-5 minutes on a 24GB GPU. The model learns the output format, the dominant action pattern, with impact most visible on games where the zero-shot baseline returns unparseable prose and falls back to `ACTION_NIL`.

**Tier 3 is 20+ plays with standard QLoRA.** Rank 16 across 3 epochs with a validation split lets the model generalize beyond memorized patterns. For common strategies where most visitors play Aliens the same way the training data is homogeneous and the model converges fast.

### What gets captured

Every tick during human or LLM play the client stores the raw SerializableStateObservation JSON pruned of `imageArray` to keep trace files small, alongside the action, score, health, and score delta. The data prep script reconstructs the exact 8-layer prompt the model would have received at that tick by replaying `buildPrompt()` with the stored SSO and the game's prompt config. The training pair is the assembled prompt paired with the human action. Consecutive identical pairs are deduplicated. `ACTION_NIL` is downsampled to 30% so the model does not learn to wait.

### Orchestration

`POST /api/finetune/trigger` accepts a game ID and returns 202 while the server prepares trace data in-process, then spawns the Python training script. Progress streams through Socket.IO as `finetune-progress` events with stage labels for preparing, training, exporting, loading, complete. The telemetry dashboard shows a live pipeline panel. When training finishes the server loads the GGUF into Ollama, refreshes the model catalog, and asks the marble run to add the tuned model and game to its existing playlist. The tote board annotates the fine-tuned row with a score delta against the baseline.

Auto-trigger is opt-in via `FINETUNE_AUTO_ENABLED=1`. When enabled the server checks featured games every 10 minutes, triggering the pipeline for any game with 10 or more new human traces since its last training run.

### Extensibility

The pipeline is per-game by default with one model per game, but the architecture supports several extensions without structural changes.

**Multi-game fine-tuning** works because the data prep script accepts multiple game IDs, the prompt already carries `{{gameName}}` so a model trained on several games can distinguish them, though a larger dataset and rank-16 LoRA would be needed for cross-game generalization.

**LLM distillation** is available because the SSO capture runs on LLM play too. A strong model's decisions can serve as training data for a smaller one, with the data prep script filtering by `playerType: 'human'` by default and a flag to include LLM traces.

**Strategy-specific models** are possible because the data prep script can filter traces by strategy text, so a model fine-tuned on conservative traces would learn defensive patterns while one trained on aggressive traces would learn risk-taking ones.

**Other games** work because any of the 122 GVGAI titles can run through the pipeline with a prompt config and at least one human trace. Games without custom configs use the default prompt.

**Other base models** work because the training script accepts any HuggingFace ID, with the 4B default tuned for fast iteration on 24GB VRAM. A 12B model generalizes better at the cost of longer training.

## Telemetry

The server records events in six families with `evaluation` covering runs, cases, summaries, `user_experience` covering views, searches, socket connections, `clickthrough` covering game selections, start clicks, `model_telemetry` covering per-decision latency, prompt size, parse success, `trace` covering sampled state ticks, `system` covering server lifecycle, guardrail blocks, fine-tune pipeline stages. Events buffer and flush to Supabase in batches with fallback to a local JSONL log when Supabase is unreachable.

The Telemetry tab surfaces event counts and rate, model latency percentiles, a persistence pipeline view from captured through buffered to Supabase to fallback to failures, per-model leaderboards with wins, best score, providers, game coverage, session leaderboards, a clickthrough funnel, per-minute event series, eval outcomes, trace type breakdown, marble-run standings, the Ollama Cloud guardrail status with hour and day progress bars.

## Human play mode

A keyboard input layer sends player actions directly to the Java engine via Socket.IO bypassing the LLM entirely, so the 40ms tick constraint is trivially met with no LLM latency. The spectator view mirrors LLM play with the same Socket.IO events, the same canvas, the same telemetry. Human traces are stored alongside LLM traces, feeding the same play-history prompt layer and fine-tune pipeline.

## Quick start

Requires Node.js 16+ and Java 11 (OpenJDK).

Compile the engine from the project root.

```bash
export PATH="/opt/homebrew/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@11"
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt
```

Add API keys to a `.env` file in the project root.

```
OLLAMA_API_KEY=...        # primary inference provider (Ollama Cloud)
OPENROUTER_API_KEY=...    # per-call fallback
```

Start the server.

```bash
cd web
npm install
npm start          # http://localhost:3000
```

The arcade auto-starts the marble run on local boot. Set `MARBLE_RUN_AUTOSTART=false` to disable it. The server starts and stops the Java process for you.

## Evaluation

```bash
cd web
npm test               # full suite (193 tests, Node's built-in runner)
npm run eval:arcade    # dry-run an arcade eval plan (no tokens spent)
```

The eval harness enumerates game × model × strategy cases with each case carrying the game's archetype from shooter-lane to chaser to collector to pusher-puzzle, with per-archetype survival and nil-loop thresholds. Results group by archetype because cross-archetype score averages are not comparable. The marble run tote board surfaces the live standings.

## Deployment

The arcade is live at **https://inference-arcade.com** with Cloudflare proxied at the apex CNAME to Railway. Railway builds from the root `Dockerfile` via GitHub push-to-deploy so every push to `master` on `zmuhls/gvgai-web` triggers a full rebuild. Supabase telemetry is configured and live. See `CLAUDE.md` for the full deployment manifest, environment variables, operational notes.

## Project layout

```
src/                     Java engine, agents, serialization
examples/                VGDL game definitions and levels
                         all_games_sp.csv is the single-player game index
web/
  server.js              Express + Socket.IO, game lifecycle, screenshot streaming
  lib/
    llm-client.js        TCP protocol, prompt assembly call, LLM API calls, plan executor
    human-play-client.js Keyboard input to Java engine with no LLM
    state-converter.js   8-layer prompt builder, strategy sanitization, GameStateTracker
    code-protocol.js     Compact GV1 code-prompt format and encoded heuristic policies
    game-manager.js      Java process lifecycle, port readiness, screenshot target
    attract-coordinator.js  Marble-run playlist, walk-up yield and resume
    batch-evaluator.js   Eval case runner, A/B comparison
    eval-plan.js         Game × model × strategy case enumeration
    models.js            Model catalog and dynamic fine-tuned model merge
    telemetry-store.js   Event buffering, Supabase + JSONL fallback, dashboard snapshot
    play-trace-store.js  Per-game trace persistence with SSO per tick
    finetune-registry.js Fine-tuned model registry and catalog merge
    finetune-pipeline.js Orchestration from data prep through training to Ollama load and eval
    ollama-loader.js     GGUF to local Ollama via ollama create
    prompt-store.js      Per-game prompt config and template resolution
    vgdl-digest.js       Structural digest from VGDL covering controls, scoring, hazards, win/loss
    game-classifier.js   Archetype and pace classification from digest
    strategy-memory-store.js  Per-game memory records, eval-gated injection
    usage-guardrail.js   Ollama Cloud call caps across hour, day, session
    trace-summary-builder.js  Human trace to prompt-layer summary for in-context learning
  routes/                Express routers for games, models, prompts, evals, telemetry, marble, finetune
  public/                Vanilla JS frontend with app.js, dashboard.js, telemetry-dashboard.js, marquee.js
  data/
    games/               Per-game prompt configs (122 files, one per game)
    templates/           Reusable prompt templates
    featured.json        Featured game IDs for the marble run
    strategy-memory/     Eval-gated per-game digests
    play-traces/         Human and LLM traces with SSO per tick (gitignored)
    finetune/            Training JSONL output (gitignored)
    finetune-models.json Fine-tuned model registry (gitignored)
  scripts/
    prepare-finetune-data.js  Traces to training JSONL
    finetune.py          Unsloth QLoRA training and GGUF export
    run-arcade-eval.js   CLI for batch eval execution
    prepare-java-runtime.js  Stages portable runtime with classes, source, gson
  test/                  193 tests via Node's built-in runner
  config.json            Server port, Java paths, model endpoints
  CLAUDE.md              Full architecture and internals reference
  TODO.md                Open follow-ups and deploy checklist
```

The upstream framework also supports the Planning and PCG competition tracks at http://www.gvgai.net/. The Learning track code lives at https://github.com/rubenrtorrado/GVGAI_GYM.
