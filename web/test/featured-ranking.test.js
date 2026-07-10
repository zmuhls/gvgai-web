const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, summarizeFeaturedRanking } = require('../scripts/rank-featured-games');

function fair(gameId, modelId, strategyId = 'safe', actions = ['ACTION_LEFT', 'ACTION_UP']) {
  return {
    runId: `${gameId}-${modelId}-${strategyId}`,
    source: 'eval.json',
    gameId,
    gameName: `game-${gameId}`,
    modelId,
    strategyId,
    winner: 'NO_WINNER',
    won: false,
    finalScore: 1,
    ticks: 61,
    decisions: 62,
    survivedMinTicks: true,
    nilActionLoop: false,
    actions
  };
}

test('ranking prioritizes wins, model passes, and strategy breadth', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const results = [
    { ...fair(1, 'm1'), won: true, winner: 'PLAYER_WINS', ticks: 20 },
    { ...fair(1, 'm2'), won: true, winner: 'PLAYER_WINS', ticks: 24 },
    { ...fair(1, 'm3'), won: true, winner: 'PLAYER_WINS', ticks: 22 },
    fair(2, 'm1', 'weave-a', ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_UP']),
    fair(2, 'm2', 'weave-b', ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_DOWN']),
    fair(2, 'm3', 'weave-c', ['ACTION_UP', 'ACTION_LEFT', 'ACTION_DOWN', 'ACTION_RIGHT']),
    fair(3, 'm1'),
    fair(3, 'm2'),
    fair(3, 'm3')
  ];

  const ranking = summarizeFeaturedRanking(results, [], {
    gameIds: [1, 2, 3],
    modelIds: models,
    generatedAt: '2026-07-10T00:00:00.000Z'
  });

  assert.equal(ranking.requiredModelPasses, 3);
  assert.equal(ranking.qualifyingGameCount, 3);
  assert.deepEqual(ranking.games.map(game => game.gameId), [1, 2, 3]);
  assert.equal(ranking.games[0].modelWins, 3);
  assert.deepEqual(ranking.games[1].qualifyingStrategies, ['weave-a', 'weave-b', 'weave-c']);
});

test('ranking keeps games below the half-catalog threshold unqualified', () => {
  const ranking = summarizeFeaturedRanking([
    fair(1, 'm1'),
    fair(1, 'm2')
  ], [], {
    gameIds: [1],
    modelIds: ['m1', 'm2', 'm3', 'm4', 'm5']
  });

  assert.equal(ranking.games[0].qualified, false);
  assert.equal(ranking.games[0].modelPasses, 2);
});

test('ranking CLI parses output and input files', () => {
  assert.deepEqual(parseArgs(['--out', 'ranking.json', 'a.json', 'b.json']), {
    out: 'ranking.json',
    inputs: ['a.json', 'b.json']
  });
});
