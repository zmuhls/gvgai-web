const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  injectRuntimeConfig,
  createCadavreMirror
} = require('../lib/cadavre-mirror');

const SOURCE_HTML = `<!doctype html>
<html><head>
<link rel="icon" href="assets/favicon-32.png">
<link rel="icon" href="./assets/favicon.png">
<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
<script src="ui/config.local.js"></script></head>
<body><a href="ui/corpse.html">the open sheet</a></body></html>`;

test('Cadavre mirror injects only same-origin runtime routes and rewrites the open sheet link', () => {
  const html = injectRuntimeConfig(SOURCE_HTML);
  assert.doesNotMatch(html, /config\.local\.js/);
  assert.match(html, /"endpoint":"\/api\/cadavre\/chat"/);
  assert.match(html, /"readyEndpoint":"\/api\/cadavre\/ready"/);
  assert.match(html, /"modelsEndpoint":"\/api\/cadavre\/models"/);
  assert.match(html, /"model":"ollama:gemma3:4b"/);
  assert.match(html, /href="\/cadavre\/open-sheet"/);
  assert.match(html, /href="https:\/\/milwrite\.github\.io\/cadavre-exquis\/assets\/favicon-32\.png"/);
  assert.match(html, /href="https:\/\/milwrite\.github\.io\/cadavre-exquis\/assets\/favicon\.png"/);
  assert.match(html, /href="https:\/\/milwrite\.github\.io\/cadavre-exquis\/assets\/apple-touch-icon\.png"/);
  assert.doesNotMatch(html, /href="(?:\.\/)?assets\//);
  assert.doesNotMatch(html, /apiKey|OLLAMA|LEGION|v1\/chat\/completions|ollama\.com/);
  assert.equal((injectRuntimeConfig(html).match(/id="cadavre-runtime-config"/g) || []).length, 1);
});

test('Cadavre mirror keeps a short in-memory copy of canonical GitHub HTML', async () => {
  let fetchCount = 0;
  let fetchedUrl = '';
  const mirror = createCadavreMirror({
    cacheTtlMs: 1000,
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async (url) => {
      fetchCount += 1;
      fetchedUrl = url;
      return new Response(SOURCE_HTML, { status: 200 });
    }
  });

  const first = await mirror.getPage('main', 1000);
  const second = await mirror.getPage('main', 1500);
  assert.equal(first.source, 'github');
  assert.equal(second.source, 'cache');
  assert.equal(fetchCount, 1);
  assert.equal(fetchedUrl, 'https://raw.example/main?cadavre_v=1');
});

test('Cadavre mirror shares one cold GitHub fetch across 100 concurrent requests', async () => {
  let fetchCount = 0;
  let markFetchStarted;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const fetchBarrier = new Promise((resolve) => { releaseFetch = resolve; });
  const mirror = createCadavreMirror({
    cacheTtlMs: 1000,
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async () => {
      fetchCount += 1;
      markFetchStarted();
      await fetchBarrier;
      return new Response(SOURCE_HTML, { status: 200 });
    }
  });

  const requests = Array.from({ length: 100 }, () => mirror.getPage('main', 1000));
  await fetchStarted;
  try {
    assert.equal(fetchCount, 1);
  } finally {
    releaseFetch();
  }

  const pages = await Promise.all(requests);
  assert.equal(pages.length, 100);
  assert.ok(pages.every((page) => page.source === 'github'));

  const status = mirror.getCacheStatus(1000);
  assert.equal(status.stats.requests, 100);
  assert.equal(status.stats.remoteFetches, 1);
  assert.equal(status.stats.coalescedRequests, 99);
  assert.equal(status.pages.main.origin, 'github');
  assert.equal(status.pages.main.refreshInFlight, false);
  assert.doesNotMatch(JSON.stringify(status), /raw\.example|<!doctype html>/);
});

test('Cadavre mirror caches a cold local fallback for its shorter TTL', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-mirror-'));
  const mainFallback = path.join(directory, 'cadavre.html');
  const sheetFallback = path.join(directory, 'cadavre-open-sheet.html');
  fs.writeFileSync(mainFallback, SOURCE_HTML);
  fs.writeFileSync(sheetFallback, SOURCE_HTML.replace('the open sheet', 'open sheet fallback'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let fetchCount = 0;
  const mirror = createCadavreMirror({
    fallbackCacheTtlMs: 100,
    fallbackPaths: { main: mainFallback, openSheet: sheetFallback },
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async () => {
      fetchCount += 1;
      throw new Error('offline');
    }
  });

  const first = await mirror.getPage('openSheet', 1000);
  fs.writeFileSync(sheetFallback, SOURCE_HTML.replace('the open sheet', 'updated local fallback'));
  const second = await mirror.getPage('openSheet', 1050);
  const third = await mirror.getPage('openSheet', 1100);

  assert.equal(first.source, 'local');
  assert.match(first.html, /\/api\/cadavre\/chat/);
  assert.match(first.html, /open sheet fallback/);
  assert.equal(second.source, 'cache');
  assert.match(second.html, /open sheet fallback/);
  assert.equal(third.source, 'local');
  assert.match(third.html, /updated local fallback/);
  assert.equal(fetchCount, 2);

  const status = mirror.getCacheStatus(1100);
  assert.equal(status.stats.cacheHits, 1);
  assert.equal(status.stats.remoteFailures, 2);
  assert.equal(status.stats.localFallbackReads, 2);
  assert.equal(status.pages.openSheet.origin, 'local');
  assert.equal(status.pages.openSheet.ttlMs, 100);
});

test('Cadavre mirror preserves stale GitHub HTML when a refresh fails', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-mirror-'));
  const mainFallback = path.join(directory, 'cadavre.html');
  const sheetFallback = path.join(directory, 'cadavre-open-sheet.html');
  fs.writeFileSync(mainFallback, SOURCE_HTML.replace('the open sheet', 'local fallback'));
  fs.writeFileSync(sheetFallback, SOURCE_HTML);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let online = true;
  const mirror = createCadavreMirror({
    cacheTtlMs: 100,
    fallbackPaths: { main: mainFallback, openSheet: sheetFallback },
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async () => {
      if (!online) throw new Error('offline');
      return new Response(SOURCE_HTML.replace('the open sheet', 'remote copy'), { status: 200 });
    }
  });

  const first = await mirror.getPage('main', 1000);
  online = false;
  const second = await mirror.getPage('main', 1100);

  assert.equal(first.source, 'github');
  assert.equal(second.source, 'cache');
  assert.match(second.html, /remote copy/);
  assert.doesNotMatch(second.html, /local fallback/);

  const status = mirror.getCacheStatus(1100);
  assert.equal(status.stats.remoteFetches, 2);
  assert.equal(status.stats.remoteFailures, 1);
  assert.equal(status.stats.staleRemoteServed, 1);
  assert.equal(status.stats.localFallbackReads, 0);
  assert.equal(status.pages.main.origin, 'github');
  assert.equal(status.pages.main.fresh, false);
});
