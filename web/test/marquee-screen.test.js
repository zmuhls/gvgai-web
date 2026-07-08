const assert = require('node:assert/strict');
const test = require('node:test');

const { shouldShowAttract } = require('../public/js/marquee-screen.js');

test('attract shows when no active case is playing', () => {
  assert.equal(shouldShowAttract('IDLE', false), true);
  assert.equal(shouldShowAttract('IDLE', true), true);
  assert.equal(shouldShowAttract('YIELDING', true), true);
  assert.equal(shouldShowAttract('RESUMING', true), true);
  assert.equal(shouldShowAttract('WALKUP_PLAYING', true), true);
});

test('attract shows while an active case is loading its first frame', () => {
  assert.equal(shouldShowAttract('MARBLE_STARTING', false), true);
  assert.equal(shouldShowAttract('MARBLE_PLAYING', false), true);
});

test('live frame holds during active play once a frame has arrived', () => {
  // Regression for the "attract template shows while the model is actively
  // playing" bug: with multi-second gaps between LLM moves, the display must
  // NOT flip back to the attract template while a live board is on screen.
  assert.equal(shouldShowAttract('MARBLE_PLAYING', true), false);
});
