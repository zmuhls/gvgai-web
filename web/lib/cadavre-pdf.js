const fs = require('node:fs');
const PDFDocument = require('pdfkit');
const { validatePoem } = require('./cadavre-user-store');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const TRIM = 36;
const CONTENT_MARGIN = 72;

function safeFilename(value) {
  const stem = String(value || 'exquisite-corpse')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase();
  return `${stem || 'exquisite-corpse'}.pdf`;
}

function serifFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf'
  ];
  return candidates.find((fontPath) => fs.existsSync(fontPath)) || 'Times-Roman';
}

function serifItalicFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf'
  ];
  return candidates.find((fontPath) => fs.existsSync(fontPath)) || 'Times-Italic';
}

function setPrintBoxes(page) {
  // Keep the printable page at true US Letter size. Trim and bleed metadata
  // describe the protected inner sheet; marks stay inside the MediaBox so
  // ordinary desktop printers never clip content or rescale an 8 x 10.5 crop.
  page.dictionary.data.CropBox = [0, 0, PAGE_WIDTH, PAGE_HEIGHT];
  page.dictionary.data.TrimBox = [TRIM, TRIM, PAGE_WIDTH - TRIM, PAGE_HEIGHT - TRIM];
  page.dictionary.data.BleedBox = [TRIM, TRIM, PAGE_WIDTH - TRIM, PAGE_HEIGHT - TRIM];
}

function drawCropMarks(doc) {
  const edgeX = PAGE_WIDTH - TRIM;
  const edgeY = PAGE_HEIGHT - TRIM;
  const innerGap = 4;
  const length = 14;
  doc.save().lineWidth(0.35).strokeColor('#777777');
  for (const x of [TRIM, edgeX]) {
    doc.moveTo(x, TRIM - innerGap).lineTo(x, TRIM - innerGap - length).stroke();
    doc.moveTo(x, edgeY + innerGap).lineTo(x, edgeY + innerGap + length).stroke();
  }
  for (const y of [TRIM, edgeY]) {
    doc.moveTo(TRIM - innerGap, y).lineTo(TRIM - innerGap - length, y).stroke();
    doc.moveTo(edgeX + innerGap, y).lineTo(edgeX + innerGap + length, y).stroke();
  }
  doc.restore();
}

function createPoemPdf(input) {
  const poem = validatePoem(input);
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: poem.title,
      Author: 'Cadavre Exquis players',
      Subject: 'Exquisite Corpse poem'
    },
    size: 'LETTER',
    margins: {
      top: CONTENT_MARGIN,
      right: CONTENT_MARGIN,
      bottom: CONTENT_MARGIN,
      left: CONTENT_MARGIN
    }
  });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));

  const result = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.addPage();
  doc.font(serifFont()).fillColor('#171717');
  doc.fontSize(11)
    .text('EXQUISITE CORPSE', { align: 'center', characterSpacing: 1.7 });
  doc.moveDown(1.4);
  doc.fontSize(24)
    .text(poem.title, { align: 'center', width: PAGE_WIDTH - CONTENT_MARGIN * 2 });
  doc.moveDown(1.2);

  const poemFontSize = poem.lines.length > 36 ? 13 : poem.lines.length > 20 ? 15 : 18;
  doc.fontSize(poemFontSize);
  for (const line of poem.lines) {
    doc.text(line, {
      align: 'center',
      lineGap: 4,
      width: PAGE_WIDTH - CONTENT_MARGIN * 2
    });
  }

  if (poem.reading) {
    doc.moveDown(2);
    doc.moveTo(CONTENT_MARGIN + 90, doc.y)
      .lineTo(PAGE_WIDTH - CONTENT_MARGIN - 90, doc.y)
      .lineWidth(0.5)
      .strokeColor('#777777')
      .stroke();
    doc.moveDown(1.5);
    doc.font(serifItalicFont()).fillColor('#333333').fontSize(11.5)
      .text(poem.reading, {
        align: 'left',
        lineGap: 3,
        width: PAGE_WIDTH - CONTENT_MARGIN * 2
      });
  }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index++) {
    doc.switchToPage(index);
    setPrintBoxes(doc.page);
    drawCropMarks(doc);
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(serifFont()).fontSize(8).fillColor('#666666')
      .text(
        `${index + 1} / ${range.count}`,
        CONTENT_MARGIN,
        PAGE_HEIGHT - 50,
        { align: 'center', width: PAGE_WIDTH - CONTENT_MARGIN * 2, lineBreak: false }
      );
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
  return result;
}

module.exports = {
  createPoemPdf,
  safeFilename,
  _private: { drawCropMarks, setPrintBoxes, serifFont, serifItalicFont }
};
