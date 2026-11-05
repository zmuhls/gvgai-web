const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.GVGAI_TRACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clef-control-'));
process.env.MODEL_GUARDRAIL_STATE = path.join(process.env.GVGAI_TRACE_DIR, 'usage.json');
const { limits, mayContinue } = require('../lib/clef-control');
const { buildClefInput } = require('../lib/clef-client');
const LLMClient = require('../lib/llm-client');
require('../lib/telemetry-store').configure({enabled:false,useEnv:false,flushMs:0});

function state(tick = 0) {
  const actions = ['ACTION_LEFT','ACTION_RIGHT','ACTION_UP','ACTION_DOWN','ACTION_USE','ACTION_NIL'];
  const x = 5 + tick / 2, y = 5;
  return {phase:'ACT', gameTick:tick, gameScore:tick, blockSize:20,
    avatarPosition:[x*20,y*20], avatarType:1, avatarHealthPoints:1,
    avatarResources:{}, NPCPositions:[], movablePositions:[], availableActions:actions,
    actionOutcomes:Object.fromEntries(actions.map(action => {
      const position = [x + (action==='ACTION_RIGHT' ? 0.5 : action==='ACTION_LEFT' ? -0.5 : 0),y];
      const forecast = {position,health:1,scoreDelta:0,steps:1,winner:'NO_WINNER',targetDistance:3};
      return [action,{riskSamples:7,immediateLosses:0,immediate:forecast,continuation:forecast}];
    }))};
}

test('short holds are declared to CLEF; Sokoban and blocked directions remain single step', () => {
  const request = buildClefInput(state(),{gameName:'pacman'},null,null,'@cf/cloudflare/clef',6);
  assert.equal(request.state.control.maxTicksByAction.ACTION_RIGHT,6);
  assert.equal(request.state.control.maxTicksByAction.ACTION_UP,1);
  assert.equal(request.state.control.maxTicksByAction.ACTION_USE,6);
  assert.match(request.questions.action.instructions,/holding exactly that key/);
  assert.match(request.questions.action.criteria.ACTION_RIGHT,/at most 6 tick/);
  assert.deepEqual(new Set(Object.values(limits(state(),'sokoban',6))),new Set([1]));
});

test('a hold stops for changed tactics, hazards, damage, blocked movement and a newly opened turn', () => {
  const hold = {action:'ACTION_RIGHT',remaining:5,previous:state(),revision:2};
  assert.equal(mayContinue(hold,state(1),2),true);
  assert.equal(mayContinue(hold,state(1),3),false);
  for (const change of [
    s=>{s.NPCPositions=[[{position:{x:140,y:100}}]];},
    s=>{s.movablePositions=[[{position:{x:140,y:100}}]];},
    s=>{s.avatarHealthPoints=0;},
    s=>{s.gameScore=-1;},
    s=>{s.avatarType=2;},
    s=>{s.avatarResources={2:1};},
    s=>{s.actionOutcomes.ACTION_RIGHT.immediateLosses=1;},
    s=>{s.actionOutcomes.ACTION_RIGHT.immediate.position=[5.5,5];},
    s=>{s.actionOutcomes.ACTION_UP.immediate.position=[5.5,4.5];},
    s=>{s.avatarPosition=[100,100];},
    s=>{s.gameTick=2;}
  ]) {
    const next=state(1); change(next);
    assert.equal(mayContinue(hold,next,2),false);
  }
});

function client() {
  const client = new LLMClient({synchronousActions:true,clefControlTicks:6});
  client.model='@cf/cloudflare/clef'; client.gameActive=true;
  client.promptConfig={gameName:'pacman'};
  client.actResponseType='JSON_PLANNING_LIVE';
  const sent=[],events=[]; let requests=0;
  client.sendMessageWithId=(_id,message)=>sent.push(message);
  client.io={emit:(event,data)=>events.push({event,data})};
  client.callProvider=async()=>{
    requests++;
    return {action:'ACTION_RIGHT',source:'clef-choice',confidence:1,
      probabilities:{ACTION_RIGHT:1},raw:{model:'clef'},usage:{input_tokens:0}};
  };
  return {client,sent,events,requests:()=>requests};
}

test('one remote choice advances at most six checked ticks; trace separates calls from execution', async () => {
  const c=client();
  for(let tick=0;tick<7;tick++) {
    const s=state(tick);
    s.planningMode=tick===0 || tick===6 ? 'JSON_PLANNING_LIVE' : 'JSON_PLANNING_GUARD';
    await c.client.processMessage(`${tick}#${JSON.stringify(s)}`);
  }
  assert.equal(c.requests(),2);
  assert.equal(c.sent.length,7);
  assert.ok(c.sent.every(message=>message.startsWith('ACTION_RIGHT#')));
  assert.equal(c.sent[5],'ACTION_RIGHT#JSON_PLANNING_LIVE');
  const summary=c.client.buildRunSummary(state(7));
  assert.equal(summary.decisions,2); assert.equal(summary.executedTicks,7);
  assert.equal(summary.controlSteps.filter(s=>s.source==='clef-hold').length,5);
  assert.equal(c.events.filter(e=>e.event==='llm-reasoning').length,2);
});

test('an interrupted hold requests fresh planning at the same tick without sending a game action', async () => {
  const c=client();
  await c.client.processMessage(`0#${JSON.stringify(state())}`);
  const s=state(1); s.planningMode='JSON_PLANNING_GUARD';
  s.actionOutcomes.ACTION_UP.immediate.position=[5.5,4.5];
  await c.client.processMessage(`1#${JSON.stringify(s)}`);
  assert.equal(c.sent[1],'REPLAN#JSON_PLANNING_LIVE');
  assert.equal(c.requests(),1);
  assert.equal(c.client.controlSteps.length,1);
  s.planningMode='JSON_PLANNING_LIVE';
  await c.client.processMessage(`2#${JSON.stringify(s)}`);
  assert.equal(c.requests(),2);
  assert.equal(c.client.controlSteps[1].tick,1);
});

test('stopping a run cancels its pending hold', async () => {
  const c=client();
  await c.client.processMessage(`0#${JSON.stringify(state())}`);
  c.client.disconnect();
  const s=state(1); s.planningMode='JSON_PLANNING_GUARD';
  await c.client.processMessage(`1#${JSON.stringify(s)}`);
  assert.equal(c.client.controlSteps.length,1);
  assert.equal(c.requests(),1);
});
