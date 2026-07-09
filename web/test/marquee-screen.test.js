const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { shouldShowAttract, resolveScreen } = require('../public/js/marquee-screen.js');

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

test('case boundaries show the interstitial card, never the attract template', () => {
  // Regression for the case-boundary flash: between cases in an ongoing run
  // the display holds a quiet interstitial over the last frame instead of
  // strobing to the full attract loop.
  assert.equal(resolveScreen('MARBLE_STARTING', false, true), 'interstitial');
  assert.equal(resolveScreen('MARBLE_PLAYING', false, true), 'interstitial');
});

test('resolveScreen: live wins over boundary state; attract only when truly idle', () => {
  assert.equal(resolveScreen('MARBLE_PLAYING', true, true), 'live');
  assert.equal(resolveScreen('MARBLE_PLAYING', true, false), 'live');
  assert.equal(resolveScreen('IDLE', true, true), 'attract');
  assert.equal(resolveScreen('WALKUP_PLAYING', true, true), 'attract');
  assert.equal(resolveScreen('MARBLE_PLAYING', false, false), 'attract'); // first-ever load
});

test('compact embed never cover-crops the game canvas', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'marquee.html'), 'utf8');
  const embedCanvasRule = html.match(/html\.marquee-embed canvas \{(?<body>[^}]+)\}/);
  if (embedCanvasRule) {
    assert.doesNotMatch(embedCanvasRule.groups.body, /object-fit:\s*cover/);
  }
});

test('compact embed screen is not capped by the narrow-page breakpoint', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'marquee.html'), 'utf8');
  const compactScreenRule = html.match(/html\.marquee-embed:not\(\.marquee-full\) \.screen \{(?<body>[^}]+)\}/);

  assert.ok(compactScreenRule, 'compact embed screen override is present');
  assert.match(compactScreenRule.groups.body, /height:\s*100%;/);
  assert.match(compactScreenRule.groups.body, /min-height:\s*0;/);
  assert.match(compactScreenRule.groups.body, /max-height:\s*none;/);
});
