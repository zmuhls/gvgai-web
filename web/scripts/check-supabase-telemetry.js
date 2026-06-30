#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const { loadRootEnv } = require('./load-root-env');

const READ_MODEL_VIEWS = [
  'telemetry_completed_runs',
  'telemetry_run_leaderboard',
  'telemetry_model_usage',
  'telemetry_session_activity'
];

function trimTrailingSlash(value) {
  return value ? String(value).replace(/\/+$/, '') : '';
}

function parseArgs(argv) {
  return argv.reduce((options, arg) => {
    if (arg === '--json') options.json = true;
    if (arg === '--skip-rollup') options.skipRollup = true;
    if (arg === '--skip-read-models') options.skipReadModels = true;
    return options;
  }, {});
}

function getConfig(env = process.env) {
  return {
    supabaseUrl: trimTrailingSlash(env.SUPABASE_URL || ''),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '',
    tableName: env.SUPABASE_TELEMETRY_TABLE || 'telemetry_events'
  };
}

function missingConfig(config) {
  return [
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.serviceRoleKey]
  ].filter(([, value]) => !value).map(([name]) => name);
}

function buildCheckRow(now = new Date()) {
  const eventId = crypto.randomUUID();
  return {
    event_id: eventId,
    created_at: now.toISOString(),
    event_family: 'system',
    event_type: 'cloud_readiness_check',
    source: 'telemetry-check',
    run_id: `cloud-check-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}`,
    payload: {
      event_id: eventId,
      check: 'supabase_telemetry',
      script: 'scripts/check-supabase-telemetry.js'
    },
    metrics: {
      schema_version: 1
    }
  };
}

function supabaseHeaders(config, prefer = null) {
  const headers = {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json'
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

function explainFailure(status, body) {
  if (status === 401 || status === 403) {
    return 'Supabase rejected the service role key. Check SUPABASE_SERVICE_ROLE_KEY.';
  }
  if (status === 404) {
    return 'Supabase could not find the telemetry table. Apply web/supabase/migrations/202606190001_telemetry.sql.';
  }
  if (status === 400) {
    return 'Supabase rejected the row. Check that the telemetry migration is current, including event_id.';
  }
  return `Supabase request failed with HTTP ${status}: ${body.slice(0, 300)}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

async function runCheck(options = {}) {
  const config = getConfig(options.env || process.env);
  const missing = missingConfig(config);
  if (missing.length > 0) {
    const error = new Error(`Missing required Supabase env vars: ${missing.join(', ')}`);
    error.code = 'MISSING_SUPABASE_CONFIG';
    error.missing = missing;
    throw error;
  }

  const tableUrl = `${config.supabaseUrl}/rest/v1/${encodeURIComponent(config.tableName)}`;
  const checkRow = buildCheckRow(options.now || new Date());
  const insert = await requestJson(tableUrl, {
    method: 'POST',
    headers: supabaseHeaders(config, 'return=representation'),
    body: JSON.stringify(checkRow)
  });

  if (!insert.response.ok) {
    const error = new Error(explainFailure(insert.response.status, insert.text || ''));
    error.code = 'SUPABASE_INSERT_FAILED';
    error.status = insert.response.status;
    error.body = insert.body;
    throw error;
  }

  const inserted = Array.isArray(insert.body) ? insert.body[0] : insert.body;
  const result = {
    ok: true,
    table: config.tableName,
    eventId: checkRow.event_id,
    insertedId: inserted?.id || null,
    insertedAt: inserted?.created_at || checkRow.created_at,
    rollupReadable: null,
    readModels: null
  };

  if (!options.skipRollup) {
    const rollupUrl = `${config.supabaseUrl}/rest/v1/telemetry_minute_rollups?select=minute,event_family,event_type,event_count&limit=1`;
    const rollup = await requestJson(rollupUrl, {
      method: 'GET',
      headers: supabaseHeaders(config)
    });
    result.rollupReadable = rollup.response.ok;
    if (!rollup.response.ok) {
      result.rollupStatus = rollup.response.status;
      result.rollupError = rollup.text.slice(0, 300);
    }
  }

  if (!options.skipReadModels) {
    result.readModels = {};
    const failedViews = [];
    for (const viewName of READ_MODEL_VIEWS) {
      const viewUrl = `${config.supabaseUrl}/rest/v1/${viewName}?select=*&limit=1`;
      const view = await requestJson(viewUrl, {
        method: 'GET',
        headers: supabaseHeaders(config)
      });
      result.readModels[viewName] = {
        readable: view.response.ok,
        status: view.response.status
      };
      if (!view.response.ok) {
        result.readModels[viewName].error = view.text.slice(0, 300);
        failedViews.push(viewName);
      }
    }

    if (failedViews.length > 0) {
      const error = new Error(`Supabase read model check failed for: ${failedViews.join(', ')}. Apply web/supabase/migrations/202606190002_telemetry_read_models.sql.`);
      error.code = 'SUPABASE_READ_MODEL_CHECK_FAILED';
      error.status = 400;
      error.readModels = result.readModels;
      throw error;
    }
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const envLoad = await loadRootEnv();
    const result = await runCheck(options);
    result.envLoaded = envLoad.loaded;
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (envLoad.timedOut) {
      console.warn(`[Telemetry] skipped root .env after ${envLoad.timeoutMs}ms; using process environment`);
    }
    console.log('[Telemetry] Supabase write check passed');
    console.log(`[Telemetry] table: ${result.table}`);
    console.log(`[Telemetry] event_id: ${result.eventId}`);
    console.log(`[Telemetry] rollup view: ${result.rollupReadable === null ? 'skipped' : result.rollupReadable ? 'readable' : 'failed'}`);
    console.log(`[Telemetry] read models: ${result.readModels === null ? 'skipped' : 'readable'}`);
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({
        ok: false,
        code: error.code || 'SUPABASE_CHECK_FAILED',
        message: error.message,
        status: error.status || null,
        missing: error.missing || [],
        readModels: error.readModels || null
      }, null, 2));
    } else {
      console.error(`[Telemetry] ${error.message}`);
      if (error.code === 'MISSING_SUPABASE_CONFIG') {
        console.error('[Telemetry] Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the repository root .env.');
      }
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCheckRow,
  getConfig,
  missingConfig,
  parseArgs,
  READ_MODEL_VIEWS,
  loadRootEnv,
  runCheck
};
