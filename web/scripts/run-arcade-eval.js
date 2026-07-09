#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadRootEnv } = require('./load-root-env');
const telemetry = require('../lib/telemetry-store');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--offline') {
      options.offline = true;
    } else if (arg === '--ollama-offline') {
      options.ollamaOffline = true;
    } else if (arg === '--all') {
      options.limit = null;
    } else if (arg === '--game-count') {
      options.gameCount = next;
      i++;
    } else if (arg === '--game-id') {
      options.gameIds = next;
      i++;
    } else if (arg === '--level-id') {
      options.levelId = next;
      i++;
    } else if (arg === '--model') {
      options.modelIds = next;
      i++;
    } else if (arg === '--all-models') {
      options.allModels = true;
    } else if (arg === '--ollama-model') {
      options.ollamaModel = next;
      i++;
    } else if (arg === '--strategy-id') {
      options.strategyIds = next;
      i++;
    } else if (arg === '--limit') {
      options.limit = next;
      i++;
    } else if (arg === '--repeats') {
      options.repeats = next;
      i++;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = next;
      i++;
    } else if (arg === '--ready-timeout-ms') {
      options.readyTimeoutMs = next;
      i++;
    } else if (arg === '--action-timeout-ms') {
      options.actionTimeoutMs = next;
      i++;
    } else if (arg === '--max-actions') {
      options.maxActions = next;
      i++;
    } else if (arg === '--out') {
      options.out = next;
      i++;
    }
  }
  return options;
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(__dirname, '..', 'data', 'eval-runs', `arcade-eval-${stamp}.json`);
}

async function main() {
  const envLoad = await loadRootEnv();
  const { runArcadeBatchEvaluation } = require('../lib/batch-evaluator');
  const options = parseArgs(process.argv.slice(2));
  if (envLoad.timedOut) {
    console.warn(`[Eval] skipped root .env after ${envLoad.timeoutMs}ms; using process environment`);
  }
  telemetry.configure({
    fallbackPath: path.resolve(__dirname, '..', 'data', 'telemetry-events.jsonl')
  });
  const result = await runArcadeBatchEvaluation({ ...options, telemetry });
  const outputPath = options.out ? path.resolve(options.out) : defaultOutputPath();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(`[Eval] ${result.status}: ${result.results.length}/${result.cases.length} runs completed`);
  console.log(`[Eval] meaningful groups: ${result.comparison.groupsWithMeaningfulDifference}/${result.comparison.comparedGroups}`);
  if (result.qualification) {
    const q = result.qualification;
    console.log(`[Eval] qualifying games: ${q.qualifyingGameCount}/${q.targetGameCount}; threshold ${q.requiredModelPasses}/${q.selectedModelCount} models`);
    const leading = q.games.slice(0, 10).map(game => {
      const mark = game.qualified ? 'qualified' : 'pending';
      return `${game.gameId}:${game.gameName} ${game.modelPasses}/${game.requiredModelPasses} ${mark}`;
    });
    for (const line of leading) {
      console.log(`[Eval] qualification ${line}`);
    }
  }

  // Per-archetype rollup: games within a class are comparable; across classes
  // the score scales and pacing differ too much for a single average.
  const byArchetype = new Map();
  for (const run of result.results) {
    const archetype = run.archetype || 'unclassified';
    const bucket = byArchetype.get(archetype) || { runs: 0, wins: 0, score: 0, nilLoops: 0 };
    bucket.runs += 1;
    if (run.won) bucket.wins += 1;
    bucket.score += Number(run.finalScore || 0);
    if (run.nilActionLoop) bucket.nilLoops += 1;
    byArchetype.set(archetype, bucket);
  }
  for (const [archetype, bucket] of byArchetype) {
    const meanScore = (bucket.score / bucket.runs).toFixed(1);
    console.log(`[Eval] ${archetype}: ${bucket.runs} runs, ${bucket.wins} wins, mean score ${meanScore}, nil loops ${bucket.nilLoops}`);
  }
  if (result.errors.length > 0) {
    console.log(`[Eval] errors: ${result.errors.length}`);
  }
  console.log(`[Eval] wrote ${outputPath}`);
  await telemetry.flush();
}

if (require.main === module) {
  main().catch(error => {
    console.error('[Eval] failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  defaultOutputPath,
  main
};
