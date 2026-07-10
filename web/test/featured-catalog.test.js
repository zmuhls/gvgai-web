'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { readFeaturedIds } = require('../lib/game-registry');
const gamesRoute = require('../routes/games-local');

const WEB_ROOT = path.resolve(__dirname, '..');

test('public game library contains only the ten retained cabinets', () => {
  assert.deepEqual(readFeaturedIds(path.resolve(WEB_ROOT, '..')), [
    0, 18, 13, 20, 30, 68, 50, 15, 26, 63
  ]);
});

test('games route derives stable featured ranks', () => {
  const ranks = gamesRoute.loadFeaturedRanks();

  assert.equal(ranks.get(0), 1);
  assert.equal(ranks.get(14), undefined);
  assert.equal(ranks.get(19), undefined);
  assert.equal(ranks.get(44), undefined);
  assert.equal(ranks.get(22), undefined);
  assert.equal(ranks.get(68), 6);
  assert.equal(ranks.get(63), 10);
  assert.equal(ranks.get(10), undefined);
  assert.equal(ranks.get(4), undefined);
});

test('static game catalog agrees with featured data', () => {
  const featuredIds = readFeaturedIds(path.resolve(WEB_ROOT, '..'));
  const staticGames = JSON.parse(
    fs.readFileSync(path.join(WEB_ROOT, 'public', 'data', 'games.json'), 'utf-8')
  );
  const staticFeatured = staticGames
    .filter(game => game.featured)
    .sort((a, b) => a.featuredRank - b.featuredRank)
    .map(game => game.id);

  assert.deepEqual(staticFeatured, featuredIds);
  assert.equal(staticGames.length, 10);
  assert.ok(staticGames.every(game => game.featured));
  for (const [index, gameId] of featuredIds.entries()) {
    const game = staticGames.find(row => row.id === gameId);
    assert.equal(game.featuredRank, index + 1);
  }
});

test('initial HTML cabinet grid contains the same ten-game library', () => {
  const featuredIds = readFeaturedIds(path.resolve(WEB_ROOT, '..'));
  const html = fs.readFileSync(path.join(WEB_ROOT, 'public', 'index.html'), 'utf-8');
  const initialGrid = html.match(/<div id="games-grid">([\s\S]*?)<\/div>\s*<section class="companion-games"/);

  assert.ok(initialGrid);
  const ids = [...initialGrid[1].matchAll(/data-game-id="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(ids, featuredIds);
});
