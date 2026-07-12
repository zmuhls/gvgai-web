const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TABLE_NAME = 'telemetry_events';
const EVENT_FAMILY = 'system';
const EVENT_TYPE = 'cadavre_wall_post';
const EVENT_SOURCE = 'cadavre';
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 3000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

function httpError(status, message) {
  const error = new Error(message);
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

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.event_id })).toString('base64url');
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
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    id: row.event_id,
    name: payload.name || 'anonymous',
    poem: payload.poem || '',
    analysis: payload.analysis || '',
    ts: row.created_at
  };
}

class CadavreWallStore {
  constructor(env = process.env) {
    this.env = env;
  }

  get supabaseUrl() {
    return String(this.env.SUPABASE_URL || '').replace(/\/+$/, '');
  }

  get serviceRoleKey() {
    return String(this.env.SUPABASE_SERVICE_ROLE_KEY || this.env.SUPABASE_SERVICE_KEY || '');
  }

  get tableName() {
    const configured = String(this.env.SUPABASE_TELEMETRY_TABLE || DEFAULT_TABLE_NAME);
    return /^[a-z0-9_]+$/i.test(configured) ? configured : DEFAULT_TABLE_NAME;
  }

  get fallbackPath() {
    const configured = String(this.env.CADAVRE_WALL_FALLBACK_PATH || '').trim();
    return configured ? path.resolve(configured) : '';
  }

  get requestTimeoutMs() {
    const configured = Number.parseInt(this.env.CADAVRE_WALL_SUPABASE_TIMEOUT_MS, 10);
    return Number.isInteger(configured) && configured > 0 ? configured : REQUEST_TIMEOUT_MS;
  }

  isSupabaseReady() {
    return Boolean(this.supabaseUrl && this.serviceRoleKey);
  }

  isReady() {
    return this.isSupabaseReady() || Boolean(this.fallbackPath);
  }

  headers(prefer) {
    const headers = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json'
    };
    if (prefer) headers.Prefer = prefer;
    return headers;
  }

  async request(path, options = {}) {
    if (!this.isSupabaseReady()) {
      throw httpError(503, 'The shared wall is awaiting its Supabase connection.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await fetch(`${this.supabaseUrl}/rest/v1/${this.tableName}${path}`, {
        ...options,
        headers: { ...this.headers(options.prefer), ...(options.headers || {}) },
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === 'AbortError') throw httpError(504, 'Wall storage timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await response.text();
      throw httpError(502, `Wall storage returned ${response.status}: ${body.slice(0, 240)}`);
    }
    return response;
  }

  readFallbackRows() {
    if (!this.fallbackPath || !fs.existsSync(this.fallbackPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.fallbackPath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(row => row && UUID_RE.test(row.event_id)) : [];
    } catch (error) {
      throw httpError(500, `The persistent wall file could not be read: ${error.message}`);
    }
  }

  writeFallbackRows(rows) {
    if (!this.fallbackPath) return;
    const directory = path.dirname(this.fallbackPath);
    const temporary = `${this.fallbackPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.fallbackPath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw httpError(500, `The persistent wall file could not be written: ${error.message}`);
    }
  }

  upsertFallbackRow(row) {
    if (!this.fallbackPath) return;
    const rows = this.readFallbackRows();
    const index = rows.findIndex(existing => existing.event_id === row.event_id);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    this.writeFallbackRows(rows);
  }

  removeFallbackRow(id, deleteTokenHash) {
    if (!this.fallbackPath) return false;
    const rows = this.readFallbackRows();
    const kept = rows.filter(row =>
      row.event_id !== id || row.payload?.delete_token_hash !== deleteTokenHash
    );
    if (kept.length === rows.length) return false;
    this.writeFallbackRows(kept);
    return true;
  }

  async list({ limit, cursor } = {}) {
    const pageSize = parseLimit(limit);
    const decodedCursor = decodeCursor(cursor);
    const params = new URLSearchParams({
      select: 'event_id,created_at,payload',
      event_family: `eq.${EVENT_FAMILY}`,
      event_type: `eq.${EVENT_TYPE}`,
      source: `eq.${EVENT_SOURCE}`,
      order: 'created_at.desc,event_id.desc',
      limit: String(pageSize + 1)
    });
    if (decodedCursor) {
      params.set(
        'or',
        `(created_at.lt.${decodedCursor.createdAt},and(created_at.eq.${decodedCursor.createdAt},event_id.lt.${decodedCursor.id}))`
      );
    }

    let cloudRows = [];
    let cloudError = null;
    if (this.isSupabaseReady()) {
      try {
        const response = await this.request(`?${params.toString()}`, { method: 'GET' });
        cloudRows = await response.json();
      } catch (error) {
        cloudError = error;
      }
    }
    if (cloudError && !this.fallbackPath) throw cloudError;

    const merged = new Map();
    for (const row of [...cloudRows, ...this.readFallbackRows()]) merged.set(row.event_id, row);
    const rows = [...merged.values()]
      .filter(row => !decodedCursor ||
        row.created_at < decodedCursor.createdAt ||
        (row.created_at === decodedCursor.createdAt && row.event_id < decodedCursor.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.event_id.localeCompare(a.event_id));
    const page = rows.slice(0, pageSize);
    return {
      items: page.map(publicPost),
      nextCursor: rows.length > pageSize && page.length ? encodeCursor(page[page.length - 1]) : null
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
    const eventId = crypto.randomUUID();
    const row = {
      event_id: eventId,
      created_at: new Date().toISOString(),
      event_family: EVENT_FAMILY,
      event_type: EVENT_TYPE,
      source: EVENT_SOURCE,
      payload: {
        name: authorName,
        poem,
        analysis: analysis || null,
        delete_token_hash: deleteTokenHash
      },
      metrics: {}
    };
    let storedRow = null;
    let cloudError = null;
    if (this.isSupabaseReady()) {
      try {
        const response = await this.request('', {
          method: 'POST',
          prefer: 'return=representation',
          body: JSON.stringify(row)
        });
        const rows = await response.json();
        storedRow = Array.isArray(rows) ? rows[0] : null;
        if (!storedRow) throw httpError(502, 'Wall storage did not return the new pin.');
      } catch (error) {
        cloudError = error;
      }
    }
    if (cloudError && !this.fallbackPath) throw cloudError;
    if (!storedRow && !this.fallbackPath) throw httpError(503, 'The shared wall has no persistent storage.');
    this.upsertFallbackRow(storedRow || row);
    return { item: publicPost(storedRow || row), deleteToken };
  }

  async remove(id, deleteToken) {
    if (!UUID_RE.test(String(id || ''))) throw httpError(400, 'Invalid wall post id.');
    if (!TOKEN_RE.test(String(deleteToken || ''))) throw httpError(403, 'This browser cannot remove that pin.');
    const deleteTokenHash = crypto.createHash('sha256').update(deleteToken).digest('hex');
    const params = new URLSearchParams({
      event_id: `eq.${id}`,
      event_family: `eq.${EVENT_FAMILY}`,
      event_type: `eq.${EVENT_TYPE}`,
      source: `eq.${EVENT_SOURCE}`,
      payload: `cs.${JSON.stringify({ delete_token_hash: deleteTokenHash })}`,
      select: 'event_id'
    });
    let cloudRemoved = false;
    let cloudError = null;
    if (this.isSupabaseReady()) {
      try {
        const response = await this.request(`?${params.toString()}`, {
          method: 'DELETE',
          prefer: 'return=representation'
        });
        const rows = await response.json();
        cloudRemoved = Array.isArray(rows) && rows.length > 0;
      } catch (error) {
        cloudError = error;
      }
    }
    if (cloudError && !this.fallbackPath) throw cloudError;
    return this.removeFallbackRow(id, deleteTokenHash) || cloudRemoved;
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
    UUID_RE,
    TOKEN_RE,
    EVENT_FAMILY,
    EVENT_TYPE,
    EVENT_SOURCE
  }
};
