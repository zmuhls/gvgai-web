'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const archive = require('../lib/trace-archive');

const SAMPLE = {
  traceId: 'trace-1753500000000-abc123',
  gameId: 0,
  gameName: 'aliens',
  levelId: 0,
  playerType: 'human',
  modelId: null,
  finalScore: 12,
  won: true,
  ticks: 88,
  actionCount: 88,
  actionHistory: [{ tick: 1, action: 'ACTION_USE', sso: { gameTick: 1 } }],
  createdAt: '2026-07-26T05:00:00.000Z'
};

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    }
  };
}

test('isConfigured follows DATABASE_URL', () => {
  assert.equal(archive.isConfigured({}), false);
  assert.equal(archive.isConfigured({ DATABASE_URL: '  ' }), false);
  assert.equal(archive.isConfigured({ DATABASE_URL: 'postgres://x' }), true);
});

test('archiveTrace upserts by trace_id with the full record as payload', async () => {
  const pool = fakePool();
  await archive.archiveTrace(SAMPLE, { pool });

  assert.equal(pool.calls.length, 1);
  const { text, params } = pool.calls[0];
  assert.match(text, /INSERT INTO play_traces/);
  assert.match(text, /ON CONFLICT \(trace_id\) DO NOTHING/);
  assert.equal(params[0], SAMPLE.traceId);
  assert.equal(params[1], SAMPLE.gameId);
  assert.equal(params[4], 'human');
  assert.equal(params[7], true);
  // The payload column carries the complete record, action history included.
  const payload = JSON.parse(params[11]);
  assert.equal(payload.actionHistory.length, 1);
  assert.equal(payload.actionHistory[0].sso.gameTick, 1);
});

test('fetchTraceSummaries filters by game and player type without payloads', async () => {
  const pool = fakePool();
  await archive.fetchTraceSummaries({ gameId: 0, playerType: 'human', pool });

  const { text, params } = pool.calls[0];
  assert.match(text, /game_id = \$1/);
  assert.match(text, /player_type = \$2/);
  assert.ok(!/payload/.test(text), 'summary query must not drag payloads');
  assert.deepEqual(params, [0, 'human']);
});

test('importTrace preserves traceId, updates the index, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-import-test-'));
  const prior = process.env.GVGAI_TRACE_DIR;
  process.env.GVGAI_TRACE_DIR = dir;
  const traceStore = require('../lib/play-trace-store');
  traceStore.clearCache();
  try {
    assert.equal(traceStore.importTrace(SAMPLE), true);
    assert.equal(traceStore.importTrace(SAMPLE), false, 'second import is a no-op');

    const stored = traceStore.getTrace(SAMPLE.gameId, SAMPLE.traceId);
    assert.equal(stored.traceId, SAMPLE.traceId, 'original id survives import');
    const listed = traceStore.getTracesForGame(SAMPLE.gameId, { playerType: 'human' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].traceId, SAMPLE.traceId);
  } finally {
    if (prior === undefined) delete process.env.GVGAI_TRACE_DIR;
    else process.env.GVGAI_TRACE_DIR = prior;
    traceStore.clearCache();
  }
});

// Live round-trip against a real database; skipped unless TEST_DATABASE_URL is
// set (same convention as cadavre-wall-postgres.integration.test.js).
const databaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();
const integrationTest = databaseUrl ? test : test.skip;

integrationTest('Postgres archive round-trips a trace', async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  t.after(async () => {
    await pool.query('DELETE FROM play_traces WHERE trace_id = $1', [SAMPLE.traceId]);
    await pool.end();
  });

  await archive.archiveTrace(SAMPLE, { pool });
  await archive.archiveTrace(SAMPLE, { pool }); // idempotent

  const rows = await archive.fetchTraceSummaries({ gameId: SAMPLE.gameId, playerType: 'human', pool });
  assert.equal(rows.filter(r => r.trace_id === SAMPLE.traceId).length, 1);

  const payload = await archive.fetchTrace(SAMPLE.traceId, { pool });
  assert.equal(payload.traceId, SAMPLE.traceId);
  assert.equal(payload.actionHistory.length, 1);
});
