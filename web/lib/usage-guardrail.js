// Cost guardrail for remote model providers. Ollama Cloud and OpenRouter share
// hour/day/month buckets so reaching one provider's cap cannot transfer spend
// to the other provider. The state file uses Railway's mounted volume when
// available, which keeps a deployment or restart from resetting the budget.
//
// Env knobs (read per call so they can change without a restart):
//   MODEL_GUARDRAIL_HOURLY   (default 20 remote calls)
//   MODEL_GUARDRAIL_DAILY    (default 30 remote calls)
//   MODEL_GUARDRAIL_MONTHLY  (default 100 remote calls)
//   MODEL_GUARDRAIL_SESSION  (default 20 calls per LLMClient instance)
//   MODEL_GUARDRAIL_CADAVRE_HOURLY (default 5 reserve calls)
//   MODEL_GUARDRAIL_CADAVRE_DAILY  (default 10 reserve calls)
//   MODEL_GUARDRAIL_CADAVRE_MONTHLY (default 25 reserve calls)
//   MODEL_GUARDRAIL_DISABLED=1  emergency override
//   MODEL_GUARDRAIL_STATE    alternate path for the persisted counters
//
// The former OLLAMA_GUARDRAIL_* names remain accepted for compatibility.

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_PATH = path.join(__dirname, '..', 'data', 'usage-guardrail.json');
const DEFAULT_LIMITS = { hourly: 20, daily: 30, monthly: 100, session: 20 };
const DEFAULT_CADAVRE_RESERVE_LIMITS = { hourly: 5, daily: 10, monthly: 25 };
const REMOTE_PROVIDERS = new Set(['ollama-cloud', 'openrouter']);

let state = null;
let persistenceError = null;

function statePath() {
  const configured = process.env.MODEL_GUARDRAIL_STATE || process.env.OLLAMA_GUARDRAIL_STATE;
  if (configured) return configured;
  const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return volumePath
    ? path.join(volumePath, 'model-usage-guardrail.json')
    : DEFAULT_STATE_PATH;
}

function firstConfigured(keys) {
  for (const key of keys) {
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  }
  return undefined;
}

function readLimit(envKeys, fallback) {
  const raw = parseInt(firstConfigured(envKeys), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readReserveLimit(envKeys, fallback) {
  const raw = parseInt(firstConfigured(envKeys), 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function getLimits() {
  return {
    hourly: readLimit(
      ['MODEL_GUARDRAIL_HOURLY', 'OLLAMA_GUARDRAIL_HOURLY'],
      DEFAULT_LIMITS.hourly
    ),
    daily: readLimit(
      ['MODEL_GUARDRAIL_DAILY', 'OLLAMA_GUARDRAIL_DAILY'],
      DEFAULT_LIMITS.daily
    ),
    monthly: readLimit(
      ['MODEL_GUARDRAIL_MONTHLY', 'OLLAMA_GUARDRAIL_MONTHLY'],
      DEFAULT_LIMITS.monthly
    ),
    session: readLimit(
      ['MODEL_GUARDRAIL_SESSION', 'OLLAMA_GUARDRAIL_SESSION'],
      DEFAULT_LIMITS.session
    )
  };
}

function getCadavreReserveLimits() {
  return {
    hourly: readReserveLimit(
      ['MODEL_GUARDRAIL_CADAVRE_HOURLY', 'OLLAMA_GUARDRAIL_CADAVRE_HOURLY'],
      DEFAULT_CADAVRE_RESERVE_LIMITS.hourly
    ),
    daily: readReserveLimit(
      ['MODEL_GUARDRAIL_CADAVRE_DAILY', 'OLLAMA_GUARDRAIL_CADAVRE_DAILY'],
      DEFAULT_CADAVRE_RESERVE_LIMITS.daily
    ),
    monthly: readReserveLimit(
      ['MODEL_GUARDRAIL_CADAVRE_MONTHLY', 'OLLAMA_GUARDRAIL_CADAVRE_MONTHLY'],
      DEFAULT_CADAVRE_RESERVE_LIMITS.monthly
    )
  };
}

function isDisabled() {
  return process.env.MODEL_GUARDRAIL_DISABLED === '1' ||
    process.env.OLLAMA_GUARDRAIL_DISABLED === '1';
}

function loadState() {
  if (!state) {
    try {
      state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch (error) {
      state = {};
      if (error.code !== 'ENOENT') {
        persistenceError = `usage counter state is unreadable: ${error.code || error.message}`;
      }
    }
  }
  return state;
}

function rotate(now) {
  const s = loadState();
  const hour = now.toISOString().slice(0, 13);
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  if (s.hour !== hour) {
    s.hour = hour;
    s.hourCount = 0;
    s.cadavreReserveHourCount = 0;
    s.hourByProvider = {};
  }
  if (s.day !== day) {
    s.day = day;
    s.dayCount = 0;
    s.cadavreReserveDayCount = 0;
    s.dayByProvider = {};
  }
  if (s.month !== month) {
    s.month = month;
    s.monthCount = 0;
    s.cadavreReserveMonthCount = 0;
    s.monthByProvider = {};
  }
  if (!s.hourByProvider || typeof s.hourByProvider !== 'object') s.hourByProvider = {};
  if (!s.dayByProvider || typeof s.dayByProvider !== 'object') s.dayByProvider = {};
  if (!s.monthByProvider || typeof s.monthByProvider !== 'object') s.monthByProvider = {};
  return s;
}

function persistState() {
  const filePath = statePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    persistenceError = null;
    return true;
  } catch (error) {
    persistenceError = `usage counter state cannot be persisted: ${error.code || error.message}`;
    try { fs.unlinkSync(tempPath); } catch { /* no temporary file to remove */ }
    return false;
  }
}

function persistenceBlock() {
  return {
    allowed: false,
    scope: 'persistence',
    reason: persistenceError || 'usage counter persistence is unavailable'
  };
}

function countProvider(s, provider) {
  s.hourByProvider[provider] = (s.hourByProvider[provider] || 0) + 1;
  s.dayByProvider[provider] = (s.dayByProvider[provider] || 0) + 1;
  s.monthByProvider[provider] = (s.monthByProvider[provider] || 0) + 1;
}

// Check the caps and count one remote provider call. `sessionCount` is the
// caller's own tally of remote calls already made this session. Cadavre can use
// a small reserve for foreground requests after general arcade traffic reaches
// the shared cap. Background jobs always pass allowReserve:false.
function admitRemoteCall(provider, sessionCount = 0, now = new Date(), options = {}) {
  if (!REMOTE_PROVIDERS.has(provider)) return { allowed: true, metered: false };
  if (isDisabled()) return { allowed: true };
  const limits = getLimits();
  const s = rotate(now);
  if (persistenceError) return persistenceBlock();
  if (sessionCount >= limits.session) {
    return { allowed: false, scope: 'session', reason: `session cap of ${limits.session} remote model calls reached` };
  }

  const hourlyBlocked = (s.hourCount || 0) >= limits.hourly;
  const dailyBlocked = (s.dayCount || 0) >= limits.daily;
  const monthlyBlocked = (s.monthCount || 0) >= limits.monthly;
  if (hourlyBlocked || dailyBlocked || monthlyBlocked) {
    const canUseCadavreReserve =
      options.consumer === 'cadavre' &&
      options.allowReserve !== false;
    if (canUseCadavreReserve) {
      const reserve = getCadavreReserveLimits();
      const reserveHourlyBlocked =
        (s.cadavreReserveHourCount || 0) >= reserve.hourly;
      const reserveDailyBlocked =
        (s.cadavreReserveDayCount || 0) >= reserve.daily;
      const reserveMonthlyBlocked =
        (s.cadavreReserveMonthCount || 0) >= reserve.monthly;
      if (!reserveHourlyBlocked && !reserveDailyBlocked && !reserveMonthlyBlocked) {
        s.hourCount = (s.hourCount || 0) + 1;
        s.dayCount = (s.dayCount || 0) + 1;
        s.monthCount = (s.monthCount || 0) + 1;
        s.cadavreReserveHourCount = (s.cadavreReserveHourCount || 0) + 1;
        s.cadavreReserveDayCount = (s.cadavreReserveDayCount || 0) + 1;
        s.cadavreReserveMonthCount = (s.cadavreReserveMonthCount || 0) + 1;
        countProvider(s, provider);
        if (!persistState()) return persistenceBlock();
        return { allowed: true, reserve: true };
      }
    }

    if (hourlyBlocked) {
      return { allowed: false, scope: 'hourly', reason: `hourly cap of ${limits.hourly} remote model calls reached` };
    }
    if (dailyBlocked) {
      return { allowed: false, scope: 'daily', reason: `daily cap of ${limits.daily} remote model calls reached` };
    }
    return { allowed: false, scope: 'monthly', reason: `monthly cap of ${limits.monthly} remote model calls reached` };
  }

  s.hourCount = (s.hourCount || 0) + 1;
  s.dayCount = (s.dayCount || 0) + 1;
  s.monthCount = (s.monthCount || 0) + 1;
  countProvider(s, provider);
  if (!persistState()) return persistenceBlock();
  return { allowed: true };
}

function admitOllamaCall(sessionCount = 0, now = new Date(), options = {}) {
  return admitRemoteCall('ollama-cloud', sessionCount, now, options);
}

function getStatus() {
  const limits = getLimits();
  const cadavreReserveLimits = getCadavreReserveLimits();
  if (isDisabled()) {
    return {
      disabled: true,
      limits,
      hourCount: null,
      dayCount: null,
      monthCount: null,
      hour: null,
      day: null,
      month: null,
      cadavreReserve: {
        limits: cadavreReserveLimits,
        hourCount: null,
        dayCount: null,
        monthCount: null
      },
      providers: { hour: null, day: null, month: null },
      persistence: { healthy: null, error: null }
    };
  }
  const s = rotate(new Date());
  return {
    disabled: false,
    limits,
    hourCount: s.hourCount || 0,
    dayCount: s.dayCount || 0,
    monthCount: s.monthCount || 0,
    hour: s.hour || null,
    day: s.day || null,
    month: s.month || null,
    cadavreReserve: {
      limits: cadavreReserveLimits,
      hourCount: s.cadavreReserveHourCount || 0,
      dayCount: s.cadavreReserveDayCount || 0,
      monthCount: s.cadavreReserveMonthCount || 0
    },
    providers: {
      hour: { ...s.hourByProvider },
      day: { ...s.dayByProvider },
      month: { ...s.monthByProvider }
    },
    persistence: {
      healthy: !persistenceError,
      error: persistenceError
    }
  };
}

function resetForTest() {
  state = null;
  persistenceError = null;
}

module.exports = {
  admitRemoteCall,
  admitOllamaCall,
  getLimits,
  getStatus,
  resetForTest,
  _private: { statePath, isDisabled, persistState }
};
