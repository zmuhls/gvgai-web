const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WEB_ROOT = path.resolve(__dirname, '..');

test('primary navigation presents durable tournament records as the Leaderboard', () => {
  const html = fs.readFileSync(path.join(WEB_ROOT, 'public', 'index.html'), 'utf-8');

  assert.match(html, /data-target="leaderboard-dashboard"[^>]*>Leaderboard</);
  assert.match(html, /id="leaderboard-dashboard"/);
  assert.match(html, /id="leaderboard-standings"/);
  assert.match(html, /id="leaderboard-history"/);
  assert.match(html, /js\/leaderboard-dashboard\.js/);
  assert.doesNotMatch(html, /js\/telemetry-dashboard\.js/);
});

test('leaderboard renderer uses the tournament API and safe DOM rendering', () => {
  const source = fs.readFileSync(path.join(WEB_ROOT, 'public', 'js', 'leaderboard-dashboard.js'), 'utf-8');

  assert.match(source, /fetch\('\/api\/leaderboard'\)/);
  assert.match(source, /renderStandings/);
  assert.match(source, /renderNewPlayers/);
  assert.match(source, /renderHistory/);
  assert.doesNotMatch(source, /innerHTML/);
});

test('server mounts the tournament leaderboard API', () => {
  const source = fs.readFileSync(path.join(WEB_ROOT, 'server.js'), 'utf-8');
  assert.match(source, /app\.use\('\/api\/leaderboard', require\('\.\/routes\/leaderboard'\)\)/);
});
