'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadModel, resolveModelfile, LoaderError } = require('../lib/ollama-loader');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-loader-test-'));
}

test('resolveModelfile generates a minimal Modelfile with no TEMPLATE line', () => {
  const dir = makeTempDir();
  const gguf = path.join(dir, 'unsloth.Q4_K_M.gguf');
  fs.writeFileSync(gguf, 'fake');

  const content = resolveModelfile(gguf);

  assert.ok(content.startsWith(`FROM ${gguf}`), 'FROM uses the absolute gguf path');
  assert.match(content, /PARAMETER num_predict 200/);
  assert.match(content, /PARAMETER temperature/);
  assert.ok(!/^TEMPLATE/m.test(content), 'no TEMPLATE override — GGUF metadata wins');
  assert.ok(!/max_tokens/.test(content), 'max_tokens is not a valid Ollama parameter');
});

test('resolveModelfile prefers an Unsloth Modelfile and rewrites FROM to absolute', () => {
  const dir = makeTempDir();
  const gguf = path.join(dir, 'unsloth.Q4_K_M.gguf');
  fs.writeFileSync(gguf, 'fake');
  fs.writeFileSync(path.join(dir, 'Modelfile'),
    'FROM ./unsloth.Q4_K_M.gguf\nTEMPLATE """{{ .Prompt }}"""\nPARAMETER stop "<end_of_turn>"\n');

  const content = resolveModelfile(gguf);

  assert.ok(content.includes(`FROM ${gguf}`), 'relative FROM rewritten to absolute');
  assert.ok(!content.includes('FROM ./'), 'no relative FROM survives');
  assert.ok(content.includes('PARAMETER stop'), 'rest of the Unsloth Modelfile preserved');
});

test('loadModel throws GGUF_MISSING for a nonexistent path', async () => {
  await assert.rejects(
    loadModel({ modelId: 'x-ft-1', ggufPath: '/nonexistent/model.gguf' }),
    err => err instanceof LoaderError && err.code === 'GGUF_MISSING'
  );
});

test('loadModel throws OLLAMA_CLI_MISSING when the binary is absent', async () => {
  const dir = makeTempDir();
  const gguf = path.join(dir, 'model.gguf');
  fs.writeFileSync(gguf, 'fake');

  await assert.rejects(
    loadModel({ modelId: 'x-ft-1', ggufPath: gguf, ollamaBin: '/nonexistent/ollama-bin' }),
    err => err instanceof LoaderError && err.code === 'OLLAMA_CLI_MISSING'
  );
  assert.ok(fs.existsSync(path.join(dir, 'Modelfile.ollama')), 'Modelfile written before spawn');
});
