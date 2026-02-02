// Convert GVGAI SerializableStateObservation to LLM prompt

function buildDescriptivePrompt(sso) {
  // Concise but informative prompt for fast LLM response
  const actions = sso.availableActions || ['ACTION_NIL'];

  return `You are playing a 2D game. Make decisions to survive and win.
Score: ${sso.gameScore || 0} | Health: ${sso.avatarHealthPoints || 100} | Tick: ${sso.gameTick || 0}

Available actions: ${actions.join(', ')}

Choose ONE action. Respond with ONLY the action name (e.g., ACTION_UP).`;
}

function buildMinimalPrompt(sso) {
  return `Game State:
Score: ${sso.gameScore || 0}
Position: (${sso.avatarPosition ? sso.avatarPosition[0] : 0}, ${sso.avatarPosition ? sso.avatarPosition[1] : 0})
HP: ${sso.avatarHealthPoints || 0}

Actions: ${sso.availableActions ? sso.availableActions.join(', ') : 'ACTION_NIL'}
Choose one action:`;
}

// Resolve {{variable}} placeholders in template content
function resolveTemplate(templateContent, sso, extraVars) {
  if (!templateContent) return null;
  const vars = {
    gameName: extraVars?.gameName || 'unknown',
    gameScore: sso.gameScore || 0,
    avatarHealthPoints: sso.avatarHealthPoints || 0,
    gameTick: sso.gameTick || 0,
    availableActions: (sso.availableActions || ['ACTION_NIL']).join(', '),
    avatarPosition: sso.avatarPosition
      ? `(${sso.avatarPosition[0]}, ${sso.avatarPosition[1]})`
      : '(0, 0)'
  };
  return templateContent.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

// Build layered prompt from prompt config (dashboard-configured)
// Returns { systemMessage, userMessage } for multi-message API call
function buildPrompt(sso, promptConfig) {
  if (!promptConfig) {
    // Fallback to legacy single-message prompt
    return { systemMessage: null, userMessage: buildDescriptivePrompt(sso) };
  }

  const extraVars = { gameName: promptConfig.gameName };

  // Layer 1: System prompt
  const systemMessage = resolveTemplate(promptConfig.systemContent, sso, extraVars);

  // Layer 2: Game context
  const gameContext = resolveTemplate(promptConfig.gameContent, sso, extraVars);

  // Layer 3: Progression/level context
  const levelContext = resolveTemplate(promptConfig.levelContent, sso, extraVars);

  // Layer 4: Per-tick state (always auto-generated)
  const actions = sso.availableActions || ['ACTION_NIL'];
  const tickState = `Current State — Score: ${sso.gameScore || 0} | Health: ${sso.avatarHealthPoints || 100} | Tick: ${sso.gameTick || 0}
Available actions: ${actions.join(', ')}

Choose ONE action. Respond with ONLY the action name (e.g., ACTION_UP).`;

  // Combine layers 2-4 into user message
  const userMessage = [gameContext, levelContext, tickState]
    .filter(Boolean)
    .join('\n\n');

  return { systemMessage, userMessage };
}

module.exports = {
  buildDescriptivePrompt,
  buildMinimalPrompt,
  buildPrompt
};
