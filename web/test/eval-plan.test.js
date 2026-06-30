const assert = require('node:assert/strict');
const test = require('node:test');

function loadEvalPlan() {
  try {
    return require('../lib/eval-plan');
  } catch (error) {
    assert.fail(`Expected web/lib/eval-plan.js to load: ${error.message}`);
  }
}

test('arcade eval plan covers the featured models across three arcade games', () => {
  const { buildArcadeEvalPlan } = loadEvalPlan();
  const plan = buildArcadeEvalPlan({ gameCount: 3 });

  assert.deepEqual(plan.modelIds, ['gpt-oss:120b', 'deepseek-v3.1:671b', 'qwen3-coder:480b']);
  assert.deepEqual(plan.gameIds, [0, 32, 4]);
  assert.equal(plan.games[0].name, 'aliens');
  assert.equal(plan.games[1].name, 'doorkoban');
  assert.equal(plan.games[2].name, 'bait');
  assert.ok(plan.strategies.length >= 2);
  assert.equal(plan.cases.length, plan.modelIds.length * plan.gameIds.length * plan.strategies.length);

  for (const evalCase of plan.cases) {
    assert.ok(plan.modelIds.includes(evalCase.modelId));
    assert.ok(plan.gameIds.includes(evalCase.gameId));
    assert.equal(evalCase.levelId, 0);
    assert.match(evalCase.runId, /^arcade-g\d+-l0-[a-z0-9.-]+-s\d+$/);
    assert.ok(evalCase.strategy.trim().length > 0);
  }
});

test('arcade eval plan can include more games without changing model coverage', () => {
  const { buildArcadeEvalPlan } = loadEvalPlan();
  const plan = buildArcadeEvalPlan({ gameCount: 5 });

  assert.deepEqual(plan.modelIds, ['gpt-oss:120b', 'deepseek-v3.1:671b', 'qwen3-coder:480b']);
  assert.deepEqual(plan.gameIds, [0, 32, 4, 11, 18]);
  assert.equal(plan.cases.length, plan.modelIds.length * plan.gameIds.length * plan.strategies.length);
});

test('normalized eval result keeps comparable performance fields', () => {
  const { buildArcadeEvalPlan, normalizeEvalResult } = loadEvalPlan();
  const [evalCase] = buildArcadeEvalPlan({ gameCount: 3 }).cases;

  const result = normalizeEvalResult(evalCase, {
    finalScore: 12,
    winner: 'PLAYER_WINS',
    ticks: 74,
    decisions: 9,
    actions: ['ACTION_RIGHT', 'ACTION_USE'],
    adherence: { label: 'Strongly followed', mentioned: 7, total: 9 },
    highlights: [{ tick: 12, action: 'ACTION_USE', reason: 'Cleared an enemy', scoreDelta: 2 }]
  });

  assert.equal(result.runId, evalCase.runId);
  assert.equal(result.modelId, evalCase.modelId);
  assert.equal(result.gameId, evalCase.gameId);
  assert.equal(result.finalScore, 12);
  assert.equal(result.winner, 'PLAYER_WINS');
  assert.equal(result.won, true);
  assert.equal(result.ticks, 74);
  assert.equal(result.decisions, 9);
  assert.deepEqual(result.actions, ['ACTION_RIGHT', 'ACTION_USE']);
  assert.equal(result.adherence.label, 'Strongly followed');
  assert.equal(result.nilActionLoop, false);
  assert.equal(result.survivedMinTicks, true);
});

test('normalized eval result flags nil action loops', () => {
  const { buildArcadeEvalPlan, normalizeEvalResult } = loadEvalPlan();
  const [evalCase] = buildArcadeEvalPlan({ gameCount: 3 }).cases;

  const result = normalizeEvalResult(evalCase, {
    finalScore: 0,
    winner: 'PLAYER_LOSES',
    ticks: 18,
    decisions: 5,
    highlights: [],
    actions: ['ACTION_NIL', 'ACTION_NIL', 'ACTION_NIL', 'ACTION_NIL']
  });

  assert.equal(result.nilActionLoop, true);
  assert.equal(result.survivedMinTicks, false);
});

test('eval case filtering targets games, models, strategies, and caps run count', () => {
  const { buildArcadeEvalPlan, filterEvalCases } = loadEvalPlan();
  const plan = buildArcadeEvalPlan({ gameCount: 5 });

  const cases = filterEvalCases(plan, {
    gameIds: [0, 4],
    modelIds: ['gpt-oss:120b'],
    strategyIds: ['safe', 'puzzle'],
    maxCases: 3
  });

  assert.equal(cases.length, 3);
  assert.deepEqual([...new Set(cases.map(evalCase => evalCase.modelId))], ['gpt-oss:120b']);
  assert.ok(cases.every(evalCase => [0, 4].includes(evalCase.gameId)));
  assert.ok(cases.every(evalCase => ['safe', 'puzzle'].includes(evalCase.strategyId)));
});
