const EventEmitter = require('events');
const { buildArcadeEvalPlan, MIN_SURVIVAL_TICKS, normalizeEvalResult } = require('./eval-plan');
const { summarizeQualification } = require('./eval-qualification');
const { readFeaturedIds } = require('./game-registry');
const { getAllModels, resolveModel } = require('./models');
const defaultTelemetry = require('./telemetry-store');
const { getConfig } = require('./runtime-config');
const { getClassDefaults } = require('./class-defaults');

const DEFAULT_CASE_LIMIT = 3;
const DEFAULT_RUN_TIMEOUT_MS = 180000;
const DEFAULT_READY_TIMEOUT_MS = 60000;
const DEFAULT_MAX_ACTIONS = 40;
const DEFAULT_MIN_SCORE_DELTA = 1;
const DEFAULT_MIN_TICK_DELTA = 25;
const DEFAULT_MIN_ADHERENCE_DELTA = 0.25;
const ACTION_SAMPLE_SIZE = 12;
let runtime = null;

function loadRuntime() {
  if (runtime) return runtime;
  runtime = {
    gameManager: require('./game-manager'),
    LLMClient: require('./llm-client'),
    config: getConfig()
  };
  return runtime;
}

function toArray(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return String(value).split(',').map(part => part.trim()).filter(Boolean);
}

function toIntegerArray(value) {
  return toArray(value).map(Number).filter(Number.isInteger);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function modelsForIds(modelIds) {
  const ids = toArray(modelIds);
  if (ids.length === 0) return undefined;

  return ids.map(id => {
    const catalogModel = getAllModels().find(model => model.id === id);
    if (catalogModel) return catalogModel;
    const resolved = resolveModel(id);
    return {
      id,
      name: id,
      provider: resolved.provider,
      fallback: resolved.fallback || null,
      description: 'Ad hoc model',
      speed: 'unknown',
      cost: 'unknown',
      featured: false
    };
  });
}

function modelsForOptions(options = {}) {
  if (options.allModels || options.featuredQualification) return getAllModels();
  return modelsForIds(options.modelIds);
}

function buildBatchPlan(options = {}) {
  const gameIds = toIntegerArray(options.gameIds);
  const featuredQualification = Boolean(options.featuredQualification);
  const selectedGameIds = featuredQualification && gameIds.length === 0
    ? readFeaturedIds()
    : gameIds;
  const planOptions = {
    gameCount: featuredQualification
      ? selectedGameIds.length
      : positiveInteger(options.gameCount, undefined),
    models: modelsForOptions(options),
    strategies: options.strategies,
    levelId: featuredQualification && options.levelId == null ? 1 : options.levelId
  };
  if (selectedGameIds.length > 0) planOptions.gameIds = selectedGameIds;
  return buildArcadeEvalPlan(planOptions);
}

function selectedCaseLimit(rawLimit, availableCount) {
  if (rawLimit === null || rawLimit === false) return availableCount;
  if (rawLimit === undefined) return Math.min(DEFAULT_CASE_LIMIT, availableCount);
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return availableCount;
  return Math.min(parsed, availableCount);
}

function selectEvalCases(plan, options = {}) {
  const gameIds = new Set(toIntegerArray(options.gameIds));
  const modelIds = new Set(toArray(options.modelIds));
  const strategyIds = new Set(toArray(options.strategyIds));
  const runIds = new Set(toArray(options.runIds));

  let cases = plan.cases.filter(evalCase => {
    if (gameIds.size > 0 && !gameIds.has(evalCase.gameId)) return false;
    if (modelIds.size > 0 && !modelIds.has(evalCase.modelId)) return false;
    if (strategyIds.size > 0 && !strategyIds.has(evalCase.strategyId)) return false;
    if (runIds.size > 0 && !runIds.has(evalCase.runId)) return false;
    return true;
  });

  const requestedLimit = options.featuredQualification && options.limit === undefined
    ? null
    : options.limit;
  cases = cases.slice(0, selectedCaseLimit(requestedLimit, cases.length));
  const repeats = positiveInteger(options.repeats, 1);
  if (repeats <= 1) return cases.map(evalCase => ({ ...evalCase, repeatIndex: 0 }));

  const repeatedCases = [];
  for (const evalCase of cases) {
    for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
      repeatedCases.push({
        ...evalCase,
        repeatIndex,
        runId: `${evalCase.runId}-r${repeatIndex + 1}`
      });
    }
  }
  return repeatedCases;
}

function defaultMaxActionsForCase(evalCase = {}, options = {}) {
  if (!options.featuredQualification) return DEFAULT_MAX_ACTIONS;
  const classEval = evalCase.archetype ? getClassDefaults(evalCase.archetype).eval || {} : {};
  const minSurvivalTicks = classEval.minSurvivalTicks || MIN_SURVIVAL_TICKS;
  return Math.max(DEFAULT_MAX_ACTIONS, minSurvivalTicks + 5);
}

function createEventSink(broadcastIo = null) {
  const emitter = new EventEmitter();
  const events = [];

  return {
    events,
    emit(event, payload) {
      events.push({ event, payload, at: new Date().toISOString() });
      emitter.emit(event, payload);
      // Optional live broadcast: tee sink events to a real Socket.IO server so a
      // marble run can be watched live while still buffering for result capture.
      if (broadcastIo) broadcastIo.emit(event, payload);
    },
    on(event, handler) {
      emitter.on(event, handler);
    },
    once(event, handler) {
      emitter.once(event, handler);
    },
    off(event, handler) {
      emitter.off(event, handler);
    }
  };
}

function waitForEvent(sink, eventName, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sink.off(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName} after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(payload) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    }

    sink.once(eventName, handler);
  });
}

async function runEvalCase(evalCase, options = {}) {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_RUN_TIMEOUT_MS);
  const readyTimeoutMs = positiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const loaded = loadRuntime();
  const gameManager = options.gameManager || loaded.gameManager;
  const LLMClient = options.LLMClient || loaded.LLMClient;
  const config = options.config || loaded.config;
  const sink = createEventSink(options.io || null);
  const llmErrors = [];
  sink.on('llm-error', error => llmErrors.push(error));

  const gameProcess = await gameManager.startGame(evalCase.gameId, evalCase.levelId, false);
  let llmClient = null;

  try {
    const ready = await gameManager.waitForReady(gameProcess.processId, readyTimeoutMs);
    if (!ready) {
      const output = gameManager.getProcessOutput(gameProcess.processId);
      const stdout = output.stdout.trim().split(/\r?\n/).slice(-5).join(' | ') || '(no stdout)';
      const stderr = output.stderr.trim().split(/\r?\n/).slice(-5).join(' | ') || '(no stderr)';
      throw new Error(`Java game process did not report socket readiness within ${readyTimeoutMs}ms. Last stdout: ${stdout}. Last stderr: ${stderr}`);
    }

    llmClient = options.createLLMClient
      ? options.createLLMClient(evalCase)
      : new LLMClient({
        initialLevelId: evalCase.levelId,
        synchronousActions: options.synchronousActions !== false,
        actionTimeoutMs: options.actionTimeoutMs,
        maxActions: positiveInteger(options.maxActions, defaultMaxActionsForCase(evalCase, options)),
        initResponseType: options.initResponseType,
        actResponseType: options.actResponseType,
        preferProviderFallback: options.preferProviderFallback,
        promptConfigOptions: options.promptConfigOptions || {}
      });
    llmClient.onSessionEnd = () => {
      sink.emit('session-end', { runId: evalCase.runId });
    };

    // Hand the coordinator a live handle so a walk-up can interrupt this case
    // by disconnecting the client (which resolves the run-summary wait below).
    if (options.onCaseStart) {
      options.onCaseStart({ processId: gameProcess.processId, llmClient });
    }

    const summaryPromise = waitForEvent(sink, 'run-summary', timeoutMs);
    await llmClient.connect(
      config.gvgai.socketPort,
      evalCase.modelId,
      sink,
      evalCase.gameId,
      evalCase.gameName,
      evalCase.strategy
    );

    const summary = await summaryPromise;
    return {
      ...normalizeEvalResult(evalCase, summary, options),
      llmErrors,
      eventCount: sink.events.length
    };
  } catch (error) {
    const output = gameManager.getProcessOutput(gameProcess.processId);
    error.diagnostics = {
      ...(error.diagnostics || {}),
      events: sink.events,
      stdout: output.stdout,
      stderr: output.stderr,
      llmErrors
    };
    throw error;
  } finally {
    if (llmClient) llmClient.disconnect();
    gameManager.stopGame(gameProcess.processId);
  }
}

function adherenceRate(result) {
  const adherence = result.adherence || {};
  return adherence.total > 0 ? adherence.mentioned / adherence.total : 0;
}

function actionSignature(result) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  return actions.slice(0, ACTION_SAMPLE_SIZE).join(',');
}

function summarizePromptDifferences(results, options = {}) {
  const minScoreDelta = Number(options.minScoreDelta ?? DEFAULT_MIN_SCORE_DELTA);
  const minTickDelta = Number(options.minTickDelta ?? DEFAULT_MIN_TICK_DELTA);
  const minAdherenceDelta = Number(options.minAdherenceDelta ?? DEFAULT_MIN_ADHERENCE_DELTA);
  const groups = new Map();

  for (const result of results) {
    const key = [result.gameId, result.levelId, result.modelId].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  const comparisons = [];
  for (const groupResults of groups.values()) {
    const strategyIds = [...new Set(groupResults.map(result => result.strategyId))];
    const scores = groupResults.map(result => result.finalScore);
    const ticks = groupResults.map(result => result.ticks);
    const adherenceRates = groupResults.map(adherenceRate);
    const winners = new Set(groupResults.map(result => result.winner || 'UNKNOWN'));
    const signatures = new Set(groupResults.map(actionSignature).filter(Boolean));
    const scoreRange = scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0;
    const tickRange = ticks.length > 0 ? Math.max(...ticks) - Math.min(...ticks) : 0;
    const adherenceRange = adherenceRates.length > 0
      ? Math.max(...adherenceRates) - Math.min(...adherenceRates)
      : 0;
    const reasons = [];

    if (scoreRange >= minScoreDelta) reasons.push(`score range ${scoreRange}`);
    if (tickRange >= minTickDelta) reasons.push(`tick range ${tickRange}`);
    if (winners.size > 1) reasons.push('different winners');
    if (adherenceRange >= minAdherenceDelta) reasons.push(`adherence range ${adherenceRange.toFixed(2)}`);
    if (signatures.size > 1) reasons.push('different action sequences');

    comparisons.push({
      gameId: groupResults[0].gameId,
      gameName: groupResults[0].gameName,
      levelId: groupResults[0].levelId,
      modelId: groupResults[0].modelId,
      modelName: groupResults[0].modelName,
      strategiesCompared: strategyIds.length,
      runsCompared: groupResults.length,
      scoreRange,
      tickRange,
      adherenceRange,
      winnerValues: [...winners],
      actionSignatureCount: signatures.size,
      meaningfulDifference: strategyIds.length >= 2 && reasons.length > 0,
      reasons,
      byStrategy: strategyIds.map(strategyId => {
        const matches = groupResults.filter(result => result.strategyId === strategyId);
        const first = matches[0];
        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        return {
          strategyId,
          strategyLabel: first.strategyLabel,
          runs: matches.length,
          meanScore: mean(matches.map(result => result.finalScore)),
          meanTicks: mean(matches.map(result => result.ticks)),
          meanAdherence: mean(matches.map(adherenceRate)),
          winners: [...new Set(matches.map(result => result.winner || 'UNKNOWN'))],
          actions: first.actions || []
        };
      })
    });
  }

  return {
    comparedGroups: comparisons.length,
    groupsWithMeaningfulDifference: comparisons.filter(item => item.meaningfulDifference).length,
    comparisons
  };
}

async function runArcadeBatchEvaluation(options = {}) {
  const plan = buildBatchPlan(options);
  const cases = selectEvalCases(plan, options);
  const telemetry = options.telemetry || defaultTelemetry;
  const batchRunId = options.runId || telemetry.createRunId('eval-batch');

  telemetry.track({
    eventFamily: 'evaluation',
    eventType: options.dryRun ? 'batch_planned' : 'batch_started',
    source: 'batch-evaluator',
    runId: batchRunId,
    payload: {
      dryRun: Boolean(options.dryRun),
      cases: cases.length,
      gameIds: [...new Set(cases.map(evalCase => evalCase.gameId))],
      modelIds: [...new Set(cases.map(evalCase => evalCase.modelId))],
      strategyIds: [...new Set(cases.map(evalCase => evalCase.strategyId))]
    },
    metrics: {
      case_count: cases.length
    }
  });

  if (options.dryRun) {
    return {
      status: 'planned',
      generatedAt: new Date().toISOString(),
      cases,
      results: [],
      errors: [],
      comparison: summarizePromptDifferences([]),
      qualification: summarizeQualification([], plan, options)
    };
  }

  const results = [];
  const errors = [];
  let caseRunner = options.caseRunner;
  if (!caseRunner && options.ollamaOffline) {
    caseRunner = require('./offline-game-evaluator').runOllamaOfflineEvalCase;
  }
  if (!caseRunner && options.offline) {
    caseRunner = require('./offline-game-evaluator').runOfflineEvalCase;
  }
  if (!caseRunner) caseRunner = runEvalCase;

  for (const evalCase of cases) {
    try {
      const result = await caseRunner(evalCase, options);
      results.push(result);
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'eval_case_completed',
        source: 'batch-evaluator',
        runId: evalCase.runId,
        gameId: evalCase.gameId,
        levelId: evalCase.levelId,
        modelId: evalCase.modelId,
        payload: {
          batchRunId,
          strategyId: evalCase.strategyId,
          strategyLabel: evalCase.strategyLabel,
          winner: result.winner,
          actions: result.actions || []
        },
        metrics: {
          final_score: result.finalScore || 0,
          ticks: result.ticks || 0,
          decisions: Array.isArray(result.actions) ? result.actions.length : 0
        }
      });
    } catch (error) {
      errors.push({
        runId: evalCase.runId,
        gameId: evalCase.gameId,
        modelId: evalCase.modelId,
        strategyId: evalCase.strategyId,
        message: error.message,
        diagnostics: error.diagnostics || null
      });
      telemetry.track({
        eventFamily: 'evaluation',
        eventType: 'eval_case_failed',
        source: 'batch-evaluator',
        runId: evalCase.runId,
        gameId: evalCase.gameId,
        levelId: evalCase.levelId,
        modelId: evalCase.modelId,
        payload: {
          batchRunId,
          strategyId: evalCase.strategyId,
          message: error.message
        }
      });
    }
  }

  const comparison = summarizePromptDifferences(results, options);
  const qualification = summarizeQualification(results, plan, options);
  const output = {
    status: errors.length > 0 ? 'completed_with_errors' : 'completed',
    generatedAt: new Date().toISOString(),
    cases,
    results,
    errors,
    comparison,
    qualification
  };

  telemetry.track({
    eventFamily: 'evaluation',
    eventType: 'batch_completed',
    source: 'batch-evaluator',
    runId: batchRunId,
    payload: {
      status: output.status,
      comparedGroups: comparison.comparedGroups,
      groupsWithMeaningfulDifference: comparison.groupsWithMeaningfulDifference,
      qualifyingGames: qualification.qualifyingGameCount,
      qualificationTargetMet: qualification.targetMet
    },
    metrics: {
      cases: cases.length,
      results: results.length,
      errors: errors.length,
      qualifying_games: qualification.qualifyingGameCount
    }
  });

  return output;
}

module.exports = {
  DEFAULT_CASE_LIMIT,
  DEFAULT_MAX_ACTIONS,
  buildBatchPlan,
  defaultMaxActionsForCase,
  selectEvalCases,
  createEventSink,
  runEvalCase,
  runArcadeBatchEvaluation,
  summarizePromptDifferences
};
