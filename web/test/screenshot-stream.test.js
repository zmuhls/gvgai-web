const assert = require('node:assert/strict');
const test = require('node:test');

const { isCompletePng, screenshotDigest } = require('../server');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function fakeCompletePng(payload = 'frame') {
  return Buffer.concat([
    PNG_SIG,
    Buffer.from('0000000d4948445200000001000000010806000000', 'hex'),
    Buffer.from(payload),
    PNG_IEND
  ]);
}

test('streamed frame validator rejects partial PNG writes', () => {
  assert.equal(isCompletePng(Buffer.alloc(0)), false);
  assert.equal(isCompletePng(Buffer.concat([PNG_SIG, Buffer.from('partial-frame')])), false);
  assert.equal(isCompletePng(fakeCompletePng()), true);
});

test('streamed frame digest changes when content changes at the same size', () => {
  const first = fakeCompletePng('A'.repeat(16));
  const second = fakeCompletePng('B'.repeat(16));

  assert.equal(first.length, second.length);
  assert.notEqual(screenshotDigest(first), screenshotDigest(second));
});
