#!/usr/bin/env node
'use strict';

// Converts stored play traces into a fine-tuning JSONL (chat-messages format,
// one {"messages":[system?, user, assistant]} object per line) by replaying
// buildPrompt() over the SSO captured on each actionHistory entry.
//
// Replay mirrors the live LLM loop ordering: recordTick(sso) BEFORE
// buildPrompt, recordAction after the decision (llm-client.js recordActState →
// requestLLMAction → recordActionDecision).
//
// Caveat: buildPrompt's PLAY HISTORY layer reads the live trace store, so
// prompts are reconstructed as-of-now, not as-of-play. That matches what the
// tuned model sees at inference time, which is the distribution we train for.

const fs = require('fs');
const path = require('path');
const { buildPrompt, GameStateTracker } = require('../lib/state-converter');
const promptStore = require('../lib/prompt-store');
const traceStore = require('../lib/play-trace-store');

const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'data', 'finetune');

class PrepareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrepareError';
    this.code = code;
  }
}

// Replay one trace into training pairs. promptConfig should already have
// codeProtocol disabled (targets must stay canonical ACTION_* words).
function pairsFromTrace(trace, promptConfig, options = {}) {
  const deduplicate = options.deduplicate !== false;
  const pairs = [];
  const tracker = new GameStateTracker();
  let lastKey = null;

  for (const entry of trace.actionHistory || []) {
    if (!entry.sso || typeof entry.sso !== 'object') continue;

    tracker.recordTick(entry.sso);
    const { systemMessage, userMessage } = buildPrompt(entry.sso, promptConfig, tracker, null);
    const action = entry.action || 'ACTION_NIL';

    const key = `${userMessage}::${action}`;
    if (!deduplicate || key !== lastKey) {
      const messages = [];
      if (systemMessage) messages.push({ role: 'system', content: systemMessage });
      messages.push({ role: 'user', content: userMessage });
      messages.push({ role: 'assistant', content: action });
      pairs.push({ messages, action });
      lastKey = key;
    }

    tracker.recordAction(action, entry.sso.gameTick || 0);
  }

  return pairs;
}

// Human traces record every tick, so ACTION_NIL dominates raw pairs. Cap NIL
// at maxNilRatio of the final set with a deterministic stride (no randomness).
function downsampleNil(pairs, maxNilRatio) {
  if (!(maxNilRatio > 0) || maxNilRatio >= 1) return pairs;
  const nonNil = pairs.filter(p => p.action !== 'ACTION_NIL').length;
  const nilCount = pairs.length - nonNil;
  if (nonNil === 0) return pairs; // all-NIL trace set: nothing sensible to keep instead
  const maxNil = Math.floor((maxNilRatio * nonNil) / (1 - maxNilRatio));
  if (nilCount <= maxNil) return pairs;
  if (maxNil === 0) return pairs.filter(p => p.action !== 'ACTION_NIL');
  const stride = Math.ceil(nilCount / maxNil);
  let nilIdx = 0;
  return pairs.filter(p => (p.action !== 'ACTION_NIL' ? true : nilIdx++ % stride === 0));
}

function prepareFinetuneData(options = {}) {
  const gameId = options.gameId;
  if (!Number.isInteger(gameId)) {
    throw new PrepareError('INVALID_GAME', `gameId must be an integer, got ${gameId}`);
  }
  const playerType = options.playerType === 'all' ? null : (options.playerType || 'human');
  const minExamples = options.minExamples ?? 20;
  const maxNilRatio = options.maxNilRatio ?? 0.3;

  const summaries = traceStore.getTracesForGame(gameId, playerType ? { playerType } : {});
  if (summaries.length === 0) {
    throw new PrepareError('NO_TRACES', `no ${playerType || ''} traces stored for game ${gameId}`.replace('  ', ' '));
  }

  const fullTraces = summaries
    .map(s => traceStore.getTrace(gameId, s.traceId))
    .filter(Boolean);
  const usable = fullTraces.filter(t =>
    (t.actionHistory || []).some(e => e.sso && typeof e.sso === 'object'));
  if (usable.length === 0) {
    throw new PrepareError('NO_SSO',
      `${fullTraces.length} trace(s) found for game ${gameId} but none carry per-tick SSO (recorded before SSO capture shipped?)`);
  }

  let pairs = [];
  let gameName = null;
  for (const trace of usable) {
    const resolved = promptStore.resolveGamePromptConfig(gameId, trace.levelId || 0, {});
    const promptConfig = { ...resolved, codeProtocol: null };
    gameName = gameName || promptConfig.gameName || trace.gameName || null;
    pairs = pairs.concat(pairsFromTrace(trace, promptConfig, options));
  }

  const rawExampleCount = pairs.length;
  pairs = downsampleNil(pairs, maxNilRatio);

  if (pairs.length < minExamples) {
    throw new PrepareError('TOO_FEW_EXAMPLES',
      `only ${pairs.length} training examples from ${usable.length} trace(s); need at least ${minExamples} — play more rounds`);
  }

  const actionDistribution = {};
  for (const p of pairs) {
    actionDistribution[p.action] = (actionDistribution[p.action] || 0) + 1;
  }

  let jsonlPath = null;
  if (options.write !== false) {
    jsonlPath = options.output ||
      path.join(options.outDir || DEFAULT_OUT_DIR, `game-${gameId}-train.jsonl`);
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    const lines = pairs.map(p => JSON.stringify({ messages: p.messages }));
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n');
  }

  return {
    jsonlPath,
    exampleCount: pairs.length,
    rawExampleCount,
    traceCount: usable.length,
    skippedTraces: fullTraces.length - usable.length,
    actionDistribution,
    gameName
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([a-z-]+)=(.*)$/i);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const gameId = Number.parseInt(args.gameId ?? args['game-id'], 10);
  if (!Number.isInteger(gameId)) {
    console.error('Usage: node prepare-finetune-data.js --gameId=0 [--player-type=human|llm|all] [--output=path] [--min-examples=20] [--max-nil-ratio=0.3]');
    process.exit(1);
  }
  try {
    const stats = prepareFinetuneData({
      gameId,
      playerType: args['player-type'],
      output: args.output,
      minExamples: args['min-examples'] ? Number.parseInt(args['min-examples'], 10) : undefined,
      maxNilRatio: args['max-nil-ratio'] ? Number.parseFloat(args['max-nil-ratio']) : undefined
    });
    console.log(JSON.stringify(stats, null, 2));
  } catch (err) {
    if (err instanceof PrepareError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(2);
    }
    throw err;
  }
}

if (require.main === module) main();

module.exports = { prepareFinetuneData, pairsFromTrace, downsampleNil, PrepareError };
