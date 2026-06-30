const assert = require('node:assert/strict');
const test = require('node:test');

const LLMClient = require('../lib/llm-client');

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

  client.model = 'google/gemini-2.5-flash';
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
  client.model = 'gpt-oss:120b';
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
  client.model = 'gpt-oss:120b';
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

test('requestLLMAction sends GV1 code tape and maps compact output to GVGAI action', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });
  let capturedBody = null;

  client.model = 'smollm2:135m';
  client.gameId = 0;
  client.levelCount = 0;
  client.promptConfig = {
    gameName: 'aliens',
    systemContent: 'paragraph system prompt should be bypassed',
    gameContent: 'Space invaders variant. Aliens scroll horizontally and drop bombs.',
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

  client.model = 'smollm2:135m';
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

test('requestLLMAction can let authoritative game code override a valid model action', async () => {
  const originalFetch = global.fetch;
  const client = new LLMClient({ actionTimeoutMs: 1000 });

  client.model = 'google/gemini-2.5-flash';
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
