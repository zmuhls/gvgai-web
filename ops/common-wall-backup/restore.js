const { cleanPrefix } = require('./lib/backup-document');
const { applyRestore, createDatabasePool, verifyRestorable } = require('./lib/database');
const { createStorage, downloadBackup, loadLatestBackup } = require('./lib/storage');
const { safeErrorMessage } = require('./index');

function selectedBackupKey(env, prefix) {
  const key = String(env.BACKUP_KEY || '').trim();
  if (!key) return '';
  if (!key.startsWith(`${prefix}/`) || !key.endsWith('.json.gz') || key.includes('..')) {
    throw new Error('BACKUP_KEY must name a compressed object under BACKUP_PREFIX.');
  }
  return key;
}

async function restore(options = {}) {
  const env = options.env || process.env;
  const prefix = cleanPrefix(env.BACKUP_PREFIX);
  const pool = options.pool || createDatabasePool(env);
  const storage = options.storage || createStorage(env);
  try {
    const key = selectedBackupKey(env, prefix);
    const backup = key
      ? await downloadBackup(storage.client, storage.bucket, key)
      : await loadLatestBackup(storage.client, storage.bucket, prefix);
    const check = await verifyRestorable(pool, backup.document);
    let applied = null;
    if (env.RESTORE_APPLY === 'true') {
      if (env.RESTORE_CONFIRM !== 'restore-common-wall') {
        throw new Error('RESTORE_CONFIRM=restore-common-wall is required to apply a backup.');
      }
      applied = await applyRestore(pool, backup.document);
    }
    return {
      event: applied ? 'common_wall_restore_complete' : 'common_wall_restore_verified',
      key: backup.key,
      sha256: backup.sha256,
      posts: backup.summary.posts,
      restoreCheckedPosts: check.restoredPosts,
      applied
    };
  } finally {
    await Promise.allSettled([
      options.pool ? Promise.resolve() : pool.end(),
      Promise.resolve().then(() => options.storage ? undefined : storage.client.destroy())
    ]);
  }
}

if (require.main === module) {
  restore().then((receipt) => {
    console.log(JSON.stringify(receipt));
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'common_wall_restore_failed',
      error: String(error?.name || error?.code || 'Error'),
      message: safeErrorMessage(error)
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  restore,
  selectedBackupKey
};
