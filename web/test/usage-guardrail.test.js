const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');

const guardrail = require('../lib/usage-guardrail');
const LLMClient = require('../lib/llm-client');

const GUARDRAIL_ENV = [
  'OLLAMA_GUARDRAIL_HOURLY',
  'OLLAMA_GUARDRAIL_DAILY',
  'OLLAMA_GUARDRAIL_SESSION',
  'OLLAMA_GUARDRAIL_DISABLED'
];

function withCleanEnv(fn) {
  const saved = {};
  for (const key of GUARDRAIL_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OLLAMA_GUARDRAIL_STATE = path.join(os.tmpdir(), `guardrail-test-${process.pid}.json`);
  guardrail.resetForTest();
  try {
    return fn();
  } finally {
    for (const key of GUARDRAIL_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.OLLAMA_GUARDRAIL_STATE;
    guardrail.resetForTest();
  }
}

test('admits calls under all caps and counts them', () => {
  withCleanEnv(() => {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(guardrail.admitOllamaCall(i), { allowed: true });
    }
  });
});

test('session cap blocks without counting against global buckets', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_SESSION = '3';
    const verdict = guardrail.admitOllamaCall(3);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scope, 'session');
    // a fresh session is still admitted — the block was session-scoped
    assert.equal(guardrail.admitOllamaCall(0).allowed, true);
  });
});

test('hourly cap blocks after the configured number of calls', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_HOURLY = '2';
    assert.equal(guardrail.admitOllamaCall(0).allowed, true);
    assert.equal(guardrail.admitOllamaCall(0).allowed, true);
    const verdict = guardrail.admitOllamaCall(0);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scope, 'hourly');
  });
});

test('hour and day buckets rotate with the clock', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_HOURLY = '1';
    process.env.OLLAMA_GUARDRAIL_DAILY = '3';
    const hour1 = new Date('2026-07-05T10:30:00Z');
    const hour2 = new Date('2026-07-05T11:05:00Z');
    const hour3 = new Date('2026-07-05T12:05:00Z');
    const hour4 = new Date('2026-07-05T13:05:00Z');
    const nextDay = new Date('2026-07-06T00:10:00Z');

    assert.equal(guardrail.admitOllamaCall(0, hour1).allowed, true);
    assert.equal(guardrail.admitOllamaCall(0, hour1).allowed, false, 'hourly cap hit');
    assert.equal(guardrail.admitOllamaCall(0, hour2).allowed, true, 'new hour resets hourly bucket');
    assert.equal(guardrail.admitOllamaCall(0, hour3).allowed, true, 'third call fills the daily bucket');
    const daily = guardrail.admitOllamaCall(0, hour4);
    assert.equal(daily.allowed, false, 'daily cap hit even in a fresh hour');
    assert.equal(daily.scope, 'daily');
    assert.equal(guardrail.admitOllamaCall(0, nextDay).allowed, true, 'new day resets daily bucket');
  });
});

test('kill switch admits everything', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_DISABLED = '1';
    process.env.OLLAMA_GUARDRAIL_SESSION = '1';
    assert.equal(guardrail.admitOllamaCall(9999).allowed, true);
  });
});

test('a guardrail block skips the OpenRouter fallback and surfaces llm-error', async () => {
  await withCleanEnv(async () => {
    process.env.OLLAMA_GUARDRAIL_SESSION = '3';
    const originalFetch = global.fetch;
    const events = [];
    const client = new LLMClient({ actionTimeoutMs: 1000 });
    client.model = 'gemma3:27b'; // catalog entry WITH an OpenRouter fallback
    client.gameId = 0;
    client.levelCount = 0;
    client.promptConfig = { gameName: 'aliens' };
    client.ollamaCloudCallCount = 3; // session cap already spent
    client.io = { emit: (event, payload) => events.push({ event, payload }) };

    global.fetch = async () => {
      throw new Error('no provider call should be made when the guardrail blocks');
    };

    try {
      await assert.rejects(
        () => client.requestLLMAction(JSON.stringify({
          gameTick: 1,
          gameScore: 0,
          availableActions: ['ACTION_LEFT', 'ACTION_RIGHT']
        })),
        /usage guardrail/
      );
      const errorEvent = events.find(e => e.event === 'llm-error');
      assert.ok(errorEvent, 'llm-error emitted');
      assert.match(errorEvent.payload.message, /usage guardrail/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
