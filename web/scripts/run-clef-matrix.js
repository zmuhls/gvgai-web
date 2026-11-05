#!/usr/bin/env node
// A fixed, reproducible expansion suite. Each case has its own Java socket,
// screenshot, usage counter and immutable receipt. No production state is read.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const {ClefBudget, superviseBudget} = require('./clef-eval-budget');

function buildCases() {
  const cases = [];
  for (const level of [0, 1, 2, 3, 4]) for (const seed of [7, 42, 2026]) {
    cases.push({gameId:87, level, seed});
  }
  for (const gameId of [0, 13, 15, 18, 26, 44, 50, 58, 66, 108]) {
    for (const level of [0, 4]) for (const seed of [7, 2026]) cases.push({gameId, level, seed});
  }
  return cases;
}

function classify(receipt) {
  if (!receipt || receipt.apiErrors || receipt.result?.error || !receipt.actionIntegrity ||
      receipt.controlDecisions || !receipt.modelDecisions) return 'error';
  if (receipt.result.won && receipt.endedBy === 'game-over') return 'win';
  if (receipt.endedBy === 'decision-cap') return 'capped';
  return receipt.result.winner === 'PLAYER_LOSES' ? 'loss' : 'unfinished';
}

function remainingCases(previous) {
  const canonical = new Map(buildCases().map(c=>[JSON.stringify(c),c]));
  if (!Array.isArray(previous.cases) || !Array.isArray(previous.results) ||
      previous.model !== '@cf/cloudflare/clef') throw new Error('Invalid prior matrix receipt');
  return previous.cases.filter(c => {
    if (!canonical.has(JSON.stringify(c))) throw new Error('Prior matrix contains an unknown case');
    const result = previous.results.find(r=>r.gameId===c.gameId&&r.level===c.level&&r.seed===c.seed);
    return !result || result.outcome === 'error';
  });
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const concurrency = Number(option('--concurrency', 3));
  const maxActions = Number(option('--max-actions', 300));
  const budget = new ClefBudget(Number(option('--budget-usd', 5)));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3 ||
      !Number.isInteger(maxActions) || maxActions < 1 || maxActions > 300) {
    throw new Error('Use --concurrency 1..3 and --max-actions 1..300');
  }
  const output = path.resolve(option('--out', `output/clef-matrix-${Date.now()}`));
  if (fs.existsSync(output)) throw new Error('Choose a new output directory; receipts are immutable');
  fs.mkdirSync(output, {recursive:true});
  const resumeFrom = option('--resume-from', null);
  const previous = resumeFrom ? JSON.parse(fs.readFileSync(path.resolve(resumeFrom),'utf8')) : null;
  if (previous && previous.maxActions !== maxActions) throw new Error('Resume must keep the original action cap');
  const report = {specification:'clef-expansion-v1', startedAt:new Date().toISOString(),
    revision:execFileSync('git', ['rev-parse','HEAD'], {encoding:'utf8'}).trim(),
    model:'@cf/cloudflare/clef', provider:process.env.CLEF_PROVIDER || 'cloudflare', maxActions, concurrency, resumeFrom,
    cases:previous?remainingCases(previous):buildCases(), results:[]};
  const write = () => {
    report.budget = budget.snapshot();
    fs.writeFileSync(path.join(output,'summary.json'), JSON.stringify(report,null,2));
  };
  write();
  if (args.includes('--dry-run')) { console.log(JSON.stringify(report,null,2)); return; }
  let cursor = 0;
  async function worker() {
    while (!report.stopReason && cursor < report.cases.length) {
      const c = report.cases[cursor++];
      const name = `game${c.gameId}-level${c.level}-seed${c.seed}`;
      const caseDir = path.join(output,name), log = fs.openSync(path.join(output,name+'.log'),'wx');
      console.log(JSON.stringify({event:'started',...c}));
      let code;
      try {
        code = await new Promise((resolve,reject) => {
          const child = spawn(process.execPath, [path.join(__dirname,'run-clef-eval.js'),
            '--games',String(c.gameId),'--level',String(c.level),'--seed',String(c.seed),
            '--max-actions',String(maxActions),'--require-wins','0','--out',caseDir],
          {stdio:['ignore',log,log,'ipc'],env:{...process.env,CLEF_EVAL_BUDGET_IPC:'1'}});
          superviseBudget(child, budget, write);
          child.once('error',reject); child.once('exit',resolve);
        });
      } finally { fs.closeSync(log); }
      const summaryFile = path.join(caseDir,'summary.json');
      const receipt = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile,'utf8')).results[0] : null;
      const result = {...c, outcome:classify(receipt), exitCode:code, receipt:name+'/summary.json',
        score:receipt?.result?.finalScore, decisions:receipt?.modelDecisions, apiErrors:receipt?.apiErrors,
        inputTokens:receipt?.inputTokens, actionIntegrity:receipt?.actionIntegrity, endedBy:receipt?.endedBy,
        reportedCostUsd:receipt?.reportedCostUsd, servingProviders:receipt?.servingProviders,
        elapsedMs:receipt?.elapsedMs, latencyMs:receipt?.latencyMs};
      if (result.outcome === 'error') report.stopReason = `Case ${name} failed; stop scheduling requests and inspect its receipt before resuming.`;
      report.results.push(result); write(); console.log(JSON.stringify({event:'result',...result}));
    }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  report.finishedAt = new Date().toISOString();
  report.totals = report.results.reduce((totals,r) => {
    totals[r.outcome] = (totals[r.outcome] || 0) + 1;
    totals.decisions += r.decisions || 0; totals.inputTokens += r.inputTokens || 0;
    return totals;
  }, {decisions:0,inputTokens:0});
  report.integrationPassed = report.results.length === report.cases.length && !report.totals.error;
  report.unstartedCases = report.cases.slice(cursor);
  const sokobanCases = report.cases.filter(c=>c.gameId===87);
  report.sokobanPassed = sokobanCases.length ? report.results.filter(r=>r.gameId===87).length === sokobanCases.length &&
    report.results.filter(r=>r.gameId===87).every(r=>r.outcome==='win') : null;
  write(); console.log(JSON.stringify({event:'complete',...report.totals,
    integrationPassed:report.integrationPassed,sokobanPassed:report.sokobanPassed,output}));
  if (!report.integrationPassed || report.sokobanPassed === false) process.exitCode = 1;
}

if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {buildCases, classify, remainingCases};
