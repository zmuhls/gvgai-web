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
  'OLLAMA_GUARDRAIL_DISABLED',
  'OPENROUTER_API_KEY'
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

test('a guardrail block uses the OpenRouter fallback key when a fallback slug exists', async () => {
  await withCleanEnv(async () => {
    process.env.OLLAMA_GUARDRAIL_SESSION = '3';
    process.env.OPENROUTER_API_KEY = 'fallback-key';
    const originalFetch = global.fetch;
    const calls = [];
    const client = new LLMClient({ actionTimeoutMs: 1000 });
    client.model = 'gemma3:27b';
    client.gameId = 0;
    client.levelCount = 0;
    client.promptConfig = { gameName: 'aliens' };
    client.ollamaCloudCallCount = 3; // session cap already spent

    global.fetch = async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
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
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /openrouter\.ai/);
      assert.equal(calls[0].options.headers.Authorization, 'Bearer fallback-key');
      assert.equal(calls[0].body.model, 'google/gemma-3-27b-it');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
