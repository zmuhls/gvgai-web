'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { readFeaturedIds } = require('../lib/game-registry');
const gamesRoute = require('../routes/games-local');

const WEB_ROOT = path.resolve(__dirname, '..');

test('featured game order is the model-native starter set plus the arcade classics and top eval candidates', () => {
  assert.deepEqual(readFeaturedIds(path.resolve(WEB_ROOT, '..')), [
    0, 10, 14, 18, 13, 19, 20, 22, 30, 68, 44, 50, 15, 26, 63
  ]);
});

test('games route derives stable featured ranks', () => {
  const ranks = gamesRoute.loadFeaturedRanks();

  assert.equal(ranks.get(0), 1);
  assert.equal(ranks.get(68), 10);
  assert.equal(ranks.get(44), 11);
  assert.equal(ranks.get(63), 15);
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
  for (const [index, gameId] of featuredIds.entries()) {
    const game = staticGames.find(row => row.id === gameId);
    assert.equal(game.featuredRank, index + 1);
  }
});
