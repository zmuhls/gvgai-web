const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_EVENT_LIMIT = 500;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_FLUSH_MS = 3000;
const DEFAULT_FALLBACK_READ_BYTES = 2 * 1024 * 1024;
// How far back the Supabase fetch reaches when building a dashboard snapshot.
// Aggregation itself is not time-windowed (see buildDashboardSnapshot); this
// only bounds the cloud query. The JSONL fallback reads its tail bytes instead.
const DEFAULT_DASHBOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Chatty per-tick events (llm_decision, game_state_tick) outnumber completion
// events ~50:1, so aggregate scans must not be capped at the newest few hundred
// events or the completions get crowded out.
const DASHBOARD_SCAN_LIMIT = 5000;
const EVENT_FAMILIES = new Set([
  'evaluation',
  'user_experience',
  'clickthrough',
  'model_telemetry',
  'trace',
  'system'
]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstFiniteNumber(values, fallback = 0) {
  for (const value of values) {
    const parsed = parseFiniteNumber(value);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function trimTrailingSlash(value) {
  return value ? String(value).replace(/\/+$/, '') : '';
}

function cleanToken(value, fallback) {
  const raw = String(value || fallback || '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function cleanString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).slice(0, 300);
}

function cleanInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  const sorted = values
    .map(value => Number(value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

function percent(numerator, denominator) {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

class TelemetryStore {
  constructor() {
    this.configured = false;
    this.enabled = true;
    this.io = null;
    this.maxEvents = DEFAULT_EVENT_LIMIT;
    this.batchSize = DEFAULT_BATCH_SIZE;
    this.flushMs = DEFAULT_FLUSH_MS;
    this.tableName = 'telemetry_events';
    this.fallbackPath = path.resolve(__dirname, '..', 'data', 'telemetry-events.jsonl');
    this.fallbackMode = 'on-error';
    this.fallbackReadBytes = DEFAULT_FALLBACK_READ_BYTES;
    this.supabaseUrl = '';
    this.supabaseServiceRoleKey = '';
    this.events = [];
    this.buffer = [];
    this.flushTimer = null;
    this.flushInFlight = false;
    this.stats = {
      accepted: 0,
      persisted: 0,
      fallback: 0,
      failures: 0,
      dropped: 0,
      // lastError mirrors the most recent failure of either kind for
      // backward-compatible consumers; lastWriteError / lastReadError let the
      // status surface tell a flush (write) failure apart from a fetch (read)
      // failure instead of labeling every error a "write error".
      lastError: null,
      lastWriteError: null,
      lastReadError: null,
      lastFlushAt: null
    };
  }

  configure(options = {}) {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const env = options.useEnv === false ? {} : process.env;

    this.io = options.io || this.io || null;
    this.enabled = options.enabled ?? env.TELEMETRY_ENABLED !== 'false';
    this.maxEvents = parsePositiveInteger(options.maxEvents || env.TELEMETRY_EVENT_LIMIT, DEFAULT_EVENT_LIMIT);
    this.batchSize = parsePositiveInteger(options.batchSize || env.TELEMETRY_BATCH_SIZE, DEFAULT_BATCH_SIZE);
    this.flushMs = options.flushMs === 0
      ? 0
      : parsePositiveInteger(options.flushMs || env.TELEMETRY_FLUSH_MS, DEFAULT_FLUSH_MS);
    this.tableName = cleanToken(options.tableName || env.SUPABASE_TELEMETRY_TABLE, 'telemetry_events');
    this.fallbackMode = cleanToken(options.fallbackMode || env.TELEMETRY_FALLBACK_MODE, 'on-error');
    this.fallbackPath = path.resolve(options.fallbackPath || env.TELEMETRY_FALLBACK_PATH || this.fallbackPath);
    this.fallbackReadBytes = parsePositiveInteger(
      options.fallbackReadBytes || env.TELEMETRY_FALLBACK_READ_BYTES,
      DEFAULT_FALLBACK_READ_BYTES
    );
    const hasSupabaseUrl = Object.prototype.hasOwnProperty.call(options, 'supabaseUrl');
    const hasServiceRoleKey = Object.prototype.hasOwnProperty.call(options, 'supabaseServiceRoleKey');
    this.supabaseUrl = trimTrailingSlash(hasSupabaseUrl ? options.supabaseUrl : env.SUPABASE_URL);
    this.supabaseServiceRoleKey = hasServiceRoleKey
      ? (options.supabaseServiceRoleKey || '')
      : (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '');
    this.configured = true;

    if (this.enabled && this.flushMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(error => {
          this.recordWriteError(error.message);
        });
      }, this.flushMs);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }

    return this.getStorageStatus();
  }

  createRunId(prefix = 'run') {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
    return `${cleanToken(prefix, 'run')}-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  }

  isSupabaseReady() {
    return Boolean(this.enabled && this.supabaseUrl && this.supabaseServiceRoleKey);
  }

  getStorageStatus() {
    if (!this.enabled) {
      return {
        state: 'disabled',
        label: 'Telemetry disabled',
        table: this.tableName,
        fallbackPath: this.fallbackPath
      };
    }

    if (!this.supabaseUrl || !this.supabaseServiceRoleKey) {
      return {
        state: 'fallback',
        label: 'Awaiting Supabase credentials',
        table: this.tableName,
        fallbackPath: this.fallbackPath
      };
    }

    if (this.stats.lastWriteError) {
      return {
        state: 'error',
        label: 'Supabase write error',
        table: this.tableName,
        fallbackPath: this.fallbackPath,
        lastError: this.stats.lastWriteError,
        lastWriteError: this.stats.lastWriteError,
        lastReadError: this.stats.lastReadError
      };
    }

    if (this.stats.lastReadError) {
      return {
        state: 'degraded',
        label: 'Supabase read error',
        table: this.tableName,
        fallbackPath: this.fallbackPath,
        lastError: this.stats.lastReadError,
        lastReadError: this.stats.lastReadError
      };
    }

    return {
      state: 'connected',
      label: 'Supabase ready',
      table: this.tableName,
      fallbackPath: this.fallbackPath
    };
  }

  recordWriteError(message) {
    this.stats.failures += 1;
    this.stats.lastWriteError = message;
    this.stats.lastError = message;
  }

  recordReadError(message) {
    this.stats.failures += 1;
    this.stats.lastReadError = message;
    this.stats.lastError = message;
  }

  normalizeEvent(input = {}) {
    const eventType = cleanToken(input.eventType || input.event_type || input.name, 'event');
    let eventFamily = cleanToken(input.eventFamily || input.event_family, 'system');
    if (!EVENT_FAMILIES.has(eventFamily)) eventFamily = 'system';

    const latencyMs = parseNonNegativeNumber(input.latencyMs ?? input.latency_ms);
    const value = parseNonNegativeNumber(input.value);
    const createdAt = input.createdAt || input.created_at || new Date().toISOString();
    const payload = cleanObject(input.payload);
    const metrics = cleanObject(input.metrics);

    if (latencyMs !== null && metrics.latency_ms === undefined) metrics.latency_ms = latencyMs;
    if (value !== null && metrics.value === undefined) metrics.value = value;

    return {
      event_id: crypto.randomUUID(),
      created_at: createdAt,
      event_family: eventFamily,
      event_type: eventType,
      source: cleanToken(input.source, 'server'),
      session_id: cleanString(input.sessionId || input.session_id),
      run_id: cleanString(input.runId || input.run_id),
      game_id: cleanInteger(input.gameId ?? input.game_id),
      level_id: cleanInteger(input.levelId ?? input.level_id),
      model_id: cleanString(input.modelId || input.model_id),
      provider: cleanString(input.provider),
      latency_ms: latencyMs === null ? null : Math.round(latencyMs),
      value,
      payload,
      metrics
    };
  }

  track(input = {}) {
    if (!this.enabled) return null;

    const event = this.normalizeEvent(input);
    this.stats.accepted += 1;
    this.events.push(event);
    while (this.events.length > this.maxEvents) {
      this.events.shift();
      this.stats.dropped += 1;
    }

    if (this.io) {
      this.io.emit('telemetry-event', this.publicEvent(event));
    }

    if (this.configured) {
      this.buffer.push(event);
      if (this.buffer.length >= this.batchSize) {
        this.flush().catch(error => {
          this.recordWriteError(error.message);
        });
      }
    }

    return event;
  }

  async flush() {
    if (!this.enabled || this.buffer.length === 0 || this.flushInFlight) return;

    this.flushInFlight = true;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      if (this.isSupabaseReady()) {
        // Idempotent insert: event_id has a unique index, so a re-flushed or
        // backfilled batch resolves as a no-op instead of a 409 write error.
        await this.writeSupabase(batch, { ignoreDuplicates: true });
        this.stats.persisted += batch.length;
        this.stats.lastFlushAt = new Date().toISOString();
        this.stats.lastWriteError = null;
        if (!this.stats.lastReadError) this.stats.lastError = null;

        if (this.fallbackMode === 'always') {
          this.writeFallback(batch);
        }
      } else {
        this.writeFallback(batch);
      }
    } catch (error) {
      this.recordWriteError(error.message);
      this.writeFallback(batch);
    } finally {
      this.flushInFlight = false;
    }
  }

  async writeSupabase(events, options = {}) {
    const params = new URLSearchParams();
    if (options.ignoreDuplicates) params.set('on_conflict', 'event_id');
    const query = params.toString() ? `?${params}` : '';
    const response = await fetch(`${this.supabaseUrl}/rest/v1/${this.tableName}${query}`, {
      method: 'POST',
      headers: this.supabaseHeaders(options.ignoreDuplicates
        ? 'resolution=ignore-duplicates,return=minimal'
        : 'return=minimal'),
      body: JSON.stringify(events.map(event => this.databaseRow(event)))
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${response.status}: ${body.slice(0, 300)}`);
    }
  }

  supabaseHeaders(prefer = null) {
    const headers = {
      apikey: this.supabaseServiceRoleKey,
      Authorization: `Bearer ${this.supabaseServiceRoleKey}`,
      'Content-Type': 'application/json'
    };
    if (prefer) headers.Prefer = prefer;
    return headers;
  }

  async readSupabaseEvents(options = {}) {
    if (!this.isSupabaseReady()) return null;

    const limit = Math.max(1, Math.min(parsePositiveInteger(options.limit, this.maxEvents), this.maxEvents));
    const windowMs = parsePositiveInteger(options.windowMs, 10 * 60 * 1000);
    const since = new Date(Date.now() - windowMs).toISOString();
    const params = new URLSearchParams({
      select: [
        'event_id',
        'created_at',
        'event_family',
        'event_type',
        'source',
        'session_id',
        'run_id',
        'game_id',
        'level_id',
        'model_id',
        'provider',
        'latency_ms',
        'value',
        'payload',
        'metrics'
      ].join(','),
      created_at: `gte.${since}`,
      order: 'created_at.desc',
      limit: String(limit)
    });

    const response = await fetch(`${this.supabaseUrl}/rest/v1/${this.tableName}?${params}`, {
      method: 'GET',
      headers: this.supabaseHeaders()
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase read ${response.status}: ${body.slice(0, 300)}`);
    }

    const rows = await response.json();
    return rows.map(row => this.eventFromDatabaseRow(row));
  }

  writeFallback(events) {
    fs.mkdirSync(path.dirname(this.fallbackPath), { recursive: true });
    fs.appendFileSync(
      this.fallbackPath,
      events.map(event => JSON.stringify(event)).join('\n') + '\n',
      'utf-8'
    );
    this.stats.fallback += events.length;
    this.stats.lastFlushAt = new Date().toISOString();
  }

  databaseRow(event) {
    return {
      event_id: event.event_id,
      created_at: event.created_at,
      event_family: event.event_family,
      event_type: event.event_type,
      source: event.source,
      session_id: event.session_id,
      run_id: event.run_id,
      game_id: event.game_id,
      level_id: event.level_id,
      model_id: event.model_id,
      provider: event.provider,
      latency_ms: event.latency_ms,
      value: event.value,
      payload: {
        event_id: event.event_id,
        ...event.payload
      },
      metrics: event.metrics
    };
  }

  publicEvent(event) {
    return {
      id: event.event_id,
      at: event.created_at,
      family: event.event_family,
      type: event.event_type,
      source: event.source,
      runId: event.run_id,
      gameId: event.game_id,
      levelId: event.level_id,
      modelId: event.model_id,
      provider: event.provider,
      latencyMs: event.latency_ms,
      value: event.value,
      payload: event.payload,
      metrics: event.metrics
    };
  }

  eventFromDatabaseRow(row = {}) {
    const payload = cleanObject(row.payload);
    return {
      event_id: row.event_id || payload.event_id || crypto.randomUUID(),
      created_at: row.created_at || new Date().toISOString(),
      event_family: EVENT_FAMILIES.has(row.event_family) ? row.event_family : 'system',
      event_type: cleanToken(row.event_type, 'event'),
      source: cleanToken(row.source, 'server'),
      session_id: cleanString(row.session_id),
      run_id: cleanString(row.run_id),
      game_id: cleanInteger(row.game_id),
      level_id: cleanInteger(row.level_id),
      model_id: cleanString(row.model_id),
      provider: cleanString(row.provider),
      latency_ms: parseNonNegativeNumber(row.latency_ms),
      value: parseNonNegativeNumber(row.value),
      payload,
      metrics: cleanObject(row.metrics)
    };
  }

  eventFromFallbackRow(row = {}) {
    return {
      event_id: row.event_id || row.id || crypto.randomUUID(),
      created_at: row.created_at || row.at || new Date().toISOString(),
      event_family: EVENT_FAMILIES.has(row.event_family) ? row.event_family : cleanToken(row.family, 'system'),
      event_type: cleanToken(row.event_type || row.type, 'event'),
      source: cleanToken(row.source, 'server'),
      session_id: cleanString(row.session_id || row.sessionId),
      run_id: cleanString(row.run_id || row.runId),
      game_id: cleanInteger(row.game_id ?? row.gameId),
      level_id: cleanInteger(row.level_id ?? row.levelId),
      model_id: cleanString(row.model_id || row.modelId),
      provider: cleanString(row.provider),
      latency_ms: parseNonNegativeNumber(row.latency_ms ?? row.latencyMs),
      value: parseNonNegativeNumber(row.value),
      payload: cleanObject(row.payload),
      metrics: cleanObject(row.metrics)
    };
  }

  readFallbackEvents(options = {}) {
    if (!fs.existsSync(this.fallbackPath)) return [];

    const maxBytes = parsePositiveInteger(options.maxBytes, this.fallbackReadBytes);
    const stat = fs.statSync(this.fallbackPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(this.fallbackPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf-8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }

      return text
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return this.eventFromFallbackRow(JSON.parse(line));
          } catch (error) {
            this.stats.failures += 1;
            this.stats.lastError = `Fallback read skipped malformed row: ${error.message}`;
            return null;
          }
        })
        .filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  }

  localEventsFromMemoryAndFallback(options = {}) {
    const limit = Math.max(parsePositiveInteger(options.limit, 80), this.maxEvents);
    const merged = new Map();
    for (const event of this.readFallbackEvents(options)) {
      merged.set(event.event_id, event);
    }
    for (const event of this.events) {
      merged.set(event.event_id, event);
    }

    return [...merged.values()]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit);
  }

  getLocalRecentEvents(limit = 80) {
    const capped = Math.max(1, Math.min(parsePositiveInteger(limit, 80), this.maxEvents));
    return this.localEventsFromMemoryAndFallback({ limit: capped })
      .slice(0, capped)
      .map(event => this.publicEvent(event));
  }

  async getRecentEvents(limit = 80, options = {}) {
    if (this.isSupabaseReady()) {
      try {
        const events = await this.readSupabaseEvents({
          limit,
          windowMs: options.windowMs || 24 * 60 * 60 * 1000
        });
        this.stats.lastReadError = null;
        if (!this.stats.lastWriteError) this.stats.lastError = null;
        return events.map(event => this.publicEvent(event));
      } catch (error) {
        this.recordReadError(error.message);
      }
    }
    return this.getLocalRecentEvents(limit);
  }

  async getDashboardSnapshot(options = {}) {
    const limit = parsePositiveInteger(options.limit, 80);
    const windowMs = parsePositiveInteger(options.windowMs, DEFAULT_DASHBOARD_WINDOW_MS);
    if (this.isSupabaseReady()) {
      try {
        const cloudEvents = await this.readSupabaseEvents({
          limit: Math.max(limit, this.maxEvents),
          windowMs
        });
        this.stats.lastReadError = null;
        if (!this.stats.lastWriteError) this.stats.lastError = null;
        return this.buildDashboardSnapshot(cloudEvents, {
          dataSource: 'supabase',
          limit,
          windowMs
        });
      } catch (error) {
        this.recordReadError(error.message);
      }
    }

    const localEvents = this.localEventsFromMemoryAndFallback({
      limit: Math.max(limit, this.maxEvents, DASHBOARD_SCAN_LIMIT),
      windowMs
    });

    return this.buildDashboardSnapshot(localEvents, {
      dataSource: localEvents.length > this.events.length ? 'fallback' : 'memory',
      limit,
      windowMs
    });
  }

  buildDashboardSnapshot(events, options = {}) {
    const limit = parsePositiveInteger(options.limit, 80);
    const now = Date.now();
    // Counters, leaderboards, and standings are lifetime aggregates over every
    // event the fetch layer loaded — time-windowing them here made the whole
    // dashboard read 0 after an idle stretch. Rate widgets (eventsPerMinute,
    // minuteSeries) slice their own short windows from this same set.
    const activeEvents = events.filter(event => Number.isFinite(Date.parse(event.created_at)));
    const recentEvents = activeEvents
      .slice()
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit)
      .map(event => this.publicEvent(event));

    const byFamily = this.countBy(activeEvents, 'event_family');
    const byType = this.countBy(activeEvents, 'event_type');
    const bySource = this.countBy(activeEvents, 'source');
    const modelEvents = activeEvents.filter(event => event.event_family === 'model_telemetry' && event.latency_ms !== null);
    const traceEvents = activeEvents.filter(event => event.event_family === 'trace');
    const evalEvents = activeEvents.filter(event => event.event_family === 'evaluation');
    const uxEvents = activeEvents.filter(event => event.event_family === 'user_experience');

    const gameSelections = activeEvents.filter(event => event.event_type === 'game_selected').length;
    const startClicks = activeEvents.filter(event => event.event_type === 'game_start_clicked').length;
    const startedRuns = activeEvents.filter(event => event.event_type === 'game_start_succeeded' || event.event_type === 'run_started').length;

    return {
      generatedAt: new Date().toISOString(),
      storage: this.getStorageStatus(),
      dataSource: options.dataSource || 'memory',
      liveClients: this.io?.engine?.clientsCount || 0,
      stats: {
        ...this.stats,
        buffered: this.buffer.length
      },
      metrics: {
        totalEvents: activeEvents.length,
        eventsPerMinute: this.eventsPerMinute(activeEvents, now),
        evaluations: evalEvents.length,
        userExperienceEvents: uxEvents.length,
        clickthroughRate: percent(startClicks, Math.max(gameSelections, 1)),
        runStartRate: percent(startedRuns, Math.max(startClicks, 1)),
        averageModelLatencyMs: Math.round(mean(modelEvents.map(event => event.latency_ms))),
        traceEvents: traceEvents.length
      },
      counts: {
        byFamily,
        byType,
        bySource
      },
      funnel: {
        gameSelections,
        startClicks,
        startedRuns,
        runSummaries: activeEvents.filter(event => event.event_type === 'run_summary').length
      },
      series: this.minuteSeries(activeEvents, now),
      models: this.modelSummary(modelEvents),
      evalOutcomes: this.evalOutcomes(evalEvents),
      marbleRun: this.marbleRun(evalEvents),
      traceTypes: this.traceTypes(traceEvents),
      leaderboards: this.leaderboards(activeEvents),
      pipeline: this.persistencePipeline(activeEvents, options.dataSource || 'memory'),
      recentEvents
    };
  }

  countBy(events, field) {
    return events.reduce((counts, event) => {
      const key = event[field] || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  }

  eventsPerMinute(events, now) {
    const recent = events.filter(event => now - Date.parse(event.created_at) <= 60 * 1000);
    return recent.length;
  }

  minuteSeries(events, now) {
    const buckets = [];
    for (let i = 9; i >= 0; i--) {
      const start = now - (i + 1) * 60 * 1000;
      const end = now - i * 60 * 1000;
      const bucketEvents = events.filter(event => {
        const at = Date.parse(event.created_at);
        return at >= start && at < end;
      });
      const modelEvents = bucketEvents.filter(event => event.event_family === 'model_telemetry' && event.latency_ms !== null);
      buckets.push({
        label: new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        total: bucketEvents.length,
        evaluation: bucketEvents.filter(event => event.event_family === 'evaluation').length,
        userExperience: bucketEvents.filter(event => event.event_family === 'user_experience').length,
        modelTelemetry: modelEvents.length,
        trace: bucketEvents.filter(event => event.event_family === 'trace').length,
        averageLatencyMs: Math.round(mean(modelEvents.map(event => event.latency_ms)))
      });
    }
    return buckets;
  }

  modelSummary(events) {
    const groups = new Map();
    for (const event of events) {
      const key = event.model_id || event.payload.modelUsed || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    return [...groups.entries()].map(([modelId, items]) => ({
      modelId,
      decisions: items.length,
      averageLatencyMs: Math.round(mean(items.map(event => event.latency_ms))),
      providers: [...new Set(items.map(event => event.provider).filter(Boolean))]
    })).sort((a, b) => b.decisions - a.decisions).slice(0, 8);
  }

  evalOutcomes(events) {
    const summaries = events.filter(event => event.event_type === 'run_summary');
    const wins = summaries.filter(event => event.payload.winner === 'PLAYER_WINS' || event.payload.won === true).length;
    const losses = summaries.filter(event => event.payload.winner === 'PLAYER_LOSES').length;
    return {
      wins,
      losses,
      other: Math.max(0, summaries.length - wins - losses),
      total: summaries.length
    };
  }

  // The Tote Board: live standings from the attract-mode marble run.
  marbleRun(evalEvents) {
    const cases = evalEvents.filter(event => event.event_type === 'marble_case_completed');
    return {
      totalCases: cases.length,
      standings: this.marbleStandings(cases),
      byStrategy: this.marbleByStrategy(cases)
    };
  }

  // Per-model standings: win rate, mean score, strong-adherence rate, fallback rate.
  marbleStandings(cases) {
    const byModel = new Map();
    for (const event of cases) {
      const p = event.payload || {};
      const key = event.model_id || p.modelUsed || 'unknown';
      if (!byModel.has(key)) {
        byModel.set(key, { modelId: key, runs: 0, wins: 0, scoreSum: 0, adherenceStrong: 0, fallbacks: 0 });
      }
      const g = byModel.get(key);
      g.runs += 1;
      if (p.won === true) g.wins += 1;
      if (typeof p.finalScore === 'number') g.scoreSum += p.finalScore;
      if (p.adherenceLabel && /strong/i.test(p.adherenceLabel)) g.adherenceStrong += 1;
      if (p.provider === 'openrouter') g.fallbacks += 1; // primary is ollama-cloud
    }
    return [...byModel.values()].map(g => ({
      modelId: g.modelId,
      runs: g.runs,
      winRate: g.runs ? Math.round((g.wins / g.runs) * 100) : 0,
      meanScore: g.runs ? Math.round((g.scoreSum / g.runs) * 10) / 10 : 0,
      strongAdherenceRate: g.runs ? Math.round((g.adherenceStrong / g.runs) * 100) : 0,
      fallbackRate: g.runs ? Math.round((g.fallbacks / g.runs) * 100) : 0
    })).sort((a, b) => b.winRate - a.winRate || b.meanScore - a.meanScore).slice(0, 8);
  }

  // Strategy-effect: how each preset strategy fares across the playlist.
  marbleByStrategy(cases) {
    const byStrat = new Map();
    for (const event of cases) {
      const p = event.payload || {};
      const key = p.strategyId || 'unknown';
      if (!byStrat.has(key)) {
        byStrat.set(key, { strategyId: key, label: p.strategyLabel || key, runs: 0, wins: 0, scoreSum: 0 });
      }
      const g = byStrat.get(key);
      g.runs += 1;
      if (p.won === true) g.wins += 1;
      if (typeof p.finalScore === 'number') g.scoreSum += p.finalScore;
    }
    return [...byStrat.values()].map(g => ({
      strategyId: g.strategyId,
      label: g.label,
      runs: g.runs,
      winRate: g.runs ? Math.round((g.wins / g.runs) * 100) : 0,
      meanScore: g.runs ? Math.round((g.scoreSum / g.runs) * 10) / 10 : 0
    })).sort((a, b) => b.meanScore - a.meanScore);
  }

  traceTypes(events) {
    return Object.entries(this.countBy(events, 'event_type'))
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }

  leaderboards(events) {
    return {
      runs: this.runLeaderboard(events),
      usage: this.usageLeaderboard(events),
      sessions: this.sessionLeaderboard(events)
    };
  }

  persistencePipeline(events, dataSource = 'memory') {
    const fallbackVisible = dataSource === 'fallback' ? events.length : 0;
    return {
      source: dataSource,
      storageState: this.getStorageStatus().state,
      lastFlushAt: this.stats.lastFlushAt,
      lastError: this.stats.lastError,
      steps: [
        {
          key: 'captured',
          label: 'Captured',
          value: events.length,
          detail: 'recent event rows'
        },
        {
          key: 'buffered',
          label: 'Buffer',
          value: this.buffer.length,
          detail: 'waiting to flush'
        },
        {
          key: 'supabase',
          label: 'Supabase',
          value: this.stats.persisted,
          detail: this.isSupabaseReady() ? 'written this process' : 'awaiting credentials'
        },
        {
          key: 'fallback',
          label: 'Fallback',
          value: this.stats.fallback + fallbackVisible,
          detail: fallbackVisible > 0 ? 'read from JSONL' : 'written this process'
        },
        {
          key: 'failures',
          label: 'Failures',
          value: this.stats.failures,
          detail: this.stats.lastError || 'none'
        }
      ]
    };
  }

  runLeaderboard(events) {
    const completionTypes = new Set(['run_summary', 'eval_case_completed']);
    const records = events
      .filter(event => event.event_family === 'evaluation' && completionTypes.has(event.event_type))
      .map(event => this.runRecord(event));

    const groups = new Map();
    for (const record of records) {
      const key = record.modelId;
      if (!groups.has(key)) {
        groups.set(key, {
          modelId: key,
          runs: 0,
          wins: 0,
          losses: 0,
          other: 0,
          scores: [],
          ticks: [],
          decisions: [],
          providers: new Set(),
          gameIds: new Set(),
          latestAt: null,
          latestRunId: null
        });
      }

      const group = groups.get(key);
      group.runs += 1;
      group.wins += record.outcome === 'win' ? 1 : 0;
      group.losses += record.outcome === 'loss' ? 1 : 0;
      group.other += record.outcome === 'other' ? 1 : 0;
      group.scores.push(record.score);
      group.ticks.push(record.ticks);
      group.decisions.push(record.decisions);
      if (record.provider) group.providers.add(record.provider);
      if (record.gameId !== null) group.gameIds.add(record.gameId);
      if (!group.latestAt || Date.parse(record.at) > Date.parse(group.latestAt)) {
        group.latestAt = record.at;
        group.latestRunId = record.runId;
      }
    }

    return [...groups.values()].map(group => ({
      modelId: group.modelId,
      runs: group.runs,
      wins: group.wins,
      losses: group.losses,
      other: group.other,
      winRate: percent(group.wins, group.runs),
      bestScore: Math.max(...group.scores),
      averageScore: Math.round(mean(group.scores)),
      averageTicks: Math.round(mean(group.ticks)),
      averageDecisions: Math.round(mean(group.decisions)),
      providers: [...group.providers],
      gameIds: [...group.gameIds].sort((a, b) => a - b).slice(0, 6),
      latestAt: group.latestAt,
      latestRunId: group.latestRunId
    })).sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
      if (b.averageScore !== a.averageScore) return b.averageScore - a.averageScore;
      return b.runs - a.runs;
    }).slice(0, 8);
  }

  runRecord(event) {
    const winner = event.payload.winner;
    const won = event.payload.won === true || winner === 'PLAYER_WINS';
    const lost = event.payload.won === false || winner === 'PLAYER_LOSES';
    return {
      at: event.created_at,
      runId: event.run_id,
      gameId: event.game_id,
      levelId: event.level_id,
      modelId: event.model_id || event.payload.modelUsed || 'unknown',
      provider: event.provider || event.payload.provider || null,
      outcome: won ? 'win' : lost ? 'loss' : 'other',
      score: firstFiniteNumber([
        event.metrics.final_score,
        event.metrics.score,
        event.payload.finalScore,
        event.payload.score
      ], 0),
      ticks: firstFiniteNumber([event.metrics.ticks, event.payload.ticks], 0),
      decisions: firstFiniteNumber([event.metrics.decisions, event.payload.decisions], 0)
    };
  }

  usageLeaderboard(events) {
    const decisions = events.filter(event => event.event_family === 'model_telemetry' && event.event_type === 'llm_decision');
    const groups = new Map();
    for (const event of decisions) {
      const modelId = event.model_id || event.payload.modelUsed || 'unknown';
      if (!groups.has(modelId)) {
        groups.set(modelId, {
          modelId,
          decisions: 0,
          latencies: [],
          promptChars: 0,
          responseChars: 0,
          providers: new Set(),
          latestAt: null
        });
      }

      const group = groups.get(modelId);
      group.decisions += 1;
      if (event.latency_ms !== null) group.latencies.push(event.latency_ms);
      group.promptChars += firstFiniteNumber([
        event.metrics.prompt_chars,
        event.metrics.promptChars
      ], 0) + firstFiniteNumber([
        event.metrics.system_prompt_chars,
        event.metrics.systemPromptChars
      ], 0);
      group.responseChars += firstFiniteNumber([
        event.metrics.response_chars,
        event.metrics.responseChars
      ], 0);
      if (event.provider) group.providers.add(event.provider);
      if (!group.latestAt || Date.parse(event.created_at) > Date.parse(group.latestAt)) {
        group.latestAt = event.created_at;
      }
    }

    return [...groups.values()].map(group => ({
      modelId: group.modelId,
      decisions: group.decisions,
      averageLatencyMs: Math.round(mean(group.latencies)),
      p95LatencyMs: Math.round(percentile(group.latencies, 95)),
      promptChars: group.promptChars,
      responseChars: group.responseChars,
      totalChars: group.promptChars + group.responseChars,
      providers: [...group.providers],
      latestAt: group.latestAt
    })).sort((a, b) => {
      if (b.decisions !== a.decisions) return b.decisions - a.decisions;
      return a.averageLatencyMs - b.averageLatencyMs;
    }).slice(0, 8);
  }

  sessionLeaderboard(events) {
    const groups = new Map();
    for (const event of events) {
      const key = event.session_id || (event.run_id ? `run:${event.run_id}` : null);
      if (!key) continue;

      if (!groups.has(key)) {
        groups.set(key, {
          sessionId: key,
          events: 0,
          clicks: 0,
          gameSelections: 0,
          startClicks: 0,
          runSummaries: 0,
          decisions: 0,
          gameIds: new Set(),
          modelIds: new Set(),
          runIds: new Set(),
          sources: new Set(),
          latestAt: null
        });
      }

      const group = groups.get(key);
      group.events += 1;
      group.clicks += event.event_family === 'clickthrough' ? 1 : 0;
      group.gameSelections += event.event_type === 'game_selected' ? 1 : 0;
      group.startClicks += event.event_type === 'game_start_clicked' ? 1 : 0;
      group.runSummaries += event.event_type === 'run_summary' ? 1 : 0;
      group.decisions += event.event_type === 'llm_decision' ? 1 : 0;
      if (event.game_id !== null) group.gameIds.add(event.game_id);
      if (event.model_id) group.modelIds.add(event.model_id);
      if (event.run_id) group.runIds.add(event.run_id);
      if (event.source) group.sources.add(event.source);
      if (!group.latestAt || Date.parse(event.created_at) > Date.parse(group.latestAt)) {
        group.latestAt = event.created_at;
      }
    }

    return [...groups.values()].map(group => ({
      sessionId: group.sessionId,
      events: group.events,
      clicks: group.clicks,
      gameSelections: group.gameSelections,
      startClicks: group.startClicks,
      runSummaries: group.runSummaries,
      decisions: group.decisions,
      gameIds: [...group.gameIds].sort((a, b) => a - b).slice(0, 6),
      modelIds: [...group.modelIds].slice(0, 4),
      runIds: [...group.runIds].slice(0, 4),
      sources: [...group.sources],
      latestAt: group.latestAt
    })).sort((a, b) => {
      const activityDelta = (b.startClicks + b.runSummaries + b.decisions) - (a.startClicks + a.runSummaries + a.decisions);
      if (activityDelta !== 0) return activityDelta;
      if (b.events !== a.events) return b.events - a.events;
      return Date.parse(b.latestAt || 0) - Date.parse(a.latestAt || 0);
    }).slice(0, 8);
  }
}

const telemetryStore = new TelemetryStore();
module.exports = telemetryStore;
module.exports.TelemetryStore = TelemetryStore;
