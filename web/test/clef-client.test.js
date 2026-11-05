const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.GVGAI_TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clef-test-'));
process.env.MODEL_GUARDRAIL_STATE = path.join(process.env.GVGAI_TRACE_DIR, 'usage.json');
const { MODEL_ID, JEV_MODEL_ID, buildClefInput, parseClefResponse, requestClef } = require('../lib/clef-client');
const { resolveModel, isModelAvailable } = require('../lib/models');
const LLMClient = require('../lib/llm-client');
const telemetry = require('../lib/telemetry-store');
telemetry.configure({ enabled: false, useEnv: false, flushMs: 0 });

const actions = ['ACTION_LEFT', 'ACTION_RIGHT'];
const state = { phase: 'ACT', gameTick: 2, gameScore: 0, blockSize: 10,
  avatarPosition: [10, 10], availableActions: actions };
function response() {
  return { success: true, result: { model: 'clef-flash',
    answers: { action: { type: 'choice', choice: 'ACTION_RIGHT', confidence: 0.8,
      probabilities: { ACTION_LEFT: 0.1, ACTION_RIGHT: 0.9 } } },
    usage: { input_tokens: 180, output_tokens: 0 } } };
}
function input() { return buildClefInput(state, { gameName: 'test', gameContent: 'Reach the exit.' }, null, null); }

test('Jev uses its pinned Decisions provider, price and model with the same legal-action validation', async () => {
  const request = buildClefInput(state, {gameName:'test'}, null, null, JEV_MODEL_ID);
  const model = resolveModel(JEV_MODEL_ID);
  assert.equal(model.decisionModel,true);
  assert.equal(model.provider,'openrouter');
  assert.equal(model.fallback,null);
  assert.equal(isModelAvailable(model,{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test'}),false);
  assert.equal(isModelAvailable(model,{CLEF_OPENROUTER_API_KEY:'test'}),true);
  const result = await requestClef(request,{openrouterKey:'test',fetch:async (url,options)=>{
    assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
    const body=JSON.parse(options.body);
    assert.equal(body.model,JEV_MODEL_ID);
    assert.deepEqual(body.provider,{only:['TypeSafe'],allow_fallbacks:false,max_price:{prompt:0.042,completion:0}});
    return {ok:true,json:async()=>({...response().result,model:`${JEV_MODEL_ID}-20261014`,provider:'TypeSafe'})};
  }});
  assert.equal(result.source,'jev-choice');
  assert.equal(result.action,'ACTION_RIGHT');
  assert.throws(()=>parseClefResponse(response(),actions,JEV_MODEL_ID),/unexpected decision model/);
  await assert.rejects(requestClef(request,{openrouterKey:'test',fetch:async()=>({ok:true,json:async()=>({
    ...response().result,model:JEV_MODEL_ID,provider:'Cloudflare'
  })})}),/unexpected Jev serving provider/);
});

test('Clef catalog routing requires both server credentials', () => {
  const model = resolveModel(MODEL_ID);
  assert.equal(model.provider, 'cloudflare');
  assert.equal(model.fallback, null);
  assert.equal(isModelAvailable(model, {}), false);
  assert.equal(isModelAvailable(model, { CLOUDFLARE_API_TOKEN: 'test' }), false);
  assert.equal(isModelAvailable(model, { CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }), true);
});

test('typed input uses only legal choices and excludes images and encoded policy', () => {
  const request = buildClefInput({ ...state, imageArray: ['secret-image'] }, {
    gameName: 'test', gameContent: 'Reach the exit.', codeProtocol: { enabled: true, authoritative: true }
  }, null, null);
  assert.deepEqual(Object.keys(request.questions.action.criteria), actions);
  assert.equal(request.model, 'clef-flash');
  assert.equal(JSON.stringify(request).includes('secret-image'), false);
  assert.equal(JSON.stringify(request).includes('REASON:'), false);
  assert.equal(request.state.game, 'test');
});

test('valid distribution preserves probabilities and actual token usage without a rationale', () => {
  const result = parseClefResponse(response(), actions);
  assert.equal(result.action, 'ACTION_RIGHT');
  assert.equal(result.reason, '');
  assert.equal(result.usage.input_tokens, 180);
  assert.equal(result.probabilities.ACTION_RIGHT, 0.9);
});

test('engine sprite names distinguish a goal from a wall in the decision map', () => {
  const request = buildClefInput({ ...state, avatarType: 1,
    spriteTypes: { 1: 'avatar', 2: 'wall', 3: 'hole' },
    observationGridNum: 3, observationGridMaxRow: 1,
    observationGrid: [[[{ category: 0, itype: 1 }]], [[{ category: 4, itype: 2 }]], [[{ category: 4, itype: 3 }]]]
  }, { gameName: 'sokoban' }, null, null);
  const map = request.state.context.find(layer => layer.name === 'Spatial + grid').text;
  assert.match(map, /1 = wall, 2 = hole/);
  assert.match(map, /@12$/);
});

test('rejects an illegal action, unknown probability key, NaN and incomplete distribution', () => {
  for (const mutate of [
    a => { a.choice = 'ACTION_USE'; },
    a => { a.probabilities.ACTION_UP = 0; },
    a => { a.confidence = NaN; },
    a => { delete a.probabilities.ACTION_LEFT; },
    a => { a.probabilities.ACTION_RIGHT = 0.2; }
  ]) {
    const data = response();
    mutate(data.result.answers.action);
    assert.throws(() => parseClefResponse(data, actions), /invalid/);
  }
});

test('REST call uses the native model path and typed body', async () => {
  const request = input();
  const result = await requestClef(request, { accountId: 'a'.repeat(32), apiToken: 'test-token',
    fetch: async (url, options) => {
      assert.ok(url.endsWith('/ai/run/@cf/cloudflare/clef-flash'));
      assert.deepEqual(JSON.parse(options.body), JSON.parse(JSON.stringify(request)));
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(JSON.parse(options.body).messages, undefined);
      return { ok: true, json: async () => response() };
    }
  });
  assert.equal(result.action, 'ACTION_RIGHT');
});

test('relay uses only its scoped secret and preserves typed response validation', async () => {
  const relaySecret = 'relay-test-'.repeat(4);
  const result = await requestClef(input(), {
    relayUrl: 'https://clef.example', relaySecret, apiToken: 'must-not-be-sent',
    fetch: async (url, options) => {
      assert.equal(url, 'https://clef.example/v1/decision');
      assert.equal(options.headers.Authorization, `Bearer ${relaySecret}`);
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).model, 'clef-flash');
      return {ok:true,json:async()=>response()};
    }
  });
  assert.equal(result.action, 'ACTION_RIGHT');
  assert.equal(isModelAvailable(resolveModel(MODEL_ID), {CLEF_RELAY_URL:'https://clef.example',CLEF_RELAY_SECRET:relaySecret}), true);
});

test('OpenRouter uses the native Decisions API and preserves the typed choice and cost', async () => {
  const request = input();
  const result = await requestClef(request, {
    provider:'openrouter', openrouterKey:'test-router-key', relayUrl:'https://unused.example',
    relaySecret:'must-not-be-sent', apiToken:'must-not-be-sent',
    fetch:async (url, options) => {
      assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
      assert.equal(options.headers.Authorization,'Bearer test-router-key');
      assert.equal(options.redirect,'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model,'cloudflare/clef-flash');
      assert.deepEqual(body.questions,request.questions);
      assert.deepEqual(body.state,JSON.parse(JSON.stringify(request.state)));
      assert.deepEqual(body.provider,{only:['Cloudflare'],allow_fallbacks:false,max_price:{prompt:0.24,completion:0}});
      assert.equal(body.messages,undefined);
      return {ok:true,json:async()=>({...response().result,model:'cloudflare/clef-flash',provider:'Cloudflare',
        usage:{input_tokens:180,output_tokens:0,cost:0.00000486}})};
    }
  });
  assert.equal(result.action,'ACTION_RIGHT');
  assert.equal(result.source,'clef-choice');
  assert.equal(result.usage.cost,0.00000486);
});

test('OpenRouter transport rejects another serving provider and hides error bodies', async () => {
  const options = {provider:'openrouter',openrouterKey:'test'};
  await assert.rejects(requestClef(input(),{...options,fetch:async()=>({ok:true,json:async()=>({
    ...response().result,model:'cloudflare/clef-flash',provider:'unexpected'
  })})}),/unexpected CLEF serving provider/);
  await assert.rejects(requestClef(input(),{...options,fetch:async()=>({ok:false,status:402,
    text:async()=>assert.fail('error body must not be read')})}),/^Error: OpenRouter Clef HTTP 402$/);
});

test('OpenRouter selection stays unavailable without its own key even when a relay exists', () => {
  const env = {CLEF_PROVIDER:'openrouter',CLEF_RELAY_URL:'https://unused.example',CLEF_RELAY_SECRET:'s'.repeat(32)};
  const model = resolveModel(MODEL_ID,env);
  assert.equal(model.provider,'openrouter');
  assert.equal(model.fallback,null);
  assert.equal(isModelAvailable(model,env),false);
  assert.equal(isModelAvailable(model,{...env,CLEF_OPENROUTER_API_KEY:'test'}),true);
});

test('OpenRouter CLEF decisions retain the same executor and truthful provider events', async t => {
  const prior = process.env.CLEF_PROVIDER;
  process.env.CLEF_PROVIDER = 'openrouter';
  t.after(()=>{ if(prior===undefined) delete process.env.CLEF_PROVIDER; else process.env.CLEF_PROVIDER=prior; });
  const instance = client();
  const result = await instance.requestLLMAction(JSON.stringify(state));
  assert.equal(result.provider,'openrouter');
  assert.equal(result.action,'ACTION_RIGHT');
  assert.equal(result.decisionSource,'clef-choice');
  assert.equal(instance.buildProviderRoutes(resolveModel(MODEL_ID)).length,1);
});

test('invalid relay configuration fails closed without falling back to account credentials', async () => {
  for (const relayUrl of ['http://clef.example', 'https://user:password@clef.example', 'https://clef.example/?token=secret', 'https://clef.example/path']) {
    await assert.rejects(requestClef(input(), {
      relayUrl, relaySecret:'r'.repeat(32), accountId:'a'.repeat(32),apiToken:'must-not-be-used',
      fetch:async()=>assert.fail('must not send credentials')
    }), /HTTPS origin/);
  }
  assert.equal(isModelAvailable(resolveModel(MODEL_ID), {CLEF_RELAY_URL:'https://clef.example'}),false);
});

test('HTTP error hides the upstream body and timeout covers body parsing', async () => {
  const options = { accountId: 'a'.repeat(32), apiToken: 'test-token' };
  await assert.rejects(requestClef(input(), { ...options,
    fetch: async () => ({ ok: false, status: 429, text: async () => 'private token' })
  }), /^Error: Cloudflare Clef HTTP 429$/);
  await assert.rejects(requestClef(input(), { ...options, timeoutMs: 5,
    fetch: async (url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) })
  }), /timed out/);
});

function client() {
  const instance = new LLMClient();
  instance.model = MODEL_ID;
  instance.promptConfig = { gameName: 'test', gameContent: 'Reach the exit.',
    codeProtocol: { enabled: true, authoritative: true }, macroActions: { enabled: true } };
  instance.callProvider = async () => parseClefResponse(response(), actions);
  return instance;
}

test('Clef goes through model selection despite authoritative policies and keeps typed events', async () => {
  const instance = client();
  const events = [];
  instance.io = { emit: (event, payload) => events.push({ event, payload }) };
  assert.equal(instance.resolveAuthoritativePolicy(JSON.stringify(state)), null);
  assert.equal(instance.macroEnabled(), false);
  const decision = await instance.requestLLMAction(JSON.stringify(state));
  assert.equal(decision.action, 'ACTION_RIGHT');
  assert.equal(decision.decisionSource, 'clef-choice');
  const event = events.find(event => event.event === 'llm-reasoning').payload;
  assert.equal(event.decision.probabilities.ACTION_RIGHT, 0.9);
  assert.equal(JSON.parse(event.prompt).model, 'clef-flash');
  assert.equal(event.systemPrompt, null);
  assert.deepEqual(event.promptLayers, JSON.parse(event.prompt).state.context);
  assert.equal(event.reason, '');
});

test('decision cap records the last executed action outcome and labels the stop', async () => {
  const instance = client();
  instance.maxActions = 1;
  instance.runLog.push({ tick: 1, action: 'ACTION_RIGHT', reason: '' });
  instance.lastSso = { ...state, gameTick: 1, gameScore: 0 };
  const events = [];
  const sent = [];
  instance.io = { emit: (event, payload) => events.push({ event, payload }) };
  instance.sendMessageWithId = (id, message) => sent.push(message);
  await instance.processMessage(`3#${JSON.stringify({ ...state, gameScore: 1 })}`);
  const summary = events.find(event => event.event === 'run-summary').payload;
  assert.equal(summary.endedBy, 'decision-cap');
  assert.equal(summary.finalScore, 1);
  assert.equal(summary.ticks, 2);
  assert.equal(summary.decisions, 1);
  assert.match(sent[0], /^ABORT#/);
});

test('discard a late answer after disconnect, a new level, or changed legal actions', async () => {
  for (const change of [c => c.disconnect(), c => { c.levelCount += 1; },
    c => { c.lastSso = { ...state, availableActions: ['ACTION_LEFT'] }; }]) {
    const instance = client();
    instance.callProvider = async () => { change(instance); return parseClefResponse(response(), actions); };
    const result = await instance.requestLLMAction(JSON.stringify(state));
    assert.equal(result.stale, true);
    assert.equal(instance.pendingLLMAction, null);
    assert.equal(instance.runLog.length, 0);
  }
});

test('Cloudflare requests share the remote-provider budget', () => {
  const guardrail = require('../lib/usage-guardrail');
  const verdict = guardrail.admitRemoteCall('cloudflare', 0);
  assert.equal(verdict.allowed, true);
  const persisted = JSON.parse(fs.readFileSync(process.env.MODEL_GUARDRAIL_STATE, 'utf8'));
  assert.equal(persisted.dayByProvider.cloudflare, 1);
});

test('Clef full model uses its own endpoint and verifies response identity', async () => {
  const request = buildClefInput(state, { gameName: 'test' }, null, null, '@cf/cloudflare/clef');
  assert.equal(request.model, 'clef');
  await assert.rejects(requestClef(request, { accountId: 'a'.repeat(32), apiToken: 'test',
    fetch: async url => {
      assert.ok(url.endsWith('/ai/run/@cf/cloudflare/clef'));
      return { ok: true, json: async () => response() };
    }
  }), /unexpected decision model/);
});

test('one surviving forecast remains a valid multi-option question with risk labels', () => {
  const forecast = terminal => ({ immediate: { terminal, winner: terminal ? 'PLAYER_LOSES' : 'NO_WINNER', position: [1, 1] },
    continuation: { winner: 'NO_WINNER', steps: 2, scoreDelta: 0, targetDistance: 1, utility: -10.2 } });
  const request = buildClefInput({ ...state, actionOutcomes: {
    ACTION_LEFT: forecast(true), ACTION_RIGHT: forecast(false)
  } }, { gameName: 'test' }, null, null);
  assert.equal(Object.keys(request.questions.action.criteria).length, 2);
  assert.match(request.questions.action.criteria.ACTION_LEFT, /WARNING.*loss/);
});

test('rejects a choice that contradicts the maximum preference', () => {
  const data = response();
  data.result.answers.action.choice = 'ACTION_LEFT';
  assert.throws(() => parseClefResponse(data, actions), /inconsistent/);
});

test('Sokoban distinguishes verified wins, deadlocks and exhausted search budgets', () => {
  const candidate = (status, engineVerified=false, solutionMoves=null) => ({
    immediate:{position:[1,1],terminal:false,deadlocked:false},
    continuation:{winner:engineVerified?'PLAYER_WINS':'NO_WINNER',steps:solutionMoves||1,scoreDelta:0,targetDistance:1},
    puzzle:{status,engineVerified,solutionMoves}
  });
  const request = buildClefInput({...state,availableActions:[...actions,'ACTION_NIL'],actionOutcomes:{
    ACTION_LEFT:candidate('no-solution'),ACTION_RIGHT:candidate('solution',true,29),
    ACTION_NIL:candidate('budget-exhausted')
  }},{gameName:'sokoban'},null,null);
  assert.deepEqual(Object.keys(request.questions.action.criteria),['ACTION_RIGHT','ACTION_NIL']);
  assert.match(request.questions.action.criteria.ACTION_RIGHT,/COMPLETE WIN VERIFIED IN JAVA: 29/);
  assert.match(request.questions.action.criteria.ACTION_NIL,/budget-exhausted/);
  assert.match(request.questions.action.instructions,/puzzles can require revisiting/);
  assert.match(request.state.planning.method,/not guaranteed shortest/);
});

test('provider failure aborts a synchronized CLEF run without fabricating moves', async () => {
  const instance = client();
  instance.synchronousActions = true;
  instance.requestLLMAction = async () => { throw new Error('Cloudflare Clef HTTP 503'); };
  const sent = [], summaries = [];
  instance.sendMessageWithId = (id, message) => sent.push(message);
  instance.io = { emit: (event, data) => { if (event === 'run-summary') summaries.push(data); } };
  await instance.processMessage(`4#${JSON.stringify(state)}`);
  assert.match(sent[0], /^ABORT#/);
  assert.equal(instance.runLog.length, 0);
  assert.equal(summaries[0].endedBy, 'provider-error');
});

test('CLEF tactics do not replace model choices with a deterministic steering action', async () => {
  const instance = client();
  instance.sessionStrategy = 'move left';
  const result = await instance.requestLLMAction(JSON.stringify(state));
  assert.equal(result.action, 'ACTION_RIGHT');
  assert.equal(result.provider, 'cloudflare');
  assert.equal(result.decisionSource, 'clef-choice');
  assert.equal(instance.buildRunSummary(state).adherence.label, 'Not measured');
});

test('oversized contexts are rejected before contacting the provider', async () => {
  const request = input(); request.state.extra = 'x'.repeat(64000);
  await assert.rejects(requestClef(request, { fetch() { throw new Error('must not call'); } }), /64 KB/);
});

test('Java socket completion and a later FINISH notify the browser and clean up once', async () => {
  const instance = client();
  const ended = [];
  let cleanup = 0;
  instance.completedLevels = 1;
  instance.io = { emit: (event, payload) => { if (event === 'session-end') ended.push(payload); } };
  instance.onSessionEnd = () => { cleanup += 1; };
  instance._triggerSessionEnd();
  await instance.processMessage('9#FINISH');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].levelsPlayed, 1);
  assert.equal(cleanup, 1);
});

test('a one-level run stops after a loss instead of silently replaying', async () => {
  const instance = client();
  instance.stopAfterLevel = true;
  const sent = [];
  instance.sendMessageWithId = (id, message) => sent.push(message);
  await instance.handleEnd({ ...state, gameWinner: 'PLAYER_LOSES' }, '10');
  assert.deepEqual(sent, ['END_TRAINING']);
  assert.equal(instance.levelCount, 0);
  assert.equal(instance.completedLevels, 1);
});
