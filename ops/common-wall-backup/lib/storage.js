const crypto = require('crypto');
const {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const {
  BACKUP_FORMAT,
  FORMAT_VERSION,
  SHA256_RE,
  backupObjectKey,
  cleanPrefix,
  decodeBackup
} = require('./backup-document');

function requiredValue(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function storageConfig(env = process.env) {
  const endpoint = requiredValue(env, 'BACKUP_BUCKET_ENDPOINT');
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== 'https:') throw new Error('BACKUP_BUCKET_ENDPOINT must use HTTPS.');
  const urlStyle = String(env.BACKUP_BUCKET_URL_STYLE || 'virtual').toLowerCase();
  if (!['virtual', 'path'].includes(urlStyle)) {
    throw new Error('BACKUP_BUCKET_URL_STYLE must be virtual or path.');
  }
  return {
    bucket: requiredValue(env, 'BACKUP_BUCKET_NAME'),
    endpoint: parsedEndpoint.origin,
    region: String(env.BACKUP_BUCKET_REGION || 'auto').trim() || 'auto',
    accessKeyId: requiredValue(env, 'BACKUP_BUCKET_ACCESS_KEY_ID'),
    secretAccessKey: requiredValue(env, 'BACKUP_BUCKET_SECRET_ACCESS_KEY'),
    forcePathStyle: urlStyle === 'path'
  };
}

function createStorage(env = process.env) {
  const config = storageConfig(env);
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    },
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000,
      socketTimeout: 30000
    })
  });
  return { client, bucket: config.bucket };
}

async function bodyToBuffer(body) {
  if (!body) throw new Error('Backup object has no body.');
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function latestObjectKey(prefix) {
  return `${cleanPrefix(prefix)}/latest.json`;
}

function pendingObjectKey(document, sha256, prefix) {
  const safePrefix = cleanPrefix(prefix);
  const finalKey = backupObjectKey(document, sha256, safePrefix);
  return `${safePrefix}/pending/${finalKey.slice(safePrefix.length + 1)}`;
}

function copySource(bucket, key) {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadBackup(client, bucket, key, expectedSha256 = '') {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const compressed = await bodyToBuffer(response.Body);
  const sha256 = checksum(compressed);
  const metadataSha = String(response.Metadata?.sha256 || '').toLowerCase();
  if ((expectedSha256 && sha256 !== expectedSha256) || (metadataSha && sha256 !== metadataSha)) {
    throw new Error('Downloaded backup checksum does not match its manifest.');
  }
  const decoded = decodeBackup(compressed);
  return { ...decoded, compressed, sha256, key };
}

async function putBackupObject(client, bucket, key, document, compressed, sha256, summary) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: compressed,
    ContentType: 'application/json',
    ContentEncoding: 'gzip',
    Metadata: {
      sha256,
      format: BACKUP_FORMAT,
      version: String(FORMAT_VERSION),
      posts: String(summary.posts),
      migrations: String(summary.migrations),
      createdat: document.createdAt
    }
  }));
}

async function verifyBackupObject(client, bucket, key, document, compressed, sha256, summary) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (Number(head.ContentLength) !== compressed.length ||
      String(head.Metadata?.sha256 || '').toLowerCase() !== sha256) {
    throw new Error('Uploaded backup metadata failed verification.');
  }
  const downloaded = await downloadBackup(client, bucket, key, sha256);
  if (downloaded.document.createdAt !== document.createdAt ||
      downloaded.summary.posts !== summary.posts ||
      downloaded.summary.migrations !== summary.migrations) {
    throw new Error('Downloaded backup contents differ from the source snapshot.');
  }
  return downloaded;
}

async function uploadPendingAndVerifyBackup({
  client,
  bucket,
  document,
  compressed,
  sha256,
  summary,
  prefix
}) {
  const key = pendingObjectKey(document, sha256, prefix);
  try {
    await putBackupObject(client, bucket, key, document, compressed, sha256, summary);
    const downloaded = await verifyBackupObject(
      client, bucket, key, document, compressed, sha256, summary
    );
    return { ...downloaded, finalKey: backupObjectKey(document, sha256, prefix) };
  } catch (error) {
    await deleteObjectQuietly(client, bucket, key);
    throw error;
  }
}

async function deleteObjectQuietly(client, bucket, key) {
  if (!key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {}
}

async function publishVerifiedBackup({ client, bucket, backup }) {
  const pendingKey = backup.key;
  const finalKey = backup.finalKey;
  try {
    await client.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: finalKey,
      CopySource: copySource(bucket, pendingKey)
    }));
    const published = await verifyBackupObject(
      client,
      bucket,
      finalKey,
      backup.document,
      backup.compressed,
      backup.sha256,
      backup.summary
    );
    await deleteObjectQuietly(client, bucket, pendingKey);
    return published;
  } catch (error) {
    await deleteObjectQuietly(client, bucket, finalKey);
    throw error;
  }
}

async function updateLatestManifest({ client, bucket, prefix, backup }) {
  const manifest = {
    format: BACKUP_FORMAT,
    version: FORMAT_VERSION,
    createdAt: backup.document.createdAt,
    key: backup.key,
    sha256: backup.sha256,
    compressedBytes: backup.compressed.length,
    posts: backup.summary.posts,
    migrations: backup.summary.migrations
  };
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: latestObjectKey(prefix),
    Body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    ContentType: 'application/json'
  }));
  return manifest;
}

async function loadLatestBackup(client, bucket, prefix) {
  const latest = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: latestObjectKey(prefix)
  }));
  const manifest = JSON.parse((await bodyToBuffer(latest.Body)).toString('utf8'));
  const safePrefix = `${cleanPrefix(prefix)}/`;
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== FORMAT_VERSION ||
      typeof manifest.key !== 'string' || !manifest.key.startsWith(safePrefix) ||
      !SHA256_RE.test(manifest.sha256 || '')) {
    throw new Error('Latest backup manifest is invalid.');
  }
  return downloadBackup(client, bucket, manifest.key, manifest.sha256);
}

function retentionDays(env = process.env) {
  const parsed = Number.parseInt(env.BACKUP_RETENTION_DAYS, 10);
  if (!Number.isInteger(parsed)) return 35;
  return Math.min(365, Math.max(7, parsed));
}

function isArchiveKey(key, prefix) {
  const safePrefix = `${cleanPrefix(prefix)}/`;
  return typeof key === 'string' && key.startsWith(safePrefix) &&
    !key.slice(safePrefix.length).includes('/') && key.endsWith('.json.gz');
}

async function deleteExpiredBackups({
  client,
  bucket,
  prefix,
  keepKey,
  now = new Date(),
  days = 35,
  minimumArchives = 7
}) {
  const safePrefix = `${cleanPrefix(prefix)}/`;
  const cutoff = now.getTime() - (days * 24 * 60 * 60 * 1000);
  let continuationToken;
  const archives = [];
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: safePrefix,
      ContinuationToken: continuationToken
    }));
    for (const object of page.Contents || []) {
      if (isArchiveKey(object.Key, prefix)) archives.push(object);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  archives.sort((left, right) => {
    const leftTime = left.LastModified instanceof Date ? left.LastModified.getTime() : Date.parse(left.LastModified);
    const rightTime = right.LastModified instanceof Date ? right.LastModified.getTime() : Date.parse(right.LastModified);
    return rightTime - leftTime;
  });
  const protectedKeys = new Set(archives.slice(0, Math.max(1, minimumArchives)).map(item => item.Key));
  protectedKeys.add(keepKey);
  let deleted = 0;
  for (const object of archives) {
    const modifiedAt = object.LastModified instanceof Date
      ? object.LastModified.getTime()
      : Date.parse(object.LastModified);
    if (protectedKeys.has(object.Key) || !Number.isFinite(modifiedAt) || modifiedAt >= cutoff) continue;
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
    deleted += 1;
  }
  return deleted;
}

module.exports = {
  bodyToBuffer,
  checksum,
  createStorage,
  deleteExpiredBackups,
  deleteObjectQuietly,
  downloadBackup,
  isArchiveKey,
  latestObjectKey,
  loadLatestBackup,
  pendingObjectKey,
  publishVerifiedBackup,
  retentionDays,
  storageConfig,
  updateLatestManifest,
  uploadPendingAndVerifyBackup
};
