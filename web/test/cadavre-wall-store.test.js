const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CadavreWallStore, _private } = require('../lib/cadavre-wall-store');
const { boundedInteger } = require('../lib/postgres-pool');
const { importVolume, normalizeLegacyRow } = require('../scripts/import-cadavre-wall-volume');

function fakePool(query) {
  return { query };
}

test('shared wall inserts a hash and returns its delete token only to the creator', async () => {
  const calls = [];
  const pool = fakePool(async (sql, values) => {
    calls.push({ sql, values });
    return {
      rowCount: 1,
      rows: [{
        id: values[0],
        author_name: values[1],
        poem: values[2],
        analysis: values[3],
        created_at: new Date('2026-07-11T12:00:00.000Z')
      }]
    };
  });
  const store = new CadavreWallStore({}, { pool });

  const created = await store.create({ name: '  A.   Writer ', poem: 'a brass bird' });

  assert.equal(created.item.name, 'A. Writer');
  assert.equal(created.item.analysis, '');
  assert.equal(created.item.ts, '2026-07-11T12:00:00.000Z');
  assert.match(created.deleteToken, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(created.item), /deleteToken/i);
  assert.match(calls[0].sql, /INSERT INTO wall_posts/);
  assert.equal(calls[0].values[1], 'A. Writer');
  assert.equal(calls[0].values[4], crypto.createHash('sha256').update(created.deleteToken).digest('hex'));
  assert.notEqual(calls[0].values[4], created.deleteToken);
});

test('shared wall pages with the created-at and id index order', async () => {
  const rows = [
    {
      id: '123e4567-e89b-42d3-a456-426614174003',
      author_name: 'Third', poem: 'three', analysis: null,
      created_at: new Date('2026-07-11T12:03:00.000Z')
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174002',
      author_name: 'Second', poem: 'two', analysis: null,
      created_at: new Date('2026-07-11T12:02:00.000Z')
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174001',
      author_name: 'First', poem: 'one', analysis: null,
      created_at: new Date('2026-07-11T12:01:00.000Z')
    }
  ];
  const calls = [];
  const store = new CadavreWallStore({}, {
    pool: fakePool(async (sql, values) => {
      calls.push({ sql, values });
      return { rows };
    })
  });

  const firstPage = await store.list({ limit: 2 });
  assert.deepEqual(firstPage.items.map(item => item.poem), ['three', 'two']);
  assert.ok(firstPage.nextCursor);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(calls[0].values, [3]);

  await store.list({ limit: 2, cursor: firstPage.nextCursor });
  assert.match(calls[1].sql, /\(created_at, id\) < ROW\(\$1::timestamptz, \$2::uuid\)/);
  assert.deepEqual(calls[1].values, [
    '2026-07-11T12:02:00.000Z',
    '123e4567-e89b-42d3-a456-426614174002',
    3
  ]);
});

test('shared wall removes a row only when the delete token hash matches', async () => {
  const token = 'a'.repeat(64);
  const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
  const calls = [];
  const store = new CadavreWallStore({}, {
    pool: fakePool(async (sql, values) => {
      calls.push({ sql, values });
      return { rowCount: values[1] === expectedHash ? 1 : 0, rows: [] };
    })
  });
  const id = '123e4567-e89b-42d3-a456-426614174000';

  assert.equal(await store.remove(id, token), true);
  assert.match(calls[0].sql, /DELETE FROM wall_posts/);
  assert.deepEqual(calls[0].values, [id, expectedHash]);
  await assert.rejects(() => store.remove(id, 'short'), { status: 403 });
  assert.equal(calls.length, 1);
});

test('shared wall rejects malformed cursors and missing database configuration', async () => {
  assert.throws(() => _private.decodeCursor('not-a-cursor'), { status: 400 });
  assert.throws(
    () => _private.cleanText('', { field: 'poem', maxLength: 12000, required: true }),
    { status: 400 }
  );
  const store = new CadavreWallStore({});
  await assert.rejects(() => store.list(), { status: 503 });
});

test('legacy volume rows normalize without exposing their delete hash', () => {
  const normalized = normalizeLegacyRow({
    event_id: '123e4567-e89b-42d3-a456-426614174000',
    created_at: '2026-07-11T12:00:00.000Z',
    payload: {
      name: '  Volume   Writer ',
      poem: 'the copper orchard',
      analysis: '',
      delete_token_hash: 'b'.repeat(64)
    }
  });
  assert.deepEqual(normalized, {
    id: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-07-11T12:00:00.000Z',
    authorName: 'Volume Writer',
    poem: 'the copper orchard',
    analysis: null,
    deleteTokenHash: 'b'.repeat(64)
  });
});

test('volume import records its file digest and does not resurrect rows on restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-wall-import-'));
  const filePath = path.join(directory, 'cadavre-wall.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, JSON.stringify([{
    event_id: '123e4567-e89b-42d3-a456-426614174000',
    created_at: '2026-07-11T12:00:00.000Z',
    payload: {
      name: 'Volume Writer',
      poem: 'the copper orchard',
      analysis: null,
      delete_token_hash: 'c'.repeat(64)
    }
  }]));

  const ledgers = new Map();
  const handledIds = new Set();
  let wallInserts = 0;
  const client = {
    async query(sql, values = []) {
      if (/SELECT source_row_count/.test(sql)) {
        const ledger = ledgers.get(values[0]);
        return { rows: ledger ? [ledger] : [] };
      }
      if (/SELECT wall_post_id/.test(sql)) {
        return { rows: handledIds.has(values[0]) ? [{ wall_post_id: values[0] }] : [] };
      }
      if (/INSERT INTO wall_posts/.test(sql)) {
        wallInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO wall_volume_imports/.test(sql)) {
        ledgers.set(values[0], { source_row_count: values[2], imported_row_count: values[3] });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO wall_volume_imported_rows/.test(sql)) {
        handledIds.add(values[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };

  const first = await importVolume({ filePath, pool });
  assert.deepEqual(first, {
    found: 1, imported: 1, previouslyImported: 0, skipped: 0, alreadyImported: false
  });
  assert.equal(wallInserts, 1);

  // This represents a later database deletion. The import ledger, rather than
  // the presence of the row, prevents a restart from recreating it.
  const second = await importVolume({ filePath, pool });
  assert.deepEqual(second, {
    found: 1, imported: 0, previouslyImported: 1, skipped: 1, alreadyImported: true
  });
  assert.equal(wallInserts, 1);

  const expanded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  expanded.push({
    event_id: '123e4567-e89b-42d3-a456-426614174001',
    created_at: '2026-07-11T12:01:00.000Z',
    payload: {
      name: 'Later Volume Writer',
      poem: 'a second orchard',
      analysis: null,
      delete_token_hash: 'd'.repeat(64)
    }
  });
  fs.writeFileSync(filePath, JSON.stringify(expanded));
  const changed = await importVolume({ filePath, pool });
  assert.deepEqual(changed, {
    found: 2, imported: 1, previouslyImported: 0, skipped: 1, alreadyImported: false
  });
  assert.equal(wallInserts, 2);
});

test('volume import stops when any legacy row is malformed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-wall-invalid-'));
  const filePath = path.join(directory, 'cadavre-wall.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(filePath, '[{}]\n');
  let connected = false;

  await assert.rejects(
    () => importVolume({ filePath, pool: { async connect() { connected = true; } } }),
    /invalid row\(s\) at index 0/
  );
  assert.equal(connected, false);
});

test('database pool settings stay within the configured bounds', () => {
  assert.equal(boundedInteger('5', 3, 1, 20), 5);
  assert.equal(boundedInteger('100', 3, 1, 20), 20);
  assert.equal(boundedInteger('bad', 3, 1, 20), 3);
});

test('wall store rejects new queries while its owned pool is closing', async () => {
  let finishClose;
  let endCalls = 0;
  const pool = {
    async query() { return { rows: [] }; },
    end() {
      endCalls += 1;
      return new Promise(resolve => { finishClose = resolve; });
    }
  };
  const store = new CadavreWallStore({}, { pool, ownsPool: true });

  const closing = store.close();
  await assert.rejects(() => store.list(), { status: 503 });
  finishClose();
  await closing;
  await store.close();
  assert.equal(endCalls, 1);
});
