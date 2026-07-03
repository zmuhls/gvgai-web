const assert = require('node:assert/strict');
const test = require('node:test');

const HumanPlayClient = require('../lib/human-play-client');

test('HumanPlayClient can be instantiated with default values', () => {
  const client = new HumanPlayClient();

  assert.equal(client.pendingAction, 'ACTION_NIL');
  assert.equal(client.playerType, 'human');
  assert.equal(client.gameActive, false);
  assert.deepEqual(client.actionHistory, []);
  assert.equal(client.runStartScore, null);
  assert.equal(client.levelCount, 0);
  assert.equal(client.buffer, '');
});

test('HumanPlayClient accepts optional runId via constructor', () => {
  const client = new HumanPlayClient({ runId: 'custom-run-42' });

  assert.equal(client.runId, 'custom-run-42');
});

test('setAction updates pendingAction when gameActive', () => {
  const client = new HumanPlayClient();
  client.gameActive = true;

  client.setAction('ACTION_RIGHT');
  assert.equal(client.pendingAction, 'ACTION_RIGHT');

  client.setAction('ACTION_USE');
  assert.equal(client.pendingAction, 'ACTION_USE');
});

test('setAction ignored when game not active', () => {
  const client = new HumanPlayClient();
  // gameActive is false by default
  assert.equal(client.gameActive, false);

  client.setAction('ACTION_LEFT');
  assert.equal(client.pendingAction, 'ACTION_NIL', 'pendingAction should remain ACTION_NIL when game not active');

  // Now activate and verify it works
  client.gameActive = true;
  client.setAction('ACTION_LEFT');
  assert.equal(client.pendingAction, 'ACTION_LEFT');
});

test('getTrace returns action history with correct fields', () => {
  const client = new HumanPlayClient();
  client.gameId = 5;
  client.gameName = 'boulderdash';
  client.levelCount = 2;
  client.actionHistory = [
    { tick: 0, action: 'ACTION_RIGHT', score: 0, health: 100, scoreDelta: 0 },
    { tick: 1, action: 'ACTION_RIGHT', score: 10, health: 100, scoreDelta: 10 },
    { tick: 2, action: 'ACTION_USE', score: 10, health: 90, scoreDelta: 0 }
  ];

  const trace = client.getTrace();

  assert.equal(trace.gameId, 5);
  assert.equal(trace.gameName, 'boulderdash');
  assert.equal(trace.levelId, 2);
  assert.equal(trace.playerType, 'human');
  assert.deepEqual(trace.actionHistory, client.actionHistory);
  assert.equal(trace.finalScore, 10, 'finalScore should be last entry score');
});

test('playerType is "human"', () => {
  const client = new HumanPlayClient();
  assert.equal(client.playerType, 'human');
});

test('buildRunSummary produces summary with playerType human and provider human', () => {
  const client = new HumanPlayClient();
  client.gameId = 3;
  client.gameName = 'aliens';
  client.levelCount = 1;
  client.actionHistory = [
    { tick: 0, action: 'ACTION_RIGHT', score: 0, health: 100, scoreDelta: 0 },
    { tick: 5, action: 'ACTION_USE', score: 50, health: 80, scoreDelta: 50 }
  ];

  const sso = { gameScore: 50, gameWinner: 'PLAYER_WINS', gameTick: 100 };
  const summary = client.buildRunSummary(sso);

  assert.equal(summary.playerType, 'human');
  assert.equal(summary.provider, 'human');
  assert.equal(summary.finalScore, 50);
  assert.equal(summary.winner, 'PLAYER_WINS');
  assert.equal(summary.won, true);
  assert.equal(summary.ticks, 100);
  assert.equal(summary.level, 1);
  assert.deepEqual(summary.actions, ['ACTION_RIGHT', 'ACTION_USE']);
});