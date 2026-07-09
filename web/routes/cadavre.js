const express = require('express');
const { getConfig } = require('../lib/runtime-config');

const router = express.Router();

const MAX_MESSAGES = 14;
const MAX_CONTENT_CHARS = 9000;
const DEFAULT_MODEL = 'gemma-4-31b-it';
const DEFAULT_ADAPTER_MODEL = 'exquisite-corpse';
const DEFAULT_FALLBACK_MODEL = 'google/gemma-3-27b-it';

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

function providerCandidates(requestedModel) {
  const config = getConfig();
  const candidates = [];
  const explicitEndpoint = process.env.CADAVRE_ENDPOINT;

  if (explicitEndpoint) {
    candidates.push({
      provider: 'cadavre-endpoint',
      apiUrl: explicitEndpoint,
      model: process.env.CADAVRE_MODEL || requestedModel || DEFAULT_ADAPTER_MODEL,
      apiKey: process.env.CADAVRE_API_KEY || process.env.LEGION_API_KEY || ''
    });
  } else if (process.env.LEGION_VLLM_URL) {
    candidates.push({
      provider: 'legion-vllm',
      apiUrl: config.legion.apiUrl,
      model: process.env.CADAVRE_MODEL || requestedModel || DEFAULT_ADAPTER_MODEL,
      apiKey: process.env.LEGION_API_KEY || ''
    });
  }

  candidates.push({
    provider: 'ollama-cloud',
    apiUrl: config.ollamaCloud.apiUrl,
    model: process.env.CADAVRE_MODEL || DEFAULT_MODEL,
    apiKey: process.env.OLLAMA_API_KEY || ''
  });

  candidates.push({
    provider: 'openrouter',
    apiUrl: config.openrouter.apiUrl,
    model: process.env.CADAVRE_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
    apiKey: process.env.OPENROUTER_API_KEY || ''
  });

  return candidates.filter((candidate) => {
    if (!candidate.apiUrl) return false;
    if (isLocalUrl(candidate.apiUrl)) return true;
    return Boolean(candidate.apiKey);
  });
}

async function callCandidate(candidate, messages, settings) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (candidate.apiKey) {
    headers.Authorization = `Bearer ${candidate.apiKey}`;
  }
  if (candidate.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://inference-arcade.com/cadavre';
    headers['X-Title'] = 'Cadavre Exquis';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  let response;
  try {
    response = await fetch(candidate.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: candidate.model,
        messages,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: false
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${candidate.provider} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${candidate.provider} ${response.status}: ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || data.message?.content || '';
  if (!String(content).trim()) {
    throw new Error(`${candidate.provider} returned empty content`);
  }
  return {
    content: String(content).trim(),
    provider: candidate.provider,
    model: candidate.model
  };
}

router.post('/chat', async (req, res) => {
  let messages;
  try {
    messages = cleanMessages(req.body?.messages);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
    return;
  }

  const settings = {
    maxTokens: clampNumber(req.body?.max_tokens ?? req.body?.maxTokens, 160, 16, 500),
    temperature: clampNumber(req.body?.temperature, 0.8, 0, 1.4)
  };

  const requestedModel = typeof req.body?.model === 'string'
    ? req.body.model.slice(0, 120)
    : '';
  const candidates = providerCandidates(requestedModel);
  if (!candidates.length) {
    res.status(503).json({ error: 'No Cadavre model provider is configured.' });
    return;
  }

  let lastError = null;
  for (const candidate of candidates) {
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
      return;
    } catch (error) {
      lastError = error;
    }
  }

  res.status(502).json({
    error: 'Cadavre model unavailable.',
    detail: lastError ? lastError.message : 'No provider answered.'
  });
});

module.exports = router;
module.exports._private = {
  cleanMessages,
  providerCandidates,
  isLocalUrl,
  clampNumber
};
