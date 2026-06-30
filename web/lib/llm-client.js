const net = require('net');
const { getConfig } = require('./runtime-config');
const config = getConfig();
const { buildPrompt, computeAdherence, GameStateTracker } = require('./state-converter');
const { parseStructured } = require('./response-parser');
const { resolveModel } = require('./models');
const promptStore = require('./prompt-store');
const telemetry = require('./telemetry-store');

class LLMClient {
  constructor(options = {}) {
    this.socket = null;
    // Load API keys from environment (Ollama Cloud is primary, OpenRouter is fallback)
    this.apiKey = process.env.OPENROUTER_API_KEY || null;          // OpenRouter (fallback)
    this.ollamaApiKey = process.env.OLLAMA_API_KEY || null;        // Ollama Cloud (primary)
    this.model = config.openrouter.defaultModel;
    this.io = null;
    this.lastReceivedMessageId = null;  // Track the messageId from Java
    this.buffer = '';
    this.gameActive = false;
    this.pendingLLMAction = null;  // Store the most recent LLM action result
    this.llmCallInProgress = false;  // Track if LLM is currently being called
    this.lastLLMCallTime = 0;  // Time-based LLM sampling
    this.levelCount = 0;  // Track current level number
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
    this.lastTraceTickLogged = null;
    this.lastTraceScoreLogged = null;
    this.lastPolicyDecisionTickLogged = null;
    this.lastPolicyDecisionActionLogged = null;
    this.lastPolicyDecisionScoreLogged = null;
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

  async connect(port, model, io, gameId, gameName, sessionStrategy = null) {
    this.model = model;
    this.io = io;
    this.gameActive = true;
    this.gameId = gameId != null ? gameId : null;
    this.gameName = gameName || 'unknown';
    // Runtime-only directive — lives on the instance, never reaches promptStore.saveGameConfig
    this.sessionStrategy = (sessionStrategy || '').trim() || null;
    this.stateTracker.reset();
    this.runLog = [];
    this.runStartScore = null;
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
    this.promptConfig = promptStore.resolveGamePromptConfig(this.gameId, 0, this.promptConfigOptions);
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
            strategy_present: Boolean(this.sessionStrategy)
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
        if (this.synchronousActions) {
          if (this.maxActions && this.runLog.length >= this.maxActions) {
            console.log(`[LLMClient] Max actions reached (${this.maxActions}); ending Java eval case`);
            this.sendMessageWithId(msgId, `ABORT#${this.actResponseType}`);
            return;
          }
          const directPolicy = this.resolveAuthoritativePolicy(jsonPayload);
          if (directPolicy) {
            const sso = this.recordActState(jsonPayload, directPolicy.action);
            if (sso) {
              this.pendingLLMAction = directPolicy.action;
              this.recordActionDecision(directPolicy.action, sso.gameTick || 0, directPolicy.reason);
              this.emitPolicyDecision(directPolicy, sso);
            }
            this.sendMessageWithId(msgId, `${directPolicy.action}#${this.actResponseType}`);
            return;
          }
          const sso = this.recordActState(jsonPayload, null);
          try {
            const decision = await this.requestLLMAction(jsonPayload);
            this.sendMessageWithId(msgId, `${decision.action}#${this.actResponseType}`);
          } catch (error) {
            console.error('[LLMClient] Error in synchronous LLM action:', error.message);
            this.recordActionDecision('ACTION_NIL', sso ? sso.gameTick : 0, error.message);
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
              this.recordActionDecision(directPolicy.action, sso.gameTick || 0, directPolicy.reason);
              this.emitPolicyDecision(directPolicy, sso);
            }
          });
          return;
        }

        // CRITICAL: Respond IMMEDIATELY with the specific message ID
        const actionToSend = this.pendingLLMAction || 'ACTION_NIL';
        this.sendMessageWithId(msgId, `${actionToSend}#${this.actResponseType}`);

        // Async processing after response sent (don't block)
        setImmediate(() => {
          this.recordActState(jsonPayload, actionToSend);

          // Start async LLM call every 400ms minimum (time-based, not tick-based)
          const now = Date.now();
          if (!this.llmCallInProgress && (now - this.lastLLMCallTime) >= 400) {
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
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          maxHealth: sso.avatarMaxHealthPoints,
          tick: sso.gameTick,
          action: actionToSend
        });
      }
      return sso;
    } catch (error) {
      console.error('[LLMClient] Error parsing game state for UI update:', error.message);
      return null;
    }
  }

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
        prompt,
        systemPrompt: decision.systemPrompt,
        response: '',
        reason: decision.reason,
        decisionSource: decision.decisionSource,
        parsedAction: decision.action,
        policyAuthoritative: true,
        fallbackAction: decision.fallbackAction,
        fallbackActionCode: decision.fallbackActionCode,
        strategy: this.sessionStrategy,
        action: decision.action,
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
    let apiUrl;
    const headers = { 'Content-Type': 'application/json' };

    const body = {
      model: modelId,
      messages,
      max_tokens: settings.maxTokens || 200,
      temperature: settings.temperature !== undefined ? settings.temperature : 0.7
    };

    if (provider === 'ollama-cloud') {
      apiUrl = config.ollamaCloud.apiUrl;
      if (this.ollamaApiKey) headers['Authorization'] = `Bearer ${this.ollamaApiKey}`;
      // Many Ollama Cloud models (e.g. gpt-oss) are reasoning models that burn the
      // token budget on hidden reasoning, leaving content empty. Low effort keeps
      // them fast (~876ms vs ~1460ms) and the visible answer non-empty.
      body.reasoning_effort = 'low';
    } else if (provider === 'ollama-local') {
      apiUrl = config.ollama.apiUrl;
    } else { // openrouter
      apiUrl = config.openrouter.apiUrl;
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        headers['HTTP-Referer'] = 'https://github.com/yourusername/gvgai-llm';
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

  async requestLLMAction(jsonPayload) {
    const sso = JSON.parse(jsonPayload);
    const {
      systemMessage,
      userMessage,
      actionCodeMap,
      responseMode,
      fallbackAction,
      fallbackActionCode,
      policyAuthoritative
    } = buildPrompt(sso, this.promptConfig, this.stateTracker, this.sessionStrategy);
    const prompt = userMessage;

    const messages = [];
    if (systemMessage) {
      messages.push({ role: 'system', content: systemMessage });
    }
    messages.push({ role: 'user', content: userMessage });

    const settings = this.promptConfig?.llmSettings || {};
    const resolved = resolveModel(this.model);
    const startTime = Date.now();
    let llmResponse;
    let usedProvider = resolved.provider;
    let usedModel = resolved.id;

    try {
      llmResponse = await this.callProvider(resolved.provider, resolved.id, messages, settings);
    } catch (primaryErr) {
      console.warn(`[LLMClient] Primary ${resolved.provider}/${resolved.id} failed: ${primaryErr.message}`);
      telemetry.track({
        eventFamily: 'model_telemetry',
        eventType: 'provider_error',
        source: 'llm-client',
        runId: this.runId,
        gameId: this.gameId,
        levelId: this.levelCount,
        modelId: resolved.id,
        provider: resolved.provider,
        payload: {
          message: primaryErr.message,
          fallback: resolved.fallback || null
        }
      });
      if (resolved.fallback) {
        usedProvider = 'openrouter';
        usedModel = resolved.fallback;
        try {
          llmResponse = await this.callProvider('openrouter', resolved.fallback, messages, settings);
          console.log(`[LLMClient] Fell back to openrouter/${resolved.fallback}`);
        } catch (fallbackErr) {
          if (this.io) this.io.emit('llm-error', { status: 0, message: `primary + fallback failed: ${fallbackErr.message}` });
          telemetry.track({
            eventFamily: 'model_telemetry',
            eventType: 'provider_error',
            source: 'llm-client',
            runId: this.runId,
            gameId: this.gameId,
            levelId: this.levelCount,
            modelId: resolved.fallback,
            provider: 'openrouter',
            payload: {
              message: fallbackErr.message,
              stage: 'fallback'
            }
          });
          throw fallbackErr;
        }
      } else {
        if (this.io) this.io.emit('llm-error', { status: 0, message: primaryErr.message });
        throw primaryErr;
      }
    }

    const elapsed = Date.now() - startTime;
    const parsed = parseStructured(llmResponse, sso.availableActions, actionCodeMap);
    let { action, reason } = parsed;
    let decisionSource = parsed.source || 'unknown';
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
      parsed.valid === false &&
      fallbackAction &&
      (sso.availableActions || []).includes(fallbackAction)
    ) {
      action = fallbackAction;
      reason = `encoded best action ${fallbackActionCode || ''}`.trim();
      decisionSource = 'policy-fallback';
    }
    this.lastProvider = usedProvider;
    this.lastModelUsed = usedModel;
    this.pendingLLMAction = action;

    this.recordActionDecision(action, sso.gameTick, reason);

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
      provider: usedProvider,
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
        prompt,
        systemPrompt: systemMessage || null,
        response: llmResponse,
        reason,
        decisionSource,
        parsedAction: parsed.action,
        policyAuthoritative: Boolean(policyAuthoritative),
        fallbackAction,
        fallbackActionCode,
        strategy: this.sessionStrategy,
        action,
        elapsed,
        provider: usedProvider,
        modelUsed: usedModel,
        gameState: {
          score: sso.gameScore,
          health: sso.avatarHealthPoints,
          tick: sso.gameTick
        }
      });
    }

    return { action, reason, decisionSource, elapsed, provider: usedProvider, modelUsed: usedModel };
  }

  recordActionDecision(action, tick, reason = '') {
    this.stateTracker.recordAction(action, tick);
    const lastDelta = this.stateTracker.actionHistory[this.stateTracker.actionHistory.length - 1];
    this.runLog.push({
      tick,
      action,
      reason,
      scoreDelta: lastDelta ? lastDelta.scoreDelta : 0
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
    this.levelCount++;
    console.log(`[LLMClient] Level ${this.levelCount} ended`);
    console.log(`[LLMClient] Score: ${sso.gameScore}`);
    console.log(`[LLMClient] Winner: ${sso.gameWinner}`);

    // Build the end-of-run summary BEFORE resetting run state
    const summary = this.buildRunSummary(sso);

    // Reset LLM state for next level
    this.pendingLLMAction = null;
    this.llmCallInProgress = false;
    this.lastLLMCallTime = 0;

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
      source: 'llm-client',
      runId: this.runId,
      gameId: this.gameId,
      levelId: this.levelCount,
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

    // Reset run accumulation + history for the next level
    this.runLog = [];
    this.runStartScore = null;
    this.stateTracker.reset();

    // Send acknowledgment
    this.sendMessageWithId(msgId, 'END_DONE');
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
