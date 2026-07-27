// Light usage guardrail for the Ollama Cloud key. Counts calls in hour/day
// buckets (persisted so restarts don't reset the day) plus a per-session cap
// the caller tracks and passes in. A rule-of-thumb backstop against grossly
// excessive or long-term use patterns, not billing-grade accounting.
//
// Env knobs (read per call so they can change without a restart):
//   OLLAMA_GUARDRAIL_HOURLY   (default 3000 calls)
//   OLLAMA_GUARDRAIL_DAILY    (default 15000 calls)
//   OLLAMA_GUARDRAIL_SESSION  (default 1500 calls per LLMClient instance)
//   OLLAMA_GUARDRAIL_CADAVRE_HOURLY (default 30 reserve calls)
//   OLLAMA_GUARDRAIL_CADAVRE_DAILY  (default 200 reserve calls)
//   OLLAMA_GUARDRAIL_DISABLED=1  kill switch
//   OLLAMA_GUARDRAIL_STATE    alternate path for the persisted counters

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'data', 'usage-guardrail.json');
const DEFAULT_LIMITS = { hourly: 3000, daily: 15000, session: 1500 };
const DEFAULT_CADAVRE_RESERVE_LIMITS = { hourly: 30, daily: 200 };

let state = null;
let persistTimer = null;

function statePath() {
  return process.env.OLLAMA_GUARDRAIL_STATE || DEFAULT_STATE_PATH;
}

function readLimit(envKey, fallback) {
  const raw = parseInt(process.env[envKey], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readReserveLimit(envKey, fallback) {
  const raw = parseInt(process.env[envKey], 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function getLimits() {
  return {
    hourly: readLimit('OLLAMA_GUARDRAIL_HOURLY', DEFAULT_LIMITS.hourly),
    daily: readLimit('OLLAMA_GUARDRAIL_DAILY', DEFAULT_LIMITS.daily),
    session: readLimit('OLLAMA_GUARDRAIL_SESSION', DEFAULT_LIMITS.session)
  };
}

function getCadavreReserveLimits() {
  return {
    hourly: readReserveLimit(
      'OLLAMA_GUARDRAIL_CADAVRE_HOURLY',
      DEFAULT_CADAVRE_RESERVE_LIMITS.hourly
    ),
    daily: readReserveLimit(
      'OLLAMA_GUARDRAIL_CADAVRE_DAILY',
      DEFAULT_CADAVRE_RESERVE_LIMITS.daily
    )
  };
}

function loadState() {
  if (!state) {
    try {
      state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch {
      state = {};
    }
  }
  return state;
}

function rotate(now) {
  const s = loadState();
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  if (s.hour !== hour) {
    s.hour = hour;
    s.hourCount = 0;
    s.cadavreReserveHourCount = 0;
  }
  if (s.day !== day) {
    s.day = day;
    s.dayCount = 0;
    s.cadavreReserveDayCount = 0;
  }
  return s;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.writeFileSync(statePath(), JSON.stringify(state));
    } catch {
      // data dir missing or read-only — counting continues in memory
    }
  }, 2000);
  if (persistTimer.unref) persistTimer.unref();
}

// Check the caps and count one Ollama Cloud call. `sessionCount` is the
// caller's own tally of calls already made this session. Cadavre can opt into a
// small, separately counted reserve after general arcade traffic reaches a
// global cap. This keeps the public game alive without disabling cost bounds.
function admitOllamaCall(sessionCount = 0, now = new Date(), options = {}) {
  if (process.env.OLLAMA_GUARDRAIL_DISABLED === '1') return { allowed: true };
  const limits = getLimits();
  const s = rotate(now);
  if (sessionCount >= limits.session) {
    return { allowed: false, scope: 'session', reason: `session cap of ${limits.session} Ollama Cloud calls reached` };
  }

  const hourlyBlocked = (s.hourCount || 0) >= limits.hourly;
  const dailyBlocked = (s.dayCount || 0) >= limits.daily;
  if (hourlyBlocked || dailyBlocked) {
    const canUseCadavreReserve =
      options.consumer === 'cadavre' &&
      options.allowReserve !== false;
    if (canUseCadavreReserve) {
      const reserve = getCadavreReserveLimits();
      const reserveHourlyBlocked =
        (s.cadavreReserveHourCount || 0) >= reserve.hourly;
      const reserveDailyBlocked =
        (s.cadavreReserveDayCount || 0) >= reserve.daily;
      if (!reserveHourlyBlocked && !reserveDailyBlocked) {
        s.hourCount = (s.hourCount || 0) + 1;
        s.dayCount = (s.dayCount || 0) + 1;
        s.cadavreReserveHourCount = (s.cadavreReserveHourCount || 0) + 1;
        s.cadavreReserveDayCount = (s.cadavreReserveDayCount || 0) + 1;
        schedulePersist();
        return { allowed: true, reserve: true };
      }
    }

    if (hourlyBlocked) {
      return { allowed: false, scope: 'hourly', reason: `hourly cap of ${limits.hourly} Ollama Cloud calls reached` };
    }
    return { allowed: false, scope: 'daily', reason: `daily cap of ${limits.daily} Ollama Cloud calls reached` };
  }

  s.hourCount = (s.hourCount || 0) + 1;
  s.dayCount = (s.dayCount || 0) + 1;
  schedulePersist();
  return { allowed: true };
}

function getStatus() {
  const limits = getLimits();
  const cadavreReserveLimits = getCadavreReserveLimits();
  if (process.env.OLLAMA_GUARDRAIL_DISABLED === '1') {
    return {
      disabled: true,
      limits,
      hourCount: null,
      dayCount: null,
      hour: null,
      day: null,
      cadavreReserve: {
        limits: cadavreReserveLimits,
        hourCount: null,
        dayCount: null
      }
    };
  }
  const s = rotate(new Date());
  return {
    disabled: false,
    limits,
    hourCount: s.hourCount || 0,
    dayCount: s.dayCount || 0,
    hour: s.hour || null,
    day: s.day || null,
    cadavreReserve: {
      limits: cadavreReserveLimits,
      hourCount: s.cadavreReserveHourCount || 0,
      dayCount: s.cadavreReserveDayCount || 0
    }
  };
}

function resetForTest() {
  state = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

module.exports = { admitOllamaCall, getLimits, getStatus, resetForTest };
