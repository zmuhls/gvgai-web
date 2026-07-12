const assert = require('node:assert/strict');
const test = require('node:test');

const usageGuardrail = require('../lib/usage-guardrail');
const { _private } = require('../routes/cadavre');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.afterEach(() => {
  _private.resetForTest();
});

test('cadavre route keeps only valid, bounded chat messages', () => {
  const messages = _private.cleanMessages([
    { role: 'system', content: 'rules' },
    { role: 'tool', content: 'becomes user' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'x'.repeat(10000) }
  ]);

  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { role: 'system', content: 'rules' });
  assert.deepEqual(messages[1], { role: 'user', content: 'becomes user' });
  assert.equal(messages[2].content.length, 9000);
});

test('cadavre route rejects oversized aggregate prompts', () => {
  assert.throws(
    () => _private.cleanMessages(Array.from({ length: 3 }, () => ({
      role: 'user',
      content: 'x'.repeat(9000)
    }))),
    (error) => error.status === 413 && /24000-character request limit/.test(error.message)
  );
});

test('cadavre route resolves route-aware models only through server configuration', () => {
  const previousEndpoint = process.env.CADAVRE_ENDPOINT;
  const previousModel = process.env.CADAVRE_MODEL;
  try {
    process.env.CADAVRE_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
    delete process.env.CADAVRE_MODEL;

    const legion = _private.resolveRouteModel('legion:exquisite-corpse');
    assert.equal(legion.provider, 'legion-vllm');
    assert.equal(legion.model, 'exquisite-corpse');
    assert.equal(legion.apiUrl, process.env.CADAVRE_ENDPOINT);
    assert.throws(
      () => _private.resolveRouteModel('https://other.example/v1/chat/completions'),
      /legion:<model> or ollama:<model>/
    );
    assert.throws(
      () => _private.resolveRouteModel('other:model'),
      /legion:<model> or ollama:<model>/
    );
  } finally {
    restoreEnv('CADAVRE_ENDPOINT', previousEndpoint);
    restoreEnv('CADAVRE_MODEL', previousModel);
  }
});

test('cadavre route accepts its legacy server alias as the configured Legion adapter', () => {
  const previousEndpoint = process.env.CADAVRE_ENDPOINT;
  const previousModel = process.env.CADAVRE_MODEL;
  try {
    process.env.CADAVRE_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
    process.env.CADAVRE_MODEL = 'adapter-v2';
    const candidate = _private.resolveRouteModel('cadavre-server');
    assert.equal(candidate.id, 'legion:adapter-v2');
    assert.equal(candidate.model, 'adapter-v2');
  } finally {
    restoreEnv('CADAVRE_ENDPOINT', previousEndpoint);
    restoreEnv('CADAVRE_MODEL', previousModel);
  }
});

test('cadavre route derives provider discovery and native Ollama endpoints', () => {
  assert.equal(
    _private.modelsUrl('https://models.example/v1/chat/completions?unused=1'),
    'https://models.example/v1/models'
  );
  assert.equal(
    _private.ollamaChatUrl('https://ollama.example/v1/chat/completions'),
    'https://ollama.example/api/chat'
  );
});

test('cadavre catalog returns the tuned adapter and allowed Ollama models without connection data', async () => {
  const originalFetch = global.fetch;
  const previousEndpoint = process.env.CADAVRE_ENDPOINT;
  const previousOllamaKey = process.env.OLLAMA_API_KEY;
  const previousCloudKey = process.env.OLLAMA_CLOUD_API_KEY;
  const calls = [];
  try {
    process.env.CADAVRE_ENDPOINT = 'https://legion.example/v1/chat/completions';
    process.env.OLLAMA_API_KEY = 'catalog-test-token';
    delete process.env.OLLAMA_CLOUD_API_KEY;
    global.fetch = async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization || '' });
      const data = url.startsWith('https://legion.example')
        ? [{ id: 'exquisite-corpse' }, { id: 'base-model' }]
        : [
          { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
          { id: 'gemma3:4b', name: 'Gemma 3 4B' },
          { id: 'gemma4:31b', name: 'Gemma 4 31B' },
          { id: 'kimi-k2.5', name: 'Kimi K2.5' },
          { id: 'kimi-k2.6', name: 'Kimi K2.6' },
          { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
          { id: 'minimax-m3', name: 'MiniMax M3' },
          { id: 'ministral-3:3b', name: 'Ministral 3 3B' },
          { id: 'ministral-3:8b', name: 'Ministral 3 8B' },
          { id: 'ministral-3:14b', name: 'Ministral 3 14B' },
          { id: 'qwen3.5:397b', name: 'Qwen 3.5 397B' },
          { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
          { id: 'mistral-large-3:675b' }
        ];
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const catalog = await _private.buildModelCatalog();
    assert.equal(catalog.default, 'legion:exquisite-corpse');
    assert.equal(catalog.defaultModel, 'legion:exquisite-corpse');
    assert.deepEqual(catalog.models.map(({ id }) => id), [
      'legion:exquisite-corpse',
      'ollama:deepseek-v3.2',
      'ollama:deepseek-v4-flash',
      'ollama:gemini-3-flash-preview',
      'ollama:gemma3:4b',
      'ollama:gemma4:31b',
      'ollama:kimi-k2.5',
      'ollama:kimi-k2.6',
      'ollama:minimax-m2.7',
      'ollama:minimax-m3',
      'ollama:ministral-3:14b',
      'ollama:qwen3.5:397b',
      'ollama:qwen3-coder-next'
    ]);
    assert.equal(catalog.models[0].available, true);
    assert.deepEqual(catalog.models.map(({ model }) => model), [
      'exquisite-corpse',
      'deepseek-v3.2',
      'deepseek-v4-flash',
      'gemini-3-flash-preview',
      'gemma3:4b',
      'gemma4:31b',
      'kimi-k2.5',
      'kimi-k2.6',
      'minimax-m2.7',
      'minimax-m3',
      'ministral-3:14b',
      'qwen3.5:397b',
      'qwen3-coder-next'
    ]);
    assert.match(catalog.models[1].label, /Ollama Cloud/);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:deepseek-v4-pro'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:mistral-large-3:675b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:ministral-3:3b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:ministral-3:8b'), false);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ url }) => url.endsWith('/v1/models')));
    assert.ok(calls.some(({ url, authorization }) =>
      url.startsWith('https://ollama.com/') && authorization === 'Bearer catalog-test-token'));
    const serialized = JSON.stringify(catalog);
    assert.doesNotMatch(serialized, /catalog-test-token|https:\/\//);
  } finally {
    global.fetch = originalFetch;
    restoreEnv('CADAVRE_ENDPOINT', previousEndpoint);
    restoreEnv('OLLAMA_API_KEY', previousOllamaKey);
    restoreEnv('OLLAMA_CLOUD_API_KEY', previousCloudKey);
  }
});

test('cadavre Ollama calls use native chat with thinking disabled and the shared guardrail', async () => {
  const originalFetch = global.fetch;
  const originalAdmit = usageGuardrail.admitOllamaCall;
  let guardrailCalls = 0;
  let guardrailSessionCount = null;
  let request;
  try {
    usageGuardrail.admitOllamaCall = (sessionCount) => {
      guardrailCalls += 1;
      guardrailSessionCount = sessionCount;
      return { allowed: true };
    };
    global.fetch = async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ message: { content: 'blue window' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const result = await _private.callCandidate({
      id: 'ollama:gemma4:latest',
      provider: 'ollama-cloud',
      apiUrl: 'https://ollama.example/v1/chat/completions',
      model: 'gemma4:latest',
      apiKey: 'request-test-token'
    }, [{ role: 'user', content: 'blue' }], { maxTokens: 40, temperature: 0.6 });

    assert.equal(guardrailCalls, 1);
    assert.equal(guardrailSessionCount, 0);
    assert.equal(request.url, 'https://ollama.example/api/chat');
    assert.equal(request.body.think, false);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.options.num_predict, 40);
    assert.equal(request.body.max_tokens, undefined);
    assert.equal(request.options.headers.Authorization, 'Bearer request-test-token');
    assert.equal(result.content, 'blue window');
  } finally {
    global.fetch = originalFetch;
    usageGuardrail.admitOllamaCall = originalAdmit;
  }
});

test('cadavre retries transient Ollama failures before using the OpenRouter equivalent', async () => {
  const originalFetch = global.fetch;
  const originalAdmit = usageGuardrail.admitOllamaCall;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const previousFallbackModel = process.env.CADAVRE_FALLBACK_MODEL;
  const calls = [];
  let guardrailCalls = 0;
  try {
    process.env.OPENROUTER_API_KEY = 'fallback-test-token';
    delete process.env.CADAVRE_FALLBACK_MODEL;
    usageGuardrail.admitOllamaCall = () => {
      guardrailCalls += 1;
      return { allowed: true };
    };
    global.fetch = async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      if (url === 'https://ollama.example/api/chat') {
        return new Response('busy', { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'silver tide' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await _private.callCandidateReliably({
      id: 'ollama:deepseek-v4-flash',
      provider: 'ollama-cloud',
      apiUrl: 'https://ollama.example/v1/chat/completions',
      model: 'deepseek-v4-flash',
      apiKey: 'ollama-test-token'
    }, [{ role: 'user', content: 'silver' }], { maxTokens: 40, temperature: 0.6 }, {
      sleepImpl: async () => {}
    });

    assert.equal(guardrailCalls, 2);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://ollama.example/api/chat');
    assert.equal(calls[1].url, 'https://ollama.example/api/chat');
    assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[2].options.headers.Authorization, 'Bearer fallback-test-token');
    assert.equal(calls[2].options.headers['HTTP-Referer'], 'https://inference-arcade.com/cadavre');
    assert.equal(calls[2].body.model, 'deepseek/deepseek-v4-flash');
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'ollama:deepseek-v4-flash');
    assert.equal(result.content, 'silver tide');
  } finally {
    global.fetch = originalFetch;
    usageGuardrail.admitOllamaCall = originalAdmit;
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
    restoreEnv('CADAVRE_FALLBACK_MODEL', previousFallbackModel);
  }
});

test('cadavre completes Ollama retry and fallback inside the browser deadline', async () => {
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  let now = 1000;
  const attempts = [];
  try {
    process.env.OPENROUTER_API_KEY = 'fallback-test-token';
    const result = await _private.callCandidateReliably({
      id: 'ollama:deepseek-v4-flash',
      provider: 'ollama-cloud',
      apiUrl: 'https://ollama.example/v1/chat/completions',
      model: 'deepseek-v4-flash',
      apiKey: 'ollama-test-token'
    }, [{ role: 'user', content: 'silver' }], { maxTokens: 40, temperature: 0.6 }, {
      nowImpl: () => now,
      sleepImpl: async (delay) => { now += delay; },
      callCandidateImpl: async (candidate, messages, settings, options) => {
        attempts.push({ provider: candidate.provider, timeoutMs: options.timeoutMs });
        now += options.timeoutMs;
        if (candidate.provider === 'ollama-cloud') throw new Error('provider timed out');
        return { content: 'silver tide', provider: candidate.provider, model: candidate.id };
      }
    });

    assert.deepEqual(attempts, [
      { provider: 'ollama-cloud', timeoutMs: _private.OLLAMA_ATTEMPT_TIMEOUT_MS },
      { provider: 'ollama-cloud', timeoutMs: _private.OLLAMA_ATTEMPT_TIMEOUT_MS },
      {
        provider: 'openrouter',
        timeoutMs: _private.CHAT_DEADLINE_MS - (_private.OLLAMA_ATTEMPT_TIMEOUT_MS * 2) - 250
      }
    ]);
    assert.equal(now, 1000 + _private.CHAT_DEADLINE_MS);
    assert.equal(result.provider, 'openrouter');
  } finally {
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
  }
});

test('cadavre keeps usage-cap rejections out of provider fallback', async () => {
  const originalFetch = global.fetch;
  const originalAdmit = usageGuardrail.admitOllamaCall;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  let fetchCalls = 0;
  try {
    process.env.OPENROUTER_API_KEY = 'fallback-test-token';
    usageGuardrail.admitOllamaCall = () => ({
      allowed: false,
      reason: 'Ollama hourly usage limit reached',
      scope: 'hourly'
    });
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch should not run');
    };

    await assert.rejects(
      _private.callCandidateReliably({
        id: 'ollama:deepseek-v4-flash',
        provider: 'ollama-cloud',
        apiUrl: 'https://ollama.example/v1/chat/completions',
        model: 'deepseek-v4-flash',
        apiKey: 'ollama-test-token'
      }, [{ role: 'user', content: 'silver' }], { maxTokens: 40, temperature: 0.6 }, {
        sleepImpl: async () => {}
      }),
      (error) => error.guardrail === true && error.scope === 'hourly'
    );
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
    usageGuardrail.admitOllamaCall = originalAdmit;
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
  }
});

test('cadavre uses low thinking for gpt-oss and disables thinking for other Ollama models', () => {
  assert.equal(_private.ollamaThinkSetting('gpt-oss:120b'), 'low');
  assert.equal(_private.ollamaThinkSetting('GPT-OSS:20b'), 'low');
  assert.equal(_private.ollamaThinkSetting('gemma4:latest'), false);
});

test('cadavre Legion calls retain the OpenAI-compatible request shape', async () => {
  const originalFetch = global.fetch;
  let request;
  try {
    global.fetch = async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'glass orchard' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const result = await _private.callCandidate({
      id: 'legion:exquisite-corpse',
      provider: 'legion-vllm',
      apiUrl: 'https://legion.example/v1/chat/completions',
      model: 'exquisite-corpse',
      apiKey: ''
    }, [{ role: 'user', content: 'glass' }], { maxTokens: 80, temperature: 0.7 });

    assert.equal(request.url, 'https://legion.example/v1/chat/completions');
    assert.equal(request.body.max_tokens, 80);
    assert.equal(request.body.think, undefined);
    assert.equal(result.model, 'legion:exquisite-corpse');
  } finally {
    global.fetch = originalFetch;
  }
});

test('cadavre route limits CORS to the deployed sites and localhost', () => {
  assert.equal(_private.isAllowedOrigin('https://inference-arcade.com'), true);
  assert.equal(_private.isAllowedOrigin('https://milwrite.github.io'), true);
  assert.equal(_private.isAllowedOrigin('http://localhost:8800'), true);
  assert.equal(_private.isAllowedOrigin('https://inference-arcade.com.evil.example'), false);
  assert.equal(_private.isAllowedOrigin('https://example.com'), false);
});

test('cadavre chat rate limit is enforced per IP', () => {
  const previousLimit = process.env.CADAVRE_CHAT_RATE_LIMIT;
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; }
  };
  let passed = 0;
  try {
    process.env.CADAVRE_CHAT_RATE_LIMIT = '1';
    _private.rateLimitChat({ ip: '203.0.113.9' }, response, () => { passed += 1; }, 1000);
    _private.rateLimitChat({ ip: '203.0.113.9' }, response, () => { passed += 1; }, 1001);
    assert.equal(passed, 1);
    assert.equal(response.statusCode, 429);
    assert.ok(Number(response.headers['Retry-After']) > 0);
  } finally {
    restoreEnv('CADAVRE_CHAT_RATE_LIMIT', previousLimit);
  }
});

test('cadavre rate limit prefers Cloudflare and forwarded client addresses', () => {
  const request = {
    ip: '10.0.0.2',
    headers: {
      'cf-connecting-ip': '203.0.113.20',
      'x-forwarded-for': '203.0.113.21, 10.0.0.1'
    },
    get(name) { return this.headers[name.toLowerCase()]; }
  };
  assert.equal(_private.clientIp(request), '203.0.113.20');
  delete request.headers['cf-connecting-ip'];
  assert.equal(_private.clientIp(request), '203.0.113.21');
  delete request.headers['x-forwarded-for'];
  assert.equal(_private.clientIp(request), '10.0.0.2');
});

test('cadavre route clamps numeric settings', () => {
  assert.equal(_private.clampNumber(999, 160, 16, 500), 500);
  assert.equal(_private.clampNumber(-5, 160, 16, 500), 16);
  assert.equal(_private.clampNumber('bad', 160, 16, 500), 160);
});
