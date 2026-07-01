const assert = require('node:assert/strict');
const test = require('node:test');

const { parseAction, parseStructured } = require('../lib/response-parser');

test('parseAction maps ACTION_SHOOT to ACTION_USE when shooting is available', () => {
  assert.equal(
    parseAction('ACTION_SHOOT', ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']),
    'ACTION_USE'
  );
});

test('parseStructured maps ACTION_SHOOT in the action field to ACTION_USE', () => {
  const parsed = parseStructured(
    'REASON: shoot the low alien.\nACTION: ACTION_SHOOT',
    ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.equal(parsed.action, 'ACTION_USE');
  assert.equal(parsed.reason, 'shoot the low alien.');
});

test('parseStructured accepts an exact compact action code before prose parsing', () => {
  const parsed = parseStructured(
    'U',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_USE');
  assert.equal(parsed.reason, '');
});

test('parseStructured accepts a compact OUT code response', () => {
  const parsed = parseStructured(
    'OUT: U',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_USE');
  assert.equal(parsed.reason, '');
});

test('parseStructured accepts a compact ANS code response', () => {
  const parsed = parseStructured(
    'ANS: R',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_RIGHT');
  assert.equal(parsed.reason, '');
});

test('parseStructured accepts an encoded best-action field from echoed GV1 tape', () => {
  const parsed = parseStructured(
    'GV1\nA:N,L,R,U\nB:R\nANS:',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_RIGHT');
  assert.equal(parsed.valid, true);
});

test('parseStructured marks invalid compact output separately from intentional NIL', () => {
  const parsed = parseStructured(
    'GV1 A:L,',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_NIL');
  assert.equal(parsed.valid, false);
});

test('parseStructured ignores compact action code letters inside prose', () => {
  const parsed = parseStructured(
    'Use the right lane',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    { N: 'ACTION_NIL', L: 'ACTION_LEFT', R: 'ACTION_RIGHT', U: 'ACTION_USE' }
  );

  assert.equal(parsed.action, 'ACTION_RIGHT');
});

test('parseStructured extracts a multi-step PLAN line in order with aliases', () => {
  const parsed = parseStructured(
    'REASON: slide under the alien column and fire.\nPLAN: LEFT, LEFT, SHOOT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_USE']);
  assert.equal(parsed.action, 'ACTION_LEFT');
  assert.equal(parsed.reason, 'slide under the alien column and fire.');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.planSource, 'plan-line');
});

test('parseStructured keeps a truncated PLAN as a valid prefix', () => {
  const parsed = parseStructured(
    'REASON: dodge.\nPLAN: LEFT, LE',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT']);
  assert.equal(parsed.action, 'ACTION_LEFT');
  assert.equal(parsed.valid, true);
});

test('parseStructured falls back to single-action when no PLAN marker exists', () => {
  const parsed = parseStructured(
    'REASON: retreat.\nACTION: RIGHT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_RIGHT']);
  assert.equal(parsed.planSource, 'single-action');
});

test('parseStructured prefers whichever of PLAN/ACTION comes last', () => {
  const planLast = parseStructured(
    'ACTION: LEFT\nPLAN: RIGHT, RIGHT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );
  assert.deepEqual(planLast.plan, ['ACTION_RIGHT', 'ACTION_RIGHT']);

  const actionLast = parseStructured(
    'PLAN: RIGHT, RIGHT\nACTION: LEFT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );
  assert.deepEqual(actionLast.plan, ['ACTION_LEFT']);
  assert.equal(actionLast.planSource, 'single-action');
});

test('parseStructured filters invalid and unavailable PLAN tokens', () => {
  const parsed = parseStructured(
    'PLAN: LEFT, BANANA, UP, SHOOT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT', 'ACTION_USE']);
});

test('parseStructured caps PLAN length at maxPlanSteps', () => {
  const parsed = parseStructured(
    'PLAN: LEFT, LEFT, LEFT, LEFT, LEFT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    null,
    { maxPlanSteps: 3 }
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_LEFT']);
});

test('parseStructured PLAN scan stays on the plan line and skips trailing prose', () => {
  const parsed = parseStructured(
    'PLAN: LEFT, SHOOT\nThe enemy on the RIGHT will then fall.',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT', 'ACTION_USE']);
});

test('parseStructured splits PLAN steps on THEN and arrows too', () => {
  const parsed = parseStructured(
    'PLAN: LEFT then LEFT → SHOOT',
    ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
  );

  assert.deepEqual(parsed.plan, ['ACTION_LEFT', 'ACTION_LEFT', 'ACTION_USE']);
});

test('parseStructured returns a NIL plan for empty and garbage responses', () => {
  const empty = parseStructured('', ['ACTION_NIL', 'ACTION_LEFT']);
  assert.deepEqual(empty.plan, ['ACTION_NIL']);
  assert.equal(empty.valid, false);

  const garbage = parseStructured('PLAN: banana, kiwi', ['ACTION_NIL', 'ACTION_LEFT']);
  assert.deepEqual(garbage.plan, ['ACTION_NIL']);
  assert.equal(garbage.valid, false);
});
