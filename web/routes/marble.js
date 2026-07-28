const express = require('express');
const coordinator = require('../lib/attract-coordinator');
const { requireOperator } = require('../lib/operator-auth');

const router = express.Router();

// Fire-and-forget: start() kicks the attract loop in the background and returns
// immediately (202). Starting a paid background playlist is an operator action,
// never a side effect of public page traffic.
router.post('/start', requireOperator({ enabledKey: 'MARBLE_RUN_ENABLED' }), (req, res) => {
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
