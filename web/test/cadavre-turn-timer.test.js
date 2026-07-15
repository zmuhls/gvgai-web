const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALLOWED_DURATIONS,
  CadavreTurnTimerStore
} = require('../lib/cadavre-turn-timer');

const TIMER_ID = '6d496c4e-98ff-4f08-a5b8-5d7f49369111';

function createStore(options = {}) {
  let now = Date.parse('2026-07-15T06:00:00.000Z');
  const store = new CadavreTurnTimerStore({
    now: () => now,
    idFactory: () => TIMER_ID,
    sweepIntervalMs: 0,
    ...options
  });
  return {
    store,
    advance(ms) { now += ms; }
  };
}

test('turn timers accept only the three settings shown in the parlor', () => {
  assert.deepEqual(ALLOWED_DURATIONS, [15, 30, 60]);
  for (const duration of ALLOWED_DURATIONS) {
    const { store } = createStore();
    const timer = store.start(duration);
    assert.equal(timer.durationSeconds, duration);
    assert.equal(timer.remainingMs, duration * 1000);
    assert.equal(timer.expired, false);
    store.close();
  }

  const { store } = createStore();
  assert.throws(() => store.start(45), (error) => error.status === 400);
  store.close();
});

test('the backend clock owns the deadline and expiry state', () => {
  const { store, advance } = createStore();
  const started = store.start(30);
  assert.equal(started.timerId, TIMER_ID);
  assert.equal(started.deadline, '2026-07-15T06:00:30.000Z');

  advance(12500);
  assert.equal(store.status(TIMER_ID).remainingMs, 17500);
  assert.equal(store.status(TIMER_ID).expired, false);

  advance(17500);
  assert.equal(store.status(TIMER_ID).remainingMs, 0);
  assert.equal(store.status(TIMER_ID).expired, true);
  store.close();
});

test('cancelled, invalid, and pruned timers cannot be resumed', () => {
  const { store, advance } = createStore({ retentionMs: 1000 });
  store.start(15);
  assert.equal(store.cancel(TIMER_ID), true);
  assert.equal(store.cancel(TIMER_ID), false);
  assert.throws(() => store.status(TIMER_ID), (error) => error.status === 404);
  assert.throws(() => store.status('not-a-timer'), (error) => error.status === 400);

  store.start(15);
  advance(16001);
  store.prune();
  assert.throws(() => store.status(TIMER_ID), (error) => error.status === 404);
  store.close();
});

test('the store stays bounded under abandoned browser sessions', () => {
  const first = '6d496c4e-98ff-4f08-a5b8-5d7f49369111';
  const second = '5b56ab84-fcc9-4ec8-b3e3-845b2edc292f';
  let nextId = first;
  const { store } = createStore({
    maxTimers: 1,
    idFactory: () => nextId
  });
  store.start(15);
  nextId = second;
  assert.throws(() => store.start(15), (error) => error.status === 503);
  store.close();
});
