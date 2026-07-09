const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBatchPlan } = require('../lib/batch-evaluator');
const { passingReason, summarizeQualification } = require('../lib/eval-qualification');
const { parseArgs } = require('../scripts/run-arcade-eval');

test('passingReason accepts wins and fair-play survival only', () => {
  assert.equal(passingReason({ winner: 'PLAYER_WINS', nilActionLoop: true }), 'won');
  assert.equal(
    passingReason({ survivedMinTicks: true, nilActionLoop: false, decisions: 4 }),
    'fair-play'
  );
  assert.equal(passingReason({ survivedMinTicks: true, nilActionLoop: true, decisions: 4 }), null);
  assert.equal(passingReason({ survivedMinTicks: true, nilActionLoop: false, decisions: 0 }), null);
});

test('summarizeQualification requires at least half of selected models per game', () => {
  const plan = {
    models: [
      { id: 'm1', name: 'Model 1' },
      { id: 'm2', name: 'Model 2' },
      { id: 'm3', name: 'Model 3' },
      { id: 'm4', name: 'Model 4' }
    ],
    games: [
      { id: 10, name: 'boulderchase', levelId: 1 },
      { id: 14, name: 'cakybaky', levelId: 1 }
    ]
  };
  const qualification = summarizeQualification([
    { runId: 'g10-m1', gameId: 10, gameName: 'boulderchase', levelId: 1, modelId: 'm1', modelName: 'Model 1', winner: 'PLAYER_WINS', finalScore: 2, ticks: 12 },
    { runId: 'g10-m2', gameId: 10, gameName: 'boulderchase', levelId: 1, modelId: 'm2', modelName: 'Model 2', survivedMinTicks: true, nilActionLoop: false, decisions: 6, finalScore: 0, ticks: 80 },
    { runId: 'g14-m1', gameId: 14, gameName: 'cakybaky', levelId: 1, modelId: 'm1', modelName: 'Model 1', survivedMinTicks: true, nilActionLoop: false, decisions: 8, finalScore: 1, ticks: 70 }
  ], plan, { targetGameCount: 2 });

  assert.equal(qualification.selectedModelCount, 4);
  assert.equal(qualification.requiredModelPasses, 2);
  assert.equal(qualification.qualifyingGameCount, 1);
  assert.equal(qualification.targetMet, false);
  assert.equal(qualification.games[0].gameId, 10);
  assert.equal(qualification.games[0].qualified, true);
  assert.equal(qualification.games[1].qualified, false);
});

test('buildBatchPlan can target level 1 and all catalog models', () => {
  const plan = buildBatchPlan({ gameIds: '0', levelId: '1', allModels: true });

  assert.equal(plan.games.length, 1);
  assert.equal(plan.games[0].id, 0);
  assert.equal(plan.games[0].levelId, 1);
  assert.ok(plan.models.length >= 7);
});

test('parseArgs accepts level and all-model qualification flags', () => {
  const options = parseArgs(['--game-id', '0,10', '--level-id', '1', '--all-models']);

  assert.equal(options.gameIds, '0,10');
  assert.equal(options.levelId, '1');
  assert.equal(options.allModels, true);
});
