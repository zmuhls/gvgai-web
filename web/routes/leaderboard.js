const express = require('express');
const { getTournamentLeaderboard } = require('../lib/tournament-records');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(getTournamentLeaderboard());
});

module.exports = router;
