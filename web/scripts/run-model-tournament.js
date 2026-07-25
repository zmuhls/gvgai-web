#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const path = require('path');
const { loadRootEnv } = require('./load-root-env');
const telemetry = require('../lib/telemetry-store');
const { COMBINATORIAL_STRATEGIES } = require('../lib/eval-plan');
const { runArcadeBatchEvaluation } = require('../lib/batch-evaluator');
const { getTournamentLeaderboard } = require('../lib/tournament-records');
const { availableTournamentModels, selectTournamentRoster } = require('../lib/tournament-roster');
const { summarizeTournament } = require('../lib/tournament-summary');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--local') options.localOnly = true;
    else if (arg === '--out') { options.out = next; index += 1; }
    else if (arg === '--roster-size') { options.rosterSize = Number(next); index += 1; }
    else if (arg === '--challengers') { options.challengerCount = Number(next); index += 1; }
    else if (arg === '--game-count') { options.gameCount = Number(next); index += 1; }
    else if (arg === '--max-actions') { options.maxActions = Number(next); index += 1; }
    else if (arg === '--timeout-ms') { options.timeoutMs = Number(next); index += 1; }
  }
  return options;
}

function outputPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(__dirname, '..', 'data', 'tournaments', `tournament-${stamp}.json`);
}

function availablePort(preferredPort = 8080) {
  const requested = Number.parseInt(preferredPort, 10);
  const port = Number.isInteger(requested) && requested > 0 ? requested : 8080;

  return new Promise((resolve, reject) => {
    const preferred = net.createServer();
    preferred.unref();
    preferred.once('error', error => {
      if (error.code !== 'EADDRINUSE') {
        reject(error);
        return;
      }

      const fallback = net.createServer();
      fallback.unref();
      fallback.once('error', reject);
      fallback.listen(0, '0.0.0.0', () => {
        const address = fallback.address();
        fallback.close(closeError => {
          if (closeError) reject(closeError);
          else resolve(address.port);
        });
      });
    });
    preferred.listen(port, '0.0.0.0', () => {
      preferred.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadRootEnv();
  const localOnly = Boolean(
    options.localOnly ||
    (!process.env.OLLAMA_API_KEY && !process.env.OPENROUTER_API_KEY)
  );

  const history = getTournamentLeaderboard().history;
  const available = await availableTournamentModels({ localOnly });
  if (!options.dryRun && !options.offline && !localOnly &&
      !process.env.OLLAMA_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error('Cloud tournament requires OLLAMA_API_KEY or OPENROUTER_API_KEY');
  }
  const roster = selectTournamentRoster(available.models, history, options);
  if (roster.models.length < 2) {
    const source = localOnly ? 'installed local Ollama' : 'available cloud';
    throw new Error(`Tournament roster needs at least two ${source} models`);
  }
  const strategy = COMBINATORIAL_STRATEGIES.find(entry => entry.id === 'four-way-sweep');
  const maxActions = Number.isInteger(options.maxActions) ? options.maxActions : 40;
  const levelId = 1;

  if (options.dryRun) {
    console.log(JSON.stringify({
      status: 'planned',
      providerMode: available.providerMode,
      discoveryStatus: available.discoveryStatus,
      availableModels: available.models.length,
      roster: roster.models.map(model => model.id),
      incumbents: roster.incumbentIds,
      newPlayers: roster.newPlayerIds
    }, null, 2));
    return;
  }

  if (!options.offline) {
    const socketPort = await availablePort(process.env.GVGAI_SOCKET_PORT || 8080);
    process.env.GVGAI_SOCKET_PORT = String(socketPort);
    console.log(`[Tournament] GVGAI socket port: ${socketPort}`);
  }

  telemetry.configure({
    fallbackPath: path.join(__dirname, '..', 'data', 'telemetry-events.jsonl')
  });
  const evaluation = await runArcadeBatchEvaluation({
    telemetry,
    offline: Boolean(options.offline),
    modelIds: roster.models.map(model => model.id),
    models: roster.models,
    strategies: [strategy],
    gameCount: Number.isInteger(options.gameCount) ? options.gameCount : undefined,
    levelId,
    limit: null,
    maxActions,
    timeoutMs: Number.isInteger(options.timeoutMs) ? options.timeoutMs : 180000,
    actionTimeoutMs: 8000
  });
  const record = summarizeTournament(evaluation, roster, {
    availableModelCount: available.models.length,
    providerMode: available.providerMode,
    discoveryStatus: available.discoveryStatus,
    socketPort: Number(process.env.GVGAI_SOCKET_PORT || 8080),
    levelId,
    strategyId: strategy.id,
    maxActions
  });
  const filePath = path.resolve(options.out || outputPath());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  await telemetry.flush();

  console.log(`[Tournament] ${record.status}: ${record.summary.matchesPlayed} matches, ${record.summary.errors} errors`);
  console.log(`[Tournament] champion: ${record.champion?.modelName || 'none'}`);
  console.log(`[Tournament] new players: ${record.newPlayers.join(', ') || 'none'}`);
  console.log(`[Tournament] wrote ${filePath}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[Tournament] failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { availablePort, main, outputPath, parseArgs };
