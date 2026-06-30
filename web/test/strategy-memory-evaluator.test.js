const assert = require('node:assert/strict');
const test = require('node:test');

const {
  comparePairedResults
} = require('../lib/strategy-memory-evaluator');

function run(overrides = {}) {
  return {
    runId: overrides.runId || 'arcade-g32-l0-local-prompt-policy-s0',
    gameId: overrides.gameId ?? 32,
    gameName: overrides.gameName || 'doorkoban',
    levelId: overrides.levelId ?? 0,
    modelId: overrides.modelId || 'local-prompt-policy',
    modelName: overrides.modelName || 'local-prompt-policy',
    strategyId: overrides.strategyId || 'safe',
    strategyLabel: overrides.strategyLabel || 'Play it safe',
    finalScore: overrides.finalScore ?? 1,
    ticks: overrides.ticks ?? 50,
    winner: overrides.winner || 'PLAYER_LOSES',
    won: overrides.won ?? overrides.winner === 'PLAYER_WINS',
    nilActionLoop: overrides.nilActionLoop || false,
    promptChars: overrides.promptChars ?? 100,
    actions: overrides.actions || ['ACTION_RIGHT']
  };
}

function gateFor(baselineResult, digestResult, errors = {}) {
  return comparePairedResults({
    baselineResults: [baselineResult],
    digestResults: [digestResult],
    baselineErrors: errors.baselineErrors || [],
    digestErrors: errors.digestErrors || []
  }).games[0];
}

test('gate accepts a marked score improvement without prompt growth', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100 }),
    run({ finalScore: 2, ticks: 50, promptChars: 100 })
  );

  assert.equal(gate.accepted, true);
  assert.ok(gate.reasons.includes('gameplay gain'));
});

test('gate accepts equal gameplay with a significant prompt reduction', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100 }),
    run({ finalScore: 1, ticks: 50, promptChars: 80 })
  );

  assert.equal(gate.accepted, true);
  assert.ok(gate.reasons.includes('equal gameplay with prompt reduction'));
});

test('gate rejects when there is no marked gain', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100 }),
    run({ finalScore: 1, ticks: 50, promptChars: 95 })
  );

  assert.equal(gate.accepted, false);
  assert.ok(gate.blockers.includes('no marked gameplay or efficiency gain'));
});

test('gate rejects a new nil action loop', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100, nilActionLoop: false }),
    run({ finalScore: 4, ticks: 80, promptChars: 100, nilActionLoop: true })
  );

  assert.equal(gate.accepted, false);
  assert.ok(gate.blockers.some(reason => reason.includes('new nil action loop')));
});

test('gate rejects a winner downgrade', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100, winner: 'PLAYER_WINS', won: true }),
    run({ finalScore: 4, ticks: 80, promptChars: 100, winner: 'PLAYER_LOSES', won: false })
  );

  assert.equal(gate.accepted, false);
  assert.ok(gate.blockers.some(reason => reason.includes('winner downgrade')));
});

test('gate rejects higher digest-memory error count', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100 }),
    run({ finalScore: 4, ticks: 80, promptChars: 100 }),
    {
      baselineErrors: [],
      digestErrors: [{ gameId: 32, runId: 'arcade-g32-l0-local-prompt-policy-s0', message: 'timeout' }]
    }
  );

  assert.equal(gate.accepted, false);
  assert.ok(gate.blockers.some(reason => reason.includes('higher error count')));
});

test('gate rejects excessive prompt growth', () => {
  const gate = gateFor(
    run({ finalScore: 1, ticks: 50, promptChars: 100 }),
    run({ finalScore: 4, ticks: 80, promptChars: 120 })
  );

  assert.equal(gate.accepted, false);
  assert.ok(gate.blockers.some(reason => reason.includes('prompt chars ratio')));
});
