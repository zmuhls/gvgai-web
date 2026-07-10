'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../lib/models');

test('built-in catalog exposes every stated Ollama Cloud model', () => {
  assert.deepEqual(models.MODELS.map(model => model.id), [
    'gemma3:4b',
    'gemma3:12b',
    'gemma3:27b',
    'qwen3-coder-next',
    'ministral-3:14b',
    'ministral-3:8b',
    'ministral-3:3b',
    'devstral-small-2:24b',
    'glm-5.2',
    'kimi-k2.7-code',
    'minimax-m3',
    'deepseek-v4-flash',
    'qwen3.5:397b',
    'nemotron-3-nano:30b',
    'gemma4:31b'
  ]);

  assert.deepEqual(models.MODELS.map(model => model.provider), Array(15).fill('ollama-cloud'));
  assert.deepEqual(models.MODELS.filter(model => model.featured).map(model => model.id), [
    'gemma3:27b',
    'qwen3-coder-next',
    'ministral-3:14b',
    'ministral-3:8b',
    'devstral-small-2:24b'
  ]);
  assert.equal(models.resolveModel('gemma3:27b').fallback, 'google/gemma-3-27b-it');
  assert.equal(models.resolveModel('ministral-3:14b').fallback, 'mistralai/ministral-14b-2512');
  assert.equal(models.resolveModel('devstral-small-2:24b').fallback, null);

  // Frontier reasoning entries: think:false routing flag + verified fallbacks;
  // none featured, so none enter the marble-run rotation.
  const frontier = models.MODELS.filter(model => model.reasoning);
  assert.deepEqual(frontier.map(model => model.id),
    [
      'glm-5.2',
      'kimi-k2.7-code',
      'minimax-m3',
      'deepseek-v4-flash',
      'qwen3.5:397b',
      'nemotron-3-nano:30b',
      'gemma4:31b'
    ]);
  assert.ok(frontier.every(model => !model.featured));
  assert.equal(models.resolveModel('glm-5.2').fallback, 'z-ai/glm-5.2');
  assert.equal(models.resolveModel('deepseek-v4-flash').fallback, 'deepseek/deepseek-v4-flash');
});

function withRegistry(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-registry-test-'));
  const registryPath = path.join(dir, 'finetune-models.json');
  if (content !== null) {
    fs.writeFileSync(registryPath, typeof content === 'string' ? content : JSON.stringify(content));
  }
  process.env.FINETUNE_REGISTRY_PATH = registryPath;
  models.invalidateFinetunedCache();
  return registryPath;
}

function restore() {
  delete process.env.FINETUNE_REGISTRY_PATH;
  models.invalidateFinetunedCache();
}

const ENTRY = {
  id: 'gvgai-aliens-ft-202607061200',
  name: 'gemma-3-4b-it FT · aliens',
  baseModel: 'unsloth/gemma-3-4b-it',
  provider: 'ollama-local',
  gameId: 0,
  gameName: 'aliens',
  trainedOnPlays: 4,
  trainedAt: '2026-07-06T12:00:00Z',
  modelPath: '/x/lora',
  ggufPath: '/x/unsloth.Q4_K_M.gguf',
  description: 'Fine-tuned on 4 human plays of aliens',
  runId: 'r1'
};

test('getAllModels returns the built-in catalog when no registry exists', () => {
  withRegistry(null);
  try {
    assert.deepEqual(models.getAllModels(), models.MODELS);
  } finally {
    restore();
  }
});

test('getAllModels merges registry entries as non-featured ollama-local models', () => {
  withRegistry({ models: [ENTRY], updatedAt: '2026-07-06T12:00:00Z' });
  try {
    const all = models.getAllModels();
    assert.equal(all.length, models.MODELS.length + 1);
    const merged = all[all.length - 1];
    assert.equal(merged.id, ENTRY.id);
    assert.equal(merged.provider, 'ollama-local');
    assert.equal(merged.fallback, null);
    assert.equal(merged.featured, false);
    assert.equal(merged.finetuned, true);
    assert.equal(merged.gameId, 0);
  } finally {
    restore();
  }
});

test('resolveModel routes registry ids to ollama-local, not inferred ollama-cloud', () => {
  withRegistry({ models: [ENTRY] });
  try {
    const resolved = models.resolveModel(ENTRY.id);
    assert.equal(resolved.provider, 'ollama-local');
    assert.equal(resolved.fallback, null);
    // built-ins and inference untouched
    assert.equal(models.resolveModel('gemma3:27b').provider, 'ollama-cloud');
    assert.equal(models.resolveModel('some/openrouter-slug').provider, 'openrouter');
    assert.equal(models.resolveModel('unknown-tag').provider, 'ollama-cloud');
  } finally {
    restore();
  }
});

test('registry entries can route to legion vLLM adapters', () => {
  const legionEntry = {
    ...ENTRY,
    id: 'gvgai-aliens',
    name: 'Gemma 3 4B FT · aliens',
    provider: 'legion-vllm',
    modelPath: '/srv/adapters/gvgai-aliens/lora',
    ggufPath: null,
    fallback: 'gemma3:27b',
    fallbackProvider: 'ollama-cloud'
  };

  withRegistry({ models: [legionEntry] });
  try {
    const merged = models.getAllModels().find(model => model.id === 'gvgai-aliens');
    assert.equal(merged.provider, 'legion-vllm');
    assert.equal(merged.fallback, 'gemma3:27b');
    assert.equal(merged.fallbackProvider, 'ollama-cloud');
    assert.equal(models.resolveModel('gvgai-aliens').provider, 'legion-vllm');
  } finally {
    restore();
  }
});

test('a corrupt registry degrades to the built-in catalog', () => {
  withRegistry('{not json');
  try {
    assert.deepEqual(models.getAllModels(), models.MODELS);
    assert.equal(models.resolveModel('gvgai-x-ft-1').provider, 'ollama-cloud');
  } finally {
    restore();
  }
});

test('registry cache invalidates on mtime change and explicit invalidation', () => {
  const registryPath = withRegistry({ models: [ENTRY] });
  try {
    assert.equal(models.getAllModels().length, models.MODELS.length + 1);

    const second = { ...ENTRY, id: 'gvgai-bait-ft-202607061201', gameName: 'bait' };
    fs.writeFileSync(registryPath, JSON.stringify({ models: [ENTRY, second] }));
    // force a different mtime in case the writes land within timestamp resolution
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(registryPath, future, future);

    assert.equal(models.getAllModels().length, models.MODELS.length + 2);

    models.invalidateFinetunedCache();
    assert.equal(models.getAllModels().length, models.MODELS.length + 2);
  } finally {
    restore();
  }
});

test('registry ids colliding with built-in catalog ids are skipped', () => {
  withRegistry({ models: [{ ...ENTRY, id: 'gemma3:27b' }] });
  try {
    const all = models.getAllModels();
    assert.equal(all.length, models.MODELS.length);
    assert.equal(all.find(m => m.id === 'gemma3:27b').provider, 'ollama-cloud');
  } finally {
    restore();
  }
});
