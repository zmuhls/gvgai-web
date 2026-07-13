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
  const applying = env.RESTORE_APPLY === 'true';
  let pool;
  let storage;
  let databaseEnv = env;
  try {
    if (applying) {
      const restoreDatabaseUrl = String(env.RESTORE_DATABASE_URL || '').trim();
      if (!restoreDatabaseUrl) throw new Error('RESTORE_DATABASE_URL is required to apply a backup.');
      if (restoreDatabaseUrl === String(env.DATABASE_URL || '').trim()) {
        throw new Error('RESTORE_DATABASE_URL must differ from the live DATABASE_URL.');
      }
      databaseEnv = { ...env, DATABASE_URL: restoreDatabaseUrl };
    }
    pool = options.pool || createDatabasePool(databaseEnv);
    storage = options.storage || createStorage(env);
    const key = selectedBackupKey(env, prefix);
    const backup = key
      ? await downloadBackup(storage.client, storage.bucket, key)
      : await loadLatestBackup(storage.client, storage.bucket, prefix);
    const check = await verifyRestorable(pool, backup.document);
    let applied = null;
    if (applying) {
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
      votes: backup.summary.votes,
      restoreCheckedPosts: check.restoredPosts,
      restoreCheckedVotes: check.restoredVotes,
      applied
    };
  } finally {
    await Promise.allSettled([
      options.pool || !pool ? Promise.resolve() : pool.end(),
      Promise.resolve().then(() => options.storage || !storage ? undefined : storage.client.destroy())
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
