const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  normalizeVGDL,
  buildStrategicDigest,
  buildStrategicDigestFromFile
} = require('../lib/vgdl-digest');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function vgdlPath(relativePath) {
  return path.join(PROJECT_ROOT, relativePath);
}

test('VGDL normalization and hashes ignore comments and blank lines', () => {
  const source = fs.readFileSync(vgdlPath('examples/gridphysics/aliens.txt'), 'utf-8');
  const withNoise = `# local note\n\n${source}\n\n# trailing note\n`;

  assert.equal(normalizeVGDL(source), normalizeVGDL(withNoise));

  const baseline = buildStrategicDigest(source, { gameId: 0, gameName: 'aliens' });
  const noisy = buildStrategicDigest(withNoise, { gameId: 0, gameName: 'aliens' });
  assert.equal(noisy.rulesHash, baseline.rulesHash);
  assert.equal(noisy.digestHash, baseline.digestHash);
});

test('aliens digest captures controls, hazards, scoring, and win conditions', () => {
  const digest = buildStrategicDigestFromFile(vgdlPath('examples/gridphysics/aliens.txt'), {
    gameId: 0,
    gameName: 'aliens'
  });

  assert.deepEqual(digest.controls.actions, ['LEFT', 'RIGHT', 'SHOOT', 'WAIT']);
  assert.ok(digest.scoring.some(item => item.includes('alien') && item.includes('+2')));
  assert.ok(digest.hazards.includes('alien'));
  assert.ok(digest.hazards.includes('bomb'));
  assert.ok(digest.winConditions.some(item => item.includes('portal') && item.includes('alien')));
  assert.ok(digest.strategyTags.includes('lane-control'));
  assert.match(digest.promptText, /Strategic digest/);
});

test('bait digest captures push puzzle and key transform mechanics', () => {
  const digest = buildStrategicDigestFromFile(vgdlPath('examples/gridphysics/bait.txt'), {
    gameId: 4,
    gameName: 'bait'
  });

  assert.ok(digest.mechanics.includes('push box'));
  assert.ok(digest.mechanics.includes('collect key to transform'));
  assert.ok(digest.strategyTags.includes('position-puzzle'));
  assert.ok(digest.strategyTags.includes('state-change'));
});

test('chase digest captures target collection and angry hazards', () => {
  const digest = buildStrategicDigestFromFile(vgdlPath('examples/gridphysics/chase.txt'), {
    gameId: 18,
    gameName: 'chase'
  });

  assert.ok(digest.hazards.includes('angry'));
  assert.ok(digest.scoring.some(item => item.includes('scared')));
  assert.ok(digest.strategyTags.includes('avoid-collisions'));
});

test('non-codeProtocol featured game digest captures doorkoban box mechanics', () => {
  const digest = buildStrategicDigestFromFile(vgdlPath('examples/gridphysics/doorkoban.txt'), {
    gameId: 32,
    gameName: 'doorkoban'
  });

  assert.ok(digest.mechanics.includes('push box'));
  assert.ok(digest.strategyTags.includes('position-puzzle'));
  assert.ok(digest.promptText.includes('Win:'));
});
