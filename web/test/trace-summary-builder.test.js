'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModules(tempDir) {
  process.env.GVGAI_TRACE_DIR = tempDir;
  delete require.cache[require.resolve('../lib/play-trace-store')];
  delete require.cache[require.resolve('../lib/trace-summary-builder')];
  const traceStore = require('../lib/play-trace-store');
  const builder = require('../lib/trace-summary-builder');
  return { traceStore, builder };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-summary-test-'));
}

function makeHumanTrace(overrides = {}) {
  return {
    gameId: 5,
    gameName: 'aliens',
    levelId: 0,
    playerType: 'human',
    modelId: null,
    strategy: null,
    finalScore: 100,
    winner: 'PLAYER',
    won: true,
    ticks: 200,
    actionCount: 50,
    actionHistory: [
      { tick: 0, action: 'ACTION_USE', score: 0, health: 100, scoreDelta: 0 },
      { tick: 1, action: 'ACTION_LEFT', score: 0, health: 100, scoreDelta: 0 },
      { tick: 2, action: 'ACTION_USE', score: 10, health: 100, scoreDelta: 10 },
      { tick: 3, action: 'ACTION_RIGHT', score: 10, health: 100, scoreDelta: 0 },
      { tick: 4, action: 'ACTION_USE', score: 20, health: 100, scoreDelta: 10 }
    ],
    scoreEvents: [
      { tick: 2, action: 'ACTION_USE', scoreDelta: 10 },
      { tick: 4, action: 'ACTION_USE', scoreDelta: 10 }
    ],
    ...overrides
  };
}

test('1. buildTraceSummary returns null when no traces exist for a game', () => {
  const tempDir = makeTempDir();
  const { builder } = freshModules(tempDir);

  const result = builder.buildTraceSummary(999);
  assert.equal(result, null);
});

test('2. buildTraceSummary returns a text summary when human traces exist', () => {
  const tempDir = makeTempDir();
  const { traceStore, builder } = freshModules(tempDir);

  traceStore.saveTrace(makeHumanTrace({ finalScore: 150 }));
  traceStore.saveTrace(makeHumanTrace({ finalScore: 100 }));

  const result = builder.buildTraceSummary(5);
  assert.ok(result, 'should return a summary object');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0, 'text should not be empty');
  assert.equal(result.traceCount, 2);
  assert.equal(result.bestScore, 150);
  // text should mention best score
  assert.match(result.text, /150/);
  // text should include action names from the trace
  assert.match(result.text, /ACTION_USE/);
});

test('3. buildTraceSummary returns null when only LLM traces exist', () => {
  const tempDir = makeTempDir();
  const { traceStore, builder } = freshModules(tempDir);

  traceStore.saveTrace(makeHumanTrace({
    playerType: 'llm',
    modelId: 'gpt-4o',
    finalScore: 80,
    won: false
  }));

  const result = builder.buildTraceSummary(5);
  assert.equal(result, null);
});

test('4. buildTraceSummary includes win rate in the text', () => {
  const tempDir = makeTempDir();
  const { traceStore, builder } = freshModules(tempDir);

  // 2 wins, 1 loss => 67% win rate
  traceStore.saveTrace(makeHumanTrace({ finalScore: 150, won: true }));
  traceStore.saveTrace(makeHumanTrace({ finalScore: 100, won: true }));
  traceStore.saveTrace(makeHumanTrace({ finalScore: 20, won: false }));

  const result = builder.buildTraceSummary(5);
  assert.ok(result);
  assert.equal(result.winRate, 2 / 3);
  // text should mention win rate percentage
  assert.match(result.text, /Win rate:\s*\d+%/);
});