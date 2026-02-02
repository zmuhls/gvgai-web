const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PROJECT_ROOT = path.join(__dirname, '../..');

// Parse games CSV and return list
router.get('/', (req, res) => {
  try {
    const csvPath = path.join(PROJECT_ROOT, 'examples/all_games_sp.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

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

        return {
          id: parseInt(id),
          name: filename,
          file: trimmedFilepath,
          category,
          levels,
          levelCount: levels.length
        };
      });

    res.json(games);
  } catch (error) {
    console.error('Error loading games:', error);
    res.status(500).json({ error: 'Failed to load games' });
  }
});

module.exports = router;
