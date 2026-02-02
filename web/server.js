// Load environment variables from parent directory
require('dotenv').config({ path: '../.env' });

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const config = require('./config.json');
const gameManager = require('./lib/game-manager');
const LLMClient = require('./lib/llm-client');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Validate API key on startup (non-fatal for local Ollama usage)
const validationClient = new LLMClient();
validationClient.validateApiKey().then(valid => {
  if (!valid) {
    console.warn('[Server] Invalid OpenRouter API key. LLM calls to OpenRouter will fail.');
  } else {
    console.log('[Server] LLM backend ready');
  }
});

// Screenshot streaming
let screenshotWatcher = null;
let lastScreenshotMtime = null;  // Track last modification time to deduplicate
const screenshotPath = path.join(config.gvgai.projectRoot, config.gvgai.screenshotPath);

function startScreenshotStreaming() {
  if (screenshotWatcher) {
    screenshotWatcher.close();
  }

  console.log('[Server] Starting screenshot streaming from:', screenshotPath);

  screenshotWatcher = chokidar.watch(screenshotPath, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 10,  // Reduced from 50ms to 10ms for lower latency
      pollInterval: 5          // Reduced from 10ms to 5ms for faster detection
    }
  });

  screenshotWatcher.on('add', (path) => {
    console.log('[Server] Screenshot file added:', path);
    sendScreenshotAsync();  // Use async version
  });
  screenshotWatcher.on('change', (path) => {
    console.log('[Server] Screenshot file changed:', path);
    sendScreenshotAsync();  // Use async version
  });
  screenshotWatcher.on('error', (error) => {
    console.error('[Server] Screenshot watcher error:', error);
  });
}

// Async version: Uses promises to avoid blocking event loop
async function sendScreenshotAsync() {
  try {
    if (!fs.existsSync(screenshotPath)) {
      return;
    }

    const stats = await fs.promises.stat(screenshotPath);

    // Deduplicate based on modification time
    if (lastScreenshotMtime && stats.mtime.getTime() === lastScreenshotMtime) {
      return; // Same file, skip sending
    }
    lastScreenshotMtime = stats.mtime.getTime();

    // Async file read (doesn't block event loop)
    const imageBuffer = await fs.promises.readFile(screenshotPath);

    // Offload base64 encoding to next tick to spread CPU cost
    const base64 = await new Promise((resolve) => {
      setImmediate(() => resolve(imageBuffer.toString('base64')));
    });

    io.emit('game-frame', {
      image: `data:image/png;base64,${base64}`,
      timestamp: Date.now(),
      mtime: stats.mtime.toISOString()
    });

    console.log(`[Server] Screenshot sent: ${stats.size} bytes, modified: ${stats.mtime.toISOString()}`);
  } catch (error) {
    console.error('[Server] Error sending screenshot:', error.message);
  }
}

function stopScreenshotStreaming() {
  if (screenshotWatcher) {
    screenshotWatcher.close();
    screenshotWatcher = null;
    lastScreenshotMtime = null;  // Reset on stop
    console.log('[Server] Stopped screenshot streaming');
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Resolve game name from CSV registry by index
function resolveGameName(gameId) {
  try {
    const csvPath = path.join(config.gvgai.projectRoot, 'examples/all_games_sp.csv');
    const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
    if (gameId >= 0 && gameId < lines.length) {
      const filepath = lines[gameId].split(',')[1].trim();
      return path.basename(filepath, '.txt');
    }
  } catch (e) {
    console.error('[Server] Failed to resolve game name:', e.message);
  }
  return 'unknown';
}

// API Routes
app.use('/api/games', require('./routes/games'));
app.use('/api/models', require('./routes/models'));
app.use('/api/prompts', require('./routes/prompts'));

// Active game instances
const activeGames = new Map();

// Start game endpoint (API key loaded from environment)
app.post('/api/game/start', async (req, res) => {
  const { gameId, levelId, model } = req.body;

  try {
    console.log(`[Server] Starting game ${gameId} (level ${levelId}) with model ${model}`);

    // Kill any existing games first to free port 8080
    for (const [pid, game] of activeGames) {
      console.log(`[Server] Cleaning up previous game ${pid}`);
      game.llmClient.disconnect();
      gameManager.stopGame(pid);
      activeGames.delete(pid);
    }
    stopScreenshotStreaming();

    // Start Java game process (no visuals - headless)
    const gameProcess = gameManager.startGame(gameId, levelId || 0, false);

    // Wait for Java to report socket is listening (via stdout)
    const socketReady = await gameManager.waitForReady(gameProcess.processId, 10000);
    if (!socketReady) {
      gameManager.stopGame(gameProcess.processId);
      return res.status(500).json({ error: 'Java game process failed to start' });
    }

    // Start screenshot streaming BEFORE LLM connects (screenshots begin on first ACT tick)
    startScreenshotStreaming();

    // Create and connect LLM client
    const llmClient = new LLMClient();

    // Wire session-end cleanup
    llmClient.onSessionEnd = () => {
      console.log(`[Server] Session ended for ${gameProcess.processId}, cleaning up`);
      activeGames.delete(gameProcess.processId);
      stopScreenshotStreaming();
      gameManager.stopGame(gameProcess.processId);
    };

    // Connect LLM client to GVGAI socket
    try {
      const gameName = resolveGameName(gameId);
      await llmClient.connect(config.gvgai.socketPort, model, io, gameId, gameName);
      console.log('[Server] LLM client connected successfully');
    } catch (error) {
      console.error('[Server] Failed to connect LLM client:', error);
      gameManager.stopGame(gameProcess.processId);
      stopScreenshotStreaming();
      return res.status(500).json({ error: 'Failed to connect to game socket' });
    }

    activeGames.set(gameProcess.processId, {
      gameProcess,
      llmClient
    });

    res.json({
      status: 'started',
      processId: gameProcess.processId,
      gameId,
      model
    });
  } catch (error) {
    console.error('[Server] Error starting game:', error);
    stopScreenshotStreaming();
    res.status(500).json({ error: error.message });
  }
});

// Stop game endpoint
app.post('/api/game/stop', (req, res) => {
  const { processId } = req.body;

  const game = activeGames.get(processId);
  if (game) {
    game.llmClient.disconnect();
    gameManager.stopGame(processId);
    activeGames.delete(processId);
    stopScreenshotStreaming();

    res.json({ status: 'stopped', processId });
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

// WebSocket connection
io.on('connection', (socket) => {
  console.log('[Server] Frontend connected:', socket.id);
  console.log('[Server] Active connections:', io.engine.clientsCount);

  socket.on('disconnect', (reason) => {
    console.log('[Server] Frontend disconnected:', socket.id, 'reason:', reason);
    console.log('[Server] Remaining connections:', io.engine.clientsCount);
  });

  socket.on('error', (error) => {
    console.error('[Server] Socket error:', socket.id, error);
  });
});

// Cleanup on server shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');

  // Stop all games
  for (const [processId, game] of activeGames) {
    game.llmClient.disconnect();
    gameManager.stopGame(processId);
  }

  activeGames.clear();
  stopScreenshotStreaming();
  process.exit(0);
});

// Start server
const PORT = config.server.port;
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] GVGAI project root: ${config.gvgai.projectRoot}`);
  console.log(`[Server] OpenRouter API key loaded from .env`);
});
