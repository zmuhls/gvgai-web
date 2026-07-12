const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { CadavreWallStore, _private } = require('../lib/cadavre-wall-store');
const { boundedInteger } = require('../lib/postgres-pool');

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
