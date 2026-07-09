const fs = require('fs');
const path = require('path');
const { MODELS } = require('./models');
const { getCachedClassification } = require('./game-classifier');
const { getClassDefaults } = require('./class-defaults');

const DEFAULT_GAME_COUNT = 3;
const MIN_SURVIVAL_TICKS = 50;
const NIL_LOOP_THRESHOLD = 3;

const DEFAULT_STRATEGIES = [
  {
    id: 'safe',
    label: 'Play it safe',
    text: 'Play defensively. Keep your distance from enemies, avoid danger, and prioritize staying alive over scoring.'
  },
  {
    id: 'points',
    label: 'Go for points',
    text: 'Be aggressive about scoring. Collect every resource and pursue points even if it means taking some risk.'
  },
  {
    id: 'puzzle',
    label: 'Solve the puzzle',
    text: 'Move deliberately and plan ahead. Work toward the exit or goal step by step without wasting moves.'
  }
];

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readFeaturedIds() {
  const featuredPath = path.join(__dirname, '..', 'data', 'featured.json');
  const data = readJson(featuredPath, { featured: [] });
  return Array.isArray(data.featured)
    ? data.featured.map(Number).filter(Number.isInteger)
    : [];
}

function readGameRegistry(root = projectRoot()) {
  const csvPath = path.join(root, 'examples', 'all_games_sp.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
  const registry = new Map();

  for (const line of lines) {
    const [idPart, filePart] = line.trim().split(',');
    const id = Number(idPart);
    const file = (filePart || '').trim();
    if (!Number.isInteger(id) || !file) continue;
    const name = path.basename(file, '.txt');
    const category = file.includes('gridphysics') ? 'gridphysics' : 'contphysics';
    registry.set(id, { id, name, file, category });
  }

  return registry;
}

function loadGameConfig(gameId) {
  const configPath = path.join(__dirname, '..', 'data', 'games', `${gameId}.json`);
  return readJson(configPath, {});
}

function levelIdsForGame(game, root = projectRoot()) {
  const levels = [];
  for (let level = 0; level < 5; level++) {
    const levelPath = path.join(root, game.file.replace('.txt', `_lvl${level}.txt`));
    if (fs.existsSync(levelPath)) levels.push(level);
  }
  return levels.length > 0 ? levels : [0, 1, 2, 3, 4];
}

function sanitizeRunPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function boundedGameCount(requested, available) {
  const count = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_GAME_COUNT;
  return Math.min(count, available);
}

function normalizeStrategies(strategies) {
  return strategies.map((strategy, index) => {
    if (typeof strategy === 'string') {
      return {
        id: `strategy-${index}`,
        label: `Strategy ${index + 1}`,
        text: strategy
      };
    }
    return {
      id: strategy.id || `strategy-${index}`,
      label: strategy.label || `Strategy ${index + 1}`,
      text: strategy.text || ''
    };
  }).filter(strategy => strategy.text.trim().length > 0);
}

function buildArcadeEvalPlan(options = {}) {
  const root = options.projectRoot || projectRoot();
  const registry = readGameRegistry(root);
  const featuredIds = Array.isArray(options.gameIds) ? options.gameIds.map(Number) : readFeaturedIds();
  const count = boundedGameCount(options.gameCount, featuredIds.length);
  const gameIds = featuredIds.slice(0, count);
  const strategies = normalizeStrategies(options.strategies || DEFAULT_STRATEGIES);
  const models = (options.models || MODELS.filter(model => model.featured)).map(model => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    fallback: model.fallback || null,
    description: model.description,
    speed: model.speed,
    cost: model.cost
  }));

  const games = gameIds.map(gameId => {
    const registryEntry = registry.get(gameId) || { id: gameId, name: `game-${gameId}`, file: '', category: 'unknown' };
    const config = loadGameConfig(gameId);
    const levels = registryEntry.file ? levelIdsForGame(registryEntry, root) : [0];
    const classification = config.classification || getCachedClassification(gameId);
    const requestedLevelId = Number.parseInt(options.levelId, 10);
    const levelId = Number.isInteger(requestedLevelId) && levels.includes(requestedLevelId)
      ? requestedLevelId
      : (levels.includes(0) ? 0 : levels[0]);
    return {
      id: gameId,
      name: config.gameName || registryEntry.name,
      file: registryEntry.file,
      category: registryEntry.category,
      classification: classification || null,
      levelIds: levels,
      levelId,
      llmSettings: config.llmSettings || {}
    };
  });

  const cases = [];
  for (const game of games) {
    for (const model of models) {
      strategies.forEach((strategy, strategyIndex) => {
        const runId = [
          `arcade-g${game.id}`,
          `l${game.levelId}`,
          sanitizeRunPart(model.id),
          `s${strategyIndex}`
        ].join('-');
        cases.push({
          runId,
          gameId: game.id,
          gameName: game.name,
          archetype: game.classification?.archetype || null,
          levelId: game.levelId,
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          fallback: model.fallback,
          strategyId: strategy.id,
          strategyLabel: strategy.label,
          strategy: strategy.text
        });
      });
    }
  }

  const byArchetype = {};
  for (const game of games) {
    const archetype = game.classification?.archetype || 'unclassified';
    byArchetype[archetype] = byArchetype[archetype] || { games: [], caseCount: 0 };
    byArchetype[archetype].games.push(game.id);
  }
  for (const evalCase of cases) {
    const archetype = evalCase.archetype || 'unclassified';
    if (byArchetype[archetype]) byArchetype[archetype].caseCount += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    minSurvivalTicks: MIN_SURVIVAL_TICKS,
    nilLoopThreshold: NIL_LOOP_THRESHOLD,
    gameIds: games.map(game => game.id),
    modelIds: models.map(model => model.id),
    games,
    models,
    strategies,
    byArchetype,
    cases
  };
}

function hasNilActionLoop(actions = [], threshold = NIL_LOOP_THRESHOLD) {
  let runLength = 0;
  for (const action of actions) {
    if (action === 'ACTION_NIL') {
      runLength += 1;
      if (runLength >= threshold) return true;
    } else {
      runLength = 0;
    }
  }
  return false;
}

function toSet(values, mapper = value => value) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return new Set(values.map(mapper));
}

function filterEvalCases(plan, filters = {}) {
  const gameIds = toSet(filters.gameIds, Number);
  const modelIds = toSet(filters.modelIds, String);
  const strategyIds = toSet(filters.strategyIds, String);
  const maxCases = Number.isInteger(filters.maxCases) && filters.maxCases > 0
    ? filters.maxCases
    : null;

  const filtered = plan.cases.filter(evalCase => {
    if (gameIds && !gameIds.has(evalCase.gameId)) return false;
    if (modelIds && !modelIds.has(evalCase.modelId)) return false;
    if (strategyIds && !strategyIds.has(evalCase.strategyId)) return false;
    return true;
  });

  return maxCases ? filtered.slice(0, maxCases) : filtered;
}

function normalizeEvalResult(evalCase, summary = {}, options = {}) {
  // Per-class thresholds: explicit options win, then the archetype's eval
  // entry in class-defaults.json, then the global constants.
  const classEval = evalCase.archetype ? getClassDefaults(evalCase.archetype).eval || {} : {};
  const minSurvivalTicks = options.minSurvivalTicks || classEval.minSurvivalTicks || MIN_SURVIVAL_TICKS;
  const nilLoopThreshold = options.nilLoopThreshold || classEval.nilLoopThreshold || NIL_LOOP_THRESHOLD;
  const ticks = Number(summary.ticks || 0);
  const actions = Array.isArray(summary.actions) ? summary.actions : [];
  const winner = summary.winner || null;
  const won = summary.won === true || winner === 'PLAYER_WINS';

  return {
    runId: evalCase.runId,
    gameId: evalCase.gameId,
    gameName: evalCase.gameName,
    archetype: evalCase.archetype || null,
    levelId: evalCase.levelId,
    modelId: evalCase.modelId,
    modelName: evalCase.modelName,
    provider: summary.provider || evalCase.provider,
    modelUsed: summary.modelUsed || evalCase.modelId,
    fallback: evalCase.fallback || null,
    strategyId: evalCase.strategyId,
    strategyLabel: evalCase.strategyLabel,
    finalScore: Number(summary.finalScore ?? summary.score ?? 0),
    winner,
    won,
    ticks,
    decisions: Number(summary.decisions || actions.length || 0),
    actions,
    adherence: summary.adherence || { label: 'No strategy', mentioned: 0, total: 0, keywords: [] },
    highlights: Array.isArray(summary.highlights) ? summary.highlights : [],
    nilActionLoop: summary.nilActionLoop === true || hasNilActionLoop(actions, nilLoopThreshold),
    survivedMinTicks: ticks > minSurvivalTicks,
    recordedAt: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_GAME_COUNT,
  MIN_SURVIVAL_TICKS,
  NIL_LOOP_THRESHOLD,
  DEFAULT_STRATEGIES,
  buildArcadeEvalPlan,
  filterEvalCases,
  normalizeEvalResult,
  hasNilActionLoop
};
