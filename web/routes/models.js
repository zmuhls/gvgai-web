const express = require('express');
const router = express.Router();
const { MODELS } = require('../lib/models');

// List available models. Featured (Ollama Cloud) models surface first in the Arcade
// picker. Routing/fallback metadata lives in lib/models.js (shared with llm-client).
router.get('/', (req, res) => {
  res.json(MODELS);
});

module.exports = router;
