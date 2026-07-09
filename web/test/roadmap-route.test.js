'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readModelNativeRoadmap } = require('../routes/roadmap');

test('model-native roadmap exposes lifecycle, games, phases, and sources', () => {
  const roadmap = readModelNativeRoadmap();

  assert.equal(roadmap.title, 'Model-Native Arcade');
  assert.deepEqual(roadmap.lifecycle, [
    'VGDL harvest',
    'No-Java runtime subset',
    'Trace capture',
    'Fine-tune JSONL',
    'QLoRA LoRA',
    'vLLM adapter',
    'Model registry',
    'Eval',
    'Featured promotion'
  ]);
  assert.equal(roadmap.games.length, 10);
  assert.deepEqual(roadmap.games.map(game => game.id), [
    0, 10, 14, 18, 13, 19, 20, 22, 30, 68
  ]);
  assert.ok(roadmap.games.every(game => game.adapterId.startsWith('gvgai-')));
  assert.ok(roadmap.phases.length >= 5);
  assert.ok(roadmap.sourceReferences.some(source => source.name === 'PyVGDL'));
  assert.ok(roadmap.sourceReferences.some(source => source.licenseReviewRequired));
});
