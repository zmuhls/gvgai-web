const express = require('express');
const { getConfig } = require('../lib/runtime-config');
const { resolveModel } = require('../lib/models');
const { CadavreWallStore } = require('../lib/cadavre-wall-store');
const telemetry = require('../lib/telemetry-store');
const usageGuardrail = require('../lib/usage-guardrail');

const router = express.Router();
const wallStore = new CadavreWallStore();

const MAX_MESSAGES = 14;
const MAX_CONTENT_CHARS = 9000;
const MAX_TOTAL_CONTENT_CHARS = 24000;
const MAX_MODEL_ID_CHARS = 120;
const DEFAULT_ADAPTER_MODEL = 'exquisite-corpse';
const DEFAULT_OLLAMA_MODEL = 'gemma3:4b';
const DEFAULT_ROUTE_MODEL = `legion:${DEFAULT_ADAPTER_MODEL}`;
const DEFAULT_STANDBY_MODELS = Object.freeze([
  'ollama:gemma3:4b',
  'ollama:gemini-3-flash-preview',
  'ollama:gpt-oss:20b'
]);
const CADAVRE_OPENROUTER_MODEL_IDS = new Map([
  ['deepseek-v3.2', 'deepseek/deepseek-v3.2'],
  ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
  ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
  ['gemma3:4b', 'google/gemma-3-4b-it'],
  ['gemma4:31b', 'google/gemma-4-31b-it'],
  ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
  ['kimi-k2.6', 'moonshotai/kimi-k2.6'],
  ['minimax-m2.7', 'minimax/minimax-m2.7'],
  ['minimax-m3', 'minimax/minimax-m3'],
  ['qwen3-coder-next', 'qwen/qwen3-coder-next'],
  ['qwen3.5:397b', 'qwen/qwen3.5-397b-a17b'],
  ['gpt-oss:20b', 'openai/gpt-oss-20b'],
  ['gpt-oss:120b', 'openai/gpt-oss-120b'],
  ['ministral-3:14b', 'mistralai/ministral-14b-2512'],
  ['nemotron-3-nano:30b', 'nvidia/nemotron-3-nano-30b-a3b'],
  ['nemotron-3-super', 'nvidia/nemotron-3-super-120b-a12b']
]);
const CADAVRE_CLOUD_MODEL_IDS = new Set(CADAVRE_OPENROUTER_MODEL_IDS.keys());
const FETCH_TIMEOUT_MS = 60000;
const CHAT_DEADLINE_MS = 50000;
const OPENROUTER_ATTEMPT_TIMEOUT_MS = 30000;
const OLLAMA_ATTEMPT_TIMEOUT_MS = 20000;
const OLLAMA_MAX_ATTEMPTS = 2;
const OLLAMA_RETRY_DELAY_MS = 250;
const MODEL_PROBE_TIMEOUT_MS = 5000;
const MODEL_CATALOG_TTL_MS = 30000;
const MODEL_READY_TTL_MS = 4 * 60 * 1000;
const MODEL_READY_DEADLINE_MS = 30000;
const MODEL_WARM_INTERVAL_MS = 3 * 60 * 1000;
const CHAT_RATE_LIMIT = 30;
const CHAT_RATE_WINDOW_MS = 60000;
const WALL_VOTE_RATE_LIMIT = 120;
const USAGE_STARTED_AT = new Date().toISOString();

const chatRateBuckets = new Map();
const wallVoteRateBuckets = new Map();
let catalogCache = null;
let catalogRefresh = null;
const modelReadyCache = new Map();
const modelReadyChecks = new Map();
let modelWarmTimer = null;
let mirrorCacheStatusProvider = null;
const catalogCacheStats = {
  requests: 0,
  hits: 0,
  misses: 0,
  refreshes: 0,
  refreshFailures: 0,
  coalescedRequests: 0,
  staleServed: 0
};
const chatUsageStats = {
  requests: 0,
  completed: 0,
  failed: 0,
  inFlight: 0,
  peakInFlight: 0,
  providerCalls: 0,
  retries: 0,
  fallbacks: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalLatencyMs: 0,
  latencies: []
};

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteMetric(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function compactMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== null && value !== undefined));
}

function percentile(values, requested) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((requested / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function cleanMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    const err = new Error('messages must be an array');
    err.status = 400;
    throw err;
  }

  const messages = rawMessages.slice(-MAX_MESSAGES).map((message) => {
    const role = ['system', 'user', 'assistant'].includes(message?.role)
      ? message.role
      : 'user';
    const content = String(message?.content || '').slice(0, MAX_CONTENT_CHARS);
    return { role, content };
  }).filter((message) => message.content.trim());
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    const error = new Error(`messages exceed the ${MAX_TOTAL_CONTENT_CHARS}-character request limit`);
    error.status = 413;
    throw error;
  }
  return messages;
}

function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url || '');
}

function isSafeModelName(model) {
  return typeof model === 'string' &&
    model.length > 0 &&
    model.length <= MAX_MODEL_ID_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(model);
}

function configuredAdapterModel() {
  const model = process.env.CADAVRE_MODEL || DEFAULT_ADAPTER_MODEL;
  return isSafeModelName(model) ? model : DEFAULT_ADAPTER_MODEL;
}

function resolveRouteModel(routeModel) {
  const requested = routeModel === 'cadavre-server' || !routeModel
    ? `legion:${configuredAdapterModel()}`
    : routeModel;
  if (typeof requested !== 'string' || requested.length > MAX_MODEL_ID_CHARS + 8) {
    const error = new Error('model must be a route-aware model id');
    error.status = 400;
    throw error;
  }

  const separator = requested.indexOf(':');
  const route = requested.slice(0, separator);
  const model = requested.slice(separator + 1);
  if (!['legion', 'ollama'].includes(route) || !isSafeModelName(model)) {
    const error = new Error('model must use legion:<model> or ollama:<model>');
    error.status = 400;
    throw error;
  }

  const config = getConfig();
  if (route === 'legion') {
    const apiUrl = process.env.CADAVRE_ENDPOINT || process.env.LEGION_VLLM_URL || config.legion?.apiUrl;
    if (!apiUrl) {
      const error = new Error('Legion is not configured');
      error.status = 503;
      throw error;
    }
    return {
      id: `legion:${model}`,
      provider: 'legion-vllm',
      apiUrl,
      model,
      apiKey: process.env.CADAVRE_API_KEY || process.env.LEGION_API_KEY || ''
    };
  }

  const apiUrl = config.ollamaCloud?.apiUrl;
  const apiKey = process.env.OLLAMA_CLOUD_API_KEY || process.env.OLLAMA_API_KEY || '';
  if (apiUrl && (apiKey || isLocalUrl(apiUrl))) {
    return {
      id: `ollama:${model}`,
      provider: 'ollama-cloud',
      apiUrl,
      model,
      apiKey
    };
  }

  const openRouterModel = CADAVRE_OPENROUTER_MODEL_IDS.get(model);
  const openRouterUrl = config.openrouter?.apiUrl;
  const openRouterKey = process.env.OPENROUTER_API_KEY || '';
  if (openRouterModel && openRouterUrl && (openRouterKey || isLocalUrl(openRouterUrl))) {
    return {
      id: `ollama:${model}`,
      provider: 'openrouter',
      apiUrl: openRouterUrl,
      model: openRouterModel,
      apiKey: openRouterKey
    };
  }

  const error = new Error('Neither Ollama Cloud nor OpenRouter is configured for this model');
  error.status = 503;
  throw error;
}

function providerCandidates(requestedModel) {
  try {
    return [resolveRouteModel(requestedModel)];
  } catch {
    return [];
  }
}

function openRouterFallbackCandidate(candidate) {
  if (candidate?.provider !== 'ollama-cloud') return null;
  const config = getConfig();
  const model = CADAVRE_OPENROUTER_MODEL_IDS.get(candidate.model) ||
    resolveModel(candidate.model).fallback || process.env.CADAVRE_FALLBACK_MODEL;
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!model || !config.openrouter?.apiUrl || !apiKey) return null;
  return {
    id: candidate.id,
    provider: 'openrouter',
    apiUrl: config.openrouter.apiUrl,
    model,
    apiKey
  };
}

function configuredStandbyModelIds() {
  const configured = String(process.env.CADAVRE_STANDBY_MODELS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => /^(?:legion|ollama):/.test(value) ? value : `ollama:${value}`);
  const source = configured.length ? configured : DEFAULT_STANDBY_MODELS;
  const seen = new Set();
  return source.filter((id) => {
    if (seen.has(id)) return false;
    try {
      const candidate = resolveRouteModel(id);
      seen.add(candidate.id);
      return true;
    } catch {
      return false;
    }
  });
}

function endpointUrl(apiUrl, pathname) {
  const url = new URL(apiUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function modelsUrl(apiUrl) {
  return endpointUrl(apiUrl, '/v1/models');
}

function openRouterModelsUrl(apiUrl) {
  return endpointUrl(apiUrl, '/api/v1/models');
}

function ollamaChatUrl(apiUrl) {
  return endpointUrl(apiUrl, '/api/chat');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeProviderModels(apiUrl, apiKey = '', modelListUrl = '') {
  if (!apiUrl) return { available: false, models: [] };
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchWithTimeout(
      modelListUrl || modelsUrl(apiUrl),
      { headers },
      MODEL_PROBE_TIMEOUT_MS
    );
    if (!response.ok) return { available: false, models: [] };
    const data = await response.json();
    const rawModels = Array.isArray(data?.data) ? data.data : [];
    const seen = new Set();
    const models = [];
    for (const entry of rawModels) {
      const id = typeof entry === 'string' ? entry : entry?.id || entry?.model;
      if (!isSafeModelName(id) || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: String(entry?.name || id).slice(0, 160) });
    }
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

async function buildModelCatalog() {
  const config = getConfig();
  const adapterModel = configuredAdapterModel();
  const legionUrl = process.env.CADAVRE_ENDPOINT || process.env.LEGION_VLLM_URL || config.legion?.apiUrl;
  const legionKey = process.env.CADAVRE_API_KEY || process.env.LEGION_API_KEY || '';
  const ollamaUrl = config.ollamaCloud?.apiUrl;
  const ollamaKey = process.env.OLLAMA_CLOUD_API_KEY || process.env.OLLAMA_API_KEY || '';
  const openRouterUrl = config.openrouter?.apiUrl;
  const openRouterKey = process.env.OPENROUTER_API_KEY || '';

  const [legion, ollama, openRouter] = await Promise.all([
    probeProviderModels(legionUrl, legionKey),
    (!ollamaKey && !isLocalUrl(ollamaUrl))
      ? Promise.resolve({ available: false, models: [] })
      : probeProviderModels(ollamaUrl, ollamaKey),
    (!openRouterKey && !isLocalUrl(openRouterUrl))
      ? Promise.resolve({ available: false, models: [] })
      : probeProviderModels(openRouterUrl, openRouterKey, openRouterModelsUrl(openRouterUrl))
  ]);
  const adapterAvailable = legion.available && legion.models.some(({ id }) => id === adapterModel);
  const models = [{
    id: `legion:${adapterModel}`,
    model: adapterModel,
    label: 'Exquisite Corpse (fine-tuned on Legion)',
    provider: 'legion',
    available: adapterAvailable
  }];

  const ollamaModels = new Map(ollama.models.map((model) => [model.id, model]));
  const openRouterModels = new Set(openRouter.models.map(({ id }) => id));
  const cloudModels = [...CADAVRE_OPENROUTER_MODEL_IDS]
    .filter(([ollamaId, openRouterId]) => openRouterModels.has(openRouterId) || ollamaModels.has(ollamaId))
    .map(([ollamaId, openRouterId]) => ({
      id: ollamaId,
      label: ollamaModels.get(ollamaId)?.label || ollamaId,
      openRouterAvailable: openRouterModels.has(openRouterId)
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const model of cloudModels) {
    models.push({
      id: `ollama:${model.id}`,
      model: model.id,
      label: model.openRouterAvailable
        ? `${model.label} (OpenRouter; Ollama fallback)`
        : `${model.label} (Ollama Cloud)`,
      provider: model.openRouterAvailable ? 'openrouter' : 'ollama',
      available: true
    });
  }

  const preferredCloud = process.env.CADAVRE_OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const defaultModel = models.find((model) => model.provider === 'legion' && model.available)?.id ||
    models.find((model) => model.id === `ollama:${preferredCloud}` && model.available)?.id ||
    models.find((model) => model.available)?.id ||
    DEFAULT_ROUTE_MODEL;
  return {
    default: defaultModel,
    defaultModel,
    models,
    providers: {
      legion: { available: legion.available, modelAvailable: adapterAvailable },
      openrouter: { available: openRouter.available, modelCount: openRouter.models.length },
      ollama: { available: ollama.available, modelCount: ollama.models.length }
    }
  };
}

function getCatalogCacheStatus(now = Date.now()) {
  const reused = catalogCacheStats.hits + catalogCacheStats.coalescedRequests + catalogCacheStats.staleServed;
  return {
    requests: catalogCacheStats.requests,
    hits: catalogCacheStats.hits,
    misses: catalogCacheStats.misses,
    refreshes: catalogCacheStats.refreshes,
    refreshFailures: catalogCacheStats.refreshFailures,
    coalescedRequests: catalogCacheStats.coalescedRequests,
    staleServed: catalogCacheStats.staleServed,
    upstreamRequestsAvoided: reused,
    hitRatio: catalogCacheStats.requests ? catalogCacheStats.hits / catalogCacheStats.requests : 0,
    reuseRatio: catalogCacheStats.requests ? reused / catalogCacheStats.requests : 0,
    ageMs: catalogCache ? Math.max(0, now - catalogCache.createdAt) : null,
    ttlMs: MODEL_CATALOG_TTL_MS,
    refreshing: Boolean(catalogRefresh),
    entries: catalogCache ? 1 : 0
  };
}

function trackCatalogRefresh(outcome, latencyMs) {
  const status = getCatalogCacheStatus();
  try {
    telemetry.track({
      eventFamily: 'system',
      eventType: 'cadavre_cache_snapshot',
      source: 'cadavre-route',
      latencyMs,
      payload: { cache: 'model_catalog', outcome },
      metrics: compactMetrics({
        requests: status.requests,
        hits: status.hits,
        misses: status.misses,
        refreshes: status.refreshes,
        refresh_failures: status.refreshFailures,
        coalesced_requests: status.coalescedRequests,
        stale_served: status.staleServed,
        upstream_requests_avoided: status.upstreamRequestsAvoided,
        hit_ratio: status.hitRatio,
        reuse_ratio: status.reuseRatio,
        age_ms: status.ageMs,
        ttl_ms: status.ttlMs,
        entries: status.entries
      })
    });
  } catch {
    // Usage logging stays best-effort so the model catalog proceeds.
  }
}

async function getModelCatalog(now = Date.now()) {
  catalogCacheStats.requests += 1;
  if (catalogCache && now - catalogCache.createdAt < MODEL_CATALOG_TTL_MS) {
    catalogCacheStats.hits += 1;
    return catalogCache.value;
  }
  if (catalogRefresh) {
    catalogCacheStats.coalescedRequests += 1;
    return catalogRefresh;
  }

  catalogCacheStats.misses += 1;
  catalogCacheStats.refreshes += 1;
  const stale = catalogCache;
  const startedAt = Date.now();
  catalogRefresh = (async () => {
    try {
      const value = await buildModelCatalog();
      catalogCache = { createdAt: now, value };
      trackCatalogRefresh('refreshed', Date.now() - startedAt);
      return value;
    } catch (error) {
      catalogCacheStats.refreshFailures += 1;
      if (stale) {
        catalogCacheStats.staleServed += 1;
        trackCatalogRefresh('stale', Date.now() - startedAt);
        return stale.value;
      }
      trackCatalogRefresh('failed', Date.now() - startedAt);
      throw error;
    } finally {
      catalogRefresh = null;
    }
  })();
  return catalogRefresh;
}

async function resolveListedRouteModel(routeModel) {
  const candidate = resolveRouteModel(routeModel);
  const catalog = await getModelCatalog();
  const listed = catalog.models.find((model) => model.id === candidate.id);
  if (!listed) {
    const error = new Error('The requested model is not in the current Cadavre catalog');
    error.status = 400;
    throw error;
  }
  if (!listed.available) {
    const error = new Error('The requested model is currently unavailable');
    error.status = 503;
    throw error;
  }
  return candidate;
}

function getModelReadyStatus(requestedModel, now = Date.now()) {
  const cached = modelReadyCache.get(requestedModel);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    modelReadyCache.delete(requestedModel);
    return null;
  }
  return { ...cached, cached: true };
}

function rememberModelReady(requestedModel, result, now = Date.now()) {
  const status = {
    requestedModel,
    model: result.model,
    provider: result.provider,
    failover: result.model !== requestedModel,
    checkedAt: new Date(now).toISOString(),
    expiresAt: now + MODEL_READY_TTL_MS
  };
  modelReadyCache.set(requestedModel, status);
  modelReadyCache.set(result.model, {
    ...status,
    requestedModel: result.model,
    failover: false
  });
  return { ...status, cached: false };
}

async function resolveListedRoutePool(routeModel) {
  const requested = resolveRouteModel(routeModel);
  const catalog = await getModelCatalog();
  const listed = catalog.models.find((model) => model.id === requested.id);
  if (!listed) {
    const error = new Error('The requested model is not in the current Cadavre catalog');
    error.status = 400;
    throw error;
  }

  const cached = getModelReadyStatus(requested.id);
  const ids = [
    cached?.model,
    requested.id,
    ...configuredStandbyModelIds(),
    catalog.default,
    catalog.defaultModel
  ].filter(Boolean);
  const seen = new Set();
  const candidates = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = catalog.models.find((model) => model.id === id && model.available !== false);
    if (!entry) continue;
    try {
      candidates.push(resolveRouteModel(id));
    } catch {
      // A catalog entry can outlive a removed credential until its short TTL ends.
    }
  }
  if (!candidates.length) {
    const error = new Error('No ready Cadavre model route is configured');
    error.status = 503;
    throw error;
  }
  return { requested, candidates, catalog };
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.hostname === 'localhost') return true;
    return url.origin === 'https://inference-arcade.com' ||
      url.origin === 'https://milwrite.github.io';
  } catch {
    return false;
  }
}

function cadavreCors(req, res, next) {
  const origin = req.get('Origin');
  if (!isAllowedOrigin(origin)) {
    res.status(403).json({ error: 'Origin is not allowed.' });
    return;
  }
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function configuredRateLimit() {
  const parsed = Number.parseInt(process.env.CADAVRE_CHAT_RATE_LIMIT, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : CHAT_RATE_LIMIT;
}

function configuredWallVoteRateLimit() {
  const parsed = Number.parseInt(process.env.CADAVRE_WALL_VOTE_RATE_LIMIT, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : WALL_VOTE_RATE_LIMIT;
}

function clientIp(req) {
  const header = (name) => {
    if (typeof req.get === 'function') return req.get(name);
    return req.headers?.[name.toLowerCase()];
  };
  const cloudflare = header('CF-Connecting-IP');
  if (cloudflare) return String(cloudflare).trim();
  const forwarded = header('X-Forwarded-For');
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimitChat(req, res, next, now = Date.now()) {
  const key = clientIp(req);
  const current = chatRateBuckets.get(key);
  const bucket = !current || now - current.startedAt >= CHAT_RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : current;
  const limit = configuredRateLimit();
  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((CHAT_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many Cadavre chat requests. Please try again shortly.' });
    return;
  }
  bucket.count += 1;
  chatRateBuckets.set(key, bucket);
  if (chatRateBuckets.size > 5000) {
    for (const [bucketKey, value] of chatRateBuckets) {
      if (now - value.startedAt >= CHAT_RATE_WINDOW_MS) chatRateBuckets.delete(bucketKey);
    }
  }
  next();
}

function rateLimitVote(req, res, next, now = Date.now()) {
  const key = clientIp(req);
  const current = wallVoteRateBuckets.get(key);
  const bucket = !current || now - current.startedAt >= CHAT_RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : current;
  const limit = configuredWallVoteRateLimit();
  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((CHAT_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many wall votes. Please try again shortly.' });
    return;
  }
  bucket.count += 1;
  wallVoteRateBuckets.set(key, bucket);
  if (wallVoteRateBuckets.size > 5000) {
    for (const [bucketKey, value] of wallVoteRateBuckets) {
      if (now - value.startedAt >= CHAT_RATE_WINDOW_MS) wallVoteRateBuckets.delete(bucketKey);
    }
  }
  next();
}

function ollamaThinkSetting(model) {
  return /^gpt-oss(?::|$)/i.test(model || '') ? 'low' : false;
}

function providerTokenUsage(candidate, data) {
  const usage = data?.usage || {};
  const inputTokens = finiteMetric(candidate.provider === 'ollama-cloud'
    ? data?.prompt_eval_count
    : usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = finiteMetric(candidate.provider === 'ollama-cloud'
    ? data?.eval_count
    : usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = finiteMetric(usage.total_tokens) ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  const cachedInputTokens = finiteMetric(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens
  );
  return compactMetrics({
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens
  });
}

async function callCandidate(candidate, messages, settings, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (candidate.apiKey) headers.Authorization = `Bearer ${candidate.apiKey}`;
  if (candidate.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://inference-arcade.com/cadavre';
    headers['X-Title'] = 'Cadavre Exquis';
  }

  let apiUrl = candidate.apiUrl;
  let body = {
    model: candidate.model,
    messages,
    max_tokens: settings.maxTokens,
    temperature: settings.temperature,
    stream: false
  };

  if (candidate.provider === 'ollama-cloud') {
    const verdict = usageGuardrail.admitOllamaCall(0);
    if (!verdict.allowed) {
      const error = new Error(verdict.reason);
      error.status = 429;
      error.guardrail = true;
      error.scope = verdict.scope;
      throw error;
    }
    apiUrl = ollamaChatUrl(candidate.apiUrl);
    body = {
      model: candidate.model,
      messages,
      stream: false,
      think: ollamaThinkSetting(candidate.model),
      options: {
        num_predict: settings.maxTokens,
        temperature: settings.temperature
      }
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, options.timeoutMs || FETCH_TIMEOUT_MS);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${candidate.provider} timed out`);
    throw error;
  }

  if (!response.ok) {
    await response.text();
    const error = new Error(`${candidate.provider} returned ${response.status}`);
    error.providerStatus = response.status;
    throw error;
  }

  const data = await response.json();
  const content = candidate.provider === 'ollama-cloud'
    ? data.message?.content
    : data.choices?.[0]?.message?.content;
  if (!String(content || '').trim()) {
    throw new Error(`${candidate.provider} returned empty content`);
  }
  return {
    content: String(content).trim(),
    provider: candidate.provider,
    model: candidate.id,
    usage: providerTokenUsage(candidate, data)
  };
}

function shouldRetryOllama(candidate, error, attempt) {
  if (candidate.provider !== 'ollama-cloud' || error.guardrail || attempt >= OLLAMA_MAX_ATTEMPTS) {
    return false;
  }
  if (!error.providerStatus) return true;
  return [408, 425, 500, 502, 503, 504].includes(error.providerStatus);
}

async function callCandidateWithRetry(candidate, messages, settings, options = {}) {
  const sleepImpl = options.sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const callCandidateImpl = options.callCandidateImpl || callCandidate;
  const nowImpl = options.nowImpl || Date.now;
  const deadlineAt = options.deadlineAt || (nowImpl() + CHAT_DEADLINE_MS);
  for (let attempt = 1; attempt <= OLLAMA_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadlineAt - nowImpl();
    if (remainingMs <= 0) throw new Error(`${candidate.provider} timed out`);
    const timeoutMs = Math.min(
      remainingMs,
      candidate.provider === 'ollama-cloud'
        ? (options.ollamaAttemptTimeoutMs || OLLAMA_ATTEMPT_TIMEOUT_MS)
        : (options.providerAttemptTimeoutMs || FETCH_TIMEOUT_MS)
    );
    try {
      options.onAttempt?.({
        provider: candidate.provider,
        model: candidate.id,
        attempt,
        fallback: Boolean(options.fallback),
        timeoutMs
      });
      return await callCandidateImpl(candidate, messages, settings, { timeoutMs });
    } catch (error) {
      if (!shouldRetryOllama(candidate, error, attempt)) throw error;
      if (deadlineAt - nowImpl() <= OLLAMA_RETRY_DELAY_MS) throw error;
      await sleepImpl(OLLAMA_RETRY_DELAY_MS);
    }
  }
  throw new Error('Ollama Cloud retry loop ended unexpectedly');
}

async function callCandidateReliably(candidate, messages, settings, options = {}) {
  const nowImpl = options.nowImpl || Date.now;
  const callCandidateImpl = options.callCandidateImpl || callCandidate;
  const deadlineAt = options.deadlineAt || (nowImpl() + CHAT_DEADLINE_MS);
  const primary = openRouterFallbackCandidate(candidate);
  if (!primary) {
    return callCandidateWithRetry(candidate, messages, settings, {
      ...options,
      callCandidateImpl,
      nowImpl,
      deadlineAt
    });
  }

  try {
    const remainingMs = deadlineAt - nowImpl();
    if (remainingMs <= 0) throw new Error(`${primary.provider} timed out`);
    const timeoutMs = Math.min(
      remainingMs,
      options.openRouterAttemptTimeoutMs || OPENROUTER_ATTEMPT_TIMEOUT_MS
    );
    options.onAttempt?.({
      provider: primary.provider,
      model: primary.id,
      attempt: 1,
      fallback: false,
      timeoutMs
    });
    return await callCandidateImpl(primary, messages, settings, { timeoutMs });
  } catch {
    return callCandidateWithRetry(candidate, messages, settings, {
      ...options,
      callCandidateImpl,
      nowImpl,
      deadlineAt,
      fallback: true
    });
  }
}

async function callListedRoutePoolReliably(pool, messages, settings, options = {}) {
  const nowImpl = options.nowImpl || Date.now;
  const deadlineAt = options.deadlineAt || (nowImpl() + CHAT_DEADLINE_MS);
  let lastError = null;

  for (let index = 0; index < pool.candidates.length; index += 1) {
    const candidate = pool.candidates[index];
    const remainingMs = deadlineAt - nowImpl();
    if (remainingMs <= 0) break;
    const routesLeft = pool.candidates.length - index;
    const routeBudgetMs = index === pool.candidates.length - 1
      ? remainingMs
      : Math.max(4000, Math.floor(remainingMs / routesLeft));
    const routeDeadlineAt = Math.min(deadlineAt, nowImpl() + routeBudgetMs);
    const standby = candidate.id !== pool.requested.id;

    try {
      const result = await callCandidateReliably(candidate, messages, settings, {
        ...options,
        deadlineAt: routeDeadlineAt,
        onAttempt: (attempt) => options.onAttempt?.({
          ...attempt,
          routeModel: candidate.id,
          standby,
          fallback: Boolean(attempt.fallback || standby)
        })
      });
      const ready = rememberModelReady(pool.requested.id, result, nowImpl());
      return {
        ...result,
        requestedModel: pool.requested.id,
        failover: ready.failover
      };
    } catch (error) {
      lastError = error;
      modelReadyCache.delete(candidate.id);
    }
  }

  if (lastError) throw lastError;
  const error = new Error('Cadavre model routes exhausted their response deadline');
  error.status = 503;
  throw error;
}

const MODEL_READY_MESSAGES = Object.freeze([
  Object.freeze({
    role: 'system',
    content: 'This is a model readiness check. Reply with one plain word and no punctuation.'
  }),
  Object.freeze({ role: 'user', content: 'ready' })
]);

async function ensureModelReady(routeModel, options = {}) {
  const requested = resolveRouteModel(routeModel);
  if (!options.force) {
    const cached = getModelReadyStatus(requested.id, options.nowImpl?.() ?? Date.now());
    if (cached) return cached;
    if (modelReadyChecks.has(requested.id)) return modelReadyChecks.get(requested.id);
  }

  const check = (async () => {
    const nowImpl = options.nowImpl || Date.now;
    const pool = await resolveListedRoutePool(requested.id);
    const result = await callListedRoutePoolReliably(
      pool,
      MODEL_READY_MESSAGES,
      { maxTokens: 16, temperature: 0 },
      {
        ...options,
        nowImpl,
        deadlineAt: options.deadlineAt || (nowImpl() + MODEL_READY_DEADLINE_MS)
      }
    );
    const status = getModelReadyStatus(requested.id, nowImpl()) ||
      rememberModelReady(requested.id, result, nowImpl());
    return { ...status, cached: false };
  })();

  modelReadyChecks.set(requested.id, check);
  try {
    return await check;
  } finally {
    if (modelReadyChecks.get(requested.id) === check) modelReadyChecks.delete(requested.id);
  }
}

function stopModelWarmer() {
  if (modelWarmTimer) clearInterval(modelWarmTimer);
  modelWarmTimer = null;
}

function startModelWarmer(options = {}) {
  stopModelWarmer();
  const intervalMs = clampNumber(
    options.intervalMs ?? process.env.CADAVRE_MODEL_WARM_INTERVAL_MS,
    MODEL_WARM_INTERVAL_MS,
    30000,
    60 * 60 * 1000
  );
  const warm = async () => {
    try {
      const status = await ensureModelReady(`ollama:${DEFAULT_OLLAMA_MODEL}`, { force: true });
      console.log(`[Cadavre] model ready: ${status.model} via ${status.provider}`);
      return status;
    } catch (error) {
      console.warn(`[Cadavre] model warm-up failed: ${error.message}`);
      return null;
    }
  };
  const initial = warm();
  modelWarmTimer = setInterval(warm, intervalMs);
  modelWarmTimer.unref?.();
  return initial;
}

function beginChatUsage(now = Date.now()) {
  chatUsageStats.requests += 1;
  chatUsageStats.inFlight += 1;
  chatUsageStats.peakInFlight = Math.max(chatUsageStats.peakInFlight, chatUsageStats.inFlight);
  return {
    startedAt: now,
    inFlightAtStart: chatUsageStats.inFlight
  };
}

function classifyCadavreError(error) {
  if (error?.guardrail) return 'guardrail';
  if (/timed out|abort/i.test(error?.message || '')) return 'timeout';
  if (/empty content/i.test(error?.message || '')) return 'empty_response';
  if (Number(error?.providerStatus) >= 500) return 'http_5xx';
  if (Number(error?.providerStatus) >= 400) return 'http_4xx';
  return 'provider_error';
}

function guardrailRatios() {
  const status = usageGuardrail.getStatus();
  if (status.disabled) return {};
  return compactMetrics({
    guardrail_hour_ratio: status.limits.hourly ? status.hourCount / status.limits.hourly : null,
    guardrail_day_ratio: status.limits.daily ? status.dayCount / status.limits.daily : null
  });
}

function recordChatUsage({ context, candidate, messages, settings, attempts, result, error }, now = Date.now()) {
  const latencyMs = Math.max(0, now - context.startedAt);
  const primaryAttempts = attempts.filter((attempt) => !attempt.fallback).length;
  const fallbackUsed = attempts.some((attempt) => attempt.fallback);
  const providerCalls = Math.max(0, attempts.length - (error?.guardrail ? 1 : 0));
  const retryCount = error?.guardrail ? 0 : Math.max(0, primaryAttempts - 1);
  const inputTokens = finiteMetric(result?.usage?.inputTokens);
  const outputTokens = finiteMetric(result?.usage?.outputTokens);

  chatUsageStats.inFlight = Math.max(0, chatUsageStats.inFlight - 1);
  if (result) chatUsageStats.completed += 1;
  else chatUsageStats.failed += 1;
  chatUsageStats.providerCalls += providerCalls;
  chatUsageStats.retries += retryCount;
  if (fallbackUsed) chatUsageStats.fallbacks += 1;
  chatUsageStats.inputTokens += inputTokens || 0;
  chatUsageStats.outputTokens += outputTokens || 0;
  chatUsageStats.totalLatencyMs += latencyMs;
  chatUsageStats.latencies.push(latencyMs);
  if (chatUsageStats.latencies.length > 1000) chatUsageStats.latencies.shift();

  const promptChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const finalProvider = result?.provider || attempts.at(-1)?.provider || candidate.provider;
  try {
    return telemetry.track({
      eventFamily: 'model_telemetry',
      eventType: result ? 'llm_decision' : 'cadavre_chat_failed',
      source: 'cadavre-route',
      modelId: candidate.id,
      provider: finalProvider,
      latencyMs,
      payload: compactMetrics({
        surface: 'cadavre',
        purpose: settings.maxTokens > 100 ? 'reading' : 'turn',
        outcome: result ? 'completed' : 'failed',
        error_class: error ? classifyCadavreError(error) : null,
        fallback_used: fallbackUsed
      }),
      metrics: compactMetrics({
        message_count: messages.length,
        prompt_chars: promptChars,
        response_chars: result?.content?.length ?? 0,
        max_tokens: settings.maxTokens,
        provider_calls: providerCalls,
        attempt_count: attempts.length,
        retry_count: retryCount,
        fallback_used: fallbackUsed ? 1 : 0,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: finiteMetric(result?.usage?.totalTokens),
        cached_input_tokens: finiteMetric(result?.usage?.cachedInputTokens),
        inflight_at_start: context.inFlightAtStart,
        ...guardrailRatios()
      })
    });
  } catch {
    return null;
  }
}

function cadavreUsageSnapshot(now = Date.now()) {
  const requests = chatUsageStats.requests;
  const settled = chatUsageStats.completed + chatUsageStats.failed;
  const cache = getCatalogCacheStatus(now);
  return {
    measurement: {
      scope: 'server_process',
      startedAt: USAGE_STARTED_AT,
      measuredAt: new Date(now).toISOString()
    },
    standards: {
      maxMessages: MAX_MESSAGES,
      maxCharsPerMessage: MAX_CONTENT_CHARS,
      maxTotalInputChars: MAX_TOTAL_CONTENT_CHARS,
      outputTokens: { min: 16, max: 500 },
      chatDeadlineMs: CHAT_DEADLINE_MS,
      ollamaAttempts: OLLAMA_MAX_ATTEMPTS,
      fallbackAttempts: 1,
      rateLimit: { requests: configuredRateLimit(), windowMs: CHAT_RATE_WINDOW_MS },
      modelCatalogCacheTtlMs: MODEL_CATALOG_TTL_MS
    },
    chat: {
      requests,
      completed: chatUsageStats.completed,
      failed: chatUsageStats.failed,
      successRate: settled ? chatUsageStats.completed / settled : 0,
      inFlight: chatUsageStats.inFlight,
      peakInFlight: chatUsageStats.peakInFlight,
      providerCalls: chatUsageStats.providerCalls,
      providerCallsPerCompletion: chatUsageStats.completed
        ? chatUsageStats.providerCalls / chatUsageStats.completed
        : 0,
      retries: chatUsageStats.retries,
      retryRate: requests ? chatUsageStats.retries / requests : 0,
      fallbacks: chatUsageStats.fallbacks,
      fallbackRate: requests ? chatUsageStats.fallbacks / requests : 0,
      averageLatencyMs: settled ? chatUsageStats.totalLatencyMs / settled : 0,
      p95LatencyMs: percentile(chatUsageStats.latencies, 95),
      inputTokens: chatUsageStats.inputTokens,
      outputTokens: chatUsageStats.outputTokens
    },
    caches: {
      modelCatalog: cache,
      htmlMirror: mirrorCacheStatusProvider ? mirrorCacheStatusProvider(now) : null
    },
    guardrail: usageGuardrail.getStatus()
  };
}

function setMirrorCacheStatusProvider(provider) {
  mirrorCacheStatusProvider = typeof provider === 'function' ? provider : null;
}

function createWallVoteHandler(store) {
  return async function wallVoteHandler(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      const result = await store.vote(
        req.params.id,
        req.body?.voterToken,
        req.body?.value
      );
      if (!result) {
        res.status(404).json({ error: 'This wall post is unavailable.' });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message || 'Unable to save this vote.' });
    }
  };
}

router.use(cadavreCors);

router.get('/models', async (req, res) => {
  try {
    res.json(await getModelCatalog());
  } catch {
    res.status(503).json({ error: 'Cadavre model catalog is unavailable.' });
  }
});

router.post('/ready', rateLimitChat, async (req, res) => {
  try {
    const status = await ensureModelReady(req.body?.model);
    res.set('Cache-Control', 'no-store').json({
      ready: true,
      requestedModel: status.requestedModel,
      model: status.model,
      provider: status.provider,
      failover: status.failover,
      cached: status.cached,
      checkedAt: status.checkedAt
    });
  } catch (error) {
    res.set('Cache-Control', 'no-store').status(error.status || 503).json({
      ready: false,
      retryable: true,
      error: 'No Cadavre model route is ready yet.'
    });
  }
});

router.get('/usage', (req, res) => {
  res.json(cadavreUsageSnapshot());
});

router.get('/wall/health', async (req, res) => {
  try {
    const health = await wallStore.health();
    res.set('Cache-Control', 'no-store').json(health);
  } catch (error) {
    console.error('[Cadavre wall] health check failed:', error.cause?.message || error.message);
    res.set('Cache-Control', 'no-store').status(503).json({
      status: 'unavailable',
      storage: 'postgres'
    });
  }
});

router.get('/wall', async (req, res) => {
  try {
    const page = await wallStore.list({ limit: req.query.limit, cursor: req.query.cursor });
    res.set('Cache-Control', 'no-store').json(page);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unable to load the shared wall.' });
  }
});

router.post('/wall', rateLimitChat, async (req, res) => {
  try {
    const created = await wallStore.create(req.body || {});
    res.set('Cache-Control', 'no-store').status(201).json(created);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unable to pin this corpse.' });
  }
});

router.post('/wall/:id/vote', rateLimitVote, createWallVoteHandler(wallStore));

// POST works with the existing GitHub Pages CORS policy and keeps the delete
// capability in a JSON body rather than a URL or server log.
router.post('/wall/:id/remove', rateLimitChat, async (req, res) => {
  try {
    const removed = await wallStore.remove(req.params.id, req.body?.deleteToken);
    if (!removed) {
      res.status(404).json({ error: 'This pin is unavailable or belongs to another browser.' });
      return;
    }
    res.status(204).end();
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unable to remove this pin.' });
  }
});

router.post('/chat', rateLimitChat, async (req, res) => {
  let messages;
  let candidate;
  let routePool;
  try {
    messages = cleanMessages(req.body?.messages);
    routePool = await resolveListedRoutePool(req.body?.model);
    candidate = routePool.requested;
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
    return;
  }

  const settings = {
    maxTokens: clampNumber(req.body?.max_tokens ?? req.body?.maxTokens, 160, 16, 500),
    temperature: clampNumber(req.body?.temperature, 0.8, 0, 1.4)
  };
  const usageContext = beginChatUsage();
  const attempts = [];

  try {
    const result = await callListedRoutePoolReliably(routePool, messages, settings, {
      onAttempt: (attempt) => attempts.push(attempt)
    });
    recordChatUsage({
      context: usageContext,
      candidate,
      messages,
      settings,
      attempts,
      result
    });
    res.json({
      id: `cadavre-${Date.now()}`,
      object: 'chat.completion',
      model: result.model,
      requested_model: result.requestedModel,
      provider: result.provider,
      failover: result.failover,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop'
      }]
    });
  } catch (error) {
    recordChatUsage({
      context: usageContext,
      candidate,
      messages,
      settings,
      attempts,
      error
    });
    res.status(error.status || 503).json({
      error: 'Cadavre model routes are temporarily unavailable.',
      retryable: true
    });
  }
});

function resetForTest() {
  chatRateBuckets.clear();
  wallVoteRateBuckets.clear();
  catalogCache = null;
  catalogRefresh = null;
  modelReadyCache.clear();
  modelReadyChecks.clear();
  stopModelWarmer();
  Object.keys(catalogCacheStats).forEach((key) => { catalogCacheStats[key] = 0; });
  Object.assign(chatUsageStats, {
    requests: 0,
    completed: 0,
    failed: 0,
    inFlight: 0,
    peakInFlight: 0,
    providerCalls: 0,
    retries: 0,
    fallbacks: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
    latencies: []
  });
  usageGuardrail.resetForTest();
}

module.exports = router;
module.exports.setMirrorCacheStatusProvider = setMirrorCacheStatusProvider;
module.exports.startModelWarmer = startModelWarmer;
module.exports.stopModelWarmer = stopModelWarmer;
module.exports.closeWallStore = () => wallStore.close();
module.exports._private = {
  cleanMessages,
  providerCandidates,
  resolveRouteModel,
  openRouterFallbackCandidate,
  configuredStandbyModelIds,
  isLocalUrl,
  isSafeModelName,
  CADAVRE_CLOUD_MODEL_IDS,
  CADAVRE_OPENROUTER_MODEL_IDS,
  clampNumber,
  modelsUrl,
  openRouterModelsUrl,
  ollamaChatUrl,
  probeProviderModels,
  buildModelCatalog,
  getModelCatalog,
  getCatalogCacheStatus,
  resolveListedRouteModel,
  resolveListedRoutePool,
  getModelReadyStatus,
  rememberModelReady,
  isAllowedOrigin,
  cadavreCors,
  clientIp,
  configuredWallVoteRateLimit,
  rateLimitChat,
  rateLimitVote,
  createWallVoteHandler,
  WALL_VOTE_RATE_LIMIT,
  ollamaThinkSetting,
  providerTokenUsage,
  CHAT_DEADLINE_MS,
  OPENROUTER_ATTEMPT_TIMEOUT_MS,
  OLLAMA_ATTEMPT_TIMEOUT_MS,
  MODEL_READY_TTL_MS,
  MODEL_READY_DEADLINE_MS,
  DEFAULT_STANDBY_MODELS,
  callCandidate,
  shouldRetryOllama,
  callCandidateWithRetry,
  callCandidateReliably,
  callListedRoutePoolReliably,
  ensureModelReady,
  startModelWarmer,
  stopModelWarmer,
  beginChatUsage,
  recordChatUsage,
  cadavreUsageSnapshot,
  setMirrorCacheStatusProvider,
  resetForTest
};
