const { Pool } = require('pg');

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function createPostgresPool(env = process.env, overrides = {}) {
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) {
    const error = new Error('DATABASE_URL is required.');
    error.code = 'MISSING_DATABASE_URL';
    throw error;
  }

  return new Pool({
    connectionString,
    max: boundedInteger(env.DATABASE_POOL_MAX, 5, 1, 20),
    idleTimeoutMillis: boundedInteger(env.DATABASE_IDLE_TIMEOUT_MS, 10000, 1000, 60000),
    connectionTimeoutMillis: boundedInteger(env.DATABASE_CONNECTION_TIMEOUT_MS, 5000, 1000, 30000),
    statement_timeout: boundedInteger(env.DATABASE_STATEMENT_TIMEOUT_MS, 5000, 1000, 30000),
    query_timeout: boundedInteger(env.DATABASE_QUERY_TIMEOUT_MS, 6000, 1000, 31000),
    keepAlive: true,
    application_name: 'inference-arcade-wall',
    ...overrides
  });
}

module.exports = {
  boundedInteger,
  createPostgresPool
};
