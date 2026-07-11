// GVGAI LLM Frontend - Main Application

const socket = window.arcadeSocket || (typeof io === 'function' ? io() : null);
if (socket) window.arcadeSocket = socket;

// Application state
const state = {
  games: [],
  models: [],
  selectedGame: null,
  selectedModel: null,
  selectedLevel: 0,
  processId: null,
  runId: null,
  showingAllGames: false,
  lastSummary: null,
  traceLog: [],
  traceStartedAt: null,
  featuredShowcase: null,
  liveGameState: { tick: 0, score: 0, health: 0 }
};

// Player type: 'llm' (model plays) or 'human' (keyboard play)
let playerType = 'llm';

// Track currently held keys to suppress key-repeat during human play
const heldKeys = new Set();

// Map KeyboardEvent.code → GVGAI action constant
const KEY_ACTION_MAP = {
  ArrowLeft:  'ACTION_LEFT',
  ArrowRight: 'ACTION_RIGHT',
  ArrowUp:    'ACTION_UP',
  ArrowDown:  'ACTION_DOWN',
  Space:      'ACTION_USE',
  KeyA:       'ACTION_LEFT',
  KeyD:       'ACTION_RIGHT',
  KeyW:       'ACTION_UP',
  KeyS:       'ACTION_DOWN'
};

// Keys whose default browser behaviour (scroll, page-nav) we suppress during play
const PREVENT_DEFAULT_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'
]);

// Named keyboard handler refs so we can remove them on cleanup
let humanKeydownHandler = null;
let humanKeyupHandler = null;

// Preset strategy cards — tap to pre-fill the editable text box. Each preset
// lists the game archetypes (from /api/games) it suits best; on game select
// the cards re-rank so affine presets come first (never hidden).
const STRATEGY_PRESETS = [
  { label: 'Survive first', text: 'Play defensively. Keep distance from enemies, avoid danger, and prioritize staying alive over scoring.', archetypes: ['survivor', 'reflex-pilot', 'navigator'] },
  { label: 'Score test', text: 'Pursue points. Collect resources and take measured risks when a clear scoring route appears.', archetypes: ['collector', 'shooter-lane'] },
  { label: 'Threat test', text: 'Seek out enemies when the path is clear. Attack threats and retreat when health or position gets worse.', archetypes: ['shooter-roaming', 'shooter-lane', 'chaser'] },
  { label: 'Goal test', text: 'Move deliberately and plan ahead. Work toward the exit or goal step by step without wasting moves.', archetypes: ['pusher-puzzle', 'chaser', 'navigator', 'collector'] },
  { label: 'Aggressive rush', text: 'Attack relentlessly. Close in on the nearest threat and fire or strike at every opening instead of waiting.', archetypes: ['shooter-lane', 'shooter-roaming', 'chaser'] },
  { label: 'Cautious explorer', text: 'Scout before committing. Read the layout, move one safe step at a time, and only advance when the path ahead is clear.', archetypes: ['navigator', 'pusher-puzzle', 'collector'] },
  { label: 'Resource hoarder', text: 'Grab every collectible you safely can. Route around fights and let enemies pass rather than trading hits for points.', archetypes: ['collector', 'navigator'] },
  { label: 'Lane defender', text: 'Hold your lane. Line up shots on enemies as they approach and only reposition when a threat slips past your column.', archetypes: ['shooter-lane', 'reflex-pilot'] },
  { label: 'Hit and run', text: 'Strike, then retreat. Land one hit on a threat and immediately fall back to a safe square before the counterattack lands.', archetypes: ['shooter-roaming', 'chaser', 'reflex-pilot'] },
  { label: 'Corner camper', text: 'Stay defensive in a safe pocket. Minimize movement, watch the enemies, and act only when one gets dangerously close.', archetypes: ['survivor', 'reflex-pilot'] },
  { label: 'Path clearer', text: 'Solve the level methodically. Plan pushes and unlocks a few moves ahead so blocks and keys open the route to the goal.', archetypes: ['pusher-puzzle', 'navigator'] },
  { label: 'Bait and dodge', text: 'Lure enemies out of position, then slip past. Use their movement against them and dodge into the gap they leave open.', archetypes: ['chaser', 'navigator', 'survivor'] }
];

// Advice clause for each VGDL strategy tag (the controlled vocab from vgdl-digest).
const TAG_ADVICE = {
  'avoid-collisions': 'Avoid collisions with hazards.',
  'collect-resources': 'Collect resources when the path is safe.',
  'attack-targets': 'Attack targets when you can line up a hit.',
  'position-puzzle': 'Plan your moves and pushes before committing.',
  'state-change': 'Trigger the transformation to make progress.',
  'clear-objectives': 'Clear every objective to win.',
  'survive': 'Prioritize surviving as long as possible.',
  'use-action': 'Use your action button when it helps.',
  'lane-control': 'Hold your lane and line up shots.',
  'balanced-navigation': 'Move deliberately toward the goal.'
};

// Generic tactic words that count as "on-topic" even without game-specific overlap,
// so reasonable defensive/aggressive tactics don't trip the soft-warn.
const GENERIC_TACTIC_WORDS = new Set(['avoid', 'dodge', 'defend', 'defensive', 'defensively', 'attack', 'attacking', 'survive', 'survival', 'score', 'scoring', 'points', 'safe', 'safely', 'aggressive', 'careful', 'carefully', 'plan', 'retreat', 'collect', 'explore', 'goal', 'enemy', 'enemies', 'threat', 'threats', 'distance', 'risk', 'risks', 'shoot', 'move', 'wait', 'push']);

const PREVIEW_GAMES = [
  { id: 0, name: 'aliens', category: 'gridphysics', archetype: 'shooter-lane', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 1 },
  { id: 14, name: 'cakybaky', category: 'gridphysics', archetype: 'collector', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 2 },
  { id: 18, name: 'chase', category: 'gridphysics', archetype: 'collector', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 3 },
  { id: 13, name: 'butterflies', category: 'gridphysics', archetype: 'chaser', pace: 'deliberate', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 4 },
  { id: 19, name: 'chipschallenge', category: 'gridphysics', archetype: 'pusher-puzzle', pace: 'deliberate', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 5 },
  { id: 20, name: 'chopper', category: 'gridphysics', archetype: 'shooter-roaming', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 6 },
  { id: 30, name: 'digdug', category: 'gridphysics', archetype: 'navigator', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 7 },
  { id: 68, name: 'pacman', category: 'gridphysics', archetype: 'chaser', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 8 },
  { id: 44, name: 'frogs', category: 'gridphysics', archetype: 'chaser', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 9 },
  { id: 50, name: 'hungrybirds', category: 'gridphysics', archetype: 'chaser', pace: 'deliberate', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 10 },
  { id: 15, name: 'camelRace', category: 'gridphysics', archetype: 'collector', pace: 'deliberate', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 11 },
  { id: 26, name: 'crossfire', category: 'gridphysics', archetype: 'chaser', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 12 },
  { id: 63, name: 'link', category: 'gridphysics', archetype: 'collector', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true, featuredRank: 13 }
];

const FEATURED_CABINET_COUNT = 13;
const FEATURED_ORDER_IDS = [0, 14, 18, 13, 19, 20, 30, 68, 44, 50, 15, 26, 63];
const SINGLE_PLAYER_CABINET_COUNT = 122;

const PREVIEW_MODELS = [
  {
    id: 'gemma4:31b',
    name: 'Gemma 4 31B',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'gemma3:27b',
    name: 'Gemma 3 27B',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3 Coder Next',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'ministral-3:14b',
    name: 'Ministral 3 14B',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'ministral-3:8b',
    name: 'Ministral 3 8B',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'ministral-3:3b',
    name: 'Ministral 3 3B',
    description: 'Open-weight model',
    featured: false
  },
  {
    id: 'devstral-small-2:24b',
    name: 'Devstral Small 2 24B',
    description: 'Open-weight model',
    featured: true
  }
];

// DOM Elements
const gameSelector = document.getElementById('game-selector');
const modelSelector = document.getElementById('model-selector');
const gameViewer = document.getElementById('game-viewer');
const gamesGrid = document.getElementById('games-grid');
const gameSearch = document.getElementById('game-search');
const modelSelect = document.getElementById('model-select');
const levelSelect = document.getElementById('level-select');
const startGameBtn = document.getElementById('start-game');
const stopGameBtn = document.getElementById('stop-game');
const backToGamesBtn = document.getElementById('back-to-games');
const playAgainBtn = document.getElementById('play-again');
const gameCanvas = document.getElementById('game-canvas');
const reasoningLog = document.getElementById('reasoning-log');
const gameEndMessage = document.getElementById('game-end-message');
const frameStatus = document.getElementById('frame-status');

// Arcade-specific elements
const strategyPresetSelect = document.getElementById('strategy-preset-select');
const strategyText = document.getElementById('strategy-text');
const strategyFormGroup = document.getElementById('strategy-form-group');
const modelFormGroup = document.getElementById('model-form-group');
const modelRunSetup = document.getElementById('model-run-setup');
const toggleBrowseAllBtn = document.getElementById('toggle-browse-all');
const gamesModeLabel = document.getElementById('games-mode-label');
const strategyActive = document.getElementById('strategy-active');
const steerForm = document.getElementById('steer-form');
const steerInput = document.getElementById('steer-input');
const steerSendBtn = document.getElementById('steer-send');
const summaryStrategy = document.getElementById('summary-strategy');
const summaryAdherence = document.getElementById('summary-adherence');
const summaryHighlights = document.getElementById('summary-highlights');
const strategyWarn = document.getElementById('strategy-warn');
const unfoldRules = document.getElementById('unfold-rules');
const unfoldChips = document.getElementById('unfold-chips');
const selectedGameStageName = document.getElementById('selected-game-stage-name');
const setupGamePreview = document.getElementById('setup-game-preview');

// Player-type toggle + human controls reference
const humanControlsRef = document.getElementById('human-controls-ref');
const controlKeys = document.getElementById('control-keys');

// Additional stat elements
const scoreEl = document.getElementById('score');
const healthEl = document.getElementById('health');
const maxHealthEl = document.getElementById('max-health');
const tickEl = document.getElementById('tick');

// Cabinet status strip + session controls (shell chrome)
const lastActionEl = document.getElementById('last-action');
const frameLatencyEl = document.getElementById('frame-latency');
const modelChips = document.getElementById('model-chips');
const backendLabel = document.getElementById('backend-label');
const copySessionLinkBtn = document.getElementById('copy-session-link');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const exportTraceBtn = document.getElementById('export-trace');
const navLinks = Array.from(document.querySelectorAll('#main-nav .nav-link'));
const topLevelSections = Array.from(document.querySelectorAll('#app > .section'));
const canvasCtx = gameCanvas.getContext('2d', { alpha: false });
const frameState = {
  pending: null,
  rafId: null,
  decoding: false,
  drawn: 0,
  dropped: 0,
  lastFrameAt: 0
};

// Initialize app
async function init() {
  console.log('[App] Initializing...');
  await loadGames();
  await loadModels();
  renderStrategyCards();
  setupEventListeners();
  setupWebSocket();
  applySessionParams();
}

// Session links: ?game=&level=&model=&strategy= preselects a cabinet so a
// copied link drops the next player at step 2 with everything dialed in.
function applySessionParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('game')) return;

  const gameId = parseInt(params.get('game'), 10);
  if (!state.games.some(g => g.id === gameId)) return;
  selectGame(gameId);

  const model = params.get('model');
  if (model && [...modelSelect.options].some(o => o.value === model)) {
    modelSelect.value = model;
    syncModelChips();
  }

  const level = params.get('level');
  if (level !== null && [...levelSelect.options].some(o => o.value === level)) {
    levelSelect.value = level;
  }

  const strategy = params.get('strategy');
  if (strategy && strategyText) {
    strategyText.value = strategy.slice(0, 240);
    updateStrategyWarn();
  }

  // Human-play links restore the "I'll play" toggle state
  if (params.get('player') === 'human') {
    playerType = 'human';
    document.querySelectorAll('.toggle-btn').forEach(b => {
      const isActive = b.dataset.playerType === 'human';
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    updatePlayerTypeUI();
  }
}

function buildSessionLink() {
  const params = new URLSearchParams();
  if (state.selectedGame) params.set('game', state.selectedGame.id);
  params.set('level', levelSelect.value || '0');
  if (playerType === 'human') {
    params.set('player', 'human');
  } else {
    params.set('model', modelSelect.value || '');
    const strategy = (strategyText?.value || '').trim();
    if (strategy) params.set('strategy', strategy);
  }
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

async function fetchGameCatalog(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  const games = await response.json();
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error(`${url} returned no games`);
  }
  return games;
}

async function loadStaticGameCatalog() {
  return fetchGameCatalog('/data/games.json');
}

// Load games from API, then fall back to the static catalog for file previews.
async function loadGames() {
  try {
    let games = await fetchGameCatalog('/api/games');
    let source = 'api';
    if (games.length < 20) {
      try {
        const staticGames = await loadStaticGameCatalog();
        if (staticGames.length > games.length) {
          games = staticGames;
          source = 'static catalog';
        }
      } catch (fallbackError) {
        console.warn('[App] Static game catalog unavailable:', fallbackError.message);
      }
    }
    state.games = games;
    state.featuredShowcase = null;
    const featuredCount = state.games.filter(g => g.featured).length;
    console.log(`[App] Loaded ${state.games.length} games (${featuredCount} featured) from ${source}`);
    trackUx('games_loaded', { total: state.games.length, featured: featuredCount, source }, {
      total_games: state.games.length,
      featured_games: featuredCount
    });
    renderCurrentGameList();
  } catch (error) {
    console.error('[App] Failed to load games:', error);
    trackUx('games_load_failed', { message: error.message });
    try {
      state.games = await loadStaticGameCatalog();
      trackUx('games_loaded', { total: state.games.length, source: 'static fallback' }, {
        total_games: state.games.length,
        featured_games: state.games.filter(g => g.featured).length
      });
    } catch (fallbackError) {
      console.error('[App] Static game catalog failed:', fallbackError);
      state.games = PREVIEW_GAMES;
    }
    state.featuredShowcase = null;
    renderCurrentGameList();
  }
}

// Render featured-only or all games depending on the current toggle
function renderCurrentGameList() {
  updateCatalogLabels();
  renderGames(state.showingAllGames ? state.games : getFeaturedShowcase());
}

function updateCatalogLabels() {
  const catalogTotal = state.games.length >= 20 ? state.games.length : SINGLE_PLAYER_CABINET_COUNT;
  if (state.showingAllGames) {
    gamesModeLabel.textContent = `all ${catalogTotal} cabinets`;
    toggleBrowseAllBtn.textContent = '★ Show featured only';
  } else {
    gamesModeLabel.textContent = 'featured cabinets';
    toggleBrowseAllBtn.textContent = `Browse all ${catalogTotal} →`;
  }
}

function getFeaturedShowcase() {
  if (state.featuredShowcase) return state.featuredShowcase;

  const byId = new Map(state.games.map(game => [game.id, game]));
  const orderedFeatured = state.games
    .filter(game => game.featured)
    .sort(compareFeaturedGames);
  const orderedIds = new Set(orderedFeatured.map(game => game.id));
  const fallbackFeatured = FEATURED_ORDER_IDS
    .map(id => byId.get(id))
    .filter(game => game && !orderedIds.has(game.id));
  const fill = state.games.filter(game => !orderedIds.has(game.id) &&
    !fallbackFeatured.some(item => item.id === game.id));

  state.featuredShowcase = orderedFeatured.concat(fallbackFeatured, fill)
    .slice(0, FEATURED_CABINET_COUNT)
    .map(game => ({ ...game, featured: true }));
  return state.featuredShowcase;
}

function compareFeaturedGames(a, b) {
  const aRank = Number.isInteger(a.featuredRank) ? a.featuredRank : FEATURED_ORDER_IDS.indexOf(a.id) + 1;
  const bRank = Number.isInteger(b.featuredRank) ? b.featuredRank : FEATURED_ORDER_IDS.indexOf(b.id) + 1;
  const aSort = aRank > 0 ? aRank : Number.MAX_SAFE_INTEGER;
  const bSort = bRank > 0 ? bRank : Number.MAX_SAFE_INTEGER;
  return aSort - bSort || a.id - b.id;
}

// Populate the preset-tactic dropdown, grouping presets that suit this game's
// archetype under "Suggested for this game" so affine tactics surface first
// (none are ever hidden). Selecting an option pre-fills the editable tactic box,
// which is the single source of truth startGame() reads and sends to the model.
function renderStrategyCards(archetype) {
  if (!strategyPresetSelect) return;

  const optionHtml = idx =>
    `<option value="${idx}">${escapeHtml(STRATEGY_PRESETS[idx].label)}</option>`;

  const suggested = [];
  const rest = [];
  STRATEGY_PRESETS.forEach((preset, idx) => {
    const affine = archetype && (preset.archetypes || []).includes(archetype);
    (affine ? suggested : rest).push(idx);
  });

  const placeholder = '<option value="" selected>Choose a sample tactic…</option>';
  let body;
  if (suggested.length) {
    body =
      `<optgroup label="Suggested for this game">${suggested.map(optionHtml).join('')}</optgroup>` +
      `<optgroup label="More tactics">${rest.map(optionHtml).join('')}</optgroup>`;
  } else {
    body = STRATEGY_PRESETS.map((_, idx) => optionHtml(idx)).join('');
  }
  strategyPresetSelect.innerHTML = placeholder + body;
  strategyPresetSelect.value = '';
}

// Selecting a preset fills the editable tactic box. Wired once at init; the
// options are re-rendered per game but the listener stays on the stable <select>.
function handleStrategyPresetChange() {
  if (!strategyPresetSelect || !strategyText) return;
  const idx = parseInt(strategyPresetSelect.value, 10);
  if (!Number.isInteger(idx) || !STRATEGY_PRESETS[idx]) return;
  const preset = STRATEGY_PRESETS[idx];
  strategyText.value = preset.text;
  updateStrategyWarn();
  trackUx('strategy_selected', { label: preset.label }, {}, { eventFamily: 'clickthrough' });
}

// Fetch the selected game's rules (derived from VGDL) and render the unfold chips.
async function loadGameDigest(gameId) {
  state.gameDigest = null;
  state.digestKeywords = [];
  if (unfoldChips) unfoldChips.innerHTML = '';
  if (unfoldRules) { unfoldRules.open = false; unfoldRules.classList.remove('hidden'); }
  try {
    const response = await fetch(`/api/games/${gameId}/digest`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const digest = await response.json();
    state.gameDigest = digest;
    state.digestKeywords = digestKeywords(digest);
    renderUnfoldChips(digest);
  } catch (error) {
    console.warn('[App] Could not load game digest:', error.message);
    if (unfoldRules) unfoldRules.classList.add('hidden');
  }
}

// Flatten the digest facets into a keyword set for the soft-warn topical check.
function digestKeywords(digest) {
  const stop = new Set(['all', 'the', 'and', 'hit', 'by', 'to', 'of', 'die', 'count', 'reaches', 'gone']);
  const blob = [
    ...(digest.scoring || []),
    ...(digest.hazards || []),
    ...(digest.mechanics || []),
    ...(digest.winConditions || []),
    ...(digest.loseConditions || []),
    ...(digest.strategyTags || [])
  ].join(' ').toLowerCase();
  return [...new Set((blob.match(/[a-z]+/g) || []).filter(w => w.length >= 3 && !stop.has(w)))];
}

// Render the game's rules as tappable "unfold" chips grouped by facet. Tapping a
// chip appends a well-formed clause to the tactic box — code-sourced scaffolding.
function renderUnfoldChips(digest) {
  if (!unfoldChips) return;
  const stripScore = s => s.replace(/\s*\([+-]?\d+\)\s*$/, '').trim();
  const groups = [];
  const add = (label, items, toClause) => {
    const chips = (items || []).filter(Boolean).map(item => ({ item, clause: toClause(item) }));
    if (chips.length) groups.push({ label, chips });
  };
  add('Avoid', digest.hazards, h => `Avoid the ${h}.`);
  add('Score by', digest.scoring, s => `Go for: ${stripScore(s)}.`);
  add('Mechanics', digest.mechanics, m => `Use the mechanic: ${m}.`);
  add('Win', digest.winConditions, w => `Work toward: ${w}.`);
  add('Approach', digest.strategyTags, t => TAG_ADVICE[t] || `Play with a ${t} approach.`);

  unfoldChips.replaceChildren();
  for (const g of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'unfold-group';

    const labelEl = document.createElement('span');
    labelEl.className = 'unfold-group-label';
    labelEl.textContent = g.label;
    groupEl.appendChild(labelEl);

    const chipsEl = document.createElement('div');
    chipsEl.className = 'unfold-group-chips';
    for (const c of g.chips) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'unfold-chip';
      btn.textContent = c.item;
      btn.dataset.clause = c.clause;
      btn.addEventListener('click', () => appendClause(c.clause, btn));
      chipsEl.appendChild(btn);
    }
    groupEl.appendChild(chipsEl);
    unfoldChips.appendChild(groupEl);
  }
}

// Append a chip's clause to the tactic box (deduped, capped at the server limit).
function appendClause(clause, chip) {
  if (!strategyText || !clause) return;
  const current = strategyText.value.trim();
  if (current.toLowerCase().includes(clause.toLowerCase())) return;
  const next = current ? `${current} ${clause}` : clause;
  strategyText.value = next.slice(0, 240);
  if (chip) chip.classList.add('added');
  updateStrategyWarn();
  trackUx('unfold_chip_added', { clause }, {}, { eventFamily: 'clickthrough' });
}

// Non-blocking soft-warn: flag injection-shaped or off-topic tactics. Never blocks
// submission — the server-side sanitizer is the actual floor; this is just a nudge.
function assessStrategy(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (/\b(ignore|disregard|forget|override)\b[^.!?]*\b(rule|rules|instruction|instructions|above|previous|system|prompt)\b/.test(lower)
      || /\b(system|assistant|developer)\s*:/.test(lower)) {
    return "That reads like an instruction to the model, not a game tactic — it'll be neutralized. Try an Unfold chip below.";
  }
  const kws = state.digestKeywords || [];
  const words = new Set(lower.match(/[a-z]+/g) || []);
  if (kws.length && words.size >= 3) {
    const onTopic = kws.some(k => words.has(k)) || [...words].some(w => GENERIC_TACTIC_WORDS.has(w));
    if (!onTopic) {
      return "This doesn't mention anything in this game — the model may ignore it. Try an Unfold chip below.";
    }
  }
  return null;
}

// Refresh the soft-warn banner from the current tactic text.
function updateStrategyWarn() {
  if (!strategyWarn) return;
  const msg = assessStrategy(strategyText ? strategyText.value : '');
  if (msg) {
    strategyWarn.textContent = msg;
    strategyWarn.classList.remove('hidden');
  } else {
    strategyWarn.textContent = '';
    strategyWarn.classList.add('hidden');
  }
}

// Load models from API
async function loadModels() {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.models = await response.json();
    console.log(`[App] Loaded ${state.models.length} models`);
    trackUx('models_loaded', { total: state.models.length }, { total_models: state.models.length });
    renderModels(state.models);
  } catch (error) {
    console.error('[App] Failed to load models:', error);
    trackUx('models_load_failed', { message: error.message });
    state.models = PREVIEW_MODELS;
    renderModels(state.models);
  }
}

// Render games grid
function renderGames(games) {
  gamesGrid.innerHTML = games.map(game => `
    <button type="button" class="game-card${game.featured ? ' featured' : ''}" data-game-id="${game.id}">
      <div class="game-card-meta">
        <span>${String(game.id).padStart(3, '0')}</span>
        <span>${escapeHtml(game.archetype || game.category)}</span>
      </div>
      <h3>${escapeHtml(game.name)}</h3>
      <p class="levels">${game.levels.length} levels</p>
    </button>
  `).join('');

  // Add click handlers
  gamesGrid.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => selectGame(parseInt(card.dataset.gameId)));
  });

  // Annotate cards that have human play traces
  annotateGameCardsWithTraces();
}

// Fetch trace stats for visible game cards and show a badge with play count + best score
function annotateGameCardsWithTraces() {
  document.querySelectorAll('.game-card[data-game-id]').forEach(card => {
    const gameId = parseInt(card.dataset.gameId, 10);
    if (!Number.isInteger(gameId)) return;
    fetch(`/api/traces/${gameId}/stats`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.traceCount || data.traceCount === 0) return;
        // Don't add duplicate badges
        if (card.querySelector('.trace-badge')) return;
        const meta = card.querySelector('.game-card-meta');
        if (!meta) return;
        const badge = document.createElement('span');
        badge.className = 'trace-badge';
        const humanCount = data.humanTraceCount || 0;
        const finetuneReady = humanCount >= 3;
        if (finetuneReady) badge.classList.add('ready');
        badge.textContent = `${humanCount} play${humanCount !== 1 ? 's' : ''} · best ${data.bestScore}` +
          (finetuneReady ? ' · FT ready' : '');
        meta.appendChild(badge);
      })
      .catch(() => {});
  });
}

// Render models dropdown (featured frontier models first, one selected by default)
function renderModels(models) {
  modelSelect.innerHTML = models.map(model => `
    <option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}${model.featured ? ' ★' : ''}${model.description ? ` — ${escapeHtml(model.description)}` : ''}</option>
  `).join('');
  const defaultModel = models.find(m => m.featured) || models[0];
  if (defaultModel) modelSelect.value = defaultModel.id;
  renderModelChips(models);
}

// Model chip rack — the cabinet's brains. The <select> stays in the DOM
// (hidden) as the single source of truth that startGame() reads.
const PROVIDER_LABELS = {
  'ollama-cloud': 'Cloud',
  'openrouter': 'OpenRouter',
  'ollama-local': 'Local',
  'legion-vllm': 'Legion vLLM'
};

function renderModelChips(models) {
  if (!modelChips) return;
  modelChips.innerHTML = models.map(model => {
    const tags = [
      `<span class="chip-badge provider">${escapeHtml(PROVIDER_LABELS[model.provider] || model.provider)}</span>`,
      /open.weight/i.test(model.description || '') ? '<span class="chip-badge">Open-weight</span>' : '',
      model.speed ? `<span class="chip-badge">${escapeHtml(model.speed)} speed</span>` : '',
      model.cost ? `<span class="chip-badge">${escapeHtml(model.cost)} cost</span>` : ''
    ].filter(Boolean).join('');
    return `
      <button type="button" class="model-chip" data-model-id="${escapeHtml(model.id)}">
        <span class="model-chip-name">${escapeHtml(model.name)}${model.featured ? ' ★' : ''}</span>
        <span class="chip-tags">${tags}</span>
      </button>
    `;
  }).join('');

  modelChips.querySelectorAll('.model-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      modelSelect.value = chip.dataset.modelId;
      syncModelChips();
      trackUx('model_chip_selected', { modelId: chip.dataset.modelId });
    });
  });

  modelSelect.classList.add('hidden');
  syncModelChips();
}

function syncModelChips() {
  if (!modelChips) return;
  modelChips.querySelectorAll('.model-chip').forEach(chip => {
    chip.classList.toggle('selected', chip.dataset.modelId === modelSelect.value);
  });
  const model = state.models.find(m => m.id === modelSelect.value);
  if (backendLabel && model) {
    backendLabel.textContent = PROVIDER_LABELS[model.provider] || model.provider || 'Model backend';
  }
}

// Select a game
function selectGame(gameId) {
  state.selectedGame = state.games.find(g => g.id === gameId);
  console.log('[App] Selected game:', state.selectedGame.name);
  trackUx('game_selected', {
    gameId,
    gameName: state.selectedGame.name,
    category: state.selectedGame.category,
    archetype: state.selectedGame.archetype || null,
    pace: state.selectedGame.pace || null
  }, {}, {
    eventFamily: 'clickthrough',
    gameId
  });

  // Re-rank the preset strategy cards for this game's archetype
  renderStrategyCards(state.selectedGame.archetype);

  // Update UI
  document.getElementById('selected-game-name').textContent = state.selectedGame.name;
  if (selectedGameStageName) selectedGameStageName.textContent = state.selectedGame.name;

  // Cabinet placard: archetype / pace / level count chips under the name.
  const stageMeta = document.getElementById('selected-game-meta');
  if (stageMeta) {
    stageMeta.replaceChildren();
    const levelCount = (state.selectedGame.levels || []).length || state.selectedGame.levelCount || 5;
    [state.selectedGame.archetype, state.selectedGame.pace, `${levelCount} levels`]
      .filter(Boolean)
      .forEach(label => {
        const chip = document.createElement('span');
        chip.className = 'meta-chip';
        chip.textContent = label;
        stageMeta.appendChild(chip);
      });
  }

  // Populate level selector - display as 1-5 but values are 0-4
  const levels = state.selectedGame.levels && state.selectedGame.levels.length > 0
    ? state.selectedGame.levels
    : [0, 1, 2, 3, 4];

  levelSelect.innerHTML = levels.map((level, idx) => `
    <option value="${level}">Level ${level + 1}</option>
  `).join('');

  console.log('[App] Populated levels:', levels);

  // Load the game's rules for the unfold scaffold + reset any prior soft-warn.
  loadGameDigest(gameId);
  updateStrategyWarn();
  updatePlayerTypeUI();

  // Show model selector
  showStep(modelSelector);
}

// Show/hide UI elements based on the current player type.
// Human mode should stay focused on the keyboard controls and play button;
// model prompting, rule unfolding, and model selection are only for LLM runs.
function updatePlayerTypeUI() {
  const isHuman = playerType === 'human';

  // "Prompt the player" header only applies to model runs; human mode shows
  // its own Controls block instead.
  const promptingHead = document.querySelector('.prompting-panel-head');
  if (promptingHead) promptingHead.classList.toggle('hidden', isHuman);

  if (modelRunSetup) {
    modelRunSetup.classList.toggle('hidden', isHuman);
  } else {
    if (modelFormGroup) modelFormGroup.classList.toggle('hidden', isHuman);
    if (strategyFormGroup) {
      strategyFormGroup.classList.toggle('hidden', isHuman);
    } else {
      if (strategyText) strategyText.classList.toggle('hidden', isHuman);
      if (strategyPresetSelect) strategyPresetSelect.classList.toggle('hidden', isHuman);
      if (unfoldRules) unfoldRules.classList.toggle('hidden', isHuman);
    }
  }

  // Toggle human controls reference
  if (humanControlsRef) humanControlsRef.classList.toggle('hidden', !isHuman);
  if (setupGamePreview) setupGamePreview.classList.toggle('hidden', isHuman);

  // Update start button text
  if (startGameBtn) {
    startGameBtn.textContent = isHuman ? 'Play the Game' : 'Run the Game';
  }

  // Populate the key reference when switching to human mode
  if (isHuman && state.selectedGame) {
    populateControlReference(state.selectedGame.id);
  }
}

// Fetch the game digest and build a key reference from the available actions.
// The digest returns controls.actions (labels like 'LEFT','SHOOT','WAIT') and
// controls.useLabel. We map those to keyboard keys and render them in #control-keys.
async function populateControlReference(gameId) {
  if (!controlKeys) return;
  controlKeys.innerHTML = '';
  try {
    const response = await fetch(`/api/games/${gameId}/digest`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const digest = await response.json();

    // Build a label → key-display map from the digest's controls.
    // digest.controls.actions is e.g. ['LEFT','RIGHT','SHOOT','WAIT']
    // digest.controls.useLabel is e.g. 'SHOOT'
    const controls = digest.controls || {};
    const actions = controls.actions || [];
    const useLabel = controls.useLabel || 'USE';

    // Keyboard display for each action label
    const labelKeyMap = {
      UP: ['↑ / W'],
      DOWN: ['↓ / S'],
      LEFT: ['← / A'],
      RIGHT: ['→ / D'],
      WAIT: ['—']
    };
    // The use action maps to Space
    labelKeyMap[useLabel] = ['Space'];

    const frag = document.createDocumentFragment();
    for (const action of actions) {
      const keys = labelKeyMap[action];
      if (!keys) continue;
      for (const key of keys) {
        const span = document.createElement('span');
        span.className = 'control-key';
        const cap = document.createElement('span');
        cap.className = 'key-cap';
        cap.textContent = key;
        const lbl = document.createElement('span');
        lbl.className = 'key-label';
        lbl.textContent = action;
        span.append(cap, lbl);
        frag.appendChild(span);
      }
    }
    controlKeys.appendChild(frag);
  } catch (err) {
    console.warn('[App] Could not load control reference:', err.message);
  }
}

// --- Human play keyboard handlers -----------------------------------------

// Start game
async function startGame() {
  if (!state.selectedGame) {
    alert('Please select a game');
    return;
  }

  const isHuman = playerType === 'human';
  const model = isHuman ? null : modelSelect.value;
  const level = parseInt(levelSelect.value);
  const strategy = isHuman ? '' : (strategyText?.value || '').trim();
  trackUx('game_start_clicked', {
    gameId: state.selectedGame.id,
    gameName: state.selectedGame.name,
    level,
    strategyPresent: Boolean(strategy)
  }, {}, {
    eventFamily: 'clickthrough',
    gameId: state.selectedGame.id,
    levelId: level,
    modelId: model
  });

  console.log('[App] Starting game:', {
    game: state.selectedGame.name,
    model: model || '(human)',
    level,
    strategy: strategy || '(none)'
  });

  try {
    startGameBtn.disabled = true;
    startGameBtn.textContent = 'Starting run...';

    // Fresh trace + status strip for this run
    state.traceLog = [];
    state.traceStartedAt = new Date().toISOString();
    if (lastActionEl) lastActionEl.textContent = '—';
    if (frameLatencyEl) frameLatencyEl.textContent = '—';

    const response = await fetch('/api/game/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: state.selectedGame.id,
        levelId: level,
        model,
        strategy,
        playerType
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start game');
    }
    state.processId = data.processId;
    state.selectedModel = model;
    state.activeStrategy = strategy;
    state.runId = data.runId;
    trackUx('game_start_succeeded', {
      processId: data.processId,
      runId: data.runId
    }, {}, {
      eventFamily: 'clickthrough',
      gameId: state.selectedGame.id,
      levelId: level,
      modelId: model
    });

    console.log('[App] Game started:', data);

    // Show game viewer
    document.getElementById('current-game-name').textContent = state.selectedGame.name;
    reasoningLog.innerHTML = '';
    state.lastSummary = null;
    state.adherenceMentioned = 0;
    state.adherenceTotal = 0;
    const ribbon0 = document.getElementById('adherence-ribbon');
    if (ribbon0) ribbon0.classList.add('hidden');
    resetFrameDisplay();
    gameEndMessage.classList.add('hidden');

    // Show the active strategy banner above the narration log
    if (strategy) {
      strategyActive.textContent = `Strategy: "${strategy}"`;
      strategyActive.classList.remove('hidden');
    } else {
      strategyActive.classList.add('hidden');
    }

    // Mid-run steering only applies to model runs
    if (steerForm) {
      steerForm.classList.toggle('hidden', playerType === 'human');
      if (steerInput) steerInput.value = '';
    }

    showStep(gameViewer);

    // Attach keyboard listeners for human play mode
    if (playerType === 'human') {
      attachHumanPlayListeners();
    }
  } catch (error) {
    console.error('[App] Error starting game:', error);
    trackUx('game_start_failed', {
      message: error.message
    }, {}, {
      eventFamily: 'clickthrough',
      gameId: state.selectedGame.id,
      levelId: level,
      modelId: model
    });
    alert('Failed to start game: ' + error.message);
  } finally {
    startGameBtn.disabled = false;
    startGameBtn.textContent = playerType === 'human' ? 'Play the Game' : 'Run the Game';
  }
}

// Stop game
async function stopGame() {
  if (!state.processId) return;
  cleanupHumanPlay();

  try {
    trackUx('game_stop_clicked', {
      processId: state.processId,
      runId: state.runId || null
    }, {}, {
      eventFamily: 'clickthrough',
      gameId: state.selectedGame?.id,
      modelId: state.selectedModel
    });
    await fetch('/api/game/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processId: state.processId })
    });

    console.log('[App] Game stopped');
    trackUx('game_stop_succeeded', {
      processId: state.processId,
      runId: state.runId || null
    }, {}, {
      eventFamily: 'clickthrough',
      gameId: state.selectedGame?.id,
      modelId: state.selectedModel
    });
    state.processId = null;
    state.runId = null;
    showStep(gameSelector);
  } catch (error) {
    console.error('[App] Error stopping game:', error);
    trackUx('game_stop_failed', { message: error.message });
  }
}

// Show/hide steps
function showStep(step) {
  [gameSelector, modelSelector, gameViewer].forEach(s => s.classList.remove('active'));
  step.classList.add('active');
  if (step === gameViewer) {
    requestAnimationFrame(() => {
      const reduceMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      step.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }
}

function showSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;

  topLevelSections.forEach(item => {
    const isActive = item.id === sectionId;
    item.classList.toggle('active', isActive);
    item.hidden = !isActive;
  });

  navLinks.forEach(link => {
    const isActive = link.dataset.target === sectionId;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

// Event listeners
function setupEventListeners() {
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      const sectionId = link.dataset.target;
      showSection(sectionId);
      trackUx('section_selected', { sectionId }, {}, { eventFamily: 'clickthrough' });
    });
  });

  gameSearch.addEventListener('input', (e) => {
    const search = e.target.value.toLowerCase();
    if (!search) {
      renderCurrentGameList();
      return;
    }
    // Searching always spans all 122 games
    const filtered = state.games.filter(g =>
      g.name.toLowerCase().includes(search)
    );
    renderGames(filtered);
    trackSearch(search, filtered.length);
  });

  // Toggle between featured-only and the full browsable list
  toggleBrowseAllBtn.addEventListener('click', () => {
    state.showingAllGames = !state.showingAllGames;
    if (state.showingAllGames) {
      gameSearch.classList.remove('hidden');
    } else {
      gameSearch.classList.add('hidden');
      gameSearch.value = '';
    }
    updateCatalogLabels();
    renderCurrentGameList();
    trackUx('catalog_mode_changed', {
      showingAllGames: state.showingAllGames
    }, {}, { eventFamily: 'clickthrough' });
  });

  startGameBtn.addEventListener('click', startGame);
  stopGameBtn.addEventListener('click', stopGame);

  // Mid-run steering: submit sends the new directive to the live model run
  if (steerForm) {
    steerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendSteer();
    });
  }

  // Preset-tactic dropdown fills the editable tactic box (listener stays put; options re-render per game)
  if (strategyPresetSelect) strategyPresetSelect.addEventListener('change', handleStrategyPresetChange);

  // Player-type toggle: "Model plays" vs "I'll play"
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.playerType;
      if (!type || type === playerType) return;
      playerType = type;
      document.querySelectorAll('.toggle-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      updatePlayerTypeUI();
    });
  });

  if (strategyText) strategyText.addEventListener('input', updateStrategyWarn);
  backToGamesBtn.addEventListener('click', () => showStep(gameSelector));

  // Session affordances on the cabinet
  if (copySessionLinkBtn) {
    copySessionLinkBtn.addEventListener('click', async () => {
      const link = buildSessionLink();
      try {
        await navigator.clipboard.writeText(link);
        copySessionLinkBtn.textContent = 'Copied ✓';
      } catch (_) {
        window.prompt('Copy this session link:', link);
      }
      setTimeout(() => { copySessionLinkBtn.textContent = 'Copy session link'; }, 1600);
      trackUx('session_link_copied', { gameId: state.selectedGame?.id ?? null });
    });
  }

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', () => {
      const display = document.querySelector('.game-display');
      if (!display) return;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (display.requestFullscreen) {
        display.requestFullscreen();
      }
    });
  }

  if (exportTraceBtn) {
    exportTraceBtn.addEventListener('click', () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        startedAt: state.traceStartedAt,
        game: state.selectedGame
          ? { id: state.selectedGame.id, name: state.selectedGame.name, archetype: state.selectedGame.archetype || null }
          : null,
        level: parseInt(levelSelect.value, 10) || 0,
        model: playerType === 'human' ? null : (modelSelect.value || null),
        playerType,
        strategy: playerType === 'human' ? null : ((strategyText?.value || '').trim() || null),
        summary: state.lastSummary || null,
        decisions: state.traceLog
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `arcade-trace-${state.selectedGame?.name || 'run'}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      trackUx('trace_exported', { decisions: state.traceLog.length });
    });
  }


  playAgainBtn.addEventListener('click', () => {
    showStep(modelSelector);
    gameEndMessage.classList.add('hidden');
  });
}

// WebSocket handlers
function setupWebSocket() {
  if (!socket) {
    console.warn('[App] Socket unavailable in static preview');
    return;
  }

  socket.on('connect', () => {
    console.log('[App] Connected to server');
    console.log('[App] Socket ID:', socket.id);
    console.log('[App] Transport:', socket.io.engine.transport.name);
    trackUx('browser_socket_connected', {
      socketId: socket.id,
      transport: socket.io.engine.transport.name
    });
  });

  socket.on('disconnect', (reason) => {
    console.warn('[App] Disconnected from server:', reason);
    trackUx('browser_socket_disconnected', { reason });
  });

  socket.on('connect_error', (error) => {
    console.error('[App] Connection error:', error);
  });

  // The server broadcasts every run's events on one global socket — walk-up
  // runs and the attract-mode marble run alike. Only apply events tagged with
  // this viewer's active run, so a resuming marble case can't hijack the
  // cabinet with a different game's frames and reasoning.
  function isCurrentRun(data) {
    return Boolean(data && state.runId && data.runId === state.runId);
  }

  // The newest multi-step plan's tape, so per-tick game-state events can
  // advance the live "executing step N" cell without a new socket event.
  let latestPlanTape = null;

  function buildPlanTape(plan) {
    const tape = document.createElement('div');
    tape.className = 'plan-tape';
    plan.forEach((step, i) => {
      const cell = document.createElement('span');
      cell.className = 'plan-cell' + (i === 0 ? ' is-live' : '');
      cell.style.setProperty('--cell-index', i);
      cell.textContent = String(step).replace(/^ACTION_/, '');
      tape.appendChild(cell);
    });
    const count = document.createElement('span');
    count.className = 'plan-count';
    count.textContent = `1/${plan.length}`;
    tape.appendChild(count);
    return tape;
  }

  socket.on('llm-reasoning', (data) => {
    if (!isCurrentRun(data)) return;
    console.log('[App] LLM reasoning:', data);

    // Update game state overlay
    if (scoreEl) scoreEl.textContent = data.gameState?.score || 0;
    if (healthEl) healthEl.textContent = data.gameState?.health || 0;
    if (tickEl) tickEl.textContent = data.gameState?.tick || 0;

    // Cabinet status strip: last decision + decision latency
    if (lastActionEl) lastActionEl.textContent = String(data.action || '—').replace(/^ACTION_/, '');
    if (frameLatencyEl) frameLatencyEl.textContent = data.elapsed != null ? `${data.elapsed}ms` : '—';

    // Accumulate the run's trace for "Export trace"
    if (state.traceLog.length < 500) {
      state.traceLog.push({
        tick: data.gameState?.tick ?? null,
        score: data.gameState?.score ?? null,
        action: data.action || null,
        reason: data.reason || null,
        response: data.response || null,
        plan: data.plan || null,
        elapsedMs: data.elapsed ?? null,
        provider: data.provider || null,
        modelUsed: data.modelUsed || null
      });
    }

    // Live adherence ribbon (running "followed the strategy" rate).
    updateAdherenceRibbon(data);

    // Add narration entry (built with DOM methods; the prompt layers can be long
    // and mix game + sanitized-player text, so we avoid innerHTML entirely here).
    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';

    const timing = data.elapsed > 800 ? 'slow' : 'fast';
    const narration = data.reason || data.response || '(no rationale)';

    const narrDiv = document.createElement('div');
    narrDiv.className = 'narration';
    narrDiv.textContent = narration;
    entry.appendChild(narrDiv);

    if (moveFollowsStrategy(data)) {
      const badge = document.createElement('span');
      badge.className = 'strategy-badge';
      badge.textContent = '↳ following your strategy';
      entry.appendChild(badge);
    }

    const hasPlan = Array.isArray(data.plan) && data.plan.length > 1;
    if (hasPlan) {
      const tape = buildPlanTape(data.plan);
      entry.appendChild(tape);
      latestPlanTape = tape;
    } else {
      latestPlanTape = null;
    }

    // The tape owns plan progression, so the action line stays timing + provider.
    const actDiv = document.createElement('div');
    actDiv.className = `action ${timing}`;
    actDiv.textContent = `→ ${String(data.action || '').replace(/^ACTION_/, '')} (${data.elapsed}ms${data.provider ? ' · ' + data.provider : ''})`;
    entry.appendChild(actDiv);

    // The Decision Autopsy: how this move was assembled + decided.
    entry.appendChild(buildAutopsy(data));

    reasoningLog.insertBefore(entry, reasoningLog.firstChild);

    // Keep only last 20 entries
    while (reasoningLog.children.length > 20) {
      reasoningLog.removeChild(reasoningLog.lastChild);
    }
  });

  socket.on('game-frame', (data) => {
    if (!isCurrentRun(data)) return;
    queueGameFrame(data);
  });

  socket.on('game-state', (data) => {
    if (!isCurrentRun(data)) return;
    // Track live game state for synchronous access by human-trace recorder
    state.liveGameState = {
      tick: data.tick || 0,
      score: data.score || 0,
      health: data.health || 0
    };
    // Update game state overlay (sent every tick)
    if (scoreEl) scoreEl.textContent = data.score || 0;
    if (healthEl) healthEl.textContent = data.health || 0;
    if (maxHealthEl && data.maxHealth) maxHealthEl.textContent = data.maxHealth;
    if (tickEl) tickEl.textContent = data.tick || 0;

    // Advance the live tape on the newest narration entry
    if (latestPlanTape && data.planLength > 1) {
      const cells = latestPlanTape.querySelectorAll('.plan-cell');
      // planStep can be 0 for one tick when a fresh plan lands mid-tick;
      // a called plan is always "on step 1" until it advances.
      const liveIdx = Math.max(1, Math.min(data.planStep, cells.length)) - 1;
      cells.forEach((cell, i) => {
        cell.classList.remove('is-live', 'is-done');
        if (i < liveIdx) cell.classList.add('is-done');
        else if (i === liveIdx) cell.classList.add('is-live');
      });
      const count = latestPlanTape.querySelector('.plan-count');
      if (count) count.textContent = `${Math.max(1, Math.min(data.planStep, data.planLength))}/${data.planLength}`;
      if (cells[liveIdx] && latestPlanTape.scrollWidth > latestPlanTape.clientWidth) {
        // Scroll the tape only (horizontal), never the reasoning log's reading position
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        latestPlanTape.scrollTo({
          left: Math.max(0, cells[liveIdx].offsetLeft - 16),
          behavior: reduced ? 'auto' : 'smooth'
        });
      }
    }
  });

  // Per-level end (non-blocking notification)
  socket.on('level-end', (data) => {
    if (!isCurrentRun(data)) return;
    console.log('[App] Level ended:', data);

    const result = data.winner === 'PLAYER_WINS' ? 'Win' :
      data.winner === 'PLAYER_LOSES' ? 'Loss' : 'Draw';

    // Add level result as a reasoning entry (non-blocking, no modal)
    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';
    entry.innerHTML = `
      <div class="action fast">Level ${data.level} complete: ${result} (Score: ${data.score})</div>
    `;
    reasoningLog.insertBefore(entry, reasoningLog.firstChild);

    // Store last level data for session-end display
    state.lastLevelData = data;
  });

  // End-of-run summary card (fires on level end, carries adherence + highlights)
  socket.on('run-summary', (data) => {
    if (!isCurrentRun(data)) return;
    console.log('[App] Run summary:', data);
    cleanupHumanPlay();
    if (steerForm) steerForm.classList.add('hidden');
    state.lastSummary = data;
    trackUx('run_summary_viewed', {
      winner: data.winner,
      finalScore: data.finalScore,
      decisions: data.decisions
    }, {
      final_score: data.finalScore || 0,
      decisions: data.decisions || 0
    }, {
      eventFamily: 'evaluation',
      gameId: state.selectedGame?.id,
      modelId: state.selectedModel
    });
    renderRunSummary(data);
    gameEndMessage.classList.remove('hidden');
  });

  // Full session end (all levels done)
  socket.on('session-end', (data) => {
    if (!isCurrentRun(data)) return;
    console.log('[App] Session ended:', data);
    cleanupHumanPlay();
    if (steerForm) steerForm.classList.add('hidden');

    // If a run-summary already populated the card, leave it as-is
    if (!state.lastSummary) {
      const lastData = state.lastLevelData || {};
      document.getElementById('final-score').textContent = lastData.score || 0;
      document.getElementById('final-result').textContent =
        lastData.winner === 'PLAYER_WINS' ? 'Victory!' :
        lastData.winner === 'PLAYER_LOSES' ? 'Defeat' :
        data.levelsPlayed ? `${data.levelsPlayed} levels played` : 'Done';
    }

    gameEndMessage.classList.remove('hidden');
  });

  // LLM API errors
  socket.on('llm-error', (data) => {
    if (!isCurrentRun(data)) return;
    console.error('[App] LLM error:', data);

    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';
    entry.innerHTML = `
      <div class="action timeout">API Error (${data.status}): ${escapeHtml(data.message?.substring(0, 200) || 'Unknown error')}</div>
    `;
    reasoningLog.insertBefore(entry, reasoningLog.firstChild);
  });

  // Mid-run steering applied server-side: refresh the banner and log the pivot
  // so every tab watching this run sees the new directive.
  socket.on('strategy-updated', (data) => {
    if (!isCurrentRun(data)) return;
    state.activeStrategy = data.strategy || null;
    if (data.strategy) {
      strategyActive.textContent = `Strategy: "${data.strategy}"`;
      strategyActive.classList.remove('hidden');
    } else {
      strategyActive.classList.add('hidden');
    }
    addSteerToTrace(data.strategy);
  });

  // A fine-tuned model landed in the catalog: refresh the picker without
  // clobbering the visitor's current selection.
  socket.on('finetune-complete', async (data) => {
    console.log('[App] Fine-tuned model ready:', data.modelId);
    const previous = modelSelect ? modelSelect.value : null;
    await loadModels();
    if (previous && state.models.some(m => m.id === previous)) {
      modelSelect.value = previous;
      syncModelChips();
    }
  });
}

// Populate the end-of-run summary card from the run-summary payload
function renderRunSummary(s) {
  const resultEl = document.getElementById('final-result');
  resultEl.textContent = s.won ? 'Victory!' :
    (s.winner === 'PLAYER_LOSES' ? 'Defeat' : 'Time up');
  document.getElementById('final-score').textContent = s.finalScore != null ? s.finalScore : 0;

  // Echo the strategy
  if (s.strategy) {
    summaryStrategy.textContent = `Your strategy: "${s.strategy}"`;
    summaryStrategy.classList.remove('hidden');
  } else {
    summaryStrategy.classList.add('hidden');
  }

  // Stated-adherence signal — honest wording: the model SAID it followed
  if (s.strategy && s.adherence && s.adherence.total > 0) {
    const a = s.adherence;
    summaryAdherence.innerHTML =
      `<span class="adherence-label adherence-${a.label.split(' ')[0].toLowerCase()}">${escapeHtml(a.label)}</span>` +
      `<span class="adherence-detail">The model referenced your strategy in ${a.mentioned}/${a.total} of its explained moves.</span>`;
    summaryAdherence.classList.remove('hidden');
  } else {
    summaryAdherence.classList.add('hidden');
  }

  // Highlight decisions
  if (s.highlights && s.highlights.length > 0) {
    const items = s.highlights.map(h => {
      const delta = h.scoreDelta ? ` <span class="hl-score">+${h.scoreDelta}</span>` : '';
      return `<li><span class="hl-action">${escapeHtml(String(h.action || '').replace(/^ACTION_/, ''))}</span> — ${escapeHtml(h.reason || '')}${delta}</li>`;
    }).join('');
    summaryHighlights.innerHTML = `<h4>Key moves</h4><ul>${items}</ul>`;
    summaryHighlights.classList.remove('hidden');
  } else {
    summaryHighlights.classList.add('hidden');
  }
}

function resetFrameDisplay() {
  frameState.pending = null;
  frameState.drawn = 0;
  frameState.dropped = 0;
  frameState.lastFrameAt = 0;
  if (canvasCtx && gameCanvas.width && gameCanvas.height) {
    canvasCtx.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
  }
  gameCanvas.removeAttribute('data-live');
  gameCanvas.closest('.game-display')?.classList.remove('is-live');
  if (frameStatus) frameStatus.textContent = 'Waiting for frame';
}

function queueGameFrame(frame) {
  if (frameState.pending) frameState.dropped += 1;
  frameState.pending = frame;
  if (frameState.rafId || frameState.decoding) return;
  frameState.rafId = requestAnimationFrame(drawQueuedFrame);
}

async function drawQueuedFrame() {
  frameState.rafId = null;
  if (!frameState.pending || frameState.decoding) return;

  const frame = frameState.pending;
  frameState.pending = null;
  frameState.decoding = true;

  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = frame.image;

    // Guard: if the data URL is empty or too short to be a valid PNG, skip
    // without throwing — the server's PNG-signature check catches most partial
    // writes, but a race between stat() and readFile() can still slip through.
    if (!frame.image || frame.image.length < 80) {
      frameState.decoding = false;
      return;
    }

    if (img.decode) {
      await img.decode();
    } else {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return;

    if (gameCanvas.width !== width || gameCanvas.height !== height) {
      gameCanvas.width = width;
      gameCanvas.height = height;
      gameCanvas.closest('.game-display')?.style.setProperty('--game-aspect-ratio', `${width} / ${height}`);
    }

    canvasCtx.imageSmoothingEnabled = false;
    canvasCtx.clearRect(0, 0, width, height);
    canvasCtx.drawImage(img, 0, 0, width, height);

    frameState.drawn += 1;
    frameState.lastFrameAt = performance.now();
    gameCanvas.dataset.live = 'true';
    gameCanvas.closest('.game-display')?.classList.add('is-live');
    if (frameStatus) {
      const latency = Math.max(0, Date.now() - frame.timestamp);
      frameStatus.textContent = `Frame ${frameState.drawn} · ${latency}ms`;
    }
  } catch (error) {
    console.error('[App] Failed to draw game frame:', error.message);
    if (frameStatus) frameStatus.textContent = 'Frame failed';
  } finally {
    frameState.decoding = false;
    if (frameState.pending && !frameState.rafId) {
      frameState.rafId = requestAnimationFrame(drawQueuedFrame);
    }
  }
}

// Light client-side check for the per-move "following your strategy" badge.
// Honest: only shows when the model's rationale literally echoes a strategy word.
const BADGE_STOPWORDS = new Set(['the','and','for','with','your','you','this','that','play','playing','try','keep','make','get','move','moving','action','when','from','are','will','can','should','need','want','take','use','using','only','even','some','over','it','to','of','in','on','as','be','do','go']);
// Build the Decision Autopsy: a collapsible view of the prompt-layer stack the
// model saw (rules → tactic → grid → tick state) plus the decision flow, so a
// viewer can see HOW a move was assembled and decided. DOM-built (no innerHTML).
function buildAutopsy(data) {
  const details = document.createElement('details');
  details.className = 'raw-toggle';
  const summary = document.createElement('summary');
  summary.textContent = 'decision autopsy';
  details.appendChild(summary);

  const flow = document.createElement('div');
  flow.className = 'autopsy-flow';
  flow.textContent = `state → prompt → ${data.modelUsed || 'model'} (${data.provider || '?'}) → REASON → ${data.action || '—'}`;
  details.appendChild(flow);

  if (Array.isArray(data.promptLayers) && data.promptLayers.length) {
    const stack = document.createElement('div');
    stack.className = 'layer-stack';
    for (const layer of data.promptLayers) {
      const row = document.createElement('details');
      row.className = 'layer' + (layer.name === 'Player tactic' ? ' layer-tactic' : '');
      const head = document.createElement('summary');
      head.className = 'layer-head';
      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      const count = document.createElement('span');
      count.className = 'layer-count';
      count.textContent = `${layer.text.length} chars`;
      head.append(name, count);
      row.appendChild(head);
      const body = document.createElement('pre');
      body.className = 'layer-text';
      body.textContent = layer.text;
      row.appendChild(body);
      stack.appendChild(row);
    }
    details.appendChild(stack);
  }

  const resp = document.createElement('div');
  resp.className = 'response';
  resp.textContent = data.response || '(no response)';
  details.appendChild(resp);
  return details;
}

// Running "followed the strategy" rate, updated per decision (mirrors the
// server-side computeAdherence heuristic, shown live instead of only on the card).
function updateAdherenceRibbon(data) {
  const ribbon = document.getElementById('adherence-ribbon');
  if (!ribbon) return;
  if (!data.strategy) { ribbon.classList.add('hidden'); return; }
  state.adherenceTotal = (state.adherenceTotal || 0) + 1;
  if (moveFollowsStrategy(data)) {
    state.adherenceMentioned = (state.adherenceMentioned || 0) + 1;
  }
  const m = state.adherenceMentioned || 0;
  const t = state.adherenceTotal;
  const pct = t ? Math.round((m / t) * 100) : 0;
  ribbon.classList.remove('hidden');
  ribbon.replaceChildren();
  const label = document.createElement('span');
  label.className = 'ribbon-label';
  label.textContent = `Following strategy: ${m}/${t} moves`;
  const bar = document.createElement('div');
  bar.className = 'ribbon-bar';
  const fill = document.createElement('div');
  fill.className = 'ribbon-fill';
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  ribbon.append(label, bar);
}

function sharesStrategyKeyword(reason, strategy) {
  if (!reason || !strategy) return false;
  const r = reason.toLowerCase();
  const words = (strategy.toLowerCase().match(/[a-z]+/g) || [])
    .filter(w => w.length >= 4 && !BADGE_STOPWORDS.has(w));
  return words.some(w => r.includes(w));
}

function parseDirectionalStrategy(strategy) {
  const text = (strategy || '').trim();
  if (!text) return null;
  const negative = text.match(/\b(?:do\s+not|don't|dont|never|avoid|without|no|not|stop)\s+(?:(?:go|going|move|moving|turn|turning|head|heading|steer|steering|press|pressing)\s+)?(?:to\s+the\s+)?(left|right|up|down)\b/i);
  if (negative) return { mode: 'avoid', action: `ACTION_${negative[1].toUpperCase()}` };
  const positive = text.match(/\b(?:go|move|turn|head|steer|press|keep|continue)\s+(?:going\s+)?(?:to\s+the\s+)?(left|right|up|down)\b/i) ||
    text.match(/^\s*(left|right|up|down)\s*[.!?]*\s*$/i);
  if (positive) return { mode: 'prefer', action: `ACTION_${positive[1].toUpperCase()}` };
  return null;
}

function moveFollowsStrategy(data) {
  const directive = parseDirectionalStrategy(data?.strategy);
  if (directive && data?.action) {
    return directive.mode === 'avoid'
      ? data.action !== directive.action
      : data.action === directive.action;
  }
  return sharesStrategyKeyword(data?.reason, data?.strategy);
}

// ─── Human play: keyboard capture ───────────────────────────────────────────

// Attach keydown/keyup listeners for human play mode. Called from startGame()
// after the game viewer is shown, only when playerType === 'human'.
function attachHumanPlayListeners() {
  // Remove any existing listeners first (idempotent)
  cleanupHumanPlay();

  humanKeydownHandler = (e) => {
    // Prevent page scrolling for arrow keys + space during play
    if (PREVENT_DEFAULT_KEYS.has(e.code)) e.preventDefault();

    // Suppress key repeat: only fire on the initial press
    if (heldKeys.has(e.code)) return;

    const action = KEY_ACTION_MAP[e.code];
    if (!action) return;

    heldKeys.add(e.code);

    // Emit the action to the server via socket
    if (socket && socket.connected) {
      socket.emit('human-action', { action });
    }

    // Add a "YOU: ACTION_X" entry to the move trace
    addHumanMoveToTrace(action);
  };

  humanKeyupHandler = (e) => {
    heldKeys.delete(e.code);
  };

  window.addEventListener('keydown', humanKeydownHandler);
  window.addEventListener('keyup', humanKeyupHandler);
}

// Remove keyboard listeners and reset held-keys state. Called from stopGame(),
// 'run-summary', and 'session-end' handlers.
function cleanupHumanPlay() {
  if (humanKeydownHandler) {
    window.removeEventListener('keydown', humanKeydownHandler);
    humanKeydownHandler = null;
  }
  if (humanKeyupHandler) {
    window.removeEventListener('keyup', humanKeyupHandler);
    humanKeyupHandler = null;
  }
  heldKeys.clear();
}

// Add a "YOU: ACTION_X" entry to the reasoning log panel for human moves.
function addHumanMoveToTrace(action) {
  const label = String(action).replace(/^ACTION_/, '');

  // Mirror the LLM path: status strip + export trace cover human runs too
  if (lastActionEl) lastActionEl.textContent = label;
  if (state.traceLog.length < 500) {
    state.traceLog.push({
      tick: state.liveGameState?.tick || 0,
      score: state.liveGameState?.score || 0,
      action,
      human: true
    });
  }

  if (!reasoningLog) return;
  const entry = document.createElement('div');
  entry.className = 'reasoning-entry human-entry';

  const youLine = document.createElement('div');
  youLine.className = 'narration';
  youLine.textContent = 'YOU';

  const actDiv = document.createElement('div');
  actDiv.className = 'action fast';
  actDiv.textContent = `→ ${label}`;

  entry.append(youLine, actDiv);
  reasoningLog.insertBefore(entry, reasoningLog.firstChild);

  // Keep only last 20 entries (same trim as LLM reasoning entries)
  while (reasoningLog.children.length > 20) {
    reasoningLog.removeChild(reasoningLog.lastChild);
  }
}

// ─── Mid-run steering ────────────────────────────────────────────────────────

// Send a new directive to the live model run. The server sanitizes it and swaps
// it into the prompt for the model's next decision; the strategy-updated socket
// event then refreshes the banner + trace for every tab watching this run.
async function sendSteer() {
  const text = (steerInput?.value || '').trim();
  if (!text || !state.processId) return;
  if (steerSendBtn) steerSendBtn.disabled = true;
  try {
    const response = await fetch('/api/game/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processId: state.processId, strategy: text })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to steer');
    if (steerInput) steerInput.value = '';
    trackUx('run_steered', { length: text.length }, {}, {
      eventFamily: 'clickthrough',
      gameId: state.selectedGame?.id,
      modelId: state.selectedModel
    });
  } catch (error) {
    console.error('[App] Error steering run:', error);
    trackUx('run_steer_failed', { message: error.message });
  } finally {
    if (steerSendBtn) steerSendBtn.disabled = false;
  }
}

// Log the steering pivot in the move trace so the narration shows where the
// player redirected the model.
function addSteerToTrace(strategy) {
  if (state.traceLog.length < 500) {
    state.traceLog.push({
      tick: state.liveGameState?.tick || 0,
      steer: strategy || null,
      human: true
    });
  }
  if (!reasoningLog) return;
  const entry = document.createElement('div');
  entry.className = 'reasoning-entry human-entry steer-entry';
  const youLine = document.createElement('div');
  youLine.className = 'narration';
  youLine.textContent = strategy ? `YOU steered: "${strategy}"` : 'YOU cleared the strategy';
  entry.appendChild(youLine);
  reasoningLog.insertBefore(entry, reasoningLog.firstChild);
  while (reasoningLog.children.length > 20) {
    reasoningLog.removeChild(reasoningLog.lastChild);
  }
}

// Utility function
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : text;
  return div.innerHTML;
}

let searchTelemetryTimer = null;
function trackSearch(query, resultCount) {
  if (searchTelemetryTimer) clearTimeout(searchTelemetryTimer);
  searchTelemetryTimer = setTimeout(() => {
    trackUx('game_search', {
      queryLength: query.length,
      resultCount
    }, {
      query_length: query.length,
      result_count: resultCount
    }, { eventFamily: 'clickthrough' });
  }, 400);
}

function trackUx(eventType, payload = {}, metrics = {}, options = {}) {
  if (typeof window.telemetryTrack !== 'function') return;
  window.telemetryTrack(eventType, payload, metrics, options);
}

// Start the app
init();
