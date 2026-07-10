function passingReason(result = {}) {
  if (result.won === true || result.winner === 'PLAYER_WINS') return 'won';
  if (result.survivedMinTicks && !result.nilActionLoop && Number(result.decisions || 0) > 0) {
    return 'fair-play';
  }
  return null;
}

function evidenceScore(result = {}) {
  const reason = passingReason(result);
  return [
    reason === 'won' ? 1 : 0,
    Number(result.finalScore || 0),
    Number(result.ticks || 0),
    Number(result.decisions || 0)
  ];
}

function compareEvidence(a = {}, b = {}) {
  const aScore = evidenceScore(a);
  const bScore = evidenceScore(b);
  for (let i = 0; i < aScore.length; i++) {
    if (aScore[i] !== bScore[i]) return bScore[i] - aScore[i];
  }
  return String(a.runId || '').localeCompare(String(b.runId || ''));
}

function summarizeQualification(results = [], plan = {}, options = {}) {
  const selectedModels = Array.isArray(plan.models) ? plan.models : [];
  const modelCount = selectedModels.length || new Set(results.map(result => result.modelId)).size;
  const requiredModelPasses = Math.max(
    1,
    Number.isInteger(options.requiredModelPasses)
      ? options.requiredModelPasses
      : Math.ceil(modelCount / 2)
  );
  const targetGameCount = Number.isInteger(options.targetGameCount)
    ? options.targetGameCount
    : Math.max(1, Array.isArray(plan.games) ? plan.games.length : 0);
  const gameSummaries = new Map();

  for (const game of plan.games || []) {
    gameSummaries.set(game.id, {
      gameId: game.id,
      gameName: game.name,
      levelId: game.levelId,
      modelPasses: 0,
      requiredModelPasses,
      qualified: false,
      models: selectedModels.map(model => ({
        modelId: model.id,
        modelName: model.name,
        passed: false,
        reason: null,
        evidenceRunId: null,
        finalScore: null,
        ticks: null,
        strategyId: null,
        winner: null
      }))
    });
  }

  for (const result of results) {
    if (!gameSummaries.has(result.gameId)) {
      gameSummaries.set(result.gameId, {
        gameId: result.gameId,
        gameName: result.gameName,
        levelId: result.levelId,
        modelPasses: 0,
        requiredModelPasses,
        qualified: false,
        models: []
      });
    }

    const summary = gameSummaries.get(result.gameId);
    let modelSummary = summary.models.find(model => model.modelId === result.modelId);
    if (!modelSummary) {
      modelSummary = {
        modelId: result.modelId,
        modelName: result.modelName || result.modelId,
        passed: false,
        reason: null,
        evidenceRunId: null,
        finalScore: null,
        ticks: null,
        strategyId: null,
        winner: null
      };
      summary.models.push(modelSummary);
    }

    const reason = passingReason(result);
    if (!reason) continue;
    const previous = modelSummary.evidenceRunId
      ? results.find(candidate => candidate.runId === modelSummary.evidenceRunId)
      : null;
    if (!previous || compareEvidence(result, previous) < 0) {
      modelSummary.passed = true;
      modelSummary.reason = reason;
      modelSummary.evidenceRunId = result.runId;
      modelSummary.finalScore = Number(result.finalScore || 0);
      modelSummary.ticks = Number(result.ticks || 0);
      modelSummary.strategyId = result.strategyId || null;
      modelSummary.winner = result.winner || null;
    }
  }

  const games = [...gameSummaries.values()]
    .map(summary => {
      const modelPasses = summary.models.filter(model => model.passed).length;
      return {
        ...summary,
        modelPasses,
        qualified: modelPasses >= requiredModelPasses
      };
    })
    .sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      if (a.modelPasses !== b.modelPasses) return b.modelPasses - a.modelPasses;
      return a.gameId - b.gameId;
    });

  const qualifyingGames = games.filter(game => game.qualified);

  return {
    targetGameCount,
    selectedModelCount: modelCount,
    requiredModelPasses,
    qualifyingGameCount: qualifyingGames.length,
    targetMet: qualifyingGames.length >= targetGameCount,
    games
  };
}

module.exports = {
  passingReason,
  summarizeQualification
};
