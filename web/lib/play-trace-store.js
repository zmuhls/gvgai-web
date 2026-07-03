'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TRACE_DIR = path.join(__dirname, '..', 'data', 'play-traces');
const INDEX_FILE = '_index.json';
const CACHE_TTL_MS = 60000;

let TRACE_DIR = process.env.GVGAI_TRACE_DIR
  ? path.resolve(process.env.GVGAI_TRACE_DIR)
  : DEFAULT_TRACE_DIR;

function refreshTraceDir() {
  TRACE_DIR = process.env.GVGAI_TRACE_DIR
    ? path.resolve(process.env.GVGAI_TRACE_DIR)
    : DEFAULT_TRACE_DIR;
}

let _indexCache = null; // { data, loadedAt }
let _cachedDir = null;

function clearCache() {
  _indexCache = null;
  _cachedDir = null;
}

function traceDir() {
  refreshTraceDir();
  return TRACE_DIR;
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

function indexPath() {
  return path.join(traceDir(), INDEX_FILE);
}

function defaultIndex() {
  return {
    traces: {},
    updatedAt: null
  };
}

function readIndex() {
  const dir = traceDir();
  if (_indexCache && _cachedDir === dir && (Date.now() - _indexCache.loadedAt) < CACHE_TTL_MS) {
    return _indexCache.data;
  }
  const raw = readJson(indexPath(), defaultIndex());
  const data = {
    ...defaultIndex(),
    ...raw,
    traces: raw?.traces || {}
  };
  _indexCache = { data, loadedAt: Date.now() };
  _cachedDir = dir;
  return data;
}

function writeIndex(index) {
  const data = {
    traces: index.traces || {},
    updatedAt: new Date().toISOString()
  };
  writeJson(indexPath(), data);
  _indexCache = { data, loadedAt: Date.now() };
  _cachedDir = traceDir();
}

function generateTraceId() {
  const ts = Date.now();
  const random6 = Array.from({ length: 6 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]
  ).join('');
  return `trace-${ts}-${random6}`;
}

function traceFilePath(gameId, traceId) {
  return path.join(traceDir(), String(gameId), `${traceId}.json`);
}

function summarizeTrace(trace) {
  return {
    traceId: trace.traceId,
    gameId: trace.gameId,
    gameName: trace.gameName ?? null,
    levelId: trace.levelId,
    playerType: trace.playerType,
    modelId: trace.modelId ?? null,
    finalScore: trace.finalScore,
    won: trace.won,
    ticks: trace.ticks,
    actionCount: trace.actionCount,
    createdAt: trace.createdAt
  };
}

function saveTrace(trace) {
  const now = new Date().toISOString();
  const traceId = generateTraceId();
  const record = {
    traceId,
    gameId: trace.gameId,
    gameName: trace.gameName ?? null,
    levelId: trace.levelId,
    playerType: trace.playerType,
    modelId: trace.modelId ?? null,
    strategy: trace.strategy ?? null,
    finalScore: trace.finalScore,
    winner: trace.winner ?? null,
    won: trace.won ?? false,
    ticks: trace.ticks,
    actionCount: trace.actionCount,
    actionHistory: trace.actionHistory || [],
    scoreEvents: trace.scoreEvents || [],
    createdAt: now
  };

  // Write trace file
  writeJson(traceFilePath(record.gameId, record.traceId), record);

  // Update index
  const index = readIndex();
  const key = String(record.gameId);
  if (!index.traces[key]) index.traces[key] = [];
  index.traces[key].push(summarizeTrace(record));
  writeIndex(index);

  return record;
}

function getTracesForGame(gameId, options = {}) {
  const index = readIndex();
  const key = String(gameId);
  let entries = index.traces[key] || [];
  if (options.playerType) {
    entries = entries.filter(e => e.playerType === options.playerType);
  }
  return [...entries].sort((a, b) => b.finalScore - a.finalScore);
}

function getTrace(gameId, traceId) {
  const filePath = traceFilePath(gameId, traceId);
  return readJson(filePath, null);
}

function getBestHumanTraces(gameId, n = 10) {
  const traces = getTracesForGame(gameId, { playerType: 'human' });
  return traces.slice(0, n);
}

function getBestTraces(gameId, n = 10) {
  const traces = getTracesForGame(gameId);
  return traces.slice(0, n);
}

function getTraceStats(gameId) {
  const traces = getTracesForGame(gameId);
  if (traces.length === 0) return null;
  const scores = traces.map(t => t.finalScore);
  const wins = traces.filter(t => t.won).length;
  const humanCount = traces.filter(t => t.playerType === 'human').length;
  const llmCount = traces.filter(t => t.playerType === 'llm').length;
  return {
    traceCount: traces.length,
    bestScore: Math.max(...scores),
    averageScore: scores.reduce((a, b) => a + b, 0) / scores.length,
    winRate: wins / traces.length,
    humanTraceCount: humanCount,
    llmTraceCount: llmCount
  };
}

module.exports = {
  saveTrace,
  getTracesForGame,
  getTrace,
  getBestHumanTraces,
  getBestTraces,
  getTraceStats,
  clearCache,
  TRACE_DIR
};