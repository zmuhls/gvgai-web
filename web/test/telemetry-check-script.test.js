const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildCheckRow,
  getConfig,
  missingConfig,
  parseArgs,
  READ_MODEL_VIEWS,
  loadRootEnv,
  runCheck
} = require('../scripts/check-supabase-telemetry');

test('telemetry check script parses output and rollup flags', () => {
  assert.deepEqual(parseArgs(['--json', '--skip-rollup', '--skip-read-models']), {
    json: true,
    skipRollup: true,
    skipReadModels: true
  });
});

test('telemetry check script reports missing required credentials', () => {
  const config = getConfig({
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: ''
  });

  assert.deepEqual(missingConfig(config), ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
});

test('telemetry env loader reads a provided env file without mutating existing keys', async () => {
  const filePath = path.join(os.tmpdir(), `gvgai-env-${Date.now()}.env`);
  fs.writeFileSync(filePath, 'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=from-file\n', 'utf-8');
  const env = {
    SUPABASE_SERVICE_ROLE_KEY: 'already-set'
  };

  const result = await loadRootEnv({ path: filePath, env });

  assert.equal(result.loaded, true);
  assert.equal(env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, 'already-set');

  fs.rmSync(filePath, { force: true });
});

test('telemetry env loader honors GVGAI_ENV_FILE when no path is passed', async () => {
  const filePath = path.join(os.tmpdir(), `gvgai-env-var-${Date.now()}.env`);
  fs.writeFileSync(filePath, 'SUPABASE_URL=https://env-var.supabase.co\n', 'utf-8');
  const env = { GVGAI_ENV_FILE: filePath };

  const result = await loadRootEnv({ env });

  assert.equal(result.loaded, true);
  assert.equal(result.path, filePath);
  assert.equal(env.SUPABASE_URL, 'https://env-var.supabase.co');

  fs.rmSync(filePath, { force: true });
});

test('telemetry check row matches migration constraints', () => {
  const row = buildCheckRow(new Date('2026-06-19T12:00:00.000Z'));

  assert.equal(row.event_family, 'system');
  assert.equal(row.event_type, 'cloud_readiness_check');
  assert.equal(row.source, 'telemetry-check');
  assert.equal(row.payload.event_id, row.event_id);
  assert.equal(row.metrics.schema_version, 1);
  assert.match(row.run_id, /^cloud-check-20260619120000000$/);
});

test('telemetry check verifies Supabase read model views', async () => {
  const originalFetch = global.fetch;
  const urls = [];

  global.fetch = async (url, options) => {
    urls.push(url);
    if (options.method === 'POST') {
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify([{ id: 1, created_at: '2026-06-19T12:00:00.000Z' }]);
        }
      };
    }

    return {
      ok: true,
      status: 200,
      async text() {
        return '[]';
      }
    };
  };

  try {
    const result = await runCheck({
      now: new Date('2026-06-19T12:00:00.000Z'),
      env: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.rollupReadable, true);
    for (const viewName of READ_MODEL_VIEWS) {
      assert.equal(result.readModels[viewName].readable, true);
      assert.ok(urls.some(url => url.includes(`/rest/v1/${viewName}?`)), `missing ${viewName} request`);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
