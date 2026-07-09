'use strict';

// Fine-tune pipeline orchestrator: one run at a time through
// preparing (in-process data prep) → training (python child, JSON-line
// progress) → loading (GGUF into local Ollama) → complete | failed.
//
// Singleton configured from startServer() with { io, telemetry } — the same
// injection pattern as telemetry-store and attract-coordinator. Everything is
// deploy-safe by construction: python missing (Railway) fails the run with
// telemetry instead of crashing, and the auto-trigger is opt-in
// (FINETUNE_AUTO_ENABLED=1).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const gameRegistry = require('./game-registry');

const WEB_ROOT = path.join(__dirname, '..');
const STDERR_TAIL_BYTES = 8192;

class TriggerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TriggerError';
    this.code = code;
  }
}

function intFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function slugifyModelPart(value) {
  return String(value || 'game')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'game';
}

class FinetunePipeline {
  constructor() {
    this.configured = false;
    this.activeRun = null;
    this.lastRun = null;
    this._child = null;
    this._autoTimer = null;
    this._autoBackoff = new Map(); // gameId -> human trace count at last failed auto run
    this._runCounter = 0;
    this.lastAutoCheckAt = null;
  }

  configure(deps = {}) {
    this.io = deps.io || null;
    this.telemetry = deps.telemetry || require('./telemetry-store');
    this.prepareData = deps.prepareData ||
      require('../scripts/prepare-finetune-data').prepareFinetuneData;
    this.ollamaLoader = deps.ollamaLoader || require('./ollama-loader');
    this.traceStore = deps.traceStore || require('./play-trace-store');
    this.models = deps.models || require('./models');
    this.enqueueMarbleEval = deps.enqueueMarbleEval || null;
    this.spawnFn = deps.spawnFn || spawn;
    this.readFeaturedIds = deps.readFeaturedIds || gameRegistry.readFeaturedIds;
    this.readGameRegistry = deps.readGameRegistry || gameRegistry.readGameRegistry;

    this.pythonBin = deps.pythonBin || process.env.FINETUNE_PYTHON || 'python3';
    this.scriptPath = deps.scriptPath || path.join(WEB_ROOT, 'scripts', 'finetune.py');
    this.registryPath = deps.registryPath || process.env.FINETUNE_REGISTRY_PATH ||
      path.join(WEB_ROOT, 'data', 'finetune-models.json');
    this.jsonlDir = deps.jsonlDir || path.join(WEB_ROOT, 'data', 'finetune');
    this.modelsDir = deps.modelsDir || process.env.FINETUNE_OUTPUT_DIR || path.join(WEB_ROOT, 'models');
    this.trainingProvider = deps.trainingProvider || process.env.FINETUNE_PROVIDER || 'ollama-local';
    this.legionModelIdPrefix = deps.legionModelIdPrefix || process.env.LEGION_MODEL_ID_PREFIX || 'gvgai';
    this.forceDryRun = deps.forceDryRun ?? process.env.FINETUNE_DRY_RUN === '1';
    this.timeoutMs = deps.timeoutMs ?? intFromEnv('FINETUNE_TIMEOUT_MS', 6 * 60 * 60 * 1000);
    this.autoIntervalMs = deps.autoIntervalMs ?? intFromEnv('FINETUNE_AUTO_INTERVAL_MS', 600000);
    this.minNewTraces = deps.minNewTraces ?? intFromEnv('FINETUNE_MIN_NEW_TRACES', 10);
    this.minExamples = deps.minExamples ?? intFromEnv('FINETUNE_MIN_EXAMPLES', 20);

    this.configured = true;
    return this;
  }

  // Synchronous validation, then fire-and-forget (same philosophy as
  // /api/game/start): failures after acceptance surface via status/io/telemetry.
  trigger({ gameId, dryRun = false, source = 'api' } = {}) {
    if (!this.configured) throw new Error('FinetunePipeline.configure() must be called first');
    if (this.activeRun) {
      throw new TriggerError('RUN_IN_PROGRESS',
        `run ${this.activeRun.runId} is already active`);
    }
    const parsedGameId = Number.parseInt(gameId, 10);
    const game = Number.isInteger(parsedGameId)
      ? this.readGameRegistry().get(parsedGameId)
      : null;
    if (!game) {
      throw new TriggerError('INVALID_GAME', `unknown gameId: ${gameId}`);
    }

    const run = {
      runId: `finetune-${Date.now()}-${++this._runCounter}`,
      gameId: parsedGameId,
      gameName: game.name,
      state: 'preparing',
      stage: 'preparing',
      dryRun: Boolean(dryRun) || this.forceDryRun,
      source,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exampleCount: null,
      traceCount: null,
      progress: {},
      modelId: null,
      ggufPath: null,
      loadedToOllama: null,
      error: null
    };
    this.activeRun = run;

    this._track('finetune_started', run, { source });
    this._emitProgress(run, { stage: 'preparing' });

    this._execute(run).catch(err => this._failRun(run, run.stage, err, 'INTERNAL'));

    return { accepted: true, runId: run.runId, state: run.state };
  }

  async _execute(run) {
    // 1. Data prep, in-process — traces are small JSON; typed errors beat a
    // second stdout protocol. Python is the only child (it needs isolation).
    let stats;
    try {
      stats = this.prepareData({
        gameId: run.gameId,
        minExamples: this.minExamples,
        output: path.join(this.jsonlDir, `game-${run.gameId}-train.jsonl`)
      });
    } catch (err) {
      return this._failRun(run, 'preparing', err, err.code);
    }
    if (run.state === 'failed') return; // shutdown/cancel raced the prep
    run.exampleCount = stats.exampleCount;
    run.traceCount = stats.traceCount;
    run.jsonlPath = stats.jsonlPath;
    this._track('finetune_stage', run, {
      stage: 'data_prepared',
      exampleCount: stats.exampleCount,
      traceCount: stats.traceCount,
      actionDistribution: stats.actionDistribution
    });
    this._emitProgress(run, {
      stage: 'data_prepared',
      exampleCount: stats.exampleCount,
      traceCount: stats.traceCount
    });

    // 2. Training child.
    run.state = 'training';
    run.stage = 'training';
    const trained = await this._runTraining(run, stats);
    if (!trained) return;

    // 3. Load into local Ollama (skipped for dry runs / missing daemon).
    run.state = 'loading';
    run.stage = 'loading';
    await this._loadModel(run);
  }

  _runTraining(run, stats) {
    return new Promise(resolve => {
      const args = [
        this.scriptPath,
        '--data', run.jsonlPath,
        '--game-id', String(run.gameId),
        '--game-name', run.gameName,
        '--run-id', run.runId,
        '--registry', this.registryPath,
        '--output-dir', this.modelsDir,
        '--provider', this.trainingProvider,
        '--trained-on-plays', String(stats.traceCount)
      ];
      if (this.trainingProvider === 'legion-vllm') {
        args.push('--model-id', `${this.legionModelIdPrefix}-${slugifyModelPart(run.gameName)}`);
        args.push('--no-gguf');
      }
      if (run.dryRun) args.push('--dry-run');

      let child;
      try {
        child = this.spawnFn(this.pythonBin, args, {
          cwd: WEB_ROOT,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        this._failRun(run, 'training', err,
          err.code === 'ENOENT' ? 'PYTHON_MISSING' : 'SPAWN_ERROR');
        return resolve(false);
      }
      this._child = child;

      let buffer = '';
      let stderrTail = '';
      let doneSeen = false;
      let errorLine = null;
      let timedOut = false;

      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        const hardKill = setTimeout(() => child.kill('SIGKILL'), 10000);
        if (hardKill.unref) hardKill.unref();
      }, this.timeoutMs);
      if (watchdog.unref) watchdog.unref();

      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('{')) continue; // HF/llama.cpp noise on stdout
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.stage === 'done') {
            doneSeen = true;
            run.ggufPath = msg.ggufPath || null;
          }
          if (msg.stage === 'error') errorLine = msg;
          this._onTrainingMessage(run, msg);
        }
      });
      child.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      });

      child.on('error', err => {
        clearTimeout(watchdog);
        this._child = null;
        this._failRun(run, 'training', err,
          err.code === 'ENOENT' ? 'PYTHON_MISSING' : 'SPAWN_ERROR');
        resolve(false);
      });

      child.on('close', exitCode => {
        clearTimeout(watchdog);
        this._child = null;
        if (run.state === 'failed') return resolve(false); // shutdown/cancel already handled
        if (exitCode === 0 && doneSeen) return resolve(true);
        const message = errorLine?.message ||
          (timedOut ? `training timed out after ${this.timeoutMs}ms`
            : `training exited with code ${exitCode}`);
        const code = errorLine ? 'TRAINING_ERROR' : (timedOut ? 'TIMEOUT' : 'TRAINING_EXIT');
        this._failRun(run, errorLine?.errorStage || 'training', new Error(message), code, stderrTail);
        resolve(false);
      });
    });
  }

  _onTrainingMessage(run, msg) {
    if (msg.modelId) run.modelId = msg.modelId;
    if (msg.stage === 'train_step') {
      run.progress = {
        step: msg.step,
        totalSteps: msg.totalSteps,
        loss: msg.loss,
        epoch: msg.epoch
      };
    } else if (msg.stage && msg.stage !== 'error') {
      run.stage = msg.stage;
      // Stage transitions only — per-step telemetry would flood Supabase.
      this._track('finetune_stage', run, { stage: msg.stage, ...msg });
    }
    this._emitProgress(run, msg);
  }

  async _loadModel(run) {
    // The registry file was just written by python — drop the catalog cache so
    // /api/models picks the new entry up immediately.
    this.models.invalidateFinetunedCache();

    if (run.dryRun || !run.ggufPath) {
      return this._complete(run, false);
    }
    let available = false;
    try {
      available = await this.ollamaLoader.isOllamaAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      // Not an error: the registry entry stands, load later via
      // scripts/load-finetuned-model.js (see FINETUNE.md).
      this._track('finetune_stage', run, { stage: 'load_skipped', reason: 'ollama_unavailable' });
      this._emitProgress(run, { stage: 'load_skipped' });
      return this._complete(run, false);
    }
    try {
      await this.ollamaLoader.loadModel({ modelId: run.modelId, ggufPath: run.ggufPath });
    } catch (err) {
      // recoverable: GGUF + registry entry exist; only the ollama load failed.
      return this._failRun(run, 'loading', err, err.code || 'OLLAMA_LOAD_FAILED', null,
        { recoverable: true });
    }
    this._emitProgress(run, { stage: 'model_loaded', modelId: run.modelId });
    this._complete(run, true);
  }

  _complete(run, loadedToOllama) {
    if (run.state === 'failed') return;
    run.state = 'complete';
    run.stage = 'complete';
    run.loadedToOllama = loadedToOllama;
    run.finishedAt = new Date().toISOString();
    this.models.invalidateFinetunedCache();
    this._autoBackoff.delete(run.gameId);

    this._track('finetune_completed', run, {
      loadedToOllama,
      exampleCount: run.exampleCount,
      traceCount: run.traceCount
    });
    if (loadedToOllama && !run.dryRun && this.enqueueMarbleEval) {
      try {
        this.enqueueMarbleEval({
          modelId: run.modelId,
          modelName: run.modelId,
          gameId: run.gameId,
          gameName: run.gameName,
          provider: 'ollama-local',
          description: `Fine-tuned on ${run.traceCount ?? '?'} ${run.gameName} play(s)`
        });
        this._track('finetune_stage', run, {
          stage: 'marble_eval_queued',
          modelId: run.modelId,
          gameId: run.gameId
        });
      } catch (err) {
        console.warn('[FinetunePipeline] marble eval enqueue failed:', err.message);
        this._track('finetune_stage', run, {
          stage: 'marble_eval_enqueue_failed',
          message: err.message
        });
      }
    }
    if (this.io) {
      this.io.emit('finetune-complete', {
        runId: run.runId,
        modelId: run.modelId,
        gameId: run.gameId,
        gameName: run.gameName,
        dryRun: run.dryRun,
        loadedToOllama
      });
    }
    this.lastRun = run;
    this.activeRun = null;
  }

  _failRun(run, stage, err, code, stderrTail = null, extra = {}) {
    if (run.state === 'failed') return;
    run.state = 'failed';
    run.stage = stage;
    run.finishedAt = new Date().toISOString();
    run.error = {
      code: code || err.code || 'ERROR',
      message: err.message,
      stage
    };
    console.error(`[FinetunePipeline] run ${run.runId} failed at ${stage}:`, err.message);

    if (run.source === 'auto') {
      // Back off this game until its human trace count moves again.
      this._autoBackoff.set(run.gameId, this._humanTraceCount(run.gameId));
    }
    this._track('finetune_error', run, {
      stage,
      code: run.error.code,
      message: err.message,
      stderrTail: stderrTail ? stderrTail.slice(-1000) : undefined
    });
    if (this.io) {
      this.io.emit('finetune-error', {
        runId: run.runId,
        gameId: run.gameId,
        stage,
        code: run.error.code,
        message: err.message,
        ...extra
      });
    }
    this.lastRun = run;
    this.activeRun = null;
  }

  getStatus() {
    const run = this.activeRun || this.lastRun;
    return {
      active: Boolean(this.activeRun),
      run: run ? {
        runId: run.runId,
        gameId: run.gameId,
        gameName: run.gameName,
        state: run.state,
        stage: run.stage,
        dryRun: run.dryRun,
        source: run.source,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exampleCount: run.exampleCount,
        traceCount: run.traceCount,
        progress: run.progress,
        modelId: run.modelId,
        loadedToOllama: run.loadedToOllama,
        error: run.error
      } : null,
      autoTrigger: {
        enabled: Boolean(this._autoTimer),
        intervalMs: this.autoIntervalMs,
        minNewTraces: this.minNewTraces,
        lastCheckAt: this.lastAutoCheckAt
      },
      registry: {
        count: this.configured ? this.models.loadFinetunedModels().length : 0,
        path: this.registryPath || null
      },
      training: {
        provider: this.trainingProvider,
        outputDir: this.modelsDir,
        legionModelIdPrefix: this.legionModelIdPrefix
      }
    };
  }

  cancel() {
    if (!this.activeRun) {
      throw new TriggerError('NO_ACTIVE_RUN', 'no fine-tune run is active');
    }
    if (this._child) this._child.kill('SIGTERM');
    this._failRun(this.activeRun, this.activeRun.stage, new Error('cancelled by operator'), 'CANCELLED');
    return this.getStatus();
  }

  // --- opt-in auto-trigger ---------------------------------------------------

  startAutoTrigger() {
    if (!this.configured) throw new Error('FinetunePipeline.configure() must be called first');
    if (this._autoTimer) return;
    this._autoTimer = setInterval(() => this._autoCheck(), this.autoIntervalMs);
    if (this._autoTimer.unref) this._autoTimer.unref();
    console.log(`[FinetunePipeline] auto-trigger on: every ${this.autoIntervalMs}ms, ` +
      `${this.minNewTraces}+ new human traces per featured game`);
  }

  stopAutoTrigger() {
    if (this._autoTimer) clearInterval(this._autoTimer);
    this._autoTimer = null;
  }

  _autoCheck() {
    this.lastAutoCheckAt = new Date().toISOString();
    if (this.activeRun) return;
    try {
      for (const gameId of this.readFeaturedIds()) {
        const humanCount = this._humanTraceCount(gameId);
        const backoffAt = this._autoBackoff.get(gameId);
        if (backoffAt != null && humanCount <= backoffAt) continue;
        if (this._newHumanTraces(gameId) < this.minNewTraces) continue;
        console.log(`[FinetunePipeline] auto-trigger: game ${gameId}`);
        this.trigger({ gameId, source: 'auto' });
        return; // one run per tick; the next tick considers the rest
      }
    } catch (err) {
      console.warn('[FinetunePipeline] auto-check failed:', err.message);
    }
  }

  _humanTraceCount(gameId) {
    try {
      return this.traceStore.getTracesForGame(gameId, { playerType: 'human' }).length;
    } catch {
      return 0;
    }
  }

  // Human traces newer than the last successful (non-dry) training for this
  // game. Last-trained state lives in the registry itself — no separate file.
  _newHumanTraces(gameId) {
    let lastTrainedAt = 0;
    for (const entry of this._readRegistryRaw()) {
      if (entry.gameId !== gameId || entry.dryRun) continue;
      const at = Date.parse(entry.trainedAt || '') || 0;
      if (at > lastTrainedAt) lastTrainedAt = at;
    }
    try {
      return this.traceStore.getTracesForGame(gameId, { playerType: 'human' })
        .filter(t => (Date.parse(t.createdAt || '') || 0) > lastTrainedAt)
        .length;
    } catch {
      return 0;
    }
  }

  _readRegistryRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      return Array.isArray(parsed) ? parsed : (parsed.models || []);
    } catch {
      return [];
    }
  }

  // Called from server shutdown(): kill the child, mark the run failed, stop
  // the auto timer. Never waits — telemetry flush happens in shutdown itself.
  shutdown() {
    this.stopAutoTrigger();
    if (this._child) {
      try {
        this._child.kill('SIGTERM');
      } catch { /* already gone */ }
    }
    if (this.activeRun) {
      this._failRun(this.activeRun, 'shutdown', new Error('server shutting down'), 'SERVER_SHUTDOWN');
    }
  }

  // --- helpers ---------------------------------------------------------------

  _emitProgress(run, msg) {
    if (!this.io) return;
    this.io.emit('finetune-progress', {
      runId: run.runId,
      gameId: run.gameId,
      gameName: run.gameName,
      state: run.state,
      modelId: run.modelId,
      dryRun: run.dryRun,
      ...msg
    });
  }

  _track(eventType, run, payload = {}) {
    if (!this.telemetry) return;
    try {
      this.telemetry.track({
        eventFamily: 'system',
        eventType,
        source: 'finetune-pipeline',
        runId: run.runId,
        gameId: run.gameId,
        modelId: run.modelId || undefined,
        payload: { dryRun: run.dryRun, source: run.source, ...payload }
      });
    } catch (err) {
      console.warn('[FinetunePipeline] telemetry track failed:', err.message);
    }
  }
}

module.exports = new FinetunePipeline();
module.exports.FinetunePipeline = FinetunePipeline;
module.exports.TriggerError = TriggerError;
