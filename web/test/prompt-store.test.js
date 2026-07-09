const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveGamePromptConfig } = require('../lib/prompt-store');

test('aliens prompt config has code protocol disabled for natural-language prompting', () => {
  const config = resolveGamePromptConfig(0, 0);

  assert.equal(config.gameName, 'aliens');
  assert.equal(config.codeProtocol.enabled, false);
  assert.equal(config.codeProtocol.id, 'GV1');
  assert.equal(config.codeProtocol.policyId, 'aliens-opening-move');
  assert.equal(config.codeProtocol.authoritative, false);
});

test('selected arcade games have code protocols disabled for natural-language prompting', () => {
  const expectations = [
    [4, 'bait', 'bait-level0'],
    [15, 'camelRace', 'fixed-code']
  ];

  for (const [gameId, gameName, policyId] of expectations) {
    const config = resolveGamePromptConfig(gameId, 0);
    assert.equal(config.gameName, gameName);
    assert.equal(config.codeProtocol.enabled, false);
    assert.equal(config.codeProtocol.id, 'GV1');
    assert.equal(config.codeProtocol.policyId, policyId);
    assert.equal(config.codeProtocol.authoritative, false);
  }
});

test('boulderchase uses compact diamond-target guidance', () => {
  const config = resolveGamePromptConfig(10, 1);

  assert.equal(config.gameName, 'boulderchase');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['resource']);
  assert.deepEqual(config.codeProtocol.wallItypes, [0]);
});

test('butterflies uses compact butterfly-target guidance', () => {
  const config = resolveGamePromptConfig(13, 1);

  assert.equal(config.gameName, 'butterflies');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['npc']);
  assert.deepEqual(config.codeProtocol.targetItypes, [5]);
});

test('chase uses compact scared-goat target guidance', () => {
  const config = resolveGamePromptConfig(18, 1);

  assert.equal(config.gameName, 'chase');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['npc']);
  assert.deepEqual(config.codeProtocol.targetItypes, [6]);
  assert.equal(config.codeProtocol.dangerNonTargets, true);
});
