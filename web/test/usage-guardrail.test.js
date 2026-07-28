const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guardrail = require('../lib/usage-guardrail');
const LLMClient = require('../lib/llm-client');
let stateFileSequence = 0;

const GUARDRAIL_ENV = [
  'MODEL_GUARDRAIL_HOURLY',
  'MODEL_GUARDRAIL_DAILY',
  'MODEL_GUARDRAIL_MONTHLY',
  'MODEL_GUARDRAIL_SESSION',
  'MODEL_GUARDRAIL_CADAVRE_HOURLY',
  'MODEL_GUARDRAIL_CADAVRE_DAILY',
  'MODEL_GUARDRAIL_CADAVRE_MONTHLY',
  'MODEL_GUARDRAIL_DISABLED',
  'MODEL_GUARDRAIL_STATE',
  'OLLAMA_GUARDRAIL_HOURLY',
  'OLLAMA_GUARDRAIL_DAILY',
  'OLLAMA_GUARDRAIL_MONTHLY',
  'OLLAMA_GUARDRAIL_SESSION',
  'OLLAMA_GUARDRAIL_CADAVRE_HOURLY',
  'OLLAMA_GUARDRAIL_CADAVRE_DAILY',
  'OLLAMA_GUARDRAIL_CADAVRE_MONTHLY',
  'OLLAMA_GUARDRAIL_DISABLED',
  'OLLAMA_GUARDRAIL_STATE',
  'RAILWAY_VOLUME_MOUNT_PATH',
  'OPENROUTER_API_KEY'
];

function withCleanEnv(fn) {
  const saved = {};
  for (const key of GUARDRAIL_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const stateFile = path.join(
    os.tmpdir(),
    `guardrail-test-${process.pid}-${stateFileSequence++}.json`
  );
  process.env.MODEL_GUARDRAIL_STATE = stateFile;
  guardrail.resetForTest();
  const restore = () => {
    for (const key of GUARDRAIL_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    guardrail.resetForTest();
    fs.rmSync(stateFile, { force: true });
  };
  try {
    const result = fn();
    if (result && typeof result.finally === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test('admits calls under all caps and counts them', () => {
  withCleanEnv(() => {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(guardrail.admitOllamaCall(i), { allowed: true });
    }
  });
});

test('safe defaults include a persistent monthly ceiling', () => {
  withCleanEnv(() => {
    assert.deepEqual(guardrail.getLimits(), {
      hourly: 20,
      daily: 30,
      monthly: 100,
      session: 20
    });
    assert.deepEqual(guardrail.getStatus().cadavreReserve.limits, {
      hourly: 5,
      daily: 10,
      monthly: 25
    });
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

test('monthly cap survives day rotation and resets with the month', () => {
  withCleanEnv(() => {
    process.env.MODEL_GUARDRAIL_HOURLY = '10';
    process.env.MODEL_GUARDRAIL_DAILY = '10';
    process.env.MODEL_GUARDRAIL_MONTHLY = '2';
    const july1 = new Date('2026-07-05T10:30:00Z');
    const july2 = new Date('2026-07-06T10:30:00Z');
    const august = new Date('2026-08-01T00:10:00Z');

    assert.equal(guardrail.admitRemoteCall('ollama-cloud', 0, july1).allowed, true);
    assert.equal(guardrail.admitRemoteCall('openrouter', 0, july2).allowed, true);
    const monthly = guardrail.admitRemoteCall('openrouter', 0, july2);
    assert.equal(monthly.allowed, false);
    assert.equal(monthly.scope, 'monthly');
    assert.equal(guardrail.admitRemoteCall('openrouter', 0, august).allowed, true);
  });
});

test('Cadavre has a bounded reserve after general traffic exhausts the global cap', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_HOURLY = '1';
    process.env.OLLAMA_GUARDRAIL_DAILY = '1';
    process.env.OLLAMA_GUARDRAIL_CADAVRE_HOURLY = '2';
    process.env.OLLAMA_GUARDRAIL_CADAVRE_DAILY = '2';
    const now = new Date('2026-07-27T06:30:00Z');

    assert.deepEqual(guardrail.admitOllamaCall(0, now), { allowed: true });
    assert.equal(guardrail.admitOllamaCall(0, now).allowed, false);
    assert.deepEqual(
      guardrail.admitOllamaCall(0, now, { consumer: 'cadavre' }),
      { allowed: true, reserve: true }
    );
    assert.deepEqual(
      guardrail.admitOllamaCall(0, now, { consumer: 'cadavre' }),
      { allowed: true, reserve: true }
    );
    const exhausted = guardrail.admitOllamaCall(0, now, { consumer: 'cadavre' });
    assert.equal(exhausted.allowed, false);
    assert.equal(exhausted.scope, 'hourly');
  });
});

test('background Cadavre warmups cannot spend the user reserve', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_HOURLY = '1';
    process.env.OLLAMA_GUARDRAIL_DAILY = '1';
    const now = new Date('2026-07-27T07:30:00Z');

    assert.equal(guardrail.admitOllamaCall(0, now).allowed, true);
    const blocked = guardrail.admitOllamaCall(0, now, {
      consumer: 'cadavre',
      allowReserve: false
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.scope, 'hourly');
  });
});

test('kill switch admits everything', () => {
  withCleanEnv(() => {
    process.env.OLLAMA_GUARDRAIL_DISABLED = '1';
    process.env.OLLAMA_GUARDRAIL_SESSION = '1';
    assert.equal(guardrail.admitOllamaCall(9999).allowed, true);
  });
});

test('Ollama Cloud and OpenRouter share one remote-provider budget', () => {
  withCleanEnv(() => {
    process.env.MODEL_GUARDRAIL_HOURLY = '2';
    const now = new Date();

    assert.equal(guardrail.admitRemoteCall('ollama-cloud', 0, now).allowed, true);
    assert.equal(guardrail.admitRemoteCall('openrouter', 0, now).allowed, true);
    const blocked = guardrail.admitRemoteCall('openrouter', 0, now);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.scope, 'hourly');
    assert.deepEqual(guardrail.getStatus().providers.hour, {
      'ollama-cloud': 1,
      openrouter: 1
    });
  });
});

test('Railway deployments persist counters on the mounted volume', () => {
  withCleanEnv(() => {
    delete process.env.MODEL_GUARDRAIL_STATE;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/data';
    assert.equal(
      guardrail._private.statePath(),
      '/data/model-usage-guardrail.json'
    );
  });
});

test('remote calls fail closed when the counter state cannot be persisted', () => {
  withCleanEnv(() => {
    process.env.MODEL_GUARDRAIL_STATE = os.tmpdir();
    guardrail.resetForTest();

    const verdict = guardrail.admitRemoteCall('openrouter');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.scope, 'persistence');
    assert.equal(guardrail.getStatus().persistence.healthy, false);
  });
});

test('a guardrail block ends the request before a paid fallback', async () => {
  await withCleanEnv(async () => {
    process.env.MODEL_GUARDRAIL_SESSION = '3';
    process.env.OPENROUTER_API_KEY = 'fallback-key';
    const originalFetch = global.fetch;
    const calls = [];
    const client = new LLMClient({ actionTimeoutMs: 1000 });
    client.model = 'gemma3:27b';
    client.gameId = 0;
    client.levelCount = 0;
    client.promptConfig = { gameName: 'aliens' };
    client.remoteProviderCallCount = 3; // session cap already spent

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
      await assert.rejects(
        client.requestLLMAction(JSON.stringify({
          gameTick: 1,
          gameScore: 0,
          availableActions: ['ACTION_LEFT', 'ACTION_RIGHT']
        })),
        /usage guardrail/
      );
      assert.equal(calls.length, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
