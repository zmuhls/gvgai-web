const crypto = require('crypto');
const { createPostgresPool } = require('./postgres-pool');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

function httpError(status, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  return error;
}

function cleanText(value, { field, maxLength, required = false, singleLine = false }) {
  let text = value === undefined || value === null ? '' : String(value);
  text = text.replace(/\r\n?/g, '\n').trim();
  if (singleLine) text = text.replace(/\s+/g, ' ');
  if (required && !text) throw httpError(400, `${field} is required.`);
  if (text.length > maxLength) throw httpError(400, `${field} must be at most ${maxLength} characters.`);
  return text;
}

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function encodeCursor(row) {
  const id = row.id || row.event_id;
  const createdAt = isoTimestamp(row.created_at);
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || !UUID_RE.test(parsed.id) || !Number.isFinite(Date.parse(parsed.createdAt))) {
      throw new Error('invalid cursor');
    }
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    throw httpError(400, 'Invalid wall cursor.');
  }
}

function publicPost(row = {}) {
  return {
    id: row.id,
    name: row.author_name || 'anonymous',
    poem: row.poem || '',
    analysis: row.analysis || '',
    ts: isoTimestamp(row.created_at)
  };
}

class CadavreWallStore {
  constructor(env = process.env, options = {}) {
    this.env = env;
    this.pool = options.pool || null;
    this.ownsPool = options.ownsPool === undefined ? !options.pool : options.ownsPool;
    this.closing = false;
    this.closePromise = null;
  }

  isReady() {
    return Boolean(this.pool || String(this.env.DATABASE_URL || '').trim());
  }

  getPool() {
    if (this.closing) {
      throw httpError(503, 'The shared wall database is shutting down.');
    }
    if (this.pool) return this.pool;
    if (!this.isReady()) {
      throw httpError(503, 'The shared wall database is unavailable.');
    }

    this.pool = createPostgresPool(this.env);
    this.pool.on('error', (error) => {
      console.error('[Cadavre wall] idle Postgres client error:', error.message);
    });
    return this.pool;
  }

  async query(sql, values = []) {
    try {
      return await this.getPool().query(sql, values);
    } catch (error) {
      if (error.status) throw error;
      throw httpError(503, 'The shared wall database is unavailable.', error);
    }
  }

  async list({ limit, cursor } = {}) {
    const pageSize = parseLimit(limit);
    const decodedCursor = decodeCursor(cursor);
    const values = [];
    let cursorClause = '';
    if (decodedCursor) {
      values.push(decodedCursor.createdAt, decodedCursor.id);
      cursorClause = 'WHERE (created_at, id) < ROW($1::timestamptz, $2::uuid)';
    }
    values.push(pageSize + 1);
    const limitParameter = `$${values.length}`;
    const result = await this.query(`
      SELECT id, author_name, poem, analysis, created_at
      FROM wall_posts
      ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParameter}
    `, values);
    const page = result.rows.slice(0, pageSize);
    return {
      items: page.map(publicPost),
      nextCursor: result.rows.length > pageSize && page.length
        ? encodeCursor(page[page.length - 1])
        : null
    };
  }

  async create(input = {}) {
    const authorName = cleanText(input.name, {
      field: 'name', maxLength: 80, singleLine: true
    }) || 'anonymous';
    const poem = cleanText(input.poem, { field: 'poem', maxLength: 12000, required: true });
    const analysis = cleanText(input.analysis, { field: 'analysis', maxLength: 16000 });
    const deleteToken = crypto.randomBytes(32).toString('hex');
    const deleteTokenHash = crypto.createHash('sha256').update(deleteToken).digest('hex');
    const id = crypto.randomUUID();
    const result = await this.query(`
      INSERT INTO wall_posts (id, author_name, poem, analysis, delete_token_hash)
      VALUES ($1::uuid, $2, $3, $4, $5)
      RETURNING id, author_name, poem, analysis, created_at
    `, [id, authorName, poem, analysis || null, deleteTokenHash]);
    if (!result.rows[0]) {
      throw httpError(503, 'The shared wall database did not return the new pin.');
    }
    return { item: publicPost(result.rows[0]), deleteToken };
  }

  async remove(id, deleteToken) {
    if (!UUID_RE.test(String(id || ''))) throw httpError(400, 'Invalid wall post id.');
    if (!TOKEN_RE.test(String(deleteToken || ''))) throw httpError(403, 'This browser cannot remove that pin.');
    const deleteTokenHash = crypto.createHash('sha256').update(deleteToken).digest('hex');
    const result = await this.query(`
      DELETE FROM wall_posts
      WHERE id = $1::uuid AND delete_token_hash = $2
      RETURNING id
    `, [id, deleteTokenHash]);
    return result.rowCount > 0;
  }

  async health() {
    const result = await this.query("SELECT to_regclass('public.wall_posts')::text AS table_name");
    if (result.rows[0]?.table_name !== 'wall_posts') {
      throw httpError(503, 'The shared wall schema is unavailable.');
    }
    return { status: 'ok', storage: 'postgres' };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (!this.pool || !this.ownsPool) return;
    const pool = this.pool;
    this.closePromise = pool.end().finally(() => {
      this.pool = null;
    });
    return this.closePromise;
  }
}

module.exports = {
  CadavreWallStore,
  _private: {
    cleanText,
    parseLimit,
    encodeCursor,
    decodeCursor,
    publicPost,
    isoTimestamp,
    UUID_RE,
    TOKEN_RE
  }
};
