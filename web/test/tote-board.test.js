const assert = require('node:assert/strict');
const test = require('node:test');

const telemetry = require('../lib/telemetry-store');

const caseEvent = (modelId, payload) => ({ event_type: 'marble_case_completed', model_id: modelId, payload });

const events = [
  caseEvent('gpt-oss:120b', { won: true, finalScore: 5, adherenceLabel: 'Strongly followed', provider: 'ollama-cloud', strategyId: 'safe', strategyLabel: 'Play it safe' }),
  caseEvent('gpt-oss:120b', { won: false, finalScore: 1, adherenceLabel: 'Drifted', provider: 'openrouter', strategyId: 'points', strategyLabel: 'Go for points' }),
  caseEvent('deepseek-v3.1:671b', { won: false, finalScore: 2, adherenceLabel: 'Partially followed', provider: 'ollama-cloud', strategyId: 'safe', strategyLabel: 'Play it safe' }),
  { event_type: 'run_summary', model_id: 'x', payload: { won: true } } // non-marble evt: ignored
];

test('marbleRun aggregates only marble_case_completed events', () => {
  const mr = telemetry.marbleRun(events);
  assert.equal(mr.totalCases, 3);
});

test('per-model standings compute win rate, mean score, adherence + fallback rates', () => {
  const mr = telemetry.marbleRun(events);
  const gpt = mr.standings.find(s => s.modelId === 'gpt-oss:120b');
  assert.equal(gpt.runs, 2);
  assert.equal(gpt.winRate, 50);       // 1 win of 2
  assert.equal(gpt.meanScore, 3);      // (5 + 1) / 2
  assert.equal(gpt.strongAdherenceRate, 50); // 1 "Strongly followed" of 2
  assert.equal(gpt.fallbackRate, 50);  // 1 openrouter answer of 2
});

test('standings sort by win rate then mean score', () => {
  const mr = telemetry.marbleRun(events);
  assert.equal(mr.standings[0].modelId, 'gpt-oss:120b'); // 50% > 0%
});

test('strategy-effect breakdown groups by strategy', () => {
  const mr = telemetry.marbleRun(events);
  const safe = mr.byStrategy.find(s => s.strategyId === 'safe');
  assert.equal(safe.runs, 2);
  assert.equal(safe.meanScore, 3.5);   // (5 + 2) / 2
  assert.equal(safe.label, 'Play it safe');
});

test('empty input yields an empty board, not an error', () => {
  const mr = telemetry.marbleRun([]);
  assert.equal(mr.totalCases, 0);
  assert.deepEqual(mr.standings, []);
  assert.deepEqual(mr.byStrategy, []);
});
