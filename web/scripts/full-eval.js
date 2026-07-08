#!/usr/bin/env node
'use strict';

// Full-catalog evaluation: all 122 games × 2 models.
// Writes results to web/data/eval-runs/full-ledger-<timestamp>.json
// Each game gets 20 actions max, 60s timeout, one deliberate strategy.

const fs = require('fs');
const path = require('path');
const { runArcadeBatchEvaluation } = require('../lib/batch-evaluator');
const telemetry = require('../lib/telemetry-store');

const MODELS = ['gemma4:31b', 'qwen3-coder-next'];
const STRATEGY = {
  id: 'deliberate',
  label: 'Deliberate',
  text: 'Move deliberately and plan ahead. Work toward the exit or goal step by step without wasting moves.'
};
const MAX_ACTIONS = 20;
const TIMEOUT_MS = 60000;
const BATCH_SIZE = 5; // games per batch — keeps memory bounded

async function main() {
  // Load all 122 game IDs from the registry CSV
  const csvPath = path.join(__dirname, '..', '..', 'examples', 'all_games_sp.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
  const allGameIds = [];
  for (const line of lines) {
    const [idPart] = line.trim().split(',');
    const id = Number(idPart);
    if (Number.isInteger(id)) allGameIds.push(id);
  }

  console.log(`[full-eval] Starting: ${allGameIds.length} games × ${MODELS.length} models = ${allGameIds.length * MODELS.length} cases`);
  console.log(`[full-eval] maxActions=${MAX_ACTIONS}, timeout=${TIMEOUT_MS}ms, batchSize=${BATCH_SIZE}`);

  const allResults = [];
  const allErrors = [];
  let batchNum = 0;

  for (let i = 0; i < allGameIds.length; i += BATCH_SIZE) {
    const batchIds = allGameIds.slice(i, i + BATCH_SIZE);
    batchNum++;
    const idStr = batchIds.join(',');
    console.log(`\n[full-eval] Batch ${batchNum}/${Math.ceil(allGameIds.length / BATCH_SIZE)}: games ${idStr}`);

    for (const modelId of MODELS) {
      console.log(`  → model ${modelId}, games ${idStr}`);
      try {
        const result = await runArcadeBatchEvaluation({
          gameIds: idStr,
          modelIds: modelId,
          limit: 999, // no limit — we want every game in the batch
          strategies: [STRATEGY],
          maxActions: MAX_ACTIONS,
          timeoutMs: TIMEOUT_MS,
          synchronousActions: true
        });
        for (const r of result.results) {
          allResults.push(r);
          const acts = (r.actions || []).slice(0, 8).join(',');
          console.log(`    ✓ game ${r.gameId} ${r.gameName}: score=${r.finalScore} won=${r.winner} ticks=${r.ticks} nilLoop=${r.nilActionLoop} acts=${acts}`);
        }
        for (const e of result.errors) {
          allErrors.push(e);
          console.log(`    ✗ game ${e.gameId}: ${e.message.slice(0, 80)}`);
        }
      } catch (err) {
        console.error(`  BATCH FAILED for ${modelId}/${idStr}: ${err.message}`);
        for (const gid of batchIds) {
          allErrors.push({ gameId: gid, modelId, message: err.message });
        }
      }
    }
  }

  // Write the full ledger
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, '..', 'data', 'eval-runs', `full-ledger-${timestamp}.json`);
  const ledger = {
    generatedAt: new Date().toISOString(),
    models: MODELS,
    strategy: STRATEGY.text,
    maxActions: MAX_ACTIONS,
    timeoutMs: TIMEOUT_MS,
    totalGames: allGameIds.length,
    totalCases: allGameIds.length * MODELS.length,
    results: allResults,
    errors: allErrors
  };
  fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2));
  console.log(`\n[full-eval] DONE: ${allResults.length} results, ${allErrors.length} errors`);
  console.log(`[full-eval] Ledger written to ${outPath}`);
}

main().catch(err => {
  console.error('[full-eval] FATAL:', err);
  process.exit(1);
});