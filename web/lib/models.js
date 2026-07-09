// Shared model catalog and routing resolution.
//
// The built-in catalog is the stated Ollama Cloud roster, drawing on
// OLLAMA_API_KEY. OpenRouter is the per-call fallback for rows with a known
// compatible slug. Each entry is a non-reasoning model, so the game receives
// answer tokens rather than hidden reasoning tokens.
//
// NOTE: confirm exact Ollama Cloud tags and OpenRouter slugs near the event —
// a stale id 404s at call time (surfaced via the 'llm-error' socket event), and
// for Ollama-primary models the fallback simply takes over. Fallback slugs
// below were verified against OpenRouter /api/v1/models on 2026-07-08.

const MODELS = [
  // --- Gemma 3 (Google) ---
  {
    id: 'gemma3:27b', name: 'Gemma 3 27B',
    provider: 'ollama-cloud', fallback: 'google/gemma-3-27b-it',
    description: 'Open-weight · flagship small Gemma, non-reasoning',
    speed: 'fast', cost: 'low', featured: true
  },
  {
    id: 'gemma3:12b', name: 'Gemma 3 12B',
    provider: 'ollama-cloud', fallback: 'google/gemma-3-12b-it',
    description: '',
    speed: null, cost: null, featured: true
  },
  // --- Qwen (Alibaba) ---
  {
    id: 'qwen3-coder-next', name: 'Qwen3 Coder Next',
    provider: 'ollama-cloud', fallback: 'qwen/qwen3-coder-next',
    description: 'Open-weight · MoE coder, non-reasoning (small active params)',
    speed: 'fast', cost: 'low', featured: false
  },
  // --- Ministral (Mistral) ---
  {
    id: 'ministral-3:14b', name: 'Ministral 3 14B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-14b-2512',
    description: 'Open-weight · compact Mistral family model, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'ministral-3:8b', name: 'Ministral 3 8B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-8b-2512',
    description: 'Open-weight · smaller Mistral family model, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'ministral-3:3b', name: 'Ministral 3 3B',
    provider: 'ollama-cloud', fallback: 'mistralai/ministral-3b-2512',
    description: 'Open-weight · smallest stated Mistral family model, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  // --- Devstral (Mistral) ---
  {
    id: 'devstral-small-2:24b', name: 'Devstral Small 2 24B',
    provider: 'ollama-cloud', fallback: null,
    description: 'Open-weight · coder-flavored small model, non-reasoning',
    speed: 'fast', cost: 'low', featured: false
  },
  // --- Frontier (reasoning-era flagships on Ollama Cloud) ---
  // Unlike the roster above, these think by default. llm-client routes
  // reasoning:true cloud entries through Ollama's native /api/chat with
  // think:false so the game receives answer tokens inside its token budget.
  // Tags verified against the account's /api/tags on 2026-07-09; OpenRouter
  // fallback slugs verified against /api/v1/models the same day.
  {
    id: 'glm-5.2', name: 'GLM 5.2',
    provider: 'ollama-cloud', fallback: 'z-ai/glm-5.2', reasoning: true,
    description: 'Frontier · Z.ai flagship MoE, reasoning',
    speed: 'slow', cost: 'high', featured: false
  },
  {
    id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code',
    provider: 'ollama-cloud', fallback: 'moonshotai/kimi-k2.7-code', reasoning: true,
    description: 'Frontier · Moonshot coding-agentic model, reasoning',
    speed: 'slow', cost: 'high', featured: false
  },
  {
    id: 'minimax-m3', name: 'MiniMax M3',
    provider: 'ollama-cloud', fallback: 'minimax/minimax-m3', reasoning: true,
    description: 'Frontier · newest MiniMax line, thinking model',
    speed: 'slow', cost: 'high', featured: false
  },
  {
    id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',
    provider: 'ollama-cloud', fallback: 'deepseek/deepseek-v4-flash', reasoning: true,
    description: 'Frontier · efficient MoE (284B total / 13B active), reasoning',
    speed: 'slow', cost: 'high', featured: false
  },
  {
    id: 'qwen3.5:397b', name: 'Qwen 3.5 397B',
    provider: 'ollama-cloud', fallback: 'qwen/qwen3.5-397b-a17b', reasoning: true,
    description: 'Frontier · largest hosted Qwen 3.5, reasoning',
    speed: 'slow', cost: 'high', featured: false
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
      fallback: e.fallback || null,
      fallbackProvider: e.fallbackProvider || null,
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
