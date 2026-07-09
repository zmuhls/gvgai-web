const net = require('net');
const { getConfig } = require('./runtime-config');
const config = getConfig();
const { buildPrompt, computeAdherence, sanitizeStrategy, GameStateTracker } = require('./state-converter');
const { parseStructured } = require('./response-parser');
const { resolveModel } = require('./models');
const promptStore = require('./prompt-store');
const telemetry = require('./telemetry-store');
const traceStore = require('./play-trace-store');
const guardrail = require('./usage-guardrail');
const { getCachedClassification } = require('./game-classifier');
const {
  DEFAULT_INITIAL_LEVEL_ID,
  DEFAULT_MAX_LEVEL_ID,
  nextLevelResponse,
  normalizeLevelId
} = require('./level-progression');

// Macro-action executor tuning. The plan queue is a bridge across LLM latency,
// not a schedule — it drains deterministically while the next call is in flight.
const MIN_LLM_INTERVAL_MS = 400;   // provider-protection floor between LLM calls
const REFILL_QUEUE_THRESHOLD = 1;  // fire the next LLM call when this few steps remain
const MAX_PLAN_STEPS = 6;          // hard cap on queued steps per plan
const MAX_PLAN_AGE_TICKS = 30;     // stale-plan safety net
const DEFAULT_TICKS_PER_STEP = 4;  // ticks each plan step is held for

// Loop-breaker tuning. Between LLM calls the executor repeats the last action
// blindly — in wandering games this means the avatar marches in one direction
// for 25+ ticks, hits a wall, and oscillates there until timeout. The breaker
// fires when stagnation is detected and forces a direction change so the next
// LLM call gets a different view of the map.
const STAGNATION_BREAK_INTERVAL = 8; // ticks between forced direction changes

const DIRECTION_ACTIONS = Object.freeze({
  left: 'ACTION_LEFT',
  right: 'ACTION_RIGHT',
  up: 'ACTION_UP',
  down: 'ACTION_DOWN'
});
const MOVEMENT_ACTIONS = Object.freeze(['ACTION_LEFT', 'ACTION_UP', 'ACTION_DOWN', 'ACTION_RIGHT']);
const STEERING_ACTION_ORDER = Object.freeze([...MOVEMENT_ACTIONS, 'ACTION_USE', 'ACTION_NIL']);
const DIRECTION_VERB = '(?:go|going|move|moving|turn|turning|head|heading|steer|steering|press|pressing)';
const NEGATED_DIRECTION_RE = new RegExp(`\\b(?:do\\s+not|don't|dont|never|avoid|without|no|not|stop)\\s+(?:${DIRECTION_VERB}\\s+)?(?:to\\s+the\\s+)?(left|right|up|down)\\b`, 'i');
const POSITIVE_DIRECTION_RE = /\b(?:go|move|turn|head|steer|press|keep|continue)\s+(?:going\s+)?(?:to\s+the\s+)?(left|right|up|down)\b/i;
const EXACT_DIRECTION_RE = /^\s*(left|right|up|down)\s*[.!?]*\s*$/i;

class LLMClient {
  constructor(options = {}) {
    this.socket = null;
    // Load provider keys from environment. OLLAMA_API_KEY serves the cloud
    // roster; OPENROUTER_API_KEY is the fallback key.
    this.apiKey = process.env.OPENROUTER_API_KEY || null;
    this.ollamaApiKey = process.env.OLLAMA_CLOUD_API_KEY || process.env.OLLAMA_API_KEY || null;
    this.model = config.openrouter.defaultModel;
    this.io = null;
    this.lastReceivedMessageId = null;  // Track the messageId from Java
    this.buffer = '';
    this.gameActive = false;
    this.pendingLLMAction = null;  // Store the most recent LLM action result
    this.llmCallInProgress = false;  // Track if LLM is currently being called
    this.lastLLMCallTime = 0;  // Time-based LLM sampling
    this.planQueue = [];  // Macro-action steps awaiting execution (front-first)
    this.planLength = 0;  // Steps in the current plan (for narration)
    this.planStep = 0;  // 1-based step currently executing (for narration)
    this.planSetTick = null;  // Game tick when the plan was set (age invalidation)
    this.planHealthAtSet = null;  // Health when the plan was set (damage invalidation)
    this.planStepHoldRemaining = 0;  // Ticks left before advancing to the next step
    this.levelCount = normalizeLevelId(options.initialLevelId, DEFAULT_INITIAL_LEVEL_ID);  // Current level id
    this.maxLevelId = normalizeLevelId(options.maxLevelId, DEFAULT_MAX_LEVEL_ID);
    this.onSessionEnd = null;  // Callback for session cleanup
    this.gameId = null;  // Game ID for prompt config lookup
    this.gameName = null;  // Resolved game name from CSV
    this.promptConfig = null;  // Resolved prompt config from dashboard
    this.stateTracker = new GameStateTracker();  // Rolling history (was previously never instantiated)
    this.sessionStrategy = null;  // Ephemeral per-session player directive (never persisted)
    this.runLog = [];  // Per-decision log for the end-of-run summary: { tick, action, reason, scoreDelta }
    this.runStartScore = null;  // Score at the first tick of the run
    this.lastProvider = null;
    this.lastModelUsed = null;
    this.lastSso = null;
    this.summaryEmitted = false;
    this.synchronousActions = !!options.synchronousActions;
    this.actionTimeoutMs = options.actionTimeoutMs || 12000;
    this.maxActions = options.maxActions || null;
    this.initResponseType = options.initResponseType || (this.synchronousActions ? 'JSON' : 'BOTH');
    this.actResponseType = options.actResponseType || (this.synchronousActions ? 'JSON' : 'BOTH');
    this.runId = options.runId || null;
    this.promptConfigOptions = options.promptConfigOptions || {};
    this.preferProviderFallback = !!options.preferProviderFallback;
    this.lastTraceTickLogged = null;
    this.lastTraceScoreLogged = null;
    this.lastPolicyDecisionTickLogged = null;
    this.lastPolicyDecisionActionLogged = null;
    this.lastPolicyDecisionScoreLogged = null;
    this.lastLoopBreakTick = -STAGNATION_BREAK_INTERVAL; // so the breaker can fire early if needed
    this.strategyRevision = 0;
    this.lastSteeringDecisionTickLogged = null;
    this.lastSteeringDecisionActionLogged = null;
    this.steeringAlternativeCursor = 0;
  }

  // Validate API key with OpenRouter (skipped for local Ollama)
  async validateApiKey() {
    if (!this.apiKey) {
      console.log('[LLMClient] No API key set — using local Ollama endpoint');
      return true;
    }
    try {
      const response = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      });

      if (!response.ok) {
        console.error('[LLMClient] API key validation failed:', response.statusText);
        return false;
      }

      const data = await response.json();
      console.log('[LLMClient] API key valid. Usage:', data.data?.usage || 'N/A');
      return true;
    } catch (error) {
      console.error('[LLMClient] Error validating API key:', error);
      return false;
    }
  }

  buildProviderRoutes(resolved) {
    const routes = [];
    const pushRoute = (provider, modelId, stage) => {
      if (!provider || !modelId) return;
      if (routes.some(route => route.provider === provider && route.modelId === modelId)) return;
      routes.push({ provider, modelId, stage });
    };

    if (this.preferProviderFallback && resolved.provider === 'ollama-cloud' && resolved.fallback) {
      pushRoute('openrouter', resolved.fallback, 'fallback');
      pushRoute(resolved.provider, resolved.id, 'primary');
      return routes;
    }

    pushRoute(resolved.provider, resolved.id, 'primary');

    if (resolved.provider === 'legion-vllm') {
      const cloudFallback = resolved.fallbackProvider === 'ollama-cloud' && resolved.fallback
        ? resolved.fallback
        : process.env.LEGION_FALLBACK_MODEL || config.openrouter.defaultModel;
      pushRoute('ollama-cloud', cloudFallback, 'fallback');

      const cloudResolved = resolveModel(cloudFallback);
      if (cloudResolved?.fallback) {
        pushRoute('openrouter', cloudResolved.fallback, 'fallback');
      }
      if (resolved.fallbackProvider === 'openrouter' && resolved.fallback) {
        pushRoute('openrouter', resolved.fallback, 'fallback');
      }
      return routes;
    }

    if (resolved.provider === 'ollama-cloud' && resolved.fallback) {
      pushRoute('openrouter', resolved.fallback, 'fallback');
    } else if (resolved.provider !== 'openrouter' && resolved.fallback) {
      pushRoute('openrouter', resolved.fallback, 'fallback');
    }

    return routes;
  }

  async connect(port, model, io, gameId, gameName, sessionStrategy = null) {
    this.model = model;
    this.io = io;
    this.gameActive = true;
    this.gameId = gameId != null ? gameId : null;
    this.gameName = gameName || 'unknown';
    // Runtime-only directive — lives on the instance, never reaches promptStore.saveGameConfig.
    // Sanitized here so every caller (walk-up + marble run) gets one canonical, fenced-safe value.
    this.sessionStrategy = sanitizeStrategy(sessionStrategy).text;
    this.stateTracker.reset();
    this.clearPlan();
    this.runLog = [];
    this.runStartScore = null;
    this.lastRunOutcome = null;  // { finalScore, won, topAction, actionCounts } from previous level/run
    this.lastProvider = null;
    this.lastModelUsed = null;
    this.lastSso = null;
    this.summaryEmitted = false;
    this.runId = this.runId || telemetry.createRunId(`game-${this.gameId ?? 'unknown'}`);
    this.lastTraceTickLogged = null;
    this.lastTraceScoreLogged = null;
    this.lastPolicyDecisionTickLogged = null;
    this.lastPolicyDecisionActionLogged = null;
    this.lastPolicyDecisionScoreLogged = null;
    this.lastLoopBreakTick = -STAGNATION_BREAK_INTERVAL;
    this.promptConfig = promptStore.resolveGamePromptConfig(this.gameId, this.levelCount, this.promptConfigOptions);
    // Ensure gameName is set even when game config doesn't specify it
    if (this.promptConfig && !this.promptConfig.gameName) {
      this.promptConfig.gameName = this.gameName;
    }

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      // CRITICAL: Set up event handlers BEFORE connecting to avoid race condition
      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('error', (error) => {
        console.error('[LLMClient] Socket error:', error);
        this.gameActive = false;
        this._triggerSessionEnd();
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('[LLMClient] Socket closed');
        this.emitCloseSummary();
        this.gameActive = false;
        this._triggerSessionEnd();
      });

      // Connect AFTER event handlers are set up
      this.socket.connect(port, 'localhost', () => {
        console.log(`[LLMClient] Connected to GVGAI socket on port ${port}`);
        telemetry.track({
          eventFamily: 'model_telemetry',
          eventType: 'llm_session_started',
          source: 'llm-client',
          runId: this.runId,
          gameId: this.gameId,
          levelId: this.levelCount,
          modelId: this.model,
          payload: {
            gameName: this.gameName,
            synchronousActions: this.synchronousActions,
            strategy_present: Boolean(this.sessionStrategy),
            archetype: getCachedClassification(this.gameId)?.archetype || null,
            pace: getCachedClassification(this.gameId)?.pace || null
          }
        });
        resolve();
      });
    });
  }

  handleData(data) {
    this.buffer += data.toString();

    // Process complete messages (terminated by newline)
    const messages = this.buffer.split('\n');
    this.buffer = messages.pop(); // Keep incomplete message in buffer

    for (const message of messages) {
      if (message.trim()) {
        this.processMessage(message.trim());
      }
    }
  }

  async processMessage(message) {
    try {
      // Parse message format: messageId#jsonPayload
      const parts = message.split('#');
      const msgId = parts[0];
      const jsonPayload = parts.slice(1).join('#');  // Rejoin in case payload contains '#'

      // Debug: uncomment to trace messages
      // console.log(`[LLMClient] msgId=${msgId}, payload: ${jsonPayload.substring(0, 80)}...`);

      if (!jsonPayload) {
        console.warn('[LLMClient] Invalid message format:', message);
        return;
      }

      // Store the received message ID so we can respond with the same ID
      this.lastReceivedMessageId = parseInt(msgId);

      // Handle special control messages
      if (jsonPayload === 'START') {
        console.log(`[LLMClient] Received msgId=${msgId}, type: START`);
        // START_DONE - no payload needed
        this.sendMessageWithId(msgId, 'START_DONE');
        return;
      }
      if (jsonPayload === 'FINISH') {
        console.log(`[LLMClient] Received msgId=${msgId}, type: FINISH`);
        this.gameActive = false;
        telemetry.track({
          eventFamily: 'evaluation',
          eventType: 'session_finished',
          source: 'llm-client',
          runId: this.runId,
          gameId: this.gameId,
          modelId: this.model,
          payload: {
            levelsPlayed: this.levelCount
          }
        });
        if (this.io) {
          this.io.emit('session-end', {
            runId: this.runId,
            reason: 'finished',
            levelsPlayed: this.levelCount
          });
        }
        this._triggerSessionEnd();
        return;
      }

      // Phase detection strategy:
      // - ACT is time-critical (<40ms), so check a small window first
      // - INIT/END are not time-critical, so fall back to full search if needed
      const head = jsonPayload.substring(0, Math.min(2000, jsonPayload.length));
      let isACT = head.includes('"phase":"ACT"');
      let isINIT = head.includes('"phase":"INIT"');
      let isEND = head.includes('"phase":"END"');

      // If no phase found in head, search full payload (non-ACT phases can afford this)
      if (!isACT && !isINIT && !isEND) {
        isACT = jsonPayload.includes('"phase":"ACT"');
        isINIT = jsonPayload.includes('"phase":"INIT"');
        isEND = jsonPayload.includes('"phase":"END"');
      }

      if (isACT) {
        // The maxActions cap counts LLM decisions (runLog entries), not engine
        // ticks, and must run in BOTH modes: in async mode nothing else ends a
        // case before natural game end / the per-case timeout, and an uncapped
        // async case burns 60-150 provider calls instead of ~40.
        if (this.maxActions && this.runLog.length >= this.maxActions) {
          console.log(`[LLMClient] Max actions reached (${this.maxActions}); ending Java eval case`);
          this.sendMessageWithId(msgId, `ABORT#${this.actResponseType}`);
          // Java doesn't reliably close the socket after ABORT, so emit the
          // run-summary now — otherwise the eval/marble case hangs until the
          // per-case timeout. The summaryEmitted guard makes this idempotent
          // if the socket does later close. (Only reached in eval/marble mode;
          // the walk-up path never sets maxActions.)
          this.emitCloseSummary();
          return;
        }
        if (this.synchronousActions) {
          const directPolicy = this.resolveAuthoritativePolicy(jsonPayload);
          if (directPolicy) {
            const sso = this.recordActState(jsonPayload, directPolicy.action);
            if (sso) {
              this.pendingLLMAction = directPolicy.action;
              this.stateTracker.recordSentAction(directPolicy.action, sso.gameTick || 0);
              this.recordActionDecision(directPolicy.action, sso.gameTick || 0, directPolicy.reason, sso);
              this.emitPolicyDecision(directPolicy, sso);
            }
            this.sendMessageWithId(msgId, `${directPolicy.action}#${this.actResponseType}`);
            return;
          }
          const sso = this.recordActState(jsonPayload, null);
          try {
            const decision = await this.requestLLMAction(jsonPayload);
            let action = decision.action;
            if (decision.stale || !action) {
              const steering = this.resolveSteeringAction(sso);
              if (steering) {
                action = steering.action;
                this.maybeEmitSteeringDecision(steering, sso);
              } else {
                action = 'ACTION_NIL';
              }
            }
            this.stateTracker.recordSentAction(action, sso ? sso.gameTick : 0);
            this.sendMessageWithId(msgId, `${action}#${this.actResponseType}`);
          } catch (error) {
            console.error('[LLMClient] Error in synchronous LLM action:', error.message);
            this.recordActionDecision('ACTION_NIL', sso ? sso.gameTick : 0, error.message, sso);
            this.sendMessageWithId(msgId, `ACTION_NIL#${this.actResponseType}`);
          }
          return;
        }

        const directPolicy = this.resolveAuthoritativePolicy(jsonPayload);
        if (directPolicy) {
          this.sendMessageWithId(msgId, `${directPolicy.action}#${this.actResponseType}`);
          setImmediate(() => {
            const sso = this.recordActState(jsonPayload, directPolicy.action);
            if (sso) {
              this.pendingLLMAction = directPolicy.action;
              this.stateTracker.recordSentAction(directPolicy.action, sso.gameTick || 0);
              this.recordActionDecision(directPolicy.action, sso.gameTick || 0, directPolicy.reason, sso);
              this.emitPolicyDecision(directPolicy, sso);
            }
          });
          return;
        }

        // CRITICAL: Respond IMMEDIATELY with the specific message ID.
        // dequeuePlanAction is O(1) with no JSON parsing; with an empty plan
        // queue it degrades to the classic pendingLLMAction || ACTION_NIL.
        const immediateSteering = this.resolveImmediateSteeringAction(jsonPayload);
        const queuedAction = immediateSteering ? immediateSteering.action : this.dequeuePlanAction();
        const steeredCandidate = immediateSteering
          ? { action: queuedAction, steering: immediateSteering }
          : this.applySteeringToCandidate(queuedAction, jsonPayload);
        const actionToSend = steeredCandidate.action;
        this.sendMessageWithId(msgId, `${actionToSend}#${this.actResponseType}`);

        // Async processing after response sent (don't block)
        setImmediate(() => {
          const sso = this.recordActState(jsonPayload, actionToSend);
          if (sso) {
            this.maybeEmitSteeringDecision(steeredCandidate.steering, sso);
            this.stateTracker.recordSentAction(actionToSend, sso.gameTick || 0);
            this.maybeInvalidatePlan(sso);
          }

          // Refill: fire the next LLM call when the plan is (nearly) exhausted
          // and the provider-protection interval has elapsed. With no plan the
          // queue is always empty, so this is the classic 400ms time gate.
          const now = Date.now();
          if (!this.llmCallInProgress &&
              this.planQueue.length <= REFILL_QUEUE_THRESHOLD &&
              (now - this.lastLLMCallTime) >= MIN_LLM_INTERVAL_MS) {
            this.startAsyncLLMCall(jsonPayload);
          }
        });

        return; // Response sent - done
      }

      // For non-ACT phases, parse JSON and handle
      if (isINIT) {
        try {
          const sso = JSON.parse(jsonPayload);
          this.lastSso = sso;
          if (this.runStartScore === null) this.runStartScore = sso.gameScore || 0;
          console.log(`[LLMClient] Received msgId=${msgId}, phase: INIT`);
          await this.handleInit(msgId);
        } catch (err) {
          console.error('[LLMClient] INIT parsing error:', err.message);
          console.error('[LLMClient] Payload length:', jsonPayload.length);
          console.error('[LLMClient] Payload preview:', jsonPayload.substring(0, 300));
          console.error('[LLMClient] Header (first 500):', head);
          this.sendMessageWithId(msgId, 'INIT_FAILED');
        }
      } else if (isEND) {
        try {
          const sso = JSON.parse(jsonPayload);
          console.log(`[LLMClient] Received msgId=${msgId}, phase: END`);
          await this.handleEnd(sso, msgId);
        } catch (err) {
          console.error('[LLMClient] END parsing error:', err.message);
          this.sendMessageWithId(msgId, 'END_FAILED');
        }
      } else {
        // No phase detected - log for debugging
        console.warn(`[LLMClient] No phase detected in ${jsonPayload.length}-byte message`);
      }
    } catch (error) {
      console.error('[LLMClient] Error processing message:', error);
      if (msgId) {
        this.sendMessageWithId(msgId, `ACTION_NIL#${this.actResponseType}`);
      }
    }
  }

  async handleInit(msgId) {
    console.log('[LLMClient] Game initializing...');
    this.summaryEmitted = false;
    // Reload prompt config for current level (picks up level-specific progression context)
    if (this.gameId != null) {
      this.promptConfig = promptStore.resolveGamePromptConfig(this.gameId, this.levelCount, this.promptConfigOptions);
      if (this.promptConfig && !this.promptConfig.gameName) {
        this.promptConfig.gameName = this.gameName;
      }
    }
    telemetry.track({
      eventFamily: 'trace',
      eventType: 'level_initialized',
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
      modelId: this.model
    });
    this.sendMessageWithId(msgId, `INIT_DONE#${this.initResponseType}`);
  }

  recordActState(jsonPayload, actionToSend) {
    try {
      const sso = JSON.parse(jsonPayload);
      this.lastSso = sso;
      this.stateTracker.recordTick(sso);
      if (this.runStartScore === null) this.runStartScore = sso.gameScore || 0;
      this.recordStateTrace(sso, actionToSend);
      if (this.io) {
        this.io.emit('game-state', {
          runId: this.runId,
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          maxHealth: sso.avatarMaxHealthPoints,
          tick: sso.gameTick,
          action: actionToSend,
          planStep: this.planStep,
          planLength: this.planLength
        });
      }
      return sso;
    } catch (error) {
      console.error('[LLMClient] Error parsing game state for UI update:', error.message);
      return null;
    }
  }

  // --- Macro-action plan executor -----------------------------------------

  macroEnabled() {
    if (process.env.MACRO_ACTIONS_DISABLED === '1') return false;
    return Boolean(this.promptConfig?.macroActions?.enabled);
  }

  ticksPerStep() {
    const n = this.promptConfig?.macroActions?.ticksPerStep;
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_TICKS_PER_STEP;
  }

  // Hot path: called synchronously before the ACT tick reply, so no JSON parsing.
  // Each plan step is held for ticksPerStep ticks so a 4-step plan spans the
  // real LLM latency gap instead of draining in ~160ms of engine ticks.
  //
  // Exhausted queue: the classic behavior repeats the last action until the next
  // LLM result — fine for puzzle games, deadly in gravity/hazard games where a
  // 2-second provider gap means ~50 blind ticks in one direction. A game config
  // can set macroActions.exhaustAction: 'wait' to stand still instead, giving the
  // demo its burst-of-moves-then-thinking cadence.
  //
  // Loop breaker: when the queue is exhausted and the state tracker detects
  // stagnation (avatar stuck in a small area, no score progress), the breaker
  // overrides the blind repeat with a perpendicular direction every
  // STAGNATION_BREAK_INTERVAL ticks. This gets the avatar out of the pocket so
  // the next LLM call sees a different part of the map.
  dequeuePlanAction() {
    if (this.planStepHoldRemaining > 0 && this.pendingLLMAction) {
      this.planStepHoldRemaining -= 1;
      return this.pendingLLMAction;
    }
    if (this.planQueue.length > 0) {
      const step = this.planQueue.shift();
      this.planStep += 1;
      this.planStepHoldRemaining = this.ticksPerStep() - 1;
      this.pendingLLMAction = step;
      return step;
    }
    if (this.macroEnabled() && this.planLength > 0 &&
        this.promptConfig?.macroActions?.exhaustAction === 'wait') {
      return 'ACTION_NIL';
    }
    const fallback = this.pendingLLMAction || 'ACTION_NIL';
    const breaker = this.resolveLoopBreaker(fallback);
    if (breaker !== fallback) {
      this.pendingLLMAction = breaker;
    }
    return breaker;
  }

  // Executor-level loop breaker. Fires when:
  //  1. The plan queue is empty (we're in the blind-repeat gap between LLM calls)
  //  2. The state tracker detects stagnation
  //  3. Enough ticks have passed since the last forced break
  //
  // Returns a different GVGAI action from the available list when breaking,
  // or the fallback action when not. The available-actions list must be passed
  // from the ACT payload — but dequeuePlanAction is called before JSON parsing,
  // so we cache the last-seen list from recordActState on every tick.
  //
  // Disabled for code-protocol games (their policy is already deterministic and
  // authoritative — overriding it would fight the scripted strategy).
  resolveLoopBreaker(fallbackAction) {
    if (this.promptConfig?.codeProtocol?.enabled) return fallbackAction;
    if (!this.stateTracker || !this.lastSso) return fallbackAction;

    const stagnation = this.stateTracker.detectStagnation();
    if (!stagnation) return fallbackAction;

    const tick = this.lastSso.gameTick || 0;
    if (tick - this.lastLoopBreakTick < STAGNATION_BREAK_INTERVAL) {
      return fallbackAction;
    }

    const directive = this.parseDirectionalStrategy();
    if (
      directive?.mode === 'avoid' &&
      (fallbackAction === directive.action || fallbackAction === 'ACTION_NIL' || MOVEMENT_ACTIONS.includes(fallbackAction))
    ) {
      return fallbackAction;
    }

    const available = this.lastSso.availableActions || [];
    const forbidden = directive?.mode === 'avoid' ? [directive.action] : [];
    let alt = this.stateTracker.suggestAlternativeDirection(available);
    if (!alt || alt === fallbackAction || forbidden.includes(alt)) {
      alt = this.chooseSteeringAlternative(available, null, {
        forbiddenActions: forbidden,
        softAvoidActions: [fallbackAction],
        movementOnly: true,
        rotate: true
      });
    }
    if (!alt || alt === fallbackAction) return fallbackAction;

    this.lastLoopBreakTick = tick;
    console.log(`[LLMClient] Loop breaker: overriding ${fallbackAction} → ${alt} (stagnation detected at tick ${tick})`);
    return alt;
  }

  parseDirectionalStrategy() {
    const strategy = (this.sessionStrategy || '').trim();
    if (!strategy) return null;

    const negative = strategy.match(NEGATED_DIRECTION_RE);
    if (negative) {
      return { mode: 'avoid', direction: negative[1].toLowerCase(), action: DIRECTION_ACTIONS[negative[1].toLowerCase()] };
    }

    const positive = strategy.match(POSITIVE_DIRECTION_RE) || strategy.match(EXACT_DIRECTION_RE);
    if (positive) {
      return { mode: 'prefer', direction: positive[1].toLowerCase(), action: DIRECTION_ACTIONS[positive[1].toLowerCase()] };
    }

    return null;
  }

  parseSsoForSteering(jsonPayload) {
    try {
      return JSON.parse(jsonPayload);
    } catch (error) {
      console.error('[LLMClient] Error parsing game state for steering:', error.message);
      return null;
    }
  }

  chooseSteeringAlternative(availableActions, forbiddenAction, options = {}) {
    const available = Array.isArray(availableActions) ? availableActions : [];
    const hardAvoid = new Set([
      forbiddenAction,
      ...(Array.isArray(options.forbiddenActions) ? options.forbiddenActions : [])
    ].filter(Boolean));
    const softAvoid = new Set((Array.isArray(options.softAvoidActions) ? options.softAvoidActions : []).filter(Boolean));
    const order = options.movementOnly ? MOVEMENT_ACTIONS : STEERING_ACTION_ORDER;
    const pick = (respectSoftAvoid) => {
      const candidates = order.filter(action =>
        available.includes(action) &&
        !hardAvoid.has(action) &&
        (!respectSoftAvoid || !softAvoid.has(action))
      );
      if (candidates.length === 0) return null;
      if (!options.rotate) return candidates[0];
      const chosen = candidates[this.steeringAlternativeCursor % candidates.length];
      this.steeringAlternativeCursor += 1;
      return chosen;
    };
    return pick(true) || pick(false);
  }

  steeringReason(directive, action, adjusted = false) {
    const label = action.replace(/^ACTION_/, '');
    if (directive.mode === 'avoid') {
      const forbidden = directive.action.replace(/^ACTION_/, '');
      return adjusted
        ? `Steering directive "${this.sessionStrategy}" forbids ${forbidden}; choosing ${label}.`
        : `Steering directive "${this.sessionStrategy}" allows ${label}.`;
    }
    return `Steering directive "${this.sessionStrategy}" selects ${label}.`;
  }

  resolveSteeringAction(sso, candidateAction = null) {
    const directive = this.parseDirectionalStrategy();
    if (!directive || !sso) return null;

    const available = Array.isArray(sso.availableActions) ? sso.availableActions : [];
    if (directive.mode === 'prefer') {
      if (!available.includes(directive.action)) return null;
      return {
        action: directive.action,
        directive,
        adjusted: candidateAction && candidateAction !== directive.action,
        reason: this.steeringReason(directive, directive.action, candidateAction && candidateAction !== directive.action)
      };
    }

    const stagnation = this.stateTracker ? this.stateTracker.detectStagnation() : '';
    const candidateIsForbidden = candidateAction === directive.action;
    const candidateIsIdle = !candidateAction || candidateAction === 'ACTION_NIL';
    const candidateIsStagnantMovement = Boolean(
      stagnation &&
      candidateAction &&
      MOVEMENT_ACTIONS.includes(candidateAction)
    );
    if (!candidateIsForbidden && !candidateIsIdle && !candidateIsStagnantMovement) return null;
    const softAvoidActions = [];
    if (candidateIsIdle) softAvoidActions.push('ACTION_NIL');
    if (candidateIsStagnantMovement) softAvoidActions.push(candidateAction, 'ACTION_NIL');
    const alternative = this.chooseSteeringAlternative(available, directive.action, {
      softAvoidActions,
      rotate: true
    });
    if (!alternative) return null;
    return {
      action: alternative,
      directive,
      adjusted: true,
      reason: this.steeringReason(directive, alternative, true)
    };
  }

  resolveImmediateSteeringAction(jsonPayload) {
    const directive = this.parseDirectionalStrategy();
    if (!directive || directive.mode !== 'prefer') return null;
    const sso = this.parseSsoForSteering(jsonPayload);
    return this.resolveSteeringAction(sso);
  }

  applySteeringToCandidate(candidateAction, jsonPayload) {
    const directive = this.parseDirectionalStrategy();
    if (!directive) return { action: candidateAction, steering: null };

    const sso = this.parseSsoForSteering(jsonPayload);
    const steering = this.resolveSteeringAction(sso, candidateAction);
    if (!steering) return { action: candidateAction, steering: null };
    return { action: steering.action, steering };
  }

  applySteeringToPlan(action, planActions, sso) {
    const directive = this.parseDirectionalStrategy();
    if (!directive) {
      return { action, planActions, reason: null, decisionSource: null, steering: null };
    }

    const steering = this.resolveSteeringAction(sso, action);
    if (!steering) {
      if (directive.mode !== 'avoid') return { action, planActions, reason: null, decisionSource: null, steering: null };
      const filtered = planActions.filter(step => step !== directive.action);
      return {
        action,
        planActions: filtered.length > 0 ? filtered : planActions,
        reason: null,
        decisionSource: null,
        steering: null
      };
    }

    let nextPlan;
    if (directive.mode === 'prefer') {
      const targetLength = this.macroEnabled()
        ? Math.max(1, Math.min(planActions.length || 1, MAX_PLAN_STEPS))
        : 1;
      nextPlan = Array(targetLength).fill(steering.action);
    } else {
      const filtered = planActions.filter(step => step !== directive.action);
      nextPlan = [steering.action, ...filtered.filter(step => step !== steering.action)];
    }

    return {
      action: steering.action,
      planActions: nextPlan,
      reason: steering.reason,
      decisionSource: 'steering-direct',
      steering
    };
  }

  maybeEmitSteeringDecision(steering, sso) {
    if (!steering || !sso) return;
    const tick = Number.isInteger(sso.gameTick) ? sso.gameTick : 0;
    const shouldEmit =
      this.lastSteeringDecisionTickLogged === null ||
      this.lastSteeringDecisionActionLogged !== steering.action ||
      tick - this.lastSteeringDecisionTickLogged >= 10;

    this.pendingLLMAction = steering.action;
    if (!shouldEmit) return;

    this.lastSteeringDecisionTickLogged = tick;
    this.lastSteeringDecisionActionLogged = steering.action;
    this.lastProvider = 'steering-direct';
    this.lastModelUsed = this.model;
    this.recordActionDecision(steering.action, tick, steering.reason, sso);

    if (this.io) {
      this.io.emit('llm-reasoning', {
        runId: this.runId,
        prompt: '',
        systemPrompt: null,
        promptLayers: null,
        response: '',
        reason: steering.reason,
        decisionSource: 'steering-direct',
        parsedAction: steering.action,
        policyAuthoritative: true,
        fallbackAction: steering.action,
        fallbackActionCode: null,
        strategy: this.sessionStrategy,
        action: steering.action,
        plan: [steering.action],
        planLength: 1,
        elapsed: 0,
        provider: 'steering-direct',
        modelUsed: this.model,
        gameState: {
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          tick: sso.gameTick
        }
      });
    }
  }

  setPlan(plan, sso) {
    const legal = new Set(sso.availableActions || []);
    const steps = (Array.isArray(plan) ? plan : [])
      .filter(a => legal.has(a))
      .slice(0, MAX_PLAN_STEPS);
    this.planQueue = steps;
    this.planLength = steps.length;
    this.planStep = 0;
    this.planStepHoldRemaining = 0;
    this.planSetTick = sso.gameTick || 0;
    this.planHealthAtSet = Number.isFinite(sso.avatarHealthPoints) ? sso.avatarHealthPoints : null;
  }

  clearPlan() {
    this.planQueue = [];
    this.planLength = 0;
    this.planStep = 0;
    this.planSetTick = null;
    this.planHealthAtSet = null;
    this.planStepHoldRemaining = 0;
    this.lastLoopBreakTick = -STAGNATION_BREAK_INTERVAL;
  }

  // A plan is a commitment to a world that may no longer exist. Drop it when the
  // world hit us (health), it went stale (age), it's walking into a wall (loop),
  // or its next step is no longer legal. Deliberately NOT on score gain — a
  // scoring plan is a working plan, and clearing it re-introduces jitter.
  maybeInvalidatePlan(sso) {
    if (this.planQueue.length === 0) return;
    const tick = sso.gameTick || 0;
    const health = Number.isFinite(sso.avatarHealthPoints) ? sso.avatarHealthPoints : null;
    let reason = null;
    if (this.planHealthAtSet !== null && health !== null && health < this.planHealthAtSet) {
      reason = 'health-drop';
    } else if (this.planSetTick !== null && tick - this.planSetTick > MAX_PLAN_AGE_TICKS) {
      reason = 'plan-age';
    } else if (this.stateTracker.detectLoop()) {
      reason = 'loop-detected';
    } else if (Array.isArray(sso.availableActions) && sso.availableActions.length > 0 &&
               !sso.availableActions.includes(this.planQueue[0])) {
      reason = 'illegal-step';
    }
    if (reason) {
      console.log(`[LLMClient] Plan invalidated (${reason}) with ${this.planQueue.length} steps remaining`);
      this.clearPlan();
    }
  }

  // -------------------------------------------------------------------------

  resolveAuthoritativePolicy(jsonPayload) {
    if (!this.promptConfig?.codeProtocol?.enabled) return null;

    let sso;
    try {
      sso = JSON.parse(jsonPayload);
    } catch (error) {
      console.error('[LLMClient] Error parsing game state for policy action:', error.message);
      return null;
    }

    const promptDecision = buildPrompt(sso, this.promptConfig, this.stateTracker, this.sessionStrategy);
    if (
      promptDecision.responseMode !== 'code' ||
      promptDecision.policyAuthoritative !== true ||
      !promptDecision.fallbackAction ||
      !(sso.availableActions || []).includes(promptDecision.fallbackAction)
    ) {
      return null;
    }

    return {
      action: promptDecision.fallbackAction,
      reason: promptDecision.policyReason || `encoded best action ${promptDecision.fallbackActionCode || ''}`.trim(),
      decisionSource: 'policy-direct',
      fallbackAction: promptDecision.fallbackAction,
      fallbackActionCode: promptDecision.fallbackActionCode,
      policyAuthoritative: true,
      prompt: promptDecision.userMessage,
      systemPrompt: promptDecision.systemMessage || null,
      promptLayers: promptDecision.promptLayers || null,
      actionCodeMap: promptDecision.actionCodeMap || null,
      responseMode: promptDecision.responseMode
    };
  }

  emitPolicyDecision(decision, sso) {
    const tick = Number.isInteger(sso.gameTick) ? sso.gameTick : 0;
    const score = Number.isFinite(sso.gameScore) ? sso.gameScore : 0;
    const shouldEmit =
      this.lastPolicyDecisionTickLogged === null ||
      this.lastPolicyDecisionActionLogged !== decision.action ||
      this.lastPolicyDecisionScoreLogged !== score ||
      tick - this.lastPolicyDecisionTickLogged >= 10;

    this.lastProvider = 'encoded-policy';
    this.lastModelUsed = this.model;
    if (!shouldEmit) return;

    this.lastPolicyDecisionTickLogged = tick;
    this.lastPolicyDecisionActionLogged = decision.action;
    this.lastPolicyDecisionScoreLogged = score;
    const prompt = decision.prompt || '';

    telemetry.track({
      eventFamily: 'model_telemetry',
      eventType: 'llm_decision',
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
      modelId: this.model,
      provider: 'encoded-policy',
      latencyMs: 0,
      payload: {
        action: decision.action,
        reason: decision.reason,
        decisionSource: decision.decisionSource,
        parsedAction: decision.action,
        policyAuthoritative: true,
        fallbackAction: decision.fallbackAction,
        fallbackActionCode: decision.fallbackActionCode,
        modelUsed: this.model,
        responseMode: decision.responseMode,
        strategy_present: Boolean(this.sessionStrategy)
      },
      metrics: {
        prompt_chars: prompt.length,
        system_prompt_chars: decision.systemPrompt ? decision.systemPrompt.length : 0,
        action_code_count: decision.actionCodeMap ? Object.keys(decision.actionCodeMap).length : 0,
        parse_valid: 1,
        response_chars: 0,
        tick,
        score
      }
    });

    if (this.io) {
      this.io.emit('llm-reasoning', {
        runId: this.runId,
        prompt,
        systemPrompt: decision.systemPrompt,
        promptLayers: decision.promptLayers || null,
        response: '',
        reason: decision.reason,
        decisionSource: decision.decisionSource,
        parsedAction: decision.action,
        policyAuthoritative: true,
        fallbackAction: decision.fallbackAction,
        fallbackActionCode: decision.fallbackActionCode,
        strategy: this.sessionStrategy,
        action: decision.action,
        plan: [decision.action],
        planLength: 1,
        elapsed: 0,
        provider: 'encoded-policy',
        modelUsed: this.model,
        gameState: {
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          tick: sso.gameTick
        }
      });
    }
  }

  recordStateTrace(sso, actionToSend) {
    const tick = Number.isInteger(sso.gameTick) ? sso.gameTick : 0;
    const score = Number.isFinite(sso.gameScore) ? sso.gameScore : 0;
    const scoreChanged = this.lastTraceScoreLogged !== null && score !== this.lastTraceScoreLogged;
    const tickDelta = this.lastTraceTickLogged === null ? Infinity : tick - this.lastTraceTickLogged;
    if (tickDelta < 10 && !scoreChanged) return;

    this.lastTraceTickLogged = tick;
    this.lastTraceScoreLogged = score;
    telemetry.track({
      eventFamily: 'trace',
      eventType: 'game_state_tick',
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
      modelId: this.model,
      payload: {
        action: actionToSend || null,
        winner: sso.gameWinner || null
      },
      metrics: {
        tick,
        score,
        health: sso.avatarHealthPoints || 0,
        max_health: sso.avatarMaxHealthPoints || 0
      }
    });
  }

  // Call a single provider's OpenAI-compatible chat endpoint. Returns the response
  // text, or throws on a non-OK status so the caller can trigger the fallback.
  async callProvider(provider, modelId, messages, settings) {
    // Local Ollama thinking models (gemma4 E-series) burn all max_tokens on
    // reasoning and return empty content via the OpenAI-compatible endpoint.
    // Route them through the native /api/chat endpoint with think:false so they
    // produce answer tokens directly — 0.4s instead of 1.5s, and the response
    // parser actually finds an action in the output.
    if (provider === 'ollama-local' && this._isLocalThinkingModel(modelId)) {
      return this._callLocalOllamaNative(modelId, messages, settings);
    }

    let apiUrl;
    const headers = { 'Content-Type': 'application/json' };

    const body = {
      model: modelId,
      messages,
      max_tokens: settings.maxTokens || 200,
      temperature: settings.temperature !== undefined ? settings.temperature : 0.7
    };

    if (provider === 'ollama-cloud') {
      // Light usage guardrail on the Ollama Cloud key. A blocked call throws a
      // flagged error; the route loop can still use a configured fallback.
      const verdict = guardrail.admitOllamaCall(this.ollamaCloudCallCount || 0);
      if (!verdict.allowed) {
        telemetry.track({
          eventFamily: 'system',
          eventType: 'guardrail_block',
          source: 'llm-client',
          runId: this.runId,
          gameId: this.gameId,
          levelId: this.levelCount,
          modelId,
          provider: 'ollama-cloud',
          payload: { scope: verdict.scope, message: verdict.reason }
        });
        const guardErr = new Error(`ollama-cloud usage guardrail: ${verdict.reason}`);
        guardErr.guardrail = true;
        throw guardErr;
      }
      this.ollamaCloudCallCount = (this.ollamaCloudCallCount || 0) + 1;
      apiUrl = config.ollamaCloud.apiUrl;
      if (this.ollamaApiKey) headers['Authorization'] = `Bearer ${this.ollamaApiKey}`;
      // Frontier reasoning models (catalog reasoning:true) think by default and
      // burn the OpenAI-compat token budget before emitting content. Route them
      // through the cloud's native /api/chat with think:false — same guardrail
      // accounting as above, since it already ran.
      if (resolveModel(modelId).reasoning) {
        return this._callOllamaNative(apiUrl, modelId, messages, settings, headers, 'ollama-cloud');
      }
    } else if (provider === 'ollama-local') {
      apiUrl = config.ollama.apiUrl;
    } else if (provider === 'legion-vllm') {
      // Shared Gemma-3-4b base + per-room LoRA adapters served by vLLM on the
      // Legion (CUDA), reached over Tailscale. The adapter is selected by the
      // `model` field already in the body, so nothing else changes here.
      apiUrl = config.legion.apiUrl;
      if (process.env.LEGION_API_KEY) headers['Authorization'] = `Bearer ${process.env.LEGION_API_KEY}`;
    } else { // openrouter
      apiUrl = config.openrouter.apiUrl;
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        headers['HTTP-Referer'] = 'https://github.com/zmuhls/gvgai';
        headers['X-Title'] = 'GVGAI LLM Agent';
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.actionTimeoutMs);
    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`${provider} timed out after ${this.actionTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider} ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const msg = data.choices?.[0]?.message || {};
    // Fall back to the reasoning field if a reasoning model truncated before content
    return msg.content || msg.reasoning || '';
  }

  // Local Ollama models that use thinking/reasoning tokens by default (gemma4
  // E-series). These need the native /api/chat endpoint with think:false to
  // produce answer tokens within the game's max_tokens budget.
  _isLocalThinkingModel(modelId) {
    return /^gemma4:e[0-9]+b/.test(modelId);
  }

  // Call the native Ollama /api/chat endpoint (not OpenAI-compatible) with
  // think:false to suppress reasoning tokens. Returns the message content.
  async _callLocalOllamaNative(modelId, messages, settings) {
    return this._callOllamaNative(config.ollama.apiUrl, modelId, messages, settings,
      { 'Content-Type': 'application/json' }, 'ollama-local');
  }

  // Shared native-endpoint caller for local and cloud Ollama. `openAiUrl` is
  // the provider's OpenAI-compat URL; the native /api/chat lives on the same
  // host. Headers carry cloud auth when present.
  async _callOllamaNative(openAiUrl, modelId, messages, settings, headers, providerLabel) {
    const baseUrl = openAiUrl.replace(/\/v1\/chat\/completions$/, '');
    const apiUrl = `${baseUrl}/api/chat`;
    const body = {
      model: modelId,
      messages,
      stream: false,
      think: false,
      options: {
        num_predict: settings.maxTokens || 200,
        temperature: settings.temperature !== undefined ? settings.temperature : 0.7
      }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.actionTimeoutMs);
    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`${providerLabel} timed out after ${this.actionTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${providerLabel} ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.message?.content || '';
  }

  async requestLLMAction(jsonPayload) {
    const sso = JSON.parse(jsonPayload);
    const {
      systemMessage,
      userMessage,
      promptLayers,
      actionCodeMap,
      responseMode,
      fallbackAction,
      fallbackActionCode,
      policyAuthoritative
    } = buildPrompt(sso, this.promptConfig, this.stateTracker, this.sessionStrategy);
    const prompt = userMessage;
    const strategyRevisionAtStart = this.strategyRevision;
    const strategyAtStart = this.sessionStrategy;

    // Cross-run learning: tell the model how its last run went so it can adjust.
    // This is the within-session reward signal — the model sees its own outcome
    // history and can break out of a stale action loop.
    let outcomeContext = '';
    if (this.lastRunOutcome) {
      const o = this.lastRunOutcome;
      const verdict = o.won ? 'WON' : 'LOST';
      outcomeContext = `LAST RUN OUTCOME — you ${verdict} with ${o.finalScore} points in ${o.ticks} ticks. Your most-used action was ${o.topAction} (${o.topActionCount}x).`;
      if (!o.won) {
        outcomeContext += ' Try a different approach this time.';
      }
    }

    const messages = [];
    if (systemMessage) {
      messages.push({ role: 'system', content: systemMessage });
    }
    const userContent = [outcomeContext, userMessage].filter(Boolean).join('\n\n');
    messages.push({ role: 'user', content: userContent });

    const settings = { ...(this.promptConfig?.llmSettings || {}) };
    if (responseMode === 'code') {
      const configuredMaxTokens = Number(settings.maxTokens);
      if (!Number.isFinite(configuredMaxTokens) || configuredMaxTokens > 8) {
        settings.maxTokens = 8;
      }
    }
    const resolved = resolveModel(this.model);
    const startTime = Date.now();
    let llmResponse;
    let usedProvider = resolved.provider;
    let usedModel = resolved.id;
    const routes = this.buildProviderRoutes(resolved);

    for (let index = 0; index < routes.length; index++) {
      const route = routes[index];
      const nextRoute = routes[index + 1] || null;
      usedProvider = route.provider;
      usedModel = route.modelId;

      try {
        llmResponse = await this.callProvider(route.provider, route.modelId, messages, settings);
        if (index > 0) {
          console.log(`[LLMClient] Fell back to ${route.provider}/${route.modelId}`);
        }
        break;
      } catch (err) {
        const label = route.stage === 'primary' && index === 0 ? 'Primary' : 'Fallback';
        console.warn(`[LLMClient] ${label} ${route.provider}/${route.modelId} failed: ${err.message}`);
        telemetry.track({
          eventFamily: 'model_telemetry',
          eventType: 'provider_error',
          source: 'llm-client',
          runId: this.runId,
          gameId: this.gameId,
          levelId: this.levelCount,
          modelId: route.modelId,
          provider: route.provider,
          payload: {
            message: err.message,
            stage: route.stage,
            fallback: nextRoute ? `${nextRoute.provider}/${nextRoute.modelId}` : null
          }
        });

        if (!nextRoute) {
          const message = routes.length > 1
            ? `provider fallback chain failed: ${err.message}`
            : err.message;
          if (this.io) this.io.emit('llm-error', { runId: this.runId, status: 0, message });
          throw err;
        }
      }
    }

    if (llmResponse === undefined) {
      throw new Error('provider fallback chain produced no response');
    }

    const elapsed = Date.now() - startTime;
    if (strategyRevisionAtStart !== this.strategyRevision || strategyAtStart !== this.sessionStrategy) {
      console.log('[LLMClient] Ignoring stale LLM response after steering update');
      return {
        action: null,
        reason: '',
        decisionSource: 'stale-strategy',
        elapsed,
        provider: usedProvider,
        modelUsed: usedModel,
        stale: true
      };
    }

    const maxPlanSteps = this.promptConfig?.macroActions?.maxSteps || MAX_PLAN_STEPS;
    const parsed = parseStructured(llmResponse, sso.availableActions, actionCodeMap, { maxPlanSteps });
    let { action, reason } = parsed;
    let decisionSource = parsed.source || 'unknown';
    const trustedCodeParse = !responseMode || responseMode !== 'code' || [
      'compact-exact',
      'compact-field',
      'exact-action',
      'canonical-action'
    ].includes(parsed.source);
    if (
      responseMode === 'code' &&
      policyAuthoritative &&
      fallbackAction &&
      (sso.availableActions || []).includes(fallbackAction)
    ) {
      action = fallbackAction;
      reason = `encoded best action ${fallbackActionCode || ''}`.trim();
      decisionSource = parsed.valid === false ? 'policy-fallback' : 'policy-override';
    } else if (
      responseMode === 'code' &&
      (parsed.valid === false || !trustedCodeParse) &&
      fallbackAction &&
      (sso.availableActions || []).includes(fallbackAction)
    ) {
      action = fallbackAction;
      reason = `encoded best action ${fallbackActionCode || ''}`.trim();
      decisionSource = 'policy-fallback';
    }
    // Queue the multi-step plan for the tick executor. Code-protocol responses
    // never take this path (buildPrompt branches to buildCodePrompt first, and
    // the overrides above rewrite action anyway).
    let planActions = (this.macroEnabled() && responseMode !== 'code' && Array.isArray(parsed.plan) && parsed.plan.length > 0)
      ? parsed.plan
      : [action];
    const steering = this.applySteeringToPlan(action, planActions, sso);
    if (steering.steering) {
      action = steering.action;
      planActions = steering.planActions;
      reason = steering.reason || reason;
      decisionSource = steering.decisionSource || decisionSource;
    }

    this.lastProvider = steering.steering ? 'steering-direct' : usedProvider;
    this.lastModelUsed = usedModel;
    this.pendingLLMAction = action;

    if (this.macroEnabled() && responseMode !== 'code') {
      this.setPlan(planActions, sso);
    }
    const aliases = this.promptConfig?.actionAliases || null;
    const displayPlan = aliases ? planActions.map(a => aliases[a] || a) : planActions;

    this.recordActionDecision(action, sso.gameTick, reason, sso);

    console.log(`[LLMClient] LLM completed (${elapsed}ms): ${action}${reason ? ' — ' + reason : ''}`);

    const storeRawText = process.env.TELEMETRY_STORE_PROMPTS === 'true';
    telemetry.track({
      eventFamily: 'model_telemetry',
      eventType: 'llm_decision',
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
      modelId: this.model,
      provider: steering.steering ? 'steering-direct' : usedProvider,
      latencyMs: elapsed,
      payload: {
        action,
        reason,
        decisionSource,
        parsedAction: parsed.action,
        policyAuthoritative: Boolean(policyAuthoritative),
        fallbackAction,
        fallbackActionCode,
        modelUsed: usedModel,
        responseMode: responseMode || 'text',
        plan: planActions,
        planLength: planActions.length,
        planSource: parsed.planSource || 'single-action',
        strategy_present: Boolean(this.sessionStrategy),
        prompt: storeRawText ? prompt : undefined,
        systemPrompt: storeRawText ? systemMessage || null : undefined,
        response: storeRawText ? llmResponse : undefined
      },
      metrics: {
        prompt_chars: prompt.length,
        system_prompt_chars: systemMessage ? systemMessage.length : 0,
        action_code_count: actionCodeMap ? Object.keys(actionCodeMap).length : 0,
        parse_valid: parsed.valid === false ? 0 : 1,
        response_chars: llmResponse.length,
        tick: sso.gameTick || 0,
        score: sso.gameScore || 0
      }
    });

    if (this.io) {
      this.io.emit('llm-reasoning', {
        runId: this.runId,
        prompt,
        systemPrompt: systemMessage || null,
        promptLayers: promptLayers || null,
        response: llmResponse,
        reason,
        decisionSource,
        parsedAction: parsed.action,
        policyAuthoritative: Boolean(policyAuthoritative),
        fallbackAction,
        fallbackActionCode,
        strategy: this.sessionStrategy,
        action,
        plan: displayPlan,
        planLength: planActions.length,
        elapsed,
        provider: steering.steering ? 'steering-direct' : usedProvider,
        modelUsed: usedModel,
        lastRunOutcome: this.lastRunOutcome || null,
        gameState: {
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          tick: sso.gameTick
        }
      });
    }

    return { action, reason, decisionSource, elapsed, provider: steering.steering ? 'steering-direct' : usedProvider, modelUsed: usedModel };
  }

  recordActionDecision(action, tick, reason = '', sso = null) {
    this.stateTracker.recordAction(action, tick);
    const lastDelta = this.stateTracker.actionHistory[this.stateTracker.actionHistory.length - 1];
    this.runLog.push({
      tick,
      action,
      reason,
      scoreDelta: lastDelta ? lastDelta.scoreDelta : 0,
      sso: traceStore.pruneSsoForTrace(sso)
    });
  }

  async startAsyncLLMCall(jsonPayload) {
    this.llmCallInProgress = true;
    this.lastLLMCallTime = Date.now();

    try {
      await this.requestLLMAction(jsonPayload);
    } catch (error) {
      console.error('[LLMClient] Error in async LLM call:', error);
    } finally {
      this.llmCallInProgress = false;
    }
  }

  async handleEnd(sso, msgId) {
    const completedLevel = this.levelCount;
    const progression = nextLevelResponse(completedLevel, sso.gameWinner, { maxLevelId: this.maxLevelId });
    console.log(`[LLMClient] Level ${completedLevel} ended`);
    console.log(`[LLMClient] Score: ${sso.gameScore}`);
    console.log(`[LLMClient] Winner: ${sso.gameWinner}`);

    // Build the end-of-run summary BEFORE resetting run state
    const summary = this.buildRunSummary(sso);

    // Reset LLM state for next level (a plan must never leak across levels)
    this.pendingLLMAction = null;
    this.llmCallInProgress = false;
    this.lastLLMCallTime = 0;
    this.clearPlan();

    // Notify frontend (per-level, not session end)
    if (this.io) {
      this.io.emit('level-end', {
        runId: this.runId,
        score: sso.gameScore,
        winner: sso.gameWinner,
        ticks: sso.gameTick,
        level: completedLevel
      });
      this.emitRunSummary(summary);
    }
    telemetry.track({
      eventFamily: 'evaluation',
      eventType: 'level_ended',
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: completedLevel,
      modelId: this.model,
      provider: this.lastProvider,
      payload: {
        score: sso.gameScore,
        winner: sso.gameWinner
      },
      metrics: {
        ticks: sso.gameTick || 0
      }
    });

    // Save the LLM play trace — these are the "model played" traces that the
    // trace summary builder compares against human traces to give the model
    // reward signals and operational patterns grounded in observed gameplay.
    const llmTrace = {
      gameId: this.gameId,
      gameName: this.gameName,
      levelId: completedLevel,
      playerType: 'llm',
      modelId: this.model,
      strategy: this.sessionStrategy,
      actionHistory: this.runLog.map(e => ({
        tick: e.tick,
        action: e.action,
        scoreDelta: e.scoreDelta,
        sso: e.sso || null
      })),
      finalScore: sso.gameScore || 0,
      winner: sso.gameWinner,
      won: sso.gameWinner === 'PLAYER_WINS' || sso.gameWinner === true,
      ticks: sso.gameTick || 0,
      scoreEvents: this.runLog
        .filter(e => e.scoreDelta !== 0)
        .map(e => ({ tick: e.tick, action: e.action, scoreDelta: e.scoreDelta }))
    };
    try {
      traceStore.saveTrace(llmTrace);
    } catch (err) {
      console.error('[LLMClient] Failed to save trace:', err.message);
    }

    // Store the outcome for the next run's prompt (cross-run learning signal)
    const actionCounts = {};
    for (const entry of this.runLog) {
      actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    }
    const topAction = Object.entries(actionCounts).sort((a, b) => b[1] - a[1])[0];
    this.lastRunOutcome = {
      finalScore: sso.gameScore || 0,
      won: sso.gameWinner === 'PLAYER_WINS' || sso.gameWinner === true,
      winner: sso.gameWinner,
      ticks: sso.gameTick || 0,
      actionCounts,
      topAction: topAction ? topAction[0] : null,
      topActionCount: topAction ? topAction[1] : 0
    };

    // Reset run accumulation + history for the next level
    this.runLog = [];
    this.runStartScore = null;
    this.stateTracker.reset();

    if (!progression.finished && progression.nextLevelId !== null) {
      this.levelCount = progression.nextLevelId;
    }

    // Reply with the next level id expected by GVGAI's learning protocol:
    // repeat the current level after a loss, advance after a win.
    this.sendMessageWithId(msgId, progression.response);
  }

  // Aggregate the run log into a summary card payload: score, win/loss, the echoed
  // strategy, a stated-adherence signal, and a few concrete highlight decisions.
  buildRunSummary(sso) {
    const won = sso.gameWinner === 'PLAYER_WINS' || sso.gameWinner === true;
    const adherence = computeAdherence(this.sessionStrategy, this.runLog);

    // Highlights: prefer score-gaining decisions; fall back to strategy-mentioning ones
    let highlights = this.runLog
      .filter(e => e.scoreDelta > 0)
      .sort((a, b) => b.scoreDelta - a.scoreDelta)
      .slice(0, 5);
    if (highlights.length < 3 && adherence.keywords.length > 0) {
      const seen = new Set(highlights.map(h => h.tick));
      for (const e of this.runLog) {
        if (seen.has(e.tick)) continue;
        const r = (e.reason || '').toLowerCase();
        if (adherence.keywords.some(k => r.includes(k))) {
          highlights.push(e);
          if (highlights.length >= 5) break;
        }
      }
    }
    highlights = highlights
      .slice(0, 5)
      .sort((a, b) => a.tick - b.tick)
      .map(e => ({ tick: e.tick, action: e.action, reason: e.reason, scoreDelta: e.scoreDelta }));

    return {
      runId: this.runId,
      strategy: this.sessionStrategy,
      provider: this.lastProvider,
      modelUsed: this.lastModelUsed || this.model,
      finalScore: sso.gameScore || 0,
      winner: sso.gameWinner,
      won,
      ticks: sso.gameTick || 0,
      decisions: this.runLog.length,
      actions: this.runLog.map(entry => entry.action),
      level: this.levelCount,
      adherence,
      highlights
    };
  }

  emitRunSummary(summary) {
    if (this.io && !this.summaryEmitted) {
      this.summaryEmitted = true;
      this.io.emit('run-summary', summary);
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'run_summary',
        source: 'llm-client',
        runId: this.runId,
        gameId: this.gameId,
        levelId: summary.level,
        modelId: this.model,
        provider: summary.provider,
        payload: {
          strategy_present: Boolean(summary.strategy),
          winner: summary.winner,
          won: summary.won,
          actions: summary.actions,
          adherence: summary.adherence,
          highlights: summary.highlights
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
    if (this.summaryEmitted || (!this.lastSso && this.runLog.length === 0)) return;
    const sso = this.lastSso || {};
    const summary = this.buildRunSummary({
      ...sso,
      gameWinner: sso.gameWinner || 'ABORTED',
      gameTick: sso.gameTick || this.runLog.length,
      gameScore: sso.gameScore || this.runStartScore || 0
    });
    summary.endedBy = 'socket-close';
    this.emitRunSummary(summary);
  }

  sendMessageWithId(msgId, msg) {
    if (this.socket && !this.socket.destroyed) {
      const message = `${msgId}#${msg}\n`;
      console.log(`[LLMClient] Sending: ${message.trim()}`);
      this.socket.write(message);
    } else {
      console.error('[LLMClient] Cannot send - socket not ready');
    }
  }

  // Mid-run steering: replace the session strategy while the model is playing.
  // Sanitized the same way as the connect-time strategy; the current macro plan
  // is dropped so the new directive shapes the very next decision instead of
  // waiting for a queued plan to drain.
  updateStrategy(rawStrategy) {
    const { text, warnings } = sanitizeStrategy(rawStrategy);
    this.sessionStrategy = text;
    this.strategyRevision += 1;
    this.clearPlan();
    this.pendingLLMAction = null;
    this.lastLLMCallTime = 0;
    this.lastSteeringDecisionTickLogged = null;
    this.lastSteeringDecisionActionLogged = null;
    this.steeringAlternativeCursor = 0;
    if (this.io) {
      this.io.emit('strategy-updated', {
        runId: this.runId,
        strategy: text,
        warnings
      });
    }
    return { text, warnings };
  }

  _triggerSessionEnd() {
    if (this.onSessionEnd) {
      const cb = this.onSessionEnd;
      this.onSessionEnd = null;  // Prevent double-call
      cb();
    }
  }

  disconnect() {
    this.gameActive = false;
    this.onSessionEnd = null;  // Don't trigger cleanup on intentional disconnect
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = LLMClient;
