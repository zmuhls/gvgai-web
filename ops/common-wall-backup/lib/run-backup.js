const { cleanPrefix, encodeBackup } = require('./backup-document');
const { createDatabasePool, readSnapshot, verifyRestorable } = require('./database');
const {
  createStorage,
  deleteExpiredBackups,
  deleteObjectQuietly,
  deleteStalePendingBackups,
  publishVerifiedBackup,
  retentionDays,
  updateLatestManifest,
  uploadPendingAndVerifyBackup
} = require('./storage');

async function closeResources(pool, storage) {
  await Promise.allSettled([
    pool ? pool.end() : Promise.resolve(),
    Promise.resolve().then(() => storage?.client?.destroy())
  ]);
}

async function runBackup(options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  const prefix = cleanPrefix(env.BACKUP_PREFIX);
  const days = retentionDays(env);
  let pool;
  let storage;
  let pending;
  try {
    pool = options.pool || createDatabasePool(env);
    storage = options.storage || createStorage(env);
    const document = await readSnapshot(pool, now);
    const encoded = encodeBackup(document);
    pending = await uploadPendingAndVerifyBackup({
      client: storage.client,
      bucket: storage.bucket,
      document,
      prefix,
      ...encoded
    });
    const restoreCheck = await verifyRestorable(pool, pending.document);
    const published = await publishVerifiedBackup({
      client: storage.client,
      bucket: storage.bucket,
      backup: pending
    });
    pending = null;
    await updateLatestManifest({
      client: storage.client,
      bucket: storage.bucket,
      prefix,
      backup: published
    });
    const deletedStalePending = await deleteStalePendingBackups({
      client: storage.client,
      bucket: storage.bucket,
      prefix,
      now
    });
    const deletedExpired = await deleteExpiredBackups({
      client: storage.client,
      bucket: storage.bucket,
      prefix,
      keepKey: published.key,
      now,
      days
    });
    return {
      event: 'common_wall_backup_complete',
      createdAt: document.createdAt,
      key: published.key,
      sha256: published.sha256,
      compressedBytes: published.compressed.length,
      posts: published.summary.posts,
      votes: published.summary.votes,
      migrations: published.summary.migrations,
      restoreCheckedPosts: restoreCheck.restoredPosts,
      restoreCheckedVotes: restoreCheck.restoredVotes,
      retentionDays: days,
      deletedStalePending,
      deletedExpired
    };
  } finally {
    if (pending && storage) {
      await deleteObjectQuietly(storage.client, storage.bucket, pending.key);
    }
    if (!options.keepOpen) await closeResources(options.pool ? null : pool, options.storage ? null : storage);
  }
}

module.exports = {
  closeResources,
  runBackup
};
