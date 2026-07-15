const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SESSION_COOKIE = 'cadavre_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class StoreError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function defaultDatabasePath() {
  if (process.env.CADAVRE_DB_PATH) return process.env.CADAVRE_DB_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'cadavre.db');
  }
  if (fs.existsSync('/data')) return '/data/cadavre.db';
  return path.join(process.cwd(), 'data', 'cadavre.db');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function passwordHash(password, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function passwordMatches(password, encoded) {
  try {
    const [kind, n, r, p, saltText, hashText] = String(encoded).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateUsername(value) {
  const username = String(value || '').trim();
  if (username.length < 2 || username.length > 32) {
    throw new StoreError(400, 'Username must be 2-32 characters');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new StoreError(400, 'Username may only contain letters, numbers, _ and -');
  }
  return username;
}

function validateEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new StoreError(400, 'Enter a valid email address');
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new StoreError(400, 'Password must be 8-128 characters');
  }
  if (!/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new StoreError(400, 'Password must contain an uppercase letter and a number');
  }
  return value;
}

function validatePoem(input) {
  if (!input || !Array.isArray(input.lines)) {
    throw new StoreError(400, 'Poem lines are required');
  }
  const lines = input.lines
    .slice(0, 200)
    .map((line) => String(line).trim().slice(0, 2000))
    .filter(Boolean);
  if (!lines.length) throw new StoreError(400, 'The poem must contain at least one line');
  const fallbackTitle = lines[0].slice(0, 80);
  const title = String(input.title || fallbackTitle || 'Exquisite Corpse').trim().slice(0, 120);
  const reading = String(input.reading || '').trim().slice(0, 10000);
  return { title, lines, reading };
}

function initializeSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS cadavre_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cadavre_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES cadavre_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cadavre_poems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES cadavre_users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      reading TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cadavre_password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES cadavre_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cadavre_auth_rate_limits (
      rate_key TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cadavre_sessions_expiry
      ON cadavre_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cadavre_poems_user_updated
      ON cadavre_poems(user_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cadavre_resets_expiry
      ON cadavre_password_resets(expires_at);
  `);
}

class CadavreUserStore {
  constructor(options = {}) {
    this.databasePath = options.databasePath || defaultDatabasePath();
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    initializeSchema(this.db);
    this.now = options.now || (() => new Date());
    this.sendReset = options.sendReset || null;
    this.dummyHash = passwordHash(crypto.randomBytes(24).toString('base64url') + 'A1');
  }

  close() {
    this.db.close();
  }

  rateLimit(key, maximum, windowMs) {
    const now = this.now().getTime();
    const row = this.db.prepare(
      'SELECT window_started_at, attempts FROM cadavre_auth_rate_limits WHERE rate_key = ?'
    ).get(key);
    if (!row || now - row.window_started_at >= windowMs) {
      this.db.prepare(`
        INSERT INTO cadavre_auth_rate_limits (rate_key, window_started_at, attempts)
        VALUES (?, ?, 1)
        ON CONFLICT(rate_key) DO UPDATE SET window_started_at = excluded.window_started_at, attempts = 1
      `).run(key, now);
      return;
    }
    if (row.attempts >= maximum) {
      throw new StoreError(429, 'Too many attempts. Please try again later.');
    }
    this.db.prepare(
      'UPDATE cadavre_auth_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?'
    ).run(key);
  }

  createSession(userId) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const expires = new Date(now.getTime() + SESSION_TTL_MS);
    this.db.prepare(`
      INSERT INTO cadavre_sessions (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sha256(raw), userId, now.toISOString(), expires.toISOString());
    return { raw, expires };
  }

  sessionUser(rawToken) {
    if (!rawToken) return null;
    const now = this.now().toISOString();
    return this.db.prepare(`
      SELECT u.id, u.username, u.email
      FROM cadavre_sessions s
      JOIN cadavre_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
      LIMIT 1
    `).get(sha256(rawToken), now) || null;
  }

  register({ username: rawUsername, email: rawEmail, password: rawPassword }) {
    const username = validateUsername(rawUsername);
    const email = validateEmail(rawEmail);
    const password = validatePassword(rawPassword);
    const existing = this.db.prepare(`
      SELECT id FROM cadavre_users
      WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
      LIMIT 1
    `).get(username, email);
    if (existing) throw new StoreError(409, 'Username or email already registered');

    const now = this.now().toISOString();
    try {
      const result = this.db.prepare(`
        INSERT INTO cadavre_users (username, email, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(username, email, passwordHash(password), now, now);
      const user = { id: Number(result.lastInsertRowid), username, email };
      return { user, session: this.createSession(user.id) };
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new StoreError(409, 'Username or email already registered');
      }
      throw error;
    }
  }

  login(loginValue, password) {
    const login = String(loginValue || '').trim();
    const row = this.db.prepare(`
      SELECT id, username, email, password_hash
      FROM cadavre_users
      WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
      LIMIT 1
    `).get(login, login.toLowerCase());
    const matches = passwordMatches(String(password || ''), row ? row.password_hash : this.dummyHash);
    if (!row || !matches) throw new StoreError(401, 'Invalid username/email or password');
    const now = this.now().toISOString();
    this.db.prepare(
      'UPDATE cadavre_users SET last_login_at = ?, updated_at = ? WHERE id = ?'
    ).run(now, now, row.id);
    return {
      user: { id: row.id, username: row.username, email: row.email },
      session: this.createSession(row.id)
    };
  }

  logout(rawToken) {
    if (rawToken) {
      this.db.prepare('DELETE FROM cadavre_sessions WHERE token_hash = ?').run(sha256(rawToken));
    }
  }

  async requestPasswordReset(emailValue, resetUrlForToken) {
    const email = validateEmail(emailValue);
    const user = this.db.prepare(
      'SELECT id, username, email FROM cadavre_users WHERE email = ? COLLATE NOCASE LIMIT 1'
    ).get(email);
    if (!user) return;

    const raw = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const expires = new Date(now.getTime() + RESET_TTL_MS);
    this.db.prepare('DELETE FROM cadavre_password_resets WHERE user_id = ? OR expires_at <= ?')
      .run(user.id, now.toISOString());
    this.db.prepare(`
      INSERT INTO cadavre_password_resets (token_hash, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(sha256(raw), user.id, now.toISOString(), expires.toISOString());
    if (this.sendReset) await this.sendReset(user, resetUrlForToken(raw));
  }

  resetPassword(token, passwordValue) {
    const password = validatePassword(passwordValue);
    const now = this.now().toISOString();
    const row = this.db.prepare(`
      SELECT token_hash, user_id
      FROM cadavre_password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      LIMIT 1
    `).get(sha256(String(token || '')), now);
    if (!row) throw new StoreError(400, 'This reset link is invalid or has expired');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        'UPDATE cadavre_users SET password_hash = ?, updated_at = ? WHERE id = ?'
      ).run(passwordHash(password), now, row.user_id);
      this.db.prepare(
        'UPDATE cadavre_password_resets SET used_at = ? WHERE token_hash = ?'
      ).run(now, row.token_hash);
      this.db.prepare('DELETE FROM cadavre_sessions WHERE user_id = ?').run(row.user_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listPoems(userId) {
    return this.db.prepare(`
      SELECT id, title, lines_json, reading, revision, created_at, updated_at
      FROM cadavre_poems
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 200
    `).all(userId).map((row) => ({
      id: row.id,
      title: row.title,
      lines: JSON.parse(row.lines_json),
      reading: row.reading,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
  }

  createPoem(userId, input) {
    const poem = validatePoem(input);
    const now = this.now().toISOString();
    const result = this.db.prepare(`
      INSERT INTO cadavre_poems (user_id, title, lines_json, reading, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, poem.title, JSON.stringify(poem.lines), poem.reading, now, now);
    return { id: Number(result.lastInsertRowid), ...poem, revision: 1, created_at: now, updated_at: now };
  }

  updatePoem(userId, poemId, input) {
    const poem = validatePoem(input);
    const expectedRevision = Number(input.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new StoreError(400, 'expected_revision is required');
    }
    const now = this.now().toISOString();
    const result = this.db.prepare(`
      UPDATE cadavre_poems
      SET title = ?, lines_json = ?, reading = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND user_id = ? AND revision = ?
    `).run(poem.title, JSON.stringify(poem.lines), poem.reading, now, poemId, userId, expectedRevision);
    if (result.changes !== 1) {
      const exists = this.db.prepare(
        'SELECT revision FROM cadavre_poems WHERE id = ? AND user_id = ?'
      ).get(poemId, userId);
      if (!exists) throw new StoreError(404, 'Poem not found');
      throw new StoreError(409, 'This poem changed in another session', { revision: exists.revision });
    }
    return { id: poemId, ...poem, revision: expectedRevision + 1, updated_at: now };
  }

  deletePoem(userId, poemId) {
    const result = this.db.prepare(
      'DELETE FROM cadavre_poems WHERE id = ? AND user_id = ?'
    ).run(poemId, userId);
    if (result.changes !== 1) throw new StoreError(404, 'Poem not found');
  }
}

module.exports = {
  CadavreUserStore,
  StoreError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  defaultDatabasePath,
  passwordHash,
  passwordMatches,
  validatePassword,
  validatePoem
};
