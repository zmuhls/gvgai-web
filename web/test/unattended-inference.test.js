const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEB_ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(WEB_ROOT, ...parts), 'utf8');

test('public page traffic cannot start the marble run', () => {
  const popout = read('public', 'js', 'marble-popout.js');
  const telemetry = read('public', 'js', 'telemetry-dashboard.js');
  const route = read('routes', 'marble.js');

  assert.doesNotMatch(popout, /\/api\/marble\/start/);
  assert.doesNotMatch(telemetry, /\/api\/marble\/start/);
  assert.match(route, /MARBLE_RUN_ENABLED/);
  assert.match(route, /requireOperator/);
});

test('server background inference paths require exact opt-in flags', () => {
  const server = read('server.js');
  const cadavreRoute = read('routes', 'cadavre.js');

  assert.match(server, /CADAVRE_MODEL_WARMER_ENABLED === 'true'/);
  assert.match(server, /MARBLE_RUN_ENABLED === 'true'/);
  assert.match(server, /MARBLE_RUN_AUTOSTART === 'true'/);
  assert.match(cadavreRoute, /CADAVRE_READY_GENERATION_ENABLED === 'true'/);
  assert.match(cadavreRoute, /CADAVRE_MODEL_WARMER_ENABLED !== 'true'/);
});

test('browser-owned model sessions stop or pause when their page leaves', () => {
  const app = read('public', 'js', 'app.js');
  const cadavre = read('public', 'cadavre.html');
  const server = read('server.js');
  const expireBlock = cadavre.match(
    /function expireHumanTurn[\s\S]*?\n    }\n\n    async function syncTurnTimer/
  )?.[0] || '';

  assert.match(app, /addEventListener\('pagehide'/);
  assert.match(app, /keepalive: true/);
  assert.match(cadavre, /MAX_GAME_TURNS = 20/);
  assert.match(cadavre, /addEventListener\("visibilitychange"/);
  assert.match(cadavre, /abortActiveChat/);
  assert.match(cadavre, /if \(!isCurrentTurn\(\)\) return/);
  assert.match(expireBlock, /pauseTurn/);
  assert.doesNotMatch(expireBlock, /actorIndex\+\+/);
  assert.match(server, /MODEL_RUN_MAX_ACTIONS/);
  assert.match(server, /MODEL_RUN_MAX_PROVIDER_CALLS/);
  assert.match(server, /MODEL_RUN_MAX_MS/);
  assert.match(server, /run_owner_disconnected/);
  assert.match(server, /resumeMarble:\s*false/);
  assert.match(server, /stopProcess:\s*false/);
  assert.match(server, /stopGameAndWait\(pid,\s*3000\)/);
  assert.match(server, /acquireGameStartLock/);
  assert.match(server, /getAllModels\(\)\.find/);
});

test('bulk model actions require operator enablement and authentication', () => {
  const evals = read('routes', 'evals.js');
  const finetune = read('routes', 'finetune.js');

  assert.match(evals, /MODEL_EVALS_ENABLED/);
  assert.match(evals, /requireOperator/);
  assert.match(finetune, /MODEL_FINETUNE_ENABLED/g);
  assert.match(finetune, /requireOperator/);
});
