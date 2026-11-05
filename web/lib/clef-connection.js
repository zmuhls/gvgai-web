// Relay credentials never fall back to an account-wide Cloudflare token.
function clefConnection(modelId, env = process.env, options = {}) {
  const provider = options.provider ?? env.CLEF_PROVIDER ?? 'cloudflare';
  if (!['cloudflare', 'openrouter'].includes(provider)) throw new Error('Unsupported CLEF provider');
  if (provider === 'openrouter') {
    const token = options.openrouterKey || env.CLEF_OPENROUTER_API_KEY || env.OPENROUTER_API_KEY;
    if (!token) throw new Error('Configure a server-only OpenRouter key for CLEF');
    return {url:'https://openrouter.ai/api/alpha/decisions', token, provider};
  }
  const relayUrl = options.relayUrl ?? env.CLEF_RELAY_URL;
  const relaySecret = options.relaySecret ?? env.CLEF_RELAY_SECRET;
  if (relayUrl || relaySecret) {
    let url;
    try { url = new URL(relayUrl); } catch { throw new Error('Invalid CLEF relay URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('CLEF relay URL must be an HTTPS origin');
    }
    if (!relaySecret || relaySecret.length < 32) throw new Error('CLEF relay secret is missing or too short');
    return { url: new URL('/v1/decision', url).href, token: relaySecret, provider };
  }
  const accountId = options.accountId || env.CLOUDFLARE_ACCOUNT_ID;
  const token = options.apiToken || env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_AUTH_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(accountId || '') || !token) {
    throw new Error('Configure a CLEF relay or server-only Cloudflare account credentials');
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`, token, provider };
}

module.exports = { clefConnection };
