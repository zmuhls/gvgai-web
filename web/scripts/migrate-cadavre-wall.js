const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPostgresPool } = require('../lib/postgres-pool');

const MIGRATIONS_DIRECTORY = path.resolve(__dirname, '..', 'postgres', 'migrations');
const LOCK_NAME = 'inference-arcade-wall-migrations';

function migrationFiles(directory = MIGRATIONS_DIRECTORY) {
  return fs.readdirSync(directory)
    .filter(name => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
}

function checksum(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

async function migrate(options = {}) {
  const directory = options.directory || MIGRATIONS_DIRECTORY;
  const pool = options.pool || createPostgresPool(options.env || process.env, { max: 1 });
  const ownsPool = !options.pool;
  let client = null;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
    locked = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS wall_schema_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query('SELECT name, checksum FROM wall_schema_migrations');
    const appliedByName = new Map(applied.rows.map(row => [row.name, row.checksum]));

    for (const name of migrationFiles(directory)) {
      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      const sourceChecksum = checksum(source);
      if (appliedByName.has(name)) {
        if (appliedByName.get(name) !== sourceChecksum) {
          throw new Error(`Applied migration ${name} has changed.`);
        }
        console.log(`[Wall migration] already applied: ${name}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(source);
        await client.query(
          'INSERT INTO wall_schema_migrations (name, checksum) VALUES ($1, $2)',
          [name, sourceChecksum]
        );
        await client.query('COMMIT');
        console.log(`[Wall migration] applied: ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    if (client && locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
      } catch (error) {
        console.error(`[Wall migration] advisory unlock failed: ${error.message}`);
      }
    }
    if (client) client.release();
    if (ownsPool) await pool.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(`[Wall migration] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  checksum,
  migrationFiles,
  migrate
};
