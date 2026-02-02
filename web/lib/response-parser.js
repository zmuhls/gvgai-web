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

function parseAction(llmResponse, availableActions = VALID_ACTIONS) {
  if (!llmResponse) {
    return 'ACTION_NIL';
  }

  const text = llmResponse.toUpperCase();

  // Try to find action keyword in response
  for (const action of availableActions) {
    if (text.includes(action)) {
      return action;
    }
  }

  // Try to parse from structured response (e.g., "Action: ACTION_UP")
  const match = text.match(/ACTION:\s*(ACTION_\w+)/);
  if (match && availableActions.includes(match[1])) {
    return match[1];
  }

  // Fallback to ACTION_NIL
  console.warn('[ResponseParser] Could not parse action from:', llmResponse);
  return 'ACTION_NIL';
}

module.exports = {
  parseAction,
  VALID_ACTIONS
};
