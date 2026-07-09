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
    [4, 'bait', 'bait-level0']
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

test('camelRace uses compact portal target guidance', () => {
  const config = resolveGamePromptConfig(15, 1);

  assert.equal(config.gameName, 'camelRace');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['portal']);
  assert.equal(config.codeProtocol.targetEntityCode, 'g');
  assert.deepEqual(config.codeProtocol.wallItypes, [0]);
});

test('digdug uses compact gem target guidance', () => {
  const config = resolveGamePromptConfig(30, 1);

  assert.equal(config.gameName, 'digdug');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['immovable']);
  assert.deepEqual(config.codeProtocol.targetItypes, [5]);
  assert.deepEqual(config.codeProtocol.wallItypes, [0, 4]);
  assert.deepEqual(config.codeProtocol.dangerSources, ['movable']);
});

test('crossfire uses compact portal goal guidance', () => {
  const config = resolveGamePromptConfig(26, 1);

  assert.equal(config.gameName, 'crossfire');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['portal']);
  assert.deepEqual(config.codeProtocol.targetItypes, [6]);
  assert.deepEqual(config.codeProtocol.wallItypes, [0]);
  assert.deepEqual(config.codeProtocol.dangerSources, ['npc', 'movable']);
});

test('hungrybirds uses compact portal goal guidance', () => {
  const config = resolveGamePromptConfig(50, 1);

  assert.equal(config.gameName, 'hungrybirds');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['portal']);
  assert.deepEqual(config.codeProtocol.targetItypes, [4]);
  assert.deepEqual(config.codeProtocol.wallItypes, [0]);
});

test('firecaster uses compact mana target guidance', () => {
  const config = resolveGamePromptConfig(40, 1);

  assert.equal(config.gameName, 'firecaster');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['resource']);
  assert.deepEqual(config.codeProtocol.targetItypes, [6]);
  assert.deepEqual(config.codeProtocol.wallItypes, [0, 5]);
});

test('garbagecollector uses compact garbage target guidance', () => {
  const config = resolveGamePromptConfig(45, 1);

  assert.equal(config.gameName, 'garbagecollector');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['movable']);
  assert.deepEqual(config.codeProtocol.targetItypes, [4]);
  assert.deepEqual(config.codeProtocol.wallItypes, [0]);
});

test('iceandfire uses compact boot resource guidance', () => {
  const config = resolveGamePromptConfig(51, 1);

  assert.equal(config.gameName, 'iceandfire');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['resource']);
  assert.equal(config.codeProtocol.targetEntityCode, 'b');
  assert.deepEqual(config.codeProtocol.wallSources, ['immovable']);
  assert.equal(config.codeProtocol.wallItypes, undefined);
});

test('roguelike uses compact resource guidance with enemy avoidance', () => {
  const config = resolveGamePromptConfig(81, 1);

  assert.equal(config.gameName, 'roguelike');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.policyId, 'grid-target');
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.targetSources, ['resource']);
  assert.equal(config.codeProtocol.targetEntityCode, 'r');
  assert.deepEqual(config.codeProtocol.dangerSources, ['npc']);
  assert.equal(config.codeProtocol.dangerRadius, 1);
});
