const express = require('express');
const router = express.Router();
const promptStore = require('../lib/prompt-store');
const { buildPrompt } = require('../lib/state-converter');

// --- Template endpoints ---

router.get('/templates', (req, res) => {
  try {
    res.json(promptStore.listTemplates());
  } catch (error) {
    console.error('Error listing templates:', error);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.get('/templates/:id', (req, res) => {
  try {
    const template = promptStore.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    console.error('Error getting template:', error);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

router.post('/templates', express.json(), (req, res) => {
  try {
    const { name, layer, category, content } = req.body;
    if (!name || !layer || !content) {
      return res.status(400).json({ error: 'name, layer, and content are required' });
    }
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!id) return res.status(400).json({ error: 'Invalid name' });

    // Check for duplicate ID
    if (promptStore.getTemplate(id)) {
      return res.status(409).json({ error: 'Template with this name already exists' });
    }

    const template = promptStore.saveTemplate({ id, name, layer, category: category || 'general', content });
    res.status(201).json(template);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/templates/:id', express.json(), (req, res) => {
  try {
    const existing = promptStore.getTemplate(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const updated = {
      ...existing,
      name: req.body.name || existing.name,
      layer: req.body.layer || existing.layer,
      category: req.body.category || existing.category,
      content: req.body.content !== undefined ? req.body.content : existing.content
    };
    const template = promptStore.saveTemplate(updated);
    res.json(template);
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/templates/:id', (req, res) => {
  try {
    const result = promptStore.deleteTemplate(req.params.id);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// --- Game config endpoints ---

router.get('/games', (req, res) => {
  try {
    res.json(promptStore.listGameConfigs());
  } catch (error) {
    console.error('Error listing game configs:', error);
    res.status(500).json({ error: 'Failed to list game configs' });
  }
});

router.get('/games/:gameId', (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);
    const config = promptStore.getGameConfig(gameId);
    if (!config) {
      // Return default skeleton
      return res.json({
        gameId,
        gameName: null,
        systemTemplateId: 'default-system',
        gameContext: { templateId: null, customOverride: null },
        progressionContexts: {},
        llmSettings: { maxTokens: 100, temperature: 0.7 }
      });
    }
    res.json(config);
  } catch (error) {
    console.error('Error getting game config:', error);
    res.status(500).json({ error: 'Failed to get game config' });
  }
});

router.put('/games/:gameId', express.json(), (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);
    const config = { ...req.body, gameId };
    const saved = promptStore.saveGameConfig(config);
    res.json(saved);
  } catch (error) {
    console.error('Error saving game config:', error);
    res.status(500).json({ error: 'Failed to save game config' });
  }
});

router.delete('/games/:gameId', (req, res) => {
  try {
    const gameId = parseInt(req.params.gameId);
    const result = promptStore.deleteGameConfig(gameId);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (error) {
    console.error('Error deleting game config:', error);
    res.status(500).json({ error: 'Failed to delete game config' });
  }
});

// --- Prompt preview ---

router.post('/preview', express.json(), (req, res) => {
  try {
    const { gameId, levelId, mockSso } = req.body;
    if (gameId === undefined) return res.status(400).json({ error: 'gameId is required' });

    const promptConfig = promptStore.resolveGamePromptConfig(gameId, levelId || 0);
    const sso = mockSso || {
      gameScore: 0,
      avatarHealthPoints: 100,
      gameTick: 0,
      availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE', 'ACTION_NIL'],
      avatarPosition: [10, 10]
    };

    const { systemMessage, userMessage } = buildPrompt(sso, promptConfig);
    const messages = [];
    if (systemMessage) messages.push({ role: 'system', content: systemMessage });
    messages.push({ role: 'user', content: userMessage });

    res.json({ messages, llmSettings: promptConfig.llmSettings });
  } catch (error) {
    console.error('Error previewing prompt:', error);
    res.status(500).json({ error: 'Failed to preview prompt' });
  }
});

module.exports = router;
