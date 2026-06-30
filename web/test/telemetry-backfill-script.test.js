const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  backfill,
  chunk,
  parseArgs,
  readJsonlEvents,
  uniqueByEventId
} = require('../scripts/backfill-telemetry');
const { TelemetryStore } = require('../lib/telemetry-store');

function tempJsonlPath() {
  return path.join(os.tmpdir(), `gvgai-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('telemetry backfill script parses path, dry-run, json, and batch options', () => {
  const options = parseArgs(['--dry-run', '--json', '--path', '/tmp/events.jsonl', '--batch-size', '50']);

  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
  assert.equal(options.path, '/tmp/events.jsonl');
  assert.equal(options.batchSize, 50);
});

test('telemetry backfill reads JSONL and removes duplicate event ids', () => {
  const filePath = tempJsonlPath();
  const event = {
    event_id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-06-19T12:00:00.000Z',
    event_family: 'system',
    event_type: 'server_started',
    source: 'server',
    payload: { event_id: '11111111-1111-4111-8111-111111111111' },
    metrics: {}
  };
  fs.writeFileSync(filePath, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, 'utf-8');

  const events = readJsonlEvents(filePath);
  const unique = uniqueByEventId(events);

  assert.equal(events.length, 2);
  assert.equal(unique.length, 1);
  fs.rmSync(filePath, { force: true });
});

test('telemetry backfill dry-run reports read and duplicate counts', async () => {
  const filePath = tempJsonlPath();
  const event = {
    event_id: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-06-19T12:00:00.000Z',
    event_family: 'evaluation',
    event_type: 'batch_planned',
    source: 'batch-evaluator',
    payload: {},
    metrics: {}
  };
  fs.writeFileSync(filePath, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, 'utf-8');
  const store = new TelemetryStore();
  store.configure({
    flushMs: 0,
    fallbackPath: filePath,
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key'
  });

  const result = await backfill({
    dryRun: true,
    path: filePath,
    store
  });

  assert.equal(result.read, 2);
  assert.equal(result.unique, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(result.skippedDuplicates, 1);
  fs.rmSync(filePath, { force: true });
});

test('telemetry store duplicate-ignore write uses event_id conflict handling', async () => {
  const originalFetch = global.fetch;
  const store = new TelemetryStore();
  store.configure({
    flushMs: 0,
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key'
  });
  let requestedUrl = null;
  let requestedPrefer = null;

  global.fetch = async (url, options) => {
    requestedUrl = url;
    requestedPrefer = options.headers.Prefer;
    return {
      ok: true,
      async text() {
        return '';
      }
    };
  };

  try {
    const event = store.normalizeEvent({
      eventFamily: 'system',
      eventType: 'server_started',
      source: 'test'
    });
    await store.writeSupabase([event], { ignoreDuplicates: true });

    assert.match(requestedUrl, /on_conflict=event_id/);
    assert.equal(requestedPrefer, 'resolution=ignore-duplicates,return=minimal');
  } finally {
    global.fetch = originalFetch;
  }
});

test('telemetry backfill chunks batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
