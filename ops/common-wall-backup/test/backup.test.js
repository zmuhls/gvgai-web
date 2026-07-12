const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
const { readSnapshot, verifyRestorable } = require('../lib/database');
const {
  deleteExpiredBackups,
  loadLatestBackup,
  updateLatestManifest,
  uploadAndVerifyBackup
} = require('../lib/storage');
const { safeErrorMessage } = require('../index');
const { selectedBackupKey } = require('../restore');

const NOW = new Date('2026-07-12T04:00:00.000Z');
const POST_ID = '123e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);

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
    volumeImports: [{
      source_digest: 'c'.repeat(64),
      source_name: 'cadavre-wall.json',
      source_row_count: 0,
      imported_row_count: 0,
      imported_at: '2026-07-12T00:00:00.000Z'
    }],
    importedVolumeRowCount: 0
  }, NOW);
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
      if (/FROM wall_schema_migrations/.test(sql)) return { rows: [{
        name: '001_create_wall_posts.sql', checksum: 'b'.repeat(64),
        applied_at: '2026-07-11T23:00:00.000Z'
      }] };
      if (/FROM wall_volume_imports/.test(sql)) return { rows: [] };
      if (/wall_volume_imported_rows/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [] };
    },
    release() {}
  };
  const document = await readSnapshot({ async connect() { return client; } }, NOW);
  assert.equal(document.posts[0].deleteTokenHash, HASH);
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
  assert.deepEqual(result, { restoredPosts: 1 });
  const insert = queries.find(entry => /INSERT INTO common_wall_restore_check/.test(entry.sql));
  assert.equal(insert.values[0], POST_ID);
  assert.equal(insert.values[5], HASH);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
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
  const backup = await uploadAndVerifyBackup({
    client, bucket: 'test-bucket', document, prefix: 'common-wall/daily', ...encoded
  });
  await updateLatestManifest({
    client, bucket: 'test-bucket', prefix: 'common-wall/daily', backup
  });
  const latest = await loadLatestBackup(client, 'test-bucket', 'common-wall/daily');
  assert.equal(latest.sha256, encoded.sha256);
  assert.equal(latest.summary.posts, 1);
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
    days: 35
  });
  assert.equal(deleted, 1);
  assert.equal(client.objects.has('common-wall/daily/old.json.gz'), false);
  assert.equal(client.objects.has('common-wall/daily/current.json.gz'), true);
  assert.equal(client.objects.has('common-wall/daily/latest.json'), true);
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

test('backup errors redact database and bucket credentials', () => {
  const env = {
    DATABASE_URL: 'postgresql://user:password@postgres.railway.internal/db',
    BACKUP_BUCKET_ACCESS_KEY_ID: 'access-key-secret',
    BACKUP_BUCKET_SECRET_ACCESS_KEY: 'bucket-secret-value'
  };
  const message = safeErrorMessage(new Error(
    `${env.DATABASE_URL} ${env.BACKUP_BUCKET_ACCESS_KEY_ID} ${env.BACKUP_BUCKET_SECRET_ACCESS_KEY}`
  ), env);
  assert.doesNotMatch(message, /password|access-key-secret|bucket-secret-value/);
});
