'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureSso = require('./fixtures/finetune/sso-tick.json');
const { pairsFromTrace, downsampleNil, PrepareError } = require('../scripts/prepare-finetune-data');

function prunedSso(overrides = {}) {
  const { imageArray, ...rest } = fixtureSso;
  return { ...rest, ...overrides };
}

function makeEntry(overrides = {}) {
  return {
    tick: 0,
    action: 'ACTION_USE',
    score: 0,
    health: 100,
    scoreDelta: 0,
    sso: prunedSso(),
    ...overrides
  };
}

const BASE_CONFIG = {
  systemContent: 'You are playing a 2D grid game.',
  gameName: 'testgame',
  codeProtocol: null
};

test('pairsFromTrace produces chat-messages pairs from SSO entries', () => {
  const trace = {
    gameId: 9999,
    actionHistory: [
      makeEntry({ tick: 0, action: 'ACTION_USE', sso: prunedSso({ gameTick: 0 }) }),
      makeEntry({ tick: 1, action: 'ACTION_LEFT', sso: prunedSso({ gameTick: 1, gameScore: 3 }) })
    ]
  };

  const pairs = pairsFromTrace(trace, BASE_CONFIG);

  assert.equal(pairs.length, 2);
  const first = pairs[0].messages;
  assert.equal(first[0].role, 'system');
  assert.equal(first[1].role, 'user');
  assert.ok(first[1].content.includes('ACTION_USE'), 'user prompt lists available actions');
  assert.equal(first[2].role, 'assistant');
  assert.equal(first[2].content, 'ACTION_USE');
  assert.equal(pairs[1].messages[2].content, 'ACTION_LEFT');
});

test('pairsFromTrace skips entries without SSO', () => {
  const trace = {
    gameId: 9999,
    actionHistory: [
      { tick: 0, action: 'ACTION_USE', score: 0 },
      makeEntry({ tick: 1, action: 'ACTION_RIGHT' })
    ]
  };

  const pairs = pairsFromTrace(trace, BASE_CONFIG);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].action, 'ACTION_RIGHT');
});

test('pairsFromTrace consecutive-dedup never increases pair count', () => {
  const entries = Array.from({ length: 6 }, () => makeEntry());
  const trace = { gameId: 9999, actionHistory: entries };

  const withDedup = pairsFromTrace(trace, BASE_CONFIG, { deduplicate: true });
  const withoutDedup = pairsFromTrace(trace, BASE_CONFIG, { deduplicate: false });

  assert.equal(withoutDedup.length, 6);
  assert.ok(withDedup.length <= withoutDedup.length);
  assert.ok(withDedup.length >= 1);
});

test('downsampleNil caps ACTION_NIL at the requested ratio deterministically', () => {
  const pairs = [
    ...Array.from({ length: 10 }, (_, i) => ({ action: 'ACTION_NIL', messages: [], i })),
    { action: 'ACTION_USE', messages: [] },
    { action: 'ACTION_LEFT', messages: [] },
    { action: 'ACTION_RIGHT', messages: [] }
  ];

  const sampled = downsampleNil(pairs, 0.3);
  const nilKept = sampled.filter(p => p.action === 'ACTION_NIL').length;

  assert.equal(sampled.length, 4);
  assert.equal(nilKept, 1);
  assert.ok(nilKept / sampled.length <= 0.3);
  // Deterministic: same input, same output
  assert.deepEqual(downsampleNil(pairs, 0.3), sampled);
});

test('downsampleNil leaves balanced or all-NIL sets alone', () => {
  const balanced = [
    { action: 'ACTION_NIL', messages: [] },
    { action: 'ACTION_USE', messages: [] },
    { action: 'ACTION_LEFT', messages: [] }
  ];
  assert.equal(downsampleNil(balanced, 0.5).length, 3);

  const allNil = Array.from({ length: 5 }, () => ({ action: 'ACTION_NIL', messages: [] }));
  assert.equal(downsampleNil(allNil, 0.3).length, 5);
});

// --- store-backed prepareFinetuneData (env-isolated trace dir) ---

function freshModules(tempDir) {
  process.env.GVGAI_TRACE_DIR = tempDir;
  delete require.cache[require.resolve('../lib/play-trace-store')];
  delete require.cache[require.resolve('../scripts/prepare-finetune-data')];
  return {
    store: require('../lib/play-trace-store'),
    prep: require('../scripts/prepare-finetune-data')
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-prep-test-'));
}

function seedTrace(store, entries, overrides = {}) {
  return store.saveTrace({
    gameId: 9999,
    gameName: 'testgame',
    levelId: 0,
    playerType: 'human',
    finalScore: 5,
    winner: 'PLAYER_WINS',
    won: true,
    ticks: entries.length,
    actionCount: entries.length,
    actionHistory: entries,
    scoreEvents: [],
    ...overrides
  });
}

test('prepareFinetuneData throws NO_TRACES on an empty store', () => {
  const { prep } = freshModules(makeTempDir());

  assert.throws(
    () => prep.prepareFinetuneData({ gameId: 9999, write: false }),
    err => err.code === 'NO_TRACES'
  );
});

test('prepareFinetuneData throws NO_SSO when traces predate SSO capture', () => {
  const tempDir = makeTempDir();
  const { store, prep } = freshModules(tempDir);
  seedTrace(store, [{ tick: 0, action: 'ACTION_USE', score: 0 }]);

  assert.throws(
    () => prep.prepareFinetuneData({ gameId: 9999, write: false }),
    err => err.code === 'NO_SSO'
  );
});

test('prepareFinetuneData throws TOO_FEW_EXAMPLES below minExamples', () => {
  const tempDir = makeTempDir();
  const { store, prep } = freshModules(tempDir);
  seedTrace(store, [makeEntry()]);

  assert.throws(
    () => prep.prepareFinetuneData({ gameId: 9999, minExamples: 50, write: false }),
    err => err.code === 'TOO_FEW_EXAMPLES'
  );
});

test('prepareFinetuneData writes a valid JSONL and reports stats', () => {
  const tempDir = makeTempDir();
  const { store, prep } = freshModules(tempDir);
  const actions = ['ACTION_USE', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'];
  seedTrace(store, actions.map((action, i) =>
    makeEntry({ tick: i, action, sso: prunedSso({ gameTick: i, gameScore: i }) })));
  seedTrace(store, actions.map((action, i) =>
    makeEntry({ tick: i, action, sso: prunedSso({ gameTick: i, gameScore: i + 1 }) })));
  const outPath = path.join(tempDir, 'out.jsonl');

  const stats = prep.prepareFinetuneData({ gameId: 9999, minExamples: 4, output: outPath });

  assert.equal(stats.traceCount, 2);
  assert.equal(stats.skippedTraces, 0);
  assert.equal(stats.exampleCount, 8);
  assert.equal(stats.actionDistribution.ACTION_USE, 4);
  assert.equal(stats.jsonlPath, outPath);

  const lines = fs.readFileSync(outPath, 'utf-8').trim().split('\n');
  assert.equal(lines.length, 8);
  for (const line of lines) {
    const row = JSON.parse(line);
    assert.ok(Array.isArray(row.messages));
    const last = row.messages[row.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.match(last.content, /^ACTION_[A-Z]+$/);
  }
});
