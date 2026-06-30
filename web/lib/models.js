// Shared model catalog + routing resolution.
//
// Primary inference provider is **Ollama Cloud**; **OpenRouter** is the per-call
// fallback (used automatically when an Ollama Cloud call fails). Frontier models
// that have no Ollama Cloud equivalent call OpenRouter directly. Local Ollama
// (no key) is kept for offline/dev.
//
// NOTE: confirm exact Ollama Cloud tags and OpenRouter slugs near the event —
// a stale id 404s at call time (surfaced via the 'llm-error' socket event), and
// for Ollama-primary models the fallback simply takes over.

const MODELS = [
  // --- Ollama Cloud primaries (OpenRouter fallback slug) ---
  {
    id: 'gpt-oss:120b', name: 'GPT-OSS 120B',
    provider: 'ollama-cloud', fallback: 'openai/gpt-oss-120b:exacto',
    description: 'Open-weight · Ollama Cloud (OpenRouter fallback)',
    speed: 'medium', cost: 'low', featured: true
  },
  {
    id: 'deepseek-v3.1:671b', name: 'DeepSeek v3.1',
    provider: 'ollama-cloud', fallback: 'deepseek/deepseek-v3.1-terminus:exacto',
    description: 'Open-weight · Ollama Cloud (OpenRouter fallback)',
    speed: 'medium', cost: 'low', featured: true
  },
  {
    id: 'qwen3-coder:480b', name: 'Qwen3 Coder 480B',
    provider: 'ollama-cloud', fallback: 'qwen/qwen3-coder',
    description: 'Open-weight · Ollama Cloud (OpenRouter fallback)',
    speed: 'medium', cost: 'low', featured: true
  },
  // --- OpenRouter frontier (direct; no Ollama Cloud equivalent) ---
  {
    id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5',
    provider: 'openrouter', fallback: null,
    description: 'Frontier · strongest reasoning (OpenRouter)',
    speed: 'medium', cost: 'mid', featured: false
  },
  {
    id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash',
    provider: 'openrouter', fallback: null,
    description: 'Frontier · fast (OpenRouter)',
    speed: 'fast', cost: 'low', featured: false
  },
  {
    id: 'openai/gpt-4o', name: 'GPT-4o',
    provider: 'openrouter', fallback: null,
    description: 'Frontier · all-rounder (OpenRouter)',
    speed: 'medium', cost: 'mid', featured: false
  },
  // --- Local Ollama (no key) ---
  {
    id: 'gemma3:1b', name: 'Gemma 3 1B (Local)',
    provider: 'ollama-local', fallback: null,
    description: 'Local Ollama model', speed: 'fast', cost: 'free', featured: false
  },
  {
    id: 'qwen2.5:0.5b', name: 'Qwen 2.5 0.5B (Local)',
    provider: 'ollama-local', fallback: null,
    description: 'Local Ollama model', speed: 'fast', cost: 'free', featured: false
  },
  {
    id: 'smollm2:135m', name: 'SmolLM2 135M (Local)',
    provider: 'ollama-local', fallback: null,
    description: 'Local Ollama model', speed: 'fast', cost: 'free', featured: false
  }
];

// Resolve a model id (from the catalog, or inferred for ad-hoc ids) to its routing.
// Inference: a '/' means an OpenRouter slug; otherwise treat as an Ollama Cloud tag.
function resolveModel(id) {
  const found = MODELS.find(m => m.id === id);
  if (found) return found;
  if (id && id.includes('/')) return { id, provider: 'openrouter', fallback: null };
  return { id, provider: 'ollama-cloud', fallback: null };
}

module.exports = { MODELS, resolveModel };
