const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getClassDefaults,
  applyClassDefaults,
  loadClassDefaults,
  clearClassDefaultsCache
} = require('../lib/class-defaults');
const promptStore = require('../lib/prompt-store');

function classification(archetype, pace = 'deliberate', overrides = {}) {
  return { classifierVersion: 1, archetype, pace, subtypes: [], inputs: {}, ...overrides };
}

function withEnv(key, value, fn) {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test('class defaults load and expose macro settings for pusher-puzzle', () => {
  clearClassDefaultsCache();
  const defaults = loadClassDefaults();
  assert.ok(defaults.archetypes['pusher-puzzle'].macroActions.enabled);

  const merged = getClassDefaults('pusher-puzzle', 'deliberate');
  assert.equal(merged.macroActions.enabled, true);
  assert.ok(merged.llmSettings.maxTokens >= 320);
});

test('pace overlay disables macro for twitch, archetype entry wins over overlay', () => {
  const twitchNavigator = getClassDefaults('navigator', 'twitch');
  assert.equal(twitchNavigator.macroActions?.enabled, false);

  // pusher-puzzle's own macroActions entry outranks the twitch overlay
  const twitchPusher = getClassDefaults('pusher-puzzle', 'twitch');
  assert.equal(twitchPusher.macroActions.enabled, true);
});

test('class defaults enable macro for a config without explicit macroActions', () => {
  const effective = applyClassDefaults(
    { llmSettings: { maxTokens: 100, temperature: 0.8 } },
    classification('pusher-puzzle')
  );
  assert.equal(effective.macroActions.enabled, true);
  // macro floor: boilerplate maxTokens 100 is raised so the PLAN fits
  assert.equal(effective.llmSettings.maxTokens, 320);
  assert.equal(effective.llmSettings.temperature, 0.8);
});

test('explicit per-game config beats class defaults, including enabled:false', () => {
  const effective = applyClassDefaults(
    {
      macroActions: { enabled: false },
      llmSettings: { maxTokens: 100 }
    },
    classification('pusher-puzzle')
  );
  assert.equal(effective.macroActions.enabled, false);
  assert.equal(effective.llmSettings.maxTokens, 100);
});

test('explicit macro config keeps its tuned fields and fills gaps from class defaults', () => {
  const effective = applyClassDefaults(
    { macroActions: { enabled: true, ticksPerStep: 3, exhaustAction: 'wait' } },
    classification('pusher-puzzle')
  );
  assert.equal(effective.macroActions.ticksPerStep, 3);
  assert.equal(effective.macroActions.exhaustAction, 'wait');
  assert.equal(effective.macroActions.maxSteps, 4);
});

test('archetypeOverride pins the archetype used for defaults', () => {
  const effective = applyClassDefaults(
    {},
    classification('navigator', 'deliberate', { archetypeOverride: 'collector' })
  );
  assert.equal(effective.macroActions.enabled, true);
});

test('codeProtocol games never inherit macro defaults', () => {
  const effective = applyClassDefaults(
    { codeProtocol: { enabled: true }, llmSettings: { maxTokens: 8 } },
    classification('pusher-puzzle')
  );
  assert.equal(effective.macroActions, null);
  assert.equal(effective.llmSettings.maxTokens, 8);
});

test('CLASS_DEFAULTS_DISABLED=1 returns only explicit config settings', () => {
  withEnv('CLASS_DEFAULTS_DISABLED', '1', () => {
    const effective = applyClassDefaults(
      { llmSettings: { maxTokens: 100 } },
      classification('pusher-puzzle')
    );
    assert.equal(effective.macroActions, null);
    assert.equal(effective.llmSettings.maxTokens, 100);
  });
});

test('resolveGamePromptConfig applies class defaults beneath explicit config', () => {
  promptStore.invalidateCache();

  // doorkoban (32): explicit macro config — tuned fields survive
  const doorkoban = promptStore.resolveGamePromptConfig(32, 0);
  assert.equal(doorkoban.classification.archetype, 'pusher-puzzle');
  assert.equal(doorkoban.macroActions.enabled, true);
  assert.equal(doorkoban.macroActions.ticksPerStep, 3);
  assert.equal(doorkoban.llmSettings.maxTokens, 320);

  // aliens (0): shooter-lane, no macro defaults; explicit settings untouched
  const aliens = promptStore.resolveGamePromptConfig(0, 0);
  assert.equal(aliens.classification.archetype, 'shooter-lane');
  assert.equal(aliens.macroActions, null);
  assert.equal(aliens.llmSettings.maxTokens, 8);

  withEnv('CLASS_DEFAULTS_DISABLED', '1', () => {
    promptStore.invalidateCache();
    const pinned = promptStore.resolveGamePromptConfig(32, 0);
    assert.equal(pinned.macroActions.enabled, true);
    assert.equal(pinned.macroActions.maxSteps, 4);
  });
  promptStore.invalidateCache();
});
