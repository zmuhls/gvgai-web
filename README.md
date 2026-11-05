# Inference Arcade

Play the original GVGAI games with Cloudflare **Clef**, or select **Clef-flash**
for its smaller decision model. The Java engine supplies legal actions and bounded
simulated consequences. Clef returns a typed action distribution; the engine
executes one selected action, then observes and replans.

This is a simulator-assisted agent. It runs in synchronized decision mode, with
request deadlines rather than the competition's 40 ms controller budget. Original
game mechanics, levels, scoring, and win conditions remain unchanged. Forecasts
are estimates, especially in stochastic games. Displayed percentages are action
preferences, not chances of winning. No model-authored rationale is fabricated.

## Run locally

Requires Node 22+ and Java 11. Keep provider credentials on the server. To use
CLEF through OpenRouter's native Decisions API:

```sh
npm --prefix web ci
npm --prefix web run java:prepare
export CLEF_PROVIDER=openrouter
export CLEF_OPENROUTER_API_KEY=your_budget_limited_openrouter_key
npm --prefix web run start:clef
```

This route pins the Cloudflare serving provider, caps its input price at $0.24
per million tokens, and disables provider fallback. It preserves the same typed
action schema and probability validation. The catalog keeps stable CLEF model
IDs while events identify OpenRouter as the transport. The dedicated key avoids
changing credentials used by legacy chat models.

Direct Workers AI remains supported: set `CLEF_PROVIDER=cloudflare`,
`CLOUDFLARE_ACCOUNT_ID` and a server-side `CLOUDFLARE_API_TOKEN` with Workers AI
access, or configure the dedicated `CLEF_RELAY_URL` and `CLEF_RELAY_SECRET`.

Open http://localhost:3000, choose a game, leave Clef selected, and start model
play. Each Clef run stops after the selected level. Clef-flash uses the same control loop. Human play and the legacy chat models
remain selectable when configured. The generic `npm --prefix web start` entry
point retains the operator's existing configuration.

The explicit CLEF startup profile supplies defaults of 300 decisions/calls and
10 minutes per run, with shared caps of 1,000 calls/hour, 2,000/day and 10,000/month.
Existing environment settings take priority, including the older 20-call settings
in `.env.example`. Those short limits will stop most games before completion.
Background inference stays off unless explicitly enabled. Calls, including failed
attempts, consume the persisted allowance. Provider errors end the run visibly;
they do not silently become waiting moves or calls to another provider.

## Decision loop

1. The browser starts the Java game over the existing Node/Socket.IO bridge.
2. Java sends the current observation, sprite names and one forecast per legal
   action. Search is bounded to 12 steps, beam width 16 and 800 simulator advances
   per first action, including seven immediate risk samples. Static Sokoban dead
   squares receive an explicit warning.
3. Clef receives the source VGDL rules, coordinates, recent outcomes and candidate
   consequences through the typed `state` / `questions` API, directly or through
   OpenRouter's Decisions endpoint.
4. The server validates model identity, legal choice and the probability
   distribution, applies that action once, and requests the next observation.
5. The browser shows action preferences and expandable simulator evidence. It does
   not score strategy adherence from prose that Clef never generated.

The engine's planning API is available only in the explicit `JSON_PLANNING`
protocol mode. Other controllers retain their competition time budget. The game
cannot advance while a Clef request is outstanding. A stopped run, changed level,
or obsolete strategy invalidates its pending response.

## Validate

```sh
npm --prefix web test
npm --prefix web run eval:arcade
npm --prefix web run eval:clef -- --games 58,26,50,15,13,18,66,87 --max-actions 250 --require-wins 5
```

`eval:arcade` only plans cases. `eval:clef` uses real API calls and the original
Java engine. It exits unsuccessfully unless the requested number of distinct games
win without provider errors. Receipts include source hashes, public input provenance,
requests, responses, actual engine actions, latencies, token counts, and explicit
terminal/capped/error outcomes. `--capture-only` inspects inputs locally without
contacting a provider and can never pass acceptance.

The initial November 4 acceptance suite verified seven distinct wins with full Clef:
Labyrinth, Crossfire, Hungry Birds, Camel Race, Butterflies, Chase and Modality.
Sokoban initially reached its decision cap. The subsequent push-space search
fix won all five original Sokoban levels: 15/15 repeated runs. A later startup
audit found that the first level ignored requested seeds and always used zero;
the seed path is now corrected and verified before paid evaluations begin.
See the [expanded validation report](docs/clef-sokoban-expansion.md) for the
complete matrix, provider failures and later transport checks.

See [research, design and acceptance evidence](docs/clef-overhaul.md), and the
preserved [October pilot](docs/clef-flash-pilot.md) and
[extended pilot](docs/clef-flash-extended.md). The wider GVGAI library is a research
benchmark, not a promise that this controller wins every game or level.

## Other agents and training

The earlier Ollama Cloud, OpenRouter, local Ollama and Legion routes remain
available as optional comparisons. Their text prompts and asynchronous action
queues are separate from Clef's typed, synchronized controller. The training
pipeline below applies to those chat models; it does not fine-tune Clef.

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
OLLAMA_API_KEY=...        # Ollama Cloud roster
OPENROUTER_API_KEY=...    # fallback when vLLM or Ollama Cloud cannot answer
LEGION_FALLBACK_MODEL=gemma3:27b
```

Start the server.

```bash
cd web
npm install
npm start          # http://localhost:3000
```

The marble run stays idle by default. Starting it requires `MARBLE_RUN_ENABLED=true`, an operator token, and an authenticated request; boot-time play also requires `MARBLE_RUN_AUTOSTART=true`. Each activation has case and wall-clock limits. The server starts and stops the Java process for you.

## Evaluation

```bash
cd web
npm test               # full suite (193 tests, Node's built-in runner)
npm run eval:arcade    # dry-run an arcade eval plan (no tokens spent)
```

The eval harness enumerates game × model × strategy cases with each case carrying the game's archetype from shooter-lane to chaser to collector to pusher-puzzle, with per-archetype survival and nil-loop thresholds. Results group by archetype because cross-archetype score averages are not comparable. The marble run tote board surfaces the live standings.

## Deployment

The arcade is live at **https://inference-arcade.com** with Cloudflare proxied at the apex CNAME to Railway. Railway builds from the root `Dockerfile` via GitHub push-to-deploy so every push to `master` on `zmuhls/gvgai-web` triggers a full rebuild. The Common Wall uses the project Postgres service over Railway's private network, while a separate daily cron service writes checksum-verified logical backups to a private Railway bucket. Supabase remains the telemetry store. See `CLAUDE.md` for the full deployment manifest, environment variables, operational notes.

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
    usage-guardrail.js   Remote-provider call caps across hour, day, session
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
