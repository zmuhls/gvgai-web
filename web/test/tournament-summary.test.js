const assert = require('node:assert/strict');
const test = require('node:test');

const { summarizeTournament } = require('../lib/tournament-summary');

test('ranks tournament players and preserves matches and game evidence', () => {
  const evaluation = {
    status: 'completed_with_errors',
    results: [
      { modelId: 'a', modelName: 'A', gameId: 0, gameName: 'aliens', won: true, winner: 'PLAYER_WINS', survivedMinTicks: true, decisions: 4, finalScore: 5 },
      { modelId: 'b', modelName: 'B', gameId: 0, gameName: 'aliens', won: false, winner: 'PLAYER_LOSES', survivedMinTicks: true, decisions: 4, finalScore: 3 },
      { modelId: 'a', modelName: 'A', gameId: 13, gameName: 'butterflies', won: false, survivedMinTicks: true, decisions: 4, finalScore: 2 },
      { modelId: 'b', modelName: 'B', gameId: 13, gameName: 'butterflies', won: false, survivedMinTicks: false, decisions: 4, finalScore: 8 }
    ],
    errors: [{ modelId: 'b', gameId: 18 }],
    qualification: { qualifyingGameCount: 1 }
  };
  const roster = {
    models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    newPlayerIds: ['b']
  };
  const record = summarizeTournament(evaluation, roster, { levelId: 1, strategyId: 'sweep', maxActions: 40 });

  assert.equal(record.champion.modelId, 'a');
  assert.equal(record.summary.matchesPlayed, 4);
  assert.equal(record.summary.errors, 1);
  assert.deepEqual(record.newPlayers, ['b']);
  assert.equal(record.standings[0].wins, 1);
  assert.equal(record.standings[1].providerErrors, 1);
  assert.equal(record.games[0].winner, 'a');
});
