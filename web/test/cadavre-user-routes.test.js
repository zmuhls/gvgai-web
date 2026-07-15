const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { CadavreUserStore } = require('../lib/cadavre-user-store');
const { createCadavreUserRouter } = require('../routes/cadavre-users');

async function startAccountServer(t, databasePath) {
  const store = new CadavreUserStore({ databasePath });
  const app = express();
  app.use(express.json());
  app.use('/api/cadavre', createCadavreUserRouter({ store }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}/api/cadavre${route}`, {
    method: options.method || 'GET',
    headers: {
      Origin: baseUrl,
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test('account routes save, edit, persist, and isolate poems by owner', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-user-routes-'));
  const databasePath = path.join(directory, 'cadavre.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { baseUrl } = await startAccountServer(t, databasePath);

  const registration = await jsonRequest(baseUrl, '/auth/register', {
    method: 'POST',
    body: { username: 'foldkeeper', email: 'foldkeeper@example.com', password: 'FoldedPage9' }
  });
  assert.equal(registration.response.status, 201);
  assert.match(registration.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(registration.response.headers.get('set-cookie'), /SameSite=Lax/);
  const ownerCookie = cookieFrom(registration.response);

  const currentUser = await jsonRequest(baseUrl, '/auth/me', { cookie: ownerCookie });
  assert.equal(currentUser.response.status, 200);
  assert.equal(currentUser.body.username, 'foldkeeper');

  const created = await jsonRequest(baseUrl, '/poems', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      title: 'Night orchard',
      lines: ['the night', 'eats an orchard'],
      reading: 'The image turns darkness into appetite.'
    }
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.revision, 1);

  const listed = await jsonRequest(baseUrl, '/poems', { cookie: ownerCookie });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.poems[0].lines, ['the night', 'eats an orchard']);

  const secondRegistration = await jsonRequest(baseUrl, '/auth/register', {
    method: 'POST',
    body: { username: 'otherhand', email: 'otherhand@example.com', password: 'SecondFold8' }
  });
  assert.equal(secondRegistration.response.status, 201);
  const otherCookie = cookieFrom(secondRegistration.response);
  const otherList = await jsonRequest(baseUrl, '/poems', { cookie: otherCookie });
  assert.deepEqual(otherList.body.poems, []);

  const forbiddenUpdate = await jsonRequest(baseUrl, `/poems/${created.body.id}`, {
    method: 'PATCH',
    cookie: otherCookie,
    body: { title: 'Taken', lines: ['not theirs'], expected_revision: 1 }
  });
  assert.equal(forbiddenUpdate.response.status, 404);

  const edited = await jsonRequest(baseUrl, `/poems/${created.body.id}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: {
      title: 'Red orchard',
      lines: ['the night', 'eats the red orchard'],
      reading: 'The revision makes the appetite visible.',
      expected_revision: 1
    }
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.revision, 2);

  const staleUpdate = await jsonRequest(baseUrl, `/poems/${created.body.id}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { title: 'Stale copy', lines: ['old words'], expected_revision: 1 }
  });
  assert.equal(staleUpdate.response.status, 409);
  assert.equal(staleUpdate.body.details.revision, 2);

  const logout = await jsonRequest(baseUrl, '/auth/logout', { method: 'POST', cookie: ownerCookie });
  assert.equal(logout.response.status, 200);
  const signedOut = await jsonRequest(baseUrl, '/poems', { cookie: ownerCookie });
  assert.equal(signedOut.response.status, 401);

  const login = await jsonRequest(baseUrl, '/auth/login', {
    method: 'POST',
    body: { login: 'foldkeeper@example.com', password: 'FoldedPage9' }
  });
  assert.equal(login.response.status, 200);
  const reopened = await jsonRequest(baseUrl, '/poems', { cookie: cookieFrom(login.response) });
  assert.deepEqual(reopened.body.poems[0].lines, ['the night', 'eats the red orchard']);
  assert.equal(reopened.body.poems[0].revision, 2);
});

test('saved poems remain available after the account store reopens', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-user-persistence-'));
  const databasePath = path.join(directory, 'cadavre.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let store = new CadavreUserStore({ databasePath });
  const { user } = store.register({
    username: 'archivefold', email: 'archive@example.com', password: 'ArchiveFold7'
  });
  store.createPoem(user.id, { title: 'Kept fold', lines: ['paper remembers'] });
  store.close();

  store = new CadavreUserStore({ databasePath });
  t.after(() => store.close());
  const loggedIn = store.login('archivefold', 'ArchiveFold7');
  assert.equal(store.listPoems(loggedIn.user.id)[0].title, 'Kept fold');
});
