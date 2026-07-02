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
  lastSummary: null
};

// Preset strategy cards — tap to pre-fill the editable text box. Each preset
// lists the game archetypes (from /api/games) it suits best; on game select
// the cards re-rank so affine presets come first (never hidden).
const STRATEGY_PRESETS = [
  { label: 'Survive first', text: 'Play defensively. Keep distance from enemies, avoid danger, and prioritize staying alive over scoring.', archetypes: ['survivor', 'reflex-pilot', 'navigator'] },
  { label: 'Score test', text: 'Pursue points. Collect resources and take measured risks when a clear scoring route appears.', archetypes: ['collector', 'shooter-lane'] },
  { label: 'Threat test', text: 'Seek out enemies when the path is clear. Attack threats and retreat when health or position gets worse.', archetypes: ['shooter-roaming', 'shooter-lane', 'chaser'] },
  { label: 'Goal test', text: 'Move deliberately and plan ahead. Work toward the exit or goal step by step without wasting moves.', archetypes: ['pusher-puzzle', 'chaser', 'navigator', 'collector'] }
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
  { id: 0, name: 'aliens', category: 'gridphysics', archetype: 'shooter-lane', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true },
  { id: 32, name: 'doorkoban', category: 'gridphysics', archetype: 'pusher-puzzle', pace: 'deliberate', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true },
  { id: 4, name: 'bait', category: 'gridphysics', archetype: 'pusher-puzzle', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true },
  { id: 11, name: 'boulderdash', category: 'gridphysics', archetype: 'collector', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true },
  { id: 18, name: 'chase', category: 'gridphysics', archetype: 'collector', pace: 'reactive', levels: [0, 1, 2, 3, 4], levelCount: 5, featured: true }
];

const PREVIEW_MODELS = [
  {
    id: 'gpt-oss:120b',
    name: 'GPT-OSS 120B',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'deepseek-v3.1:671b',
    name: 'DeepSeek v3.1',
    description: 'Open-weight model',
    featured: true
  },
  {
    id: 'qwen3-coder:480b',
    name: 'Qwen3 Coder 480B',
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
const apiKeyInput = document.getElementById('api-key');
const startGameBtn = document.getElementById('start-game');
const stopGameBtn = document.getElementById('stop-game');
const backToGamesBtn = document.getElementById('back-to-games');
const playAgainBtn = document.getElementById('play-again');
const gameCanvas = document.getElementById('game-canvas');
const reasoningLog = document.getElementById('reasoning-log');
const gameEndMessage = document.getElementById('game-end-message');
const frameStatus = document.getElementById('frame-status');

// Arcade-specific elements
const strategyCards = document.getElementById('strategy-cards');
const strategyText = document.getElementById('strategy-text');
const toggleBrowseAllBtn = document.getElementById('toggle-browse-all');
const gamesModeLabel = document.getElementById('games-mode-label');
const strategyActive = document.getElementById('strategy-active');
const summaryStrategy = document.getElementById('summary-strategy');
const summaryAdherence = document.getElementById('summary-adherence');
const summaryHighlights = document.getElementById('summary-highlights');
const strategyWarn = document.getElementById('strategy-warn');
const unfoldRules = document.getElementById('unfold-rules');
const unfoldChips = document.getElementById('unfold-chips');

// Additional stat elements
const scoreEl = document.getElementById('score');
const healthEl = document.getElementById('health');
const maxHealthEl = document.getElementById('max-health');
const tickEl = document.getElementById('tick');
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
}

// Load games from API
async function loadGames() {
  try {
    const response = await fetch('/api/games');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.games = await response.json();
    const featuredCount = state.games.filter(g => g.featured).length;
    console.log(`[App] Loaded ${state.games.length} games (${featuredCount} featured)`);
    trackUx('games_loaded', { total: state.games.length, featured: featuredCount }, {
      total_games: state.games.length,
      featured_games: featuredCount
    });
    renderCurrentGameList();
  } catch (error) {
    console.error('[App] Failed to load games:', error);
    trackUx('games_load_failed', { message: error.message });
    state.games = PREVIEW_GAMES;
    renderCurrentGameList();
  }
}

// Render featured-only or all games depending on the current toggle
function renderCurrentGameList() {
  const featured = state.games.filter(g => g.featured);
  // Show featured first when there are any; otherwise fall back to all
  renderGames(state.showingAllGames || featured.length === 0 ? state.games : featured);
}

// Render the preset strategy cards, affine-to-archetype presets first
function renderStrategyCards(archetype) {
  if (!strategyCards) return;
  const ranked = STRATEGY_PRESETS
    .map((preset, originalIdx) => ({ preset, originalIdx }))
    .sort((a, b) => {
      const aAffine = archetype && (a.preset.archetypes || []).includes(archetype) ? 0 : 1;
      const bAffine = archetype && (b.preset.archetypes || []).includes(archetype) ? 0 : 1;
      return aAffine - bAffine || a.originalIdx - b.originalIdx;
    });
  strategyCards.innerHTML = ranked.map(({ preset, originalIdx }) => `
    <button type="button" class="strategy-card" data-strategy-idx="${originalIdx}">${escapeHtml(preset.label)}</button>
  `).join('');
  strategyCards.querySelectorAll('.strategy-card').forEach(card => {
    card.addEventListener('click', () => {
      const preset = STRATEGY_PRESETS[parseInt(card.dataset.strategyIdx)];
      strategyText.value = preset.text;
      strategyCards.querySelectorAll('.strategy-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      trackUx('strategy_selected', { label: preset.label }, {}, { eventFamily: 'clickthrough' });
    });
  });
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
    <div class="game-card${game.featured ? ' featured' : ''}" data-game-id="${game.id}">
      <div class="game-card-meta">
        <span>${String(game.id).padStart(3, '0')}</span>
        <span>${escapeHtml(game.archetype || game.category)}</span>
      </div>
      <h3>${escapeHtml(game.name)}</h3>
      <p class="levels">${game.levels.length} levels</p>
    </div>
  `).join('');

  // Add click handlers
  gamesGrid.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => selectGame(parseInt(card.dataset.gameId)));
  });
}

// Render models dropdown (featured frontier models first, one selected by default)
function renderModels(models) {
  modelSelect.innerHTML = models.map(model => `
    <option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}${model.featured ? ' ★' : ''} — ${escapeHtml(model.description)}</option>
  `).join('');
  const defaultModel = models.find(m => m.featured) || models[0];
  if (defaultModel) modelSelect.value = defaultModel.id;
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

  // Show model selector
  showStep(modelSelector);
}

// Start game
async function startGame() {
  if (!state.selectedGame) {
    alert('Please select a game');
    return;
  }

  const model = modelSelect.value;
  const level = parseInt(levelSelect.value);
  const strategy = (strategyText?.value || '').trim();
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
    model,
    level,
    strategy: strategy || '(none)'
  });

  try {
    startGameBtn.disabled = true;
    startGameBtn.textContent = 'Starting run...';

    const response = await fetch('/api/game/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: state.selectedGame.id,
        levelId: level,
        model,
        strategy
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

    showStep(gameViewer);
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
    startGameBtn.textContent = 'Run the Cabinet';
  }
}

// Stop game
async function stopGame() {
  if (!state.processId) return;

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
    item.classList.toggle('active', item.id === sectionId);
  });

  navLinks.forEach(link => {
    link.classList.toggle('active', link.dataset.target === sectionId);
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
      gamesModeLabel.textContent = 'All 122 cabinets';
      toggleBrowseAllBtn.textContent = '★ Show featured only';
      gameSearch.classList.remove('hidden');
    } else {
      gamesModeLabel.textContent = 'Featured cabinets';
      toggleBrowseAllBtn.textContent = 'Browse all 122 →';
      gameSearch.classList.add('hidden');
      gameSearch.value = '';
    }
    renderCurrentGameList();
    trackUx('catalog_mode_changed', {
      showingAllGames: state.showingAllGames
    }, {}, { eventFamily: 'clickthrough' });
  });

  startGameBtn.addEventListener('click', startGame);
  stopGameBtn.addEventListener('click', stopGame);
  if (strategyText) strategyText.addEventListener('input', updateStrategyWarn);
  backToGamesBtn.addEventListener('click', () => showStep(gameSelector));
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
    console.log('[App] LLM reasoning:', data);

    // Update game state overlay
    if (scoreEl) scoreEl.textContent = data.gameState?.score || 0;
    if (healthEl) healthEl.textContent = data.gameState?.health || 0;
    if (tickEl) tickEl.textContent = data.gameState?.tick || 0;

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

    if (sharesStrategyKeyword(data.reason, data.strategy)) {
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
    queueGameFrame(data);
  });

  socket.on('game-state', (data) => {
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
    console.log('[App] Run summary:', data);
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
    console.log('[App] Session ended:', data);

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
    console.error('[App] LLM error:', data);

    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';
    entry.innerHTML = `
      <div class="action timeout">API Error (${data.status}): ${escapeHtml(data.message?.substring(0, 200) || 'Unknown error')}</div>
    `;
    reasoningLog.insertBefore(entry, reasoningLog.firstChild);
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
  if (sharesStrategyKeyword(data.reason, data.strategy)) {
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
