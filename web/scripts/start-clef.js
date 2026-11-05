#!/usr/bin/env node
const { loadRootEnv } = require('./load-root-env');

async function main() {
  await loadRootEnv();
  if (!/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID || '') ||
      !(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN)) {
    throw new Error('Set server-only CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before starting CLEF.');
  }
  // An explicit interactive profile; operator-supplied limits always win.
  const defaults = {
    MODEL_RUN_MAX_ACTIONS: '300', MODEL_RUN_MAX_PROVIDER_CALLS: '300', MODEL_RUN_MAX_MS: '600000',
    MODEL_GUARDRAIL_SESSION: '300', MODEL_GUARDRAIL_HOURLY: '1000',
    MODEL_GUARDRAIL_DAILY: '2000', MODEL_GUARDRAIL_MONTHLY: '10000',
    MARBLE_RUN_ENABLED: 'false', MARBLE_RUN_AUTOSTART: 'false',
    CADAVRE_MODEL_WARMER_ENABLED: 'false', CADAVRE_READY_GENERATION_ENABLED: 'false',
    MODEL_EVALS_ENABLED: 'false', MODEL_FINETUNE_ENABLED: 'false'
  };
  for (const [name, value] of Object.entries(defaults)) process.env[name] ??= value;
  return require('../server').startServer();
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
