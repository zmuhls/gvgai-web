// Pace real engine frames across model waits. Human controls remain immediate.
// No interpolated images, invented actions, or unbounded playback backlog.
(function(root) {
  class FramePacer {
    constructor() { this.reset(); }

    reset(enabled = true) {
      this.enabled = enabled;
      this.queue = [];
      this.intervalMs = 33;
      this.lastDrawAt = null;
      this.lastDecision = null;
      this.dropped = 0;
      this.received = 0;
    }

    observeDecision(tick, now, elapsedMs, planningMs, maxTicks) {
      if (!this.enabled || !Number.isFinite(tick)) return;
      let interval = (Math.max(0, elapsedMs || 0) + Math.max(0, planningMs || 0)) /
        Math.max(1, maxTicks || 1) + 25;
      if (this.lastDecision && tick > this.lastDecision.tick) {
        const ticks = tick - this.lastDecision.tick;
        const frames = this.received - this.lastDecision.received;
        interval = (now - this.lastDecision.at) / (frames > 0 ? Math.min(ticks,frames) : ticks);
        interval = this.intervalMs * 0.5 + interval * 0.5;
      }
      this.intervalMs = Math.max(33, Math.min(350, interval));
      this.lastDecision = {tick, at:now, received:this.received};
    }

    push(frame, now) {
      this.received++;
      if (!this.enabled) {
        this.dropped += this.queue.length;
        this.queue = [];
      }
      this.queue.push({frame, at:now});
      this.trim(now);
    }

    trim(now) {
      while (this.queue.length > 1 &&
          (this.queue.length > 12 || now - this.queue[0].at > 1200)) {
        this.queue.shift();
        this.dropped++;
      }
    }

    delay(now) {
      if (!this.queue.length || !this.enabled || this.lastDrawAt === null) return 0;
      // Bound added viewing delay even if a game slows down or the tab was hidden.
      return Math.max(0, Math.min(this.lastDrawAt + this.intervalMs,
        this.queue[0].at + 1200) - now);
    }

    take(now) {
      this.trim(now);
      if (this.delay(now) > 0) return null;
      return this.queue.shift()?.frame || null;
    }

    finish() {
      this.enabled = false;
      this.dropped += Math.max(0, this.queue.length - 1);
      this.queue = this.queue.slice(-1);
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = FramePacer;
  else root.FramePacer = FramePacer;
})(typeof globalThis === 'object' ? globalThis : this);
