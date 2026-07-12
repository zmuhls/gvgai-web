const { Pool } = require('pg');
const { buildBackupDocument, isoTimestamp, validateBackupDocument } = require('./backup-document');

function requireDatabaseUrl(env = process.env) {
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return connectionString;
}

function createDatabasePool(env = process.env) {
  return new Pool({
    connectionString: requireDatabaseUrl(env),
    max: 1,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
    keepAlive: true,
    application_name: 'inference-arcade-wall-backup'
  });
}

async function rollbackQuietly(client) {
  if (!client) return;
  try {
    await client.query('ROLLBACK');
  } catch {}
}

async function readSnapshot(pool, createdAt = new Date()) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    inTransaction = true;
    const [posts, schemaMigrations, volumeImports, importedRows] = await Promise.all([
      client.query(`
        SELECT id::text, created_at, author_name, poem, analysis,
               btrim(delete_token_hash) AS delete_token_hash
        FROM wall_posts
        ORDER BY created_at, id
      `),
      client.query(`
        SELECT name, btrim(checksum) AS checksum, applied_at
        FROM wall_schema_migrations
        ORDER BY name
      `),
      client.query(`
        SELECT btrim(source_digest) AS source_digest, source_name,
               source_row_count, imported_row_count, imported_at
        FROM wall_volume_imports
        ORDER BY imported_at, source_digest
      `),
      client.query('SELECT count(*)::int AS count FROM wall_volume_imported_rows')
    ]);
    await client.query('COMMIT');
    inTransaction = false;
    return buildBackupDocument({
      posts: posts.rows,
      schemaMigrations: schemaMigrations.rows,
      volumeImports: volumeImports.rows,
      importedVolumeRowCount: Number(importedRows.rows[0]?.count || 0)
    }, createdAt);
  } catch (error) {
    if (inTransaction) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function insertBackupPost(client, tableName, post) {
  return client.query(`
    INSERT INTO ${tableName} (
      id, created_at, author_name, poem, analysis, delete_token_hash
    ) VALUES ($1::uuid, $2::timestamptz, $3, $4, $5, $6)
  `, [
    post.id,
    post.createdAt,
    post.authorName,
    post.poem,
    post.analysis,
    post.deleteTokenHash
  ]);
}

async function verifyRestorable(pool, document) {
  const summary = validateBackupDocument(document);
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(`
      CREATE TEMP TABLE common_wall_restore_check
      (LIKE wall_posts INCLUDING ALL)
      ON COMMIT DROP
    `);
    for (const post of document.posts) {
      await insertBackupPost(client, 'common_wall_restore_check', post);
    }
    const count = await client.query('SELECT count(*)::int AS count FROM common_wall_restore_check');
    if (Number(count.rows[0]?.count) !== summary.posts) {
      throw new Error('Restore check row count does not match the backup.');
    }
    await client.query('ROLLBACK');
    inTransaction = false;
    return { restoredPosts: summary.posts };
  } catch (error) {
    if (inTransaction) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

function comparableDatabasePost(row) {
  return {
    id: String(row.id),
    createdAt: isoTimestamp(row.created_at, 'existing wall post createdAt'),
    authorName: String(row.author_name),
    poem: String(row.poem),
    analysis: row.analysis === undefined || row.analysis === null ? null : String(row.analysis),
    deleteTokenHash: String(row.delete_token_hash).trim()
  };
}

function postsMatch(left, right) {
  return left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.authorName === right.authorName &&
    left.poem === right.poem &&
    left.analysis === right.analysis &&
    left.deleteTokenHash === right.deleteTokenHash;
}

async function applyRestore(pool, document) {
  validateBackupDocument(document);
  const client = await pool.connect();
  let inTransaction = false;
  let inserted = 0;
  let existing = 0;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    for (const post of document.posts) {
      const current = await client.query(`
        SELECT id::text, created_at, author_name, poem, analysis,
               btrim(delete_token_hash) AS delete_token_hash
        FROM wall_posts
        WHERE id = $1::uuid
      `, [post.id]);
      if (current.rows[0]) {
        if (!postsMatch(comparableDatabasePost(current.rows[0]), post)) {
          throw new Error(`Existing wall post ${post.id} differs from the backup.`);
        }
        existing += 1;
        continue;
      }
      await insertBackupPost(client, 'wall_posts', post);
      inserted += 1;
    }
    await client.query('COMMIT');
    inTransaction = false;
    return { inserted, existing };
  } catch (error) {
    if (inTransaction) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  applyRestore,
  comparableDatabasePost,
  createDatabasePool,
  insertBackupPost,
  postsMatch,
  readSnapshot,
  requireDatabaseUrl,
  verifyRestorable
};
