#!/usr/bin/env node
const path = require('path');

const { projectRoot } = require('../lib/game-registry');
const { DEFAULT_MEMORY_DIR } = require('../lib/strategy-memory-store');
const { evaluateStrategyMemory } = require('../lib/strategy-memory-evaluator');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    offline: false,
    ollamaOffline: false,
    all: false,
    featured: false,
    gameIds: [],
    modelIds: undefined,
    strategyIds: undefined,
    limit: undefined,
    repeats: undefined,
    memoryDir: null,
    out: null,
    projectRoot: projectRoot(),
    thresholds: {}
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--ollama-offline') options.ollamaOffline = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--featured') options.featured = true;
    else if (arg === '--game-id') options.gameIds = argv[++i] || '';
    else if (arg === '--model') options.modelIds = argv[++i] || '';
    else if (arg === '--strategy-id') options.strategyIds = argv[++i] || '';
    else if (arg === '--limit') options.limit = argv[++i] || undefined;
    else if (arg === '--repeats') options.repeats = argv[++i] || undefined;
    else if (arg === '--memory-dir') options.memoryDir = path.resolve(argv[++i] || DEFAULT_MEMORY_DIR);
    else if (arg === '--out') options.out = path.resolve(argv[++i] || '');
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || options.projectRoot);
    else if (arg === '--score-gain') options.thresholds.scoreGain = Number(argv[++i]);
    else if (arg === '--tick-gain') options.thresholds.tickGain = Number(argv[++i]);
    else if (arg === '--prompt-max-ratio') options.thresholds.promptMaxRatio = Number(argv[++i]);
    else if (arg === '--prompt-drop-ratio') options.thresholds.promptDropRatio = Number(argv[++i]);
  }

  return options;
}

async function main() {
  const options = parseArgs();
  const result = await evaluateStrategyMemory(options);
  const prefix = result.dryRun ? '[StrategyEval:dry-run]' : '[StrategyEval]';

  console.log(`${prefix} ${result.status}: ${result.cases.length} cases, ${result.plannedPairs?.length || result.results.length} variant runs`);
  if (result.gate) {
    for (const game of result.gate.games) {
      const promptDrop = (game.deltas.promptDrop * 100).toFixed(1);
      const scoreDelta = game.deltas.scoreDelta.toFixed(2);
      const tickDelta = game.deltas.tickDelta.toFixed(2);
      const label = game.accepted ? 'accepted' : 'rejected';
      const detail = game.accepted ? game.reasons.join(', ') : game.blockers.join(', ');
      console.log(`${prefix} game ${game.gameId}: ${label} scoreDelta=${scoreDelta} tickDelta=${tickDelta} promptDrop=${promptDrop}% ${detail}`);
    }
  } else {
    for (const pair of result.plannedPairs.slice(0, 10)) {
      console.log(`${prefix} plan ${pair.variant} ${pair.runId} promptChars=${pair.promptMetrics.promptChars}`);
    }
    if (result.plannedPairs.length > 10) {
      console.log(`${prefix} ... ${result.plannedPairs.length - 10} more planned variant runs`);
    }
  }
  if (result.artifactPath) console.log(`${prefix} wrote ${result.artifactPath}`);
  if (result.errors?.length > 0) console.log(`${prefix} errors: ${result.errors.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('[StrategyEval] failed:', error);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs
};
