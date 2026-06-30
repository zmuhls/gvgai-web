const express = require('express');
const router = express.Router();
const { buildArcadeEvalPlan } = require('../lib/eval-plan');
const { runArcadeBatchEvaluation } = require('../lib/batch-evaluator');

function parseGameCount(raw) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

router.post('/arcade/run', async (req, res) => {
  try {
    const result = await runArcadeBatchEvaluation(req.body || {});
    res.json(result);
  } catch (error) {
    console.error('[Evals] Failed to run arcade eval batch:', error);
    res.status(500).json({ error: 'Failed to run arcade eval batch' });
  }
});

module.exports = router;
