'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../lib/models');

const NO_KEYS = {};
const LEGION_ENTRY = {
  id: 'unsloth/gemma-4-E4B-it',
  name: 'Gemma 4 E4B (local vLLM)',
  provider: 'legion-vllm',
  finetuned: false
};

function withRegistry(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-registry-test-'));
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

test('without provider keys, cloud models are unavailable and registry locals are available', () => {
  withRegistry({ models: [LEGION_ENTRY] });
  try {
    const flagship = models.MODELS.find(m => m.id === 'gemma3:27b');
    assert.equal(models.isModelAvailable(flagship, NO_KEYS), false);
    const legion = models.getAllModels().find(m => m.id === LEGION_ENTRY.id);
    assert.equal(models.isModelAvailable(legion, NO_KEYS), true,
      'a registry entry is an operator decision — it counts as available');
  } finally {
    restore();
  }
});

test('an Ollama Cloud key makes the cloud roster available', () => {
  const flagship = models.MODELS.find(m => m.id === 'gemma3:27b');
  assert.equal(models.isModelAvailable(flagship, { OLLAMA_API_KEY: 'k' }), true);
  assert.equal(models.isModelAvailable(flagship, { OLLAMA_CLOUD_API_KEY: 'k' }), true);
});

test('an OpenRouter key revives only cloud models with a fallback slug', () => {
  const withFallback = models.MODELS.find(m => m.id === 'gemma3:27b');
  const withoutFallback = models.MODELS.find(m => m.id === 'devstral-small-2:24b');
  const env = { OPENROUTER_API_KEY: 'k' };
  assert.equal(models.isModelAvailable(withFallback, env), true);
  assert.equal(models.isModelAvailable(withoutFallback, env), false);
});

test('availableEvalModels prefers available featured, then registry locals, then legacy featured', () => {
  const featuredIds = models.MODELS.filter(m => m.featured).map(m => m.id);

  // Keys present: unchanged behavior — the featured cloud roster.
  withRegistry({ models: [LEGION_ENTRY] });
  try {
    assert.deepEqual(
      models.availableEvalModels({ OLLAMA_API_KEY: 'k' }).map(m => m.id),
      featuredIds
    );

    // Keyless box with a registry: the local model carries the marquee.
    assert.deepEqual(
      models.availableEvalModels(NO_KEYS).map(m => m.id),
      [LEGION_ENTRY.id]
    );
  } finally {
    restore();
  }

  // Keyless and no registry: deterministic legacy fallback (old behavior).
  withRegistry(null);
  try {
    assert.deepEqual(models.availableEvalModels(NO_KEYS).map(m => m.id), featuredIds);
  } finally {
    restore();
  }
});

test('buildArcadeEvalPlan applies availability only when availabilityEnv is passed', () => {
  const { buildArcadeEvalPlan } = require('../lib/eval-plan');
  const featuredIds = models.MODELS.filter(m => m.featured).map(m => m.id);

  withRegistry({ models: [LEGION_ENTRY] });
  try {
    // Keyless env: the registry local carries the plan.
    const keyless = buildArcadeEvalPlan({ gameCount: 1, availabilityEnv: {} });
    assert.deepEqual(keyless.modelIds, [LEGION_ENTRY.id]);

    // Keyed env: unchanged featured roster.
    const keyed = buildArcadeEvalPlan({ gameCount: 1, availabilityEnv: { OLLAMA_API_KEY: 'k' } });
    assert.deepEqual(keyed.modelIds, featuredIds);

    // No availabilityEnv: deterministic legacy default regardless of registry.
    const legacy = buildArcadeEvalPlan({ gameCount: 1 });
    assert.deepEqual(legacy.modelIds, featuredIds);
  } finally {
    restore();
  }
});
