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
    [13, 'butterflies', 'grid-target'],
    [15, 'camelRace', 'fixed-code'],
    [18, 'chase', 'grid-target']
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
