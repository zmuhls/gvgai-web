const assert = require('node:assert/strict');
const test = require('node:test');

const { AttractCoordinator } = require('../lib/attract-coordinator');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeCase(id) {
  return {
    runId: `run-${id}`,
    gameId: id,
    gameName: `game${id}`,
    levelId: 0,
    modelId: `model${id}`,
    modelName: `Model ${id}`,
    provider: 'ollama-cloud',
    strategyId: 'safe',
    strategyLabel: 'Play it safe',
    strategy: 'Play it safe.'
  };
}

function makeIo() {
  const events = [];
  return {
    events,
    emit: (event, payload) => events.push({ event, payload }),
    typesOf: (name) => events.filter(e => e.event === name).map(e => e.payload)
  };
}

function makeTelemetry() {
  const tracked = [];
  return { tracked, track: (e) => tracked.push(e) };
}

// A runEvalCase fake that completes on its own after `ms`, but also resolves early
// if its client is disconnected (mirroring the real interrupt path).
function autoRunner(result, ms) {
  const calls = [];
  const fn = (evalCase, options) => {
    calls.push({ evalCase, options });
    return new Promise((resolve) => {
      const handle = {
        processId: `proc-${evalCase.runId}`,
        llmClient: { disconnect: () => resolve({ ...result, aborted: true }) }
      };
      setImmediate(() => {
        if (options.onCaseStart) options.onCaseStart(handle);
        setTimeout(() => resolve(result), ms);
      });
    });
  };
  return { fn, calls };
}

// A runEvalCase fake that stays open until its client is disconnected.
function holdOpenRunner(result) {
  const calls = [];
  const disconnects = [];
  const fn = (evalCase, options) => {
    calls.push({ evalCase, options });
    return new Promise((resolve) => {
      const handle = {
        processId: `proc-${evalCase.runId}`,
        llmClient: { disconnect: () => { disconnects.push(evalCase.runId); resolve(result); } }
      };
      setImmediate(() => { if (options.onCaseStart) options.onCaseStart(handle); });
    });
  };
  return { fn, calls, disconnects };
}

test('start(): plays the playlist, advances the cursor, records telemetry', async () => {
  const io = makeIo();
  const telemetry = makeTelemetry();
  const runner = autoRunner({ finalScore: 2, winner: 'NO_WINNER', won: false, ticks: 5, decisions: 5, adherence: { label: 'x' } }, 8);
  const coord = new AttractCoordinator();
  coord.configure({
    io,
    streamer: { start() {}, stop() {} },
    isWalkupActive: () => false,
    gameManager: { stopGameAndWait: () => Promise.resolve(true) },
    telemetry,
    buildArcadeEvalPlan: () => ({ cases: [makeCase(0), makeCase(1)] }),
    runEvalCase: runner.fn
  });

  coord.start();
  await wait(60);
  coord.stop();
  await wait(20);

  const completed = io.typesOf('case-completed');
  assert.ok(completed.length >= 2, `expected multiple completed cases, got ${completed.length}`);
  assert.ok(completed.some(c => c.endedBy === 'summary'), 'a case should complete normally');
  assert.equal(runner.calls[0].options.initResponseType, 'BOTH');
  assert.equal(runner.calls[0].options.actResponseType, 'BOTH');
  assert.ok(telemetry.tracked.some(e => e.eventType === 'marble_case_completed'), 'completed cases record telemetry');
  assert.ok(coord.loopCount >= 1 || runner.calls.length >= 2, 'cursor should advance through the playlist');
  assert.equal(coord.mode, 'IDLE');
});

test('beginWalkup(): interrupts the current case, yields, and does not advance', async () => {
  const io = makeIo();
  const telemetry = makeTelemetry();
  const runner = holdOpenRunner({ finalScore: 0, winner: 'NO_WINNER', won: false, ticks: 3, decisions: 3, adherence: { label: 'x' } });
  const coord = new AttractCoordinator();
  coord.configure({
    io,
    streamer: { start() {}, stop() {} },
    isWalkupActive: () => false,
    gameManager: { stopGameAndWait: () => Promise.resolve(true) },
    telemetry,
    buildArcadeEvalPlan: () => ({ cases: [makeCase(0), makeCase(1)] }),
    runEvalCase: runner.fn,
    resumeDebounceMs: 10
  });

  coord.start();
  await wait(30);
  assert.equal(coord.mode, 'MARBLE_PLAYING');
  assert.equal(coord.cursor, 0);
  assert.equal(coord.currentCase.runId, 'run-0');

  await coord.beginWalkup();
  assert.equal(coord.mode, 'WALKUP_PLAYING');
  assert.equal(coord.walkupActive, true);
  assert.equal(coord.cursor, 0, 'a yielded case must not advance the cursor');
  assert.ok(runner.disconnects.includes('run-0'), 'the live case client was disconnected');

  const completed = io.typesOf('case-completed');
  assert.ok(completed.some(c => c.endedBy === 'yield'), 'the interrupted case reports endedBy=yield');
  assert.ok(!telemetry.tracked.some(e => e.eventType === 'marble_case_completed'),
    'a yielded case must NOT pollute eval telemetry');

  // Resume: the same case replays (cursor still 0).
  coord.endWalkup();
  await wait(40);
  assert.equal(coord.walkupActive, false);
  assert.equal(coord.mode, 'MARBLE_PLAYING');
  assert.ok(runner.calls.length >= 2, 'the yielded case replays after resume');
  assert.equal(coord.cursor, 0);

  coord.stop();
  await wait(20);
});

test('stop(): tears down and returns to IDLE', async () => {
  const io = makeIo();
  const runner = holdOpenRunner({ finalScore: 0, winner: 'NO_WINNER', won: false, ticks: 1, decisions: 1, adherence: { label: 'x' } });
  const coord = new AttractCoordinator();
  coord.configure({
    io,
    streamer: { start() {}, stop() {} },
    isWalkupActive: () => false,
    gameManager: { stopGameAndWait: () => Promise.resolve(true) },
    buildArcadeEvalPlan: () => ({ cases: [makeCase(0)] }),
    runEvalCase: runner.fn
  });

  coord.start();
  await wait(30);
  assert.equal(coord.enabled, true);
  coord.stop();
  await wait(20);
  assert.equal(coord.enabled, false);
  assert.equal(coord.mode, 'IDLE');
});

test('addFinetunedModel(): adds tuned model and game to the marble playlist once', () => {
  const io = makeIo();
  const coord = new AttractCoordinator();
  const buildCalls = [];
  const buildPlan = (options = {}) => {
    buildCalls.push(options);
    const models = options.models || [
      { id: 'base', name: 'Base', provider: 'ollama-cloud', fallback: null }
    ];
    const gameIds = options.gameIds || [0];
    return {
      models,
      gameIds,
      cases: gameIds.flatMap(gameId => models.map(model => ({
        ...makeCase(gameId),
        runId: `run-${gameId}-${model.id}`,
        modelId: model.id,
        modelName: model.name,
        provider: model.provider
      })))
    };
  };

  coord.configure({
    io,
    buildArcadeEvalPlan: buildPlan,
    runEvalCase: () => Promise.resolve({})
  });
  coord.cases = coord._buildCases();
  assert.equal(coord.cases.length, 1);

  const first = coord.addFinetunedModel({
    modelId: 'gvgai-aliens-ft-1',
    gameId: 4,
    gameName: 'bait'
  });
  assert.equal(first.added, true);
  assert.deepEqual(coord.planOptions.gameIds, [0, 4]);
  assert.deepEqual(coord.planOptions.models.map(model => model.id), ['base', 'gvgai-aliens-ft-1']);
  assert.equal(coord.cases.length, 4);
  assert.ok(io.events.some(e => e.event === 'marble-run-playlist-updated' && e.payload.added === true));

  const second = coord.addFinetunedModel({
    modelId: 'gvgai-aliens-ft-1',
    gameId: 4,
    gameName: 'bait'
  });
  assert.equal(second.added, false);
  assert.deepEqual(coord.planOptions.models.map(model => model.id), ['base', 'gvgai-aliens-ft-1']);
  assert.equal(coord.cases.length, 4);
  assert.ok(buildCalls.length >= 3);
});

test('stops the loop after repeated case failures (engine-unavailable backstop)', async () => {
  const io = makeIo();
  let calls = 0;
  const coord = new AttractCoordinator();
  coord.configure({
    io,
    streamer: { start() {}, stop() {} },
    isWalkupActive: () => false,
    gameManager: { stopGameAndWait: () => Promise.resolve(true) },
    buildArcadeEvalPlan: () => ({ cases: [makeCase(0), makeCase(1), makeCase(2)] }),
    runEvalCase: () => { calls += 1; return Promise.reject(new Error('no java')); },
    maxConsecutiveErrors: 2,
    errorBackoffMs: 5
  });

  coord.start();
  await wait(80);
  assert.equal(coord.enabled, false, 'loop disables itself after repeated failures');
  assert.equal(coord.mode, 'IDLE');
  assert.equal(calls, 2, 'stops exactly at maxConsecutiveErrors');
});
