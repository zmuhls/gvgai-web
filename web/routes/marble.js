const express = require('express');
const coordinator = require('../lib/attract-coordinator');

const router = express.Router();

// Fire-and-forget: start() kicks the attract loop in the background and returns
// immediately (202). Progress reaches clients over Socket.IO, like /api/game/start.
router.post('/start', (req, res) => {
  try {
    const snapshot = coordinator.start();
    res.status(202).json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/stop', (req, res) => {
  res.json(coordinator.stop());
});

// Snapshot for late-joining spectators (the /marquee page hydrates from this).
router.get('/state', (req, res) => {
  res.json(coordinator.getSnapshot());
});

module.exports = router;
