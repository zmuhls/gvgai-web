// GVGAI LLM Frontend - Main Application

const socket = io();

// Application state
const state = {
  games: [],
  models: [],
  selectedGame: null,
  selectedModel: null,
  selectedLevel: 0,
  processId: null
};

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
  setupEventListeners();
  setupWebSocket();
}

// Load games from API
async function loadGames() {
  try {
    const response = await fetch('/api/games');
    state.games = await response.json();
    console.log(`[App] Loaded ${state.games.length} games`);
    renderGames(state.games);
  } catch (error) {
    console.error('[App] Failed to load games:', error);
    alert('Failed to load games. Please refresh the page.');
  }
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
    <div class="game-card" data-game-id="${game.id}">
      <span class="category">${game.category}</span>
      <h3>${game.name}</h3>
      <p class="levels">${game.levels.length} levels</p>
    </div>
  `).join('');

  // Add click handlers
  document.querySelectorAll('.game-card').forEach(card => {
    card.addEventListener('click', () => selectGame(parseInt(card.dataset.gameId)));
  });
}

// Render models dropdown
function renderModels(models) {
  modelSelect.innerHTML = models.map(model => `
    <option value="${model.id}">${model.name} - ${model.description}</option>
  `).join('');
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

  console.log('[App] Starting game:', {
    game: state.selectedGame.name,
    model,
    level
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
        model
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to start game');
    }
    state.processId = data.processId;
    state.selectedModel = model;

    console.log('[App] Game started:', data);

    // Show game viewer
    document.getElementById('current-game-name').textContent = state.selectedGame.name;
    reasoningLog.innerHTML = '';
    gameEndMessage.classList.add('hidden');
    showStep(gameViewer);
  } catch (error) {
    console.error('[App] Error starting game:', error);
    alert('Failed to start game: ' + error.message);
  } finally {
    startGameBtn.disabled = false;
    startGameBtn.textContent = 'Start Game';
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
    const filtered = state.games.filter(g =>
      g.name.toLowerCase().includes(search)
    );
    renderGames(filtered);
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

    // Add reasoning entry
    const entry = document.createElement('div');
    entry.className = 'reasoning-entry';

    const timing = data.elapsed > 50 ? 'timeout' : (data.elapsed > 40 ? 'slow' : 'fast');

    entry.innerHTML = `
      <div class="prompt">${escapeHtml(data.prompt.substring(0, 200))}...</div>
      <div class="response">${escapeHtml(data.response || '(timeout)')}</div>
      <div class="action ${timing}">→ ${data.action} (${data.elapsed}ms)</div>
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

  // Full session end (all levels done)
  socket.on('session-end', (data) => {
    console.log('[App] Session ended:', data);

    const lastData = state.lastLevelData || {};
    document.getElementById('final-score').textContent = lastData.score || 0;
    document.getElementById('final-result').textContent =
      lastData.winner === 'PLAYER_WINS' ? 'Victory!' :
      lastData.winner === 'PLAYER_LOSES' ? 'Defeat' :
      data.levelsPlayed ? `${data.levelsPlayed} levels played` : 'Done';

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

// Utility function
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Start the app
init();
