'use strict';

// Thin HTTP surface over lib/finetune-pipeline.js. The pipeline itself is
// configured (with io + telemetry) in server.js startServer().

const express = require('express');
const pipeline = require('../lib/finetune-pipeline');
const { TriggerError } = require('../lib/finetune-pipeline');

const router = express.Router();

router.post('/trigger', (req, res) => {
  const { gameId, dryRun } = req.body || {};
  try {
    const result = pipeline.trigger({ gameId, dryRun: Boolean(dryRun) });
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof TriggerError && err.code === 'RUN_IN_PROGRESS') {
      return res.status(409).json({ error: 'run_in_progress', message: err.message });
    }
    if (err instanceof TriggerError && err.code === 'INVALID_GAME') {
      return res.status(400).json({ error: 'invalid_gameId', message: err.message });
    }
    console.error('[FinetuneRoute] trigger failed:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

router.get('/status', (req, res) => {
  res.json(pipeline.getStatus());
});

router.post('/cancel', (req, res) => {
  try {
    res.json(pipeline.cancel());
  } catch (err) {
    if (err instanceof TriggerError && err.code === 'NO_ACTIVE_RUN') {
      return res.status(409).json({ error: 'no_active_run', message: err.message });
    }
    console.error('[FinetuneRoute] cancel failed:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

module.exports = router;
