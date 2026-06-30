const fs = require('fs');
const path = require('path');

const { buildStrategicDigestFromFile } = require('./vgdl-digest');

const MEMORY_SCHEMA_VERSION = 1;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_MEMORY_DIR = path.join(DATA_DIR, 'strategy-memory');
const INDEX_FILE = '_index.json';
const CACHE_TTL_MS = 60000;

const _cache = {
  index: new Map(),
  records: new Map()
};

function clearMemoryCache() {
  _cache.index.clear();
  _cache.records.clear();
}

function memoryDir(options = {}) {
  return options.memoryDir || process.env.STRATEGY_MEMORY_DIR || DEFAULT_MEMORY_DIR;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function fileNameForMemoryKey(memoryKey) {
  return `${String(memoryKey).replace(/[^a-zA-Z0-9.-]+/g, '-')}.json`;
}

function indexPath(options = {}) {
  return path.join(memoryDir(options), INDEX_FILE);
}

function defaultIndex() {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAt: null,
    games: {},
    memoryKeys: {}
  };
}

function readIndex(options = {}) {
  const dir = memoryDir(options);
  const cached = _cache.index.get(dir);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) return cached.data;
  const raw = readJson(indexPath(options), defaultIndex());
  const data = {
    ...defaultIndex(),
    ...raw,
    games: raw?.games || {},
    memoryKeys: raw?.memoryKeys || {}
  };
  _cache.index.set(dir, { data, loadedAt: Date.now() });
  return data;
}

function writeIndex(index, options = {}) {
  const data = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    games: index.games || {},
    memoryKeys: index.memoryKeys || {}
  };
  writeJson(indexPath(options), data);
  _cache.index.set(memoryDir(options), { data, loadedAt: Date.now() });
}

function memoryPath(memoryKey, options = {}) {
  return path.join(memoryDir(options), fileNameForMemoryKey(memoryKey));
}

function getMemoryRecord(memoryKey, options = {}) {
  if (!memoryKey) return null;
  const cacheKey = `${memoryDir(options)}:${memoryKey}`;
  const cached = _cache.records.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) return cached.data;
  const data = readJson(memoryPath(memoryKey, options), null);
  if (data) _cache.records.set(cacheKey, { data, loadedAt: Date.now() });
  return data;
}

function summarizeIndexEntry(record) {
  return {
    memoryKey: record.memoryKey,
    gameId: record.gameId,
    gameName: record.gameName,
    rulesHash: record.rulesHash,
    digestHash: record.digestHash,
    evaluationStatus: record.evaluationStatus || 'candidate',
    updatedAt: record.updatedAt || null
  };
}

function saveMemoryRecord(record, options = {}) {
  const now = new Date().toISOString();
  const nextRecord = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...record,
    evaluationStatus: record.evaluationStatus || 'candidate',
    createdAt: record.createdAt || now,
    updatedAt: now
  };
  if (!nextRecord.memoryKey) nextRecord.memoryKey = nextRecord.digestHash;
  if (!nextRecord.promptText && nextRecord.digest?.promptText) nextRecord.promptText = nextRecord.digest.promptText;

  writeJson(memoryPath(nextRecord.memoryKey, options), nextRecord);
  _cache.records.set(`${memoryDir(options)}:${nextRecord.memoryKey}`, { data: nextRecord, loadedAt: Date.now() });

  const index = readIndex(options);
  const entry = summarizeIndexEntry(nextRecord);
  index.memoryKeys[nextRecord.memoryKey] = entry;
  if (nextRecord.gameId !== null && nextRecord.gameId !== undefined) {
    index.games[String(nextRecord.gameId)] = entry;
  }
  writeIndex(index, options);
  return nextRecord;
}

function createMemoryRecordFromDigest(digest, meta = {}) {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    memoryKey: digest.digestHash,
    gameId: meta.gameId ?? digest.gameId ?? null,
    gameName: meta.gameName || digest.gameName,
    vgdlPath: meta.vgdlPath || null,
    rulesHash: digest.rulesHash,
    digestHash: digest.digestHash,
    digest,
    promptText: digest.promptText,
    evaluationStatus: meta.evaluationStatus || 'candidate'
  };
}

function createMemoryRecordFromFile(game, options = {}) {
  const digest = buildStrategicDigestFromFile(game.vgdlPath, {
    gameId: game.id,
    gameName: game.name
  });
  return createMemoryRecordFromDigest(digest, {
    gameId: game.id,
    gameName: game.name,
    vgdlPath: game.relativePath || game.file || game.vgdlPath,
    evaluationStatus: options.evaluationStatus || 'candidate'
  });
}

function upsertMemoryForGame(game, options = {}) {
  const record = createMemoryRecordFromFile(game, options);
  if (options.dryRun) return record;
  return saveMemoryRecord(record, options);
}

function resolveGameMemory(gameId, strategicDigestConfig = null, options = {}) {
  const explicitMode = options.strategyMemory || options.mode || null;
  const allowCandidate = Boolean(options.allowCandidate || explicitMode === 'candidate');
  const disabled = explicitMode === 'baseline' || explicitMode === 'disabled';
  const config = strategicDigestConfig || {};

  if (disabled) return null;
  if (config.enabled === false && !allowCandidate) return null;

  const index = readIndex(options);
  const configuredKey = config.memoryKey || options.memoryKey || null;
  const indexEntry = configuredKey
    ? index.memoryKeys[configuredKey]
    : index.games[String(gameId)];
  const memoryKey = configuredKey || indexEntry?.memoryKey;
  if (!memoryKey) return null;

  const record = getMemoryRecord(memoryKey, options);
  if (!record) return null;

  const status = config.evaluationStatus || record.evaluationStatus || indexEntry?.evaluationStatus || 'candidate';
  if (!allowCandidate && status !== 'accepted') return null;

  return {
    ...record,
    evaluationStatus: status,
    resolvedFrom: configuredKey ? 'config' : 'index'
  };
}

function listMemoryRecords(options = {}) {
  const index = readIndex(options);
  const records = [];
  for (const memoryKey of Object.keys(index.memoryKeys)) {
    const record = getMemoryRecord(memoryKey, options);
    if (record) records.push(record);
  }
  if (options.status) {
    return records.filter(record => record.evaluationStatus === options.status);
  }
  return records;
}

function updateMemoryEvaluation(memoryKey, gateSummary, options = {}) {
  const record = getMemoryRecord(memoryKey, options);
  if (!record) return null;
  const nextRecord = {
    ...record,
    evaluationStatus: gateSummary.accepted ? 'accepted' : 'rejected',
    lastEvaluatedAt: new Date().toISOString(),
    latestGate: gateSummary
  };
  return saveMemoryRecord(nextRecord, options);
}

module.exports = {
  MEMORY_SCHEMA_VERSION,
  DEFAULT_MEMORY_DIR,
  INDEX_FILE,
  memoryDir,
  indexPath,
  memoryPath,
  readIndex,
  writeIndex,
  getMemoryRecord,
  saveMemoryRecord,
  createMemoryRecordFromDigest,
  createMemoryRecordFromFile,
  upsertMemoryForGame,
  resolveGameMemory,
  updateMemoryEvaluation,
  listMemoryRecords,
  clearMemoryCache,
  fileNameForMemoryKey
};
