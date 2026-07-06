const express = require('express');
const promptStore = require('../lib/prompt-store');
const { buildPrompt, GameStateTracker } = require('../lib/state-converter');

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

// POST /preview — assemble the prompt for a game+level without running it.
// The dashboard's "Preview Prompt" button calls this to show what the model
// would receive. Uses a synthetic SSO so buildPrompt can resolve template
// variables ({{gameName}}, {{availableActions}}, etc.).
router.post('/preview', (req, res) => {
  try {
    const { gameId, levelId } = req.body || {};
    const parsedGameId = Number.parseInt(gameId, 10);
    if (!Number.isInteger(parsedGameId)) {
      return res.status(400).json({ error: 'Invalid or missing gameId' });
    }
    const parsedLevelId = Number.parseInt(levelId, 10) || 0;

    const promptConfig = promptStore.resolveGamePromptConfig(parsedGameId, parsedLevelId, {});
    if (!promptConfig) {
      return res.status(404).json({ error: 'Game config not found' });
    }

    // Synthetic SSO with enough fields for template resolution + buildPrompt
    const syntheticSso = {
      availableActions: ['ACTION_NIL', 'ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
      gameScore: 0,
      avatarHealthPoints: 100,
      avatarMaxHealthPoints: 100,
      gameTick: 0,
      avatarPosition: [0, 0],
      blockSize: 1,
      worldDimension: [200, 200],
      observationGrid: [],
      observationGridNum: 0
    };
    const tracker = new GameStateTracker();
    const { systemMessage, userMessage, promptLayers } = buildPrompt(syntheticSso, promptConfig, tracker, null);

    const messages = [];
    if (systemMessage) messages.push({ role: 'system', content: systemMessage });
    messages.push({ role: 'user', content: userMessage });

    res.json({
      messages,
      llmSettings: promptConfig.llmSettings || { maxTokens: 100, temperature: 0.7 },
      promptLayers: promptLayers || []
    });
  } catch (error) {
    console.error('[Prompts] Preview failed:', error);
    res.status(500).json({ error: 'Failed to assemble prompt preview' });
  }
});

module.exports = router;
