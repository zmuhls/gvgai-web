'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const models = require('../lib/models');

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
    assert.equal(models.resolveModel('gemma4:31b').provider, 'ollama-cloud');
    assert.equal(models.resolveModel('some/openrouter-slug').provider, 'openrouter');
    assert.equal(models.resolveModel('unknown-tag').provider, 'ollama-cloud');
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
  withRegistry({ models: [{ ...ENTRY, id: 'gemma4:31b' }] });
  try {
    const all = models.getAllModels();
    assert.equal(all.length, models.MODELS.length);
    assert.equal(all.find(m => m.id === 'gemma4:31b').provider, 'ollama-cloud');
  } finally {
    restore();
  }
});
