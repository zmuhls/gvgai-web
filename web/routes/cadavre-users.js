const express = require('express');
const {
  CadavreUserStore,
  StoreError,
  SESSION_COOKIE,
  SESSION_TTL_MS
} = require('../lib/cadavre-user-store');

function cookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((result, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 0) return result;
    result[pair.slice(0, separator).trim()] = decodeURIComponent(pair.slice(separator + 1).trim());
    return result;
  }, {});
}

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== requestOrigin(req)) {
    throw new StoreError(403, 'Cross-origin account requests are not allowed');
  }
}

function clientAddress(req) {
  return String(
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'local'
  ).slice(0, 100);
}

function sessionCookie(req, token, maximumAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ||
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maximumAgeSeconds}`,
    'SameSite=Lax',
    'Priority=High',
    ...(secure ? ['Secure'] : [])
  ].join('; ');
}

function publicUser(user) {
  return { userId: user.id, username: user.username, email: user.email };
}

async function sendResetEmail(user, resetUrl) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CADAVRE_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn('[Cadavre Auth] Password reset email not sent: RESEND_API_KEY or CADAVRE_FROM_EMAIL is missing');
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [user.email],
      subject: 'Reset your Cadavre Exquis password',
      text: `Hello ${user.username},\n\nUse this link within one hour to reset your password:\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`
    })
  });
  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

function createCadavreUserRouter(options = {}) {
  const router = express.Router();
  const store = options.store || new CadavreUserStore({ sendReset: options.sendReset || sendResetEmail });

  function currentUser(req) {
    return store.sessionUser(cookies(req)[SESSION_COOKIE]);
  }

  function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw new StoreError(401, 'Not authenticated');
    return user;
  }

  function route(handler) {
    return async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (!(error instanceof StoreError)) {
          console.error('[Cadavre Users]', error);
        }
        res.status(error.status || 500).json({
          error: error.status ? error.message : 'Account service unavailable',
          ...(error.details ? { details: error.details } : {})
        });
      }
    };
  }

  router.post('/auth/register', route(async (req, res) => {
    requireSameOrigin(req);
    store.rateLimit(`register:${clientAddress(req)}`, 5, 60 * 60 * 1000);
    const result = store.register(req.body || {});
    res.setHeader('Set-Cookie', sessionCookie(req, result.session.raw, SESSION_TTL_MS / 1000));
    res.status(201).json(publicUser(result.user));
  }));

  router.post('/auth/login', route(async (req, res) => {
    requireSameOrigin(req);
    store.rateLimit(`login:${clientAddress(req)}`, 20, 10 * 60 * 1000);
    const result = store.login(req.body?.login, req.body?.password);
    res.setHeader('Set-Cookie', sessionCookie(req, result.session.raw, SESSION_TTL_MS / 1000));
    res.json(publicUser(result.user));
  }));

  router.post('/auth/logout', route(async (req, res) => {
    requireSameOrigin(req);
    store.logout(cookies(req)[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  }));

  router.get('/auth/me', route(async (req, res) => {
    const user = requireUser(req);
    res.json(publicUser(user));
  }));

  router.post('/auth/forgot-password', route(async (req, res) => {
    requireSameOrigin(req);
    store.rateLimit(`reset:${clientAddress(req)}`, 5, 60 * 60 * 1000);
    const baseUrl = process.env.PUBLIC_BASE_URL || requestOrigin(req);
    try {
      await store.requestPasswordReset(req.body?.email, (token) =>
        `${baseUrl}/cadavre?reset=${encodeURIComponent(token)}`
      );
    } catch (error) {
      if (error instanceof StoreError) throw error;
      console.error('[Cadavre Auth] Password reset delivery failed', error);
    }
    res.status(202).json({ ok: true, message: 'If that account exists, a reset link is on its way.' });
  }));

  router.post('/auth/reset-password', route(async (req, res) => {
    requireSameOrigin(req);
    store.rateLimit(`reset-submit:${clientAddress(req)}`, 10, 60 * 60 * 1000);
    store.resetPassword(req.body?.token, req.body?.password);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  }));

  router.get('/poems', route(async (req, res) => {
    const user = requireUser(req);
    res.json({ poems: store.listPoems(user.id) });
  }));

  router.post('/poems', route(async (req, res) => {
    requireSameOrigin(req);
    const user = requireUser(req);
    res.status(201).json(store.createPoem(user.id, req.body || {}));
  }));

  router.patch('/poems/:id', route(async (req, res) => {
    requireSameOrigin(req);
    const user = requireUser(req);
    const poemId = Number(req.params.id);
    if (!Number.isInteger(poemId) || poemId < 1) throw new StoreError(400, 'Invalid poem id');
    res.json(store.updatePoem(user.id, poemId, req.body || {}));
  }));

  router.delete('/poems/:id', route(async (req, res) => {
    requireSameOrigin(req);
    const user = requireUser(req);
    const poemId = Number(req.params.id);
    if (!Number.isInteger(poemId) || poemId < 1) throw new StoreError(400, 'Invalid poem id');
    store.deletePoem(user.id, poemId);
    res.status(204).end();
  }));

  router._cadavreStore = store;
  router.closeStore = () => store.close();
  return router;
}

module.exports = {
  createCadavreUserRouter,
  _private: {
    cookies,
    requestOrigin,
    requireSameOrigin,
    sessionCookie,
    publicUser
  }
};
