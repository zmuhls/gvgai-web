const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEB_ROOT = path.resolve(__dirname, '..');

test('server exposes mid-run steering for model runs only', () => {
  const serverSource = fs.readFileSync(path.join(WEB_ROOT, 'server.js'), 'utf-8');

  assert.match(serverSource, /app\.post\('\/api\/game\/steer'/);
  assert.match(serverSource, /updateStrategy/);
  // Human runs cannot be steered
  assert.match(serverSource, /Steering only applies to model runs/);
});

test('frame stream is tagged with the owning run so viewers can scope frames', () => {
  const serverSource = fs.readFileSync(path.join(WEB_ROOT, 'server.js'), 'utf-8');

  // startScreenshotStreaming records the owner and game-frame carries it
  assert.match(serverSource, /function startScreenshotStreaming\(owner/);
  assert.match(serverSource, /runId: frameOwner \? frameOwner\.runId : null/);
  assert.match(serverSource, /source: frameOwner \? frameOwner\.source : null/);
  // The walk-up route claims the stream for its run
  assert.match(serverSource, /startScreenshotStreaming\(\{ runId, source: 'walkup' \}\)/);

  // The marble run claims the stream for its case
  const coordinatorSource = fs.readFileSync(path.join(WEB_ROOT, 'lib', 'attract-coordinator.js'), 'utf-8');
  assert.match(coordinatorSource, /streamer\.start\(\{ runId: evalCase\.runId, source: 'marble' \}\)/);
});

test('walk-up viewer scopes socket events to its active run', () => {
  const appSource = fs.readFileSync(path.join(WEB_ROOT, 'public', 'js', 'app.js'), 'utf-8');

  assert.match(appSource, /function isCurrentRun\(data\)/);
  // Every run-scoped handler drops events from other runs (marble hijack fix)
  for (const event of ['llm-reasoning', 'game-frame', 'game-state', 'level-end', 'run-summary', 'session-end', 'llm-error', 'strategy-updated']) {
    const handler = appSource.match(new RegExp(`socket\\.on\\('${event}',[^)]*\\)\\s*=>\\s*\\{\\s*([^\\n]*)`));
    assert.ok(handler, `handler for ${event} present`);
    assert.match(handler[1], /isCurrentRun/, `${event} handler filters by run`);
  }
});

test('trace adherence badge uses action-aware directional steering checks', () => {
  const appSource = fs.readFileSync(path.join(WEB_ROOT, 'public', 'js', 'app.js'), 'utf-8');

  assert.match(appSource, /function parseDirectionalStrategy\(strategy\)/);
  assert.match(appSource, /function moveFollowsStrategy\(data\)/);
  assert.match(appSource, /data\.action === directive\.action/);
  assert.doesNotMatch(appSource, /if \(sharesStrategyKeyword\(data\.reason, data\.strategy\)\)/);
});
