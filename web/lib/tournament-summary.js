const { passingReason } = require('./eval-qualification');

function summarizeTournament(evaluation, roster, options = {}) {
  const results = evaluation.results || [];
  const errors = evaluation.errors || [];
  const standings = roster.models.map(model => {
    const modelResults = results.filter(result => result.modelId === model.id);
    const modelErrors = errors.filter(error => error.modelId === model.id);
    return {
      modelId: model.id,
      modelName: model.name || model.id,
      stage: 'tournament',
      runs: modelResults.length,
      wins: modelResults.filter(result => result.won || result.winner === 'PLAYER_WINS').length,
      losses: modelResults.filter(result => result.winner === 'PLAYER_LOSES').length,
      qualifiedGames: modelResults.filter(result => passingReason(result)).length,
      totalScore: modelResults.reduce((sum, result) => sum + Number(result.finalScore || 0), 0),
      providerErrors: modelErrors.length,
      meanLatencyMs: 0
    };
  }).sort((a, b) => (
    b.wins - a.wins ||
    b.qualifiedGames - a.qualifiedGames ||
    b.totalScore - a.totalScore ||
    a.providerErrors - b.providerErrors ||
    a.modelId.localeCompare(b.modelId)
  )).map((row, index) => ({ ...row, rank: index + 1 }));

  const gamesById = new Map();
  for (const result of results) {
    const bucket = gamesById.get(result.gameId) || {
      gameId: result.gameId,
      gameName: result.gameName,
      matchesPlayed: 0,
      qualifiedModels: new Set(),
      winners: []
    };
    bucket.matchesPlayed += 1;
    if (passingReason(result)) bucket.qualifiedModels.add(result.modelId);
    if (result.won || result.winner === 'PLAYER_WINS') bucket.winners.push(result.modelId);
    gamesById.set(result.gameId, bucket);
  }
  const games = [...gamesById.values()].sort((a, b) => a.gameId - b.gameId).map(game => ({
    gameId: game.gameId,
    gameName: game.gameName,
    matchesPlayed: game.matchesPlayed,
    qualifiedModels: game.qualifiedModels.size,
    winner: game.winners.length === 1 ? game.winners[0] : null
  }));
  const champion = standings[0] || null;

  return {
    schemaVersion: 2,
    generatedAt: options.generatedAt || new Date().toISOString(),
    status: evaluation.status || 'completed',
    champion: champion ? {
      modelId: champion.modelId,
      modelName: champion.modelName,
      reason: `${champion.wins} wins, ${champion.qualifiedGames} qualified games, ${champion.totalScore} total score, and ${champion.providerErrors} provider errors.`
    } : null,
    roster: {
      availableModelCount: options.availableModelCount || roster.models.length,
      participantCount: roster.models.length,
      providerMode: options.providerMode || 'unknown',
      discoveryStatus: options.discoveryStatus || 'not-run'
    },
    participants: roster.models.map(model => ({ modelId: model.id, modelName: model.name || model.id })),
    newPlayers: roster.newPlayerIds,
    summary: {
      matchesPlayed: results.length,
      errors: errors.length,
      gameCount: games.length
    },
    methodology: {
      levelId: options.levelId,
      socketPort: options.socketPort,
      strategyId: options.strategyId,
      maxActions: options.maxActions,
      ranking: ['wins', 'qualified games', 'total score', 'provider reliability']
    },
    standings,
    games,
    qualification: evaluation.qualification || null
  };
}

module.exports = { summarizeTournament };
