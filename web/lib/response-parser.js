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

// Canonical ACTION_* pattern — unambiguous, always safe to match anywhere
const CANONICAL_RE = /\bACTION_(UP|DOWN|LEFT|RIGHT|USE|NIL|ESCAPE)\b/g;

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

function parseAction(llmResponse, availableActions = VALID_ACTIONS) {
  if (!llmResponse) {
    return 'ACTION_NIL';
  }

  const text = llmResponse.trim().toUpperCase();

  // 1. Exact match — response is literally just an action name
  const exactTrimmed = text.replace(/[^A-Z_]/g, '');
  if (availableActions.includes(exactTrimmed)) {
    return exactTrimmed;
  }

  // 2. Canonical ACTION_* — unambiguous, pick the LAST one (conclusion)
  let lastCanonical = null;
  let m;
  while ((m = CANONICAL_RE.exec(text)) !== null) {
    const action = 'ACTION_' + m[1];
    if (availableActions.includes(action)) {
      lastCanonical = action;
    }
  }
  CANONICAL_RE.lastIndex = 0; // reset for next call
  if (lastCanonical) return lastCanonical;

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
  if (bestAction) return bestAction;

  // Fallback
  console.warn('[ResponseParser] Could not parse action from:', llmResponse);
  return 'ACTION_NIL';
}

// Parse a structured "REASON: ... / ACTION: ..." response into { action, reason }.
// Used when narration is on. The action is extracted ONLY from the text after the
// last ACTION: marker, so prose direction words ("the LEFT enemy is closer, go RIGHT")
// can no longer hijack the bare-word tier.
function parseStructured(llmResponse, availableActions = VALID_ACTIONS) {
  if (!llmResponse) {
    return { action: 'ACTION_NIL', reason: '' };
  }

  // Rationale: one sentence after REASON:, up to the next line or ACTION:
  let reason = '';
  const reasonMatch = llmResponse.match(/REASON:\s*(.+?)(?:\n|ACTION:|$)/is);
  if (reasonMatch) {
    reason = reasonMatch[1].trim().replace(/\s+/g, ' ').slice(0, 200);
  }

  // Action: prefer the slice after the LAST ACTION: marker
  const upper = llmResponse.toUpperCase();
  const actionIdx = upper.lastIndexOf('ACTION:');
  const actionSlice = actionIdx !== -1
    ? llmResponse.slice(actionIdx + 'ACTION:'.length)
    : llmResponse;
  const action = parseAction(actionSlice, availableActions);

  // Graceful reason fallback: first non-empty line that isn't an action token
  if (!reason) {
    const lines = llmResponse.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^ACTION[:_]/i.test(line)) continue;
      const stripped = line.replace(/[^A-Za-z_]/g, '').toUpperCase();
      if (availableActions.includes(stripped)) continue;
      reason = line.slice(0, 200);
      break;
    }
  }

  return { action, reason };
}

module.exports = {
  parseAction,
  parseStructured,
  VALID_ACTIONS
};
