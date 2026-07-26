'use strict';

// Durable Postgres mirror for play traces.
//
// The filesystem store (play-trace-store.js) stays the read path for the
// running instance; this module writes each saved trace through to Postgres
// when DATABASE_URL is configured (the Railway deployment, whose container
// filesystem is wiped on redeploy). A training box pulls the archive down to
// local trace files with scripts/sync-traces.js, so the fine-tune pipeline
// (npm run finetune:prepare) reads them exactly like locally captured plays.

const { createPostgresPool } = require('./postgres-pool');

let sharedPool = null;

function isConfigured(env = process.env) {
  return Boolean(String(env.DATABASE_URL || '').trim());
}

function getPool(env = process.env) {
  if (!sharedPool) {
    sharedPool = createPostgresPool(env, { application_name: 'inference-arcade-traces' });
  }
  return sharedPool;
}

async function closePool() {
  if (sharedPool) {
    const pool = sharedPool;
    sharedPool = null;
    await pool.end();
  }
}

// Idempotent by trace_id so a retried save or a re-imported trace never
// duplicates a row.
async function archiveTrace(record, options = {}) {
  const pool = options.pool || getPool(options.env);
  await pool.query(
    `INSERT INTO play_traces (
       trace_id, game_id, game_name, level_id, player_type, model_id,
       final_score, won, ticks, action_count, created_at, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (trace_id) DO NOTHING`,
    [
      record.traceId,
      record.gameId,
      record.gameName ?? null,
      record.levelId ?? null,
      record.playerType,
      record.modelId ?? null,
      record.finalScore ?? null,
      record.won === true,
      record.ticks ?? null,
      record.actionCount ?? null,
      record.createdAt || new Date().toISOString(),
      JSON.stringify(record)
    ]
  );
}

// Summaries only (no payload) — cheap listing for sync/browse.
async function fetchTraceSummaries(options = {}) {
  const pool = options.pool || getPool(options.env);
  const clauses = [];
  const params = [];
  if (Number.isInteger(options.gameId)) {
    params.push(options.gameId);
    clauses.push(`game_id = $${params.length}`);
  }
  if (options.playerType) {
    params.push(options.playerType);
    clauses.push(`player_type = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT trace_id, game_id, game_name, player_type, final_score, won,
            ticks, action_count, created_at
       FROM play_traces ${where}
       ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

async function fetchTrace(traceId, options = {}) {
  const pool = options.pool || getPool(options.env);
  const result = await pool.query(
    'SELECT payload FROM play_traces WHERE trace_id = $1',
    [traceId]
  );
  return result.rows[0]?.payload ?? null;
}

module.exports = {
  isConfigured,
  archiveTrace,
  fetchTraceSummaries,
  fetchTrace,
  closePool
};
