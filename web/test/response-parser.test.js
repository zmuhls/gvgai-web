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
