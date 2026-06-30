const assert = require('node:assert/strict');
const test = require('node:test');
const { getConfig, loadConfig, PROJECT_ROOT } = require('../lib/runtime-config');

test('GVGAI Java classpath avoids project root fallback', () => {
  const config = getConfig();
  const tokens = config.gvgai.classpath.split(':');

  assert.ok(tokens.includes('out'));
  assert.ok(tokens.includes('gson-2.6.2.jar'));
  assert.equal(tokens.includes('.'), false);
});

test('runtime config falls back when config.json read times out', () => {
  const error = new Error('read timed out');
  error.code = 'ETIMEDOUT';
  const loaded = loadConfig({
    env: {},
    exists: () => false,
    reader: () => {
      throw error;
    },
    timeoutMs: 5
  });

  assert.equal(loaded.status.fallback, true);
  assert.equal(loaded.status.timedOut, true);
  assert.equal(loaded.config.server.port, 3000);
  assert.equal(loaded.config.gvgai.projectRoot, PROJECT_ROOT);
});
