const assert = require('node:assert/strict');
const test = require('node:test');

const { GameStateTracker } = require('../lib/state-converter');

// --- detectStagnation -------------------------------------------------------

function recordTicks(tracker, positions, startTick = 0, score = 0) {
  for (let i = 0; i < positions.length; i++) {
    tracker.recordTick({
      gameTick: startTick + i,
      gameScore: score,
      avatarPosition: positions[i]
    });
  }
}

test('detectStagnation returns empty when history is too short', () => {
  const tracker = new GameStateTracker();
  recordTicks(tracker, [[10, 10], [12, 10], [11, 11]], 0);
  assert.equal(tracker.detectStagnation(), '');
});

test('detectStagnation fires when avatar is bounded in a small area with no score change', () => {
  const tracker = new GameStateTracker();
  // Avatar oscillates within a 2-cell pocket over 25 ticks — exactly the
  // killBill failure pattern: non-zero per-tick movement, zero net progress.
  const positions = [];
  for (let i = 0; i < 25; i++) {
    const x = 10 + (i % 3);       // oscillates 10-12
    const y = 20 + Math.floor(i / 10); // creeps 20-22
    positions.push([x, y]);
  }
  recordTicks(tracker, positions, 0, 0);
  const warning = tracker.detectStagnation();
  assert.ok(warning.includes('STAGNANT'), `Expected STAGNANT in: ${warning}`);
  assert.ok(warning.includes('no score change'));
});

test('detectStagnation does not fire when score is changing', () => {
  const tracker = new GameStateTracker();
  const positions = [];
  for (let i = 0; i < 25; i++) {
    positions.push([10 + (i % 3), 20]);
  }
  // Score increases across the window → making progress
  for (let i = 0; i < 25; i++) {
    tracker.recordTick({
      gameTick: i,
      gameScore: i, // score goes 0,1,2,...
      avatarPosition: positions[i]
    });
  }
  assert.equal(tracker.detectStagnation(), '');
});

test('detectStagnation does not fire when avatar is exploring a large area', () => {
  const tracker = new GameStateTracker();
  const positions = [];
  for (let i = 0; i < 25; i++) {
    positions.push([10 + i * 5, 20]); // moves 10 → 130 (span 120)
  }
  recordTicks(tracker, positions, 0, 0);
  assert.equal(tracker.detectStagnation(), '');
});

test('detectStagnation resets stagnantSinceTick when score changes', () => {
  const tracker = new GameStateTracker();
  // First: stagnate
  const stuckPositions = [];
  for (let i = 0; i < 25; i++) stuckPositions.push([10 + (i % 3), 20]);
  recordTicks(tracker, stuckPositions, 0, 0);
  assert.ok(tracker.detectStagnation());
  assert.ok(tracker.stagnantSinceTick !== null);

  // Then: score changes
  tracker.recordTick({ gameTick: 25, gameScore: 10, avatarPosition: [11, 20] });
  // Need enough history to span the score change — add more ticks
  for (let i = 26; i < 45; i++) {
    tracker.recordTick({ gameTick: i, gameScore: 10, avatarPosition: [11 + (i % 3), 20] });
  }
  const warning = tracker.detectStagnation();
  // The window is now 29-44, all at score 10, bounded → stagnant again but
  // stagnantSinceTick was reset by the score change so duration restarts.
  if (warning) {
    // Should report a fresh duration, not the old one
    assert.ok(!warning.includes('45 ticks'), 'should not carry over old duration');
  }
});

// --- dominantSentAction -----------------------------------------------------

test('dominantSentAction returns null when no actions recorded', () => {
  const tracker = new GameStateTracker();
  assert.equal(tracker.dominantSentAction(), null);
});

test('dominantSentAction returns the most frequent action and its fraction', () => {
  const tracker = new GameStateTracker();
  for (let i = 0; i < 10; i++) tracker.recordSentAction('ACTION_RIGHT', i);
  for (let i = 0; i < 3; i++) tracker.recordSentAction('ACTION_DOWN', i + 10);
  for (let i = 0; i < 2; i++) tracker.recordSentAction('ACTION_NIL', i + 13);

  const dominant = tracker.dominantSentAction();
  assert.equal(dominant.action, 'ACTION_RIGHT');
  assert.equal(dominant.count, 10);
  assert.ok(dominant.fraction > 0.6);
});

// --- suggestAlternativeDirection -------------------------------------------

test('suggestAlternativeDirection returns null when no move actions available', () => {
  const tracker = new GameStateTracker();
  const alt = tracker.suggestAlternativeDirection(['ACTION_NIL', 'ACTION_USE']);
  assert.equal(alt, null);
});

test('suggestAlternativeDirection returns null when no dominant action', () => {
  const tracker = new GameStateTracker();
  tracker.recordSentAction('ACTION_RIGHT', 0);
  tracker.recordSentAction('ACTION_DOWN', 1);
  // 50/50 split — no genuine majority, not stuck on one direction
  const alt = tracker.suggestAlternativeDirection(['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT']);
  assert.equal(alt, null);
});

test('suggestAlternativeDirection picks a perpendicular direction when stuck on one axis', () => {
  const tracker = new GameStateTracker();
  // Avatar has been going RIGHT 80% of the time
  for (let i = 0; i < 16; i++) tracker.recordSentAction('ACTION_RIGHT', i);
  for (let i = 0; i < 4; i++) tracker.recordSentAction('ACTION_DOWN', i + 16);

  const available = ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT'];
  const alt = tracker.suggestAlternativeDirection(available);
  assert.ok(alt, 'should return an alternative');
  assert.notEqual(alt, 'ACTION_RIGHT', 'should not be the dominant action');
  assert.notEqual(alt, 'ACTION_LEFT', 'should prefer perpendicular over reverse');
  // Should be UP or DOWN (perpendicular to LEFT-RIGHT axis)
  assert.ok(alt === 'ACTION_UP' || alt === 'ACTION_DOWN', `expected perpendicular, got ${alt}`);
});

test('suggestAlternativeDirection falls back to reverse if only reverse is available', () => {
  const tracker = new GameStateTracker();
  for (let i = 0; i < 10; i++) tracker.recordSentAction('ACTION_RIGHT', i);

  // Only RIGHT and LEFT available (a corridor game)
  const alt = tracker.suggestAlternativeDirection(['ACTION_LEFT', 'ACTION_RIGHT']);
  assert.equal(alt, 'ACTION_LEFT');
});

// --- resolveLoopBreaker (LLMClient) ----------------------------------------

const LLMClient = require('../lib/llm-client');

test('resolveLoopBreaker returns fallback when not stagnant', () => {
  const client = new LLMClient();
  client.promptConfig = { gameName: 'test' };
  client.lastSso = { gameTick: 0, availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT'] };

  // No state history → not stagnant
  assert.equal(client.resolveLoopBreaker('ACTION_RIGHT'), 'ACTION_RIGHT');
});

test('resolveLoopBreaker forces a direction change when stagnant', () => {
  const client = new LLMClient();
  client.promptConfig = { gameName: 'test' };
  client.lastSso = {
    gameTick: 30,
    gameScore: 0,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT']
  };

  // Simulate 30 ticks of RIGHT in a small area
  for (let i = 0; i < 30; i++) {
    client.stateTracker.recordTick({
      gameTick: i,
      gameScore: 0,
      avatarPosition: [10 + (i % 3), 20]
    });
    client.stateTracker.recordSentAction('ACTION_RIGHT', i);
  }
  client.lastLoopBreakTick = -100; // ensure interval has elapsed

  const breaker = client.resolveLoopBreaker('ACTION_RIGHT');
  assert.notEqual(breaker, 'ACTION_RIGHT', 'breaker should not return the same action');
  assert.ok(['ACTION_UP', 'ACTION_DOWN'].includes(breaker), `expected perpendicular, got ${breaker}`);
});

test('resolveLoopBreaker respects the break interval', () => {
  const client = new LLMClient();
  client.promptConfig = { gameName: 'test' };
  client.lastSso = {
    gameTick: 30,
    gameScore: 0,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT']
  };

  // Simulate stagnation
  for (let i = 0; i < 30; i++) {
    client.stateTracker.recordTick({
      gameTick: i,
      gameScore: 0,
      avatarPosition: [10 + (i % 3), 20]
    });
    client.stateTracker.recordSentAction('ACTION_RIGHT', i);
  }

  // First break fires
  client.lastLoopBreakTick = -100;
  const firstBreak = client.resolveLoopBreaker('ACTION_RIGHT');
  assert.notEqual(firstBreak, 'ACTION_RIGHT');

  // Second call within the interval → no break
  const secondCall = client.resolveLoopBreaker('ACTION_RIGHT');
  assert.equal(secondCall, 'ACTION_RIGHT', 'should not break again within the interval');
});

test('resolveLoopBreaker is disabled for code-protocol games', () => {
  const client = new LLMClient();
  client.promptConfig = {
    gameName: 'test',
    codeProtocol: { enabled: true }
  };
  client.lastSso = {
    gameTick: 30,
    gameScore: 0,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT']
  };

  // Simulate stagnation
  for (let i = 0; i < 30; i++) {
    client.stateTracker.recordTick({
      gameTick: i,
      gameScore: 0,
      avatarPosition: [10 + (i % 3), 20]
    });
    client.stateTracker.recordSentAction('ACTION_RIGHT', i);
  }
  client.lastLoopBreakTick = -100;

  // Code protocol → breaker disabled
  assert.equal(client.resolveLoopBreaker('ACTION_RIGHT'), 'ACTION_RIGHT');
});

// --- dequeuePlanAction integration with loop breaker -----------------------

function actPayload(overrides = {}) {
  return JSON.stringify({
    phase: 'ACT',
    gameTick: 1,
    gameScore: 0,
    avatarHealthPoints: 100,
    gameWinner: 'NO_WINNER',
    availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_UP', 'ACTION_DOWN'],
    ...overrides
  });
}

const nextTickDrain = () => new Promise(resolve => setImmediate(resolve));

test('dequeuePlanAction breaks out of a stagnant loop', async () => {
  const client = new LLMClient();
  client.promptConfig = { gameName: 'test', macroActions: { enabled: false } };
  client.startAsyncLLMCall = () => {};
  client.llmCallInProgress = true;
  client.sendMessageWithId = () => {};
  client.pendingLLMAction = 'ACTION_RIGHT';

  // Feed 30 stagnant ticks
  for (let i = 0; i < 30; i++) {
    client.lastSso = {
      gameTick: i,
      gameScore: 0,
      avatarPosition: [10 + (i % 3), 20],
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_UP', 'ACTION_DOWN']
    };
    client.stateTracker.recordTick(client.lastSso);
    client.stateTracker.recordSentAction('ACTION_RIGHT', i);
  }
  client.lastLoopBreakTick = -100;

  // The next dequeue should break the loop
  const action = client.dequeuePlanAction();
  assert.notEqual(action, 'ACTION_RIGHT', 'breaker should override the stagnant RIGHT');
  assert.ok(['ACTION_UP', 'ACTION_DOWN'].includes(action), `expected perpendicular, got ${action}`);
});

// --- buildPrompt includes stagnation warning -------------------------------

test('buildPrompt includes stagnation warning when tracker detects stagnation', () => {
  const { buildPrompt } = require('../lib/state-converter');
  const tracker = new GameStateTracker();

  // Simulate stagnation
  for (let i = 0; i < 25; i++) {
    tracker.recordTick({
      gameTick: i,
      gameScore: 0,
      avatarPosition: [10 + (i % 3), 20]
    });
  }

  const sso = {
    gameScore: 0,
    avatarHealthPoints: 100,
    gameTick: 25,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT'],
    avatarPosition: [11, 20],
    observationGrid: []
  };

  const prompt = buildPrompt(sso, {
    systemContent: 'test system',
    gameContent: 'test rules',
    levelContent: ''
  }, tracker, null);

  assert.ok(prompt.userMessage.includes('STAGNANT'), 'prompt should contain STAGNANT warning');
});

test('buildPrompt does not include stagnation warning when not stagnant', () => {
  const { buildPrompt } = require('../lib/state-converter');
  const tracker = new GameStateTracker();

  // Avatar is exploring a large area
  for (let i = 0; i < 25; i++) {
    tracker.recordTick({
      gameTick: i,
      gameScore: i, // score changing
      avatarPosition: [10 + i * 5, 20]
    });
  }

  const sso = {
    gameScore: 25,
    avatarHealthPoints: 100,
    gameTick: 25,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT'],
    avatarPosition: [135, 20],
    observationGrid: []
  };

  const prompt = buildPrompt(sso, {
    systemContent: 'test system',
    gameContent: 'test rules',
    levelContent: ''
  }, tracker, null);

  assert.ok(!prompt.userMessage.includes('STAGNANT'), 'prompt should not contain STAGNANT warning');
});