const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEB_ROOT = path.resolve(__dirname, '..');

test('server mounts the arcade eval route', () => {
  const serverSource = fs.readFileSync(path.join(WEB_ROOT, 'server.js'), 'utf-8');

  assert.match(serverSource, /app\.use\('\/api\/evals',\s*require\('\.\/routes\/evals'\)\);/);
  assert.match(serverSource, /app\.use\('\/api\/telemetry',\s*require\('\.\/routes\/telemetry'\)\);/);
  assert.match(serverSource, /app\.use\('\/api\/roadmap',\s*require\('\.\/routes\/roadmap'\)\);/);
});

test('eval route exposes the arcade plan builder', () => {
  const routeSource = fs.readFileSync(path.join(WEB_ROOT, 'routes', 'evals.js'), 'utf-8');

  assert.match(routeSource, /router\.get\('\/arcade'/);
  assert.match(routeSource, /router\.post\('\/arcade\/run'/);
  assert.match(routeSource, /buildArcadeEvalPlan/);
  assert.match(routeSource, /runArcadeBatchEvaluation/);
  assert.match(routeSource, /gameCount/);
});

test('telemetry route exposes summary, event write, and flush endpoints', () => {
  const routeSource = fs.readFileSync(path.join(WEB_ROOT, 'routes', 'telemetry.js'), 'utf-8');

  assert.match(routeSource, /router\.get\('\/summary'/);
  assert.match(routeSource, /router\.post\('\/events'/);
  assert.match(routeSource, /router\.post\('\/flush'/);
  assert.match(routeSource, /telemetry\.track/);
});
