const assert = require('node:assert/strict');
const test = require('node:test');

const { createPoemPdf, safeFilename } = require('../lib/cadavre-pdf');

test('cadavre PDF is Letter-sized with safe trim, crop, and bleed boxes', async () => {
  const pdf = await createPoemPdf({
    title: 'The red orchard',
    lines: ['night folds the ladder', 'a bright moth answers'],
    reading: 'The ladder and moth make ascent feel fragile.'
  });
  const source = pdf.toString('latin1');

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(source, /\/MediaBox \[0 0 612 792\]/);
  assert.match(source, /\/CropBox \[0 0 612 792\]/);
  assert.match(source, /\/TrimBox \[36 36 576 756\]/);
  assert.match(source, /\/BleedBox \[36 36 576 756\]/);
  assert.equal((source.match(/\/Type \/Page\b/g) || []).length, 1);
  assert.equal(safeFilename('The red orchard!'), 'the-red-orchard.pdf');
});
