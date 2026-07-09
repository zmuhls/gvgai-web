const assert = require('node:assert/strict');
const test = require('node:test');

const { _private } = require('../routes/cadavre');

test('cadavre route keeps only valid, bounded chat messages', () => {
  const messages = _private.cleanMessages([
    { role: 'system', content: 'rules' },
    { role: 'tool', content: 'becomes user' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'x'.repeat(10000) }
  ]);

  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { role: 'system', content: 'rules' });
  assert.deepEqual(messages[1], { role: 'user', content: 'becomes user' });
  assert.equal(messages[2].content.length, 9000);
});

test('cadavre route accepts explicit local endpoint without a key', () => {
  const prevEndpoint = process.env.CADAVRE_ENDPOINT;
  const prevModel = process.env.CADAVRE_MODEL;
  const prevOllama = process.env.OLLAMA_API_KEY;
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  try {
    process.env.CADAVRE_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
    delete process.env.CADAVRE_MODEL;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const candidates = _private.providerCandidates('exquisite-corpse');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].provider, 'cadavre-endpoint');
    assert.equal(candidates[0].model, 'exquisite-corpse');
  } finally {
    if (prevEndpoint === undefined) delete process.env.CADAVRE_ENDPOINT;
    else process.env.CADAVRE_ENDPOINT = prevEndpoint;
    if (prevModel === undefined) delete process.env.CADAVRE_MODEL;
    else process.env.CADAVRE_MODEL = prevModel;
    if (prevOllama === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = prevOllama;
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;
  }
});

test('cadavre route clamps numeric settings', () => {
  assert.equal(_private.clampNumber(999, 160, 16, 500), 500);
  assert.equal(_private.clampNumber(-5, 160, 16, 500), 16);
  assert.equal(_private.clampNumber('bad', 160, 16, 500), 160);
});
