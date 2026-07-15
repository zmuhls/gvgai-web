const assert = require('node:assert/strict');
const test = require('node:test');

const usageGuardrail = require('../lib/usage-guardrail');
const cadavreRouter = require('../routes/cadavre');
const { _private } = cadavreRouter;

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

test('cadavre route can use OpenRouter when Ollama Cloud is not configured', () => {
  const previousOllamaKey = process.env.OLLAMA_API_KEY;
  const previousCloudKey = process.env.OLLAMA_CLOUD_API_KEY;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  try {
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_CLOUD_API_KEY;
    process.env.OPENROUTER_API_KEY = 'openrouter-only-test-token';

    const candidate = _private.resolveRouteModel('ollama:gpt-oss:20b');
    assert.equal(candidate.id, 'ollama:gpt-oss:20b');
    assert.equal(candidate.provider, 'openrouter');
    assert.equal(candidate.model, 'openai/gpt-oss-20b');
  } finally {
    restoreEnv('OLLAMA_API_KEY', previousOllamaKey);
    restoreEnv('OLLAMA_CLOUD_API_KEY', previousCloudKey);
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
  }
});

test('cadavre standby configuration preserves model names containing colons', () => {
  const previousStandbys = process.env.CADAVRE_STANDBY_MODELS;
  const previousOllamaKey = process.env.OLLAMA_API_KEY;
  try {
    process.env.CADAVRE_STANDBY_MODELS = 'gemma3:4b, gpt-oss:20b, ollama:gemma3:4b';
    process.env.OLLAMA_API_KEY = 'standby-parser-test-token';

    assert.deepEqual(_private.configuredStandbyModelIds(), [
      'ollama:gemma3:4b',
      'ollama:gpt-oss:20b'
    ]);
  } finally {
    restoreEnv('CADAVRE_STANDBY_MODELS', previousStandbys);
    restoreEnv('OLLAMA_API_KEY', previousOllamaKey);
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
  assert.equal(
    _private.openRouterModelsUrl('https://openrouter.ai/api/v1/chat/completions'),
    'https://openrouter.ai/api/v1/models'
  );
});

test('cadavre aligns every curated Ollama model with its OpenRouter fallback id', () => {
  const expectedFallbacks = new Map([
    ['deepseek-v3.2', 'deepseek/deepseek-v3.2'],
    ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
    ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
    ['gemma3:4b', 'google/gemma-3-4b-it'],
    ['gemma4:31b', 'google/gemma-4-31b-it'],
    ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
    ['kimi-k2.6', 'moonshotai/kimi-k2.6'],
    ['minimax-m2.7', 'minimax/minimax-m2.7'],
    ['minimax-m3', 'minimax/minimax-m3'],
    ['qwen3-coder-next', 'qwen/qwen3-coder-next'],
    ['qwen3.5:397b', 'qwen/qwen3.5-397b-a17b'],
    ['gpt-oss:20b', 'openai/gpt-oss-20b'],
    ['gpt-oss:120b', 'openai/gpt-oss-120b'],
    ['ministral-3:14b', 'mistralai/ministral-14b-2512'],
    ['nemotron-3-nano:30b', 'nvidia/nemotron-3-nano-30b-a3b'],
    ['nemotron-3-super', 'nvidia/nemotron-3-super-120b-a12b']
  ]);

  assert.deepEqual(_private.CADAVRE_OPENROUTER_MODEL_IDS, expectedFallbacks);
  assert.deepEqual(
    [..._private.CADAVRE_CLOUD_MODEL_IDS],
    [...expectedFallbacks.keys()]
  );
});

test('cadavre catalog returns the tuned adapter and OpenRouter-first model choices without connection data', async () => {
  const originalFetch = global.fetch;
  const previousEndpoint = process.env.CADAVRE_ENDPOINT;
  const previousOllamaKey = process.env.OLLAMA_API_KEY;
  const previousCloudKey = process.env.OLLAMA_CLOUD_API_KEY;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const calls = [];
  try {
    process.env.CADAVRE_ENDPOINT = 'https://legion.example/v1/chat/completions';
    process.env.OLLAMA_API_KEY = 'catalog-test-token';
    process.env.OPENROUTER_API_KEY = 'openrouter-catalog-test-token';
    delete process.env.OLLAMA_CLOUD_API_KEY;
    global.fetch = async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization || '' });
      let data;
      if (url.startsWith('https://legion.example')) {
        data = [{ id: 'exquisite-corpse' }, { id: 'base-model' }];
      } else if (url.startsWith('https://openrouter.ai')) {
        data = [..._private.CADAVRE_OPENROUTER_MODEL_IDS.values()].map((id) => ({ id }));
      } else {
        data = [
          { id: 'deepseek-v3.2', name: 'DeepSeek V3.2' },
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
          { id: 'gemma3:4b', name: 'Gemma 3 4B' },
          { id: 'gemma3:12b', name: 'Gemma 3 12B' },
          { id: 'gemma3:27b', name: 'Gemma 3 27B' },
          { id: 'gemma4:31b', name: 'Gemma 4 31B' },
          { id: 'devstral-small-2:24b', name: 'Devstral Small 2 24B' },
          { id: 'gpt-oss:20b', name: 'GPT-OSS 20B' },
          { id: 'gpt-oss:120b', name: 'GPT-OSS 120B' },
          { id: 'kimi-k2.5', name: 'Kimi K2.5' },
          { id: 'kimi-k2.6', name: 'Kimi K2.6' },
          { id: 'minimax-m2.7', name: 'MiniMax M2.7' },
          { id: 'minimax-m3', name: 'MiniMax M3' },
          { id: 'ministral-3:3b', name: 'Ministral 3 3B' },
          { id: 'ministral-3:8b', name: 'Ministral 3 8B' },
          { id: 'ministral-3:14b', name: 'Ministral 3 14B' },
          { id: 'nemotron-3-nano:30b', name: 'Nemotron 3 Nano 30B' },
          { id: 'nemotron-3-super', name: 'Nemotron 3 Super' },
          { id: 'qwen3.5:397b', name: 'Qwen 3.5 397B' },
          { id: 'qwen3-coder-next', name: 'Qwen3 Coder Next' },
          { id: 'mistral-large-3:675b' }
        ];
      }
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
      'ollama:gpt-oss:120b',
      'ollama:gpt-oss:20b',
      'ollama:kimi-k2.5',
      'ollama:kimi-k2.6',
      'ollama:minimax-m2.7',
      'ollama:minimax-m3',
      'ollama:ministral-3:14b',
      'ollama:nemotron-3-nano:30b',
      'ollama:nemotron-3-super',
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
      'gpt-oss:120b',
      'gpt-oss:20b',
      'kimi-k2.5',
      'kimi-k2.6',
      'minimax-m2.7',
      'minimax-m3',
      'ministral-3:14b',
      'nemotron-3-nano:30b',
      'nemotron-3-super',
      'qwen3.5:397b',
      'qwen3-coder-next'
    ]);
    assert.match(catalog.models[1].label, /OpenRouter; Ollama fallback/);
    assert.equal(catalog.models[1].provider, 'openrouter');
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:deepseek-v4-pro'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:mistral-large-3:675b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:ministral-3:3b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:ministral-3:8b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:gemma3:12b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:gemma3:27b'), false);
    assert.equal(catalog.models.some(({ id }) => id === 'ollama:devstral-small-2:24b'), false);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ url }) => url.endsWith('/v1/models')));
    assert.ok(calls.some(({ url, authorization }) =>
      url.startsWith('https://ollama.com/') && authorization === 'Bearer catalog-test-token'));
    assert.ok(calls.some(({ url, authorization }) =>
      url === 'https://openrouter.ai/api/v1/models' && authorization === 'Bearer openrouter-catalog-test-token'));
    const serialized = JSON.stringify(catalog);
    assert.doesNotMatch(serialized, /catalog-test-token|https:\/\//);
  } finally {
    global.fetch = originalFetch;
    restoreEnv('CADAVRE_ENDPOINT', previousEndpoint);
    restoreEnv('OLLAMA_API_KEY', previousOllamaKey);
    restoreEnv('OLLAMA_CLOUD_API_KEY', previousCloudKey);
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
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

test('cadavre uses the OpenRouter equivalent before spending an Ollama call', async () => {
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

    assert.equal(guardrailCalls, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer fallback-test-token');
    assert.equal(calls[0].options.headers['HTTP-Referer'], 'https://inference-arcade.com/cadavre');
    assert.equal(calls[0].body.model, 'deepseek/deepseek-v4-flash');
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

test('cadavre falls back to Ollama inside the browser deadline when OpenRouter fails', async () => {
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
        if (candidate.provider === 'openrouter') throw new Error('provider timed out');
        return { content: 'silver tide', provider: candidate.provider, model: candidate.id };
      }
    });

    assert.deepEqual(attempts, [
      {
        provider: 'openrouter',
        timeoutMs: _private.OPENROUTER_ATTEMPT_TIMEOUT_MS
      },
      { provider: 'ollama-cloud', timeoutMs: _private.OLLAMA_ATTEMPT_TIMEOUT_MS }
    ]);
    assert.equal(now, 1000 + _private.CHAT_DEADLINE_MS);
    assert.equal(result.provider, 'ollama-cloud');
  } finally {
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
  }
});

test('cadavre reaches the Ollama usage cap only after OpenRouter fails', async () => {
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
      return new Response('busy', { status: 503 });
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
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
    usageGuardrail.admitOllamaCall = originalAdmit;
    restoreEnv('OPENROUTER_API_KEY', previousOpenRouterKey);
  }
});

test('cadavre moves from an exhausted selected route to a healthy standby model', async () => {
  let now = 1000;
  const attempts = [];
  const selected = {
    id: 'ollama:deepseek-v4-flash',
    provider: 'legion-vllm',
    apiUrl: 'https://selected.example/v1/chat/completions',
    model: 'deepseek-v4-flash',
    apiKey: ''
  };
  const standby = {
    id: 'ollama:gemma3:4b',
    provider: 'legion-vllm',
    apiUrl: 'https://standby.example/v1/chat/completions',
    model: 'gemma3:4b',
    apiKey: ''
  };

  const result = await _private.callListedRoutePoolReliably({
    requested: selected,
    candidates: [selected, standby]
  }, [{ role: 'user', content: 'copper' }], { maxTokens: 16, temperature: 0.8 }, {
    nowImpl: () => now,
    deadlineAt: 31000,
    onAttempt: (attempt) => attempts.push(attempt),
    callCandidateImpl: async (candidate) => {
      now += 25;
      if (candidate.id === selected.id) {
        const error = new Error('daily provider cap reached');
        error.guardrail = true;
        throw error;
      }
      return {
        content: 'verdigris',
        provider: 'openrouter',
        model: standby.id
      };
    }
  });

  assert.equal(result.content, 'verdigris');
  assert.equal(result.model, standby.id);
  assert.equal(result.requestedModel, selected.id);
  assert.equal(result.failover, true);
  assert.deepEqual(attempts.map(({ routeModel, standby: isStandby, fallback }) => ({
    routeModel,
    standby: isStandby,
    fallback
  })), [
    { routeModel: selected.id, standby: false, fallback: false },
    { routeModel: standby.id, standby: true, fallback: true }
  ]);
  assert.equal(_private.getModelReadyStatus(selected.id, now).model, standby.id);
});

test('cadavre readiness cache expires and the ready endpoint is rate limited', () => {
  const status = _private.rememberModelReady('ollama:deepseek-v4-flash', {
    model: 'ollama:gemma3:4b',
    provider: 'openrouter'
  }, 1000);

  assert.equal(status.cached, false);
  assert.equal(status.failover, true);
  assert.equal(_private.getModelReadyStatus('ollama:deepseek-v4-flash', 1001).cached, true);
  assert.equal(
    _private.getModelReadyStatus('ollama:deepseek-v4-flash', 1000 + _private.MODEL_READY_TTL_MS),
    null
  );

  const layer = cadavreRouter.stack.find((entry) => entry.route?.path === '/ready');
  assert.ok(layer);
  assert.equal(layer.route.methods.post, true);
  assert.equal(layer.route.stack[0].handle, _private.rateLimitChat);
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
  assert.equal(_private.isAllowedOrigin('http://127.0.0.1:8800'), true);
  assert.equal(_private.isAllowedOrigin('http://[::1]:8800'), true);
  assert.equal(_private.isAllowedOrigin('https://inference-arcade.com.evil.example'), false);
  assert.equal(_private.isAllowedOrigin('https://example.com'), false);
});

test('cadavre wall vote handler forwards the browser token and returns only vote state', async () => {
  const expected = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    upvotes: 4,
    downvotes: 2,
    score: 2,
    viewerVote: 1
  };
  let received;
  const handler = _private.createWallVoteHandler({
    async vote(id, voterToken, value) {
      received = { id, voterToken, value };
      return expected;
    }
  });
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  const voterToken = 'd'.repeat(64);

  await handler({
    params: { id: expected.id },
    body: { voterToken, value: 1 }
  }, response);

  assert.deepEqual(received, { id: expected.id, voterToken, value: 1 });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, expected);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(response.body), /token|hash/i);
});

test('cadavre registers the wall vote endpoint with its own limiter', () => {
  const layer = cadavreRouter.stack.find(entry => entry.route?.path === '/wall/:id/vote');

  assert.ok(layer);
  assert.equal(layer.route.methods.post, true);
  assert.equal(layer.route.stack[0].handle, _private.rateLimitVote);
});

test('cadavre wall vote handler returns 404 for a missing post and keeps validation statuses', async () => {
  const response = () => ({
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  });
  const request = {
    params: { id: '123e4567-e89b-42d3-a456-426614174000' },
    body: { voterToken: 'e'.repeat(64), value: 1 }
  };

  const missingResponse = response();
  await _private.createWallVoteHandler({ async vote() { return null; } })(request, missingResponse);
  assert.equal(missingResponse.statusCode, 404);

  const invalidResponse = response();
  await _private.createWallVoteHandler({
    async vote() {
      const error = new Error('value must be -1, 0, or 1.');
      error.status = 400;
      throw error;
    }
  })(request, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.deepEqual(invalidResponse.body, { error: 'value must be -1, 0, or 1.' });
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

test('cadavre wall votes have a separate rate limit that resetForTest clears', () => {
  const previousChatLimit = process.env.CADAVRE_CHAT_RATE_LIMIT;
  const previousVoteLimit = process.env.CADAVRE_WALL_VOTE_RATE_LIMIT;
  const makeResponse = () => ({
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; }
  });
  let votePasses = 0;
  let chatPasses = 0;
  try {
    process.env.CADAVRE_CHAT_RATE_LIMIT = '1';
    process.env.CADAVRE_WALL_VOTE_RATE_LIMIT = '1';
    const request = { ip: '203.0.113.10' };
    const firstVoteResponse = makeResponse();
    const limitedVoteResponse = makeResponse();

    _private.rateLimitVote(request, firstVoteResponse, () => { votePasses += 1; }, 1000);
    _private.rateLimitVote(request, limitedVoteResponse, () => { votePasses += 1; }, 1001);
    _private.rateLimitChat(request, makeResponse(), () => { chatPasses += 1; }, 1002);

    assert.equal(votePasses, 1);
    assert.equal(chatPasses, 1);
    assert.equal(limitedVoteResponse.statusCode, 429);
    assert.match(limitedVoteResponse.body.error, /Too many wall votes/);
    assert.ok(Number(limitedVoteResponse.headers['Retry-After']) > 0);

    _private.resetForTest();
    _private.rateLimitVote(request, makeResponse(), () => { votePasses += 1; }, 1003);
    assert.equal(votePasses, 2);
  } finally {
    restoreEnv('CADAVRE_CHAT_RATE_LIMIT', previousChatLimit);
    restoreEnv('CADAVRE_WALL_VOTE_RATE_LIMIT', previousVoteLimit);
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
