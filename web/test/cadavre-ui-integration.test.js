const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const htmlPath = path.join(__dirname, '..', 'public', 'cadavre.html');
const titlePath = path.join(__dirname, '..', 'public', 'assets', 'cadavre-title.png');
const serverPath = path.join(__dirname, '..', 'server.js');
const routesPath = path.join(__dirname, '..', 'routes', 'cadavre.js');
const railwayPath = path.join(__dirname, '..', '..', 'railway.json');

test('Cadavre ships the model catalog UI with additive account and poem features', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /id="modelRoute"/);
  assert.match(html, /modelsEndpoint/);
  assert.match(html, /id="countdown"/);
  assert.match(html, /<option value="0">off<\/option>/);
  assert.match(html, /value="15"/);
  assert.match(html, /value="30"/);
  assert.match(html, /value="60"/);
  assert.match(html, /TIMER_API/);
  assert.match(html, /fetch\(TIMER_API/);
  assert.match(html, /durationSeconds: countdownSeconds/);
  assert.match(html, /syncTurnTimer/);
  assert.match(html, /performance\.now\(\)/);
  assert.match(html, /countdownSeconds === 0/);
  assert.match(html, /\/cancel/);
  assert.doesNotMatch(html, /timerDeadline = Date\.now\(\) \+ countdownSeconds/);
  assert.match(html, /id="authDialog"/);
  assert.match(html, /el\("authPassword"\)\.value = ""/);
  assert.match(html, /el\("authConfirm"\)\.value = ""/);
  assert.match(html, /id="editBtn"/);
  assert.match(html, /id="savePoemBtn"/);
  assert.match(html, /id="exportPdfBtn"/);
  assert.doesNotMatch(html, /exportMdBtn|text\/markdown|save as markdown/i);
  assert.match(html, /\[502, 503, 504\]\.includes/);
  assert.match(html, /retryDelays = \[1000, 2000, 3000\]/);
  assert.match(html, /src="\/assets\/cadavre-title\.png"/);
  assert.doesNotMatch(html, /milwrite\.github\.io\/cadavre-exquis\/assets\/title-cutup/);
  assert.ok(fs.statSync(titlePath).size > 100000);

  const modelPosition = html.indexOf('id="modelRoute"');
  const countdownPosition = html.indexOf('id="countdown"');
  const playerPosition = html.indexOf('id="playerCount"');
  assert.ok(modelPosition < countdownPosition && countdownPosition < playerPosition);

  for (const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) assert.doesNotThrow(() => new Function(match[1]));
  }
});

test('Railway keeps health-checked deploys while the browser covers volume remounts', () => {
  const railway = JSON.parse(fs.readFileSync(railwayPath, 'utf8'));
  assert.equal(railway.deploy.overlapSeconds, undefined);
  assert.equal(railway.deploy.healthcheckPath, '/api/cadavre/wall/health');
});

test('Cadavre owns turn countdown deadlines on the backend', () => {
  const routes = fs.readFileSync(routesPath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');

  assert.match(routes, /router\.post\('\/turn-timer'/);
  assert.match(routes, /router\.get\('\/turn-timer\/:id'/);
  assert.match(routes, /router\.post\('\/turn-timer\/:id\/cancel'/);
  assert.match(routes, /new CadavreTurnTimerStore\(\)/);
  assert.match(server, /cadavreRoutes\.closeTurnTimerStore\(\)/);
  assert.match(server, /cadavreUserRoutes\.closeStore\(\)/);
});

test('production Cadavre route serves the committed integrated page', () => {
  const source = fs.readFileSync(serverPath, 'utf8');
  assert.match(source, /app\.get\('\/cadavre',[\s\S]*?public', 'cadavre\.html'/);
  assert.doesNotMatch(source, /app\.get\('\/cadavre', \(req, res\) => cadavreMirror\.handler\('main'/);
});
