#!/usr/bin/env node
'use strict';

// Pull play traces from the Postgres archive (see lib/trace-archive.js) into
// the local filesystem store, so a training box can run
// `npm run finetune:prepare` over plays captured on the deployed instance.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/sync-traces.js [--game-id N]
//     [--player-type human|llm] [--dry-run]
//
// Idempotent: traces already present locally (by traceId) are skipped, so
// re-running only downloads what is new.

const { loadRootEnv } = require('./load-root-env');

function parseArgs(argv) {
  const options = { gameId: null, playerType: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--game-id') { options.gameId = Number.parseInt(next, 10); i++; }
    else if (arg === '--player-type') { options.playerType = next; i++; }
    else if (arg === '--dry-run') { options.dryRun = true; }
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: sync-traces.js [--game-id N] [--player-type human|llm] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(64);
    }
  }
  return options;
}

async function main() {
  await loadRootEnv();
  const archive = require('../lib/trace-archive');
  const traceStore = require('../lib/play-trace-store');
  const options = parseArgs(process.argv.slice(2));

  if (!archive.isConfigured()) {
    console.error('[SyncTraces] DATABASE_URL is not set — nothing to pull from.');
    process.exit(1);
  }

  const summaries = await archive.fetchTraceSummaries({
    gameId: Number.isInteger(options.gameId) ? options.gameId : undefined,
    playerType: options.playerType || undefined
  });
  console.log(`[SyncTraces] remote traces: ${summaries.length}`);

  let imported = 0;
  let skipped = 0;
  for (const summary of summaries) {
    const existing = traceStore.getTrace(summary.game_id, summary.trace_id);
    if (existing) { skipped++; continue; }
    if (options.dryRun) {
      console.log(`[SyncTraces] would import ${summary.trace_id} (game ${summary.game_id}, ${summary.player_type})`);
      imported++;
      continue;
    }
    const record = await archive.fetchTrace(summary.trace_id);
    if (!record) { skipped++; continue; }
    if (traceStore.importTrace(record)) {
      imported++;
      console.log(`[SyncTraces] imported ${record.traceId} (game ${record.gameId}, ${record.playerType}, score ${record.finalScore})`);
    } else {
      skipped++;
    }
  }

  console.log(`[SyncTraces] done: ${imported} ${options.dryRun ? 'to import' : 'imported'}, ${skipped} already local`);
  await archive.closePool();
}

main().catch(err => {
  console.error('[SyncTraces] failed:', err.message);
  process.exitCode = 1;
});
