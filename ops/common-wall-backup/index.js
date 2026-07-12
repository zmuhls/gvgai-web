const { runBackup } = require('./lib/run-backup');

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

function jobTimeoutMillis(env = process.env) {
  const parsed = Number.parseInt(env.BACKUP_JOB_TIMEOUT_MS, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_JOB_TIMEOUT_MS;
  return Math.min(15 * 60 * 1000, Math.max(60 * 1000, parsed));
}

function safeErrorMessage(error, env = process.env) {
  let message = String(error?.message || 'Backup failed.');
  for (const name of [
    'DATABASE_URL',
    'RESTORE_DATABASE_URL',
    'BACKUP_BUCKET_ACCESS_KEY_ID',
    'BACKUP_BUCKET_SECRET_ACCESS_KEY'
  ]) {
    const secret = String(env[name] || '');
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@').slice(0, 500);
}

if (require.main === module) {
  const timeoutMillis = jobTimeoutMillis();
  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({
      event: 'common_wall_backup_timed_out',
      timeoutMillis
    }));
    process.exit(1);
  }, timeoutMillis);
  runBackup().then((receipt) => {
    clearTimeout(watchdog);
    console.log(JSON.stringify(receipt));
  }).catch((error) => {
    clearTimeout(watchdog);
    console.error(JSON.stringify({
      event: 'common_wall_backup_failed',
      error: String(error?.name || error?.code || 'Error'),
      message: safeErrorMessage(error)
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  jobTimeoutMillis,
  safeErrorMessage
};
