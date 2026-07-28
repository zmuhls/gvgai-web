const assert = require('node:assert/strict');
const test = require('node:test');

const coordinator = require('../lib/attract-coordinator');
const { _private } = require('../server');

test.afterEach(() => {
  _private.activeGames.clear();
  _private.modelStartWindows.clear();
  _private.releaseGameStartLock();
});

test('background inference settings require exact opt-ins', () => {
  assert.deepEqual(_private.backgroundInferenceSettings({}), {
    cadavreWarmer: false,
    marbleAutostart: false
  });
  assert.deepEqual(_private.backgroundInferenceSettings({
    CADAVRE_MODEL_WARMER_ENABLED: 'TRUE',
    MARBLE_RUN_ENABLED: 'true',
    MARBLE_RUN_AUTOSTART: '1'
  }), {
    cadavreWarmer: false,
    marbleAutostart: false
  });
  assert.deepEqual(_private.backgroundInferenceSettings({
    CADAVRE_MODEL_WARMER_ENABLED: 'true',
    MARBLE_RUN_ENABLED: 'true',
    MARBLE_RUN_AUTOSTART: 'true'
  }), {
    cadavreWarmer: true,
    marbleAutostart: true
  });
});

test('the game-start lock admits one start at a time', () => {
  assert.equal(_private.acquireGameStartLock(), true);
  assert.equal(_private.acquireGameStartLock(), false);
  _private.releaseGameStartLock();
  assert.equal(_private.acquireGameStartLock(), true);
});

test('the model-start window is conservative and prunes expired peers', () => {
  const previous = process.env.MODEL_GAME_STARTS_PER_MINUTE;
  process.env.MODEL_GAME_STARTS_PER_MINUTE = '2';
  const request = { socket: { remoteAddress: 'railway-proxy' } };
  try {
    assert.equal(_private.admitModelStart(request, 1000), true);
    assert.equal(_private.admitModelStart(request, 2000), true);
    assert.equal(_private.admitModelStart(request, 3000), false);
    assert.equal(_private.admitModelStart(request, 62001), true);
    assert.equal(_private.modelStartWindows.size, 1);
  } finally {
    if (previous === undefined) delete process.env.MODEL_GAME_STARTS_PER_MINUTE;
    else process.env.MODEL_GAME_STARTS_PER_MINUTE = previous;
  }
});

test('replacement cleanup leaves the marble run yielded until the new game owns the port', () => {
  const originalEndWalkup = coordinator.endWalkup;
  let resumeCalls = 0;
  let disconnectCalls = 0;
  let stopCalls = 0;
  coordinator.endWalkup = () => { resumeCalls += 1; };
  const deadlineTimer = setTimeout(() => {}, 60 * 1000);
  deadlineTimer.unref?.();
  _private.activeGames.set('process-1', {
    client: { disconnect: () => { disconnectCalls += 1; } },
    manager: { stopGame: () => { stopCalls += 1; } },
    deadlineTimer
  });

  try {
    const cleaned = _private.finishActiveGame('process-1', {
      disconnectClient: true,
      resumeMarble: false,
      stopProcess: false
    });
    assert.ok(cleaned);
    assert.equal(_private.activeGames.has('process-1'), false);
    assert.equal(disconnectCalls, 1);
    assert.equal(stopCalls, 0);
    assert.equal(resumeCalls, 0);
  } finally {
    clearTimeout(deadlineTimer);
    coordinator.endWalkup = originalEndWalkup;
  }
});
