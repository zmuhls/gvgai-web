const express = require('express');
const telemetry = require('../lib/telemetry-store');
const guardrail = require('../lib/usage-guardrail');

const router = express.Router();

function parseLimit(raw, fallback = 80) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

router.get('/summary', async (req, res) => {
  res.json(await telemetry.getDashboardSnapshot({
    limit: parseLimit(req.query.limit)
  }));
});

router.get('/events', async (req, res) => {
  res.json({
    events: await telemetry.getRecentEvents(parseLimit(req.query.limit))
  });
});

router.post('/events', (req, res) => {
  const body = req.body || {};
  const event = telemetry.track({
    eventFamily: body.eventFamily || body.event_family || 'user_experience',
    eventType: body.eventType || body.event_type,
    source: body.source || 'browser',
    sessionId: body.sessionId || body.session_id,
    runId: body.runId || body.run_id,
    gameId: body.gameId ?? body.game_id,
    levelId: body.levelId ?? body.level_id,
    modelId: body.modelId || body.model_id,
    provider: body.provider,
    latencyMs: body.latencyMs ?? body.latency_ms,
    value: body.value,
    payload: {
      ...(body.payload || {}),
      path: body.payload?.path || req.get('referer') || null,
      user_agent: req.get('user-agent') || null
    },
    metrics: body.metrics || {}
  });

  res.status(202).json({
    ok: true,
    eventId: event?.event_id || null
  });
});

router.post('/flush', async (req, res) => {
  await telemetry.flush();
  res.json({
    ok: true,
    storage: telemetry.getStorageStatus()
  });
});

// GET /guardrail — Ollama Cloud usage guardrail status (hour/day counters + limits)
router.get('/guardrail', (req, res) => {
  res.json(guardrail.getStatus());
});

module.exports = router;
