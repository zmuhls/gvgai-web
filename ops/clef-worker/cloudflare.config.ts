import { bindings, defineConfig } from 'cf/config';

// Dedicated standard account, separate from the CUNY AI Lab enterprise account.
const accountId = '051d576ac3f7bb29f538a3ea559b77a6';
if (process.env.CLOUDFLARE_ACCOUNT_ID !== accountId) {
  throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the dedicated personal account before building or deploying');
}

export default defineConfig({
  accountId,
  worker: {
    name: 'inference-arcade-clef',
    entrypoint: './src/index.js',
    compatibilityDate: '2026-11-04',
    compatibilityFlags: ['nodejs_compat'],
    workersDev: true,
    previewUrls: false,
    env: { AI: bindings.ai(), RELAY_SECRET: bindings.secret() },
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.01 }
    }
  }
});
