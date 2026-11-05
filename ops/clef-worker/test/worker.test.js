import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const secret = 'test-only-'.repeat(5);
const valid = { model: 'clef', state: { legalActions: ['ACTION_LEFT','ACTION_RIGHT'] }, questions: {
  action: { type: 'choice', instructions: 'Move to the goal.', criteria: { ACTION_LEFT: 'Left', ACTION_RIGHT: 'Right' } }
}};
const request = (body = valid, token = secret) => new Request('https://relay.example/v1/decision', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

test('authentication and invalid schemas cannot call Workers AI', async () => {
  let calls = 0;
  const env = { RELAY_SECRET: secret, AI: { run: () => { calls++; } } };
  assert.equal((await worker.fetch(request(valid, 'wrong'), env)).status, 401);
  for (const body of [{...valid,model:'expensive-chat-model'}, {...valid,questions:{extra:valid.questions.action}}, {...valid,state:{legalActions:['ACTION_LEFT']}}]) {
    assert.equal((await worker.fetch(request(body), env)).status, 400);
  }
  assert.equal(calls, 0);
});

test('body size is enforced for requests without a Content-Length header', async () => {
  const env = { RELAY_SECRET: secret, AI: { run: () => assert.fail('must not call model') } };
  assert.equal((await worker.fetch(request({...valid,state:{...valid.state,padding:'x'.repeat(64000)}}), env)).status, 413);
});

test('native CLEF response is preserved and caller cannot choose another model', async () => {
  const result = { model:'clef', answers:{action:{type:'choice',choice:'ACTION_RIGHT'}}, usage:{input_tokens:12} };
  const env = { RELAY_SECRET: secret, AI: { run: async (model,input) => {
    assert.equal(model,'@cf/cloudflare/clef'); assert.deepEqual(input,valid); return result;
  } } };
  const actual = await worker.fetch(request(), env);
  assert.equal(actual.status, 200);
  assert.equal(actual.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await actual.json(), {success:true,result});
});

test('upstream errors never expose request or credential details', async () => {
  const env = { RELAY_SECRET: secret, AI: { run: async () => { throw new Error(secret); } } };
  const actual = await worker.fetch(request(), env);
  assert.equal(actual.status, 502);
  assert.equal((await actual.text()).includes(secret),false);
});
