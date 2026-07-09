// Attract-mode "marble run" coordinator.
//
// When no walk-up player is active, the arcade runs itself: it plays a serial
// playlist of game x model x strategy eval cases on the single Java process and
// broadcasts every event live, then loops. A walk-up player interrupts the loop
// (high priority), plays, and the loop resumes afterward.
//
// Single-session is a hard constraint (one Java process, fixed port 8080, one
// global screenshot file), so a marble run is a serial playlist on one broadcast
// channel — which fits: all Socket.IO emits are global, so every spectator tab
// sees the same run. Interrupting a case needs no new abort plumbing: disconnecting
// the LLM client emits the run-summary that runEvalCase is already blocked on, so
// it unwinds through its own finally (disconnect + stopGame).

const { runEvalCase } = require('./batch-evaluator');
const { buildArcadeEvalPlan } = require('./eval-plan');

function nowIso() {
  return new Date().toISOString();
}

class AttractCoordinator {
  constructor() {
    this.configured = false;
    this.enabled = false;
    this.mode = 'IDLE'; // IDLE | MARBLE_STARTING | MARBLE_PLAYING | YIELDING | WALKUP_PLAYING | RESUMING
    this.cases = [];
    this.cursor = 0;
    this.loopCount = 0;
    this.walkupActive = false;
    this.currentCase = null;
    this.currentStartedAt = null;

    this._currentHandle = null;   // { processId, llmClient } for the live marble case
    this._currentPromise = null;  // the in-flight runEvalCase promise
    this._abortReason = null;     // 'yield' | 'stopped' when a case is cut short
    this._loopRunning = false;
    this._resumeTimer = null;
    this._resumePromise = null;
    this._resumeResolve = null;

    // Injected dependencies (see configure).
    this.io = null;
    this.streamer = null;                 // { start(), stop() } — shared screenshot streamer
    this.isWalkupActive = () => false;    // authority for whether a walk-up owns the process
    this.gameManager = null;
    this.telemetry = null;
    this.buildArcadeEvalPlan = buildArcadeEvalPlan;
    this.runEvalCase = runEvalCase;
    this.planOptions = {};
    this.caseOptions = {};
    this.resumeDebounceMs = 1500;
    this._consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;  // stop churning if the engine is unavailable
    this.errorBackoffMs = 2000;     // brief pause after a failed case
  }

  configure(deps = {}) {
    this.io = deps.io || null;
    this.streamer = deps.streamer || null;
    this.isWalkupActive = deps.isWalkupActive || (() => false);
    this.gameManager = deps.gameManager || require('./game-manager');
    this.telemetry = deps.telemetry || null;
    if (deps.buildArcadeEvalPlan) this.buildArcadeEvalPlan = deps.buildArcadeEvalPlan;
    if (deps.runEvalCase) this.runEvalCase = deps.runEvalCase;
    this.planOptions = deps.planOptions || {};
    this.caseOptions = deps.caseOptions || {};
    if (deps.resumeDebounceMs != null) this.resumeDebounceMs = deps.resumeDebounceMs;
    if (deps.maxConsecutiveErrors != null) this.maxConsecutiveErrors = deps.maxConsecutiveErrors;
    if (deps.errorBackoffMs != null) this.errorBackoffMs = deps.errorBackoffMs;
    this.configured = true;
    return this;
  }

  // --- control surface -----------------------------------------------------

  start() {
    if (!this.configured) throw new Error('AttractCoordinator.configure() must be called first');
    if (this.enabled) return this.getSnapshot();
    if (!this.cases.length) this.cases = this._buildCases();
    this.enabled = true;
    // Fire-and-forget: the loop runs in the background; progress reaches clients
    // only via Socket.IO, mirroring the /api/game/start pattern.
    this._runLoop().catch(err => {
      console.error('[Attract] loop crashed:', err);
      this._loopRunning = false;
    });
    return this.getSnapshot();
  }

  stop() {
    this.enabled = false;
    clearTimeout(this._resumeTimer);
    this._signalResume();
    const handle = this._currentHandle;
    if (handle && handle.llmClient) {
      this._abortReason = 'stopped';
      try { handle.llmClient.disconnect(); } catch (e) { /* already gone */ }
    }
    if (this.streamer) this.streamer.stop();
    this.currentCase = null;
    this.mode = 'IDLE';
    this._emitState();
    return this.getSnapshot();
  }

  // Called by the walk-up start route BEFORE it spawns its own game. Resolves once
  // the marble case is torn down and the single Java port is free.
  async beginWalkup() {
    clearTimeout(this._resumeTimer);
    if (this.walkupActive) return;
    this.walkupActive = true;
    this.mode = 'YIELDING';
    this._emitState();

    const handle = this._currentHandle;
    const inflight = this._currentPromise;
    if (handle && handle.llmClient) {
      this._abortReason = 'yield';
      try { handle.llmClient.disconnect(); } catch (e) { /* already gone */ }
    }
    // Wait for the in-flight case to unwind (its finally disconnects + stopGames).
    if (inflight) await inflight.catch(() => {});
    // Guarantee the fixed socket port is actually free before the walk-up spawns.
    if (handle && handle.processId && this.gameManager) {
      await this.gameManager.stopGameAndWait(handle.processId, 3000);
    }
    if (this.streamer) this.streamer.stop();
    this.currentCase = null;
    this.mode = 'WALKUP_PLAYING';
    this._emitState();
  }

  // Called by the walk-up cleanup paths. Debounced + re-checked so back-to-back
  // walk-ups don't blip a marble frame between them.
  endWalkup() {
    if (!this.walkupActive) return;
    clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => {
      if (!this.enabled) return;
      if (this.isWalkupActive && this.isWalkupActive()) return; // a walk-up is still live
      this.walkupActive = false;
      this.mode = 'RESUMING';
      this._emitState();
      this._signalResume();
    }, this.resumeDebounceMs);
  }

  getSnapshot() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      walkupActive: this.walkupActive,
      loopCount: this.loopCount,
      cursor: this.cursor,
      total: this.cases.length,
      current: this.currentCase ? this._caseSummary(this.currentCase) : null,
      upNext: this._upNext(3),
      startedAt: this.currentStartedAt,
      generatedAt: nowIso()
    };
  }

  addFinetunedModel(model = {}) {
    const modelId = model.modelId || model.id;
    if (!modelId) return { added: false, reason: 'missing_model_id', snapshot: this.getSnapshot() };

    const currentPlan = this._buildPlan();
    const currentModels = Array.isArray(currentPlan.models) ? currentPlan.models : [];
    const alreadyPresent = currentModels.some(entry => entry.id === modelId);

    let models = currentModels;
    if (!alreadyPresent) {
      models = currentModels.concat({
        id: modelId,
        name: model.modelName || model.name || modelId,
        provider: model.provider || 'ollama-local',
        fallback: model.fallback || null,
        description: model.description || `Fine-tuned for ${model.gameName || `game ${model.gameId}`}`,
        speed: model.speed || 'fast',
        cost: model.cost || 'free',
        finetuned: true,
        gameId: model.gameId ?? null,
        gameName: model.gameName ?? null
      });
    }

    let gameIds = Array.isArray(currentPlan.gameIds) ? [...currentPlan.gameIds] : [];
    const parsedGameId = Number.parseInt(model.gameId, 10);
    if (Number.isInteger(parsedGameId) && !gameIds.includes(parsedGameId)) {
      gameIds.push(parsedGameId);
    }

    this.planOptions = {
      ...(this.planOptions || {}),
      models,
      gameIds,
      gameCount: Math.max(
        Number.isInteger(this.planOptions?.gameCount) ? this.planOptions.gameCount : 0,
        gameIds.length
      )
    };

    const activeRunId = this.currentCase?.runId || null;
    this.cases = this._buildCases();
    if (activeRunId) {
      const activeIndex = this.cases.findIndex(evalCase => evalCase.runId === activeRunId);
      this.cursor = activeIndex >= 0 ? activeIndex : Math.min(this.cursor, Math.max(this.cases.length - 1, 0));
    } else {
      this.cursor = Math.min(this.cursor, Math.max(this.cases.length - 1, 0));
    }

    this._emit('marble-run-playlist-updated', {
      modelId,
      gameId: Number.isInteger(parsedGameId) ? parsedGameId : null,
      added: !alreadyPresent,
      total: this.cases.length
    });
    this._emitState();

    return { added: !alreadyPresent, snapshot: this.getSnapshot() };
  }

  // --- internals -----------------------------------------------------------

  async _runLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    try {
      while (this.enabled) {
        if (this.walkupActive) {
          await this._waitForResume();
          continue;
        }
        if (!this.cases.length) break;

        const evalCase = this.cases[this.cursor];
        this._abortReason = null;
        this.currentCase = evalCase;
        this.currentStartedAt = nowIso();
        this.mode = 'MARBLE_STARTING';
        this._emitState();
        // Tag the frame stream with this case's runId so walk-up viewers can
        // drop marble frames instead of having their canvas hijacked.
        if (this.streamer) this.streamer.start({ runId: evalCase.runId, source: 'marble' });
        this._emit('case-started', this._caseStartedPayload(evalCase));

        let caseErrored = false;
        try {
          this._currentPromise = this.runEvalCase(evalCase, {
            io: this.io,
            timeoutMs: this.caseOptions.timeoutMs,
            maxActions: this.caseOptions.maxActions,
            // Marble run defaults async: the engine ticks at full speed off the
            // plan queue instead of blocking on a provider round-trip per move.
            synchronousActions: this.caseOptions.synchronousActions === true,
            initResponseType: this.caseOptions.initResponseType || 'BOTH',
            actResponseType: this.caseOptions.actResponseType || 'BOTH',
            onCaseStart: (handle) => {
              this._currentHandle = handle;
              // If stop() ran while this case was still spawning, cut the late
              // client instead of reviving the loop to MARBLE_PLAYING after it
              // was already set IDLE.
              if (!this.enabled) {
                this._abortReason = 'stopped';
                try { handle.llmClient.disconnect(); } catch (e) { /* already gone */ }
                return;
              }
              // If a walk-up arrived while this case was spawning, cut it now that
              // the client exists — keeps beginWalkup responsive (seconds, not minutes).
              if (this.walkupActive) {
                this._abortReason = 'yield';
                try { handle.llmClient.disconnect(); } catch (e) { /* already gone */ }
              } else {
                this.mode = 'MARBLE_PLAYING';
                this._emitState();
              }
            }
          });
          const result = await this._currentPromise;
          this._emit('case-completed', this._caseCompletedPayload(evalCase, result, this._abortReason || 'summary'));
          if (!this._abortReason) {
            this._recordTelemetry(evalCase, result);
            this._consecutiveErrors = 0;
          }
        } catch (error) {
          this._emit('case-completed', {
            runId: evalCase.runId,
            index: this.cursor,
            endedBy: this._abortReason || 'error',
            message: error.message,
            result: null
          });
          if (!this._abortReason) caseErrored = true;
        } finally {
          if (this.streamer) this.streamer.stop();
          this._currentHandle = null;
          this._currentPromise = null;
          this.currentCase = null;
        }

        if (caseErrored) {
          this._consecutiveErrors += 1;
          // Stop churning if the engine is unavailable (e.g. Java misconfigured).
          if (this._consecutiveErrors >= this.maxConsecutiveErrors) {
            console.error(`[Attract] ${this._consecutiveErrors} consecutive case failures; stopping marble run.`);
            this.enabled = false;
            this.mode = 'IDLE';
            this._emitState();
            break;
          }
          // Brief backoff so a transient failure doesn't tight-loop the playlist.
          await new Promise(resolve => setTimeout(resolve, this.errorBackoffMs));
        }

        // Only advance if the case ran normally; a yielded case replays after resume.
        if (!this.walkupActive) this._advanceCursor();
      }
    } finally {
      this._loopRunning = false;
    }
  }

  _waitForResume() {
    if (!this.walkupActive) return Promise.resolve();
    if (!this._resumePromise) {
      this._resumePromise = new Promise((resolve) => { this._resumeResolve = resolve; });
    }
    return this._resumePromise;
  }

  _signalResume() {
    if (this._resumeResolve) {
      const resolve = this._resumeResolve;
      this._resumeResolve = null;
      this._resumePromise = null;
      resolve();
    }
  }

  _advanceCursor() {
    this.cursor += 1;
    if (this.cursor >= this.cases.length) {
      this.cursor = 0;
      this.loopCount += 1;
    }
  }

  _buildCases() {
    try {
      const plan = this._buildPlan();
      return Array.isArray(plan.cases) ? plan.cases : [];
    } catch (error) {
      console.error('[Attract] failed to build playlist:', error.message);
      return [];
    }
  }

  _buildPlan() {
    return this.buildArcadeEvalPlan(this.planOptions || {});
  }

  _emit(event, payload) {
    if (this.io) this.io.emit(event, payload);
  }

  _emitState() {
    this._emit('marble-run-state', this.getSnapshot());
  }

  _caseSummary(c) {
    return {
      runId: c.runId,
      gameId: c.gameId,
      gameName: c.gameName,
      levelId: c.levelId,
      modelId: c.modelId,
      modelName: c.modelName,
      provider: c.provider,
      strategyId: c.strategyId,
      strategyLabel: c.strategyLabel
    };
  }

  _upNext(n) {
    const out = [];
    const total = this.cases.length;
    for (let i = 1; i <= n && i <= total; i++) {
      const c = this.cases[(this.cursor + i) % total];
      out.push({ gameName: c.gameName, modelName: c.modelName, strategyLabel: c.strategyLabel });
    }
    return out;
  }

  _caseStartedPayload(c) {
    return {
      runId: c.runId,
      index: this.cursor,
      total: this.cases.length,
      loopCount: this.loopCount,
      game: { id: c.gameId, name: c.gameName, levelId: c.levelId },
      model: { id: c.modelId, name: c.modelName, provider: c.provider },
      strategy: { id: c.strategyId, label: c.strategyLabel, text: c.strategy },
      startedAt: this.currentStartedAt
    };
  }

  _caseCompletedPayload(c, result, endedBy) {
    return {
      runId: c.runId,
      index: this.cursor,
      endedBy,
      result: result ? {
        finalScore: result.finalScore,
        winner: result.winner,
        won: result.won,
        ticks: result.ticks,
        decisions: result.decisions,
        adherence: result.adherence
      } : null
    };
  }

  _recordTelemetry(c, result) {
    if (!this.telemetry || !result) return;
    try {
      this.telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'marble_case_completed',
        source: 'marble-run',
        runId: c.runId,
        gameId: c.gameId,
        levelId: c.levelId,
        modelId: c.modelId,
        payload: {
          gameName: c.gameName,
          strategyId: c.strategyId,
          strategyLabel: c.strategyLabel,
          finalScore: result.finalScore,
          winner: result.winner,
          won: result.won,
          ticks: result.ticks,
          decisions: result.decisions,
          provider: result.provider,
          modelUsed: result.modelUsed,
          adherenceLabel: result.adherence ? result.adherence.label : null,
          loopCount: this.loopCount
        }
      });
    } catch (e) { /* telemetry is best-effort */ }
  }
}

module.exports = new AttractCoordinator();
module.exports.AttractCoordinator = AttractCoordinator;
