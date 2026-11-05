const test = require('node:test');
const assert = require('node:assert/strict');
const {buildCases, classify, remainingCases} = require('../scripts/run-clef-matrix');

test('matrix covers every Sokoban level on three seeds plus ten other games', () => {
  const cases = buildCases();
  assert.equal(cases.length,55);
  assert.equal(new Set(cases.map(c=>JSON.stringify(c))).size,55);
  assert.equal(new Set(cases.map(c=>c.gameId)).size,11);
  for (let level=0;level<5;level++) assert.equal(cases.filter(c=>c.gameId===87&&c.level===level).length,3);
});

test('matrix never counts caps, provider failures or fabricated actions as wins', () => {
  const ok = {apiErrors:0, actionIntegrity:true, controlDecisions:0, modelDecisions:8,
    result:{won:true,winner:'PLAYER_WINS'},endedBy:'game-over'};
  assert.equal(classify(ok),'win');
  assert.equal(classify({...ok,endedBy:'decision-cap'}),'capped');
  assert.equal(classify({...ok,apiErrors:1}),'error');
  assert.equal(classify({...ok,actionIntegrity:false}),'error');
  assert.equal(classify({...ok,controlDecisions:1}),'error');
  assert.equal(classify({...ok,modelDecisions:0}),'error');
  assert.equal(classify({...ok,result:{won:false,winner:'PLAYER_LOSES'}}),'loss');
});

test('resume preserves completed outcomes and only reruns errors or unstarted cases', () => {
  const cases = buildCases().slice(0,5);
  const results = ['win','loss','capped','error'].map((outcome,i)=>({...cases[i],outcome}));
  assert.deepEqual(remainingCases({model:'@cf/cloudflare/clef',cases,results}),cases.slice(3));
  assert.throws(()=>remainingCases({model:'@cf/cloudflare/clef',cases:[{gameId:999,level:0,seed:7}],results:[]}),/unknown case/);
});
