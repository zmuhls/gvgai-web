const { buildPrompt, extractSpatialContext } = require('./state-converter');
const { clefConnection } = require('./clef-connection');
const { limits: controlLimits } = require('./clef-control');

const MODEL_ID = '@cf/cloudflare/clef-flash';
const DEFAULT_MODEL_ID = '@cf/cloudflare/clef';
const JEV_MODEL_ID = 'typesafe/jev-1.14';
const MODEL_SELECTORS = Object.freeze({
  [DEFAULT_MODEL_ID]: 'clef',
  [MODEL_ID]: 'clef-flash',
  [JEV_MODEL_ID]: JEV_MODEL_ID
});
const ACTIONS = Object.freeze({
  ACTION_UP: 'Move up (decrease row).',
  ACTION_DOWN: 'Move down (increase row).',
  ACTION_LEFT: 'Move left (decrease column).',
  ACTION_RIGHT: 'Move right (increase column).',
  ACTION_USE: 'Use the avatar ability, such as shooting; follow the game rules.',
  ACTION_NIL: 'Wait without pressing a key.'
});

function decisionPromptConfig(config) {
  return { ...config, codeProtocol: { enabled: false }, macroActions: { enabled: false } };
}

/** Define the one-step objective; criteria keys are the engine's legal actions. */
function buildActionQuestion(criteria, puzzle = false, holds = false) {
  return {
    type: 'choice',
    instructions: 'Select the best action from the candidate evaluations in criteria. ' +
      (puzzle ? 'First prefer fewer immediate losses across risk samples. When a complete solution is engine-verified, choose the action with the fewest total moves to that win, including the first move. ' +
      'A verified complete solution takes priority over nearby score gains, distance heuristics and recent-position penalties: puzzles can require revisiting a cell. ' +
      'Otherwise prefer a simulated win in the fewest steps, then survival, objective progress, '
        : 'First prefer fewer immediate losses across risk samples. Then prefer a simulated win in the fewest steps. Otherwise prefer survival, objective progress, ') +
      'higher continuation.utility (the simulator heuristic), higher future score and shorter traversable route to a useful target. Avoid deadlocked boxes, ' +
      'blocked moves and revisiting the same position without progress. ' +
      'continuation is an optimistic bounded simulation, not a guaranteed outcome. ' +
      (holds ? 'Choosing an action authorizes holding exactly that key for up to its stated maximum ticks. The executor observes and checks immediate risk every tick, stopping early for a blockage, nearby dynamic sprite, newly opened turn, damage, transformation or changed tactic. It never substitutes another action. ' :
        'Only the chosen first action is executed; the world is observed again before the next decision. ') +
      'Coordinates are (column, row), with row zero at the top. ' +
      'A player tactic is a preference; game rules and legal actions take priority.',
    criteria
  };
}

function buildClefInput(sso, config, tracker, strategy, modelId = MODEL_ID, controlTicks = 1) {
  const selector = MODEL_SELECTORS[modelId];
  if (!selector) throw new Error('Unsupported decision model');
  const available = [...new Set(sso.availableActions || [])];
  if (!available.length || available.some(action => !Object.hasOwn(ACTIONS, action))) {
    throw new Error('Clef requires a nonempty list of supported GVGAI actions');
  }
  const effectiveConfig = decisionPromptConfig(config);
  const types = Object.entries(sso.spriteTypes || {});
  const symbols = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (types.length && types.length <= symbols.length) {
    effectiveConfig.gridSymbolMap = Object.fromEntries(types.map(([type], index) =>
      [type, Number(type) === sso.avatarType ? '@' : symbols[index]]));
    effectiveConfig.gridLegend = types.map(([type, name]) =>
      `${effectiveConfig.gridSymbolMap[type]} = ${name}`).join(', ') + ', . = empty background';
  }
  const prompt = buildPrompt(sso, effectiveConfig, tracker, strategy);
  // Reuse the game's rules, map and history, without an encoded best-action policy
  // or a text-generation contract. Images are never included in this request.
  const layers = (prompt.promptLayers || []).filter(layer =>
    !['System', 'Tick state', 'Player tactic', 'Play history'].includes(layer.name));
  const forecasts = sso.actionOutcomes || null;
  const maxTicksByAction = controlLimits(sso, config?.gameName, controlTicks);
  const excludedActions = {};
  for (const action of available) {
    const forecast = forecasts?.[action]?.immediate;
    if (forecast?.terminal && forecast.winner !== 'PLAYER_WINS') excludedActions[action] = 'simulated immediate loss';
    if (forecasts?.[action]?.immediateLosses > 0) excludedActions[action] = `immediate loss in ${forecasts[action].immediateLosses}/${forecasts[action].riskSamples} simulations`;
    if (config?.gameName === 'sokoban' && forecast?.deadlocked) excludedActions[action] = 'box on a static dead square';
    if (config?.gameName === 'sokoban' && forecasts?.[action]?.puzzle?.status === 'no-solution') {
      excludedActions[action] = 'push-space search exhausted: no solution under the absorbing-hole rules';
    }
  }
  // A forecast is fallible. If every action is rejected, expose all choices
  // and the warnings rather than inventing a safe action or a provider fallback.
  const safe = available.filter(action => !excludedActions[action]);
  // Choice schemas need multiple alternatives. With one predicted safe move,
  // retain the original options and clearly mark their predicted losses.
  const choices = safe.length >= 2 ? safe : available;
  const criteria = Object.fromEntries(choices.map(action => {
    const candidate = forecasts?.[action];
    let description = `${ACTIONS[action]}${config?.actionAliases?.[action] ? ` Game label: ${config.actionAliases[action]}.` : ''}`;
    if (controlTicks > 1) description += ` Execute this key for at most ${maxTicksByAction[action]} tick(s), rechecking each tick; the continuation below is evidence, not an action queue.`;
    if (candidate) {
      const f = candidate.continuation;
      const visits = (tracker?.stateHistory || []).filter(entry =>
        entry.score === sso.gameScore && entry.position.every((v, i) => v / sso.blockSize === candidate.immediate.position[i])).length;
      description += ` Immediate losses: ${candidate.immediateLosses || 0}/${candidate.riskSamples || 1} sampled futures. Next position (${candidate.immediate.position.join(', ')}). ` +
        `Best simulated continuation: ${f.winner}, score gain ${f.scoreDelta}, ` +
        `remaining route distance ${f.targetDistance}, ${f.steps} steps, utility ${f.utility ?? 'unknown'} (higher is better). ` +
        `Next position visited ${visits} times recently without score progress.`;
      if (candidate.puzzle) {
        description += candidate.puzzle.engineVerified
          ? ` COMPLETE WIN VERIFIED IN JAVA: ${candidate.puzzle.solutionMoves} total moves including this action. Fewer total moves is better.`
          : ` Complete-solution search: ${candidate.puzzle.status}. This is not a verified winning continuation.`;
      }
      if (excludedActions[action]) description += ` WARNING: ${excludedActions[action]}; avoid this action if possible.`;
    }
    return [action, description];
  }));
  return {
    model: selector,
    state: {
      game: config?.gameName || 'GVGAI',
      context: layers.length ? layers : (prompt.userMessage || ''),
      spatial: types.length ? {
        avatarGridPosition: sso.avatarPosition?.map(value => value / sso.blockSize),
        gridSize: sso.worldDimension?.map(value => value / sso.blockSize),
        avatarOrientation: sso.avatarOrientation
      } : extractSpatialContext(sso),
      tick: sso.gameTick,
      score: sso.gameScore,
      health: sso.avatarHealthPoints,
      lastAction: sso.avatarLastAction,
      legalActions: choices,
      engineLegalActions: available,
      control: { maxTicksByAction, observeEveryTick: true },
      playerTactic: strategy || null,
      recentPositions: (tracker?.stateHistory || []).slice(-12).map(entry => ({
        position: entry.position.map(value => value / sso.blockSize), score: entry.score
      })),
      planning: forecasts ? {
        method: Object.values(forecasts).some(candidate => candidate.puzzle)
          ? 'Bounded weighted push-space A* for reusable absorbing holes; complete solutions replayed in a copy of the Java engine. Paths are not guaranteed shortest. Limits: 60000 nodes, 250 ms, 300 moves per candidate. Budget exhaustion is unknown, not a deadlock.'
          : `GVGAI forward model, beam width 16, depth at most 12, at most 800 advances per action${sso.planningMode === 'JSON_PLANNING_LIVE' ? '; interactive search stops after a 20 ms slice per action, after seven required immediate-risk samples' : ''}`,
        warning: 'Stochastic forecasts may differ from reality. Distance is a heuristic, not a win condition.',
        excludedActions, allActionsUnsafe: !safe.length, candidates: forecasts
      } : null
    },
    questions: { action: buildActionQuestion(criteria, config?.gameName === 'sokoban', controlTicks > 1) }
  };
}

function parseClefResponse(data, availableActions, expectedModel) {
  if (data.success === false || data.error) throw new Error('Provider rejected the Clef request');
  const result = data.result || data;
  const expectedIds = expectedModel === JEV_MODEL_ID
    ? [JEV_MODEL_ID, `${JEV_MODEL_ID}-20261014`]
    : [expectedModel, `@cf/cloudflare/${expectedModel}`, `cloudflare/${expectedModel}`];
  if (expectedModel && !expectedIds.includes(result.model)) {
    throw new Error('Provider returned an unexpected decision model');
  }
  const answer = result.answers?.action;
  const probabilities = answer?.probabilities;
  if (answer?.type !== 'choice' || !availableActions.includes(answer.choice) ||
      !probabilities || !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 || answer.confidence > 1 ||
      Object.keys(probabilities).length !== availableActions.length ||
      availableActions.some(action => !Number.isFinite(probabilities[action]) ||
        probabilities[action] < 0 || probabilities[action] > 1) ||
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02) {
    throw new Error('Clef returned an invalid legal-action distribution');
  }
  if (availableActions.some(action => probabilities[action] > probabilities[answer.choice] + 0.000001)) {
    throw new Error('Clef returned a choice inconsistent with its distribution');
  }
  return {
    action: answer.choice,
    reason: '', // A probability distribution is not a model-authored rationale.
    source: result.model?.startsWith('typesafe/jev-') ? 'jev-choice' : 'clef-choice',
    valid: true,
    confidence: answer.confidence,
    probabilities,
    usage: result.usage || null,
    model: result.model,
    raw: result
  };
}

async function requestClef(input, options = {}) {
  const modelId = Object.keys(MODEL_SELECTORS).find(id => MODEL_SELECTORS[id] === input?.model);
  if (!modelId) throw new Error('Unsupported decision model');
  const isJev = modelId === JEV_MODEL_ID;
  const servingProvider = isJev ? 'TypeSafe' : 'Cloudflare';
  const modelLabel = isJev ? 'Jev' : 'Clef';
  if (Buffer.byteLength(JSON.stringify(input)) > 64000) throw new Error('Clef decision context exceeds the 64 KB application limit');
  // Keep the decision schema identical across transports. OpenRouter's native
  // Decisions endpoint uses a catalog slug rather than the Workers AI selector.
  const connection = clefConnection(modelId, process.env, options);
  const providerLabel = connection.provider === 'openrouter' ? 'OpenRouter' : 'Cloudflare';
  const payload = connection.provider === 'openrouter' ? {
    ...input, model:isJev ? JEV_MODEL_ID : `cloudflare/${input.model}`,
    provider:{only:[servingProvider], allow_fallbacks:false, max_price:{prompt:isJev ? 0.042 : 0.24,completion:0}}
  } : input;
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 64000) throw new Error('Clef decision context exceeds the 64 KB application limit');
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 12000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch || fetch)(
      connection.url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        body,
        signal: controller.signal
      }
    );
    if (!response.ok) {
      // Provider bodies can contain request data. Keep credentials and state out
      // of errors sent to the browser; HTTP status is sufficient for diagnosis.
      throw new Error(`${providerLabel} ${modelLabel} HTTP ${response.status}`);
    }
    const data = await response.json();
    if (connection.provider === 'openrouter' && data.provider !== servingProvider) {
      throw new Error(`OpenRouter returned an unexpected ${isJev ? 'Jev' : 'CLEF'} serving provider`);
    }
    return parseClefResponse(data, input.state.legalActions, input.model);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${providerLabel} ${modelLabel} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { MODEL_ID, DEFAULT_MODEL_ID, JEV_MODEL_ID, MODEL_SELECTORS, buildActionQuestion, buildClefInput, decisionPromptConfig, parseClefResponse, requestClef };
