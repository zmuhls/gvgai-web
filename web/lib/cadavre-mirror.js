const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = 'legion:exquisite-corpse';
const DEFAULT_SOURCES = {
  main: 'https://raw.githubusercontent.com/milwrite/cadavre-exquis/master/index.html',
  openSheet: 'https://raw.githubusercontent.com/milwrite/cadavre-exquis/master/ui/corpse.html'
};
const DEFAULT_FALLBACKS = {
  main: path.join(__dirname, '..', 'public', 'cadavre.html'),
  openSheet: path.join(__dirname, '..', 'public', 'cadavre-open-sheet.html')
};

function runtimeConfigScript() {
  const config = JSON.stringify({
    endpoint: '/api/cadavre/chat',
    model: DEFAULT_MODEL,
    modelsEndpoint: '/api/cadavre/models'
  });
  return `<script id="cadavre-runtime-config">window.CORPSE_CONFIG = Object.freeze(${config});</script>`;
}

function injectRuntimeConfig(html, options = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('Cadavre mirror received empty HTML');
  }

  let transformed = html.replace(
    /\s*<script\b[^>]*\bid=["']cadavre-runtime-config["'][^>]*>[\s\S]*?<\/script>/gi,
    ''
  ).replace(
    /\s*<script\b[^>]*\bsrc=["'][^"']*config\.local\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi,
    ''
  );
  if (options.rewriteOpenSheet !== false) {
    transformed = transformed.replace(
      /href=(["'])(?:\.\/)?ui\/corpse\.html(?:\?[^"']*)?\1/gi,
      'href="/cadavre/open-sheet"'
    );
  }

  const script = runtimeConfigScript();
  if (/<\/head>/i.test(transformed)) {
    return transformed.replace(/<\/head>/i, `  ${script}\n</head>`);
  }
  return `${script}\n${transformed}`;
}

async function fetchHtml(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl || fetch)(url, {
      headers: { Accept: 'text/html' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function createCadavreMirror(options = {}) {
  const sources = { ...DEFAULT_SOURCES, ...(options.sources || {}) };
  const fallbackPaths = {
    ...DEFAULT_FALLBACKS,
    ...(options.fallbackPaths || {}),
    ...(options.fallbackPath ? { main: options.fallbackPath, openSheet: options.fallbackPath } : {})
  };
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map();

  async function getPage(page, now = Date.now()) {
    if (!Object.hasOwn(sources, page)) throw new Error(`Unknown Cadavre mirror page: ${page}`);
    const cached = cache.get(page);
    if (cached && now - cached.fetchedAt < cacheTtlMs) {
      return { html: cached.html, source: 'cache' };
    }

    try {
      const remote = await fetchHtml(sources[page], {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.fetchTimeoutMs
      });
      const html = injectRuntimeConfig(remote, { rewriteOpenSheet: page === 'main' });
      cache.set(page, { fetchedAt: now, html });
      return { html, source: 'github' };
    } catch (error) {
      if (cached) return { html: cached.html, source: 'cache' };
      const fallback = await fs.promises.readFile(fallbackPaths[page], 'utf8');
      return {
        html: injectRuntimeConfig(fallback, { rewriteOpenSheet: page === 'main' }),
        source: 'local'
      };
    }
  }

  async function handler(page, req, res) {
    try {
      const result = await getPage(page);
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
      res.type('html').send(result.html);
    } catch {
      res.status(503).type('text').send('Cadavre Exquis is temporarily unavailable.');
    }
  }

  return { getPage, handler };
}

module.exports = {
  DEFAULT_SOURCES,
  DEFAULT_FALLBACKS,
  DEFAULT_MODEL,
  runtimeConfigScript,
  injectRuntimeConfig,
  fetchHtml,
  createCadavreMirror
};
