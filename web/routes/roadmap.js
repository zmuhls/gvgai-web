'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const ROADMAP_PATH = path.join(__dirname, '..', 'data', 'model-native-roadmap.json');

function readModelNativeRoadmap(filePath = ROADMAP_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

router.get('/model-native', (req, res) => {
  try {
    res.json(readModelNativeRoadmap());
  } catch (error) {
    console.error('[RoadmapRoute] failed to load model-native roadmap:', error.message);
    res.status(500).json({ error: 'failed_to_load_roadmap', message: error.message });
  }
});

module.exports = router;
module.exports.readModelNativeRoadmap = readModelNativeRoadmap;
