const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} = require('@aws-sdk/client-s3');
const {
  backupObjectKey,
  buildBackupDocument,
  cleanPrefix,
  decodeBackup,
  encodeBackup,
  validateBackupDocument
} = require('../lib/backup-document');
const { applyRestore, readSnapshot, verifyRestorable } = require('../lib/database');
const { runBackup } = require('../lib/run-backup');
const {
  deleteExpiredBackups,
  deleteStalePendingBackups,
  loadLatestBackup,
  publishVerifiedBackup,
  updateLatestManifest,
  uploadPendingAndVerifyBackup
} = require('../lib/storage');
const { jobTimeoutMillis, safeErrorMessage } = require('../index');
const { restore, selectedBackupKey } = require('../restore');

const NOW = new Date('2026-07-12T04:00:00.000Z');
const POST_ID = '123e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);
const VOTER_HASH = 'c'.repeat(64);

function sampleDocument() {
  return buildBackupDocument({
    schemaMigrations: [{
      name: '001_create_wall_posts.sql',
      checksum: 'b'.repeat(64),
      applied_at: '2026-07-11T23:00:00.000Z'
    }],
    posts: [{
      id: POST_ID,
      created_at: '2026-07-12T03:00:00.000Z',
      author_name: 'Backup Writer',
      poem: 'the copper orchard',
      analysis: null,
      delete_token_hash: HASH
    }],
    votes: [{
      post_id: POST_ID,
      voter_token_hash: VOTER_HASH,
      vote: 1,
      created_at: '2026-07-12T03:15:00.000Z',
      updated_at: '2026-07-12T03:30:00.000Z'
    }]
  }, NOW);
}

function sampleLegacyDocument() {
  const current = sampleDocument();
  return {
    ...current,
    version: 2,
    source: { schema: 'public', table: 'wall_posts' },
    votes: undefined
  };
}

test('backup document round-trips through deterministic gzip with a dated object key', () => {
  const document = sampleDocument();
  const first = encodeBackup(document);
  const second = encodeBackup(document);
  assert.deepEqual(first.compressed, second.compressed);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(decodeBackup(first.compressed).document, document);
  assert.equal(
    backupObjectKey(document, first.sha256, 'common-wall/daily'),
    `common-wall/daily/2026-07-12T04-00-00-000Z-${first.sha256.slice(0, 12)}.json.gz`
  );
});

test('backup validation rejects duplicate ids and missing deletion hashes', () => {
  const duplicate = sampleDocument();
  duplicate.posts.push({ ...duplicate.posts[0] });
  assert.throws(() => validateBackupDocument(duplicate), /invalid or duplicate wall post id/);

  const missingHash = sampleDocument();
  missingHash.posts[0].deleteTokenHash = '';
  assert.throws(() => validateBackupDocument(missingHash), /invalid deletion hash/);
  assert.throws(() => cleanPrefix('../escape'), /path-safe/);
});

test('backup validation checks vote references, values, hashes, and uniqueness', () => {
  const unknownPost = sampleDocument();
  unknownPost.votes[0].postId = '123e4567-e89b-42d3-a456-426614174001';
  assert.throws(() => validateBackupDocument(unknownPost), /unknown wall post/);

  const invalidValue = sampleDocument();
  invalidValue.votes[0].vote = 0;
  assert.throws(() => validateBackupDocument(invalidValue), /invalid wall vote value/);

  const invalidHash = sampleDocument();
  invalidHash.votes[0].voterTokenHash = VOTER_HASH.toUpperCase();
  assert.throws(() => validateBackupDocument(invalidHash), /invalid voter token hash/);

  const duplicate = sampleDocument();
  duplicate.votes.push({ ...duplicate.votes[0] });
  assert.throws(() => validateBackupDocument(duplicate), /duplicate wall vote/);
});

test('version 2 archives decode as snapshots with no votes', () => {
  const legacy = sampleLegacyDocument();
  const bytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const compressed = zlib.gzipSync(bytes, { level: 9, mtime: 0 });
  const decoded = decodeBackup(compressed);
  assert.equal(decoded.document.version, 2);
  assert.deepEqual(decoded.document.votes, []);
  assert.equal(decoded.summary.votes, 0);
});

test('database snapshot uses a read-only transaction and keeps private hashes', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/FROM wall_posts/.test(sql)) return { rows: [{
        id: POST_ID,
        created_at: '2026-07-12T03:00:00.000Z',
        author_name: 'Backup Writer',
        poem: 'the copper orchard',
        analysis: null,
        delete_token_hash: HASH
      }] };
      if (/FROM wall_post_votes/.test(sql)) return { rows: [{
        post_id: POST_ID,
        voter_token_hash: VOTER_HASH,
        vote: 1,
        created_at: '2026-07-12T03:15:00.000Z',
        updated_at: '2026-07-12T03:30:00.000Z'
      }] };
      if (/FROM wall_schema_migrations/.test(sql)) return { rows: [{
        name: '001_create_wall_posts.sql', checksum: 'b'.repeat(64),
        applied_at: '2026-07-11T23:00:00.000Z'
      }] };
      return { rows: [] };
    },
    release() {}
  };
  const document = await readSnapshot({ async connect() { return client; } }, NOW);
  assert.equal(document.posts[0].deleteTokenHash, HASH);
  assert.equal(document.votes[0].voterTokenHash, VOTER_HASH);
  assert.match(queries[0], /REPEATABLE READ READ ONLY/);
  assert.equal(queries.at(-1), 'COMMIT');
});

test('restore verification inserts into a temporary table and always rolls back', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (/SELECT count/.test(sql)) return { rows: [{ count: 1 }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const result = await verifyRestorable({ async connect() { return client; } }, sampleDocument());
  assert.deepEqual(result, { restoredPosts: 1, restoredVotes: 1 });
  const postInsert = queries.find(entry => /INSERT INTO common_wall_restore_check_posts/.test(entry.sql));
  assert.equal(postInsert.values[0], POST_ID);
  assert.equal(postInsert.values[5], HASH);
  const voteInsert = queries.find(entry => /INSERT INTO common_wall_restore_check_votes/.test(entry.sql));
  assert.deepEqual(voteInsert.values.slice(0, 3), [POST_ID, VOTER_HASH, 1]);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
});

test('applied restore locks and refuses a nonempty target', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (/FROM wall_posts/.test(sql) && /FROM wall_post_votes/.test(sql)) {
        return { rows: [{ posts: 1, votes: 0 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    applyRestore({ async connect() { return client; } }, sampleDocument()),
    /must be empty/
  );
  assert.equal(queries[0], 'BEGIN');
  assert.match(queries[1], /ACCESS EXCLUSIVE/);
  assert.match(queries[1], /wall_post_votes/);
  assert.equal(queries.at(-1), 'ROLLBACK');
});

test('applied restore inserts posts before votes into an empty locked target', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (/FROM wall_posts/.test(sql) && /FROM wall_post_votes/.test(sql)) {
        return { rows: [{ posts: 0, votes: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const result = await applyRestore({ async connect() { return client; } }, sampleDocument());
  assert.deepEqual(result, { inserted: 1, existing: 0, insertedVotes: 1, existingVotes: 0 });
  const postIndex = queries.findIndex(entry => /INSERT INTO wall_posts/.test(entry.sql));
  const voteIndex = queries.findIndex(entry => /INSERT INTO wall_post_votes/.test(entry.sql));
  assert.ok(postIndex > 0);
  assert.ok(voteIndex > postIndex);
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

class MemoryS3 {
  constructor() {
    this.objects = new Map();
  }

  async send(command) {
    const input = command.input;
    if (command instanceof PutObjectCommand) {
      this.objects.set(input.Key, {
        body: Buffer.from(input.Body),
        metadata: input.Metadata || {},
        modifiedAt: NOW
      });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw new Error('missing object');
      return { ContentLength: object.body.length, Metadata: object.metadata };
    }
    if (command instanceof CopyObjectCommand) {
      const sourceKey = decodeURIComponent(input.CopySource).split('/').slice(1).join('/');
      const source = this.objects.get(sourceKey);
      if (!source) throw new Error('missing copy source');
      this.objects.set(input.Key, {
        body: Buffer.from(source.body),
        metadata: { ...source.metadata },
        modifiedAt: NOW
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw new Error('missing object');
      return { Body: object.body, Metadata: object.metadata };
    }
    if (command instanceof ListObjectsV2Command) {
      return {
        IsTruncated: false,
        Contents: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(input.Prefix))
          .map(([Key, object]) => ({ Key, LastModified: object.modifiedAt }))
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  }
}

test('object storage upload is downloaded, checksummed, and discoverable as latest', async () => {
  const client = new MemoryS3();
  const document = sampleDocument();
  const encoded = encodeBackup(document);
  const pending = await uploadPendingAndVerifyBackup({
    client, bucket: 'test-bucket', document, prefix: 'common-wall/daily', ...encoded
  });
  assert.match(pending.key, /common-wall\/daily\/pending\//);
  const backup = await publishVerifiedBackup({ client, bucket: 'test-bucket', backup: pending });
  assert.doesNotMatch(backup.key, /\/pending\//);
  assert.equal(client.objects.has(pending.key), false);
  await updateLatestManifest({
    client, bucket: 'test-bucket', prefix: 'common-wall/daily', backup
  });
  const latest = await loadLatestBackup(client, 'test-bucket', 'common-wall/daily');
  assert.equal(latest.sha256, encoded.sha256);
  assert.equal(latest.summary.posts, 1);
  assert.equal(latest.summary.votes, 1);
  assert.equal(client.objects.get(backup.key).metadata.votes, '1');
  const manifest = JSON.parse(client.objects.get('common-wall/daily/latest.json').body.toString('utf8'));
  assert.equal(manifest.version, 3);
  assert.equal(manifest.votes, 1);
});

test('latest manifest accepts a version 2 archive and supplies an empty vote list', async () => {
  const client = new MemoryS3();
  const legacy = sampleLegacyDocument();
  const bytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  const compressed = zlib.gzipSync(bytes, { level: 9, mtime: 0 });
  const sha256 = crypto.createHash('sha256').update(compressed).digest('hex');
  const key = 'common-wall/daily/legacy.json.gz';
  client.objects.set(key, {
    body: compressed,
    metadata: { sha256 },
    modifiedAt: NOW
  });
  client.objects.set('common-wall/daily/latest.json', {
    body: Buffer.from(`${JSON.stringify({
      format: legacy.format,
      version: 2,
      createdAt: legacy.createdAt,
      key,
      sha256,
      posts: 1,
      migrations: 1
    })}\n`),
    metadata: {},
    modifiedAt: NOW
  });
  const latest = await loadLatestBackup(client, 'test-bucket', 'common-wall/daily');
  assert.equal(latest.document.version, 2);
  assert.deepEqual(latest.document.votes, []);
  assert.equal(latest.summary.votes, 0);
});

test('backup receipt reports archived and restore-checked vote counts', async () => {
  const client = new MemoryS3();
  const databaseClient = {
    async query(sql) {
      if (/FROM wall_posts\s+ORDER BY/.test(sql)) return { rows: [{
        id: POST_ID,
        created_at: '2026-07-12T03:00:00.000Z',
        author_name: 'Backup Writer',
        poem: 'the copper orchard',
        analysis: null,
        delete_token_hash: HASH
      }] };
      if (/FROM wall_post_votes\s+ORDER BY/.test(sql)) return { rows: [{
        post_id: POST_ID,
        voter_token_hash: VOTER_HASH,
        vote: 1,
        created_at: '2026-07-12T03:15:00.000Z',
        updated_at: '2026-07-12T03:30:00.000Z'
      }] };
      if (/FROM wall_schema_migrations/.test(sql)) return { rows: [{
        name: '004_create_wall_post_votes.sql',
        checksum: 'd'.repeat(64),
        applied_at: '2026-07-12T02:00:00.000Z'
      }] };
      if (/count\(\*\).*common_wall_restore_check_posts/.test(sql)) {
        return { rows: [{ count: 1 }] };
      }
      if (/count\(\*\).*common_wall_restore_check_votes/.test(sql)) {
        return { rows: [{ count: 1 }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const receipt = await runBackup({
    pool: { async connect() { return databaseClient; } },
    storage: { client, bucket: 'test-bucket' },
    env: { BACKUP_PREFIX: 'common-wall/daily', BACKUP_RETENTION_DAYS: '35' },
    now: NOW
  });
  assert.equal(receipt.posts, 1);
  assert.equal(receipt.votes, 1);
  assert.equal(receipt.restoreCheckedPosts, 1);
  assert.equal(receipt.restoreCheckedVotes, 1);
});

test('retention cleanup deletes only expired compressed backups', async () => {
  const client = new MemoryS3();
  client.objects.set('common-wall/daily/old.json.gz', {
    body: Buffer.from('old'), metadata: {}, modifiedAt: new Date('2026-05-01T00:00:00Z')
  });
  client.objects.set('common-wall/daily/current.json.gz', {
    body: Buffer.from('new'), metadata: {}, modifiedAt: NOW
  });
  client.objects.set('common-wall/daily/latest.json', {
    body: Buffer.from('{}'), metadata: {}, modifiedAt: new Date('2026-05-01T00:00:00Z')
  });
  const deleted = await deleteExpiredBackups({
    client,
    bucket: 'test-bucket',
    prefix: 'common-wall/daily',
    keepKey: 'common-wall/daily/current.json.gz',
    now: NOW,
    days: 35,
    minimumArchives: 1
  });
  assert.equal(deleted, 1);
  assert.equal(client.objects.has('common-wall/daily/old.json.gz'), false);
  assert.equal(client.objects.has('common-wall/daily/current.json.gz'), true);
  assert.equal(client.objects.has('common-wall/daily/latest.json'), true);
});

test('retention preserves at least seven recovery points after a long outage', async () => {
  const client = new MemoryS3();
  for (let index = 0; index < 9; index += 1) {
    client.objects.set(`common-wall/daily/archive-${index}.json.gz`, {
      body: Buffer.from(String(index)),
      metadata: {},
      modifiedAt: new Date(Date.UTC(2026, 0, index + 1))
    });
  }
  const deleted = await deleteExpiredBackups({
    client,
    bucket: 'test-bucket',
    prefix: 'common-wall/daily',
    keepKey: 'common-wall/daily/archive-8.json.gz',
    now: NOW,
    days: 35
  });
  assert.equal(deleted, 2);
  assert.equal([...client.objects.keys()].filter(key => key.endsWith('.json.gz')).length, 7);
});

test('a later run removes stale pending uploads without touching recent ones', async () => {
  const client = new MemoryS3();
  client.objects.set('common-wall/daily/pending/stale.json.gz', {
    body: Buffer.from('stale'), metadata: {}, modifiedAt: new Date('2026-07-10T00:00:00Z')
  });
  client.objects.set('common-wall/daily/pending/recent.json.gz', {
    body: Buffer.from('recent'), metadata: {}, modifiedAt: new Date('2026-07-12T03:30:00Z')
  });
  const deleted = await deleteStalePendingBackups({
    client,
    bucket: 'test-bucket',
    prefix: 'common-wall/daily',
    now: NOW
  });
  assert.equal(deleted, 1);
  assert.equal(client.objects.has('common-wall/daily/pending/stale.json.gz'), false);
  assert.equal(client.objects.has('common-wall/daily/pending/recent.json.gz'), true);
});

test('restore selection stays under the configured prefix', () => {
  assert.equal(
    selectedBackupKey({ BACKUP_KEY: 'common-wall/daily/a.json.gz' }, 'common-wall/daily'),
    'common-wall/daily/a.json.gz'
  );
  assert.throws(
    () => selectedBackupKey({ BACKUP_KEY: 'other/a.json.gz' }, 'common-wall/daily'),
    /must name a compressed object/
  );
});

test('applied restore requires a separate target database URL', async () => {
  await assert.rejects(
    restore({
      env: {
        BACKUP_PREFIX: 'common-wall/daily',
        RESTORE_APPLY: 'true',
        RESTORE_CONFIRM: 'restore-common-wall'
      }
    }),
    /RESTORE_DATABASE_URL is required/
  );
  await assert.rejects(
    restore({
      env: {
        BACKUP_PREFIX: 'common-wall/daily',
        DATABASE_URL: 'postgres://live',
        RESTORE_DATABASE_URL: 'postgres://live',
        RESTORE_APPLY: 'true',
        RESTORE_CONFIRM: 'restore-common-wall'
      }
    }),
    /must differ from the live DATABASE_URL/
  );
});

test('backup errors redact database and bucket credentials', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:password@postgres.railway.internal/db',
    RESTORE_DATABASE_URL: 'postgresql://restore:password@replacement.railway.internal/db',
    BACKUP_BUCKET_ACCESS_KEY_ID: 'access-key-secret',
    BACKUP_BUCKET_SECRET_ACCESS_KEY: 'bucket-secret-value'
  };
  const message = safeErrorMessage(new Error(
    `${env.DATABASE_URL} ${env.RESTORE_DATABASE_URL} ${env.BACKUP_BUCKET_ACCESS_KEY_ID} ${env.BACKUP_BUCKET_SECRET_ACCESS_KEY}`
  ), env);
  assert.doesNotMatch(message, /password|access-key-secret|bucket-secret-value/);
});

test('job timeout is bounded between one and fifteen minutes', () => {
  assert.equal(jobTimeoutMillis({}), 600000);
  assert.equal(jobTimeoutMillis({ BACKUP_JOB_TIMEOUT_MS: '1' }), 60000);
  assert.equal(jobTimeoutMillis({ BACKUP_JOB_TIMEOUT_MS: '99999999' }), 900000);
});
