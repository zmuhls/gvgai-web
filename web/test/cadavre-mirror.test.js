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
<html><head><script src="ui/config.local.js"></script></head>
<body><a href="ui/corpse.html">the open sheet</a></body></html>`;

test('Cadavre mirror injects only same-origin runtime routes and rewrites the open sheet link', () => {
  const html = injectRuntimeConfig(SOURCE_HTML);
  assert.doesNotMatch(html, /config\.local\.js/);
  assert.match(html, /"endpoint":"\/api\/cadavre\/chat"/);
  assert.match(html, /"modelsEndpoint":"\/api\/cadavre\/models"/);
  assert.match(html, /"model":"legion:exquisite-corpse"/);
  assert.match(html, /href="\/cadavre\/open-sheet"/);
  assert.doesNotMatch(html, /apiKey|OLLAMA|LEGION|https:\/\//);
  assert.equal((injectRuntimeConfig(html).match(/id="cadavre-runtime-config"/g) || []).length, 1);
});

test('Cadavre mirror keeps a short in-memory copy of canonical GitHub HTML', async () => {
  let fetchCount = 0;
  const mirror = createCadavreMirror({
    cacheTtlMs: 1000,
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(SOURCE_HTML, { status: 200 });
    }
  });

  const first = await mirror.getPage('main', 1000);
  const second = await mirror.getPage('main', 1500);
  assert.equal(first.source, 'github');
  assert.equal(second.source, 'cache');
  assert.equal(fetchCount, 1);
});

test('Cadavre mirror reads the matching local page when GitHub is unavailable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-mirror-'));
  const mainFallback = path.join(directory, 'cadavre.html');
  const sheetFallback = path.join(directory, 'cadavre-open-sheet.html');
  fs.writeFileSync(mainFallback, SOURCE_HTML);
  fs.writeFileSync(sheetFallback, SOURCE_HTML.replace('the open sheet', 'open sheet fallback'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const mirror = createCadavreMirror({
    fallbackPaths: { main: mainFallback, openSheet: sheetFallback },
    sources: { main: 'https://raw.example/main', openSheet: 'https://raw.example/sheet' },
    fetchImpl: async () => { throw new Error('offline'); }
  });
  const page = await mirror.getPage('openSheet');
  assert.equal(page.source, 'local');
  assert.match(page.html, /\/api\/cadavre\/chat/);
  assert.match(page.html, /open sheet fallback/);
});
