const crypto = require('node:crypto');

const ALLOWED_DURATIONS = Object.freeze([15, 30, 60]);
const ALLOWED_DURATION_SET = new Set(ALLOWED_DURATIONS);
const TIMER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TurnTimerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TurnTimerError';
    this.status = status;
  }
}

class CadavreTurnTimerStore {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.retentionMs = options.retentionMs ?? 60000;
    this.maxTimers = options.maxTimers ?? 5000;
    this.timers = new Map();

    const sweepIntervalMs = options.sweepIntervalMs ?? 30000;
    this.sweepTimer = sweepIntervalMs > 0
      ? setInterval(() => this.prune(), sweepIntervalMs)
      : null;
    this.sweepTimer?.unref?.();
  }

  validateId(id) {
    const timerId = String(id || '');
    if (!TIMER_ID_PATTERN.test(timerId)) {
      throw new TurnTimerError(400, 'Timer id is invalid.');
    }
    return timerId;
  }

  prune(now = this.now()) {
    for (const [timerId, timer] of this.timers) {
      if (now >= timer.deadlineMs + this.retentionMs) this.timers.delete(timerId);
    }
  }

  snapshot(timer, now = this.now()) {
    const remainingMs = Math.max(0, timer.deadlineMs - now);
    return {
      timerId: timer.id,
      durationSeconds: timer.durationSeconds,
      startedAt: new Date(timer.startedAtMs).toISOString(),
      deadline: new Date(timer.deadlineMs).toISOString(),
      serverNow: new Date(now).toISOString(),
      remainingMs,
      expired: remainingMs === 0
    };
  }

  start(durationSeconds) {
    const duration = Number(durationSeconds);
    if (!ALLOWED_DURATION_SET.has(duration)) {
      throw new TurnTimerError(400, 'Turn timer must be 15, 30, or 60 seconds.');
    }

    const now = this.now();
    this.prune(now);
    if (this.timers.size >= this.maxTimers) {
      throw new TurnTimerError(503, 'Turn timer service is at capacity.');
    }

    const timer = {
      id: this.validateId(this.idFactory()),
      durationSeconds: duration,
      startedAtMs: now,
      deadlineMs: now + duration * 1000
    };
    this.timers.set(timer.id, timer);
    return this.snapshot(timer, now);
  }

  status(id) {
    const timerId = this.validateId(id);
    const timer = this.timers.get(timerId);
    if (!timer) throw new TurnTimerError(404, 'Turn timer is unavailable.');
    return this.snapshot(timer);
  }

  cancel(id) {
    const timerId = this.validateId(id);
    return this.timers.delete(timerId);
  }

  reset() {
    this.timers.clear();
  }

  close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.reset();
  }
}

module.exports = {
  ALLOWED_DURATIONS,
  CadavreTurnTimerStore,
  TurnTimerError
};
