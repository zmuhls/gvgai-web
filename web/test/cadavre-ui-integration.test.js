const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const htmlPath = path.join(__dirname, '..', 'public', 'cadavre.html');
const serverPath = path.join(__dirname, '..', 'server.js');

test('Cadavre ships the model catalog UI with additive account and poem features', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /id="modelRoute"/);
  assert.match(html, /modelsEndpoint/);
  assert.match(html, /id="countdown"/);
  assert.match(html, /value="15"/);
  assert.match(html, /value="30"/);
  assert.match(html, /value="60"/);
  assert.match(html, /id="authDialog"/);
  assert.match(html, /id="editBtn"/);
  assert.match(html, /id="savePoemBtn"/);
  assert.match(html, /id="exportPdfBtn"/);
  assert.doesNotMatch(html, /exportMdBtn|text\/markdown|save as markdown/i);

  for (const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) assert.doesNotThrow(() => new Function(match[1]));
  }
});

test('production Cadavre route serves the committed integrated page', () => {
  const source = fs.readFileSync(serverPath, 'utf8');
  assert.match(source, /app\.get\('\/cadavre',[\s\S]*?public', 'cadavre\.html'/);
  assert.doesNotMatch(source, /app\.get\('\/cadavre', \(req, res\) => cadavreMirror\.handler\('main'/);
});
