#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { loadRootEnv } = require('./load-root-env');
const { TelemetryStore } = require('../lib/telemetry-store');

const DEFAULT_BATCH_SIZE = 100;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    json: false,
    path: process.env.TELEMETRY_FALLBACK_PATH || path.resolve(__dirname, '..', 'data', 'telemetry-events.jsonl'),
    batchSize: DEFAULT_BATCH_SIZE
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--path') {
      options.path = path.resolve(next);
      i++;
    } else if (arg === '--batch-size') {
      const parsed = Number.parseInt(next, 10);
      if (Number.isInteger(parsed) && parsed > 0) options.batchSize = parsed;
      i++;
    }
  }

  return options;
}

function readJsonlEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];

  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        error.message = `Invalid JSONL at line ${index + 1}: ${error.message}`;
        throw error;
      }
    });
}

function uniqueByEventId(events) {
  const seen = new Set();
  const unique = [];
  for (const event of events) {
    const eventId = event.event_id || event.payload?.event_id;
    if (eventId && seen.has(eventId)) continue;
    if (eventId) seen.add(eventId);
    unique.push(event);
  }
  return unique;
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function backfill(options = {}) {
  const filePath = path.resolve(options.path || path.resolve(__dirname, '..', 'data', 'telemetry-events.jsonl'));
  const batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  const store = options.store || new TelemetryStore();
  if (!options.store) {
    store.configure({
      flushMs: 0,
      fallbackPath: filePath
    });
  }

  if (!store.isSupabaseReady()) {
    const error = new Error('Missing Supabase credentials. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the root .env.');
    error.code = 'MISSING_SUPABASE_CONFIG';
    throw error;
  }

  const allEvents = readJsonlEvents(filePath);
  const events = uniqueByEventId(allEvents).map(event => store.eventFromDatabaseRow(event));

  const result = {
    ok: true,
    dryRun: Boolean(options.dryRun),
    path: filePath,
    read: allEvents.length,
    unique: events.length,
    uploaded: 0,
    skippedDuplicates: Math.max(0, allEvents.length - events.length),
    batches: 0
  };

  if (options.dryRun || events.length === 0) return result;

  const batches = chunk(events, batchSize);
  for (const batch of batches) {
    await store.writeSupabase(batch, { ignoreDuplicates: true });
    result.uploaded += batch.length;
    result.batches += 1;
  }

  return result;
}

async function main() {
  const envLoad = await loadRootEnv();
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await backfill(options);
    result.envLoaded = envLoad.loaded;
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (envLoad.timedOut) {
      console.warn(`[Telemetry] skipped root .env after ${envLoad.timeoutMs}ms; using process environment`);
    }
    console.log(`[Telemetry] read ${result.read} fallback events from ${result.path}`);
    console.log(`[Telemetry] unique events: ${result.unique}`);
    console.log(`[Telemetry] uploaded: ${result.dryRun ? 0 : result.uploaded}${result.dryRun ? ' (dry run)' : ''}`);
    console.log(`[Telemetry] skipped local duplicates: ${result.skippedDuplicates}`);
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        code: error.code || 'TELEMETRY_BACKFILL_FAILED',
        message: error.message
      }, null, 2));
    } else {
      console.error(`[Telemetry] ${error.message}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  backfill,
  chunk,
  parseArgs,
  readJsonlEvents,
  uniqueByEventId
};
