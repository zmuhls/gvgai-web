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
  assert.deepEqual(
    { upvotes: created.item.upvotes, downvotes: created.item.downvotes, score: created.item.score },
    { upvotes: 0, downvotes: 0, score: 0 }
  );
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
  assert.deepEqual(
    firstPage.items.map(({ upvotes, downvotes, score }) => ({ upvotes, downvotes, score })),
    [
      { upvotes: 0, downvotes: 0, score: 0 },
      { upvotes: 0, downvotes: 0, score: 0 }
    ]
  );
  assert.ok(firstPage.nextCursor);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(calls[0].sql, /CROSS JOIN LATERAL/);
  assert.match(calls[0].sql, /WHERE post_id = page\.id/);
  assert.deepEqual(calls[0].values, [3]);

  await store.list({ limit: 2, cursor: firstPage.nextCursor });
  assert.match(calls[1].sql, /\(created_at, id\) < ROW\(\$1::timestamptz, \$2::uuid\)/);
  assert.deepEqual(calls[1].values, [
    '2026-07-11T12:02:00.000Z',
    '123e4567-e89b-42d3-a456-426614174002',
    3
  ]);
});

test('shared wall maps persistent vote totals without exposing voter identities', async () => {
  const store = new CadavreWallStore({}, {
    pool: fakePool(async () => ({
      rows: [{
        id: '123e4567-e89b-42d3-a456-426614174000',
        author_name: 'Voted', poem: 'copper rain', analysis: null,
        created_at: new Date('2026-07-11T12:00:00.000Z'),
        upvotes: 7, downvotes: 2, score: 5
      }]
    }))
  });

  const page = await store.list({ limit: 1 });

  assert.deepEqual(page.items[0], {
    id: '123e4567-e89b-42d3-a456-426614174000',
    name: 'Voted',
    poem: 'copper rain',
    analysis: '',
    ts: '2026-07-11T12:00:00.000Z',
    upvotes: 7,
    downvotes: 2,
    score: 5
  });
  assert.doesNotMatch(JSON.stringify(page), /token|hash|viewerVote/i);
});

test('shared wall adds, switches, and clears one hashed vote in short transactions', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const token = 'a'.repeat(64);
  const expectedHash = crypto.createHash('sha256')
    .update(_private.VOTE_HASH_DOMAIN)
    .update(token)
    .digest('hex');
  const votes = new Map();
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql, values = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, values });
      if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes('SELECT id FROM wall_posts')) {
        return { rows: [{ id }], rowCount: 1 };
      }
      if (normalized.includes('INSERT INTO wall_post_votes')) {
        votes.set(values[1], values[2]);
        return { rows: [], rowCount: 1 };
      }
      if (normalized.includes('DELETE FROM wall_post_votes')) {
        const removed = votes.delete(values[1]);
        return { rows: [], rowCount: removed ? 1 : 0 };
      }
      if (normalized.includes('SELECT COUNT(*) FILTER')) {
        const values = [...votes.values()];
        const upvotes = values.filter(vote => vote === 1).length;
        const downvotes = values.filter(vote => vote === -1).length;
        return { rows: [{ upvotes, downvotes, score: upvotes - downvotes }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release() { releases += 1; }
  };
  const store = new CadavreWallStore({}, {
    pool: { async connect() { return client; } }
  });

  assert.deepEqual(await store.vote(id, token, 1), {
    id, upvotes: 1, downvotes: 0, score: 1, viewerVote: 1
  });
  assert.deepEqual(await store.vote(id, token, -1), {
    id, upvotes: 0, downvotes: 1, score: -1, viewerVote: -1
  });
  assert.deepEqual(await store.vote(id, token, 0), {
    id, upvotes: 0, downvotes: 0, score: 0, viewerVote: 0
  });

  assert.equal(votes.size, 0);
  assert.ok(calls.some(({ sql }) => /FOR KEY SHARE/.test(sql)));
  assert.ok(calls.some(({ sql }) => /ON CONFLICT \(post_id, voter_token_hash\) DO UPDATE/.test(sql)));
  assert.equal(calls.filter(({ sql }) => sql === 'BEGIN').length, 3);
  assert.equal(calls.filter(({ sql }) => sql === 'COMMIT').length, 3);
  assert.equal(releases, 3);
  assert.ok(calls.some(({ values }) => values.includes(expectedHash)));
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(token));
});

test('shared wall returns no vote result for a missing post and rolls back', async () => {
  const calls = [];
  let released = false;
  const store = new CadavreWallStore({}, {
    pool: {
      async connect() {
        return {
          async query(sql) {
            const normalized = sql.replace(/\s+/g, ' ').trim();
            calls.push(normalized);
            if (normalized.includes('SELECT id FROM wall_posts')) return { rows: [] };
            return { rows: [] };
          },
          release() { released = true; }
        };
      }
    }
  });

  const result = await store.vote(
    '123e4567-e89b-42d3-a456-426614174000',
    'b'.repeat(64),
    1
  );

  assert.equal(result, null);
  assert.deepEqual(calls, [
    'BEGIN',
    'SELECT id FROM wall_posts WHERE id = $1::uuid FOR KEY SHARE',
    'ROLLBACK'
  ]);
  assert.equal(released, true);
});

test('shared wall validates vote ids, tokens, and values before opening a connection', async () => {
  let connections = 0;
  const store = new CadavreWallStore({}, {
    pool: { async connect() { connections += 1; throw new Error('should not connect'); } }
  });
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const token = 'c'.repeat(64);

  await assert.rejects(() => store.vote('bad-id', token, 1), { status: 400 });
  await assert.rejects(() => store.vote(id, 'short', 1), { status: 400 });
  await assert.rejects(() => store.vote(id, token, 2), { status: 400 });
  await assert.rejects(() => store.vote(id, token, '1'), { status: 400 });
  assert.equal(connections, 0);
});

test('shared wall health requires both persistent post and vote tables', async () => {
  const healthy = new CadavreWallStore({}, {
    pool: fakePool(async sql => {
      assert.match(sql, /wall_post_votes/);
      return { rows: [{ posts_table: 'wall_posts', votes_table: 'wall_post_votes' }] };
    })
  });
  const missingVotes = new CadavreWallStore({}, {
    pool: fakePool(async () => ({
      rows: [{ posts_table: 'wall_posts', votes_table: null }]
    }))
  });

  assert.deepEqual(await healthy.health(), { status: 'ok', storage: 'postgres' });
  await assert.rejects(() => missingVotes.health(), { status: 503 });
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
