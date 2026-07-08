const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FINISH_TRAINING_RESPONSE,
  nextLevelResponse
} = require('../lib/level-progression');

test('nextLevelResponse repeats the current level when the player loses', () => {
  assert.deepEqual(nextLevelResponse(2, 'PLAYER_LOSES'), {
    response: '2',
    currentLevel: 2,
    nextLevelId: 2,
    won: false,
    finished: false
  });
});

test('nextLevelResponse advances to the next level only after a win', () => {
  assert.deepEqual(nextLevelResponse(2, 'PLAYER_WINS'), {
    response: '3',
    currentLevel: 2,
    nextLevelId: 3,
    won: true,
    finished: false
  });
});

test('nextLevelResponse finishes training after a win on the final level', () => {
  assert.deepEqual(nextLevelResponse(4, 'PLAYER_WINS'), {
    response: FINISH_TRAINING_RESPONSE,
    currentLevel: 4,
    nextLevelId: null,
    won: true,
    finished: true
  });
});
