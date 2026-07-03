'use strict';

const express = require('express');
const traceStore = require('../lib/play-trace-store');

const router = express.Router();

// Validate gameId param; respond 400 if not a valid integer.
function validateGameId(req, res) {
  const gameId = Number.parseInt(req.params.gameId, 10);
  if (!Number.isInteger(gameId)) {
    res.status(400).json({ error: 'Invalid gameId' });
    return null;
  }
  return gameId;
}

// Parse ?n= query as a positive integer, clamped to [1, 100], default fallback.
function parseCount(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, 100);
  return fallback;
}

// 1. GET /:gameId — list trace summaries (no actionHistory)
router.get('/:gameId', (req, res) => {
  const gameId = validateGameId(req, res);
  if (gameId === null) return;

  const options = {};
  const playerType = req.query.playerType;
  if (playerType === 'human' || playerType === 'llm') {
    options.playerType = playerType;
  }

  try {
    const traces = traceStore.getTracesForGame(gameId, options);
    res.json({ gameId, traces });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load traces', detail: err.message });
  }
});

// 3. GET /:gameId/stats — aggregate statistics (declared before /:traceId)
router.get('/:gameId/stats', (req, res) => {
  const gameId = validateGameId(req, res);
  if (gameId === null) return;

  try {
    const stats = traceStore.getTraceStats(gameId);
    if (!stats) {
      res.json({ gameId, traceCount: 0, message: 'No traces yet' });
      return;
    }
    res.json({ gameId, ...stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats', detail: err.message });
  }
});

// 4. GET /:gameId/best — top N traces (declared before /:traceId)
router.get('/:gameId/best', (req, res) => {
  const gameId = validateGameId(req, res);
  if (gameId === null) return;

  const n = parseCount(req.query.n, 5);
  const humanOnly = req.query.humanOnly === 'true';

  try {
    const traces = humanOnly
      ? traceStore.getBestHumanTraces(gameId, n)
      : traceStore.getBestTraces(gameId, n);
    res.json({ gameId, traces });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load best traces', detail: err.message });
  }
});

// 2. GET /:gameId/:traceId — full trace with actionHistory
router.get('/:gameId/:traceId', (req, res) => {
  const gameId = validateGameId(req, res);
  if (gameId === null) return;

  const traceId = req.params.traceId;
  if (!traceId) {
    res.status(400).json({ error: 'Missing traceId' });
    return;
  }

  try {
    const trace = traceStore.getTrace(gameId, traceId);
    if (!trace) {
      res.status(404).json({ error: 'Trace not found', gameId, traceId });
      return;
    }
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load trace', detail: err.message });
  }
});

module.exports = router;