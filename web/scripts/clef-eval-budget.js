// CLEF pricing verified 2026-11-04: $0.24/M input tokens, no output charge,
// maximum context 65,536 tokens. Reserve a full context before every request.
// https://developers.cloudflare.com/workers-ai/models/clef/
const MAX_INPUT_TOKENS = 65536;
const USD_PER_MILLION = 0.24;

class ClefBudget {
  constructor(usd) {
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('Budget must be a positive USD amount');
    this.limitTokens = Math.floor(usd * 1000000 / USD_PER_MILLION);
    this.chargedTokens = 0;
    this.reportedTokens = 0;
    this.unknownRequests = 0;
    this.reservations = new Set();
  }

  reserve(key) {
    if (this.reservations.has(key)) throw new Error('A request is already reserved');
    if (this.chargedTokens + (this.reservations.size + 1) * MAX_INPUT_TOKENS > this.limitTokens) {
      throw new Error('CLEF test budget exhausted; no request was sent');
    }
    this.reservations.add(key);
  }

  settle(key, inputTokens) {
    if (!this.reservations.delete(key)) throw new Error('No request reservation to settle');
    // Fail closed when a response or its usage is missing (including child exit).
    const known = Number.isSafeInteger(inputTokens) && inputTokens >= 0 && inputTokens <= MAX_INPUT_TOKENS;
    this.chargedTokens += known ? inputTokens : MAX_INPUT_TOKENS;
    if (known) this.reportedTokens += inputTokens;
    else this.unknownRequests += 1;
  }

  snapshot() {
    const reservedTokens = this.reservations.size * MAX_INPUT_TOKENS;
    return {limitTokens:this.limitTokens, chargedTokens:this.chargedTokens,
      reportedTokens:this.reportedTokens, unknownRequests:this.unknownRequests, reservedTokens,
      maxRequestTokens:MAX_INPUT_TOKENS, usdPerMillionInputTokens:USD_PER_MILLION,
      conservativeUsd:(this.chargedTokens + reservedTokens) * USD_PER_MILLION / 1000000};
  }
}

function superviseBudget(child, budget, persist) {
  child.on('message', message => {
    if (!message || !['clef-budget:reserve','clef-budget:settle'].includes(message.type)) return;
    let error;
    try {
      if (message.type === 'clef-budget:reserve') budget.reserve(child);
      else budget.settle(child, message.inputTokens);
      persist(); // Record the reservation before permitting an external request.
    } catch (failure) { error = failure.message; }
    if (child.connected) child.send({type:'clef-budget:reply',id:message.id,error}, () => {});
  });
  child.once('exit', () => {
    if (budget.reservations.has(child)) budget.settle(child);
    persist();
  });
}

let sequence = 0;
async function budgetMessage(type, inputTokens) {
  if (process.env.CLEF_EVAL_BUDGET_IPC !== '1') return;
  if (!process.connected || !process.send) throw new Error('CLEF test budget supervisor is disconnected');
  const id = ++sequence;
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      error ? reject(new Error(error)) : resolve();
    };
    const onMessage = message => {
      if (message?.type === 'clef-budget:reply' && message.id === id) finish(message.error);
    };
    const onDisconnect = () => finish('CLEF test budget supervisor is disconnected');
    const timer = setTimeout(() => finish('CLEF test budget supervisor timed out'), 5000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({type,id,inputTokens}, error => { if (error) finish(error.message); });
  });
}

module.exports = {ClefBudget, superviseBudget, budgetMessage, MAX_INPUT_TOKENS};
