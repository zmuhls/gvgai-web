const { cleanPrefix, encodeBackup } = require('./backup-document');
const { createDatabasePool, readSnapshot, verifyRestorable } = require('./database');
const {
  createStorage,
  deleteExpiredBackups,
  retentionDays,
  updateLatestManifest,
  uploadAndVerifyBackup
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
  try {
    pool = options.pool || createDatabasePool(env);
    storage = options.storage || createStorage(env);
    const document = await readSnapshot(pool, now);
    const encoded = encodeBackup(document);
    const downloaded = await uploadAndVerifyBackup({
      client: storage.client,
      bucket: storage.bucket,
      document,
      prefix,
      ...encoded
    });
    const restoreCheck = await verifyRestorable(pool, downloaded.document);
    await updateLatestManifest({
      client: storage.client,
      bucket: storage.bucket,
      prefix,
      backup: downloaded
    });
    const deletedExpired = await deleteExpiredBackups({
      client: storage.client,
      bucket: storage.bucket,
      prefix,
      keepKey: downloaded.key,
      now,
      days
    });
    return {
      event: 'common_wall_backup_complete',
      createdAt: document.createdAt,
      key: downloaded.key,
      sha256: downloaded.sha256,
      compressedBytes: downloaded.compressed.length,
      posts: downloaded.summary.posts,
      migrations: downloaded.summary.migrations,
      restoreCheckedPosts: restoreCheck.restoredPosts,
      retentionDays: days,
      deletedExpired
    };
  } finally {
    if (!options.keepOpen) await closeResources(options.pool ? null : pool, options.storage ? null : storage);
  }
}

module.exports = {
  closeResources,
  runBackup
};
