// Shared model catalog + routing resolution.
//
// The catalog is open-weight small language models hosted on **Ollama Cloud**
// (the primary inference provider, drawing on OLLAMA_API_KEY). **OpenRouter**
// is the per-call fallback only — used automatically when an Ollama Cloud call
// fails. Every entry is a non-reasoning model: nothing here has the `thinking`
// capability flag on Ollama Cloud (/api/show), so no hidden reasoning-token
// burn and no empty-content replies.
//
// NOTE: confirm exact Ollama Cloud tags and OpenRouter slugs near the event —
// a stale id 404s at call time (surfaced via the 'llm-error' socket event), and
// for Ollama-primary models the fallback simply takes over. Fallback slugs
// below were verified against OpenRouter /api/v1/models on 2026-07-05.

const MODELS = [
  // --- Gemma (Google) ---
  {
    id: 'gemma3:27b', name: 'Gemma 3 27B',
    provider: 'ollama-cloud', fallback: 'google/gemma-3-27b-it',
    description: 'Open-weight · flagship small Gemma, non-reasoning',
    speed: 'fast', cost: 'low', featured: true
  },
  {
    id: 'gemma3:12b', name: 'Gemma 3 12B',
    provider: 'ollama-cloud', fallback: 'google/gemma-3-12b-it',
    description: 'Open-weight · mid-size Gemma, non-reasoning',
    speed: 'fast', cost: 'low', featured: true
  },
  // --- Qwen (Alibaba) ---
  {
    id: 'qwen3-coder-next', name: 'Qwen3 Coder Next',
    provider: 'ollama-cloud', fallback: 'qwen/qwen3-coder-next',
    description: 'Open-weight · MoE coder, non-reasoning (small active params)',
    speed: 'fast', cost: 'low', featured: false
  },
  // --- Mistral small tier ---
  {
    id: 'ministral-3:14b', name: 'Ministral 3 14B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-14b-2512',
    description: 'Open-weight · Mistral small tier, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'ministral-3:8b', name: 'Ministral 3 8B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-8b-2512',
    description: 'Open-weight · Mistral small tier, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'ministral-3:3b', name: 'Ministral 3 3B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-3b-2512',
    description: 'Open-weight · tiny end of the roster, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'devstral-small-2:24b', name: 'Devstral Small 2 24B',
    provider: 'ollama-cloud', fallback: null,
    description: 'Open-weight · coder-flavored small model, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  }
];

// --- Fine-tuned model registry (written by scripts/finetune.py) ---
//
// Registry entries become ollama-local catalog entries at read time. The file
// is optional: absent/corrupt → empty list, so the deployed instance (no local
// Ollama, no registry) serves the built-in catalog unchanged.

const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', 'data', 'finetune-models.json');

let registryCache = { path: null, mtimeMs: null, models: [] };

function registryPath() {
  return process.env.FINETUNE_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
}

function invalidateFinetunedCache() {
  registryCache = { path: null, mtimeMs: null, models: [] };
}

function loadFinetunedModels() {
  const filePath = registryPath();
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return [];
  }
  if (registryCache.path === filePath && registryCache.mtimeMs === mtimeMs) {
    return registryCache.models;
  }
  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    entries = Array.isArray(parsed) ? parsed : (parsed.models || []);
  } catch (err) {
    console.warn('[Models] Unreadable finetune registry, ignoring:', err.message);
    return [];
  }
  const models = entries
    .filter(e => e && e.id)
    .map(e => ({
      id: e.id,
      name: e.name || e.id,
      provider: e.provider || 'ollama-local',
      fallback: null,
      description: e.description || `Fine-tuned on ${e.trainedOnPlays ?? '?'} plays`,
      speed: 'fast',
      cost: 'free',
      featured: false,
      finetuned: true,
      gameId: e.gameId ?? null,
      gameName: e.gameName ?? null,
      baseModel: e.baseModel ?? null,
      dryRun: Boolean(e.dryRun)
    }));
  registryCache = { path: filePath, mtimeMs, models };
  return models;
}

// Built-in catalog + fine-tuned registry models (id collisions keep the built-in).
function getAllModels() {
  const fineTuned = loadFinetunedModels()
    .filter(ft => !MODELS.some(m => m.id === ft.id));
  return [...MODELS, ...fineTuned];
}

// Resolve a model id (from the catalog, or inferred for ad-hoc ids) to its routing.
// Fine-tuned registry models resolve to ollama-local — without this check the
// inference below would send them to Ollama Cloud, which has no such tag.
// Inference: a '/' means an OpenRouter slug; otherwise treat as an Ollama Cloud tag.
function resolveModel(id) {
  const found = MODELS.find(m => m.id === id);
  if (found) return found;
  const fineTuned = loadFinetunedModels().find(m => m.id === id);
  if (fineTuned) return fineTuned;
  if (id && id.includes('/')) return { id, provider: 'openrouter', fallback: null };
  return { id, provider: 'ollama-cloud', fallback: null };
}

module.exports = { MODELS, resolveModel, getAllModels, loadFinetunedModels, invalidateFinetunedCache };
