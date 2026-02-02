const express = require('express');
const router = express.Router();

// List of open-weight models
router.get('/', (req, res) => {
  const models = [
    {
      id: 'gemma3:1b',
      name: 'Gemma 3 1B (Local)',
      description: 'Local Ollama model',
      speed: 'fast',
      cost: 'free'
    },
    {
      id: 'moonshotai/kimi-k2-0905:exacto',
      name: 'Kimi K2',
      description: 'Open-weight model',
      speed: 'fast',
      cost: 'low'
    },
    {
      id: 'deepseek/deepseek-v3.1-terminus:exacto',
      name: 'DeepSeek v3.1 Terminus',
      description: 'Open-weight model',
      speed: 'fast',
      cost: 'low'
    },
    {
      id: 'z-ai/glm-4.6:exacto',
      name: 'GLM 4.6',
      description: 'Open-weight model',
      speed: 'fast',
      cost: 'low'
    },
    {
      id: 'openai/gpt-oss-120b:exacto',
      name: 'GPT-OSS 120B',
      description: 'Open-weight model',
      speed: 'medium',
      cost: 'low'
    }
  ];

  res.json(models);
});

module.exports = router;
