// GVGAI LLM Frontend - Main Application

const socket = io();

// Application state
const state = {
  games: [],
  models: [],
  selectedGame: null,
  selectedModel: null,
  selectedLevel: 0,
  processId: null,
  showingAllGames: false,
  lastSummary: null
};

// Preset strategy cards — tap to pre-fill the editable text box
const STRATEGY_PRESETS = [
  { label: 'Play it safe', text: 'Play defensively. Keep your distance from enemies, avoid danger, and prioritize staying alive over scoring.' },
  { label: 'Go for points', text: 'Be aggressive about scoring. Collect every resource and pursue points even if it means taking some risk.' },
  { label: 'Hunt enemies', text: 'Seek out and attack enemies whenever you can. Move toward threats and use your attack to clear them.' },
  { label: 'Solve the puzzle', text: 'Move deliberately and plan ahead. Work toward the exit or goal step by step without wasting moves.' }
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

// Arcade-specific elements
const strategyCards = document.getElementById('strategy-cards');
const strategyText = document.getElementById('strategy-text');
const toggleBrowseAllBtn = document.getElementById('toggle-browse-all');
const gamesModeLabel = document.getElementById('games-mode-label');
const strategyActive = document.getElementById('strategy-active');
const summaryStrategy = document.getElementById('summary-strategy');
const summaryAdherence = document.getElementById('summary-adherence');
const summaryHighlights = document.getElementById('summary-highlights');

// Additional stat elements
const scoreEl = document.getElementById('score');
const healthEl = document.getElementById('health');
const maxHealthEl = document.getElementById('max-health');
const tickEl = document.getElementById('tick');

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
    state.games = await response.json();
    const featuredCount = state.games.filter(g => g.featured).length;
    console.log(`[App] Loaded ${state.games.length} games (${featuredCount} featured)`);
    renderCurrentGameList();
  } catch (error) {
    console.error('[App] Failed to load games:', error);
    alert('Failed to load games. Please refresh the page.');
  }
}

// Render featured-only or all games depending on the current toggle
function renderCurrentGameList() {
  const featured = state.games.filter(g => g.featured);
  // Show featured first when there are any; otherwise fall back to all
  renderGames(state.showingAllGames || featured.length === 0 ? state.games : featured);
}

// Render the preset strategy cards
function renderStrategyCards() {
  if (!strategyCards) return;
  strategyCards.innerHTML = STRATEGY_PRESETS.map((p, i) => `
    <button type="button" class="strategy-card" data-strategy-idx="${i}">${escapeHtml(p.label)}</button>
  `).join('');
  strategyCards.querySelectorAll('.strategy-card').forEach(card => {
    card.addEventListener('click', () => {
      const preset = STRATEGY_PRESETS[parseInt(card.dataset.strategyIdx)];
      strategyText.value = preset.text;
      strategyCards.querySelectorAll('.strategy-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });
}

// Load models from API
async function loadModels() {
  try {
    const response = await fetch('/api/models');
    state.models = await response.json();
    console.log(`[App] Loaded ${state.models.length} models`);
    renderModels(state.models);
  } catch (error) {
    console.error('[App] Failed to load models:', error);
  }
}

// Render games grid
function renderGames(games) {
  gamesGrid.innerHTML = games.map(game => `
    <div class="game-card${game.featured ? ' featured' : ''}" data-game-id="${game.id}">
      ${game.featured ? '<span class="featured-star">★ Featured</span>' : `<span class="category">${escapeHtml(game.category)}</span>`}
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

  console.log('[App] Starting game:', {
    game: state.selectedGame.name,
    model,
    level,
    strategy: strategy || '(none)'
  });

  try {
    startGameBtn.disabled = true;
    startGameBtn.textContent = 'Starting...';

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

    console.log('[App] Game started:', data);

    // Show game viewer
    document.getElementById('current-game-name').textContent = state.selectedGame.name;
    reasoningLog.innerHTML = '';
    state.lastSummary = null;
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
    alert('Failed to start game: ' + error.message);
  } finally {
    startGameBtn.disabled = false;
    startGameBtn.textContent = 'Start Playing';
  }
}

// Stop game
async function stopGame() {
  if (!state.processId) return;

  try {
    await fetch('/api/game/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processId: state.processId })
    });

    console.log('[App] Game stopped');
    state.processId = null;
    showStep(gameSelector);
  } catch (error) {
    console.error('[App] Error stopping game:', error);
  }
}

// Show/hide steps
function showStep(step) {
  [gameSelector, modelSelector, gameViewer].forEach(s => s.classList.remove('active'));
  step.classList.add('active');
}

// Event listeners
function setupEventListeners() {
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
  });

  // Toggle between featured-only and the full browsable list
  toggleBrowseAllBtn.addEventListener('click', () => {
    state.showingAllGames = !state.showingAllGames;
    if (state.showingAllGames) {
      gamesModeLabel.textContent = 'All 122 games';
      toggleBrowseAllBtn.textContent = '★ Show featured only';
      gameSearch.classList.remove('hidden');
    } else {
      gamesModeLabel.textContent = 'Featured games';
      toggleBrowseAllBtn.textContent = 'Browse all 122 →';
      gameSearch.classList.add('hidden');
      gameSearch.value = '';
    }
    renderCurrentGameList();
  });

  startGameBtn.addEventListener('click', startGame);
  stopGameBtn.addEventListener('click', stopGame);
  backToGamesBtn.addEventListener('click', () => showStep(gameSelector));
  playAgainBtn.addEventListener('click', () => {
    showStep(modelSelector);
    gameEndMessage.classList.add('hidden');
  });
}

// WebSocket handlers
function setupWebSocket() {
  socket.on('connect', () => {
    console.log('[App] Connected to server');
    console.log('[App] Socket ID:', socket.id);
    console.log('[App] Transport:', socket.io.engine.transport.name);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[App] Disconnected from server:', reason);
  });

  socket.on('connect_error', (error) => {
    console.error('[App] Connection error:', error);
  });

  socket.on('llm-reasoning', (data) => {
    console.log('[App] LLM reasoning:', data);

    // Update game state overlay
    if (scoreEl) scoreEl.textContent = data.gameState?.score || 0;
    if (healthEl) healthEl.textContent = data.gameState?.health || 0;
    if (tickEl) tickEl.textContent = data.gameState?.tick || 0;

    // Add narration entry: clean rationale up top, raw details collapsible
    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';

    const timing = data.elapsed > 800 ? 'slow' : 'fast';
    const narration = data.reason || data.response || '(no rationale)';
    const followsBadge = sharesStrategyKeyword(data.reason, data.strategy)
      ? '<span class="strategy-badge">↳ following your strategy</span>'
      : '';

    entry.innerHTML = `
      <div class="narration">${escapeHtml(narration)}</div>
      ${followsBadge}
      <div class="action ${timing}">→ ${escapeHtml(data.action)} (${data.elapsed}ms${data.provider ? ' · ' + escapeHtml(data.provider) : ''})</div>
      <details class="raw-toggle">
        <summary>details</summary>
        <div class="response">${escapeHtml(data.response || '(no response)')}</div>
      </details>
    `;

    reasoningLog.insertBefore(entry, reasoningLog.firstChild);

    // Keep only last 20 entries
    while (reasoningLog.children.length > 20) {
      reasoningLog.removeChild(reasoningLog.lastChild);
    }
  });

  socket.on('game-frame', (data) => {
    const now = Date.now();
    const latency = now - data.timestamp;
    console.log(`[App] Game frame received: ${data.image.length} bytes, latency: ${latency}ms`);

    // Update canvas with game screenshot
    const img = new Image();
    img.onload = () => {
      const ctx = gameCanvas.getContext('2d');
      // Only resize canvas when dimensions change (avoids flicker)
      if (gameCanvas.width !== img.width || gameCanvas.height !== img.height) {
        gameCanvas.width = img.width;
        gameCanvas.height = img.height;
      }
      ctx.drawImage(img, 0, 0);
    };
    img.onerror = () => {
      console.error('[App] Failed to load game frame image');
    };
    img.src = data.image;
  });

  socket.on('game-state', (data) => {
    // Update game state overlay (sent every tick)
    if (scoreEl) scoreEl.textContent = data.score || 0;
    if (healthEl) healthEl.textContent = data.health || 0;
    if (maxHealthEl && data.maxHealth) maxHealthEl.textContent = data.maxHealth;
    if (tickEl) tickEl.textContent = data.tick || 0;
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
      return `<li><span class="hl-action">${escapeHtml(h.action)}</span> — ${escapeHtml(h.reason || '')}${delta}</li>`;
    }).join('');
    summaryHighlights.innerHTML = `<h4>Key moves</h4><ul>${items}</ul>`;
    summaryHighlights.classList.remove('hidden');
  } else {
    summaryHighlights.classList.add('hidden');
  }
}

// Light client-side check for the per-move "following your strategy" badge.
// Honest: only shows when the model's rationale literally echoes a strategy word.
const BADGE_STOPWORDS = new Set(['the','and','for','with','your','you','this','that','play','playing','try','keep','make','get','move','moving','action','when','from','are','will','can','should','need','want','take','use','using','only','even','some','over','it','to','of','in','on','as','be','do','go']);
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

// Start the app
init();
