const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GVGAI_TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-client-traces-'));
process.env.OLLAMA_GUARDRAIL_STATE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'llm-client-guardrail-')),
  'usage-guardrail.json'
);

const LLMClient = require('../lib/llm-client');
const models = require('../lib/models');
const guardrail = require('../lib/usage-guardrail');

test('live LLM client requests full state and frame data for ACT ticks', () => {
  const client = new LLMClient();

  assert.equal(client.initResponseType, 'BOTH');
  assert.equal(client.actResponseType, 'BOTH');
});

test('async ACT response asks Java for BOTH on the next tick', async () => {
  const client = new LLMClient();
  const sent = [];

  client.pendingLLMAction = 'ACTION_RIGHT';
  client.llmCallInProgress = true;
  client.sendMessageWithId = (msgId, message) => {
    sent.push({ msgId, message });
  };

  await client.processMessage(`7#${JSON.stringify({
    phase: 'ACT',
    gameTick: 1,
    gameScore: 0,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  })}`);

  assert.deepEqual(sent, [{ msgId: '7', message: 'ACTION_RIGHT#BOTH' }]);
});

test('authoritative code policy answers ACT ticks without provider latency', async () => {
  const client = new LLMClient();
  const sent = [];
  const emitted = [];

  client.model = 'gemma4:31b';
  client.gameId = 4;
  client.gameName = 'bait';
  client.promptConfig = {
    gameName: 'bait',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'bait-level0',
      authoritative: true,
      actionCodes: {
        U: 'ACTION_UP',
        D: 'ACTION_DOWN',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT'
      },
      keyItype: 7,
      boxItype: 9,
      withKeyAvatarType: 5
    }
  };
  client.sendMessageWithId = (msgId, message) => {
    sent.push({ msgId, message });
  };
  client.startAsyncLLMCall = () => {
    throw new Error('provider path should not run for authoritative policy');
  };
  client.io = {
    emit(event, payload) {
      emitted.push({ event, payload });
    }
  };

  await client.processMessage(`7#${JSON.stringify({
    phase: 'ACT',
    blockSize: 10,
    worldDimension: [50, 60],
    avatarPosition: [20, 10],
    avatarType: 4,
    gameTick: 0,
    gameScore: 0,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_DOWN', 'ACTION_UP'],
    movablePositionsNum: 2,
    movablePositions: [
      [{ position: { x: 20, y: 40 }, itype: 7, category: 6, obsID: 26 }],
      [
        { position: { x: 20, y: 30 }, itype: 9, category: 6, obsID: 19 },
        { position: { x: 30, y: 30 }, itype: 9, category: 6, obsID: 21 }
      ]
    ]
  })}`);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(sent, [{ msgId: '7', message: 'ACTION_DOWN#BOTH' }]);
  assert.equal(client.pendingLLMAction, 'ACTION_DOWN');
  assert.equal(client.runLog.length, 1);
  assert.equal(client.runLog[0].reason, 'approach box puzzle');
  assert.ok(emitted.some(entry => entry.event === 'llm-reasoning' && entry.payload.provider === 'encoded-policy'));
});

test('socket close emits a partial run summary from recorded fallback actions', () => {
  const client = new LLMClient({ synchronousActions: true });
  const events = [];
  client.io = {
    emit(event, payload) {
      events.push({ event, payload });
    }
  };
  client.model = 'gemma3:27b';
  client.sessionStrategy = 'Play safely';
  client.runStartScore = 0;
  client.lastSso = {
    gameScore: 0,
    gameWinner: 'PLAYER_LOSES',
    gameTick: 42
  };

  client.recordActionDecision('ACTION_NIL', 42, 'provider 401');
  client.emitCloseSummary();

  const summaryEvent = events.find(entry => entry.event === 'run-summary');
  assert.ok(summaryEvent);
  assert.equal(summaryEvent.payload.endedBy, 'socket-close');
  assert.equal(summaryEvent.payload.ticks, 42);
  assert.deepEqual(summaryEvent.payload.actions, ['ACTION_NIL']);
});

test('socket close emits a partial run summary from init state before first action', () => {
  const client = new LLMClient({ synchronousActions: true });
  const events = [];
  client.io = {
    emit(event, payload) {
      events.push({ event, payload });
    }
  };
  client.model = 'gemma3:27b';
  client.lastSso = {
    gameScore: 0,
    gameWinner: 'NO_WINNER',
    gameTick: 0
  };

  client.emitCloseSummary();

  const summaryEvent = events.find(entry => entry.event === 'run-summary');
  assert.ok(summaryEvent);
  assert.equal(summaryEvent.payload.endedBy, 'socket-close');
  assert.equal(summaryEvent.payload.ticks, 0);
  assert.deepEqual(summaryEvent.payload.actions, []);
});

test('async mode enforces maxActions with an ABORT and a run summary', async () => {
  const client = new LLMClient({ maxActions: 2 }); // async by default, like marble-run cases
  const sent = [];
  const events = [];
  client.sendMessageWithId = (msgId, message) => sent.push({ msgId, message });
  client.io = { emit: (event, payload) => events.push({ event, payload }) };
  client.model = 'gemma3:27b';
  client.lastSso = { gameScore: 1, gameWinner: 'NO_WINNER', gameTick: 9 };

  client.recordActionDecision('ACTION_LEFT', 3, 'probe left');
  client.recordActionDecision('ACTION_RIGHT', 6, 'probe right');

  await client.processMessage(`9#${JSON.stringify({
    phase: 'ACT',
    gameTick: 9,
    gameScore: 1,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT']
  })}`);

  assert.deepEqual(sent, [{ msgId: '9', message: 'ABORT#BOTH' }]);
  const summaryEvent = events.find(entry => entry.event === 'run-summary');
  assert.ok(summaryEvent, 'run summary is emitted so the eval case resolves without waiting for a timeout');
  assert.deepEqual(summaryEvent.payload.actions, ['ACTION_LEFT', 'ACTION_RIGHT']);
});

test('provider calls use the configured action timeout signal', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1234 });
  let capturedSignal = null;

  global.fetch = async (url, options) => {
    capturedSignal = options.signal;
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'ACTION_UP' } }] };
      }
    };
  };

  try {
    const response = await client.callProvider('ollama-local', 'test-model', [], {});
    assert.equal(response, 'ACTION_UP');
    assert.ok(capturedSignal);
    assert.equal(capturedSignal.aborted, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('preferProviderFallback tries configured OpenRouter fallback before Ollama Cloud', () => {
  const client = new LLMClient({ preferProviderFallback: true });
  const routes = client.buildProviderRoutes(models.resolveModel('gemma3:27b'));

  assert.deepEqual(routes, [
    { provider: 'openrouter', modelId: 'google/gemma-3-27b-it', stage: 'fallback' },
    { provider: 'ollama-cloud', modelId: 'gemma3:27b', stage: 'primary' }
  ]);
});

test('requestLLMAction falls back from legion vLLM through cloud guardrail to OpenRouter', async () => {
  const originalFetch = global.fetch;
  const savedRegistryPath = process.env.FINETUNE_REGISTRY_PATH;
  const savedLegionFallback = process.env.LEGION_FALLBACK_MODEL;
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const savedGuardrailSession = process.env.OLLAMA_GUARDRAIL_SESSION;
  const savedGuardrailState = process.env.OLLAMA_GUARDRAIL_STATE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legion-fallback-test-'));
  const registryPath = path.join(tempDir, 'finetune-models.json');
  const calls = [];

  fs.writeFileSync(registryPath, JSON.stringify({
    models: [{
      id: 'legion-test',
      name: 'Legion Test',
      provider: 'legion-vllm',
      baseModel: 'unsloth/gemma-3-4b-it',
      gameId: 0,
      gameName: 'aliens'
    }]
  }));

  process.env.FINETUNE_REGISTRY_PATH = registryPath;
  process.env.LEGION_FALLBACK_MODEL = 'gemma3:27b';
  process.env.OPENROUTER_API_KEY = 'fallback-key';
  process.env.OLLAMA_GUARDRAIL_SESSION = '1';
  process.env.OLLAMA_GUARDRAIL_STATE = path.join(tempDir, 'guardrail.json');
  models.invalidateFinetunedCache();
  guardrail.resetForTest();

  const client = new LLMClient({ actionTimeoutMs: 1000 });
  client.model = 'legion-test';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = { gameName: 'aliens' };
  client.ollamaCloudCallCount = 1;

  global.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (calls.length === 1) {
      throw new Error('connect ECONNREFUSED');
    }
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'ACTION_RIGHT' } }] };
      }
    };
  };

  try {
    const result = await client.requestLLMAction(JSON.stringify({
      gameTick: 1,
      gameScore: 0,
      availableActions: ['ACTION_LEFT', 'ACTION_RIGHT']
    }));

    assert.equal(result.action, 'ACTION_RIGHT');
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.modelUsed, 'google/gemma-3-27b-it');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.model, 'legion-test');
    assert.equal(calls[1].body.model, 'google/gemma-3-27b-it');
    assert.match(calls[1].url, /openrouter\.ai/);
    assert.equal(calls[1].options.headers.Authorization, 'Bearer fallback-key');
  } finally {
    global.fetch = originalFetch;
    if (savedRegistryPath === undefined) delete process.env.FINETUNE_REGISTRY_PATH;
    else process.env.FINETUNE_REGISTRY_PATH = savedRegistryPath;
    if (savedLegionFallback === undefined) delete process.env.LEGION_FALLBACK_MODEL;
    else process.env.LEGION_FALLBACK_MODEL = savedLegionFallback;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    if (savedGuardrailSession === undefined) delete process.env.OLLAMA_GUARDRAIL_SESSION;
    else process.env.OLLAMA_GUARDRAIL_SESSION = savedGuardrailSession;
    if (savedGuardrailState === undefined) delete process.env.OLLAMA_GUARDRAIL_STATE;
    else process.env.OLLAMA_GUARDRAIL_STATE = savedGuardrailState;
    models.invalidateFinetunedCache();
    guardrail.resetForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('requestLLMAction sends GV1 code tape and maps compact output to GVGAI action', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });
  let capturedBody = null;

  client.model = 'ministral-3:3b';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    systemContent: 'paragraph system prompt should be bypassed',
    gameContent: 'Space invaders variant. Aliens scroll horizontally and drop bombs.',
    llmSettings: { maxTokens: 100, temperature: 0.1 },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      },
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      objectiveCodes: ['KILL_ALL', 'AVOID_HAZARD'],
      ruleCodes: ['ALIGN_SHOOT', 'DODGE_NEAR', 'CLEAR_LOW']
    }
  };

  global.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'U' } }] };
      }
    };
  };

  try {
    const result = await client.requestLLMAction(JSON.stringify({
      blockSize: 10,
      observationGridNum: 30,
      observationGridMaxRow: 11,
      avatarPosition: [160, 100],
      avatarHealthPoints: 100,
      gameScore: 22,
      gameTick: 423,
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
      NPCPositionsNum: 1,
      NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]],
      movablePositionsNum: 1,
      movablePositions: [[{ position: { x: 150, y: 90 }, itype: 6, category: 6 }]]
    }));

    assert.equal(result.action, 'ACTION_USE');
    assert.equal(result.decisionSource, 'compact-exact');
    assert.equal(client.pendingLLMAction, 'ACTION_USE');
    assert.equal(capturedBody.max_tokens, 8);
    assert.equal(capturedBody.temperature, 0.1);
    assert.equal(capturedBody.messages.length, 1);
    assert.match(capturedBody.messages[0].content, /^GV1\n/);
    assert.match(capturedBody.messages[0].content, /D:target=a18,7 dx=\+2 fire=0 dodge=R/);
    assert.match(capturedBody.messages[0].content, /B:R/);
    assert.match(capturedBody.messages[0].content, /ANS=\[N\|L\|R\|U\]\nANS:$/);
    assert.doesNotMatch(capturedBody.messages[0].content, /Space invaders variant|controller|Return exactly/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestLLMAction uses encoded best action when compact output is invalid', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });

  client.model = 'ministral-3:3b';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    llmSettings: { maxTokens: 8, temperature: 0.1 },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      },
      entityCodes: {
        npc: 'a',
        movable: 'b'
      }
    }
  };

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'GV1 A:L,' } }] };
    }
  });

  try {
    const result = await client.requestLLMAction(JSON.stringify({
      blockSize: 10,
      avatarPosition: [160, 100],
      avatarHealthPoints: 100,
      gameScore: 0,
      gameTick: 0,
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
      NPCPositionsNum: 1,
      NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]]
    }));

    assert.equal(result.action, 'ACTION_RIGHT');
    assert.equal(result.decisionSource, 'policy-fallback');
    assert.equal(client.pendingLLMAction, 'ACTION_RIGHT');
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestLLMAction ignores bare prose directions in code mode', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });

  client.model = 'ministral-3:3b';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    llmSettings: { maxTokens: 8, temperature: 0.1 },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      forceActionCode: 'U',
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      },
      entityCodes: {
        npc: 'a',
        movable: 'b'
      }
    }
  };

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'The right lane looks safest, so move right.' } }] };
    }
  });

  try {
    const result = await client.requestLLMAction(JSON.stringify({
      blockSize: 10,
      avatarPosition: [160, 100],
      avatarHealthPoints: 100,
      gameScore: 0,
      gameTick: 0,
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
      NPCPositionsNum: 1,
      NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]]
    }));

    assert.equal(result.action, 'ACTION_USE');
    assert.equal(result.decisionSource, 'policy-fallback');
    assert.equal(client.pendingLLMAction, 'ACTION_USE');
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestLLMAction can let authoritative game code override a valid model action', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });

  client.model = 'gemma4:31b';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    llmSettings: { maxTokens: 8, temperature: 0.1 },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      forceActionCode: 'U',
      authoritative: true,
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      },
      entityCodes: {
        npc: 'a',
        movable: 'b'
      }
    }
  };

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'R' } }] };
    }
  });

  try {
    const result = await client.requestLLMAction(JSON.stringify({
      blockSize: 10,
      avatarPosition: [160, 100],
      avatarHealthPoints: 100,
      gameScore: 0,
      gameTick: 0,
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
      NPCPositionsNum: 1,
      NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]]
    }));

    assert.equal(result.action, 'ACTION_USE');
    assert.equal(result.decisionSource, 'policy-override');
    assert.equal(client.pendingLLMAction, 'ACTION_USE');
  } finally {
    global.fetch = originalFetch;
  }
});

// --- Macro-action plan executor ---------------------------------------------

function actPayload(overrides = {}) {
  return JSON.stringify({
    phase: 'ACT',
    gameTick: 1,
    gameScore: 0,
    avatarHealthPoints: 100,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    ...overrides
  });
}

function macroClient(macroActions = { enabled: true, ticksPerStep: 1 }) {
  const client = new LLMClient();
  client.promptConfig = { gameName: 'aliens', macroActions };
  client.startAsyncLLMCall = () => {};
  client.llmCallInProgress = true; // keep the refill gate closed unless a test opens it
  return client;
}

const nextTickDrain = () => new Promise(resolve => setImmediate(resolve));

test('plan queue is consumed one step per ACT tick, then repeats the last step', async () => {
  const client = macroClient();
  const sent = [];
  client.sendMessageWithId = (msgId, message) => sent.push(message);

  client.planQueue = ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_USE'];
  client.planLength = 3;

  for (let tick = 1; tick <= 5; tick++) {
    await client.processMessage(`${tick}#${actPayload({ gameTick: tick })}`);
    await nextTickDrain();
  }

  assert.deepEqual(sent, [
    'ACTION_LEFT#BOTH',
    'ACTION_LEFT#BOTH',
    'ACTION_USE#BOTH',
    'ACTION_USE#BOTH', // exhausted queue repeats the last step (classic behavior)
    'ACTION_USE#BOTH'
  ]);
  assert.equal(client.planStep, 3);
});

test('ticksPerStep holds each plan step for N ticks before advancing', async () => {
  const client = macroClient({ enabled: true, ticksPerStep: 2 });
  const sent = [];
  client.sendMessageWithId = (msgId, message) => sent.push(message);

  client.planQueue = ['ACTION_LEFT', 'ACTION_USE'];
  client.planLength = 2;

  for (let tick = 1; tick <= 4; tick++) {
    await client.processMessage(`${tick}#${actPayload({ gameTick: tick })}`);
    await nextTickDrain();
  }

  assert.deepEqual(sent, [
    'ACTION_LEFT#BOTH',
    'ACTION_LEFT#BOTH',
    'ACTION_USE#BOTH',
    'ACTION_USE#BOTH'
  ]);
});

test('refill fires only when the queue is low and the interval elapsed', async () => {
  const client = macroClient();
  const calls = [];
  client.llmCallInProgress = false;
  client.lastLLMCallTime = 0;
  client.startAsyncLLMCall = () => calls.push('call');
  client.sendMessageWithId = () => {};

  client.planQueue = ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_USE'];
  await client.processMessage(`1#${actPayload()}`);
  await nextTickDrain();
  assert.equal(calls.length, 0, 'no refill while the queue is full');

  client.planQueue = ['ACTION_USE'];
  await client.processMessage(`2#${actPayload({ gameTick: 2 })}`);
  await nextTickDrain();
  assert.equal(calls.length, 1, 'refill once the queue is low');

  client.planQueue = [];
  client.lastLLMCallTime = Date.now(); // interval not elapsed
  await client.processMessage(`3#${actPayload({ gameTick: 3 })}`);
  await nextTickDrain();
  assert.equal(calls.length, 1, 'time floor still applies');
});

test('plan is invalidated on health drop, stale age, and loop detection', async () => {
  const scenarios = [
    { setup: c => { c.planHealthAtSet = 100; }, payload: { avatarHealthPoints: 50 } },
    { setup: c => { c.planSetTick = 0; }, payload: { gameTick: 31 } },
    { setup: c => { c.stateTracker.detectLoop = () => 'stuck warning'; }, payload: {} }
  ];

  for (const scenario of scenarios) {
    const client = macroClient();
    client.sendMessageWithId = () => {};
    client.planQueue = ['ACTION_LEFT', 'ACTION_USE'];
    client.planLength = 2;
    scenario.setup(client);

    await client.processMessage(`1#${actPayload(scenario.payload)}`);
    await nextTickDrain();

    assert.deepEqual(client.planQueue, []);
    assert.equal(client.planLength, 0);
  }
});

test('handleEnd clears the plan queue so plans never leak across levels', async () => {
  const client = macroClient();
  client.planQueue = ['ACTION_LEFT'];
  client.planLength = 1;
  client.planStep = 2;

  await client.handleEnd({ gameScore: 5, gameWinner: 'PLAYER_WINS', gameTick: 90 }, '9');

  assert.deepEqual(client.planQueue, []);
  assert.equal(client.planLength, 0);
  assert.equal(client.planStep, 0);
});

test('handleEnd repeats failed levels and advances only after a win', async () => {
  const failedRun = new LLMClient();
  const failedReplies = [];
  failedRun.levelCount = 2;
  failedRun.sendMessageWithId = (msgId, message) => failedReplies.push({ msgId, message });

  await failedRun.handleEnd({ gameScore: 0, gameWinner: 'PLAYER_LOSES', gameTick: 40 }, 'loss');

  assert.deepEqual(failedReplies, [{ msgId: 'loss', message: '2' }]);
  assert.equal(failedRun.levelCount, 2);

  const winningRun = new LLMClient();
  const winningReplies = [];
  winningRun.levelCount = 2;
  winningRun.sendMessageWithId = (msgId, message) => winningReplies.push({ msgId, message });

  await winningRun.handleEnd({ gameScore: 12, gameWinner: 'PLAYER_WINS', gameTick: 80 }, 'win');

  assert.deepEqual(winningReplies, [{ msgId: 'win', message: '3' }]);
  assert.equal(winningRun.levelCount, 3);
});

test('authoritative code policy bypasses a non-empty plan queue', async () => {
  const client = new LLMClient();
  const sent = [];
  client.model = 'gemma4:31b';
  client.gameId = 4;
  client.gameName = 'bait';
  client.promptConfig = {
    gameName: 'bait',
    macroActions: { enabled: true },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'bait-level0',
      authoritative: true,
      actionCodes: { U: 'ACTION_UP', D: 'ACTION_DOWN', L: 'ACTION_LEFT', R: 'ACTION_RIGHT' },
      keyItype: 7,
      boxItype: 9,
      withKeyAvatarType: 5
    }
  };
  client.sendMessageWithId = (msgId, message) => sent.push(message);
  client.planQueue = ['ACTION_LEFT', 'ACTION_LEFT'];
  client.planLength = 2;

  await client.processMessage(`7#${JSON.stringify({
    phase: 'ACT',
    blockSize: 10,
    worldDimension: [50, 60],
    avatarPosition: [20, 10],
    avatarType: 4,
    gameTick: 0,
    gameScore: 0,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_DOWN', 'ACTION_UP'],
    movablePositionsNum: 2,
    movablePositions: [
      [{ position: { x: 20, y: 40 }, itype: 7, category: 6, obsID: 26 }],
      [
        { position: { x: 20, y: 30 }, itype: 9, category: 6, obsID: 19 },
        { position: { x: 30, y: 30 }, itype: 9, category: 6, obsID: 21 }
      ]
    ]
  })}`);
  await nextTickDrain();

  assert.deepEqual(sent, ['ACTION_DOWN#BOTH']);
  assert.deepEqual(client.planQueue, ['ACTION_LEFT', 'ACTION_LEFT'], 'queue untouched by policy path');
});

test('requestLLMAction queues a PLAN response and emits plan metadata', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });
  const emitted = [];

  client.model = 'gemma3:27b';
  client.gameId = 0;
  client.levelCount = 0;
  client.sessionStrategy = 'rush left and shoot';
  client.promptConfig = {
    gameName: 'aliens',
    llmSettings: { maxTokens: 100, temperature: 0.7 },
    actionAliases: { ACTION_USE: 'SHOOT' },
    macroActions: { enabled: true, maxSteps: 4 }
  };
  client.io = { emit: (event, payload) => emitted.push({ event, payload }) };

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'REASON: rushing left as asked.\nPLAN: LEFT, LEFT, SHOOT' } }] };
    }
  });

  try {
    const result = await client.requestLLMAction(actPayload({ gameTick: 10 }));

    assert.equal(result.action, 'ACTION_LEFT');
    assert.deepEqual(client.planQueue, ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_USE']);
    assert.equal(client.planLength, 3);
    assert.equal(client.planSetTick, 10);
    assert.equal(client.planHealthAtSet, 100);

    const reasoning = emitted.find(e => e.event === 'llm-reasoning');
    assert.ok(reasoning);
    assert.deepEqual(reasoning.payload.plan, ['ACTION_LEFT', 'ACTION_LEFT', 'SHOOT'], 'display aliases applied');
    assert.equal(reasoning.payload.planLength, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('MACRO_ACTIONS_DISABLED=1 degrades a PLAN response to a single action', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });

  client.model = 'gemma3:27b';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    macroActions: { enabled: true }
  };

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: 'REASON: go.\nPLAN: LEFT, LEFT, SHOOT' } }] };
    }
  });

  process.env.MACRO_ACTIONS_DISABLED = '1';
  try {
    const result = await client.requestLLMAction(actPayload());

    assert.equal(result.action, 'ACTION_LEFT');
    assert.equal(client.pendingLLMAction, 'ACTION_LEFT');
    assert.deepEqual(client.planQueue, [], 'kill switch keeps the queue empty');
  } finally {
    delete process.env.MACRO_ACTIONS_DISABLED;
    global.fetch = originalFetch;
  }
});

test('exhaustAction wait stands still instead of repeating the last step', async () => {
  const client = macroClient({ enabled: true, ticksPerStep: 1, exhaustAction: 'wait' });
  const sent = [];
  client.sendMessageWithId = (msgId, message) => sent.push(message);

  client.planQueue = ['ACTION_LEFT'];
  client.planLength = 1;

  for (let tick = 1; tick <= 3; tick++) {
    await client.processMessage(`${tick}#${actPayload({ gameTick: tick })}`);
    await nextTickDrain();
  }

  assert.deepEqual(sent, [
    'ACTION_LEFT#BOTH',
    'ACTION_NIL#BOTH', // exhausted: wait, don't march
    'ACTION_NIL#BOTH'
  ]);
});

test('game-state emit carries live planStep and planLength', async () => {
  const client = macroClient();
  const emitted = [];
  client.sendMessageWithId = () => {};
  client.io = { emit: (event, payload) => emitted.push({ event, payload }) };

  client.planQueue = ['ACTION_LEFT', 'ACTION_USE'];
  client.planLength = 2;

  await client.processMessage(`1#${actPayload()}`);
  await nextTickDrain();

  const gameState = emitted.find(e => e.event === 'game-state');
  assert.ok(gameState);
  assert.equal(gameState.payload.planStep, 1);
  assert.equal(gameState.payload.planLength, 2);
});

test('recordActionDecision stores pruned SSO in runLog when provided', () => {
  const client = new LLMClient();
  const fixture = require('./fixtures/finetune/sso-tick.json');

  client.recordActionDecision('ACTION_UP', 3, 'test reason', fixture);

  assert.equal(client.runLog.length, 1);
  assert.equal(client.runLog[0].action, 'ACTION_UP');
  assert.equal(client.runLog[0].sso.gameTick, fixture.gameTick);
  assert.equal(client.runLog[0].sso.imageArray, undefined, 'screenshot bytes pruned');
});

test('recordActionDecision stores null sso when omitted', () => {
  const client = new LLMClient();

  client.recordActionDecision('ACTION_UP', 3);

  assert.equal(client.runLog[0].sso, null);
});
