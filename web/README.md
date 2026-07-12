# GVGAI Web Frontend with OpenRouter LLM Integration

A web-based interface for watching AI language models play GVGAI games in real-time.

## Features

- Browse and select from 122+ classic video games
- Choose from multiple LLM models via OpenRouter
- Watch AI agents play games with real-time visual output
- See LLM reasoning and decision-making process
- View game statistics and performance metrics
- Stream telemetry to Supabase with a local dashboard and JSONL fallback
- View the Model-Native Arcade roadmap for the ten-game no-Java migration path

## Prerequisites

- Node.js 16+ installed
- Java 11+ installed (OpenJDK)
- GVGAI project compiled (run from project root)
- OpenRouter API key ([get one here](https://openrouter.ai/keys))

## Quick Start

### 1. Compile GVGAI (if not already done)

From the GVGAI project root:

```bash
export PATH="/usr/local/opt/openjdk@11/bin:/usr/bin:$PATH"
export JAVA_HOME="/usr/local/opt/openjdk@11"
/usr/bin/find src -name "*.java" > sources.txt
javac -cp "gson-2.6.2.jar" -d out @sources.txt
```

### 2. Install Node.js Dependencies

```bash
cd web
npm install
```

### 3. Start the Web Server

```bash
npm start
```

The server will start on `http://localhost:3000`

### 4. Open in Browser

Navigate to `http://localhost:3000` in your web browser.

## How to Use

### Step 1: Select a Game

1. Browse the game catalog or use the search bar
2. Click on any game card to select it
3. Games are categorized as `gridphysics` or `contphysics`

Popular games to try:
- **aliens** - Space shooter (0)
- **pacman** - Classic maze game (37)
- **zelda** - Adventure/puzzle game (78)
- **sokoban** - Block-pushing puzzle (63)

### Step 2: Configure AI Agent

1. Select an LLM model from the dropdown:
   - **Claude 3.5 Haiku** - Fast, cheap, good for rapid gameplay
   - **Claude 3.5 Sonnet** - Balanced performance
   - **GPT-4 Turbo** - Advanced reasoning
   - **GPT-3.5 Turbo** - Fast and reliable

2. Choose a level (0-4, depending on game)

3. Enter your OpenRouter API key
   - Get one at [openrouter.ai/keys](https://openrouter.ai/keys)
   - Your key is only stored in browser session memory
   - Never committed to disk or sent anywhere except OpenRouter

4. Click **Start Game**

### Step 3: Watch AI Play

- **Game Display**: Live visual output from the game
- **Game Stats**: Score, health, and tick count in overlay
- **LLM Reasoning Panel**: Real-time view of:
  - Prompts sent to the LLM
  - LLM responses
  - Actions taken
  - Response timing (color-coded):
    - 🟢 Green: < 40ms (safe)
    - 🟡 Yellow: 40-50ms (close to limit)
    - 🔴 Red: > 50ms (over budget, using fallback)

The AI will play until the game ends (win, lose, or timeout).

## Architecture

```
┌─────────────┐     HTTP/WS     ┌──────────────┐
│  Browser    │◄────────────────►│  Node.js     │
│  (Frontend) │                  │  Server      │
└─────────────┘                  └──────────────┘
                                        │
                    ┌───────────────────┼─────────────────┐
                    │                   │                 │
                    ▼                   ▼                 ▼
            ┌──────────────┐   ┌──────────────┐  ┌──────────────┐
            │  GVGAI       │   │  LLM Agent   │  │  OpenRouter  │
            │  Java Game   │◄──►│  Client      │◄─►│  API         │
            │  (Socket)    │   │              │  │              │
            └──────────────┘   └──────────────┘  └──────────────┘
```

## How It Works

### Backend (Node.js)

1. **Game Manager** (`lib/game-manager.js`)
   - Spawns Java GVGAI process
   - Manages game lifecycle

2. **LLM Client** (`lib/llm-client.js`)
   - Connects to GVGAI socket (port 8080)
   - Receives game state as JSON
   - Converts state to text prompt
   - Calls OpenRouter API
   - Parses LLM response to game action
   - Sends action back to game

3. **Model-Native Roadmap** (`routes/roadmap.js`, `data/model-native-roadmap.json`)
   - Lists the ten starter games for the no-Java runtime path
   - Documents the lifecycle from VGDL harvest to vLLM adapter promotion
   - Keeps external reuse references behind license review

4. **State Converter** (`lib/state-converter.js`)
   - Transforms `SerializableStateObservation` to natural language
   - Multiple prompt strategies available

5. **Response Parser** (`lib/response-parser.js`)
   - Extracts valid GVGAI actions from LLM text
   - Fallback to `ACTION_NIL` on parse failure

### Frontend (Vanilla JS)

- **Game Selector**: Displays catalog, handles search/filter
- **Model Selector**: LLM configuration interface
- **Game Viewer**: Live game display with WebSocket streaming
- **Reasoning Display**: Shows LLM prompts/responses in real-time
- **Telemetry Stream**: Shows eval, UX, clickthrough, model, and trace events

## Configuration

Edit `config.json` to customize:

```json
{
  "server": {
    "port": 3000
  },
  "gvgai": {
    "socketPort": 8080,
    "javaPath": "/usr/local/opt/openjdk@11/bin/java",
    "projectRoot": "/path/to/GVGAI"
  },
  "openrouter": {
    "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
    "defaultModel": "anthropic/claude-3-5-haiku"
  }
}
```

## Handling the 40ms Time Constraint

GVGAI requires agents to return actions within 40ms, but LLMs typically take 200-2000ms to respond.

**Solution**: Timeout with fallback
- LLM request starts asynchronously
- If response arrives within 35ms, use it
- Otherwise, send `ACTION_NIL` (do nothing) as safe fallback
- LLM continues running for future ticks

This allows the game to run smoothly while still benefiting from LLM decision-making.

## Troubleshooting

### "Failed to connect to game socket"

- Ensure GVGAI is compiled (`out/` directory exists)
- Check Java path in `config.json`
- Wait 2-3 seconds after starting game before LLM connects

### "No game visuals showing"

- GVGAI learning track may not generate screenshots in all modes
- Check console for errors
- Try a different game

### "LLM always timing out"

- This is expected! LLMs are slow
- Green timing indicators are rare
- Yellow/red is normal - game uses fallback actions

### "OpenRouter API error"

- Verify your API key is correct
- Check you have credits at OpenRouter
- Some models may not be available

## API Endpoints

- `GET /api/games` - List all games
- `GET /api/models` - List available LLM models
- `POST /api/game/start` - Start a game session
- `POST /api/game/stop` - Stop a game session
- `GET /api/evals/arcade` - Build the default arcade prompt-evaluation plan
- `POST /api/evals/arcade/run` - Run selected prompt cases and compare results
- `GET /api/telemetry/summary` - Read dashboard rollups and recent telemetry
- `POST /api/telemetry/events` - Log browser UX and clickthrough events through the server
- `POST /api/telemetry/flush` - Flush pending telemetry writes
- `GET /api/roadmap/model-native` - Read the Model-Native Arcade lifecycle, starter games, and reuse references

Supabase setup is documented in [`SUPABASE_TELEMETRY.md`](./SUPABASE_TELEMETRY.md).
Use `npm run telemetry:check` after adding Supabase credentials to verify the cloud insert path and rollup view.
Use `npm run telemetry:backfill` to upload local JSONL fallback events captured before credentials were available.

## Cadavre mirror and model routes

`/cadavre` and `/cadavre/open-sheet` read the canonical interfaces from
`milwrite/cadavre-exquis` with a 30-second server cache. The tracked files
`public/cadavre.html` and `public/cadavre-open-sheet.html` serve as cold-start
fallbacks. Refresh both fallback files after a canonical UI release:

```bash
npm run sync:cadavre-ui
```

The browser receives route ids and calls this server:

- `GET /api/cadavre/models` returns the available `legion:<model>` and
  `ollama:<model>` choices.
- `GET /api/cadavre/usage` reports the active request limits, chat volume,
  latency, provider-call ratio, token counts, guardrail use, and cache
  efficiency for the model catalog and HTML mirror.
- `POST /api/cadavre/chat` resolves one listed route through a server-owned
  provider endpoint. Transient Ollama failures receive one retry inside a
  shared 50-second deadline, followed by the configured OpenRouter equivalent
  when that model has one.

Cadavre writes one privacy-safe telemetry event per chat request and one cache
snapshot per upstream refresh. These records contain counts and timings rather
than poem or prompt text. The HTML mirror and model catalog coalesce concurrent
cold reads, while chat completions remain fresh for each turn. The usage route
labels its live counters as process-scoped; persisted telemetry combines events
across server instances and deployments.

```bash
npm run test:cadavre
```

Production uses `OLLAMA_API_KEY` for Ollama Cloud. Add `LEGION_VLLM_URL` when
the Exquisite Corpse vLLM host has an HTTPS endpoint that Railway can reach;
`LEGION_API_KEY` supplies its optional bearer token. The browser sees model
names and completion responses while provider credentials remain in Railway.
`CADAVRE_OLLAMA_MODEL` can change the default Cloud choice from
`deepseek-v4-flash`.

## Model-Native Arcade Path

The first no-Java migration set is configured in `data/featured.json` and
`data/model-native-roadmap.json`: aliens, boulderchase, cakybaky, chase,
butterflies, chipschallenge, chopper, clusters, digdug, and pacman. The current
Java runtime remains the oracle for v1 while a smaller non-Java gridphysics
subset is built and checked against sampled Java ticks.

For Legion vLLM adapter runs, configure:

```bash
FINETUNE_PROVIDER=legion-vllm
FINETUNE_OUTPUT_DIR=/srv/adapters
LEGION_MODEL_ID_PREFIX=gvgai
```

The generated adapter id is stable, for example `gvgai-aliens`, and the model
registry keeps `provider: "legion-vllm"` so the existing model router can call
the vLLM endpoint with that adapter name.

## WebSocket Events

**Server → Client:**
- `game-frame`: Game screenshot (base64 PNG)
- `llm-reasoning`: LLM prompt/response/action
- `game-end`: Game over with final stats

## Development

### Run in dev mode with auto-reload:

```bash
npm run dev
```

### Run batch prompt evaluations:

```bash
/usr/local/bin/node web/scripts/run-arcade-eval.js --game-count 1 --model gpt-oss:120b --limit 3
```

The default batch runs the first featured game, one model, and three prompt strategies. Results are written to `web/data/eval-runs/*.json` with per-run score, winner, ticks, actions, adherence, and a comparison block that marks whether prompt variants produced a meaningful difference.

Prepare the hydrated Java runtime when macOS cloud-backed files block the GVGAI tree:

```bash
/usr/local/bin/node web/scripts/prepare-java-runtime.js
```

Run a Java-backed local-model prompt check against real GVGAI:

```bash
/usr/local/bin/node web/scripts/run-arcade-eval.js --game-count 1 --model qwen2.5:0.5b --limit 3 --max-actions 12
```

This starts the Java `tracks.singleLearning.utils.JavaServer`, plays the selected GVGAI level through the socket protocol, and caps each case after the requested number of model actions so prompt comparisons finish quickly.

Run the local offline prompt-policy check when provider keys or GVGAI Java startup are unavailable:

```bash
/usr/local/bin/node web/scripts/run-arcade-eval.js --offline --game-count 1 --model local-prompt-policy --limit 3
```

This uses the same eval plan and comparison code, but runs a small deterministic game locally so prompt differences can be verified without OpenRouter, Ollama Cloud, or the Java engine.

Run the local Ollama check to make an installed model choose each move:

```bash
/usr/local/bin/node web/scripts/run-arcade-eval.js --ollama-offline --game-count 1 --model qwen2.5:0.5b --ollama-model qwen2.5:0.5b --limit 3
```

The Ollama mode uses the same local game and comparison output, while calling the configured Ollama model for every action.

Preview the selected cases without launching Java or calling a model:

```bash
/usr/local/bin/node web/scripts/run-arcade-eval.js --dry-run --game-count 1 --model gpt-oss:120b --limit 3
```

### Project Structure

```
web/
├── server.js              # Main Express server
├── package.json           # Dependencies
├── config.json            # Configuration
├── lib/                   # Backend libraries
│   ├── game-manager.js    # Java process management
│   ├── llm-client.js      # OpenRouter integration
│   ├── state-converter.js # State to prompt conversion
│   └── response-parser.js # LLM response parsing
├── routes/
│   ├── games.js           # Game API endpoints
│   └── models.js          # Model API endpoints
└── public/                # Frontend files
    ├── index.html
    ├── css/styles.css
    └── js/app.js          # Main frontend app
```

## Future Enhancements

- Batch mode: Run multiple games automatically
- Model comparison: Run 2+ models side-by-side
- Custom prompt templates editor
- Game replay system
- Performance analytics dashboard
- Export gameplay data for LLM fine-tuning

## License

Same as GVGAI project license.

## Credits

- GVGAI Framework: [github.com/GAIGResearch/GVGAI](https://github.com/GAIGResearch/GVGAI)
- OpenRouter: [openrouter.ai](https://openrouter.ai)
