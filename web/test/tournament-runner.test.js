const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { availablePort, parseArgs } = require('../scripts/run-model-tournament');

test('tournament parser accepts the local roster flag', () => {
  assert.equal(parseArgs(['--local']).localOnly, true);
});

test('tournament chooses a fallback port without disturbing an existing listener', async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '0.0.0.0', resolve);
  });

  try {
    const occupiedPort = listener.address().port;
    const selectedPort = await availablePort(occupiedPort);
    assert.notEqual(selectedPort, occupiedPort);
    assert.ok(selectedPort > 0);
  } finally {
    await new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    });
  }
});
