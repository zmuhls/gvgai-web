#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SOURCES,
  DEFAULT_FALLBACKS,
  fetchHtml,
  injectRuntimeConfig
} = require('../lib/cadavre-mirror');

async function main() {
  const pages = [
    { name: 'main', rewriteOpenSheet: true },
    { name: 'openSheet', rewriteOpenSheet: false }
  ];
  const fetched = await Promise.all(pages.map(async (page) => ({
    ...page,
    html: injectRuntimeConfig(await fetchHtml(DEFAULT_SOURCES[page.name]), {
      rewriteOpenSheet: page.rewriteOpenSheet
    })
  })));

  for (const page of fetched) {
    const destination = DEFAULT_FALLBACKS[page.name];
    const temporary = `${destination}.tmp`;
    await fs.promises.writeFile(temporary, page.html, 'utf8');
    await fs.promises.rename(temporary, destination);
    process.stdout.write(`Updated ${path.relative(process.cwd(), destination)} from canonical master.\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Cadavre UI sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
