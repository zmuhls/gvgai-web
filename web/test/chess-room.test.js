const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const webRoot = path.join(__dirname, '..');

test('links the Chess LM companion room from the arcade', () => {
  const index = fs.readFileSync(path.join(webRoot, 'public', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(webRoot, 'public', 'css', 'styles.css'), 'utf8');

  assert.match(index, /class="game-card companion-link room-chess" href="\/chess"/);
  assert.match(index, /<span>Seventh Seal–Inspired Chess<\/span>/);
  assert.match(index, /<h3>Chess LM<\/h3>/);
  assert.match(styles, /\.room-chess\s*\{/);
});

test('serves the Chess LM wrapper at the clean route', () => {
  const server = fs.readFileSync(path.join(webRoot, 'server.js'), 'utf8');
  const room = fs.readFileSync(path.join(webRoot, 'public', 'chess.html'), 'utf8');

  assert.match(server, /app\.get\('\/chess'.*'chess\.html'/);
  assert.match(room, /<title>Chess LM · Inference Arcade<\/title>/);
  assert.match(room, /<iframe src="https:\/\/milwrite\.github\.io\/chess-lm\/"/);
});
