'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  mapKeyToAction,
  buildControlReference,
  FULL_KEY_MAP,
} = require('../lib/key-mapping');

// 1. mapKeyToAction maps ArrowLeft to ACTION_LEFT
test('mapKeyToAction maps ArrowLeft to ACTION_LEFT', () => {
  assert.strictEqual(mapKeyToAction('ArrowLeft'), 'ACTION_LEFT');
});

// 2. mapKeyToAction returns null for unmapped keys
test('mapKeyToAction returns null for unmapped keys', () => {
  assert.strictEqual(mapKeyToAction('KeyQ'), null);
});

// 3. mapKeyToAction returns null when action not in availableActions
test('mapKeyToAction returns null when action not in availableActions', () => {
  // ArrowUp maps to ACTION_UP but game only has LEFT/RIGHT/USE
  const actions = ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE', 'ACTION_NIL'];
  assert.strictEqual(mapKeyToAction('ArrowUp', actions), null);
});

// 4. mapKeyToAction respects availableActions filter
test('mapKeyToAction respects availableActions filter', () => {
  const actions = ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE', 'ACTION_NIL'];
  assert.strictEqual(mapKeyToAction('ArrowLeft', actions), 'ACTION_LEFT');
  assert.strictEqual(mapKeyToAction('Space', actions), 'ACTION_USE');
});

// 5. WASD keys map to cardinal actions
test('WASD keys map to cardinal actions', () => {
  assert.strictEqual(mapKeyToAction('KeyA'), 'ACTION_LEFT');
  assert.strictEqual(mapKeyToAction('KeyD'), 'ACTION_RIGHT');
  assert.strictEqual(mapKeyToAction('KeyW'), 'ACTION_UP');
  assert.strictEqual(mapKeyToAction('KeyS'), 'ACTION_DOWN');
});

// 6. buildControlReference respects availableActions filter
test('buildControlReference respects availableActions filter', () => {
  const actions = ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'];
  const refs = buildControlReference(actions);
  const refActions = refs.map(r => r.action);
  assert.ok(!refActions.includes('ACTION_UP'), 'should not include ACTION_UP');
  assert.ok(!refActions.includes('ACTION_DOWN'), 'should not include ACTION_DOWN');
  assert.ok(refActions.includes('ACTION_LEFT'), 'should include ACTION_LEFT');
  assert.ok(refActions.includes('ACTION_RIGHT'), 'should include ACTION_RIGHT');
  assert.ok(refActions.includes('ACTION_USE'), 'should include ACTION_USE');
});

// 7. buildControlReference applies actionAliases for labels
test('buildControlReference applies actionAliases for labels', () => {
  const actions = ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE', 'ACTION_NIL'];
  const aliases = { ACTION_USE: 'SHOOT', ACTION_NIL: 'WAIT' };
  const refs = buildControlReference(actions, aliases);
  const useRef = refs.find(r => r.action === 'ACTION_USE');
  assert.ok(useRef, 'should have ACTION_USE entry');
  assert.strictEqual(useRef.label, 'SHOOT');
});

// 8. buildControlReference deduplicates keys mapping to same action
test('buildControlReference deduplicates keys mapping to same action', () => {
  const actions = ['ACTION_USE'];
  const refs = buildControlReference(actions);
  const useRef = refs.find(r => r.action === 'ACTION_USE');
  assert.ok(useRef, 'should have ACTION_USE entry');
  // Space, Enter, KeyZ, KeyX, KeyC all map to ACTION_USE
  assert.ok(useRef.keys.includes('SPACE'), 'should include SPACE');
  assert.ok(useRef.keys.includes('ENTER'), 'should include ENTER');
  assert.ok(useRef.keys.includes('Z'), 'should include Z');
  assert.ok(useRef.keys.includes('X'), 'should include X');
  assert.ok(useRef.keys.includes('C'), 'should include C');
  // Only one entry for ACTION_USE
  const useEntries = refs.filter(r => r.action === 'ACTION_USE');
  assert.strictEqual(useEntries.length, 1, 'should have exactly one ACTION_USE entry');
});

// Sanity: FULL_KEY_MAP is exported
test('FULL_KEY_MAP is exported and correct', () => {
  assert.strictEqual(FULL_KEY_MAP.ArrowLeft, 'ACTION_LEFT');
  assert.strictEqual(FULL_KEY_MAP.Space, 'ACTION_USE');
  assert.strictEqual(FULL_KEY_MAP.KeyW, 'ACTION_UP');
});