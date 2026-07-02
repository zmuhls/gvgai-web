const fs = require('fs');
const path = require('path');

const { buildPrompt } = require('./state-converter');
const promptStore = require('./prompt-store');
const {
  buildBatchPlan,
  selectEvalCases,
  runArcadeBatchEvaluation
} = require('./batch-evaluator');
const { selectGames } = require('./game-registry');
const { getCachedClassification } = require('./game-classifier');
const { getClassDefaults } = require('./class-defaults');
const {
  DEFAULT_MEMORY_DIR,
  upsertMemoryForGame,
  updateMemoryEvaluation
} = require('./strategy-memory-store');

const BASELINE_VARIANT = 'baseline';
const DIGEST_VARIANT = 'digest-memory';
const DEFAULT_SCORE_GAIN = 1;
const DEFAULT_TICK_GAIN = 25;
const DEFAULT_PROMPT_MAX_RATIO = 1.05;
const DEFAULT_PROMPT_DROP_RATIO = 0.15;

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length > 0 ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function winnerRank(winner) {
  if (winner === 'PLAYER_WINS' || winner === true) return 2;
  if (winner === 'PLAYER_LOSES' || winner === false || winner === 'ABORTED') return 0;
  return 1;
}

function sampleSsoForPrompt() {
  return {
    blockSize: 1,
    observationGridNum: 5,
    observationGridMaxRow: 5,
    worldDimension: [5, 5],
    avatarPosition: [2, 2],
    avatarHealthPoints: 100,
    avatarMaxHealthPoints: 100,
    gameScore: 0,
    gameTick: 0,
    gameWinner: 'NO_WINNER',
    availableActions: [
      'ACTION_NIL',
      'ACTION_UP',
      'ACTION_DOWN',
      'ACTION_LEFT',
      'ACTION_RIGHT',
      'ACTION_USE'
    ]
  };
}

function promptOptionsForVariant(variant, evalCase, memoryRecordsByGame, options = {}) {
  if (variant === BASELINE_VARIANT) {
    return {
      strategyMemory: BASELINE_VARIANT,
      strategyMemoryDir: options.memoryDir
    };
  }

  return {
    strategyMemory: DIGEST_VARIANT,
    allowCandidateStrategyMemory: true,
    strategyMemoryDir: options.memoryDir,
    strategyMemoryRecord: memoryRecordsByGame?.get(Number(evalCase.gameId)) || null
  };
}

function measurePromptForCase(evalCase, variant, memoryRecordsByGame, options = {}) {
  const promptConfig = promptStore.resolveGamePromptConfig(
    evalCase.gameId,
    evalCase.levelId,
    promptOptionsForVariant(variant, evalCase, memoryRecordsByGame, options)
  );
  const prompt = buildPrompt(sampleSsoForPrompt(), promptConfig, null, evalCase.strategy);
  const userChars = prompt.userMessage ? prompt.userMessage.length : 0;
  const systemChars = prompt.systemMessage ? prompt.systemMessage.length : 0;
  return {
    userPromptChars: userChars,
    systemPromptChars: systemChars,
    promptChars: userChars + systemChars,
    memoryKey: promptConfig.strategicDigestMemory?.memoryKey || null,
    responseMode: prompt.responseMode || 'text'
  };
}

function buildCasesForGames(games, options = {}) {
  const plan = buildBatchPlan({
    ...options,
    gameIds: games.map(game => game.id),
    gameCount: games.length
  });
  return selectEvalCases(plan, {
    ...options,
    limit: options.limit === undefined ? null : options.limit
  });
}

function enrichResultsWithPromptMetrics(results, cases, variant, memoryRecordsByGame, options = {}) {
  const caseByRunId = new Map(cases.map(evalCase => [evalCase.runId, evalCase]));
  return results.map(result => {
    const evalCase = caseByRunId.get(result.runId) || result;
    const promptMetrics = measurePromptForCase(evalCase, variant, memoryRecordsByGame, options);
    return {
      ...result,
      variant,
      promptMetrics,
      promptChars: promptMetrics.promptChars
    };
  });
}

function pairKey(result) {
  return [
    result.runId,
    result.gameId,
    result.levelId,
    result.modelId,
    result.strategyId
  ].join('|');
}

function groupByGame(results) {
  const groups = new Map();
  for (const result of results) {
    const key = String(result.gameId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return groups;
}

function summarizeVariant(results) {
  return {
    runs: results.length,
    meanScore: mean(results.map(result => Number(result.finalScore || 0))),
    meanTicks: mean(results.map(result => Number(result.ticks || 0))),
    winRate: results.length > 0 ? results.filter(result => result.won || result.winner === 'PLAYER_WINS').length / results.length : 0,
    nilLoopRate: results.length > 0 ? results.filter(result => result.nilActionLoop).length / results.length : 0,
    meanPromptChars: mean(results.map(result => Number(result.promptChars || result.promptMetrics?.promptChars || 0)))
  };
}

function compareGameGate(gameId, baselineResults, digestResults, baselineErrors, digestErrors, thresholds = {}) {
  // Per-class gate thresholds: explicit options win, then the archetype's
  // memoryGate entry in class-defaults.json, then the code defaults. Puzzle
  // games can demand smaller tick gains; survivors larger ones.
  const archetype = thresholds.archetype
    || getCachedClassification(gameId)?.archetype
    || null;
  const classGate = archetype ? getClassDefaults(archetype).memoryGate || {} : {};
  const scoreGain = Number(thresholds.scoreGain ?? classGate.scoreGain ?? DEFAULT_SCORE_GAIN);
  const tickGain = Number(thresholds.tickGain ?? classGate.tickGain ?? DEFAULT_TICK_GAIN);
  const promptMaxRatio = Number(thresholds.promptMaxRatio ?? classGate.promptMaxRatio ?? DEFAULT_PROMPT_MAX_RATIO);
  const promptDropRatio = Number(thresholds.promptDropRatio ?? classGate.promptDropRatio ?? DEFAULT_PROMPT_DROP_RATIO);
  const baselineByPair = new Map(baselineResults.map(result => [pairKey(result), result]));
  const digestByPair = new Map(digestResults.map(result => [pairKey(result), result]));
  const reasons = [];
  const blockers = [];

  const baseline = summarizeVariant(baselineResults);
  const digest = summarizeVariant(digestResults);
  const scoreDelta = digest.meanScore - baseline.meanScore;
  const tickDelta = digest.meanTicks - baseline.meanTicks;
  const winRateDelta = digest.winRate - baseline.winRate;
  const promptRatio = baseline.meanPromptChars > 0
    ? digest.meanPromptChars / baseline.meanPromptChars
    : 1;
  const promptDrop = baseline.meanPromptChars > 0
    ? (baseline.meanPromptChars - digest.meanPromptChars) / baseline.meanPromptChars
    : 0;

  if (digestErrors.length > baselineErrors.length) {
    blockers.push(`higher error count (${digestErrors.length} vs ${baselineErrors.length})`);
  }

  for (const [key, digestResult] of digestByPair) {
    const baselineResult = baselineByPair.get(key);
    if (!baselineResult) continue;
    if (digestResult.nilActionLoop && !baselineResult.nilActionLoop) {
      blockers.push(`new nil action loop in ${digestResult.runId}`);
    }
    if (winnerRank(digestResult.winner) < winnerRank(baselineResult.winner)) {
      blockers.push(`winner downgrade in ${digestResult.runId}`);
    }
  }

  if (promptRatio > promptMaxRatio) {
    blockers.push(`prompt chars ratio ${promptRatio.toFixed(2)} exceeds ${promptMaxRatio.toFixed(2)}`);
  }

  const gameplayGain =
    scoreDelta >= scoreGain ||
    tickDelta >= tickGain ||
    winRateDelta > 0;
  const gameplayEqual =
    Math.abs(scoreDelta) < scoreGain &&
    Math.abs(tickDelta) < tickGain &&
    winRateDelta === 0;
  const efficiencyGain = promptDrop >= promptDropRatio;

  if (gameplayGain) reasons.push('gameplay gain');
  if (gameplayEqual && efficiencyGain) reasons.push('equal gameplay with prompt reduction');
  if (!gameplayGain && !(gameplayEqual && efficiencyGain)) {
    blockers.push('no marked gameplay or efficiency gain');
  }

  const accepted = blockers.length === 0;
  return {
    gameId: Number(gameId),
    archetype,
    accepted,
    evaluationStatus: accepted ? 'accepted' : 'rejected',
    reasons,
    blockers,
    thresholds: {
      scoreGain,
      tickGain,
      promptMaxRatio,
      promptDropRatio
    },
    baseline,
    digest,
    deltas: {
      scoreDelta,
      tickDelta,
      winRateDelta,
      promptRatio,
      promptDrop
    }
  };
}

function comparePairedResults(input, thresholds = {}) {
  const baselineResults = input.baselineResults || [];
  const digestResults = input.digestResults || [];
  const baselineErrors = input.baselineErrors || [];
  const digestErrors = input.digestErrors || [];
  const baselineByGame = groupByGame(baselineResults);
  const digestByGame = groupByGame(digestResults);
  const allGameIds = new Set([
    ...baselineByGame.keys(),
    ...digestByGame.keys(),
    ...baselineErrors.map(error => String(error.gameId)),
    ...digestErrors.map(error => String(error.gameId))
  ]);

  const games = [...allGameIds].sort((a, b) => Number(a) - Number(b)).map(gameId => {
    const gameBaselineErrors = baselineErrors.filter(error => String(error.gameId) === gameId);
    const gameDigestErrors = digestErrors.filter(error => String(error.gameId) === gameId);
    return compareGameGate(
      gameId,
      baselineByGame.get(gameId) || [],
      digestByGame.get(gameId) || [],
      gameBaselineErrors,
      gameDigestErrors,
      thresholds
    );
  });

  return {
    generatedAt: new Date().toISOString(),
    games,
    acceptedGames: games.filter(game => game.accepted).length,
    rejectedGames: games.filter(game => !game.accepted).length,
    status: games.every(game => game.accepted) ? 'accepted' : 'mixed'
  };
}

function artifactPath(options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(__dirname, '..', 'data', 'eval-runs', `strategy-memory-${stamp}.json`);
}

function writeArtifact(output, options = {}) {
  const outPath = options.out ? path.resolve(options.out) : artifactPath(options);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  return outPath;
}

async function runVariant(variant, games, cases, memoryRecordsByGame, options = {}) {
  const result = await runArcadeBatchEvaluation({
    ...options,
    dryRun: false,
    gameIds: games.map(game => game.id),
    gameCount: games.length,
    limit: options.limit === undefined ? null : options.limit,
    promptConfigOptions: variant === DIGEST_VARIANT
      ? {
        strategyMemory: DIGEST_VARIANT,
        allowCandidateStrategyMemory: true,
        strategyMemoryDir: options.memoryDir
      }
      : {
        strategyMemory: BASELINE_VARIANT,
        strategyMemoryDir: options.memoryDir
      }
  });

  return {
    ...result,
    variant,
    results: enrichResultsWithPromptMetrics(result.results, cases, variant, memoryRecordsByGame, options),
    errors: result.errors.map(error => ({ ...error, variant }))
  };
}

async function evaluateStrategyMemory(options = {}) {
  const allGames = selectGames(options);
  const memoryRecordsByGame = new Map();
  const digestErrors = [];
  for (const game of allGames) {
    try {
      const record = upsertMemoryForGame(game, {
        dryRun: options.dryRun,
        memoryDir: options.memoryDir || DEFAULT_MEMORY_DIR
      });
      memoryRecordsByGame.set(game.id, record);
    } catch (error) {
      digestErrors.push({ gameId: game.id, gameName: game.name, message: error.message });
    }
  }
  const games = allGames.filter(game => memoryRecordsByGame.has(game.id) || options.dryRun);

  const cases = buildCasesForGames(games, options);
  const plannedPairs = cases.flatMap(evalCase => [
    {
      variant: BASELINE_VARIANT,
      runId: evalCase.runId,
      gameId: evalCase.gameId,
      modelId: evalCase.modelId,
      strategyId: evalCase.strategyId,
      promptMetrics: measurePromptForCase(evalCase, BASELINE_VARIANT, memoryRecordsByGame, options)
    },
    {
      variant: DIGEST_VARIANT,
      runId: evalCase.runId,
      gameId: evalCase.gameId,
      modelId: evalCase.modelId,
      strategyId: evalCase.strategyId,
      promptMetrics: measurePromptForCase(evalCase, DIGEST_VARIANT, memoryRecordsByGame, options)
    }
  ]);

  if (options.dryRun) {
    return {
      status: 'planned',
      dryRun: true,
      generatedAt: new Date().toISOString(),
      memoryDir: options.memoryDir || DEFAULT_MEMORY_DIR,
      games: games.map(game => ({ id: game.id, name: game.name, file: game.file })),
      cases,
      plannedPairs,
      results: [],
      errors: digestErrors,
      gate: null,
      artifactPath: null
    };
  }

  const baseline = await runVariant(BASELINE_VARIANT, games, cases, memoryRecordsByGame, options);
  const digest = await runVariant(DIGEST_VARIANT, games, cases, memoryRecordsByGame, options);
  const gate = comparePairedResults({
    baselineResults: baseline.results,
    digestResults: digest.results,
    baselineErrors: baseline.errors,
    digestErrors: digest.errors
  }, options.thresholds || {});

  for (const gateResult of gate.games) {
    const record = memoryRecordsByGame.get(gateResult.gameId);
    if (record?.memoryKey) {
      updateMemoryEvaluation(record.memoryKey, gateResult, {
        memoryDir: options.memoryDir || DEFAULT_MEMORY_DIR
      });
    }
  }

  const output = {
    status: gate.rejectedGames > 0 || digestErrors.length > 0 ? 'completed_with_rejections' : 'completed',
    dryRun: false,
    generatedAt: new Date().toISOString(),
    memoryDir: options.memoryDir || DEFAULT_MEMORY_DIR,
    games: games.map(game => ({ id: game.id, name: game.name, file: game.file })),
    cases,
    variants: {
      baseline,
      digestMemory: digest
    },
    results: [...baseline.results, ...digest.results],
    errors: [...digestErrors, ...baseline.errors, ...digest.errors],
    gate
  };
  output.artifactPath = writeArtifact(output, options);
  return output;
}

module.exports = {
  BASELINE_VARIANT,
  DIGEST_VARIANT,
  DEFAULT_SCORE_GAIN,
  DEFAULT_TICK_GAIN,
  DEFAULT_PROMPT_MAX_RATIO,
  DEFAULT_PROMPT_DROP_RATIO,
  measurePromptForCase,
  compareGameGate,
  comparePairedResults,
  evaluateStrategyMemory
};
