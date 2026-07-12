const assert = require('node:assert/strict');
const test = require('node:test');

const { _private } = require('../routes/cadavre');
const { deferred, jsonResponse } = require('./support/cadavre-harness');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test.afterEach(() => {
  _private.resetForTest();
});

test('100 simultaneous cold catalog reads share one provider refresh', async () => {
  const originalFetch = global.fetch;
  const previousEndpoint = process.env.CADAVRE_ENDPOINT;
  const previousOllamaKey = process.env.OLLAMA_API_KEY;
  const previousCloudKey = process.env.OLLAMA_CLOUD_API_KEY;
  const release = deferred();
  const calls = [];
  try {
    process.env.CADAVRE_ENDPOINT = 'https://legion.example/v1/chat/completions';
    process.env.OLLAMA_API_KEY = 'catalog-test-token';
    delete process.env.OLLAMA_CLOUD_API_KEY;
    global.fetch = async (url) => {
      calls.push(url);
      await release.promise;
      return url.startsWith('https://legion.example')
        ? jsonResponse({ data: [{ id: 'exquisite-corpse' }] })
        : jsonResponse({ data: [{ id: 'deepseek-v4-flash' }] });
    };

    const reads = Array.from({ length: 100 }, () => _private.getModelCatalog(1000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    release.resolve();
    const catalogs = await Promise.all(reads);

    assert.ok(catalogs.every((catalog) => catalog === catalogs[0]));
    assert.equal(calls.filter((url) => url.startsWith('https://legion.example')).length, 1);
    assert.equal(calls.filter((url) => url.startsWith('https://ollama.com/')).length, 1);
    assert.deepEqual(_private.getCatalogCacheStatus(1000), {
      requests: 100,
      hits: 0,
      misses: 1,
      refreshes: 1,
      refreshFailures: 0,
      coalescedRequests: 99,
      staleServed: 0,
      upstreamRequestsAvoided: 99,
      hitRatio: 0,
      reuseRatio: 0.99,
      ageMs: 0,
      ttlMs: 30000,
      refreshing: false,
      entries: 1
    });

    await _private.getModelCatalog(1100);
    assert.equal(calls.length, 2);
    const warm = _private.getCatalogCacheStatus(1100);
    assert.equal(warm.hits, 1);
    assert.equal(warm.requests, 101);
    assert.equal(warm.upstreamRequestsAvoided, 100);
  } finally {
    global.fetch = originalFetch;
    restoreEnv('CADAVRE_ENDPOINT', previousEndpoint);
    restoreEnv('OLLAMA_API_KEY', previousOllamaKey);
    restoreEnv('OLLAMA_CLOUD_API_KEY', previousCloudKey);
  }
});
