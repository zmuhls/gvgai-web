const express = require('express');
const fs = require('fs');
const path = require('path');

const { buildStrategicDigestFromFile } = require('../lib/vgdl-digest');
const { getCachedClassification } = require('../lib/game-classifier');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '../..');

// VGDL files are static, so cache each game's derived digest facets.
const digestCache = new Map();

// Resolve a game id to its VGDL file via the game registry CSV.
function resolveGameFile(gameId) {
  const csvPath = path.join(PROJECT_ROOT, 'examples/all_games_sp.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  for (const line of csvContent.trim().split('\n')) {
    const [id, filepath] = line.trim().split(',');
    if (Number.parseInt(id, 10) === gameId && filepath) {
      const file = filepath.trim();
      return { name: path.basename(file, '.txt'), file };
    }
  }
  return null;
}

function loadFeaturedSet() {
  try {
    const featuredPath = path.join(__dirname, '../data/featured.json');
    const { featured } = JSON.parse(fs.readFileSync(featuredPath, 'utf-8'));
    return new Set(Array.isArray(featured) ? featured : []);
  } catch {
    return new Set();
  }
}

router.get('/', (req, res) => {
  try {
    const csvPath = path.join(PROJECT_ROOT, 'examples/all_games_sp.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const featuredSet = loadFeaturedSet();

    const games = csvContent.trim().split('\n').map(line => {
      const trimmedLine = line.trim();
      const [id, filepath] = trimmedLine.split(',');
      const trimmedFilepath = filepath.trim();
      const filename = path.basename(trimmedFilepath, '.txt');
      const category = trimmedFilepath.includes('gridphysics') ? 'gridphysics' : 'contphysics';
      const levels = [];

      for (let i = 0; i < 5; i++) {
        const levelPath = path.join(PROJECT_ROOT, trimmedFilepath.replace('.txt', `_lvl${i}.txt`));
        if (fs.existsSync(levelPath)) levels.push(i);
      }

      if (levels.length === 0) levels.push(0, 1, 2, 3, 4);

      const gameId = Number.parseInt(id, 10);
      const classification = getCachedClassification(gameId);

      return {
        id: gameId,
        name: filename,
        file: trimmedFilepath,
        category,
        archetype: classification?.archetype || null,
        pace: classification?.pace || null,
        levels,
        levelCount: levels.length,
        featured: featuredSet.has(gameId)
      };
    });

    res.json(games);
  } catch (error) {
    console.error('Error loading games:', error);
    res.status(500).json({ error: 'Failed to load games' });
  }
});

// GET /api/games/:id/digest — the game's rules, derived straight from its VGDL,
// as discrete "unfold" facets for the prompting-field scaffold. All 122 games,
// zero authoring: the same vgdl-digest that seeds each game's customOverride.
router.get('/:id/digest', (req, res) => {
  try {
    const gameId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(gameId)) {
      return res.status(400).json({ error: 'Invalid game id' });
    }
    if (digestCache.has(gameId)) {
      return res.json(digestCache.get(gameId));
    }

    const game = resolveGameFile(gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    const vgdlPath = path.join(PROJECT_ROOT, game.file);
    if (!fs.existsSync(vgdlPath)) {
      return res.status(404).json({ error: 'VGDL file not found' });
    }

    const digest = buildStrategicDigestFromFile(vgdlPath, { gameId, gameName: game.name });
    const facets = {
      gameId,
      gameName: digest.gameName,
      controls: digest.controls,
      scoring: digest.scoring,
      hazards: digest.hazards,
      mechanics: digest.mechanics,
      winConditions: digest.winConditions,
      loseConditions: digest.loseConditions,
      strategyTags: digest.strategyTags,
      classification: getCachedClassification(gameId)
    };
    digestCache.set(gameId, facets);
    res.json(facets);
  } catch (error) {
    console.error('Error building digest:', error);
    res.status(500).json({ error: 'Failed to build digest' });
  }
});

module.exports = router;
