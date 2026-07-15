const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CadavreUserStore } = require('../lib/cadavre-user-store');

function withStore(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cadavre-users-'));
  const store = new CadavreUserStore({
    databasePath: path.join(directory, 'cadavre.db'),
    ...options
  });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test('cadavre accounts own editable, revision-checked poems', (t) => {
  const store = withStore(t);
  const { user, session } = store.register({
    username: 'cadavrist',
    email: 'cadavrist@example.com',
    password: 'FoldedPage9'
  });

  assert.equal(store.sessionUser(session.raw).username, 'cadavrist');
  const saved = store.createPoem(user.id, {
    title: 'Night orchard',
    lines: ['the night', 'eats an orchard'],
    reading: 'The image turns darkness into an appetite.'
  });
  assert.equal(saved.revision, 1);

  const edited = store.updatePoem(user.id, saved.id, {
    title: 'Night orchard',
    lines: ['the night', 'eats the red orchard'],
    reading: 'The revision makes the appetite visible.',
    expected_revision: 1
  });
  assert.equal(edited.revision, 2);
  assert.deepEqual(store.listPoems(user.id)[0].lines, ['the night', 'eats the red orchard']);
  assert.throws(
    () => store.updatePoem(user.id, saved.id, {
      title: 'Stale', lines: ['old line'], expected_revision: 1
    }),
    (error) => error.status === 409
  );
});

test('password reset links are one-time and revoke existing sessions', async (t) => {
  let resetUrl = '';
  const store = withStore(t, {
    sendReset: async (_user, url) => { resetUrl = url; }
  });
  const registered = store.register({
    username: 'paperfold',
    email: 'paper@example.com',
    password: 'Original9'
  });

  await store.requestPasswordReset('paper@example.com', (token) => `https://example.test/cadavre?reset=${token}`);
  const token = new URL(resetUrl).searchParams.get('reset');
  assert.ok(token);

  store.resetPassword(token, 'Replacement8');
  assert.equal(store.sessionUser(registered.session.raw), null);
  assert.throws(() => store.login('paperfold', 'Original9'), (error) => error.status === 401);
  assert.equal(store.login('paper@example.com', 'Replacement8').user.username, 'paperfold');
  assert.throws(() => store.resetPassword(token, 'AnotherPass7'), (error) => error.status === 400);
});
