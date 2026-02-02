const net = require('net');
const config = require('../config.json');
const { buildPrompt } = require('./state-converter');
const { parseAction } = require('./response-parser');
const promptStore = require('./prompt-store');

class LLMClient {
  constructor() {
    this.socket = null;
    // Load API key from environment (optional for local Ollama)
    this.apiKey = process.env.OPENROUTER_API_KEY || null;
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

  async connect(port, model, io, gameId, gameName) {
    this.model = model;
    this.io = io;
    this.gameActive = true;
    this.gameId = gameId != null ? gameId : null;
    this.gameName = gameName || 'unknown';
    this.promptConfig = promptStore.resolveGamePromptConfig(this.gameId, 0);
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
        this.gameActive = false;
        this._triggerSessionEnd();
      });

      // Connect AFTER event handlers are set up
      this.socket.connect(port, 'localhost', () => {
        console.log(`[LLMClient] Connected to GVGAI socket on port ${port}`);
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
        // CRITICAL: Respond IMMEDIATELY with the specific message ID
        const actionToSend = this.pendingLLMAction || 'ACTION_NIL';
        this.sendMessageWithId(msgId, `${actionToSend}#IMAGE`);

        // Async processing after response sent (don't block)
        setImmediate(() => {
          // Parse game state and emit to frontend for UI updates
          try {
            const sso = JSON.parse(jsonPayload);
            if (this.io) {
              this.io.emit('game-state', {
                score: sso.gameScore,
                health: sso.avatarHealthPoints,
                maxHealth: sso.avatarMaxHealthPoints,
                tick: sso.gameTick,
                action: actionToSend
              });
            }
          } catch (error) {
            console.error('[LLMClient] Error parsing game state for UI update:', error.message);
          }

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
          JSON.parse(jsonPayload);  // Validate JSON
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
        this.sendMessageWithId(msgId, 'ACTION_NIL#IMAGE');
      }
    }
  }

  async handleInit(msgId) {
    console.log('[LLMClient] Game initializing...');
    // Reload prompt config for current level (picks up level-specific progression context)
    if (this.gameId != null) {
      this.promptConfig = promptStore.resolveGamePromptConfig(this.gameId, this.levelCount);
      if (this.promptConfig && !this.promptConfig.gameName) {
        this.promptConfig.gameName = this.gameName;
      }
    }
    // Send INIT_DONE with BOTH type to enable screenshots
    // Format: messageId#INIT_DONE#BOTH
    this.sendMessageWithId(msgId, 'INIT_DONE#BOTH');
  }

  async startAsyncLLMCall(jsonPayload) {
    this.llmCallInProgress = true;
    this.lastLLMCallTime = Date.now();

    try {
      // Parse JSON (this is slow but happens async)
      const sso = JSON.parse(jsonPayload);

      // Build prompt from game state using dashboard-configured layers (or legacy fallback)
      const { systemMessage, userMessage } = buildPrompt(sso, this.promptConfig);
      const prompt = userMessage; // For logging/broadcasting

      // Build messages array (system + user if dashboard config exists)
      const messages = [];
      if (systemMessage) {
        messages.push({ role: 'system', content: systemMessage });
      }
      messages.push({ role: 'user', content: userMessage });

      // Use per-game LLM settings if configured, otherwise defaults
      const settings = this.promptConfig?.llmSettings || {};

      // Call LLM API
      const startTime = Date.now();
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        headers['HTTP-Referer'] = 'https://github.com/yourusername/gvgai-llm';
        headers['X-Title'] = 'GVGAI LLM Agent';
      }

      // Route to Ollama for local models (no slash), OpenRouter for cloud models (org/model)
      const apiUrl = this.model.includes('/') ? config.openrouter.apiUrl : config.ollama.apiUrl;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: settings.maxTokens || 100,
          temperature: settings.temperature !== undefined ? settings.temperature : 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (this.io) {
          this.io.emit('llm-error', { status: response.status, message: errorText });
        }
        throw new Error(`OpenRouter API error: ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const llmResponse = data.choices[0]?.message?.content || '';
      const elapsed = Date.now() - startTime;

      // Parse action from LLM response
      const action = parseAction(llmResponse);

      // Store action for next tick
      this.pendingLLMAction = action;

      console.log(`[LLMClient] LLM completed (${elapsed}ms): ${action}`);

      // Broadcast to frontend
      if (this.io) {
        this.io.emit('llm-reasoning', {
          prompt,
          systemPrompt: systemMessage || null,
          response: llmResponse,
          action,
          elapsed,
          gameState: {
            score: sso.gameScore,
            health: sso.avatarHealthPoints,
            tick: sso.gameTick
          }
        });
      }
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
    }

    // Send acknowledgment
    this.sendMessageWithId(msgId, 'END_DONE');
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
