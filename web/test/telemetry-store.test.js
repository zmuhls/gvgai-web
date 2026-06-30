const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { TelemetryStore } = require('../lib/telemetry-store');

test('telemetry store normalizes events and computes dashboard rollups', async () => {
  const store = new TelemetryStore();
  store.configure({
    enabled: true,
    flushMs: 0,
    batchSize: 10,
    fallbackPath: path.join(os.tmpdir(), `gvgai-telemetry-${Date.now()}.jsonl`)
  });

  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_selected',
    source: 'browser',
    gameId: 0,
    payload: { gameName: 'aliens' }
  });
  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_start_clicked',
    source: 'browser',
    gameId: 0,
    modelId: 'gpt-oss:120b'
  });
  store.track({
    eventFamily: 'model_telemetry',
    eventType: 'llm_decision',
    source: 'llm-client',
    modelId: 'gpt-oss:120b',
    provider: 'ollama-local',
    latencyMs: 120,
    payload: { action: 'ACTION_UP' }
  });
  store.track({
    eventFamily: 'trace',
    eventType: 'game_state_tick',
    source: 'llm-client',
    metrics: { tick: 10, score: 1 }
  });

  const snapshot = await store.getDashboardSnapshot();

  assert.equal(snapshot.metrics.totalEvents, 4);
  assert.equal(snapshot.metrics.clickthroughRate, 1);
  assert.equal(snapshot.metrics.averageModelLatencyMs, 120);
  assert.equal(snapshot.metrics.traceEvents, 1);
  assert.equal(snapshot.counts.byFamily.clickthrough, 2);
  assert.equal(snapshot.models[0].modelId, 'gpt-oss:120b');
  assert.equal(snapshot.dataSource, 'memory');
});

test('telemetry store writes JSONL fallback when Supabase credentials are absent', async () => {
  const fallbackPath = path.join(os.tmpdir(), `gvgai-telemetry-fallback-${Date.now()}.jsonl`);
  const store = new TelemetryStore();
  store.configure({
    enabled: true,
    flushMs: 0,
    batchSize: 10,
    fallbackPath
  });

  store.track({
    eventFamily: 'evaluation',
    eventType: 'batch_planned',
    source: 'test',
    metrics: { case_count: 2 }
  });

  await store.flush();

  const rows = fs.readFileSync(fallbackPath, 'utf-8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_family, 'evaluation');
  assert.equal(rows[0].event_type, 'batch_planned');
  assert.equal(store.getStorageStatus().state, 'fallback');
  const snapshot = await store.getDashboardSnapshot({ limit: 10 });
  const fallbackStep = snapshot.pipeline.steps.find(step => step.key === 'fallback');
  assert.equal(fallbackStep.value, 1);

  fs.rmSync(fallbackPath, { force: true });
});

test('telemetry dashboard hydrates local fallback records after restart', async () => {
  const fallbackPath = path.join(os.tmpdir(), `gvgai-telemetry-restart-${Date.now()}.jsonl`);
  const writer = new TelemetryStore();
  writer.configure({
    enabled: true,
    flushMs: 0,
    batchSize: 10,
    fallbackPath
  });

  writer.track({
    eventFamily: 'model_telemetry',
    eventType: 'llm_decision',
    source: 'llm-client',
    runId: 'restart-run',
    gameId: 0,
    modelId: 'model-restart',
    provider: 'ollama-local',
    latencyMs: 90,
    metrics: { prompt_chars: 40, response_chars: 12 }
  });
  writer.track({
    eventFamily: 'evaluation',
    eventType: 'run_summary',
    source: 'llm-client',
    runId: 'restart-run',
    gameId: 0,
    modelId: 'model-restart',
    provider: 'ollama-local',
    payload: { winner: 'PLAYER_WINS', won: true },
    metrics: { final_score: 7, ticks: 40, decisions: 1 }
  });
  await writer.flush();

  const reader = new TelemetryStore();
  reader.configure({
    enabled: true,
    flushMs: 0,
    fallbackPath
  });

  const snapshot = await reader.getDashboardSnapshot({ limit: 20, windowMs: 24 * 60 * 60 * 1000 });
  const recent = await reader.getRecentEvents(20, { windowMs: 24 * 60 * 60 * 1000 });

  assert.equal(snapshot.dataSource, 'fallback');
  assert.equal(snapshot.metrics.totalEvents, 2);
  assert.equal(snapshot.leaderboards.runs[0].modelId, 'model-restart');
  assert.equal(snapshot.leaderboards.usage[0].averageLatencyMs, 90);
  assert.equal(snapshot.pipeline.source, 'fallback');
  assert.equal(snapshot.pipeline.steps.find(step => step.key === 'fallback').value, 2);
  assert.equal(recent.length, 2);

  fs.rmSync(fallbackPath, { force: true });
});

test('telemetry dashboard clamps clickthrough rate to a valid ratio', async () => {
  const store = new TelemetryStore();
  store.configure({
    enabled: true,
    flushMs: 0,
    batchSize: 10,
    fallbackPath: path.join(os.tmpdir(), `gvgai-telemetry-rate-${Date.now()}.jsonl`)
  });

  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_selected',
    source: 'browser',
    gameId: 0
  });
  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_start_clicked',
    source: 'browser',
    gameId: 0
  });
  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_start_clicked',
    source: 'browser',
    gameId: 0
  });

  const snapshot = await store.getDashboardSnapshot();

  assert.equal(snapshot.metrics.clickthroughRate, 1);
});

test('telemetry dashboard ranks runs, usage, and active sessions', async () => {
  const store = new TelemetryStore();
  store.configure({
    enabled: true,
    flushMs: 0,
    batchSize: 10,
    fallbackPath: path.join(os.tmpdir(), `gvgai-telemetry-ranks-${Date.now()}.jsonl`)
  });

  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_selected',
    source: 'browser',
    sessionId: 'browser-a',
    gameId: 0,
    payload: { gameName: 'aliens' }
  });
  store.track({
    eventFamily: 'clickthrough',
    eventType: 'game_start_clicked',
    source: 'browser',
    sessionId: 'browser-a',
    gameId: 0,
    modelId: 'model-a'
  });
  store.track({
    eventFamily: 'model_telemetry',
    eventType: 'llm_decision',
    source: 'llm-client',
    runId: 'run-a',
    gameId: 0,
    modelId: 'model-a',
    provider: 'ollama-local',
    latencyMs: 120,
    metrics: { prompt_chars: 100, system_prompt_chars: 20, response_chars: 30 }
  });
  store.track({
    eventFamily: 'evaluation',
    eventType: 'run_summary',
    source: 'llm-client',
    runId: 'run-a',
    gameId: 0,
    modelId: 'model-a',
    provider: 'ollama-local',
    payload: { winner: 'PLAYER_WINS', won: true },
    metrics: { final_score: 15, ticks: 80, decisions: 1 }
  });
  store.track({
    eventFamily: 'evaluation',
    eventType: 'eval_case_completed',
    source: 'batch-evaluator',
    runId: 'run-b',
    gameId: 1,
    modelId: 'model-b',
    payload: { winner: 'PLAYER_LOSES' },
    metrics: { final_score: 5, ticks: 120, decisions: 2 }
  });

  const snapshot = await store.getDashboardSnapshot({ limit: 20 });

  assert.equal(snapshot.leaderboards.runs[0].modelId, 'model-a');
  assert.equal(snapshot.leaderboards.runs[0].wins, 1);
  assert.equal(snapshot.leaderboards.runs[0].bestScore, 15);
  assert.equal(snapshot.leaderboards.usage[0].modelId, 'model-a');
  assert.equal(snapshot.leaderboards.usage[0].decisions, 1);
  assert.equal(snapshot.leaderboards.usage[0].totalChars, 150);
  assert.equal(snapshot.leaderboards.sessions[0].sessionId, 'run:run-a');
  assert.equal(snapshot.leaderboards.sessions[0].decisions, 1);
  assert.equal(snapshot.leaderboards.sessions[1].sessionId, 'browser-a');
  assert.equal(snapshot.leaderboards.sessions[1].startClicks, 1);
});

test('telemetry database row includes typed event id and JSON details', () => {
  const store = new TelemetryStore();
  const event = store.normalizeEvent({
    eventFamily: 'system',
    eventType: 'cloud_check',
    source: 'test',
    payload: { ok: true }
  });
  const row = store.databaseRow(event);

  assert.equal(row.event_id, event.event_id);
  assert.equal(row.payload.event_id, event.event_id);
  assert.equal(row.event_family, 'system');
  assert.deepEqual(row.payload.ok, true);
});

test('telemetry dashboard can hydrate from Supabase rows', async () => {
  const originalFetch = global.fetch;
  const store = new TelemetryStore();
  store.configure({
    enabled: true,
    flushMs: 0,
    supabaseUrl: 'https://example.supabase.co',
    supabaseServiceRoleKey: 'service-role-key'
  });
  const now = new Date().toISOString();
  let requestedUrl = null;
  let requestedHeaders = null;

  global.fetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options.headers;
    return {
      ok: true,
      async json() {
        return [
          {
            event_id: '11111111-1111-4111-8111-111111111111',
            created_at: now,
            event_family: 'model_telemetry',
            event_type: 'llm_decision',
            source: 'llm-client',
            model_id: 'gpt-oss:120b',
            provider: 'ollama-cloud',
            latency_ms: 250,
            payload: { action: 'ACTION_UP' },
            metrics: { response_chars: 22 }
          },
          {
            event_id: '22222222-2222-4222-8222-222222222222',
            created_at: now,
            event_family: 'evaluation',
            event_type: 'run_summary',
            source: 'llm-client',
            payload: { winner: 'PLAYER_WINS', won: true },
            metrics: { final_score: 10 }
          }
        ];
      }
    };
  };

  try {
    const snapshot = await store.getDashboardSnapshot({ limit: 10 });

    assert.equal(snapshot.dataSource, 'supabase');
    assert.equal(snapshot.metrics.totalEvents, 2);
    assert.equal(snapshot.metrics.averageModelLatencyMs, 250);
    assert.equal(snapshot.evalOutcomes.wins, 1);
    assert.equal(snapshot.recentEvents.length, 2);
    assert.match(requestedUrl, /^https:\/\/example\.supabase\.co\/rest\/v1\/telemetry_events\?/);
    assert.equal(requestedHeaders.Authorization, 'Bearer service-role-key');
  } finally {
    global.fetch = originalFetch;
  }
});
