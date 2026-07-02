#!/usr/bin/env node
const path = require('path');

const { selectGames, projectRoot } = require('../lib/game-registry');
const { classifyGame, CLASSIFIER_VERSION } = require('../lib/game-classifier');
const promptStore = require('../lib/prompt-store');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    write: false,
    all: false,
    gameIds: [],
    featured: false,
    projectRoot: projectRoot()
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--featured') options.featured = true;
    else if (arg === '--game-id') options.gameIds = argv[++i] || '';
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || options.projectRoot);
  }

  if (!options.write) options.dryRun = true;
  return options;
}

function classifyGames(options = {}) {
  const games = selectGames(options);
  const results = [];
  const written = [];
  const skipped = [];

  for (const game of games) {
    const classification = classifyGame(game);
    results.push({ gameId: game.id, gameName: game.name, classification });

    if (options.dryRun) continue;

    // Only backfill games that already have a config file; config-less games
    // are served by the lazy getCachedClassification path.
    const config = promptStore.getGameConfig(game.id);
    if (!config) {
      skipped.push(game.id);
      continue;
    }
    // Preserve a manual archetype pin across re-runs of the classifier.
    const archetypeOverride = config.classification?.archetypeOverride;
    config.classification = archetypeOverride
      ? { ...classification, archetypeOverride }
      : classification;
    promptStore.saveGameConfig(config);
    written.push(game.id);
  }

  return {
    classifierVersion: CLASSIFIER_VERSION,
    dryRun: Boolean(options.dryRun),
    results,
    written,
    skipped
  };
}

function distribution(results, key) {
  const counts = new Map();
  for (const { classification } of results) {
    const value = classification[key];
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const options = parseArgs();
  const result = classifyGames(options);
  const prefix = result.dryRun ? '[Classify:dry-run]' : '[Classify]';

  for (const { gameId, gameName, classification } of result.results) {
    const subtypes = classification.subtypes.length > 0 ? ` [${classification.subtypes.join(',')}]` : '';
    const error = classification.inputs.error ? ` PARSE-ERROR: ${classification.inputs.error}` : '';
    console.log(`${prefix} ${gameId} ${gameName} ${classification.archetype} ${classification.pace}${subtypes}${error}`);
  }

  console.log(`${prefix} archetypes: ${distribution(result.results, 'archetype').map(([k, n]) => `${k}=${n}`).join(' ')}`);
  console.log(`${prefix} pace: ${distribution(result.results, 'pace').map(([k, n]) => `${k}=${n}`).join(' ')}`);
  if (!result.dryRun) {
    console.log(`${prefix} wrote ${result.written.length} configs, skipped ${result.skipped.length} config-less games (${result.skipped.join(',') || 'none'})`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  classifyGames
};
