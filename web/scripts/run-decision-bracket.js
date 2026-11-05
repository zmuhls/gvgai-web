#!/usr/bin/env node
// A bounded pilot: identical simulator evidence and guarded control for all
// entrants. DeepSeek uses JSON chat output, not invented choice probabilities.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const ROSTER = [
  {id:'@cf/cloudflare/clef',slug:'cloudflare/clef',family:'clef',provider:'Cloudflare',price:0.24,reserve:65536*0.24/1e6},
  {id:'typesafe/jev-1.14',slug:'typesafe/jev-1.14',family:'jev',provider:'TypeSafe',price:0.042,reserve:262144*0.042/1e6},
  {id:'deepseek-v4-flash',slug:'deepseek/deepseek-v4-flash',family:'deepseek',provider:'Relace',price:0.05,reserve:(65536*0.05+128*0.5)/1e6}
];
const QUALIFIERS = [
  {gameId:68,gameName:'pacman',levelId:0,seed:7,cap:24},
  {gameId:66,gameName:'modality',levelId:0,seed:2026,cap:20},
  {gameId:26,gameName:'crossfire',levelId:0,seed:7,cap:48}
];
const FINALS = [
  {gameId:87,gameName:'sokoban',levelId:4,seed:2026,cap:16},
  {gameId:13,gameName:'butterflies',levelId:4,seed:7,cap:48},
  {gameId:108,gameName:'zelda',levelId:4,seed:2026,cap:48}
];
const CHALLENGES = [
  {gameId:30,gameName:'digdug',levelId:1,seed:7,cap:32},
  {gameId:30,gameName:'digdug',levelId:4,seed:2026,cap:24},
  {gameId:68,gameName:'pacman',levelId:4,seed:2026,cap:20},
  {gameId:0,gameName:'aliens',levelId:4,seed:7,cap:20}
];

function compare(a,b) {
  const status = x => x.valid ? (x.winner==='PLAYER_WINS' ? 3 : x.winner==='PLAYER_LOSES' ? 1 : 2) : 0;
  return Math.sign(status(a)-status(b) || a.score-b.score ||
    (a.winner==='PLAYER_WINS' && b.winner==='PLAYER_WINS' ? b.ticks-a.ticks : 0));
}

function standings(rows, models) {
  return models.map(model => {
    const own = rows.filter(r=>r.modelId===model.id);
    let points=0;
    for(const row of own) for(const other of rows.filter(r=>r.gameId===row.gameId&&
        r.levelId===row.levelId&&r.seed===row.seed&&r.modelId!==model.id)) {
      const result=compare(row,other); points+=result>0?1:result===0?0.5:0;
    }
    return {modelId:model.id,points,wins:own.filter(r=>r.winner==='PLAYER_WINS').length,
      valid:own.length>0&&own.every(r=>r.valid)};
  }).sort((a,b)=>Number(b.valid)-Number(a.valid)||b.points-a.points||b.wins-a.wins);
}

async function main() {
  const args=process.argv.slice(2);
  const arg=name=>args[args.indexOf(name)+1];
  if(!args.includes('--out')||!args.includes('--budget-usd'))throw new Error('Specify --out and --budget-usd');
  const out=path.resolve(arg('--out')), limit=Number(arg('--budget-usd'));
  const challenge=args.includes('--challenge');
  const qualifiers=challenge?CHALLENGES:QUALIFIERS;
  assert.ok(limit>0&&limit<=0.20,'This pilot is capped at $0.20');
  const key=process.env.CLEF_OPENROUTER_API_KEY;
  if(!key)throw new Error('Set the server-only CLEF_OPENROUTER_API_KEY');
  const recordPath=path.join(out,'bracket.json');
  if(fs.existsSync(recordPath))throw new Error('Use a fresh output directory; preserve previous attempts');
  fs.mkdirSync(out,{recursive:true});
  fs.copyFileSync(__filename,path.join(out,'runner-at-start.js'));
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.GVGAI_SOCKET_PORT=String(server.address().port);
  await new Promise(resolve=>server.close(resolve));
  process.env.GVGAI_SCREENSHOT_PATH=path.join(out,'frame.png');
  process.env.GVGAI_TRACE_DIR=path.join(out,'traces');
  process.env.MODEL_GUARDRAIL_STATE=path.join(out,'guardrails.json');
  process.env.CLEF_PROVIDER='openrouter';
  process.env.TELEMETRY_ENABLED='false';
  require('../lib/telemetry-store').configure({enabled:false,useEnv:false,flushMs:0});
  const {runEvalCase}=require('../lib/batch-evaluator');
  const LLMClient=require('../lib/llm-client');
  const manager=require('../lib/game-manager');
  const {buildClefInput,parseClefResponse}=require('../lib/clef-client');
  // Evaluation-only: put the champion on the same observed, bounded executor.
  // Its production chat controller and model catalog on disk are unchanged.
  const champion=require('../lib/models').MODELS.find(m=>m.id==='deepseek-v4-flash');
  champion.decisionModel=true;
  champion.decisionFamily='deepseek';
  const keyStatus=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${key}`}});
  if(!keyStatus.ok)throw new Error('Cannot verify remaining allowance');
  const balance=(await keyStatus.json()).data;
  assert.ok(balance.limit_remaining>=limit+0.02,'Keep $0.02 for production verification');
  const record={version:1,startedAt:new Date().toISOString(),code:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    limit,charged:0,allowanceBefore:balance.limit_remaining,roster:ROSTER,challenge,qualifiers,finals:challenge?[]:FINALS,
    protocol:'Shared simulator evidence, six-tick guarded holds, native choice for CLEF/Jev, JSON chat choice for DeepSeek; no retries or fallback.',
    ranking:'Per-game pairwise points: win > unfinished > loss; then same-game score; completed wins tie-break on fewer engine ticks. Latency is diagnostic only. Invalid runs cannot promote.',
    results:[],requests:[],complete:false};
  record.sourceHashes=Object.fromEntries([__filename,...['clef-client.js','clef-control.js','llm-client.js'].map(f=>path.join(__dirname,'../lib',f))]
    .map(f=>[path.relative(path.resolve(__dirname,'../..'),f),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
  const save=()=>fs.writeFileSync(recordPath,JSON.stringify(record,null,2));
  save();

  async function request(model,input) {
    if(record.charged+model.reserve>limit){const e=new Error('Bracket budget exhausted');e.guardrail=true;throw e;}
    const payload=model.family==='deepseek' ? {
      model:model.slug,messages:[
        {role:'system',content:'Select one offered legal action using the supplied state and question. Reply with only a JSON object with one field: "action". Do not include a rationale or probabilities.'},
        {role:'user',content:JSON.stringify({state:input.state,questions:input.questions})}
      ],temperature:0,max_tokens:128,reasoning:{enabled:false},response_format:{type:'json_object'},
      provider:{only:[model.provider],allow_fallbacks:false,require_parameters:true,max_price:{prompt:model.price,completion:0.5}}
    } : {...input,model:model.slug,
      provider:{only:[model.provider],allow_fallbacks:false,max_price:{prompt:model.price,completion:0}}};
    const body=JSON.stringify(payload);
    assert.ok(Buffer.byteLength(body)<64000);
    record.charged+=model.reserve; save();
    const start=performance.now();
    const response=await fetch(`https://openrouter.ai/api/${model.family==='deepseek'?'v1/chat/completions':'alpha/decisions'}`,{
      method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body,
      redirect:'error',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(`${model.slug} HTTP ${response.status}`);
    const raw=await response.json();
    assert.equal(raw.provider,model.provider,'Unexpected serving provider');
    assert.ok(raw.model===model.slug || (model.family==='jev'&&raw.model===model.slug+'-20261014'),'Unexpected model');
    assert.ok(Number.isFinite(raw.usage?.cost),'Missing charged cost');
    record.charged+=raw.usage.cost-model.reserve;
    let decision;
    if(model.family==='deepseek') {
      assert.equal(raw.choices?.[0]?.finish_reason,'stop');
      const answer=JSON.parse(raw.choices[0].message.content);
      assert.deepEqual(Object.keys(answer),['action']);
      assert.ok(input.state.legalActions.includes(answer.action),'Illegal action');
      decision={action:answer.action,source:'deepseek-choice',raw,usage:raw.usage};
    } else decision=parseClefResponse(raw,input.state.legalActions,model.family==='clef'?'clef':model.slug);
    const elapsedMs=Math.round(performance.now()-start);
    record.requests.push({modelId:model.id,game:input.state.game,tick:input.state.tick,
      model:raw.model,provider:raw.provider,action:decision.action,elapsedMs,cost:raw.usage.cost,
      inputTokens:raw.usage.input_tokens??raw.usage.prompt_tokens,
      inputSha256:crypto.createHash('sha256').update(body).digest('hex')});
    save();
    return {...decision,elapsedMs};
  }

  async function episode(stage,game,model) {
    process.env.GVGAI_SEED=String(game.seed);
    const runId=`${stage}-${game.gameId}-${game.levelId}-${game.seed}-${model.family}`;
    let processId,summary,started;
    const decisions=[];
    const requestStart=record.requests.length;
    try {
      await runEvalCase({...game,runId,modelId:model.id,strategy:''},{expectedSeed:game.seed,timeoutMs:240000,
        io:{emit:(event,data)=>{if(event==='run-summary')summary=data;}},
        onCaseStart:g=>{processId=g.processId;},
        createLLMClient() {
          const c=new LLMClient({runId,initialLevelId:game.levelId,maxActions:game.cap,
            maxProviderCalls:game.cap,clefControlTicks:6,stopAfterLevel:true});
          const recordStep=c.recordClefExecution.bind(c);
          c.recordClefExecution=(sso,action,source,tick)=>recordStep(sso,action,source.replace(/^clef-/,model.family+'-'),tick);
          c.requestLLMAction=async json=>{
            started??=Date.now();
            const sso=JSON.parse(json);
            // Identical state/criteria builder for all models, independent of transport.
            const input=buildClefInput(sso,c.promptConfig,c.stateTracker,null,'@cf/cloudflare/clef',6);
            const choice=await request(model,input);
            const maxTicks=input.state.control.maxTicksByAction[choice.action]||1;
            c.planStep=1;c.planLength=maxTicks;
            c.clefHold=maxTicks>1?{action:choice.action,remaining:maxTicks-1,decisionTick:sso.gameTick,
              previous:sso,revision:c.strategyRevision}:null;
            c.lastProvider='openrouter';c.lastModelUsed=choice.raw.model;
            c.recordActionDecision(choice.action,sso.gameTick,'',sso);
            decisions.push({tick:sso.gameTick,action:choice.action,maxTicks,input,response:choice.raw,
              elapsedMs:choice.elapsedMs,planningMillis:sso.planningMillis});
            return {action:choice.action,stale:false};
          };
          return c;
        }
      });
      assert.ok(summary);
      for(const step of summary.controlSteps) {
        const choice=decisions.find(d=>d.tick===step.decisionTick);
        assert.equal(choice.action,step.action);
        assert.ok(step.tick-step.decisionTick<choice.maxTicks);
      }
      const requests=record.requests.slice(requestStart);
      const latencies=requests.map(r=>r.elapsedMs).sort((a,b)=>a-b);
      const result={stage,modelId:model.id,...game,winner:summary.winner,score:summary.finalScore,
        ticks:summary.ticks,decisions:summary.decisions,executedTicks:summary.executedTicks,endedBy:summary.endedBy,
        valid:!['provider-error','usage-limit','invalid-state'].includes(summary.endedBy),
        capped:summary.endedBy==='decision-cap',durationMs:Date.now()-started,
        medianMs:latencies[Math.floor(latencies.length/2)]||0,p95Ms:latencies[Math.min(latencies.length-1,Math.floor(latencies.length*0.95))]||0,
        cost:requests.reduce((n,r)=>n+r.cost,0)};
      record.results.push(result);save();
      fs.writeFileSync(path.join(out,runId+'.json'),JSON.stringify({result,summary,decisions},null,2));
      console.log('BRACKET_GAME '+JSON.stringify(result));
      if(summary.endedBy==='usage-limit')throw new Error('Bracket budget exhausted; retain incomplete result');
    } finally {if(processId)await manager.stopGameAndWait(processId);}
  }

  for(let i=0;i<qualifiers.length;i++) {
    for(let j=0;j<ROSTER.length;j++)await episode(challenge?'challenge':'qualifier',qualifiers[i],ROSTER[(i+j)%ROSTER.length]);
  }
  record.qualifierStandings=standings(record.results,ROSTER);
  if(challenge) {
    record.complete=true;record.finishedAt=new Date().toISOString();save();
    console.log('CHALLENGE_COMPLETE '+JSON.stringify({charged:record.charged,standings:record.qualifierStandings}));
    return;
  }
  const eligible=record.qualifierStandings.filter(r=>r.valid);
  if(eligible.length<2)throw new Error('Fewer than two valid finalists');
  const cutoff=eligible[1];
  const finalistIds=eligible.filter(r=>r.points>cutoff.points||(r.points===cutoff.points&&r.wins>=cutoff.wins)).map(r=>r.modelId);
  record.finalists=finalistIds;save();
  console.log('FINALISTS '+JSON.stringify(record.qualifierStandings));
  const finalists=ROSTER.filter(m=>finalistIds.includes(m.id));
  for(let i=0;i<FINALS.length;i++) {
    for(let j=0;j<finalists.length;j++)await episode('final',FINALS[i],finalists[(i+j)%finalists.length]);
  }
  record.finalStandings=standings(record.results.filter(r=>r.stage==='final'),finalists);
  const top=record.finalStandings[0];
  record.champions=record.finalStandings.filter(r=>r.valid&&r.points===top.points&&r.wins===top.wins).map(r=>r.modelId);
  record.complete=true;record.finishedAt=new Date().toISOString();save();
  console.log('BRACKET_COMPLETE '+JSON.stringify({charged:record.charged,standings:record.finalStandings,champions:record.champions}));
}

module.exports={compare,standings,ROSTER,QUALIFIERS,FINALS,CHALLENGES};
if(require.main===module)main().catch(e=>{console.error('BRACKET_ERROR '+e.message);process.exitCode=1;});
