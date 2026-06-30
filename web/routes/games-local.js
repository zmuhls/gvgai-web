const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const PROJECT_ROOT = path.join(__dirname, '../..');

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

      return {
        id: Number.parseInt(id, 10),
        name: filename,
        file: trimmedFilepath,
        category,
        levels,
        levelCount: levels.length,
        featured: featuredSet.has(Number.parseInt(id, 10))
      };
    });

    res.json(games);
  } catch (error) {
    console.error('Error loading games:', error);
    res.status(500).json({ error: 'Failed to load games' });
  }
});

module.exports = router;
