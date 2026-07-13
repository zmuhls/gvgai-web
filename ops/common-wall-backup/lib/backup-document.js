const crypto = require('crypto');
const zlib = require('zlib');

const BACKUP_FORMAT = 'inference-arcade/common-wall';
const FORMAT_VERSION = 3;
const LEGACY_FORMAT_VERSION = 2;
const DEFAULT_PREFIX = 'common-wall/daily';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp.`);
  return date.toISOString();
}

function cleanPrefix(value = DEFAULT_PREFIX) {
  const prefix = String(value || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
  if (!prefix || !/^[a-z0-9/_-]+$/i.test(prefix) || prefix.includes('..')) {
    throw new Error('BACKUP_PREFIX must contain only path-safe characters.');
  }
  return prefix;
}

function buildBackupDocument(snapshot, createdAt = new Date()) {
  return {
    format: BACKUP_FORMAT,
    version: FORMAT_VERSION,
    createdAt: isoTimestamp(createdAt, 'createdAt'),
    source: { schema: 'public', table: 'wall_posts', voteTable: 'wall_post_votes' },
    schemaMigrations: (snapshot.schemaMigrations || []).map(row => ({
      name: String(row.name),
      checksum: String(row.checksum).trim(),
      appliedAt: isoTimestamp(row.applied_at ?? row.appliedAt, 'schema migration appliedAt')
    })),
    posts: (snapshot.posts || []).map(row => ({
      id: String(row.id),
      createdAt: isoTimestamp(row.created_at ?? row.createdAt, 'wall post createdAt'),
      authorName: String(row.author_name ?? row.authorName),
      poem: String(row.poem),
      analysis: row.analysis === undefined || row.analysis === null ? null : String(row.analysis),
      deleteTokenHash: String(row.delete_token_hash ?? row.deleteTokenHash).trim()
    })),
    votes: (snapshot.votes || []).map(row => ({
      postId: String(row.post_id ?? row.postId),
      voterTokenHash: String(row.voter_token_hash ?? row.voterTokenHash).trim(),
      vote: Number(row.vote),
      createdAt: isoTimestamp(row.created_at ?? row.createdAt, 'wall vote createdAt'),
      updatedAt: isoTimestamp(row.updated_at ?? row.updatedAt, 'wall vote updatedAt')
    }))
  };
}

function normalizedBackupDocument(document) {
  if (document?.version !== LEGACY_FORMAT_VERSION || Array.isArray(document.votes)) return document;
  return { ...document, votes: [] };
}

function validateBackupDocument(document) {
  if (!document || typeof document !== 'object') throw new Error('Backup must be a JSON object.');
  if (document.format !== BACKUP_FORMAT ||
      ![LEGACY_FORMAT_VERSION, FORMAT_VERSION].includes(document.version)) {
    throw new Error('Backup format or version is unsupported.');
  }
  isoTimestamp(document.createdAt, 'createdAt');
  if (document.source?.schema !== 'public' || document.source?.table !== 'wall_posts') {
    throw new Error('Backup source must be public.wall_posts.');
  }
  if (document.version === FORMAT_VERSION && document.source?.voteTable !== 'wall_post_votes') {
    throw new Error('Backup vote source must be public.wall_post_votes.');
  }
  if (!Array.isArray(document.schemaMigrations) || !Array.isArray(document.posts) ||
      !Array.isArray(document.votes)) {
    throw new Error('Backup migrations, posts, and votes must be arrays.');
  }
  if (document.version === LEGACY_FORMAT_VERSION && document.votes.length !== 0) {
    throw new Error('Version 2 backups cannot contain votes.');
  }

  for (const migration of document.schemaMigrations) {
    if (!/^\d+_[a-z0-9_-]+\.sql$/i.test(migration?.name || '')) {
      throw new Error('Backup contains an invalid migration name.');
    }
    if (!SHA256_RE.test(migration?.checksum || '')) {
      throw new Error('Backup contains an invalid migration checksum.');
    }
    isoTimestamp(migration.appliedAt, 'schema migration appliedAt');
  }

  const ids = new Set();
  for (const post of document.posts) {
    if (!UUID_RE.test(post?.id || '') || ids.has(post.id)) {
      throw new Error('Backup contains an invalid or duplicate wall post id.');
    }
    ids.add(post.id);
    isoTimestamp(post.createdAt, 'wall post createdAt');
    if (typeof post.authorName !== 'string' || post.authorName.length < 1 || post.authorName.length > 80) {
      throw new Error('Backup contains an invalid author name.');
    }
    if (typeof post.poem !== 'string' || post.poem.length < 1 || post.poem.length > 12000) {
      throw new Error('Backup contains an invalid poem.');
    }
    if (post.analysis !== null && (typeof post.analysis !== 'string' || post.analysis.length > 16000)) {
      throw new Error('Backup contains an invalid analysis.');
    }
    if (!SHA256_RE.test(post.deleteTokenHash || '')) {
      throw new Error('Backup contains an invalid deletion hash.');
    }
  }

  const voteKeys = new Set();
  for (const vote of document.votes) {
    const key = `${vote?.postId || ''}:${vote?.voterTokenHash || ''}`;
    if (!UUID_RE.test(vote?.postId || '') || !ids.has(vote.postId)) {
      throw new Error('Backup contains a vote for an unknown wall post.');
    }
    if (!SHA256_RE.test(vote?.voterTokenHash || '')) {
      throw new Error('Backup contains an invalid voter token hash.');
    }
    if (voteKeys.has(key)) {
      throw new Error('Backup contains a duplicate wall vote.');
    }
    voteKeys.add(key);
    if (!Number.isInteger(vote.vote) || ![-1, 1].includes(vote.vote)) {
      throw new Error('Backup contains an invalid wall vote value.');
    }
    isoTimestamp(vote.createdAt, 'wall vote createdAt');
    isoTimestamp(vote.updatedAt, 'wall vote updatedAt');
  }

  return {
    posts: document.posts.length,
    votes: document.votes.length,
    migrations: document.schemaMigrations.length
  };
}

function encodeBackup(document) {
  const summary = validateBackupDocument(document);
  const json = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const compressed = zlib.gzipSync(json, { level: 9, mtime: 0 });
  const sha256 = crypto.createHash('sha256').update(compressed).digest('hex');
  return { compressed, json, sha256, summary };
}

function decodeBackup(compressed) {
  const bytes = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed);
  const json = zlib.gunzipSync(bytes).toString('utf8');
  const document = normalizedBackupDocument(JSON.parse(json));
  const summary = validateBackupDocument(document);
  return { document, json, summary };
}

function backupObjectKey(document, sha256, prefix = DEFAULT_PREFIX) {
  if (!SHA256_RE.test(sha256)) throw new Error('Backup checksum must be lowercase SHA-256 hex.');
  const timestamp = isoTimestamp(document.createdAt, 'createdAt').replace(/[:.]/g, '-');
  return `${cleanPrefix(prefix)}/${timestamp}-${sha256.slice(0, 12)}.json.gz`;
}

module.exports = {
  BACKUP_FORMAT,
  FORMAT_VERSION,
  LEGACY_FORMAT_VERSION,
  DEFAULT_PREFIX,
  UUID_RE,
  SHA256_RE,
  backupObjectKey,
  buildBackupDocument,
  cleanPrefix,
  decodeBackup,
  encodeBackup,
  isoTimestamp,
  normalizedBackupDocument,
  validateBackupDocument
};
