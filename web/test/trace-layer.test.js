const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvgai-trace-layer-'));
  process.env.GVGAI_TRACE_DIR = tempDir;
  // Clear module cache so the trace store picks up the new env var
  delete require.cache[require.resolve('../lib/play-trace-store')];
  delete require.cache[require.resolve('../lib/trace-summary-builder')];
  delete require.cache[require.resolve('../lib/state-converter')];
});

afterEach(() => {
  delete process.env.GVGAI_TRACE_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('buildPrompt includes Play history layer when human traces exist', () => {
  const store = require('../lib/play-trace-store');
  store.saveTrace({
    gameId: 999,
    gameName: 'test-game',
    playerType: 'human',
    finalScore: 100,
    won: true,
    ticks: 300,
    actionHistory: [
      { tick: 0, action: 'ACTION_USE', score: 10, scoreDelta: 10 },
      { tick: 5, action: 'ACTION_LEFT', score: 10, scoreDelta: 0 }
    ],
    scoreEvents: [{ tick: 0, action: 'ACTION_USE', scoreDelta: 10 }]
  });

  const { buildPrompt } = require('../lib/state-converter');
  const sso = {
    gameScore: 0,
    avatarHealthPoints: 100,
    gameTick: 0,
    availableActions: ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    observationGrid: []
  };
  const promptConfig = { gameId: 999, systemContent: 'test system', gameContent: 'test game rules' };
  const result = buildPrompt(sso, promptConfig, null, null);
  assert.ok(result.userMessage.includes('PLAY HISTORY'), 'Expected PLAY HISTORY in prompt text');
  assert.ok(result.promptLayers.some(l => l.name === 'Play history' && l.text), 'Expected Play history layer in promptLayers');
});

test('buildPrompt omits Play history layer when no traces exist', () => {
  const { buildPrompt } = require('../lib/state-converter');
  const sso = {
    gameScore: 0,
    avatarHealthPoints: 100,
    gameTick: 0,
    availableActions: ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    observationGrid: []
  };
  const promptConfig = { gameId: 888, systemContent: 'test system', gameContent: 'test game rules' };
  const result = buildPrompt(sso, promptConfig, null, null);
  assert.ok(!result.userMessage.includes('PLAY HISTORY'), 'Should not have PLAY HISTORY with no traces');
  assert.ok(!result.promptLayers.some(l => l.name === 'Play history' && l.text), 'Should not have Play history layer');
});

test('buildHistoryContext includes explicit reward attribution', () => {
  const { GameStateTracker } = require('../lib/state-converter');
  const tracker = new GameStateTracker();
  tracker.actionHistory = [
    { tick: 10, action: 'ACTION_USE', scoreDelta: 10, healthDelta: 0, positionDelta: '(0, 0)' },
    { tick: 11, action: 'ACTION_LEFT', scoreDelta: 0, healthDelta: -5, positionDelta: '(-1, 0)' },
    { tick: 12, action: 'ACTION_NIL', scoreDelta: 0, healthDelta: 0, positionDelta: '(0, 0)' }
  ];
  const context = tracker.buildHistoryContext();
  assert.ok(context.includes('this action scored'), 'Should attribute scoring actions');
  assert.ok(context.includes('took damage'), 'Should flag damage actions');
  assert.ok(context.includes('no effect'), 'Should flag idle actions');
});

test('buildHistoryContext returns empty string when no history', () => {
  const { GameStateTracker } = require('../lib/state-converter');
  const tracker = new GameStateTracker();
  assert.strictEqual(tracker.buildHistoryContext(), '');
});