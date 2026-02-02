// Prompt Dashboard - manages prompt templates and per-game configs

(function () {
  // State
  let games = [];
  let templates = [];
  let gameConfigs = []; // list of gameIds that have configs
  let activeEditor = null; // 'game' | 'template'
  let activeGameId = null;
  let activeTemplateId = null;

  // --- Navigation ---

  document.querySelectorAll('#main-nav .nav-link').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#main-nav .nav-link').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.target;
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      const section = document.getElementById(target);
      if (section) section.classList.add('active');

      // Load dashboard data when switching to it
      if (target === 'prompt-dashboard') {
        loadDashboardData();
      }
    });
  });

  // Sidebar tabs
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById(tab.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });

  // --- Data Loading ---

  async function loadDashboardData() {
    await Promise.all([loadGames(), loadTemplates(), loadGameConfigs()]);
    renderGamesList();
    renderTemplatesList();
  }

  async function loadGames() {
    try {
      const res = await fetch('/api/games');
      games = await res.json();
    } catch (e) {
      console.error('[Dashboard] Failed to load games:', e);
    }
  }

  async function loadTemplates() {
    try {
      const res = await fetch('/api/prompts/templates');
      templates = await res.json();
    } catch (e) {
      console.error('[Dashboard] Failed to load templates:', e);
    }
  }

  async function loadGameConfigs() {
    try {
      const res = await fetch('/api/prompts/games');
      gameConfigs = await res.json();
    } catch (e) {
      console.error('[Dashboard] Failed to load game configs:', e);
    }
  }

  // --- Rendering ---

  function renderGamesList() {
    const list = document.getElementById('dashboard-games-list');
    const configIds = new Set(gameConfigs.map(c => c.gameId));

    list.innerHTML = games.map(g => `
      <div class="sidebar-item ${activeGameId === g.id ? 'active' : ''}" data-game-id="${g.id}">
        <span class="config-indicator ${configIds.has(g.id) ? 'configured' : ''}"></span>
        <span class="sidebar-item-name">${escapeHtml(g.name)}</span>
        <span class="sidebar-item-meta">${g.category}</span>
      </div>
    `).join('');

    list.querySelectorAll('.sidebar-item').forEach(item => {
      item.addEventListener('click', () => {
        openGameEditor(parseInt(item.dataset.gameId));
      });
    });

    // Search
    const searchInput = document.getElementById('dashboard-game-search');
    searchInput.removeEventListener('input', filterGames);
    searchInput.addEventListener('input', filterGames);
  }

  function filterGames(e) {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#dashboard-games-list .sidebar-item').forEach(item => {
      const name = item.querySelector('.sidebar-item-name').textContent.toLowerCase();
      item.style.display = name.includes(q) ? '' : 'none';
    });
  }

  function renderTemplatesList() {
    const list = document.getElementById('dashboard-templates-list');

    const grouped = { system: [], game: [], progression: [] };
    templates.forEach(t => {
      const layer = grouped[t.layer] ? t.layer : 'system';
      grouped[layer].push(t);
    });

    let html = '';
    for (const [layer, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      html += `<div class="sidebar-group-label">${layer.toUpperCase()}</div>`;
      html += items.map(t => `
        <div class="sidebar-item ${activeTemplateId === t.id ? 'active' : ''}" data-template-id="${t.id}">
          <span class="layer-badge layer-${layer}">${layer[0].toUpperCase()}</span>
          <span class="sidebar-item-name">${escapeHtml(t.name)}</span>
        </div>
      `).join('');
    }

    list.innerHTML = html;

    list.querySelectorAll('.sidebar-item').forEach(item => {
      item.addEventListener('click', () => {
        openTemplateEditor(item.dataset.templateId);
      });
    });
  }

  // --- Game Config Editor ---

  async function openGameEditor(gameId) {
    activeGameId = gameId;
    activeTemplateId = null;
    activeEditor = 'game';

    const game = games.find(g => g.id === gameId);

    document.getElementById('editor-placeholder').classList.add('hidden');
    document.getElementById('template-editor').classList.add('hidden');
    document.getElementById('game-config-editor').classList.remove('hidden');
    document.getElementById('prompt-preview').classList.add('hidden');
    document.getElementById('editor-game-name').textContent = game ? game.name : `Game ${gameId}`;

    // Load config
    let config;
    try {
      const res = await fetch(`/api/prompts/games/${gameId}`);
      config = await res.json();
    } catch (e) {
      console.error('[Dashboard] Failed to load game config:', e);
      return;
    }

    // Populate system template dropdown
    const systemSelect = document.getElementById('editor-system-template');
    const systemTemplates = templates.filter(t => t.layer === 'system');
    systemSelect.innerHTML = systemTemplates.map(t =>
      `<option value="${t.id}" ${config.systemTemplateId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
    ).join('');

    // Populate game context template dropdown
    const gameContextSelect = document.getElementById('editor-game-context-template');
    const gameTemplates = templates.filter(t => t.layer === 'game');
    gameContextSelect.innerHTML = '<option value="">None (no game-specific context)</option>' +
      gameTemplates.map(t =>
        `<option value="${t.id}" ${config.gameContext?.templateId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
      ).join('');

    document.getElementById('editor-game-context-override').value = config.gameContext?.customOverride || '';

    // Level contexts
    const levelDiv = document.getElementById('editor-level-contexts');
    const levels = game ? game.levels : [0, 1, 2, 3, 4];
    const progContexts = config.progressionContexts || {};
    levelDiv.innerHTML = levels.map(lvl => `
      <div class="level-context-entry">
        <label class="sub-label">Level ${lvl + 1}</label>
        <textarea rows="2" data-level="${lvl}" placeholder="Level-specific tips...">${escapeHtml(progContexts[lvl]?.customOverride || '')}</textarea>
      </div>
    `).join('');

    // LLM settings
    document.getElementById('editor-max-tokens').value = config.llmSettings?.maxTokens || 100;
    document.getElementById('editor-temperature').value = config.llmSettings?.temperature ?? 0.7;

    renderGamesList();
  }

  // Save game config
  document.getElementById('save-game-config-btn').addEventListener('click', async () => {
    if (activeGameId == null) return;
    const game = games.find(g => g.id === activeGameId);

    const progressionContexts = {};
    document.querySelectorAll('#editor-level-contexts textarea').forEach(ta => {
      const lvl = ta.dataset.level;
      const val = ta.value.trim();
      if (val) {
        progressionContexts[lvl] = { templateId: null, customOverride: val };
      }
    });

    const config = {
      gameId: activeGameId,
      gameName: game ? game.name : null,
      systemTemplateId: document.getElementById('editor-system-template').value,
      gameContext: {
        templateId: document.getElementById('editor-game-context-template').value || null,
        customOverride: document.getElementById('editor-game-context-override').value.trim() || null
      },
      progressionContexts,
      llmSettings: {
        maxTokens: parseInt(document.getElementById('editor-max-tokens').value) || 100,
        temperature: parseFloat(document.getElementById('editor-temperature').value) ?? 0.7
      }
    };

    try {
      const res = await fetch(`/api/prompts/games/${activeGameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        await loadGameConfigs();
        renderGamesList();
        showToast('Game config saved');
      } else {
        const err = await res.json();
        alert('Save failed: ' + (err.error || 'Unknown error'));
      }
    } catch (e) {
      console.error('[Dashboard] Failed to save game config:', e);
    }
  });

  // Preview prompt
  document.getElementById('preview-prompt-btn').addEventListener('click', async () => {
    if (activeGameId == null) return;

    // Save first (so preview reflects current edits)
    document.getElementById('save-game-config-btn').click();

    // Small delay to let save complete
    await new Promise(r => setTimeout(r, 200));

    try {
      const res = await fetch('/api/prompts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: activeGameId, levelId: 0 })
      });
      const data = await res.json();
      const previewDiv = document.getElementById('prompt-preview');
      previewDiv.classList.remove('hidden');
      previewDiv.innerHTML = '<h4>Assembled Prompt Preview</h4>' +
        data.messages.map(m =>
          `<div class="preview-message"><span class="preview-role">${escapeHtml(m.role)}</span><pre>${escapeHtml(m.content)}</pre></div>`
        ).join('') +
        `<div class="preview-settings">max_tokens: ${data.llmSettings?.maxTokens || 100}, temperature: ${data.llmSettings?.temperature ?? 0.7}</div>`;
    } catch (e) {
      console.error('[Dashboard] Failed to preview prompt:', e);
    }
  });

  // --- Template Editor ---

  async function openTemplateEditor(templateId) {
    activeTemplateId = templateId;
    activeGameId = null;
    activeEditor = 'template';

    document.getElementById('editor-placeholder').classList.add('hidden');
    document.getElementById('game-config-editor').classList.add('hidden');
    document.getElementById('template-editor').classList.remove('hidden');

    if (templateId) {
      document.getElementById('template-editor-title').textContent = 'Edit Template';
      try {
        const res = await fetch(`/api/prompts/templates/${templateId}`);
        const tpl = await res.json();
        document.getElementById('editor-template-name').value = tpl.name || '';
        document.getElementById('editor-template-layer').value = tpl.layer || 'system';
        document.getElementById('editor-template-category').value = tpl.category || '';
        document.getElementById('editor-template-content').value = tpl.content || '';
        document.getElementById('delete-template-btn').classList.remove('hidden');
      } catch (e) {
        console.error('[Dashboard] Failed to load template:', e);
      }
    } else {
      // New template
      document.getElementById('template-editor-title').textContent = 'New Template';
      document.getElementById('editor-template-name').value = '';
      document.getElementById('editor-template-layer').value = 'game';
      document.getElementById('editor-template-category').value = '';
      document.getElementById('editor-template-content').value = '';
      document.getElementById('delete-template-btn').classList.add('hidden');
    }

    renderTemplatesList();
  }

  // New template button
  document.getElementById('new-template-btn').addEventListener('click', () => {
    openTemplateEditor(null);
  });

  // Save template
  document.getElementById('save-template-btn').addEventListener('click', async () => {
    const name = document.getElementById('editor-template-name').value.trim();
    const layer = document.getElementById('editor-template-layer').value;
    const category = document.getElementById('editor-template-category').value.trim();
    const content = document.getElementById('editor-template-content').value;

    if (!name || !content) {
      alert('Name and content are required');
      return;
    }

    try {
      let res;
      if (activeTemplateId) {
        res = await fetch(`/api/prompts/templates/${activeTemplateId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, layer, category, content })
        });
      } else {
        res = await fetch('/api/prompts/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, layer, category, content })
        });
      }

      if (res.ok) {
        const saved = await res.json();
        activeTemplateId = saved.id;
        await loadTemplates();
        renderTemplatesList();
        document.getElementById('delete-template-btn').classList.remove('hidden');
        document.getElementById('template-editor-title').textContent = 'Edit Template';
        showToast('Template saved');
      } else {
        const err = await res.json();
        alert('Save failed: ' + (err.error || 'Unknown error'));
      }
    } catch (e) {
      console.error('[Dashboard] Failed to save template:', e);
    }
  });

  // Delete template
  document.getElementById('delete-template-btn').addEventListener('click', async () => {
    if (!activeTemplateId) return;
    if (!confirm('Delete this template?')) return;

    try {
      const res = await fetch(`/api/prompts/templates/${activeTemplateId}`, { method: 'DELETE' });
      if (res.ok) {
        activeTemplateId = null;
        await loadTemplates();
        renderTemplatesList();
        document.getElementById('template-editor').classList.add('hidden');
        document.getElementById('editor-placeholder').classList.remove('hidden');
        showToast('Template deleted');
      } else {
        const err = await res.json();
        alert('Delete failed: ' + (err.error || 'Unknown error'));
      }
    } catch (e) {
      console.error('[Dashboard] Failed to delete template:', e);
    }
  });

  // --- Utilities ---

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showToast(msg) {
    let toast = document.getElementById('dashboard-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'dashboard-toast';
      toast.className = 'dashboard-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }
})();
