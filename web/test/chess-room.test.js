const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.join(__dirname, '..');

test('links the Chess at the Shore companion room from the arcade', () => {
  const index = fs.readFileSync(path.join(webRoot, 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(webRoot, 'public', 'css', 'styles.css'), 'utf8');

  assert.match(index, /class="game-card companion-link room-chess" href="\/chess"/);
  assert.match(index, /<h3>Chess at the Shore<\/h3>/);
  assert.match(styles, /\.room-chess\s*\{/);
});

test('serves the Chess at the Shore wrapper at the clean route', () => {
  const server = fs.readFileSync(path.join(webRoot, 'server.js'), 'utf8');
  const room = fs.readFileSync(path.join(webRoot, 'public', 'chess.html'), 'utf8');

  assert.match(server, /app\.get\('\/chess'.*'chess\.html'/);
  assert.match(room, /<title>Chess at the Shore · Inference Arcade<\/title>/);
  assert.match(room, /<iframe src="https:\/\/milwrite\.github\.io\/chess-lm\/"/);
});
