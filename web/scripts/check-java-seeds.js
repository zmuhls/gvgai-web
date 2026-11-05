#!/usr/bin/env node
// Real Java socket regression with scripted legal moves; makes no provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'gvgai-seeds-'));
  const server = net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.env.GVGAI_SOCKET_PORT = String(server.address().port);
  await new Promise(resolve=>server.close(resolve));
  process.env.GVGAI_SCREENSHOT_PATH = path.join(directory,'frame.png');
  process.env.GVGAI_TRACE_DIR = path.join(directory,'traces');
  process.env.TELEMETRY_ENABLED = 'false';
  const telemetry = require('../lib/telemetry-store');
  telemetry.configure({enabled:false,useEnv:false,flushMs:0});
  const {runEvalCase} = require('../lib/batch-evaluator');
  const LLMClient = require('../lib/llm-client');
  const gameManager = require('../lib/game-manager');
  const trajectories = [];
  for (const [index,seed] of [7,7,2026].entries()) {
    process.env.GVGAI_SEED = String(seed);
    const observations = [];
    let processId;
    try {
      const result = await runEvalCase({runId:`seed-regression-${index}`,gameId:13,gameName:'butterflies',
        levelId:0,modelId:'@cf/cloudflare/clef',strategy:''},{
        expectedSeed:seed,timeoutMs:30000,onCaseStart:game=>{processId=game.processId;},
        createLLMClient() {
          const client = new LLMClient({maxActions:12,initialLevelId:0,stopAfterLevel:true});
          client.callProvider = async (_provider,_model,_messages,_settings,input) => {
            observations.push(input.state.context);
            const action = input.state.legalActions.includes('ACTION_LEFT') ? 'ACTION_LEFT' : input.state.legalActions[0];
            return {action,source:'scripted-seed-regression',confidence:1,probabilities:{[action]:1},
              raw:{scripted:true},reason:''};
          };
          return client;
        }
      });
      assert.equal(result.engineSeed,seed);
      assert.equal(observations.length,12);
      trajectories.push(observations);
    } finally {
      if (processId) await gameManager.stopGameAndWait(processId);
    }
  }
  assert.deepEqual(trajectories[0],trajectories[1],'same seed must reproduce the stochastic game');
  assert.notDeepEqual(trajectories[0],trajectories[2],'different seeds must change the stochastic game');
  console.log('PASS: first-level Java seeds are verified; seed 7 repeats exactly and seed 2026 produces a different trajectory; no model calls');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
