const { getAllModels } = require('./models');

const DEFAULT_TAGS_URL = 'https://ollama.com/api/tags';
const DEFAULT_LOCAL_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
const DEFAULT_ROSTER_SIZE = 8;
const DEFAULT_CHALLENGER_COUNT = 4;

function normalizeRemoteModel(row) {
  const id = typeof row === 'string' ? row : row?.name || row?.model || row?.id;
  if (!id || /(?:embed|embedding|rerank)/i.test(id)) return null;
  return {
    id,
    name: row?.display_name || row?.displayName || id,
    provider: 'ollama-cloud',
    fallback: null,
    description: 'Discovered from the current Ollama Cloud roster',
    speed: 'unknown',
    cost: 'unknown',
    discovered: true
  };
}

function normalizeLocalModel(row) {
  const id = typeof row === 'string' ? row : row?.name || row?.model;
  if (!id || /(?:embed|embedding|rerank)/i.test(id)) return null;
  return {
    id,
    name: id,
    provider: 'ollama-local',
    fallback: null,
    description: 'Installed in the local Ollama runtime',
    speed: 'local',
    cost: 'local',
    discovered: true
  };
}

async function discoverOllamaLocalModels(options = {}) {
  const fetchFn = options.localFetchFn || fetch;
  const endpoint = options.localEndpoint || process.env.OLLAMA_LOCAL_TAGS_URL || DEFAULT_LOCAL_TAGS_URL;
  const timeoutMs = Number(options.timeoutMs) || 8000;

  try {
    const response = await fetchFn(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { models: [], status: `http-${response.status}` };
    const body = await response.json();
    const rows = Array.isArray(body?.models) ? body.models : (Array.isArray(body) ? body : []);
    return {
      models: rows.map(normalizeLocalModel).filter(Boolean),
      status: 'ready'
    };
  } catch (error) {
    return { models: [], status: error.name === 'TimeoutError' ? 'timeout' : 'unavailable' };
  }
}

async function discoverOllamaCloudModels(options = {}) {
  const apiKey = options.apiKey || process.env.OLLAMA_API_KEY;
  if (!apiKey) return { models: [], status: 'missing-key' };
  const fetchFn = options.fetchFn || fetch;
  const endpoint = options.endpoint || process.env.OLLAMA_CLOUD_TAGS_URL || DEFAULT_TAGS_URL;
  const timeoutMs = Number(options.timeoutMs) || 8000;

  try {
    const response = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { models: [], status: `http-${response.status}` };
    const body = await response.json();
    const rows = Array.isArray(body?.models) ? body.models : (Array.isArray(body) ? body : []);
    return {
      models: rows.map(normalizeRemoteModel).filter(Boolean),
      status: 'ready'
    };
  } catch (error) {
    return { models: [], status: error.name === 'TimeoutError' ? 'timeout' : 'unavailable' };
  }
}

async function availableTournamentModels(options = {}) {
  if (options.localOnly) {
    const local = await discoverOllamaLocalModels(options);
    return {
      models: local.models,
      discoveryStatus: local.status,
      discoveredCount: local.models.length,
      providerMode: 'ollama-local'
    };
  }

  const catalog = (options.catalog || getAllModels())
    .filter(model => model?.id && !model.dryRun)
    .map(model => ({ ...model, discovered: false }));
  const remote = await discoverOllamaCloudModels(options);
  const merged = new Map(catalog.map(model => [model.id, model]));
  for (const model of remote.models) {
    if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return {
    models: [...merged.values()],
    discoveryStatus: remote.status,
    discoveredCount: remote.models.filter(model => !catalog.some(entry => entry.id === model.id)).length,
    providerMode: 'cloud'
  };
}

function lastSeenIndex(modelId, history) {
  const index = history.findIndex(record => (record.participants || []).includes(modelId));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function selectTournamentRoster(availableModels, history = [], options = {}) {
  const rosterSize = Math.max(2, Number(options.rosterSize) || DEFAULT_ROSTER_SIZE);
  const challengerCount = Math.max(1, Math.min(
    rosterSize - 1,
    Number(options.challengerCount) || DEFAULT_CHALLENGER_COUNT
  ));
  const incumbentCount = rosterSize - challengerCount;
  const byId = new Map(availableModels.map(model => [model.id, model]));
  const latest = history[0] || null;
  const latestPlayers = new Set(latest?.participants || []);
  const incumbentIds = (latest?.standings || [])
    .map(row => row.modelId)
    .filter(modelId => byId.has(modelId))
    .slice(0, incumbentCount);
  const selected = incumbentIds.map(modelId => byId.get(modelId));
  const selectedIds = new Set(incumbentIds);

  const candidates = availableModels
    .filter(model => !selectedIds.has(model.id))
    .sort((a, b) => {
      const aNew = latestPlayers.has(a.id) ? 1 : 0;
      const bNew = latestPlayers.has(b.id) ? 1 : 0;
      if (aNew !== bNew) return aNew - bNew;
      if (Boolean(a.discovered) !== Boolean(b.discovered)) return a.discovered ? -1 : 1;
      const seenDifference = lastSeenIndex(b.id, history) - lastSeenIndex(a.id, history);
      return seenDifference || a.id.localeCompare(b.id);
    });

  for (const model of candidates) {
    if (selected.length >= rosterSize) break;
    selected.push(model);
    selectedIds.add(model.id);
  }

  // A first-ever tournament has no incumbents. Fill its remaining slots from
  // the catalog order after the challenger selection above.
  for (const model of availableModels) {
    if (selected.length >= rosterSize) break;
    if (selectedIds.has(model.id)) continue;
    selected.push(model);
    selectedIds.add(model.id);
  }

  return {
    models: selected,
    incumbentIds: selected.filter(model => latestPlayers.has(model.id)).map(model => model.id),
    newPlayerIds: selected.filter(model => !latestPlayers.has(model.id)).map(model => model.id),
    rosterSize: selected.length,
    requestedRosterSize: rosterSize,
    challengerCount
  };
}

module.exports = {
  DEFAULT_CHALLENGER_COUNT,
  DEFAULT_LOCAL_TAGS_URL,
  DEFAULT_ROSTER_SIZE,
  DEFAULT_TAGS_URL,
  availableTournamentModels,
  discoverOllamaCloudModels,
  discoverOllamaLocalModels,
  normalizeLocalModel,
  normalizeRemoteModel,
  selectTournamentRoster
};
