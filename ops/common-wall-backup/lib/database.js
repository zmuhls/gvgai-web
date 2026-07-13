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
    const posts = await client.query(`
      SELECT id::text, created_at, author_name, poem, analysis,
             btrim(delete_token_hash) AS delete_token_hash
      FROM wall_posts
      ORDER BY created_at, id
    `);
    const votes = await client.query(`
      SELECT post_id::text, btrim(voter_token_hash) AS voter_token_hash,
             vote::int, created_at, updated_at
      FROM wall_post_votes
      ORDER BY post_id, voter_token_hash
    `);
    const schemaMigrations = await client.query(`
      SELECT name, btrim(checksum) AS checksum, applied_at
      FROM wall_schema_migrations
      ORDER BY name
    `);
    await client.query('COMMIT');
    inTransaction = false;
    return buildBackupDocument({
      posts: posts.rows,
      votes: votes.rows,
      schemaMigrations: schemaMigrations.rows
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

async function insertBackupVote(client, tableName, vote) {
  return client.query(`
    INSERT INTO ${tableName} (
      post_id, voter_token_hash, vote, created_at, updated_at
    ) VALUES ($1::uuid, $2, $3::smallint, $4::timestamptz, $5::timestamptz)
  `, [
    vote.postId,
    vote.voterTokenHash,
    vote.vote,
    vote.createdAt,
    vote.updatedAt
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
      CREATE TEMP TABLE common_wall_restore_check_posts
      (LIKE wall_posts INCLUDING ALL)
      ON COMMIT DROP
    `);
    await client.query(`
      CREATE TEMP TABLE common_wall_restore_check_votes
      (LIKE wall_post_votes INCLUDING ALL)
      ON COMMIT DROP
    `);
    for (const post of document.posts) {
      await insertBackupPost(client, 'common_wall_restore_check_posts', post);
    }
    for (const vote of document.votes) {
      await insertBackupVote(client, 'common_wall_restore_check_votes', vote);
    }
    const postCount = await client.query(
      'SELECT count(*)::int AS count FROM common_wall_restore_check_posts'
    );
    if (Number(postCount.rows[0]?.count) !== summary.posts) {
      throw new Error('Restore check post count does not match the backup.');
    }
    const voteCount = await client.query(
      'SELECT count(*)::int AS count FROM common_wall_restore_check_votes'
    );
    if (Number(voteCount.rows[0]?.count) !== summary.votes) {
      throw new Error('Restore check vote count does not match the backup.');
    }
    await client.query('ROLLBACK');
    inTransaction = false;
    return { restoredPosts: summary.posts, restoredVotes: summary.votes };
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
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('LOCK TABLE wall_posts, wall_post_votes IN ACCESS EXCLUSIVE MODE');
    await requireEmptyRestoreTarget(client);
    for (const post of document.posts) {
      await insertBackupPost(client, 'wall_posts', post);
    }
    for (const vote of document.votes) {
      await insertBackupVote(client, 'wall_post_votes', vote);
    }
    await client.query('COMMIT');
    inTransaction = false;
    return {
      inserted: document.posts.length,
      existing: 0,
      insertedVotes: document.votes.length,
      existingVotes: 0
    };
  } catch (error) {
    if (inTransaction) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function requireEmptyRestoreTarget(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM wall_posts) AS posts,
      (SELECT count(*)::int FROM wall_post_votes) AS votes
  `);
  const posts = Number(result.rows[0]?.posts || 0);
  const votes = Number(result.rows[0]?.votes || 0);
  if (posts !== 0 || votes !== 0) {
    throw new Error('Restore target wall_posts and wall_post_votes must be empty.');
  }
  return { existingPosts: posts, existingVotes: votes };
}

module.exports = {
  applyRestore,
  comparableDatabasePost,
  createDatabasePool,
  insertBackupPost,
  insertBackupVote,
  postsMatch,
  readSnapshot,
  requireEmptyRestoreTarget,
  requireDatabaseUrl,
  verifyRestorable
};
