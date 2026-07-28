const express = require('express');
const router = express.Router();
const { buildArcadeEvalPlan } = require('../lib/eval-plan');
const { runArcadeBatchEvaluation } = require('../lib/batch-evaluator');
const { requireOperator } = require('../lib/operator-auth');

function parseGameCount(raw) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function providerCallCeiling() {
  const parsed = Number.parseInt(process.env.MODEL_RUN_MAX_PROVIDER_CALLS, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

router.get('/arcade', (req, res) => {
  try {
    res.json(buildArcadeEvalPlan({
      gameCount: parseGameCount(req.query.gameCount)
    }));
  } catch (error) {
    console.error('[Evals] Failed to build arcade eval plan:', error);
    res.status(500).json({ error: 'Failed to build arcade eval plan' });
  }
});

router.post(
  '/arcade/run',
  requireOperator({ enabledKey: 'MODEL_EVALS_ENABLED' }),
  async (req, res) => {
    try {
      const requested = req.body || {};
      const result = await runArcadeBatchEvaluation({
        ...requested,
        limit: Math.min(3, Math.max(1, Number.parseInt(requested.limit, 10) || 3)),
        repeats: Math.min(2, Math.max(1, Number.parseInt(requested.repeats, 10) || 1)),
        maxActions: Math.min(40, Math.max(1, Number.parseInt(requested.maxActions, 10) || 40)),
        maxProviderCalls: Math.min(
          providerCallCeiling(),
          Math.max(
            1,
            Number.parseInt(requested.maxProviderCalls, 10) || providerCallCeiling()
          )
        )
      });
      res.json(result);
    } catch (error) {
      console.error('[Evals] Failed to run arcade eval batch:', error);
      res.status(500).json({ error: 'Failed to run arcade eval batch' });
    }
  }
);

module.exports = router;
