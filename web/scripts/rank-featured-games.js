#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { MODELS } = require('../lib/models');
const { passingReason } = require('../lib/eval-qualification');

function parseArgs(argv) {
  const options = { inputs: [] };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') {
      options.out = argv[index + 1];
      index += 1;
    } else {
      options.inputs.push(argv[index]);
    }
  }
  return options;
}

function compareEvidence(left, right) {
  const leftWon = left.won === true || left.winner === 'PLAYER_WINS';
  const rightWon = right.won === true || right.winner === 'PLAYER_WINS';
  if (leftWon !== rightWon) return leftWon ? -1 : 1;
  if (left.finalScore !== right.finalScore) return Number(right.finalScore || 0) - Number(left.finalScore || 0);
  if (left.ticks !== right.ticks) return Number(right.ticks || 0) - Number(left.ticks || 0);
  return Number(right.decisions || 0) - Number(left.decisions || 0);
}

function actionDiversity(result) {
  return new Set(Array.isArray(result.actions) ? result.actions : []).size;
}

function summarizeFeaturedRanking(results, errors, options) {
  const gameIds = options.gameIds;
  const modelIds = options.modelIds;
  const requiredModelPasses = Math.ceil(modelIds.length / 2);

  const games = gameIds.map(gameId => {
    const gameResults = results.filter(result => result.gameId === gameId && modelIds.includes(result.modelId));
    const modelsTested = [...new Set(gameResults.map(result => result.modelId))];
    const passingResults = gameResults.filter(result => passingReason(result));
    const evidence = modelIds.flatMap(modelId => {
      const candidates = passingResults.filter(result => result.modelId === modelId).sort(compareEvidence);
      if (candidates.length === 0) return [];
      const best = candidates[0];
      return [{
        modelId,
        runId: best.runId,
        source: best.source,
        strategyId: best.strategyId,
        reason: passingReason(best),
        winner: best.winner,
        finalScore: Number(best.finalScore || 0),
        ticks: Number(best.ticks || 0),
        decisions: Number(best.decisions || 0),
        nilActionLoop: Boolean(best.nilActionLoop),
        actionDiversity: actionDiversity(best)
      }];
    });
    const winningEvidence = evidence.filter(item => item.reason === 'won');
    const qualifyingStrategies = [...new Set(passingResults.map(result => result.strategyId).filter(Boolean))].sort();

    return {
      gameId,
      gameName: gameResults[0]?.gameName || `game-${gameId}`,
      qualified: evidence.length >= requiredModelPasses,
      modelPasses: evidence.length,
      modelWins: winningEvidence.length,
      modelsTested: modelsTested.length,
      qualifyingStrategies,
      meanWinTicks: winningEvidence.length > 0
        ? winningEvidence.reduce((sum, item) => sum + item.ticks, 0) / winningEvidence.length
        : null,
      maxActionDiversity: evidence.reduce((max, item) => Math.max(max, item.actionDiversity), 0),
      nilLoopRuns: gameResults.filter(result => result.nilActionLoop).length,
      errorCount: errors.filter(error => error.gameId === gameId).length,
      evidence
    };
  });

  games.sort((left, right) => {
    if (left.qualified !== right.qualified) return left.qualified ? -1 : 1;
    if (left.modelWins !== right.modelWins) return right.modelWins - left.modelWins;
    if (left.modelPasses !== right.modelPasses) return right.modelPasses - left.modelPasses;
    if (left.qualifyingStrategies.length !== right.qualifyingStrategies.length) {
      return right.qualifyingStrategies.length - left.qualifyingStrategies.length;
    }
    if (left.meanWinTicks !== null || right.meanWinTicks !== null) {
      const leftTicks = left.meanWinTicks ?? Number.POSITIVE_INFINITY;
      const rightTicks = right.meanWinTicks ?? Number.POSITIVE_INFINITY;
      if (leftTicks !== rightTicks) return leftTicks - rightTicks;
    }
    if (left.maxActionDiversity !== right.maxActionDiversity) {
      return right.maxActionDiversity - left.maxActionDiversity;
    }
    return left.gameId - right.gameId;
  });

  return {
    generatedAt: options.generatedAt || new Date().toISOString(),
    selectedGameCount: gameIds.length,
    selectedModelCount: modelIds.length,
    requiredModelPasses,
    qualifyingGameCount: games.filter(game => game.qualified).length,
    rankingCriteria: [
      'qualified at the half-catalog threshold',
      'distinct model wins',
      'distinct model passes',
      'qualifying strategy breadth',
      'lower mean ticks for wins',
      'action diversity',
      'stable game id tie-break'
    ],
    models: modelIds,
    sources: options.sources || [],
    games: games.map((game, index) => ({ rank: index + 1, ...game }))
  };
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const options = parseArgs(process.argv.slice(2));
  if (!options.out || options.inputs.length === 0) {
    throw new Error('Usage: rank-featured-games.js --out <path> <eval.json> [eval.json ...]');
  }

  const featured = JSON.parse(fs.readFileSync(path.join(root, 'web', 'data', 'featured.json'), 'utf-8')).featured;
  const modelIds = MODELS.filter(model => model.featured).map(model => model.id);
  const results = [];
  const errors = [];
  const sources = [];

  for (const input of options.inputs) {
    const absolute = path.resolve(root, input);
    const source = path.relative(root, absolute);
    const payload = JSON.parse(fs.readFileSync(absolute, 'utf-8'));
    sources.push(source);
    results.push(...(payload.results || []).map(result => ({ ...result, source })));
    errors.push(...(payload.errors || []).map(error => ({ ...error, source })));
  }

  const ranking = summarizeFeaturedRanking(results, errors, {
    gameIds: featured,
    modelIds,
    sources
  });
  const output = path.resolve(root, options.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(ranking, null, 2)}\n`);
  console.log(`[Ranking] ${ranking.qualifyingGameCount}/${ranking.selectedGameCount} games qualify`);
  for (const game of ranking.games) {
    console.log(`[Ranking] ${game.rank}. ${game.gameName}: ${game.modelPasses}/${ranking.requiredModelPasses} passes, ${game.modelWins} wins`);
  }
  console.log(`[Ranking] wrote ${output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[Ranking] failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  summarizeFeaturedRanking
};
