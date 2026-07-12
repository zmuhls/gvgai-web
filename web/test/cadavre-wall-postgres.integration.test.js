const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { Pool } = require('pg');

const { CadavreWallStore } = require('../lib/cadavre-wall-store');

const databaseUrl = String(process.env.TEST_DATABASE_URL || '').trim();
const integrationTest = databaseUrl ? test : test.skip;

function integrationPool() {
  return new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
}

integrationTest('Postgres wall creates, reads, and removes a live row', async (t) => {
  const pool = integrationPool();
  const store = new CadavreWallStore({}, { pool });
  const ids = [];
  t.after(async () => {
    if (ids.length) await pool.query('DELETE FROM wall_posts WHERE id = ANY($1::uuid[])', [ids]);
    await pool.end();
  });

  assert.deepEqual(await store.health(), { status: 'ok', storage: 'postgres' });
  const created = await store.create({
    name: 'Postgres integration check',
    poem: 'a temporary brass bird',
    analysis: 'removed before the test exits'
  });
  ids.push(created.item.id);

  const page = await store.list({ limit: 100 });
  assert.equal(page.items.some(item => item.id === created.item.id), true);
  assert.doesNotMatch(JSON.stringify(page.items), /delete_token|deleteToken/i);
  assert.equal(await store.remove(created.item.id, '0'.repeat(64)), false);
  assert.equal(await store.remove(created.item.id, created.deleteToken), true);
  ids.length = 0;
});

integrationTest('Postgres wall cursor preserves UUID order when timestamps match', async (t) => {
  const pool = integrationPool();
  const store = new CadavreWallStore({}, { pool });
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID()).sort().reverse();
  t.after(async () => {
    await pool.query('DELETE FROM wall_posts WHERE id = ANY($1::uuid[])', [ids]);
    await pool.end();
  });

  for (const id of ids) {
    await pool.query(`
      INSERT INTO wall_posts (
        id, created_at, author_name, poem, analysis, delete_token_hash
      ) VALUES ($1::uuid, '9999-12-31T23:59:59.999Z'::timestamptz, $2, $3, NULL, $4)
    `, [id, 'Cursor integration check', `temporary ${id}`, 'd'.repeat(64)]);
  }

  const first = await store.list({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ids.slice(0, 2));
  const second = await store.list({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.items[0].id, ids[2]);
});

integrationTest('Postgres wall enforces application text limits', async (t) => {
  const pool = integrationPool();
  const id = crypto.randomUUID();
  t.after(async () => {
    await pool.query('DELETE FROM wall_posts WHERE id = $1::uuid', [id]);
    await pool.end();
  });

  await assert.rejects(
    () => pool.query(`
      INSERT INTO wall_posts (id, author_name, poem, delete_token_hash)
      VALUES ($1::uuid, $2, $3, $4)
    `, [id, 'x'.repeat(81), 'constraint check', 'e'.repeat(64)]),
    error => ['22001', '23514'].includes(error.code)
  );
});
