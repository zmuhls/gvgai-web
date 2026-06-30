#!/usr/bin/env node
const path = require('path');

const { selectGames, projectRoot } = require('../lib/game-registry');
const {
  upsertMemoryForGame,
  DEFAULT_MEMORY_DIR
} = require('../lib/strategy-memory-store');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    all: false,
    gameIds: [],
    featured: false,
    memoryDir: null,
    projectRoot: projectRoot()
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--featured') options.featured = true;
    else if (arg === '--game-id') options.gameIds = argv[++i] || '';
    else if (arg === '--memory-dir') options.memoryDir = path.resolve(argv[++i] || DEFAULT_MEMORY_DIR);
    else if (arg === '--project-root') options.projectRoot = path.resolve(argv[++i] || options.projectRoot);
  }

  return options;
}

function generateStrategyMemory(options = {}) {
  const games = selectGames(options);
  const records = [];
  const errors = [];

  for (const game of games) {
    try {
      const record = upsertMemoryForGame(game, {
        dryRun: options.dryRun,
        memoryDir: options.memoryDir
      });
      records.push(record);
    } catch (error) {
      errors.push({
        gameId: game.id,
        gameName: game.name,
        message: error.message
      });
    }
  }

  return {
    status: errors.length > 0 ? 'completed_with_errors' : 'completed',
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    memoryDir: options.memoryDir || DEFAULT_MEMORY_DIR,
    games: games.map(game => ({ id: game.id, name: game.name, file: game.file })),
    records,
    errors
  };
}

function main() {
  const options = parseArgs();
  const result = generateStrategyMemory(options);
  const prefix = result.dryRun ? '[StrategyMemory:dry-run]' : '[StrategyMemory]';

  for (const record of result.records) {
    const preview = String(record.promptText || '').split(/\r?\n/).slice(0, 2).join(' ');
    console.log(`${prefix} ${record.gameId} ${record.gameName} ${record.memoryKey} ${record.evaluationStatus}`);
    console.log(`  ${preview}`);
  }
  for (const error of result.errors) {
    console.error(`${prefix} ${error.gameId} ${error.gameName} ERROR ${error.message}`);
  }
  console.log(`${prefix} ${result.records.length}/${result.games.length} records ${result.dryRun ? 'planned' : 'written'} in ${result.memoryDir}`);

  if (result.errors.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  generateStrategyMemory
};
