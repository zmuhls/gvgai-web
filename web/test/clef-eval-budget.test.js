const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {ClefBudget, superviseBudget, MAX_INPUT_TOKENS} = require('../scripts/clef-eval-budget');

test('concurrent reservations cannot exceed the shared spending allowance', () => {
  const budget = new ClefBudget(2 * MAX_INPUT_TOKENS * 0.24 / 1000000 + 0.000001);
  budget.reserve('a'); budget.reserve('b');
  assert.throws(()=>budget.reserve('c'),/exhausted/);
  assert.throws(()=>budget.reserve('a'),/already reserved/);
  budget.settle('a',1000);
  assert.throws(()=>budget.reserve('c'),/exhausted/);
  budget.settle('b',1000); budget.reserve('c');
  assert.equal(budget.snapshot().reportedTokens,2000);
  assert.equal(budget.snapshot().reservedTokens,MAX_INPUT_TOKENS);
  assert.ok(budget.snapshot().conservativeUsd <= 0.031459);
});

test('missing or invalid usage conservatively consumes the full reservation', () => {
  const budget = new ClefBudget(1);
  for (const usage of [undefined, null, -1, NaN, MAX_INPUT_TOKENS+1, '12']) {
    budget.reserve('request'); budget.settle('request',usage);
  }
  assert.equal(budget.snapshot().chargedTokens,6*MAX_INPUT_TOKENS);
  assert.equal(budget.snapshot().unknownRequests,6);
  assert.equal(budget.snapshot().reportedTokens,0);
  assert.throws(()=>budget.settle('request',12),/No request/);
});

test('supervised child refuses the next request before spending beyond its budget', async () => {
  const modulePath = require.resolve('../scripts/clef-eval-budget');
  const source = `const {budgetMessage} = require(${JSON.stringify(modulePath)});
    (async () => {
      let requests = 0;
      try {
        for (let i=0;i<3;i++) {
          await budgetMessage('clef-budget:reserve'); requests++;
          await budgetMessage('clef-budget:settle',60000);
        }
      } catch (error) { console.log(JSON.stringify({requests,error:error.message})); }
      finally { process.disconnect(); }
    })();`;
  const budget = new ClefBudget(0.02);
  const child = spawn(process.execPath,['-e',source],{
    stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,CLEF_EVAL_BUDGET_IPC:'1'}
  });
  let output = '';
  child.stdout.on('data',chunk=>{ output += chunk; });
  superviseBudget(child,budget,()=>{});
  const code = await new Promise((resolve,reject)=>{ child.once('error',reject); child.once('exit',resolve); });
  assert.equal(code,0);
  assert.equal(JSON.parse(output).requests,1);
  assert.match(JSON.parse(output).error,/budget exhausted/);
  assert.equal(budget.snapshot().chargedTokens,60000);
  assert.equal(budget.snapshot().reservedTokens,0);
});

test('a child exiting mid-request cannot refund unknown spending', async () => {
  const modulePath = require.resolve('../scripts/clef-eval-budget');
  const child = spawn(process.execPath,['-e',
    `require(${JSON.stringify(modulePath)}).budgetMessage('clef-budget:reserve').then(()=>process.exit(0));`],
  {stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,CLEF_EVAL_BUDGET_IPC:'1'}});
  const budget = new ClefBudget(0.02);
  superviseBudget(child,budget,()=>{});
  await new Promise((resolve,reject)=>{ child.once('error',reject); child.once('exit',resolve); });
  assert.equal(budget.snapshot().chargedTokens,MAX_INPUT_TOKENS);
  assert.equal(budget.snapshot().unknownRequests,1);
  assert.equal(budget.snapshot().reservedTokens,0);
});
