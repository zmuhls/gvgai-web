const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveGamePromptConfig } = require('../lib/prompt-store');

test('aliens prompt config enables the GV1 code protocol', () => {
  const config = resolveGamePromptConfig(0, 0);

  assert.equal(config.gameName, 'aliens');
  assert.equal(config.codeProtocol.enabled, true);
  assert.equal(config.codeProtocol.id, 'GV1');
  assert.equal(config.codeProtocol.policyId, 'aliens-opening-move');
  assert.deepEqual(config.codeProtocol.movementCodes, ['R', 'L']);
  assert.equal(config.codeProtocol.movementIntervalTicks, 6);
  assert.equal(config.codeProtocol.authoritative, false);
  assert.deepEqual(config.codeProtocol.actionCodes, {
    N: 'ACTION_NIL',
    L: 'ACTION_LEFT',
    R: 'ACTION_RIGHT',
    U: 'ACTION_USE'
  });
  assert.deepEqual(config.codeProtocol.entityCodes, {
    npc: 'a',
    movable: 'b',
    portal: 'p',
    static: 'x'
  });
});

test('selected arcade games resolve non-authoritative code protocols', () => {
  const expectations = [
    [4, 'bait', 'bait-level0'],
    [13, 'butterflies', 'grid-target'],
    [15, 'camelRace', 'fixed-code'],
    [18, 'chase', 'grid-target']
  ];

  for (const [gameId, gameName, policyId] of expectations) {
    const config = resolveGamePromptConfig(gameId, 0);
    assert.equal(config.gameName, gameName);
    assert.equal(config.codeProtocol.enabled, true);
    assert.equal(config.codeProtocol.id, 'GV1');
    assert.equal(config.codeProtocol.policyId, policyId);
    assert.equal(config.codeProtocol.authoritative, false);
  }
});
