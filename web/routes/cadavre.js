const express = require('express');
const { getConfig } = require('../lib/runtime-config');
const usageGuardrail = require('../lib/usage-guardrail');

const router = express.Router();

const MAX_MESSAGES = 14;
const MAX_CONTENT_CHARS = 9000;
const MAX_MODEL_ID_CHARS = 120;
const DEFAULT_ADAPTER_MODEL = 'exquisite-corpse';
const DEFAULT_OLLAMA_MODEL = 'deepseek-v4-flash';
const DEFAULT_ROUTE_MODEL = `legion:${DEFAULT_ADAPTER_MODEL}`;
const FETCH_TIMEOUT_MS = 60000;
const MODEL_PROBE_TIMEOUT_MS = 5000;
const MODEL_CATALOG_TTL_MS = 30000;
const CHAT_RATE_LIMIT = 30;
const CHAT_RATE_WINDOW_MS = 60000;

const chatRateBuckets = new Map();
let catalogCache = null;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    const err = new Error('messages must be an array');
    err.status = 400;
    throw err;
  }

  return rawMessages.slice(-MAX_MESSAGES).map((message) => {
    const role = ['system', 'user', 'assistant'].includes(message?.role)
      ? message.role
      : 'user';
    const content = String(message?.content || '').slice(0, MAX_CONTENT_CHARS);
    return { role, content };
  }).filter((message) => message.content.trim());
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
  if (!apiUrl || (!apiKey && !isLocalUrl(apiUrl))) {
    const error = new Error('Ollama Cloud is not configured');
    error.status = 503;
    throw error;
  }
  return {
    id: `ollama:${model}`,
    provider: 'ollama-cloud',
    apiUrl,
    model,
    apiKey
  };
}

function providerCandidates(requestedModel) {
  try {
    return [resolveRouteModel(requestedModel)];
  } catch {
    return [];
  }
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

async function probeProviderModels(apiUrl, apiKey = '') {
  if (!apiUrl) return { available: false, models: [] };
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchWithTimeout(modelsUrl(apiUrl), { headers }, MODEL_PROBE_TIMEOUT_MS);
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

  const [legion, ollama] = await Promise.all([
    probeProviderModels(legionUrl, legionKey),
    (!ollamaKey && !isLocalUrl(ollamaUrl))
      ? Promise.resolve({ available: false, models: [] })
      : probeProviderModels(ollamaUrl, ollamaKey)
  ]);
  const adapterAvailable = legion.available && legion.models.some(({ id }) => id === adapterModel);
  const models = [{
    id: `legion:${adapterModel}`,
    model: adapterModel,
    label: 'Exquisite Corpse (fine-tuned on Legion)',
    provider: 'legion',
    available: adapterAvailable
  }];

  const cloudModels = [...ollama.models].sort((a, b) => a.label.localeCompare(b.label));
  for (const model of cloudModels) {
    models.push({
      id: `ollama:${model.id}`,
      model: model.id,
      label: `${model.label} (Ollama Cloud)`,
      provider: 'ollama',
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
      ollama: { available: ollama.available, modelCount: ollama.models.length }
    }
  };
}

async function getModelCatalog(now = Date.now()) {
  if (catalogCache && now - catalogCache.createdAt < MODEL_CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const value = await buildModelCatalog();
  catalogCache = { createdAt: now, value };
  return value;
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

function ollamaThinkSetting(model) {
  return /^gpt-oss(?::|$)/i.test(model || '') ? 'low' : false;
}

async function callCandidate(candidate, messages, settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (candidate.apiKey) headers.Authorization = `Bearer ${candidate.apiKey}`;

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
    }, FETCH_TIMEOUT_MS);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`${candidate.provider} timed out`);
    throw error;
  }

  if (!response.ok) {
    await response.text();
    throw new Error(`${candidate.provider} returned ${response.status}`);
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
    model: candidate.id
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

router.post('/chat', rateLimitChat, async (req, res) => {
  let messages;
  let candidate;
  try {
    messages = cleanMessages(req.body?.messages);
    candidate = await resolveListedRouteModel(req.body?.model);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
    return;
  }

  const settings = {
    maxTokens: clampNumber(req.body?.max_tokens ?? req.body?.maxTokens, 160, 16, 500),
    temperature: clampNumber(req.body?.temperature, 0.8, 0, 1.4)
  };

  try {
    const result = await callCandidate(candidate, messages, settings);
    res.json({
      id: `cadavre-${Date.now()}`,
      object: 'chat.completion',
      model: result.model,
      provider: result.provider,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop'
      }]
    });
  } catch (error) {
    if (error.guardrail) {
      res.status(429).json({ error: `Ollama Cloud usage guardrail: ${error.message}` });
      return;
    }
    res.status(error.status || 502).json({ error: 'Cadavre model unavailable.' });
  }
});

function resetForTest() {
  chatRateBuckets.clear();
  catalogCache = null;
  usageGuardrail.resetForTest();
}

module.exports = router;
module.exports._private = {
  cleanMessages,
  providerCandidates,
  resolveRouteModel,
  isLocalUrl,
  isSafeModelName,
  clampNumber,
  modelsUrl,
  ollamaChatUrl,
  probeProviderModels,
  buildModelCatalog,
  getModelCatalog,
  resolveListedRouteModel,
  isAllowedOrigin,
  cadavreCors,
  clientIp,
  rateLimitChat,
  ollamaThinkSetting,
  callCandidate,
  resetForTest
};
