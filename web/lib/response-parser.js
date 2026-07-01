// Parse LLM response to extract valid GVGAI action

const VALID_ACTIONS = [
  'ACTION_NIL',
  'ACTION_UP',
  'ACTION_DOWN',
  'ACTION_LEFT',
  'ACTION_RIGHT',
  'ACTION_USE',
  'ACTION_ESCAPE'
];

// Canonical ACTION_* pattern — unambiguous, always safe to match anywhere.
// ACTION_SHOOT is not a GVGAI action, but models often produce it for games
// whose prompt aliases ACTION_USE as SHOOT.
const CANONICAL_RE = /\bACTION_(UP|DOWN|LEFT|RIGHT|USE|SHOOT|NIL|ESCAPE)\b/g;

// Bare directional / synonym words — ambiguous ("the right move"), so we
// prefer the LAST occurrence (LLMs state their conclusion at the end).
const BARE_WORDS = [
  { pattern: /\bUP\b/g, action: 'ACTION_UP' },
  { pattern: /\bDOWN\b/g, action: 'ACTION_DOWN' },
  { pattern: /\bLEFT\b/g, action: 'ACTION_LEFT' },
  { pattern: /\bRIGHT\b/g, action: 'ACTION_RIGHT' },
  { pattern: /\b(?:USE|SHOOT|FIRE|SPACE)\b/g, action: 'ACTION_USE' },
  { pattern: /\b(?:NIL|NONE|WAIT|STAY|IDLE)\b/g, action: 'ACTION_NIL' },
];

function parseActionDetailed(llmResponse, availableActions = VALID_ACTIONS, actionCodeMap = null) {
  if (!llmResponse) {
    return { action: 'ACTION_NIL', matched: false, source: 'empty' };
  }

  const text = llmResponse.trim().toUpperCase();

  // 0. Compact code protocol. Only exact short-code replies count here.
  // A bare "U" can mean ACTION_USE in GV1, but "Use the right lane" should
  // still fall through to normal prose parsing.
  if (actionCodeMap) {
    const exactCode = text.replace(/^[`'"]+|[`'".,;:]+$/g, '');
    const mapped = actionCodeMap[exactCode];
    if (mapped && availableActions.includes(mapped)) {
      return { action: mapped, matched: true, source: 'compact-exact' };
    }

    const codedMatch = text.match(/\b(?:OUT|ACT|MOVE|ANS|B)\s*:\s*([A-Z0-9])\b/);
    if (codedMatch) {
      const coded = actionCodeMap[codedMatch[1]];
      if (coded && availableActions.includes(coded)) {
        return { action: coded, matched: true, source: 'compact-field' };
      }
    }
  }

  // 1. Exact match — response is literally just an action name
  const exactTrimmed = text.replace(/[^A-Z_]/g, '');
  if (availableActions.includes(exactTrimmed)) {
    return { action: exactTrimmed, matched: true, source: 'exact-action' };
  }

  // 2. Canonical ACTION_* — unambiguous, pick the LAST one (conclusion)
  let lastCanonical = null;
  let m;
  while ((m = CANONICAL_RE.exec(text)) !== null) {
    const action = m[1] === 'SHOOT' ? 'ACTION_USE' : 'ACTION_' + m[1];
    if (availableActions.includes(action)) {
      lastCanonical = action;
    }
  }
  CANONICAL_RE.lastIndex = 0; // reset for next call
  if (lastCanonical) {
    return { action: lastCanonical, matched: true, source: 'canonical-action' };
  }

  // 3. Bare words — find the LAST match across all patterns, pick the one
  //    with the highest index (closest to end of response)
  let bestAction = null;
  let bestIdx = -1;
  for (const { pattern, action } of BARE_WORDS) {
    if (!availableActions.includes(action)) continue;
    let bm;
    while ((bm = pattern.exec(text)) !== null) {
      if (bm.index > bestIdx) {
        bestIdx = bm.index;
        bestAction = action;
      }
    }
    pattern.lastIndex = 0; // reset for next call
  }
  if (bestAction) {
    return { action: bestAction, matched: true, source: 'bare-word' };
  }

  // Fallback
  console.warn('[ResponseParser] Could not parse action from:', llmResponse);
  return { action: 'ACTION_NIL', matched: false, source: 'fallback' };
}

function parseAction(llmResponse, availableActions = VALID_ACTIONS, actionCodeMap = null) {
  return parseActionDetailed(llmResponse, availableActions, actionCodeMap).action;
}

// Parse a structured "REASON: ... / ACTION: ..." (or "PLAN: ...") response into
// { action, reason, plan }. Used when narration is on. The action is extracted ONLY
// from the text after the last ACTION:/PLAN: marker, so prose direction words
// ("the LEFT enemy is closer, go RIGHT") can no longer hijack the bare-word tier.
// A PLAN: line yields a multi-step plan (front-first, so a truncated plan is still
// a valid prefix); plan[0] === action always.
function parseStructured(llmResponse, availableActions = VALID_ACTIONS, actionCodeMap = null, options = {}) {
  const maxPlanSteps = options.maxPlanSteps || 6;

  if (!llmResponse) {
    return { action: 'ACTION_NIL', reason: '', plan: ['ACTION_NIL'], valid: false, source: 'empty', planSource: 'single-action' };
  }

  // Rationale: one sentence after REASON:, up to the next line or ACTION:/PLAN:
  let reason = '';
  const reasonMatch = llmResponse.match(/REASON:\s*(.+?)(?:\n|ACTION:|PLAN:|$)/is);
  if (reasonMatch) {
    reason = reasonMatch[1].trim().replace(/\s+/g, ' ').slice(0, 200);
  }

  const upper = llmResponse.toUpperCase();
  const actionIdx = upper.lastIndexOf('ACTION:');

  // Plan: the slice after the LAST PLAN: marker (when it's the model's conclusion,
  // i.e. after any ACTION: marker), taken up to end-of-line only — plans are one
  // line, and stopping there keeps trailing prose out of the token scan.
  const planIdx = upper.lastIndexOf('PLAN:');
  if (planIdx !== -1 && planIdx > actionIdx) {
    const planLine = llmResponse.slice(planIdx + 'PLAN:'.length).split('\n')[0];
    const tokens = planLine.split(/[,;→>]+|\bTHEN\b/i).map(t => t.trim()).filter(Boolean);
    const plan = [];
    for (const token of tokens) {
      if (plan.length >= maxPlanSteps) break;
      const meta = parseActionDetailed(token, availableActions, actionCodeMap);
      if (meta.matched) plan.push(meta.action);
    }
    if (plan.length > 0) {
      return { action: plan[0], reason, plan, valid: true, source: 'plan-line', planSource: 'plan-line' };
    }
  }

  // Action: prefer the slice after the LAST ACTION: marker
  const actionSlice = actionIdx !== -1
    ? llmResponse.slice(actionIdx + 'ACTION:'.length)
    : llmResponse;
  const actionMeta = parseActionDetailed(actionSlice, availableActions, actionCodeMap);
  const action = actionMeta.action;

  // Graceful reason fallback: first non-empty line that isn't an action token
  if (!reason) {
    const lines = llmResponse.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^(?:ACTION[:_]|PLAN:)/i.test(line)) continue;
      if (parseAction(line, availableActions, actionCodeMap) !== 'ACTION_NIL' || (actionCodeMap && actionCodeMap[line.trim().toUpperCase()] === 'ACTION_NIL')) continue;
      const stripped = line.replace(/[^A-Za-z_]/g, '').toUpperCase();
      if (availableActions.includes(stripped)) continue;
      reason = line.slice(0, 200);
      break;
    }
  }

  return {
    action,
    reason,
    plan: [action],
    valid: actionMeta.matched,
    source: actionMeta.source,
    planSource: 'single-action'
  };
}

module.exports = {
  parseAction,
  parseActionDetailed,
  parseStructured,
  VALID_ACTIONS
};
