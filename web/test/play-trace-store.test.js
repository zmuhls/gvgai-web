'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshModule(tempDir) {
  process.env.GVGAI_TRACE_DIR = tempDir;
  delete require.cache[require.resolve('../lib/play-trace-store')];
  return require('../lib/play-trace-store');
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'play-trace-test-'));
}

function makeTrace(overrides = {}) {
  return {
    gameId: 0,
    gameName: 'aliens',
    levelId: 0,
    playerType: 'human',
    modelId: null,
    strategy: null,
    finalScore: 100,
    winner: 'PLAYER',
    won: true,
    ticks: 100,
    actionCount: 50,
    actionHistory: [{ tick: 0, action: 'ACTION_USE' }],
    scoreEvents: [{ tick: 10, score: 10 }],
    ...overrides
  };
}

test('1. saveTrace stores a trace and returns it with a traceId', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  const trace = makeTrace({ finalScore: 200, actionHistory: [{ tick: 0, action: 'ACTION_NIL' }] });
  const saved = store.saveTrace(trace);

  assert.ok(saved.traceId, 'saved trace should have a traceId');
  assert.match(saved.traceId, /^trace-\d+-[a-z0-9]{6}$/, 'traceId should match pattern trace-{timestamp}-{random6}');
  assert.equal(saved.finalScore, 200);
  assert.equal(saved.actionHistory.length, 1);
  assert.equal(saved.gameId, 0);
  assert.ok(saved.createdAt, 'saved trace should have createdAt');

  // File should exist on disk
  const filePath = path.join(tempDir, '0', `${saved.traceId}.json`);
  assert.ok(fs.existsSync(filePath), 'trace file should exist on disk');
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.equal(onDisk.traceId, saved.traceId);
  assert.equal(onDisk.finalScore, 200);
  assert.deepEqual(onDisk.actionHistory, trace.actionHistory);

  // Index should exist
  const indexPath = path.join(tempDir, '_index.json');
  assert.ok(fs.existsSync(indexPath), 'index file should exist');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  assert.ok(index.traces['0'], 'index should have traces for gameId 0');
  assert.equal(index.traces['0'].length, 1);
  assert.equal(index.traces['0'][0].traceId, saved.traceId);
  // Index entries should NOT have actionHistory
  assert.equal(index.traces['0'][0].actionHistory, undefined);
});

test('2. getTracesForGame returns traces sorted by score descending', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  store.saveTrace(makeTrace({ finalScore: 100 }));
  store.saveTrace(makeTrace({ finalScore: 300 }));
  store.saveTrace(makeTrace({ finalScore: 200 }));

  const traces = store.getTracesForGame(0);
  assert.equal(traces.length, 3);
  assert.equal(traces[0].finalScore, 300);
  assert.equal(traces[1].finalScore, 200);
  assert.equal(traces[2].finalScore, 100);
  // Should be summaries, not full traces
  assert.equal(traces[0].actionHistory, undefined);
});

test('3. getBestHumanTraces filters by playerType=human', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  store.saveTrace(makeTrace({ playerType: 'human', finalScore: 150 }));
  store.saveTrace(makeTrace({ playerType: 'llm', finalScore: 500 }));
  store.saveTrace(makeTrace({ playerType: 'human', finalScore: 300 }));
  store.saveTrace(makeTrace({ playerType: 'human', finalScore: 200 }));

  const humanTraces = store.getBestHumanTraces(0, 2);
  assert.equal(humanTraces.length, 2);
  assert.equal(humanTraces[0].finalScore, 300);
  assert.equal(humanTraces[1].finalScore, 200);
  assert.equal(humanTraces[0].playerType, 'human');
  assert.equal(humanTraces[1].playerType, 'human');

  // Also test getBestTraces returns all player types
  const allBest = store.getBestTraces(0, 2);
  assert.equal(allBest.length, 2);
  assert.equal(allBest[0].finalScore, 500);
  assert.equal(allBest[1].finalScore, 300);

  // Also test options.playerType filter on getTracesForGame
  const llmTraces = store.getTracesForGame(0, { playerType: 'llm' });
  assert.equal(llmTraces.length, 1);
  assert.equal(llmTraces[0].playerType, 'llm');
});

test('4. getTraceStats returns aggregate statistics', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  store.saveTrace(makeTrace({ playerType: 'human', finalScore: 100, won: true }));
  store.saveTrace(makeTrace({ playerType: 'human', finalScore: 200, won: true }));
  store.saveTrace(makeTrace({ playerType: 'llm', finalScore: 300, won: false }));
  store.saveTrace(makeTrace({ playerType: 'llm', finalScore: 400, won: true }));

  const stats = store.getTraceStats(0);
  assert.equal(stats.traceCount, 4);
  assert.equal(stats.bestScore, 400);
  assert.equal(stats.averageScore, 250);
  assert.equal(stats.winRate, 0.75); // 3 of 4 won
  assert.equal(stats.humanTraceCount, 2);
  assert.equal(stats.llmTraceCount, 2);

  // No traces for unknown game
  const emptyStats = store.getTraceStats(999);
  assert.equal(emptyStats, null);
});

test('5. getTrace loads a full trace by traceId including actionHistory', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  const actionHistory = [
    { tick: 0, action: 'ACTION_NIL' },
    { tick: 1, action: 'ACTION_USE' },
    { tick: 2, action: 'ACTION_LEFT' }
  ];
  const scoreEvents = [{ tick: 5, score: 10 }];
  const saved = store.saveTrace(makeTrace({ finalScore: 150, actionHistory, scoreEvents }));

  const loaded = store.getTrace(0, saved.traceId);
  assert.ok(loaded);
  assert.equal(loaded.traceId, saved.traceId);
  assert.equal(loaded.finalScore, 150);
  assert.deepEqual(loaded.actionHistory, actionHistory);
  assert.deepEqual(loaded.scoreEvents, scoreEvents);
  assert.equal(loaded.gameId, 0);
});

test('6. clearCache forces a fresh read from disk', () => {
  const tempDir = makeTempDir();
  const store = freshModule(tempDir);

  store.saveTrace(makeTrace({ finalScore: 100 }));
  // Read once to populate cache
  let traces = store.getTracesForGame(0);
  assert.equal(traces.length, 1);

  // Manually write a second trace file + update index directly on disk
  // (simulating an external process writing)
  const indexFile = path.join(tempDir, '_index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  const fakeEntry = {
    traceId: 'trace-manual-abcdef',
    gameId: 0,
    gameName: 'aliens',
    levelId: 0,
    playerType: 'human',
    modelId: null,
    finalScore: 500,
    won: true,
    ticks: 50,
    actionCount: 25,
    createdAt: new Date().toISOString()
  };
  index.traces['0'].push(fakeEntry);
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');

  // Without clearing cache, we might still get stale data — but TTL is 60s
  // so it would still be cached. After clearCache, we get fresh data.
  store.clearCache();
  traces = store.getTracesForGame(0);
  assert.equal(traces.length, 2, 'should see externally-added trace after cache clear');
  assert.equal(traces[0].finalScore, 500, 'highest score should be first');
});