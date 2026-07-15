const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadRootEnv } = require('./scripts/load-root-env');
const { getConfig, getConfigLoadStatus } = require('./lib/runtime-config');
const { resolveScreenshotPath } = require('./lib/screenshot-path');
const { sanitizeStrategy } = require('./lib/state-converter');
const { createCadavreMirror } = require('./lib/cadavre-mirror');
const coordinator = require('./lib/attract-coordinator');
const finetunePipeline = require('./lib/finetune-pipeline');
const config = getConfig();
const cadavreMirror = createCadavreMirror();

const telemetry = require('./lib/telemetry-store');
const cadavreRoutes = require('./routes/cadavre');
cadavreRoutes.setMirrorCacheStatusProvider((now) => cadavreMirror.getCacheStatus(now));

let gameManager = null;
let LLMClient = null;
let HumanPlayClient = null;

function loadRuntimeModules() {
  if (!gameManager) gameManager = require('./lib/game-manager');
  if (!LLMClient) LLMClient = require('./lib/llm-client');
  if (!HumanPlayClient) HumanPlayClient = require('./lib/human-play-client');
  return { gameManager, LLMClient, HumanPlayClient };
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Screenshot streaming — native fs.watch for low-latency macOS FSEvents
let screenshotWatcher = null;
// The run that owns the frame stream right now ({ runId, source: 'walkup'|'marble' }).
// Every game-frame is tagged with it so viewers can drop frames that belong to a
// different run (the walk-up viewer ignores marble frames and vice versa).
let frameOwner = null;
let lastScreenshotDigest = null;
let lastFrameSendTime = 0;
let pendingFrameTimeout = null;
let frameReadInFlight = false;
let frameReadQueued = false;
const FRAME_MIN_INTERVAL = 33;  // ~30fps cap
const screenshotPath = resolveScreenshotPath(config.gvgai);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function isCompletePng(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 45 &&
    buffer.subarray(0, PNG_SIG.length).equals(PNG_SIG) &&
    buffer.subarray(buffer.length - PNG_IEND.length).equals(PNG_IEND);
}

function screenshotDigest(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function startScreenshotStreaming(owner = null) {
  stopScreenshotStreaming();
  frameOwner = owner && owner.runId ? { runId: owner.runId, source: owner.source || 'walkup' } : null;

  console.log('[Server] Starting screenshot streaming from:', screenshotPath);

  // Ensure file exists before watching (fs.watch requires existing file)
  const dir = path.dirname(screenshotPath);
  const filename = path.basename(screenshotPath);

  try {
    // Watch the directory for changes to the screenshot file
    screenshotWatcher = fs.watch(dir, { persistent: true }, (eventType, changedFile) => {
      if (changedFile === filename) {
        scheduleFrameSend();
      }
    });

    screenshotWatcher.on('error', (error) => {
      console.error('[Server] Screenshot watcher error:', error);
    });

    // macOS FSEvents can silently stop delivering change notifications after
    // the watched file is deleted and recreated (which prepareScreenshotTarget
    // does on every game start). A 1s polling heartbeat catches the silent
    // failure case without adding duplicate sends (content-hash dedup still
    // applies).
    screenshotWatcher._pollFallback = setInterval(() => scheduleFrameSend(), 1000);
  } catch (error) {
    console.error('[Server] Failed to start file watcher, falling back to polling:', error.message);
    // Fallback: poll every 33ms
    screenshotWatcher = setInterval(() => scheduleFrameSend(), FRAME_MIN_INTERVAL);
    screenshotWatcher._isInterval = true;
  }
}

// Throttle frame sends to ~30fps max
function scheduleFrameSend() {
  const now = Date.now();
  const elapsed = now - lastFrameSendTime;

  if (elapsed >= FRAME_MIN_INTERVAL) {
    // Send immediately
    sendScreenshotAsync();
  } else if (!pendingFrameTimeout) {
    // Schedule send for when the throttle window opens
    pendingFrameTimeout = setTimeout(() => {
      pendingFrameTimeout = null;
      sendScreenshotAsync();
    }, FRAME_MIN_INTERVAL - elapsed);
  }
  // Otherwise a send is already scheduled, skip
}

async function sendScreenshotAsync() {
  if (frameReadInFlight) {
    frameReadQueued = true;
    return;
  }

  frameReadInFlight = true;
  try {
    // Read the file first, then validate and dedup by content hash. Java writes
    // the PNG in-place, so fs.watch often fires mid-write and macOS stat values
    // can be stale across repeated overwrites. The frame bytes are tiny, so a
    // full hash is cheaper and more reliable than mtime/size bookkeeping.
    const imageBuffer = await fs.promises.readFile(screenshotPath);

    // Guard against partial writes: the browser will reject a header-only or
    // truncated data URL with "Invalid encoded image data". Do not remember a
    // partial frame as the last frame; the next fs.watch/poll tick will retry.
    if (!isCompletePng(imageBuffer)) {
      return;
    }

    const digest = screenshotDigest(imageBuffer);
    if (lastScreenshotDigest === digest) {
      return;
    }
    lastScreenshotDigest = digest;
    lastFrameSendTime = Date.now();

    // Convert to base64 data URL so the client can use it directly as img.src
    const base64 = imageBuffer.toString('base64');
    io.emit('game-frame', {
      image: `data:image/png;base64,${base64}`,
      timestamp: Date.now(),
      runId: frameOwner ? frameOwner.runId : null,
      source: frameOwner ? frameOwner.source : null
    });
  } catch (error) {
    // File might not exist yet or be mid-write, silently skip
    if (error.code !== 'ENOENT') {
      console.error('[Server] Error sending screenshot:', error.message);
    }
  } finally {
    frameReadInFlight = false;
    if (frameReadQueued) {
      frameReadQueued = false;
      scheduleFrameSend();
    }
  }
}

function stopScreenshotStreaming() {
  if (pendingFrameTimeout) {
    clearTimeout(pendingFrameTimeout);
    pendingFrameTimeout = null;
  }
  if (screenshotWatcher) {
    if (screenshotWatcher._isInterval) {
      clearInterval(screenshotWatcher);
    } else {
      if (screenshotWatcher._pollFallback) {
        clearInterval(screenshotWatcher._pollFallback);
        screenshotWatcher._pollFallback = null;
      }
      screenshotWatcher.close();
    }
    screenshotWatcher = null;
    frameOwner = null;
    lastScreenshotDigest = null;
    lastFrameSendTime = 0;
    frameReadInFlight = false;
    frameReadQueued = false;
    console.log('[Server] Stopped screenshot streaming');
  }
}

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path.startsWith('/api/telemetry')) {
    next();
    return;
  }

  const start = Date.now();
  res.on('finish', () => {
    telemetry.track({
      eventFamily: 'user_experience',
      eventType: 'api_request',
      source: 'server',
      latencyMs: Date.now() - start,
      payload: {
        method: req.method,
        path: req.path,
        status: res.statusCode
      },
      metrics: {
        status: res.statusCode
      }
    });
  });
  next();
});

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
app.use('/api/games', require('./routes/games-local'));
app.use('/api/models', require('./routes/models-local'));
app.use('/api/prompts', require('./routes/prompts-local'));
app.use('/api/evals', require('./routes/evals'));
app.use('/api/telemetry', require('./routes/telemetry'));
app.use('/api/marble', require('./routes/marble'));
app.use('/api/traces', require('./routes/traces-local'));
app.use('/api/finetune', require('./routes/finetune'));
app.use('/api/cadavre', cadavreRoutes);
app.use('/api/cadavre', require('./routes/cadavre-users'));

// Clean URL for the embeddable spectator page (also served as /marquee.html).
app.get('/marquee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'marquee.html')));

// The integrated Cadavre page is release-controlled with this service. Serving
// the committed file prevents an older upstream mirror from replacing features
// that were deployed with the backend in the same revision.
app.get('/cadavre', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadavre.html')));
app.get('/cadavre/open-sheet', (req, res) => cadavreMirror.handler('openSheet', req, res));
app.get('/haggle', (req, res) => res.sendFile(path.join(__dirname, 'public', 'haggle.html')));
app.get('/langgames', (req, res) => res.sendFile(path.join(__dirname, 'public', 'langgames.html')));

// Active game instances
const activeGames = new Map();

// Start game endpoint (API key loaded from environment)
app.post('/api/game/start', async (req, res) => {
  const { gameId, levelId, model, strategy, playerType } = req.body;
  const isHumanPlay = playerType === 'human';
  // Neutralize the walk-up player's free-text tactic before it enters any prompt.
  const { text: cleanStrategy, warnings: strategyWarnings } = sanitizeStrategy(strategy);

  try {
    // A walk-up player takes priority: pause the marble run and free port 8080.
    await coordinator.beginWalkup();
    const runtime = loadRuntimeModules();
    console.log(`[Server] Starting game ${gameId} (level ${levelId}) — ${isHumanPlay ? 'human play' : `model ${model}`}`);
    const runId = telemetry.createRunId(isHumanPlay ? `human-${gameId}` : `game-${gameId}`);
    telemetry.track({
      eventFamily: 'evaluation',
      eventType: 'game_start_requested',
      source: 'server',
      runId,
      gameId,
      levelId: levelId || 0,
      modelId: isHumanPlay ? 'human' : model,
      payload: {
        strategy_present: Boolean(strategy),
        playerType: isHumanPlay ? 'human' : 'llm'
      }
    });

    // Kill any existing games first to free port 8080
    for (const [pid, game] of activeGames) {
      console.log(`[Server] Cleaning up previous game ${pid}`);
      game.client.disconnect();
      runtime.gameManager.stopGame(pid);
      activeGames.delete(pid);
    }
    stopScreenshotStreaming();

    // Start Java game process (no visuals - headless)
    const gameProcess = await runtime.gameManager.startGame(gameId, levelId || 0, false);

    // Wait for Java to report socket is listening (via stdout)
    const socketReady = await runtime.gameManager.waitForReady(gameProcess.processId, 10000);
    if (!socketReady) {
      runtime.gameManager.stopGame(gameProcess.processId);
      return res.status(500).json({ error: 'Java game process failed to start' });
    }

    // Start screenshot streaming BEFORE the client connects (screenshots begin on first ACT tick)
    startScreenshotStreaming({ runId, source: 'walkup' });

    // Create the appropriate client based on playerType.
    // Human play: HumanPlayClient sends keyboard actions via Socket.IO (no LLM calls).
    // LLM play: LLMClient with strategyMemory 'accepted' — only eval-accepted
    // strategy-memory records may replace the game-rules prompt layer.
    const initialLevelId = levelId || 0;
    const client = isHumanPlay
      ? new runtime.HumanPlayClient({ runId, initialLevelId })
      : new runtime.LLMClient({ runId, initialLevelId, promptConfigOptions: { strategyMemory: 'accepted' } });

    // Wire session-end cleanup (same for both client types)
    client.onSessionEnd = () => {
      console.log(`[Server] Session ended for ${gameProcess.processId}, cleaning up`);
      activeGames.delete(gameProcess.processId);
      stopScreenshotStreaming();
      runtime.gameManager.stopGame(gameProcess.processId);
      coordinator.endWalkup(); // resume the marble run after the walk-up finishes
    };

    // Connect client to GVGAI socket
    try {
      const gameName = resolveGameName(gameId);
      if (isHumanPlay) {
        // connect(port, model, io, gameId, gameName) — keep the LLMClient arg
        // order. Dropping 'human' here shifts io into model and the game NAME
        // into gameId, which files human traces under the wrong key and mutes
        // the client's socket emits (the pre-2026-07-06 human-trace bug).
        await client.connect(config.gvgai.socketPort, 'human', io, gameId, gameName);
      } else {
        await client.connect(config.gvgai.socketPort, model, io, gameId, gameName, cleanStrategy);
      }
      console.log(`[Server] ${isHumanPlay ? 'Human play' : 'LLM'} client connected successfully`);
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'run_started',
        source: 'server',
        runId,
        gameId,
        levelId: levelId || 0,
        modelId: isHumanPlay ? 'human' : model,
        payload: {
          gameName,
          processId: gameProcess.processId,
          playerType: isHumanPlay ? 'human' : 'llm',
          strategy_present: Boolean(strategy),
          strategy_sanitized: strategyWarnings.length > 0,
          strategy_warning_types: strategyWarnings.map(w => w.type),
          archetype: client.promptConfig?.classification?.archetype || null,
          strategic_digest_memory: client.promptConfig?.strategicDigestMemory || null
        }
      });
    } catch (error) {
      console.error(`[Server] Failed to connect ${isHumanPlay ? 'human play' : 'LLM'} client:`, error);
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'run_start_failed',
        source: 'server',
        runId,
        gameId,
        levelId: levelId || 0,
        modelId: isHumanPlay ? 'human' : model,
        payload: {
          message: error.message
        }
      });
      runtime.gameManager.stopGame(gameProcess.processId);
      stopScreenshotStreaming();
      return res.status(500).json({ error: 'Failed to connect to game socket' });
    }

    activeGames.set(gameProcess.processId, {
      gameProcess,
      client,
      llmClient: isHumanPlay ? null : client  // backward compat for code that reads game.llmClient
    });

    res.json({
      status: 'started',
      processId: gameProcess.processId,
      gameId,
      model: isHumanPlay ? 'human' : model,
      playerType: isHumanPlay ? 'human' : 'llm',
      runId,
      strategyWarnings
    });
  } catch (error) {
    console.error('[Server] Error starting game:', error);
    telemetry.track({
      eventFamily: 'evaluation',
      eventType: 'game_start_error',
      source: 'server',
      gameId,
      levelId: levelId || 0,
      modelId: model,
      payload: {
        message: error.message
      }
    });
    stopScreenshotStreaming();
    res.status(500).json({ error: error.message });
  }
});

// Steer a live LLM run: update the session strategy mid-play. The new directive
// is sanitized inside updateStrategy and takes effect on the model's next decision.
app.post('/api/game/steer', (req, res) => {
  const { processId, strategy } = req.body;

  const game = activeGames.get(processId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  if (game.client.playerType === 'human' || typeof game.client.updateStrategy !== 'function') {
    return res.status(400).json({ error: 'Steering only applies to model runs' });
  }

  const { text, warnings } = game.client.updateStrategy(strategy);
  telemetry.track({
    eventFamily: 'evaluation',
    eventType: 'run_steered',
    source: 'server',
    runId: game.client.runId,
    gameId: game.client.gameId,
    modelId: game.client.model,
    payload: {
      strategy_present: Boolean(text),
      strategy_sanitized: warnings.length > 0,
      strategy_warning_types: warnings.map(w => w.type)
    }
  });

  res.json({ status: 'steered', processId, strategy: text, strategyWarnings: warnings });
});

// Stop game endpoint
app.post('/api/game/stop', (req, res) => {
  const { processId } = req.body;

  const game = activeGames.get(processId);
  if (game) {
    game.client.disconnect();
    if (gameManager) gameManager.stopGame(processId);
    activeGames.delete(processId);
    stopScreenshotStreaming();
    coordinator.endWalkup(); // resume the marble run after the walk-up stops
    telemetry.track({
      eventFamily: 'evaluation',
      eventType: 'run_stopped',
      source: 'server',
      runId: game.client.runId,
      gameId: game.client.gameId,
      modelId: game.client.model || (game.client.playerType === 'human' ? 'human' : null),
      payload: { processId }
    });

    res.json({ status: 'stopped', processId });
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

// WebSocket connection
io.on('connection', (socket) => {
  console.log('[Server] Frontend connected:', socket.id);
  console.log('[Server] Active connections:', io.engine.clientsCount);
  // Hydrate late-joining spectators (e.g. a freshly opened /marquee iframe).
  socket.emit('marble-run-state', coordinator.getSnapshot());
  telemetry.track({
    eventFamily: 'user_experience',
    eventType: 'socket_connected',
    source: 'socket',
    sessionId: socket.id,
    payload: {
      clients: io.engine.clientsCount
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[Server] Frontend disconnected:', socket.id, 'reason:', reason);
    console.log('[Server] Remaining connections:', io.engine.clientsCount);
    telemetry.track({
      eventFamily: 'user_experience',
      eventType: 'socket_disconnected',
      source: 'socket',
      sessionId: socket.id,
      payload: {
        reason,
        clients: io.engine.clientsCount
      }
    });
  });

  socket.on('error', (error) => {
    console.error('[Server] Socket error:', socket.id, error);
  });

  // Human play: forward keyboard actions from the browser to the active HumanPlayClient
  socket.on('human-action', (data) => {
    for (const [, game] of activeGames) {
      if (game.client && game.client.playerType === 'human' && game.client.gameActive) {
        game.client.setAction(data.action);
        break;
      }
    }
  });
});

// Cleanup on server shutdown
let shutdownStarted = false;

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n[Server] Shutting down (${signal})...`);

  const forcedExit = setTimeout(() => {
    console.error('[Server] shutdown exceeded 15 seconds; exiting.');
    process.exit(1);
  }, 15000);
  forcedExit.unref();
  const httpClosed = server.listening
    ? new Promise(resolve => server.close(resolve))
    : Promise.resolve();
  io.disconnectSockets(true);

  // Stop all games
  for (const [processId, game] of activeGames) {
    game.client.disconnect();
    if (gameManager) gameManager.stopGame(processId);
  }

  activeGames.clear();
  coordinator.stop();
  finetunePipeline.shutdown();
  stopScreenshotStreaming();
  telemetry.track({
    eventFamily: 'system',
    eventType: 'server_stopped',
    source: 'server'
  });
  await Promise.allSettled([
    httpClosed,
    telemetry.flush()
  ]);
  await Promise.allSettled([cadavreRoutes.closeWallStore()]);
  clearTimeout(forcedExit);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PORT = Number.parseInt(process.env.PORT || config.server.port || 3000, 10);

async function startServer() {
  const envLoad = await loadRootEnv();
  if (envLoad.timedOut) {
    console.warn(`[Server] skipped root .env after ${envLoad.timeoutMs}ms; using process environment`);
  }
  const configStatus = getConfigLoadStatus();
  if (configStatus.fallback) {
    console.warn(`[Server] using runtime config defaults because config.json did not load within ${configStatus.timeoutMs}ms`);
  }

  telemetry.configure({
    io,
    fallbackPath: path.resolve(__dirname, 'data', 'telemetry-events.jsonl')
  });
  telemetry.track({
    eventFamily: 'system',
    eventType: 'server_started',
    source: 'server',
    payload: {
      port: config.server.port,
      supabase: telemetry.getStorageStatus().state
    }
  });

  if (process.env.VALIDATE_LLM_ON_STARTUP === 'true') {
    try {
      const runtime = loadRuntimeModules();
      const validationClient = new runtime.LLMClient();
      validationClient.validateApiKey().then(valid => {
        if (!valid) {
          console.warn('[Server] Invalid OpenRouter API key. LLM calls to OpenRouter will fail.');
        } else {
          console.log('[Server] LLM backend ready');
        }
      });
    } catch (error) {
      console.warn('[Server] LLM validation skipped:', error.message);
    }
  } else {
    console.log('[Server] LLM validation deferred until a run starts');
  }

  return new Promise(resolve => {
    server.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
      console.log(`[Server] GVGAI project root: ${config.gvgai.projectRoot}`);
      console.log(`[Server] OpenRouter API key loaded from environment`);
      cadavreRoutes.startModelWarmer();

      // Wire the attract-mode marble run onto the single Java process. It shares the
      // one screenshot streamer and yields to any walk-up player (activeGames > 0).
      const runtime = loadRuntimeModules();
      coordinator.configure({
        io,
        streamer: { start: startScreenshotStreaming, stop: stopScreenshotStreaming },
        isWalkupActive: () => activeGames.size > 0,
        gameManager: runtime.gameManager,
        telemetry,
        caseOptions: { maxActions: 40, synchronousActions: false }
      });
      // Fine-tune pipeline: route is always mounted; the auto-trigger is opt-in
      // (FINETUNE_AUTO_ENABLED=1) so the deployed instance stays inert. Completed
      // local Ollama loads are delegated to the marble run, which already owns
      // the single Java port.
      finetunePipeline.configure({
        io,
        telemetry,
        enqueueMarbleEval: model => coordinator.addFinetunedModel(model)
      });
      if (process.env.FINETUNE_AUTO_ENABLED === '1') {
        finetunePipeline.startAutoTrigger();
      }
      // Always-on by default (attract mode); set MARBLE_RUN_AUTOSTART=false to disable.
      if (process.env.MARBLE_RUN_AUTOSTART !== 'false') {
        coordinator.start();
        console.log('[Server] Attract-mode marble run started');
      } else {
        console.log('[Server] Attract-mode marble run autostart disabled');
      }

      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('[Server] failed to start:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  startServer,
  isCompletePng,
  screenshotDigest
};
