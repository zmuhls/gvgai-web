const net = require('net');
const telemetry = require('./telemetry-store');
const traceStore = require('./play-trace-store');
const { getCachedClassification } = require('./game-classifier');

/**
 * HumanPlayClient — connects to the GVGAI Java TCP socket and sends human
 * keyboard actions instead of LLM API calls. Speaks the same wire protocol
 * as LLMClient (START/INIT/ACT/END/FINISH) and emits the same socket events
 * so spectators see an identical view.
 *
 * The 40ms tick constraint is trivially met: on ACT the pendingAction (set
 * by the human via setAction) is written to the socket immediately, before
 * any JSON parsing or telemetry work.
 */
class HumanPlayClient {
  constructor(options = {}) {
    this.socket = null;
    this.io = null;
    this.buffer = '';
    this.gameActive = false;
    this.playerType = 'human';
    this.pendingAction = 'ACTION_NIL';
    this.gameId = null;
    this.gameName = null;
    this.levelCount = 0;
    this.runId = options.runId || null;
    this.runStartScore = null;
    this.lastSso = null;
    this.summaryEmitted = false;
    this.onSessionEnd = null;
    this.actionHistory = [];
    this.lastReceivedMessageId = null;
    this.initResponseType = 'BOTH';
    this.actResponseType = 'BOTH';
  }

  /**
   * Set the action to send on the next ACT tick. Only takes effect when a
   * game is active — ignored otherwise so a stray keypress can't leak into
   * the next level before INIT arrives.
   */
  setAction(action) {
    if (!this.gameActive) return;
    this.pendingAction = action || 'ACTION_NIL';
  }

  /**
   * Connect to the GVGAI Java TCP socket. Mirrors LLMClient.connect's
   * signature so callers can swap the two transparently.
   */
  connect(port, model, io, gameId, gameName) {
    this.io = io;
    this.gameActive = true;
    this.gameId = gameId != null ? gameId : null;
    this.gameName = gameName || 'unknown';
    this.actionHistory = [];
    this.runStartScore = null;
    this.summaryEmitted = false;
    this.lastSso = null;
    this.runId = this.runId || telemetry.createRunId(`human-game-${this.gameId ?? 'unknown'}`);

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        console.error('[HumanPlayClient] Socket error:', error);
        this.gameActive = false;
        this._triggerSessionEnd();
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('[HumanPlayClient] Socket closed');
        this.emitCloseSummary();
        this.gameActive = false;
        this._triggerSessionEnd();
      });

      this.socket.connect(port, 'localhost', () => {
        console.log(`[HumanPlayClient] Connected to GVGAI socket on port ${port}`);
        const classification = getCachedClassification(this.gameId);
        telemetry.track({
          eventFamily: 'model_telemetry',
          eventType: 'human_session_started',
          source: 'human-play-client',
          runId: this.runId,
          gameId: this.gameId,
          levelId: this.levelCount,
          payload: {
            gameName: this.gameName,
            playerType: 'human',
            archetype: classification?.archetype || null,
            pace: classification?.pace || null
          }
        });
        resolve();
      });
    });
  }

  handleData(data) {
    this.buffer += data.toString();

    const messages = this.buffer.split('\n');
    this.buffer = messages.pop();

    for (const message of messages) {
      if (message.trim()) {
        this.processMessage(message.trim());
      }
    }
  }

  async processMessage(message) {
    try {
      const parts = message.split('#');
      const msgId = parts[0];
      const jsonPayload = parts.slice(1).join('#');

      if (!jsonPayload) {
        console.warn('[HumanPlayClient] Invalid message format:', message);
        return;
      }

      this.lastReceivedMessageId = parseInt(msgId);

      // --- Control messages (no JSON payload) ---
      if (jsonPayload === 'START') {
        console.log(`[HumanPlayClient] Received msgId=${msgId}, type: START`);
        this.sendMessageWithId(msgId, 'START_DONE');
        return;
      }
      if (jsonPayload === 'FINISH') {
        console.log(`[HumanPlayClient] Received msgId=${msgId}, type: FINISH`);
        this.gameActive = false;
        telemetry.track({
          eventFamily: 'evaluation',
          eventType: 'session_finished',
          source: 'human-play-client',
          runId: this.runId,
          gameId: this.gameId,
          payload: {
            levelsPlayed: this.levelCount,
            playerType: 'human'
          }
        });
        if (this.io) {
          this.io.emit('session-end', {
            reason: 'finished',
            levelsPlayed: this.levelCount
          });
        }
        this._triggerSessionEnd();
        return;
      }

      // --- Phase detection (same strategy as LLMClient) ---
      const head = jsonPayload.substring(0, Math.min(2000, jsonPayload.length));
      let isACT = head.includes('"phase":"ACT"');
      let isINIT = head.includes('"phase":"INIT"');
      let isEND = head.includes('"phase":"END"');

      if (!isACT && !isINIT && !isEND) {
        isACT = jsonPayload.includes('"phase":"ACT"');
        isINIT = jsonPayload.includes('"phase":"INIT"');
        isEND = jsonPayload.includes('"phase":"END"');
      }

      if (isACT) {
        // CRITICAL: Send the pending action immediately (<1ms) before any
        // parsing or telemetry. This is what keeps us well within the
        // 40ms engine constraint.
        const actionToSend = this.pendingAction || 'ACTION_NIL';
        this.sendMessageWithId(msgId, `${actionToSend}#${this.actResponseType}`);

        // Async post-response work: parse state, record, emit to spectators
        setImmediate(() => {
          this.recordActState(jsonPayload, actionToSend);
        });
        return;
      }

      if (isINIT) {
        try {
          const sso = JSON.parse(jsonPayload);
          this.lastSso = sso;
          if (this.runStartScore === null) this.runStartScore = sso.gameScore || 0;
          console.log(`[HumanPlayClient] Received msgId=${msgId}, phase: INIT`);
          this.handleInit(msgId);
        } catch (err) {
          console.error('[HumanPlayClient] INIT parsing error:', err.message);
          this.sendMessageWithId(msgId, 'INIT_FAILED');
        }
        return;
      }

      if (isEND) {
        try {
          const sso = JSON.parse(jsonPayload);
          console.log(`[HumanPlayClient] Received msgId=${msgId}, phase: END`);
          await this.handleEnd(sso, msgId);
        } catch (err) {
          console.error('[HumanPlayClient] END parsing error:', err.message);
          this.sendMessageWithId(msgId, 'END_FAILED');
        }
        return;
      }

      console.warn(`[HumanPlayClient] No phase detected in ${jsonPayload.length}-byte message`);
    } catch (error) {
      console.error('[HumanPlayClient] Error processing message:', error);
      if (msgId) {
        this.sendMessageWithId(msgId, `ACTION_NIL#${this.actResponseType}`);
      }
    }
  }

  handleInit(msgId) {
    console.log('[HumanPlayClient] Game initializing...');
    this.sendMessageWithId(msgId, `INIT_DONE#${this.initResponseType}`);
  }

  recordActState(jsonPayload, actionToSend) {
    try {
      const sso = JSON.parse(jsonPayload);
      this.lastSso = sso;
      if (this.runStartScore === null) this.runStartScore = sso.gameScore || 0;

      const tick = Number.isInteger(sso.gameTick) ? sso.gameTick : 0;
      const score = Number.isFinite(sso.gameScore) ? sso.gameScore : 0;
      const health = Number.isFinite(sso.avatarHealthPoints) ? sso.avatarHealthPoints : 0;
      const prevScore = this.actionHistory.length > 0
        ? this.actionHistory[this.actionHistory.length - 1].score
        : this.runStartScore;
      const scoreDelta = score - (prevScore || 0);

      this.actionHistory.push({ tick, action: actionToSend, score, health, scoreDelta });

      // Telemetry: one event per human action
      const classification = getCachedClassification(this.gameId);
      telemetry.track({
        eventFamily: 'model_telemetry',
        eventType: 'human_action',
        source: 'human-play-client',
        runId: this.runId,
        gameId: this.gameId,
        levelId: this.levelCount,
        provider: 'human',
        payload: {
          action: actionToSend,
          playerType: 'human',
          archetype: classification?.archetype || null,
          pace: classification?.pace || null
        },
        metrics: {
          tick,
          score,
          health,
          score_delta: scoreDelta
        }
      });

      // Spectator view — same shape as LLMClient
      if (this.io) {
        this.io.emit('game-state', {
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          maxHealth: sso.avatarMaxHealthPoints,
          tick: sso.gameTick,
          action: actionToSend,
          planStep: 0,
          planLength: 0,
          playerType: 'human'
        });
      }
    } catch (error) {
      console.error('[HumanPlayClient] Error parsing game state for UI update:', error.message);
    }
  }

  async handleEnd(sso, msgId) {
    this.levelCount++;
    console.log(`[HumanPlayClient] Level ${this.levelCount} ended`);
    console.log(`[HumanPlayClient] Score: ${sso.gameScore}`);
    console.log(`[HumanPlayClient] Winner: ${sso.gameWinner}`);

    const summary = this.buildRunSummary(sso);

    // Notify frontend (per-level, not session end)
    if (this.io) {
      this.io.emit('level-end', {
        score: sso.gameScore,
        winner: sso.gameWinner,
        ticks: sso.gameTick,
        level: this.levelCount
      });
      this.emitRunSummary(summary);
    }

    telemetry.track({
      eventFamily: 'evaluation',
      eventType: 'level_ended',
      source: 'human-play-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
      provider: 'human',
      payload: {
        score: sso.gameScore,
        winner: sso.gameWinner,
        playerType: 'human'
      },
      metrics: {
        ticks: sso.gameTick || 0
      }
    });

    // Save the play trace before resetting per-level state
    const trace = this.getTrace();
    trace.winner = sso.gameWinner;
    trace.won = sso.gameWinner === 'PLAYER_WINS' || sso.gameWinner === true;
    trace.ticks = sso.gameTick || 0;
    trace.finalScore = sso.gameScore || trace.finalScore;
    trace.scoreEvents = this.actionHistory
      .filter(e => e.scoreDelta !== 0)
      .map(e => ({ tick: e.tick, action: e.action, scoreDelta: e.scoreDelta }));
    try {
      traceStore.saveTrace(trace);
      console.log(`[HumanPlayClient] Trace saved: ${trace.actionHistory.length} actions, score ${trace.finalScore}`);
    } catch (err) {
      console.error('[HumanPlayClient] Failed to save trace:', err.message);
    }

    // Reset per-level state for the next level
    this.actionHistory = [];
    this.runStartScore = null;
    this.pendingAction = 'ACTION_NIL';
    this.summaryEmitted = false;

    // Send acknowledgment
    this.sendMessageWithId(msgId, 'END_DONE');
  }

  getTrace() {
    const lastEntry = this.actionHistory.length > 0
      ? this.actionHistory[this.actionHistory.length - 1]
      : null;
    return {
      gameId: this.gameId,
      gameName: this.gameName,
      levelId: this.levelCount,
      playerType: 'human',
      actionHistory: this.actionHistory,
      finalScore: lastEntry ? lastEntry.score : (this.lastSso ? (this.lastSso.gameScore || 0) : 0)
    };
  }

  buildRunSummary(sso) {
    const won = sso.gameWinner === 'PLAYER_WINS' || sso.gameWinner === true;
    const lastEntry = this.actionHistory.length > 0
      ? this.actionHistory[this.actionHistory.length - 1]
      : null;
    const finalScore = lastEntry ? lastEntry.score : (sso.gameScore || 0);

    return {
      playerType: 'human',
      provider: 'human',
      modelUsed: null,
      strategy: null,
      finalScore,
      winner: sso.gameWinner,
      won,
      ticks: sso.gameTick || 0,
      decisions: this.actionHistory.length,
      actions: this.actionHistory.map(entry => entry.action),
      level: this.levelCount,
      adherence: { score: null, keywords: [], matched: 0, total: 0 },
      highlights: this.actionHistory
        .filter(e => e.scoreDelta > 0)
        .sort((a, b) => b.scoreDelta - a.scoreDelta)
        .slice(0, 5)
        .sort((a, b) => a.tick - b.tick)
        .map(e => ({ tick: e.tick, action: e.action, reason: 'human input', scoreDelta: e.scoreDelta }))
    };
  }

  emitRunSummary(summary) {
    if (this.io && !this.summaryEmitted) {
      this.summaryEmitted = true;
      this.io.emit('run-summary', summary);
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'run_summary',
        source: 'human-play-client',
        runId: this.runId,
        gameId: this.gameId,
        levelId: summary.level,
        provider: 'human',
        payload: {
          playerType: 'human',
          winner: summary.winner,
          won: summary.won,
          actions: summary.actions
        },
        metrics: {
          final_score: summary.finalScore,
          ticks: summary.ticks,
          decisions: summary.decisions
        }
      });
    }
  }

  emitCloseSummary() {
    if (this.summaryEmitted || (!this.lastSso && this.actionHistory.length === 0)) return;
    const sso = this.lastSso || {};
    const summary = this.buildRunSummary({
      ...sso,
      gameWinner: sso.gameWinner || 'ABORTED',
      gameTick: sso.gameTick || this.actionHistory.length,
      gameScore: sso.gameScore || this.runStartScore || 0
    });
    summary.endedBy = 'socket-close';
    this.emitRunSummary(summary);
  }

  sendMessageWithId(msgId, msg) {
    if (this.socket && !this.socket.destroyed) {
      const message = `${msgId}#${msg}\n`;
      this.socket.write(message);
    } else {
      console.error('[HumanPlayClient] Cannot send - socket not ready');
    }
  }

  _triggerSessionEnd() {
    if (this.onSessionEnd) {
      const cb = this.onSessionEnd;
      this.onSessionEnd = null;
      cb();
    }
  }

  disconnect() {
    this.gameActive = false;
    this.onSessionEnd = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = HumanPlayClient;