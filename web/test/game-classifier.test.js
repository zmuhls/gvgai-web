const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

const {
  CLASSIFIER_VERSION,
  ARCHETYPES,
  PACES,
  classifyDigest,
  classifyGame,
  getCachedClassification,
  clearClassifierCache
} = require('../lib/game-classifier');
const { buildStrategicDigestFromFile } = require('../lib/vgdl-digest');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function digestFor(gameId, gameName) {
  return buildStrategicDigestFromFile(
    path.join(PROJECT_ROOT, 'examples', 'gridphysics', `${gameName}.txt`),
    { gameId, gameName }
  );
}

function syntheticDigest(overrides = {}) {
  return {
    avatar: { type: 'MovingAvatar', ...overrides.avatar },
    controls: { useLabel: 'USE', ...overrides.controls },
    strategyTags: overrides.strategyTags || [],
    hazards: overrides.hazards || [],
    loseConditions: overrides.loseConditions || []
  };
}

test('featured games classify to their expected archetypes', () => {
  const cases = [
    { id: 0, name: 'aliens', archetype: 'shooter-lane', pace: 'reactive' },
    { id: 4, name: 'bait', archetype: 'pusher-puzzle', pace: 'reactive' },
    { id: 11, name: 'boulderdash', archetype: 'collector', pace: 'reactive' },
    { id: 13, name: 'butterflies', archetype: 'chaser', pace: 'deliberate' },
    { id: 32, name: 'doorkoban', archetype: 'pusher-puzzle', pace: 'deliberate' }
  ];

  for (const { id, name, archetype, pace } of cases) {
    const classification = classifyDigest(digestFor(id, name), { physicsCategory: 'gridphysics' });
    assert.equal(classification.archetype, archetype, `${name} archetype`);
    assert.equal(classification.pace, pace, `${name} pace`);
    assert.equal(classification.classifierVersion, CLASSIFIER_VERSION);
    assert.ok(ARCHETYPES.includes(classification.archetype));
    assert.ok(PACES.includes(classification.pace));
  }
});

test('aliens gets the lane subtype, bait/chase the transform subtype', () => {
  assert.ok(classifyDigest(digestFor(0, 'aliens')).subtypes.includes('lane'));
  assert.ok(classifyDigest(digestFor(4, 'bait')).subtypes.includes('transform'));
  assert.ok(classifyDigest(digestFor(11, 'boulderdash')).subtypes.length >= 0);
});

test('archetype rules cover reflex, survivor, roaming shooter, and fallback', () => {
  assert.equal(
    classifyDigest(syntheticDigest({ avatar: { type: 'BirdAvatar' } })).archetype,
    'reflex-pilot'
  );
  assert.equal(
    classifyDigest(syntheticDigest({ strategyTags: ['survive', 'collect-resources', 'clear-objectives'] })).archetype,
    'survivor'
  );
  assert.equal(
    classifyDigest(syntheticDigest({
      avatar: { type: 'ShootAvatar' },
      controls: { useLabel: 'SHOOT' },
      strategyTags: ['use-action', 'attack-targets']
    })).archetype,
    'shooter-roaming'
  );
  assert.equal(classifyDigest(syntheticDigest()).archetype, 'navigator');
});

test('pace derivation: contphysics and reflex avatars are twitch', () => {
  assert.equal(classifyDigest(syntheticDigest(), { physicsCategory: 'contphysics' }).pace, 'twitch');
  assert.equal(classifyDigest(syntheticDigest({ avatar: { type: 'MissileAvatar' } }), { physicsCategory: 'gridphysics' }).pace, 'twitch');
  assert.equal(classifyDigest(syntheticDigest({ hazards: ['enemy'] }), { physicsCategory: 'gridphysics' }).pace, 'reactive');
  assert.equal(classifyDigest(syntheticDigest(), { physicsCategory: 'gridphysics' }).pace, 'deliberate');
});

test('subtype derivation: hazard-dense and timed', () => {
  const classification = classifyDigest(syntheticDigest({
    hazards: ['a', 'b', 'c'],
    loseConditions: ['timeout'],
    strategyTags: ['state-change']
  }));
  assert.ok(classification.subtypes.includes('hazard-dense'));
  assert.ok(classification.subtypes.includes('timed'));
  assert.ok(classification.subtypes.includes('transform'));
});

test('classification never perturbs the digest or its hash', () => {
  const digest = digestFor(32, 'doorkoban');
  const hashBefore = digest.digestHash;
  const snapshot = JSON.stringify(digest);

  const classification = classifyDigest(digest, { physicsCategory: 'gridphysics' });

  assert.equal(digest.digestHash, hashBefore);
  assert.equal(JSON.stringify(digest), snapshot);
  assert.equal(digest.classification, undefined);
  assert.ok(classification.archetype);
});

test('classifyGame falls back to navigator on unparseable VGDL', () => {
  const classification = classifyGame({
    id: 999,
    name: 'missing',
    vgdlPath: path.join(PROJECT_ROOT, 'examples', 'gridphysics', 'does-not-exist.txt'),
    category: 'gridphysics'
  });
  assert.equal(classification.archetype, 'navigator');
  assert.equal(classification.pace, 'deliberate');
  assert.ok(classification.inputs.error);
});

test('getCachedClassification resolves by game id and caches', () => {
  clearClassifierCache();
  const first = getCachedClassification(0);
  assert.equal(first.archetype, 'shooter-lane');
  assert.equal(getCachedClassification(0), first);
  assert.equal(getCachedClassification('not-a-number'), null);
  assert.equal(getCachedClassification(99999), null);
  clearClassifierCache();
});
