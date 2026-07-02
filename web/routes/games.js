const express = require('express');
const fs = require('fs');
const path = require('path');
const { getCachedClassification } = require('../lib/game-classifier');
const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, '../..');

// Load the featured-games list (curation is data; safe if the file is missing)
function loadFeaturedSet() {
  try {
    const featuredPath = path.join(__dirname, '../data/featured.json');
    const { featured } = JSON.parse(fs.readFileSync(featuredPath, 'utf-8'));
    return new Set(Array.isArray(featured) ? featured : []);
  } catch (e) {
    return new Set();
  }
}

// Parse games CSV and return list
router.get('/', (req, res) => {
  try {
    const csvPath = path.join(PROJECT_ROOT, 'examples/all_games_sp.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    const featuredSet = loadFeaturedSet();

    const games = csvContent
      .trim()
      .split('\n')
      .map(line => {
        const trimmedLine = line.trim(); // Remove \r and whitespace
        const [id, filepath] = trimmedLine.split(',');
        const trimmedFilepath = filepath.trim(); // Extra safety
        const filename = path.basename(trimmedFilepath, '.txt');
        const category = trimmedFilepath.includes('gridphysics') ? 'gridphysics' : 'contphysics';

        // Find available levels - GVGAI games typically have levels 0-4
        const levels = [];
        for (let i = 0; i < 5; i++) {
          const levelPath = path.join(PROJECT_ROOT, trimmedFilepath.replace('.txt', `_lvl${i}.txt`));
          if (fs.existsSync(levelPath)) {
            levels.push(i);
          }
        }

        // If no levels found, default to 0-4 (GVGAI standard)
        if (levels.length === 0) {
          levels.push(0, 1, 2, 3, 4);
        }

        const gameId = parseInt(id);
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

module.exports = router;
