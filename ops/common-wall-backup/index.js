const { runBackup } = require('./lib/run-backup');

function safeErrorMessage(error, env = process.env) {
  let message = String(error?.message || 'Backup failed.');
  for (const name of [
    'DATABASE_URL',
    'BACKUP_BUCKET_ACCESS_KEY_ID',
    'BACKUP_BUCKET_SECRET_ACCESS_KEY'
  ]) {
    const secret = String(env[name] || '');
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@').slice(0, 500);
}

if (require.main === module) {
  runBackup().then((receipt) => {
    console.log(JSON.stringify(receipt));
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'common_wall_backup_failed',
      error: String(error?.name || error?.code || 'Error'),
      message: safeErrorMessage(error)
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  safeErrorMessage
};
