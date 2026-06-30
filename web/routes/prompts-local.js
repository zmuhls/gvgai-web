const express = require('express');
const promptStore = require('../lib/prompt-store');

const router = express.Router();

router.get('/templates', (req, res) => {
  res.json(promptStore.listTemplates());
});

router.get('/templates/:id', (req, res) => {
  const template = promptStore.getTemplate(req.params.id);
  if (!template) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(template);
});

router.post('/templates', (req, res) => {
  try {
    res.json(promptStore.saveTemplate(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/templates/:id', (req, res) => {
  const result = promptStore.deleteTemplate(req.params.id);
  res.status(result.error ? 400 : 200).json(result);
});

router.get('/games', (req, res) => {
  res.json(promptStore.listGameConfigs());
});

router.get('/games/:gameId', (req, res) => {
  const config = promptStore.getGameConfig(req.params.gameId);
  if (!config) {
    res.status(404).json({ error: 'Game config not found' });
    return;
  }
  res.json(config);
});

router.post('/games/:gameId', (req, res) => {
  try {
    const config = {
      ...req.body,
      gameId: Number.parseInt(req.params.gameId, 10)
    };
    res.json(promptStore.saveGameConfig(config));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/games/:gameId', (req, res) => {
  const result = promptStore.deleteGameConfig(req.params.gameId);
  res.status(result.error ? 404 : 200).json(result);
});

module.exports = router;
