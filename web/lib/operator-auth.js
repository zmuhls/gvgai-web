'use strict';

const crypto = require('crypto');

function bearerToken(req) {
  const header = String(req.get?.('authorization') || req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorizeOperator(req, options = {}) {
  const env = options.env || process.env;
  if (options.enabledKey && env[options.enabledKey] !== 'true') {
    return { ok: false, status: 403, error: 'This operator action is disabled.' };
  }

  const expected = env.MODEL_CONTROL_TOKEN;
  if (!expected) {
    return { ok: false, status: 503, error: 'Model operator access is not configured.' };
  }
  if (!safeEqual(bearerToken(req), expected)) {
    return { ok: false, status: 401, error: 'Operator authorization is required.' };
  }
  return { ok: true };
}

function requireOperator(options = {}) {
  return (req, res, next) => {
    const result = authorizeOperator(req, options);
    if (!result.ok) {
      res.set('Cache-Control', 'no-store');
      res.status(result.status).json({ error: result.error });
      return;
    }
    next();
  };
}

module.exports = { authorizeOperator, requireOperator, _private: { bearerToken, safeEqual } };
