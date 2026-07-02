const fs = require('fs');
const path = require('path');

const CLASS_DEFAULTS_PATH = path.join(__dirname, '..', 'data', 'class-defaults.json');
const CACHE_TTL_MS = 30000;

let _cache = null;

function clearClassDefaultsCache() {
  _cache = null;
}

function loadClassDefaults() {
  if (_cache && (Date.now() - _cache.loadedAt) < CACHE_TTL_MS) return _cache.data;
  let data = { archetypes: {}, paceOverlays: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(CLASS_DEFAULTS_PATH, 'utf-8'));
    data = {
      archetypes: raw.archetypes || {},
      paceOverlays: raw.paceOverlays || {}
    };
  } catch { /* missing/invalid file degrades to no defaults */ }
  _cache = { data, loadedAt: Date.now() };
  return data;
}

// Archetype entry wins over pace overlay, per-key one level deep (macroActions,
// llmSettings, eval, memoryGate are flat objects).
function mergeDefaults(base = {}, override = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function getClassDefaults(archetype, pace) {
  const { archetypes, paceOverlays } = loadClassDefaults();
  const paceOverlay = (pace && paceOverlays[pace]) || {};
  const archetypeEntry = (archetype && archetypes[archetype]) || {};
  return mergeDefaults(paceOverlay, archetypeEntry);
}

function classDefaultsDisabled() {
  return process.env.CLASS_DEFAULTS_DISABLED === '1';
}

// The PLAN closing contract needs response headroom; below this the model's
// plan gets truncated mid-list and the run degenerates into ACTION_NIL loops.
const MACRO_MAX_TOKENS_FLOOR = 320;

// Apply class-derived defaults beneath a game config's explicit settings.
// Precedence (most binding first): env kill switch > explicit per-game config
// keys > archetypeOverride pin > archetype entry > pace overlay > code
// constants (the callers' own fallbacks). Returns effective settings only —
// never mutates the config.
function applyClassDefaults(config = {}, classification = null) {
  const explicit = {
    macroActions: config.macroActions || null,
    llmSettings: config.llmSettings || null
  };
  if (classDefaultsDisabled() || !classification) return explicit;

  const archetype = classification.archetypeOverride || classification.archetype;
  const defaults = getClassDefaults(archetype, classification.pace);

  // Code-protocol games are driven by a scripted per-tick policy; the macro
  // executor already skips them, so don't let class defaults claim otherwise.
  const codeProtocolActive = Boolean(config.codeProtocol?.enabled);
  const macroDefaults = codeProtocolActive ? null : defaults.macroActions || null;

  const macroActions = explicit.macroActions
    ? { ...(macroDefaults || {}), ...explicit.macroActions }
    : macroDefaults;
  let llmSettings = explicit.llmSettings
    ? { ...(defaults.llmSettings || {}), ...explicit.llmSettings }
    : defaults.llmSettings || null;

  if (macroActions?.enabled && (llmSettings?.maxTokens ?? 0) < MACRO_MAX_TOKENS_FLOOR) {
    llmSettings = { ...(llmSettings || {}), maxTokens: MACRO_MAX_TOKENS_FLOOR };
  }

  return { macroActions, llmSettings };
}

module.exports = {
  CLASS_DEFAULTS_PATH,
  loadClassDefaults,
  getClassDefaults,
  applyClassDefaults,
  classDefaultsDisabled,
  clearClassDefaultsCache
};
