const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  MEMORY_SCHEMA_VERSION,
  saveMemoryRecord,
  resolveGameMemory,
  readIndex,
  createMemoryRecordFromFile
} = require('../lib/strategy-memory-store');
const promptStore = require('../lib/prompt-store');
const { buildPrompt } = require('../lib/state-converter');

function tempMemoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gvgai-strategy-memory-'));
}

function makeRecord(overrides = {}) {
  return {
    memoryKey: overrides.memoryKey || 'sha256:test-memory',
    gameId: overrides.gameId ?? 32,
    gameName: overrides.gameName || 'doorkoban',
    rulesHash: overrides.rulesHash || 'sha256:rules',
    digestHash: overrides.digestHash || overrides.memoryKey || 'sha256:test-memory',
    promptText: overrides.promptText || 'DIGEST PROMPT TEXT FOR DOORKOBAN',
    digest: {
      promptText: overrides.promptText || 'DIGEST PROMPT TEXT FOR DOORKOBAN'
    },
    evaluationStatus: overrides.evaluationStatus || 'candidate'
  };
}

test('memory store resolves accepted records by game id', () => {
  const memoryDir = tempMemoryDir();
  const record = saveMemoryRecord(makeRecord({ evaluationStatus: 'accepted' }), { memoryDir });
  const index = readIndex({ memoryDir });

  assert.equal(index.games['32'].memoryKey, record.memoryKey);
  assert.equal(resolveGameMemory(32, null, { memoryDir }).memoryKey, record.memoryKey);
});

test('v2 records built from VGDL carry a classification, surfaced in the index', () => {
  const memoryDir = tempMemoryDir();
  const projectRoot = path.resolve(__dirname, '..', '..');
  const record = createMemoryRecordFromFile({
    id: 32,
    name: 'doorkoban',
    vgdlPath: path.join(projectRoot, 'examples', 'gridphysics', 'doorkoban.txt'),
    category: 'gridphysics'
  });

  assert.equal(record.schemaVersion, MEMORY_SCHEMA_VERSION);
  assert.equal(record.classification.archetype, 'pusher-puzzle');
  assert.equal(record.classification.pace, 'deliberate');
  assert.equal(record.digest.classification, undefined);

  saveMemoryRecord({ ...record, evaluationStatus: 'accepted' }, { memoryDir });
  const index = readIndex({ memoryDir });
  assert.equal(index.games['32'].archetype, 'pusher-puzzle');
});

test('v1 records without classification still resolve', () => {
  const memoryDir = tempMemoryDir();
  saveMemoryRecord(makeRecord({ evaluationStatus: 'accepted' }), { memoryDir });
  const resolved = resolveGameMemory(32, null, { memoryDir });
  assert.equal(resolved.memoryKey, 'sha256:test-memory');
  assert.equal(readIndex({ memoryDir }).games['32'].archetype, null);
});

test('memory store hides candidate records unless explicitly allowed', () => {
  const memoryDir = tempMemoryDir();
  saveMemoryRecord(makeRecord({ evaluationStatus: 'candidate' }), { memoryDir });

  assert.equal(resolveGameMemory(32, null, { memoryDir }), null);
  assert.equal(resolveGameMemory(32, null, { memoryDir, allowCandidate: true }).evaluationStatus, 'candidate');
});

test('prompt resolution injects only accepted digest memory for normal prompts', () => {
  const memoryDir = tempMemoryDir();
  const originalDir = process.env.STRATEGY_MEMORY_DIR;
  process.env.STRATEGY_MEMORY_DIR = memoryDir;

  try {
    saveMemoryRecord(makeRecord({ evaluationStatus: 'candidate', promptText: 'CANDIDATE DIGEST TEXT' }), { memoryDir });
    let config = promptStore.resolveGamePromptConfig(32, 0);
    assert.doesNotMatch(config.gameContent, /CANDIDATE DIGEST TEXT/);

    saveMemoryRecord(makeRecord({ evaluationStatus: 'accepted', promptText: 'ACCEPTED DIGEST TEXT' }), { memoryDir });
    config = promptStore.resolveGamePromptConfig(32, 0);
    assert.equal(config.gameContent, 'ACCEPTED DIGEST TEXT');
    assert.equal(config.strategicDigestMemory.evaluationStatus, 'accepted');
  } finally {
    if (originalDir === undefined) delete process.env.STRATEGY_MEMORY_DIR;
    else process.env.STRATEGY_MEMORY_DIR = originalDir;
  }
});

test('STRATEGY_MEMORY_DISABLED=1 blocks accepted records from prompts', () => {
  const memoryDir = tempMemoryDir();
  const originalDir = process.env.STRATEGY_MEMORY_DIR;
  const originalKill = process.env.STRATEGY_MEMORY_DISABLED;
  process.env.STRATEGY_MEMORY_DIR = memoryDir;
  process.env.STRATEGY_MEMORY_DISABLED = '1';

  try {
    saveMemoryRecord(makeRecord({ evaluationStatus: 'accepted', promptText: 'ACCEPTED DIGEST TEXT' }), { memoryDir });
    promptStore.invalidateCache();
    const config = promptStore.resolveGamePromptConfig(32, 0, { strategyMemory: 'accepted' });
    assert.notEqual(config.gameContent, 'ACCEPTED DIGEST TEXT');
    assert.equal(config.strategicDigestMemory, null);
  } finally {
    if (originalDir === undefined) delete process.env.STRATEGY_MEMORY_DIR;
    else process.env.STRATEGY_MEMORY_DIR = originalDir;
    if (originalKill === undefined) delete process.env.STRATEGY_MEMORY_DISABLED;
    else process.env.STRATEGY_MEMORY_DISABLED = originalKill;
    promptStore.invalidateCache();
  }
});

test('accepted digest memory does not change codeProtocol prompts', () => {
  const memoryDir = tempMemoryDir();
  const originalDir = process.env.STRATEGY_MEMORY_DIR;
  process.env.STRATEGY_MEMORY_DIR = memoryDir;

  try {
    saveMemoryRecord(makeRecord({
      gameId: 0,
      gameName: 'aliens',
      memoryKey: 'sha256:aliens-test-memory',
      digestHash: 'sha256:aliens-test-memory',
      evaluationStatus: 'accepted',
      promptText: 'ACCEPTED ALIENS DIGEST TEXT'
    }), { memoryDir });

    const config = promptStore.resolveGamePromptConfig(0, 0);
    assert.equal(config.codeProtocol.enabled, true);
    assert.doesNotMatch(config.gameContent, /ACCEPTED ALIENS DIGEST TEXT/);

    const prompt = buildPrompt({
      blockSize: 10,
      observationGridNum: 30,
      observationGridMaxRow: 11,
      avatarPosition: [160, 100],
      avatarHealthPoints: 100,
      gameScore: 0,
      gameTick: 0,
      availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE']
    }, config);
    assert.equal(prompt.responseMode, 'code');
    assert.doesNotMatch(prompt.userMessage, /ACCEPTED ALIENS DIGEST TEXT/);
  } finally {
    if (originalDir === undefined) delete process.env.STRATEGY_MEMORY_DIR;
    else process.env.STRATEGY_MEMORY_DIR = originalDir;
  }
});
