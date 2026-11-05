// Relay credentials never fall back to an account-wide Cloudflare token.
function clefConnection(modelId, env = process.env, options = {}) {
  const relayUrl = options.relayUrl ?? env.CLEF_RELAY_URL;
  const relaySecret = options.relaySecret ?? env.CLEF_RELAY_SECRET;
  if (relayUrl || relaySecret) {
    let url;
    try { url = new URL(relayUrl); } catch { throw new Error('Invalid CLEF relay URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('CLEF relay URL must be an HTTPS origin');
    }
    if (!relaySecret || relaySecret.length < 32) throw new Error('CLEF relay secret is missing or too short');
    return { url: new URL('/v1/decision', url).href, token: relaySecret };
  }
  const accountId = options.accountId || env.CLOUDFLARE_ACCOUNT_ID;
  const token = options.apiToken || env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_AUTH_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !token) {
    throw new Error('Configure a CLEF relay or server-only Cloudflare account credentials');
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, token };
}

module.exports = { clefConnection };
