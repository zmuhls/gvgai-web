const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBatchPlan,
  defaultMaxActionsForCase,
  selectEvalCases,
  runEvalCase,
  runArcadeBatchEvaluation,
  summarizePromptDifferences
} = require('../lib/batch-evaluator');

test('batch plan defaults to featured arcade games and prompt strategies', () => {
  const plan = buildBatchPlan({ gameCount: 1, modelIds: 'gpt-oss:120b' });
  const cases = selectEvalCases(plan);

  assert.equal(plan.gameIds.length, 1);
  assert.equal(plan.modelIds.length, 1);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map(evalCase => evalCase.strategyId), ['safe', 'points', 'puzzle']);
});

test('featured qualification selects the full planned sweep by default', () => {
  const plan = buildBatchPlan({ featuredQualification: true, modelIds: 'gpt-oss:120b' });
  const cases = selectEvalCases(plan, { featuredQualification: true });

  assert.equal(plan.gameIds.length, 15);
  assert.ok(plan.models.length >= 8);
  assert.equal(cases.length, plan.cases.length);
  assert.ok(cases.every(evalCase => evalCase.levelId === 1));
});

test('dry run returns selected cases without starting games', async () => {
  const result = await runArcadeBatchEvaluation({
    dryRun: true,
    gameCount: 1,
    modelIds: 'gpt-oss:120b',
    limit: 2
  });

  assert.equal(result.status, 'planned');
  assert.equal(result.cases.length, 2);
  assert.equal(result.results.length, 0);
  assert.equal(result.errors.length, 0);
});

test('offline batch produces prompt-dependent game outcomes', async () => {
  const result = await runArcadeBatchEvaluation({
    offline: true,
    gameCount: 1,
    modelIds: 'local-prompt-policy',
    limit: 3
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.results.length, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(result.comparison.groupsWithMeaningfulDifference, 1);
  assert.equal(result.comparison.comparisons[0].meaningfulDifference, true);

  const byStrategy = new Map(result.results.map(run => [run.strategyId, run]));
  assert.deepEqual(byStrategy.get('safe').actions, [
    'ACTION_UP',
    'ACTION_RIGHT',
    'ACTION_RIGHT',
    'ACTION_RIGHT',
    'ACTION_RIGHT',
    'ACTION_DOWN'
  ]);
  assert.deepEqual(byStrategy.get('points').actions.slice(0, 4), [
    'ACTION_UP',
    'ACTION_RIGHT',
    'ACTION_DOWN',
    'ACTION_USE'
  ]);
  assert.deepEqual(byStrategy.get('puzzle').actions.slice(0, 2), [
    'ACTION_RIGHT',
    'ACTION_USE'
  ]);
  assert.ok(byStrategy.get('points').finalScore > byStrategy.get('safe').finalScore);
});

test('batch errors preserve case diagnostics', async () => {
  const result = await runArcadeBatchEvaluation({
    gameCount: 1,
    modelIds: 'gpt-oss:120b',
    limit: 1,
    caseRunner: async () => {
      const error = new Error('synthetic timeout');
      error.diagnostics = {
        events: [{ event: 'session-end', payload: { reason: 'closed' } }],
        stdout: '[GAME] ready'
      };
      throw error;
    }
  });

  assert.equal(result.status, 'completed_with_errors');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].message, 'synthetic timeout');
  assert.deepEqual(result.errors[0].diagnostics.events[0], {
    event: 'session-end',
    payload: { reason: 'closed' }
  });
});

test('runEvalCase passes response type overrides to the live client', async () => {
  let receivedOptions = null;
  class FakeLLMClient {
    constructor(options) {
      receivedOptions = options;
    }

    async connect(_port, _model, sink) {
      sink.emit('run-summary', {
        finalScore: 3,
        winner: 'NO_WINNER',
        won: false,
        ticks: 5,
        decisions: 2,
        actions: ['ACTION_RIGHT']
      });
    }

    disconnect() {}
  }

  const gameManager = {
    startGame: async () => ({ processId: 'proc-1' }),
    waitForReady: async () => true,
    getProcessOutput: () => ({ stdout: '', stderr: '' }),
    stopGame: () => true
  };

  const result = await runEvalCase({
    runId: 'run-1',
    gameId: 0,
    gameName: 'aliens',
    levelId: 0,
    modelId: 'model-1',
    strategyId: 'safe',
    strategyLabel: 'Play it safe',
    strategy: 'Avoid danger.'
  }, {
    gameManager,
    LLMClient: FakeLLMClient,
    config: { gvgai: { socketPort: 8080 } },
    initResponseType: 'BOTH',
    actResponseType: 'BOTH',
    synchronousActions: true,
    preferProviderFallback: true
  });

  assert.equal(receivedOptions.initResponseType, 'BOTH');
  assert.equal(receivedOptions.actResponseType, 'BOTH');
  assert.equal(receivedOptions.synchronousActions, true);
  assert.equal(receivedOptions.preferProviderFallback, true);
  assert.equal(result.finalScore, 3);
});

test('featured qualification action budget covers class survival thresholds', async () => {
  assert.equal(defaultMaxActionsForCase({ archetype: 'pusher-puzzle' }, { featuredQualification: true }), 85);
  assert.equal(defaultMaxActionsForCase({ archetype: 'pusher-puzzle' }, {}), 40);
});

test('prompt comparison marks different outcomes as meaningful', () => {
  const comparison = summarizePromptDifferences([
    {
      gameId: 0,
      gameName: 'aliens',
      levelId: 0,
      modelId: 'gpt-oss:120b',
      modelName: 'GPT-OSS 120B',
      strategyId: 'safe',
      strategyLabel: 'Play it safe',
      finalScore: 2,
      ticks: 40,
      winner: 'PLAYER_LOSES',
      actions: ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_NIL'],
      adherence: { mentioned: 1, total: 4 }
    },
    {
      gameId: 0,
      gameName: 'aliens',
      levelId: 0,
      modelId: 'gpt-oss:120b',
      modelName: 'GPT-OSS 120B',
      strategyId: 'points',
      strategyLabel: 'Go for points',
      finalScore: 9,
      ticks: 95,
      winner: 'PLAYER_WINS',
      actions: ['ACTION_USE', 'ACTION_RIGHT', 'ACTION_USE'],
      adherence: { mentioned: 4, total: 4 }
    }
  ]);

  assert.equal(comparison.comparedGroups, 1);
  assert.equal(comparison.groupsWithMeaningfulDifference, 1);
  assert.equal(comparison.comparisons[0].meaningfulDifference, true);
  assert.ok(comparison.comparisons[0].reasons.includes('different winners'));
});

test('prompt comparison requires at least two strategies', () => {
  const comparison = summarizePromptDifferences([
    {
      gameId: 0,
      gameName: 'aliens',
      levelId: 0,
      modelId: 'gpt-oss:120b',
      modelName: 'GPT-OSS 120B',
      strategyId: 'safe',
      strategyLabel: 'Play it safe',
      finalScore: 5,
      ticks: 50,
      winner: 'PLAYER_LOSES',
      actions: ['ACTION_LEFT'],
      adherence: { mentioned: 1, total: 1 }
    }
  ]);

  assert.equal(comparison.groupsWithMeaningfulDifference, 0);
  assert.equal(comparison.comparisons[0].meaningfulDifference, false);
});
