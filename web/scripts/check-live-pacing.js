#!/usr/bin/env node
// Real Java/socket timing with an explicitly scripted 800ms provider; no API calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'gvgai-pacing-'));
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.GVGAI_SOCKET_PORT=String(server.address().port);
  await new Promise(resolve=>server.close(resolve));
  process.env.GVGAI_SCREENSHOT_PATH=path.join(directory,'frame.png');
  process.env.GVGAI_TRACE_DIR=path.join(directory,'traces');
  process.env.GVGAI_SEED='7'; process.env.TELEMETRY_ENABLED='false';
  require('../lib/telemetry-store').configure({enabled:false,useEnv:false,flushMs:0});
  const {runEvalCase}=require('../lib/batch-evaluator');
  const LLMClient=require('../lib/llm-client');
  const manager=require('../lib/game-manager');
  const results=[];
  for(const [gameId,gameName] of [[68,'pacman'],[0,'aliens'],[13,'butterflies']]) {
    for(const controlTicks of [1,6]) {
      let processId,started,summary,lastObserved,pendingReplanTick;
      let replans=0,guards=0,calls=0;
      const events=[];
      try {
        await runEvalCase({runId:`pacing-${gameId}-${controlTicks}`,gameId,gameName,levelId:0,
          modelId:'@cf/cloudflare/clef',strategy:''},{
          expectedSeed:7,timeoutMs:90000,onCaseStart:g=>{processId=g.processId;},
          io:{emit:(event,data)=>{events.push({event,data});if(event==='run-summary')summary=data;}},
          createLLMClient() {
            const client=new LLMClient({maxActions:6,clefControlTicks:controlTicks,stopAfterLevel:true});
            const original=client.processMessage.bind(client);
            client.processMessage=async message=>{
              const payload=message.slice(message.indexOf('#')+1);
              if(payload.startsWith('{')) {
                const s=JSON.parse(payload);
                if(s.phase==='ACT') {
                  started??=Date.now();lastObserved=s;
                  if(s.planningMode==='JSON_PLANNING_GUARD')guards++;
                  if(pendingReplanTick!==undefined) {
                    assert.equal(s.gameTick,pendingReplanTick,'REPLAN must not advance the game');
                    assert.equal(s.planningMode,'JSON_PLANNING_LIVE');
                    pendingReplanTick=undefined;
                  }
                }
              }
              return original(message);
            };
            const send=client.sendMessageWithId.bind(client);
            client.sendMessageWithId=(id,message)=>{
              if(message.startsWith('REPLAN#')){pendingReplanTick=lastObserved.gameTick;replans++;}
              send(id,message);
            };
            client.callProvider=async(_p,_m,_messages,_settings,input)=>{
              calls++;
              await new Promise(resolve=>setTimeout(resolve,800));
              const legal=input.state.legalActions;
              const candidates=input.state.planning.candidates;
              const order=gameId===0?['ACTION_USE','ACTION_LEFT','ACTION_RIGHT']:['ACTION_LEFT','ACTION_UP','ACTION_RIGHT','ACTION_DOWN'];
              const here=input.state.spatial.avatarGridPosition;
              const action=order.find(a=>legal.includes(a)&&candidates[a].immediateLosses===0&&
                (a==='ACTION_USE'||candidates[a].immediate.position.some((v,i)=>v!==here[i])))||legal[0];
              return {action,source:'scripted-timing-check',confidence:1,probabilities:{[action]:1},
                raw:{scripted:true,delayMs:800},usage:{input_tokens:0},reason:'Scripted timing check; not a CLEF result'};
            };
            return client;
          }
        });
        const durationMs=Date.now()-started;
        assert.equal(calls,summary.decisions);
        assert.equal(summary.controlSteps.length,summary.executedTicks);
        assert.equal(new Set(summary.controlSteps.map(s=>s.tick)).size,summary.executedTicks);
        const choices=events.filter(e=>e.event==='llm-reasoning').map(e=>e.data);
        for(const step of summary.controlSteps) {
          const choice=choices.find(d=>d.gameState.tick===step.decisionTick);
          assert.equal(step.action,choice.action,'Hold must never change the selected key');
          assert.ok(step.tick-step.decisionTick<choice.decision.control.maxTicks,'Hold exceeded its declared bound');
        }
        results.push({gameId,gameName,controlTicks,calls,engineTicks:summary.executedTicks,durationMs,
          ticksPerSecond:summary.executedTicks/(durationMs/1000),guards,replans});
        console.log('PACING '+JSON.stringify(results.at(-1)));
      } finally {
        if(processId)await manager.stopGameAndWait(processId);
      }
    }
  }
  for(const game of [68,0,13]) {
    const [before,after]=results.filter(r=>r.gameId===game);
    assert.ok(after.guards>0,'Live mode must exercise guard observations');
    assert.ok(after.engineTicks>before.engineTicks,'Holds must advance more ticks per provider request');
    assert.ok(after.ticksPerSecond>before.ticksPerSecond,'Live pacing must improve measured throughput');
  }
  assert.ok(results.some(r=>r.replans>0),'Exercise replan without advancing a tick');
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({scripted:true,providerDelayMs:800,results},null,2));
  console.log('PASS: live Java pacing, bounded holds and same-tick replanning; no model requests');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
