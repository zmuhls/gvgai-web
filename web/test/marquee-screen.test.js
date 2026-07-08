const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('compact embed screen is not capped by the narrow-page breakpoint', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'marquee.html'), 'utf8');
  const compactScreenRule = html.match(/html\.marquee-embed:not\(\.marquee-full\) \.screen \{(?<body>[^}]+)\}/);

  assert.ok(compactScreenRule, 'compact embed screen override is present');
  assert.match(compactScreenRule.groups.body, /height:\s*100%;/);
  assert.match(compactScreenRule.groups.body, /min-height:\s*0;/);
  assert.match(compactScreenRule.groups.body, /max-height:\s*none;/);
});
