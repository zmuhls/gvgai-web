const assert = require('node:assert/strict');
const test = require('node:test');

const telemetry = require('../lib/telemetry-store');
const { _private } = require('../routes/cadavre');
const { makeCandidate } = require('./support/cadavre-harness');

test.afterEach(() => {
  _private.resetForTest();
});

test('Cadavre normalizes provider-reported token usage', () => {
  assert.deepEqual(_private.providerTokenUsage({ provider: 'ollama-cloud' }, {
    prompt_eval_count: 23,
    eval_count: 7
  }), {
    inputTokens: 23,
    outputTokens: 7,
    totalTokens: 30
  });

  assert.deepEqual(_private.providerTokenUsage({ provider: 'openrouter' }, {
    usage: {
      prompt_tokens: 31,
      completion_tokens: 9,
      total_tokens: 40,
      prompt_tokens_details: { cached_tokens: 18 }
    }
  }), {
    inputTokens: 31,
    outputTokens: 9,
    totalTokens: 40,
    cachedInputTokens: 18
  });
});

test('Cadavre usage telemetry records counts without poem text or connection data', () => {
  const originalTrack = telemetry.track;
  const events = [];
  try {
    telemetry.track = (event) => {
      events.push(event);
      return event;
    };
    const candidate = makeCandidate({
      apiUrl: 'https://secret-provider.example/v1/chat/completions',
      apiKey: 'never-log-this-key'
    });
    _private.setMirrorCacheStatusProvider(() => ({
      pages: { main: { cached: true, origin: 'github', ageMs: 100, ttlMs: 30000 } },
      stats: { requests: 10, cacheHits: 9, remoteFetches: 1 }
    }));
    const context = _private.beginChatUsage(1000);
    const event = _private.recordChatUsage({
      context,
      candidate,
      messages: [
        { role: 'system', content: 'private-system-sentinel' },
        { role: 'user', content: 'ultraviolet-badger-sentinel' }
      ],
      settings: { maxTokens: 80, temperature: 0.8 },
      attempts: [
        { provider: 'ollama-cloud', fallback: false },
        { provider: 'ollama-cloud', fallback: false },
        { provider: 'openrouter', fallback: true }
      ],
      result: {
        provider: 'openrouter',
        model: candidate.id,
        content: 'private-response-sentinel',
        usage: { inputTokens: 31, outputTokens: 9, totalTokens: 40, cachedInputTokens: 18 }
      }
    }, 1250);

    assert.equal(events.length, 1);
    assert.equal(event.eventFamily, 'model_telemetry');
    assert.equal(event.eventType, 'llm_decision');
    assert.equal(event.source, 'cadavre-route');
    assert.equal(event.modelId, 'ollama:deepseek-v4-flash');
    assert.equal(event.provider, 'openrouter');
    assert.equal(event.latencyMs, 250);
    assert.equal(event.payload.surface, 'cadavre');
    assert.equal(event.payload.purpose, 'turn');
    assert.equal(event.payload.fallback_used, true);
    assert.equal(event.metrics.message_count, 2);
    assert.equal(event.metrics.prompt_chars, 50);
    assert.equal(event.metrics.response_chars, 25);
    assert.equal(event.metrics.provider_calls, 3);
    assert.equal(event.metrics.retry_count, 1);
    assert.equal(event.metrics.cached_input_tokens, 18);

    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /private-system-sentinel|ultraviolet-badger|private-response-sentinel/);
    assert.doesNotMatch(serialized, /never-log-this-key|secret-provider\.example/);
    assert.doesNotMatch(serialized, /"messages"|"content"|"prompt"|"response"/);

    const snapshot = _private.cadavreUsageSnapshot(1250);
    assert.equal(snapshot.chat.requests, 1);
    assert.equal(snapshot.chat.completed, 1);
    assert.equal(snapshot.chat.providerCallsPerCompletion, 3);
    assert.equal(snapshot.chat.retryRate, 1);
    assert.equal(snapshot.chat.fallbackRate, 1);
    assert.equal(snapshot.chat.p95LatencyMs, 250);
    assert.equal(snapshot.standards.chatDeadlineMs, 50000);
    assert.equal(snapshot.standards.maxTotalInputChars, 24000);
    assert.equal(snapshot.standards.modelCatalogCacheTtlMs, 30000);
    assert.equal(snapshot.caches.htmlMirror.stats.cacheHits, 9);
  } finally {
    _private.setMirrorCacheStatusProvider(null);
    telemetry.track = originalTrack;
  }
});
