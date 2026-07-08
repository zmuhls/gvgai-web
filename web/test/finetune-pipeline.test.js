'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FinetunePipeline, TriggerError } = require('../lib/finetune-pipeline');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal || 'SIGTERM';
  }
}

function until(cond, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('until() timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pipeline-test-'));
}

function makePipeline(overrides = {}) {
  const tempDir = makeTempDir();
  const io = { events: [], emit(event, payload) { this.events.push({ event, payload }); } };
  const telemetry = { events: [], track(e) { this.events.push(e); } };
  const children = [];
  const marbleQueue = [];

  const pipeline = new FinetunePipeline().configure({
    io,
    telemetry,
    prepareData: () => ({
      jsonlPath: path.join(tempDir, 'train.jsonl'),
      exampleCount: 24,
      traceCount: 3,
      actionDistribution: { ACTION_USE: 24 }
    }),
    ollamaLoader: {
      isOllamaAvailable: async () => false,
      loadModel: async () => ({ loaded: true })
    },
    traceStore: { getTracesForGame: () => [] },
    models: { invalidateFinetunedCache() {}, loadFinetunedModels() { return []; } },
    spawnFn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    readGameRegistry: () => new Map([[0, { id: 0, name: 'aliens' }]]),
    readFeaturedIds: () => [0],
    enqueueMarbleEval: model => marbleQueue.push(model),
    registryPath: path.join(tempDir, 'registry.json'),
    jsonlDir: tempDir,
    modelsDir: path.join(tempDir, 'models'),
    forceDryRun: false,
    ...overrides
  });
  return { pipeline, io, telemetry, children, tempDir, marbleQueue };
}

function emitLines(child, objects) {
  const text = objects.map(o => JSON.stringify(o)).join('\n') + '\n';
  child.stdout.emit('data', Buffer.from(text));
}

test('trigger rejects unknown game ids', () => {
  const { pipeline } = makePipeline();
  assert.throws(() => pipeline.trigger({ gameId: 424242 }),
    err => err instanceof TriggerError && err.code === 'INVALID_GAME');
});

test('trigger rejects a second run while one is active', async () => {
  const { pipeline, children } = makePipeline();
  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);

  assert.throws(() => pipeline.trigger({ gameId: 0 }),
    err => err instanceof TriggerError && err.code === 'RUN_IN_PROGRESS');

  children[0].emit('close', 1); // clean up
  await until(() => !pipeline.getStatus().active);
});

test('dry run completes through the full stage sequence', async () => {
  const { pipeline, io, telemetry, children, marbleQueue } = makePipeline();
  const { runId } = pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);
  assert.equal(pipeline.getStatus().run.state, 'training');

  emitLines(children[0], [
    { stage: 'start', modelId: 'gvgai-aliens-ft-1', dryRun: true },
    { stage: 'load_data', exampleCount: 24 },
    { stage: 'train_begin', totalSteps: 10, epochs: 2 },
    { stage: 'train_step', step: 5, totalSteps: 10, loss: 0.9, epoch: 1 },
    { stage: 'done', modelId: 'gvgai-aliens-ft-1', ggufPath: null }
  ]);
  children[0].stdout.emit('data', Buffer.from('non-json noise line\n'));
  children[0].emit('close', 0);
  await until(() => pipeline.getStatus().run.state === 'complete');

  const status = pipeline.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.run.runId, runId);
  assert.equal(status.run.modelId, 'gvgai-aliens-ft-1');
  assert.equal(status.run.loadedToOllama, false);
  assert.deepEqual(status.run.progress, { step: 5, totalSteps: 10, loss: 0.9, epoch: 1 });

  const completeEvent = io.events.find(e => e.event === 'finetune-complete');
  assert.ok(completeEvent, 'finetune-complete emitted');
  assert.equal(completeEvent.payload.modelId, 'gvgai-aliens-ft-1');
  assert.ok(io.events.some(e => e.event === 'finetune-progress' && e.payload.stage === 'train_step'));
  assert.deepEqual(marbleQueue, [], 'dry runs do not queue marble eval');

  const types = telemetry.events.map(e => e.eventType);
  assert.ok(types.includes('finetune_started'));
  assert.ok(types.includes('finetune_stage'));
  assert.ok(types.includes('finetune_completed'));
  assert.ok(!telemetry.events.some(e => e.payload?.stage === 'train_step'),
    'per-step progress stays off telemetry');
});

test('a real (non-dry) run loads the model into ollama', async () => {
  const loads = [];
  const { pipeline, children, marbleQueue, telemetry } = makePipeline({
    ollamaLoader: {
      isOllamaAvailable: async () => true,
      loadModel: async (opts) => { loads.push(opts); return { loaded: true }; }
    }
  });
  pipeline.trigger({ gameId: 0 });
  await until(() => children.length === 1);

  emitLines(children[0], [
    { stage: 'done', modelId: 'gvgai-aliens-ft-2', ggufPath: '/models/x.gguf' }
  ]);
  children[0].emit('close', 0);
  await until(() => pipeline.getStatus().run.state === 'complete');

  assert.equal(pipeline.getStatus().run.loadedToOllama, true);
  assert.deepEqual(loads, [{ modelId: 'gvgai-aliens-ft-2', ggufPath: '/models/x.gguf' }]);
  assert.deepEqual(marbleQueue, [{
    modelId: 'gvgai-aliens-ft-2',
    modelName: 'gvgai-aliens-ft-2',
    gameId: 0,
    gameName: 'aliens',
    provider: 'ollama-local',
    description: 'Fine-tuned on 3 aliens play(s)'
  }]);
  assert.ok(telemetry.events.some(e => e.payload?.stage === 'marble_eval_queued'));
});

test('missing python fails the run with PYTHON_MISSING', async () => {
  const { pipeline, io, children } = makePipeline();
  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);

  const err = new Error('spawn python3 ENOENT');
  err.code = 'ENOENT';
  children[0].emit('error', err);
  await until(() => pipeline.getStatus().run.state === 'failed');

  const status = pipeline.getStatus();
  assert.equal(status.active, false);
  assert.equal(status.run.error.code, 'PYTHON_MISSING');
  assert.ok(io.events.some(e => e.event === 'finetune-error' && e.payload.code === 'PYTHON_MISSING'));
});

test('data prep errors fail the run with the PrepareError code', async () => {
  const prepErr = new Error('no human traces stored for game 0');
  prepErr.code = 'NO_TRACES';
  const { pipeline, io } = makePipeline({
    prepareData: () => { throw prepErr; }
  });
  pipeline.trigger({ gameId: 0 });
  await until(() => pipeline.getStatus().run?.state === 'failed');

  assert.equal(pipeline.getStatus().run.error.code, 'NO_TRACES');
  assert.equal(pipeline.getStatus().run.stage, 'preparing');
  assert.ok(io.events.some(e => e.event === 'finetune-error' && e.payload.stage === 'preparing'));
});

test('a training error line surfaces as TRAINING_ERROR with its errorStage', async () => {
  const { pipeline, children } = makePipeline();
  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);

  emitLines(children[0], [
    { stage: 'error', errorStage: 'export_gguf', message: 'no .gguf produced' }
  ]);
  children[0].stderr.emit('data', Buffer.from('Traceback ...\n'));
  children[0].emit('close', 1);
  await until(() => pipeline.getStatus().run.state === 'failed');

  const run = pipeline.getStatus().run;
  assert.equal(run.error.code, 'TRAINING_ERROR');
  assert.equal(run.stage, 'export_gguf');
  assert.equal(run.error.message, 'no .gguf produced');
});

test('cancel kills the child and fails the run as CANCELLED', async () => {
  const { pipeline, children } = makePipeline();
  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);

  pipeline.cancel();

  assert.equal(children[0].killedWith, 'SIGTERM');
  assert.equal(pipeline.getStatus().run.error.code, 'CANCELLED');
  assert.equal(pipeline.getStatus().active, false);
  // late close from the killed child must not resurrect anything
  children[0].emit('close', 143);
  assert.equal(pipeline.getStatus().run.error.code, 'CANCELLED');

  assert.throws(() => pipeline.cancel(),
    err => err instanceof TriggerError && err.code === 'NO_ACTIVE_RUN');
});

test('shutdown kills the child and marks the run SERVER_SHUTDOWN', async () => {
  const { pipeline, children, telemetry } = makePipeline();
  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => children.length === 1);

  pipeline.shutdown();

  assert.equal(children[0].killedWith, 'SIGTERM');
  assert.equal(pipeline.getStatus().run.error.code, 'SERVER_SHUTDOWN');
  assert.ok(telemetry.events.some(e => e.eventType === 'finetune_error'));
});

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('integration: real python3 dry run writes a registry entry', { skip: !hasPython }, async () => {
  const tempDir = makeTempDir();
  const registryPath = path.join(tempDir, 'registry.json');
  const fixture = path.join(__dirname, 'fixtures', 'finetune', 'sample-train.jsonl');

  const { pipeline } = makePipeline({
    spawnFn: undefined, // real spawn
    registryPath,
    jsonlDir: tempDir,
    prepareData: (options) => {
      fs.mkdirSync(path.dirname(options.output), { recursive: true });
      fs.copyFileSync(fixture, options.output);
      return { jsonlPath: options.output, exampleCount: 5, traceCount: 1, actionDistribution: {} };
    }
  });

  pipeline.trigger({ gameId: 0, dryRun: true });
  await until(() => {
    const run = pipeline.getStatus().run;
    return run && (run.state === 'complete' || run.state === 'failed');
  }, 30000);

  const run = pipeline.getStatus().run;
  assert.equal(run.state, 'complete', `run failed: ${JSON.stringify(run.error)}`);
  assert.match(run.modelId, /^gvgai-aliens-ft-\d+$/);
  assert.equal(run.loadedToOllama, false);

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
  assert.equal(registry.models.length, 1);
  assert.equal(registry.models[0].dryRun, true);
  assert.equal(registry.models[0].provider, 'ollama-local');
});
