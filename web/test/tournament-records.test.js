const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getTournamentLeaderboard } = require('../lib/tournament-records');

test('normalizes tournament history and identifies newly introduced players', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-records-'));
  const tournamentDir = path.join(dataDir, 'tournaments');
  fs.mkdirSync(tournamentDir);
  fs.writeFileSync(path.join(dataDir, 'model-tournament-older.json'), JSON.stringify({
    generatedAt: '2026-07-01T00:00:00.000Z',
    champion: { modelId: 'model-a' },
    qualifierStandings: [
      { rank: 1, modelId: 'model-a', score: 3 },
      { rank: 2, modelId: 'model-b', score: 2 }
    ],
    methodology: { stages: [{ models: 2, games: 3 }] },
    finalGames: [{ gameId: 0, gameName: 'aliens', winner: 'model-a' }]
  }));
  fs.writeFileSync(path.join(tournamentDir, 'tournament-newer.json'), JSON.stringify({
    schemaVersion: 2,
    generatedAt: '2026-07-10T00:00:00.000Z',
    champion: { modelId: 'model-c', modelName: 'Model C' },
    participants: ['model-a', 'model-c'],
    newPlayers: ['model-c'],
    summary: { matchesPlayed: 20 },
    standings: [
      { rank: 1, modelId: 'model-c', wins: 2, qualifiedGames: 4, totalScore: 9 },
      { rank: 2, modelId: 'model-a', wins: 1, qualifiedGames: 3, totalScore: 7 }
    ],
    games: [
      { gameId: 0, gameName: 'aliens', winner: 'model-c' },
      { gameId: 13, gameName: 'butterflies', winner: null }
    ]
  }));
  fs.writeFileSync(path.join(tournamentDir, 'tournament-corrupt.json'), '{');

  const leaderboard = getTournamentLeaderboard({ dataDir });

  assert.equal(leaderboard.recordCount, 2);
  assert.equal(leaderboard.latest.champion.modelId, 'model-c');
  assert.equal(leaderboard.latest.matchesPlayed, 20);
  assert.equal(leaderboard.latest.gameCount, 2);
  assert.deepEqual(leaderboard.latest.newPlayers.map(player => player.modelId), ['model-c']);
  assert.equal(leaderboard.latest.standings[0].wins, 2);
  assert.equal(leaderboard.history[1].matchesPlayed, 6);
});

test('the established tournament artifact produces a populated leaderboard', () => {
  const leaderboard = getTournamentLeaderboard();

  assert.ok(leaderboard.recordCount >= 1);
  assert.equal(leaderboard.latest.champion.modelId, 'deepseek-v4-flash');
  assert.ok(leaderboard.latest.participantCount > 0);
  assert.ok(leaderboard.latest.matchesPlayed > 0);
  assert.ok(leaderboard.latest.gameCount > 0);
  assert.ok(leaderboard.latest.standings.length > 0);
});
