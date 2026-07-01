Web-Based LLM Game Evaluation
=====

Watch language models play classic video games in real time, and read the reasoning behind each move.

This is an expanded fork of the [original GVGAI repository](https://github.com/GAIGResearch/GVGAI). The upstream project supplies a Java engine that runs 122+ 2D grid games written in VGDL. This fork adds a layer under `web/`: a Node.js server that connects an LLM to the engine over a TCP socket, plus a browser frontend that shows the game, the model's per-move reasoning, and an end-of-run summary.

It is part of the CUNY AI Lab's Inference Arcade initiative, which fosters critical play with large language models by retrofitting them to the design grammar of classic and novel interactive games. The point is to make a model's decision-making legible: you hand it a strategy in plain language, watch it act under real-time pressure, and see where it follows the plan and where it breaks.

The Learning track code is not in this repository. It lives at https://github.com/rubenrtorrado/GVGAI_GYM.

## How it works

The browser talks to the Node server over HTTP and WebSocket. The Node server spawns the Java engine and talks to it over a TCP socket, one message per game tick. Each tick, the server sends the model the current board as an ASCII grid plus spatial context, score, and recent history; the model replies with one action and a one-sentence reason.

The engine demands an action within 40ms per tick, but a model takes 200-2000ms to answer. The server resolves this by answering each tick immediately with the previous decision while the next one computes in the background. So decisions land a few ticks late. That lag is the reason the showcase favors slower puzzle games over twitch games.

## Quick start

Requires Node.js 16+ and Java 11 (OpenJDK).

Compile the engine from the project root:

```bash
export PATH="/opt/homebrew/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@11"
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt
```

Add API keys to a `.env` file in the project root (see `.env.example`):

```
OLLAMA_API_KEY=...        # primary inference provider (Ollama Cloud)
OPENROUTER_API_KEY=...    # per-call fallback
```

Start the server:

```bash
cd web
npm install
npm start          # http://localhost:3000
```

Open `http://localhost:3000`. Pick a game, choose a strategy, and watch. The server starts and stops the Java process for you.

On start, the arcade also runs itself: an always-on **marble run** (attract mode) cycles the featured models through the featured games under contrasting strategies and broadcasts it live — so the cabinet is never dark. Watch the embeddable spectator feed at `http://localhost:3000/marquee`, and the live standings on the **Telemetry** tab. Starting a game yourself interrupts the marble run; it resumes when you stop. The loop makes real LLM calls on boot — set `MARBLE_RUN_AUTOSTART=false` to disable it.

## The arcade flow

Pick a game, tap a strategy card to drop a plain-language directive into an editable box — or **unfold the game's rules** (derived straight from its VGDL) to build a tactic from tappable facets. Whatever you type is length-capped, fenced, and neutralized server-side, so a stray note or injection can't break the model's ability to play. Then watch. A live panel shows each decision: the action, the model's stated reason, which provider answered, and an expandable **decision autopsy** of the prompt layers behind the move, alongside a running adherence ribbon. When the run ends, a summary card reports the score, echoes the strategy, and rates how closely the model stuck to it.

A separate Prompt Dashboard lets you edit the per-game prompt layers directly. Your in-session strategy never overwrites that saved config; it layers on top at runtime and is discarded when the run ends.

## Model routing

Ollama Cloud is the primary provider; OpenRouter is the fallback. Each model in the catalog (`web/lib/models.js`) declares a provider and a fallback slug. The server calls the primary, and on any error retries the fallback through OpenRouter. The frontend reports whichever provider actually answered. All providers use the OpenAI-compatible chat-completions format.

## Telemetry and evaluation

The server records events (runs, decisions, frontend interactions) and flushes them to Supabase in batches, falling back to a local JSONL log when Supabase is not configured. Both are optional and off by default.

An offline eval harness runs game-by-model-by-strategy batches to compare prompts and models without a person at the keyboard. Start with a dry run:

```bash
cd web
npm test               # full suite (Node's built-in runner)
npm run eval:arcade    # dry-run an arcade eval plan
```

## Pointers

- Game index: `examples/all_games_sp.csv` (line number is the game id)
- VGDL definitions: `examples/gridphysics/{game}.txt`, levels at `{game}_lvl{0-4}.txt`
- Per-game prompt config: `web/data/games/{id}.json`
- Architecture and internals: `CLAUDE.md`

The upstream framework also supports the Planning and PCG competition tracks. See http://www.gvgai.net/.
