# GVGAI Web Frontend with OpenRouter LLM Integration

A web-based interface for watching AI language models play GVGAI games in real-time.

## Features

- Browse and select from 122+ classic video games
- Choose from multiple LLM models via OpenRouter
- Watch AI agents play games with real-time visual output
- See LLM reasoning and decision-making process
- View game statistics and performance metrics

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

3. **State Converter** (`lib/state-converter.js`)
   - Transforms `SerializableStateObservation` to natural language
   - Multiple prompt strategies available

4. **Response Parser** (`lib/response-parser.js`)
   - Extracts valid GVGAI actions from LLM text
   - Fallback to `ACTION_NIL` on parse failure

### Frontend (Vanilla JS)

- **Game Selector**: Displays catalog, handles search/filter
- **Model Selector**: LLM configuration interface
- **Game Viewer**: Live game display with WebSocket streaming
- **Reasoning Display**: Shows LLM prompts/responses in real-time

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
