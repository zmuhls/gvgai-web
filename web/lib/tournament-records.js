const fs = require('fs');
const path = require('path');
const { getAllModels } = require('./models');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const TOURNAMENT_FILE = /^(?:model-)?tournament-.*\.json$/;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modelName(modelId, suppliedName = null) {
  if (suppliedName) return suppliedName;
  return getAllModels().find(model => model.id === modelId)?.name || modelId;
}

function tournamentFiles(dataDir = DEFAULT_DATA_DIR) {
  const directories = [dataDir, path.join(dataDir, 'tournaments')];
  const files = [];
  for (const directory of directories) {
    try {
      for (const fileName of fs.readdirSync(directory)) {
        if (TOURNAMENT_FILE.test(fileName)) files.push(path.join(directory, fileName));
      }
    } catch {
      // A fresh installation may not have a tournament history directory yet.
    }
  }
  return files;
}

function readRecord(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const generatedAtMs = Date.parse(data.generatedAt);
    if (!Number.isFinite(generatedAtMs)) return null;
    return { filePath, data, generatedAtMs };
  } catch {
    return null;
  }
}

function stagedStandings(data = {}) {
  if (Array.isArray(data.standings) && data.standings.length > 0) {
    return data.standings.map(row => ({ ...row, stage: row.stage || 'tournament' }));
  }

  const ordered = [];
  const seen = new Set();
  const append = (rows, stage) => {
    if (!Array.isArray(rows)) return;
    rows.slice().sort((a, b) => finiteNumber(a.rank, 999) - finiteNumber(b.rank, 999)).forEach(row => {
      if (!row?.modelId || seen.has(row.modelId)) return;
      seen.add(row.modelId);
      ordered.push({ ...row, stage });
    });
  };
  append(data.finalStandings, 'final');
  append(data.semifinalStandings, 'semifinal');
  append(data.qualifierStandings, 'qualifier');
  return ordered;
}

function participantIds(data, standings) {
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const ids = participants.map(player => (
    typeof player === 'string' ? player : player?.modelId || player?.id
  )).filter(Boolean);
  if (ids.length > 0) return [...new Set(ids)];
  return [...new Set(standings.map(row => row.modelId).filter(Boolean))];
}

function recordedMatches(data = {}) {
  const direct = finiteNumber(data.summary?.matchesPlayed ?? data.matchesPlayed, -1);
  if (direct >= 0) return direct;
  const stages = data.methodology?.stages;
  if (!Array.isArray(stages)) return 0;
  return stages.reduce((total, stage) => {
    const models = finiteNumber(stage.models, 0);
    const games = finiteNumber(stage.games, 0);
    return total + models * games;
  }, 0);
}

function normalizeStanding(row, index) {
  return {
    rank: index + 1,
    modelId: row.modelId,
    modelName: modelName(row.modelId, row.modelName),
    stage: row.stage || 'tournament',
    wins: finiteNumber(row.wins, 0),
    qualifiedGames: finiteNumber(row.qualifiedGames, 0),
    runs: finiteNumber(row.runs ?? row.gamesPlayed, 0),
    totalScore: finiteNumber(row.totalScore ?? row.score, 0),
    placementPoints: finiteNumber(row.placementPoints, 0),
    providerErrors: finiteNumber(row.providerErrors, 0),
    meanLatencyMs: finiteNumber(row.meanLatencyMs, 0)
  };
}

function normalizeTournament(record) {
  const { data, filePath, generatedAtMs } = record;
  const rawStandings = stagedStandings(data);
  const standings = rawStandings.map(normalizeStanding);
  const participants = participantIds(data, standings);
  const rawGames = Array.isArray(data.games) ? data.games : (data.finalGames || []);
  const games = rawGames.map(game => ({
    gameId: Number.isInteger(Number(game.gameId)) ? Number(game.gameId) : null,
    gameName: game.gameName || (game.gameId != null ? `game ${game.gameId}` : 'unknown'),
    winner: game.winner || null,
    qualifiedModels: finiteNumber(game.qualifiedModels, 0),
    matchesPlayed: finiteNumber(game.matchesPlayed, 0)
  }));
  const championId = data.champion?.modelId || standings[0]?.modelId || null;
  const championStanding = standings.find(row => row.modelId === championId) || standings[0] || null;

  return {
    id: path.basename(filePath, '.json'),
    schemaVersion: finiteNumber(data.schemaVersion, 1),
    generatedAt: data.generatedAt,
    generatedAtMs,
    sourceFile: path.basename(filePath),
    status: data.status || 'completed',
    champion: championId ? {
      modelId: championId,
      modelName: modelName(championId, data.champion?.modelName || championStanding?.modelName),
      reason: data.champion?.reason || null
    } : null,
    participants,
    participantCount: participants.length || finiteNumber(data.roster?.viableCandidateCount, 0),
    availableModelCount: finiteNumber(data.roster?.availableModelCount, participants.length),
    matchesPlayed: recordedMatches(data),
    gameCount: games.length || finiteNumber(data.qualification?.targetGameCount, 0),
    standings,
    games,
    declaredNewPlayers: Array.isArray(data.newPlayers) ? data.newPlayers : [],
    methodology: data.methodology || null
  };
}

function publicTournament(record, previous = null) {
  const previousPlayers = new Set(previous?.participants || []);
  const inferredNew = record.participants.filter(modelId => !previousPlayers.has(modelId));
  const declared = record.declaredNewPlayers.map(player => (
    typeof player === 'string' ? player : player?.modelId || player?.id
  )).filter(Boolean);
  const newPlayerIds = [...new Set(declared.length > 0 ? declared : inferredNew)];

  return {
    id: record.id,
    schemaVersion: record.schemaVersion,
    generatedAt: record.generatedAt,
    sourceFile: record.sourceFile,
    status: record.status,
    champion: record.champion,
    participantCount: record.participantCount,
    availableModelCount: record.availableModelCount,
    matchesPlayed: record.matchesPlayed,
    gameCount: record.gameCount,
    participants: record.participants,
    newPlayers: newPlayerIds.map(modelId => ({ modelId, modelName: modelName(modelId) })),
    standings: record.standings,
    games: record.games,
    methodology: record.methodology
  };
}

function getTournamentLeaderboard(options = {}) {
  const records = tournamentFiles(options.dataDir || DEFAULT_DATA_DIR)
    .map(readRecord)
    .filter(Boolean)
    .map(normalizeTournament)
    .sort((a, b) => b.generatedAtMs - a.generatedAtMs);
  const history = records.map((record, index) => publicTournament(record, records[index + 1] || null));

  return {
    generatedAt: new Date().toISOString(),
    recordCount: history.length,
    latest: history[0] || null,
    history
  };
}

module.exports = {
  DEFAULT_DATA_DIR,
  getTournamentLeaderboard,
  normalizeTournament,
  publicTournament,
  readRecord,
  recordedMatches,
  stagedStandings,
  tournamentFiles
};
