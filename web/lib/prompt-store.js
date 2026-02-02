const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const GAMES_DIR = path.join(DATA_DIR, 'games');
const INDEX_PATH = path.join(TEMPLATES_DIR, '_index.json');

// Ensure games directory exists
if (!fs.existsSync(GAMES_DIR)) {
  fs.mkdirSync(GAMES_DIR, { recursive: true });
}

// --- In-memory cache for game loop performance (avoids disk reads every 400ms) ---
const CACHE_TTL_MS = 30000;
const _cache = {
  templates: new Map(),
  gameConfigs: new Map()
};

function getCachedTemplate(id) {
  const cached = _cache.templates.get(id);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = getTemplate(id);
  if (data) {
    _cache.templates.set(id, { data, loadedAt: Date.now() });
  }
  return data;
}

function getCachedGameConfig(gameId) {
  const cached = _cache.gameConfigs.get(gameId);
  if (cached && (Date.now() - cached.loadedAt) < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = getGameConfig(gameId);
  if (data) {
    _cache.gameConfigs.set(gameId, { data, loadedAt: Date.now() });
  }
  return data;
}

function invalidateCache() {
  _cache.templates.clear();
  _cache.gameConfigs.clear();
}

// --- Template operations ---

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  } catch {
    return { templates: [] };
  }
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n');
}

function listTemplates() {
  return readIndex().templates;
}

function getTemplate(id) {
  const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTemplate(template) {
  const now = new Date().toISOString();
  if (!template.createdAt) template.createdAt = now;
  template.updatedAt = now;

  const filePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2) + '\n');

  // Update index
  const index = readIndex();
  const existing = index.templates.findIndex(t => t.id === template.id);
  const entry = { id: template.id, name: template.name, layer: template.layer, category: template.category };
  if (existing >= 0) {
    index.templates[existing] = entry;
  } else {
    index.templates.push(entry);
  }
  writeIndex(index);
  invalidateCache();
  return template;
}

function deleteTemplate(id) {
  // Check if any game config references this template
  const gameConfigs = listGameConfigs();
  for (const gc of gameConfigs) {
    if (gc.systemTemplateId === id) return { error: `Template referenced by game ${gc.gameName || gc.gameId}` };
    if (gc.gameContext?.templateId === id) return { error: `Template referenced by game ${gc.gameName || gc.gameId}` };
    const progContexts = gc.progressionContexts || {};
    for (const lvl of Object.values(progContexts)) {
      if (lvl?.templateId === id) return { error: `Template referenced by game ${gc.gameName || gc.gameId}` };
    }
  }

  const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }

  const index = readIndex();
  index.templates = index.templates.filter(t => t.id !== id);
  writeIndex(index);
  invalidateCache();
  return { ok: true };
}

// --- Game config operations ---

function listGameConfigs() {
  try {
    const files = fs.readdirSync(GAMES_DIR).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(GAMES_DIR, f), 'utf-8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getGameConfig(gameId) {
  const filePath = path.join(GAMES_DIR, `${gameId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveGameConfig(config) {
  config.updatedAt = new Date().toISOString();
  const filePath = path.join(GAMES_DIR, `${config.gameId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  invalidateCache();
  return config;
}

function deleteGameConfig(gameId) {
  const filePath = path.join(GAMES_DIR, `${gameId}.json`);
  try {
    fs.unlinkSync(filePath);
    invalidateCache();
    return { ok: true };
  } catch {
    return { error: 'Config not found' };
  }
}

// --- Prompt resolution (runtime) ---

function defaultPromptConfig() {
  const systemTemplate = getCachedTemplate('default-system');
  return {
    systemContent: systemTemplate ? systemTemplate.content : 'You are playing a 2D game. Respond with ONE action name.',
    gameContent: null,
    levelContent: null,
    llmSettings: { maxTokens: 100, temperature: 0.7 }
  };
}

function resolveGamePromptConfig(gameId, levelId) {
  const config = getCachedGameConfig(gameId);
  if (!config) return defaultPromptConfig();

  // Resolve system template
  let systemContent = null;
  if (config.systemTemplateId) {
    const tpl = getCachedTemplate(config.systemTemplateId);
    systemContent = tpl ? tpl.content : null;
  }
  if (!systemContent) {
    systemContent = defaultPromptConfig().systemContent;
  }

  // Resolve game context
  let gameContent = null;
  if (config.gameContext) {
    if (config.gameContext.customOverride) {
      gameContent = config.gameContext.customOverride;
    } else if (config.gameContext.templateId) {
      const tpl = getCachedTemplate(config.gameContext.templateId);
      gameContent = tpl ? tpl.content : null;
    }
  }

  // Resolve progression context for this level
  let levelContent = null;
  const progContexts = config.progressionContexts || {};
  const levelKey = String(levelId);
  if (progContexts[levelKey]) {
    if (progContexts[levelKey].customOverride) {
      levelContent = progContexts[levelKey].customOverride;
    } else if (progContexts[levelKey].templateId) {
      const tpl = getCachedTemplate(progContexts[levelKey].templateId);
      levelContent = tpl ? tpl.content : null;
    }
  }

  return {
    systemContent,
    gameContent,
    levelContent,
    gameName: config.gameName || null,
    llmSettings: config.llmSettings || { maxTokens: 100, temperature: 0.7 }
  };
}

module.exports = {
  listTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  listGameConfigs,
  getGameConfig,
  saveGameConfig,
  deleteGameConfig,
  resolveGamePromptConfig,
  invalidateCache
};
