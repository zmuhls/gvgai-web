const fs = require('fs');
const path = require('path');
const defaultTelemetry = require('./telemetry-store');

const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_FALLBACK_CACHE_TTL_MS = 5000;
const DEFAULT_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = 'ollama:gemma3:4b';
const DEFAULT_CANONICAL_BASE = 'https://milwrite.github.io/cadavre-exquis/';
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
    readyEndpoint: '/api/cadavre/ready',
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
  const canonicalBase = options.canonicalBase || DEFAULT_CANONICAL_BASE;
  transformed = transformed.replace(
    /\b(href|src)=(['"])(?:\.\/)?assets\//gi,
    `$1=$2${canonicalBase}assets/`
  );

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
  const fallbackCacheTtlMs = options.fallbackCacheTtlMs ?? DEFAULT_FALLBACK_CACHE_TTL_MS;
  const telemetry = options.telemetry === false ? null : (options.telemetry || defaultTelemetry);
  const cache = new Map();
  const refreshes = new Map();
  const stats = {
    requests: 0,
    cacheHits: 0,
    coalescedRequests: 0,
    remoteFetches: 0,
    remoteFailures: 0,
    localFallbackReads: 0,
    staleRemoteServed: 0
  };

  function cacheTtlFor(entry) {
    return entry.origin === 'local' ? fallbackCacheTtlMs : cacheTtlMs;
  }

  function isFresh(entry, now) {
    return now - entry.fetchedAt < cacheTtlFor(entry);
  }

  function refreshSourceUrl(source, now) {
    const url = new URL(source);
    url.searchParams.set('cadavre_v', String(Math.floor(now / Math.max(1, cacheTtlMs))));
    return url.toString();
  }

  function trackCacheSnapshot(page, outcome, latencyMs) {
    if (!telemetry?.track) return;
    const reused = stats.cacheHits + stats.coalescedRequests + stats.staleRemoteServed;
    try {
      telemetry.track({
        eventFamily: 'system',
        eventType: 'cadavre_cache_snapshot',
        source: 'cadavre-mirror',
        latencyMs,
        payload: { cache: 'html_mirror', page, outcome },
        metrics: {
          requests: stats.requests,
          cache_hits: stats.cacheHits,
          coalesced_requests: stats.coalescedRequests,
          remote_fetches: stats.remoteFetches,
          remote_failures: stats.remoteFailures,
          local_fallback_reads: stats.localFallbackReads,
          stale_remote_served: stats.staleRemoteServed,
          upstream_requests_avoided: reused,
          hit_ratio: stats.requests ? stats.cacheHits / stats.requests : 0,
          reuse_ratio: stats.requests ? reused / stats.requests : 0,
          entries: cache.size,
          ttl_ms: cacheTtlMs,
          fallback_ttl_ms: fallbackCacheTtlMs
        }
      });
    } catch {
      // Cache logging stays best-effort so the page response proceeds.
    }
  }

  async function refreshPage(page, now, cached) {
    const startedAt = Date.now();
    let outcome = 'failed';
    stats.remoteFetches += 1;
    try {
      const remote = await fetchHtml(refreshSourceUrl(sources[page], now), {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.fetchTimeoutMs
      });
      const html = injectRuntimeConfig(remote, { rewriteOpenSheet: page === 'main' });
      cache.set(page, { fetchedAt: now, html, origin: 'github' });
      outcome = 'github';
      return { html, source: 'github' };
    } catch (error) {
      stats.remoteFailures += 1;
      if (cached?.origin === 'github') {
        stats.staleRemoteServed += 1;
        outcome = 'stale';
        return { html: cached.html, source: 'cache' };
      }

      stats.localFallbackReads += 1;
      const fallback = await fs.promises.readFile(fallbackPaths[page], 'utf8');
      const html = injectRuntimeConfig(fallback, { rewriteOpenSheet: page === 'main' });
      cache.set(page, { fetchedAt: now, html, origin: 'local' });
      outcome = 'local';
      return { html, source: 'local' };
    } finally {
      trackCacheSnapshot(page, outcome, Date.now() - startedAt);
    }
  }

  async function getPage(page, now = Date.now()) {
    if (!Object.hasOwn(sources, page)) throw new Error(`Unknown Cadavre mirror page: ${page}`);
    stats.requests += 1;
    const cached = cache.get(page);
    if (cached && isFresh(cached, now)) {
      stats.cacheHits += 1;
      return { html: cached.html, source: 'cache' };
    }

    const activeRefresh = refreshes.get(page);
    if (activeRefresh) {
      stats.coalescedRequests += 1;
      return activeRefresh;
    }

    const refresh = refreshPage(page, now, cached).finally(() => {
      refreshes.delete(page);
    });
    refreshes.set(page, refresh);
    return refresh;
  }

  function getCacheStatus(now = Date.now()) {
    const pages = {};
    for (const page of Object.keys(sources)) {
      const entry = cache.get(page);
      pages[page] = {
        cached: Boolean(entry),
        origin: entry?.origin || null,
        ageMs: entry ? Math.max(0, now - entry.fetchedAt) : null,
        ttlMs: entry ? cacheTtlFor(entry) : null,
        fresh: entry ? isFresh(entry, now) : false,
        refreshInFlight: refreshes.has(page)
      };
    }
    return { pages, stats: { ...stats } };
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

  return { getPage, getCacheStatus, handler };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_FALLBACK_CACHE_TTL_MS,
  DEFAULT_SOURCES,
  DEFAULT_FALLBACKS,
  DEFAULT_MODEL,
  DEFAULT_CANONICAL_BASE,
  runtimeConfigScript,
  injectRuntimeConfig,
  fetchHtml,
  createCadavreMirror
};
