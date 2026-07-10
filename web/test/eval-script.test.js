const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseArgs } = require('../scripts/run-arcade-eval');

test('arcade eval script parses dry-run, selection, and timeout options', () => {
  const options = parseArgs([
    '--dry-run',
    '--combinatorial-strategies',
    '--ollama-offline',
    '--game-count', '3',
    '--game-id', '0,4',
    '--model', 'gpt-oss:120b',
    '--ollama-model', 'qwen2.5:0.5b',
    '--strategy-id', 'safe,puzzle',
    '--limit', '2',
    '--repeats', '2',
    '--timeout-ms', '45000',
    '--ready-timeout-ms', '60000',
    '--action-timeout-ms', '2500',
    '--max-actions', '40',
    '--out', 'evals/results.json'
  ]);

  assert.equal(options.dryRun, true);
  assert.equal(options.combinatorialStrategies, true);
  assert.equal(options.ollamaOffline, true);
  assert.equal(options.gameCount, '3');
  assert.equal(options.gameIds, '0,4');
  assert.equal(options.modelIds, 'gpt-oss:120b');
  assert.equal(options.ollamaModel, 'qwen2.5:0.5b');
  assert.equal(options.strategyIds, 'safe,puzzle');
  assert.equal(options.limit, '2');
  assert.equal(options.repeats, '2');
  assert.equal(options.timeoutMs, '45000');
  assert.equal(options.readyTimeoutMs, '60000');
  assert.equal(options.actionTimeoutMs, '2500');
  assert.equal(options.maxActions, '40');
  assert.equal(options.out, 'evals/results.json');
});

test('arcade eval script loads repository env before creating runtime clients', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'run-arcade-eval.js'), 'utf-8');
  const envIndex = source.indexOf('await loadRootEnv()');
  const runnerIndex = source.indexOf("require('../lib/batch-evaluator')");

  assert.ok(envIndex !== -1);
  assert.ok(runnerIndex !== -1);
  assert.ok(envIndex < runnerIndex);
});
