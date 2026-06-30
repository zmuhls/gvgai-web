const { computeAdherence } = require('./state-converter');
const { parseAction } = require('./response-parser');

const ACTIONS = {
  UP: 'ACTION_UP',
  DOWN: 'ACTION_DOWN',
  LEFT: 'ACTION_LEFT',
  RIGHT: 'ACTION_RIGHT',
  USE: 'ACTION_USE',
  NIL: 'ACTION_NIL'
};

function classifyStrategy(text = '') {
  const lower = text.toLowerCase();
  if (/\b(defensive|distance|danger|alive|safe|surviv)/.test(lower)) return 'safe';
  if (/\b(score|points|collect|resource|aggressive|risk)/.test(lower)) return 'points';
  if (/\b(exit|goal|puzzle|deliberate|step|plan)/.test(lower)) return 'puzzle';
  return 'balanced';
}

function routeForPolicy(policy) {
  if (policy === 'safe') {
    return [
      [ACTIONS.UP, 'Take the top lane to avoid danger.'],
      [ACTIONS.RIGHT, 'Collect the safe gem before moving on.'],
      [ACTIONS.RIGHT, 'Keep distance from the enemy by staying high.'],
      [ACTIONS.RIGHT, 'Stay on the safe route around the threat.'],
      [ACTIONS.RIGHT, 'Move toward the exit from the safe lane.'],
      [ACTIONS.DOWN, 'Step into the exit after avoiding danger.']
    ];
  }
  if (policy === 'points') {
    return [
      [ACTIONS.UP, 'Move toward the collectible for points.'],
      [ACTIONS.RIGHT, 'Collect the gem to raise the score.'],
      [ACTIONS.DOWN, 'Return to the center path to attack for more points.'],
      [ACTIONS.USE, 'Attack the enemy for extra points.'],
      [ACTIONS.RIGHT, 'Move through the cleared enemy tile.'],
      [ACTIONS.RIGHT, 'Push toward the exit after scoring.'],
      [ACTIONS.RIGHT, 'Finish at the exit with the higher score.']
    ];
  }
  if (policy === 'puzzle') {
    return [
      [ACTIONS.RIGHT, 'Move directly toward the exit goal.'],
      [ACTIONS.USE, 'Clear the blocker so the exit path opens.'],
      [ACTIONS.RIGHT, 'Advance through the cleared path.'],
      [ACTIONS.RIGHT, 'Keep moving toward the exit.'],
      [ACTIONS.RIGHT, 'Reach the exit with few wasted moves.']
    ];
  }
  return [
    [ACTIONS.RIGHT, 'Move toward the center of the board.'],
    [ACTIONS.USE, 'Clear the enemy blocking the path.'],
    [ACTIONS.RIGHT, 'Move through the cleared path.'],
    [ACTIONS.RIGHT, 'Approach the exit.'],
    [ACTIONS.RIGHT, 'Finish the level.']
  ];
}

function applyAction(state, action) {
  if (action === ACTIONS.USE) {
    const adjacentToEnemy = state.enemyAlive &&
      Math.abs(state.x - state.enemy.x) + Math.abs(state.y - state.enemy.y) === 1;
    if (adjacentToEnemy) {
      state.enemyAlive = false;
      state.score += 5;
    }
    return;
  }

  if (action === ACTIONS.UP) state.y = Math.max(0, state.y - 1);
  if (action === ACTIONS.DOWN) state.y = Math.min(2, state.y + 1);
  if (action === ACTIONS.LEFT) state.x = Math.max(0, state.x - 1);
  if (action === ACTIONS.RIGHT) state.x = Math.min(4, state.x + 1);

  if (state.enemyAlive && state.x === state.enemy.x && state.y === state.enemy.y) {
    state.health -= 1;
    state.x = Math.max(0, state.x - 1);
  }

  if (!state.gemCollected && state.x === state.gem.x && state.y === state.gem.y) {
    state.gemCollected = true;
    state.score += 3;
  }
}

function tacticalHintFor(policy, state) {
  if (policy === 'safe') {
    if (state.y === 1) return ACTIONS.UP;
    if (state.x < 4) return ACTIONS.RIGHT;
    return ACTIONS.DOWN;
  }
  if (policy === 'points') {
    if (!state.gemCollected) {
      if (state.y === 1) return ACTIONS.UP;
      if (state.x < state.gem.x) return ACTIONS.RIGHT;
    }
    const adjacentToEnemy = state.enemyAlive &&
      Math.abs(state.x - state.enemy.x) + Math.abs(state.y - state.enemy.y) === 1;
    if (adjacentToEnemy) return ACTIONS.USE;
    if (state.y === 0) return ACTIONS.DOWN;
    return ACTIONS.RIGHT;
  }
  if (policy === 'puzzle') {
    const adjacentToEnemy = state.enemyAlive &&
      Math.abs(state.x - state.enemy.x) + Math.abs(state.y - state.enemy.y) === 1;
    if (adjacentToEnemy) return ACTIONS.USE;
    return ACTIONS.RIGHT;
  }
  return ACTIONS.RIGHT;
}

function buildOllamaPrompt(strategy, state) {
  const policy = classifyStrategy(strategy);
  const hints = {
    safe: tacticalHintFor('safe', state),
    points: tacticalHintFor('points', state),
    puzzle: tacticalHintFor('puzzle', state)
  };

  return `Choose one token only.
You are playing a 5x3 grid game.
Player: (${state.x},${state.y}); exit: (${state.exit.x},${state.exit.y}); enemy alive: ${state.enemyAlive}; enemy: (${state.enemy.x},${state.enemy.y}); gem collected: ${state.gemCollected}; gem: (${state.gem.x},${state.gem.y}); score: ${state.score}; health: ${state.health}.
Assigned strategy: ${strategy}
Strategy action guide:
- safe or defensive strategy: choose ${hints.safe}
- points or aggressive scoring strategy: choose ${hints.points}
- puzzle or exit strategy: choose ${hints.puzzle}
Valid tokens: ACTION_UP ACTION_DOWN ACTION_LEFT ACTION_RIGHT ACTION_USE ACTION_NIL.
Answer:`;
}

async function callOllamaAction(model, prompt, options = {}) {
  const response = await fetch(options.apiUrl || 'http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      prompt,
      options: {
        temperature: 0,
        num_predict: 12,
        stop: ['\n']
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const raw = data.response || '';
  return {
    raw,
    action: parseAction(raw, Object.values(ACTIONS)),
    durationMs: Math.round((data.total_duration || 0) / 1000000)
  };
}

async function playOllamaOfflineGame(strategy, options = {}) {
  const model = options.ollamaModel || options.modelId || 'qwen2.5:0.5b';
  const state = {
    x: 0,
    y: 1,
    health: 3,
    score: 0,
    enemy: { x: 2, y: 1 },
    gem: { x: 1, y: 0 },
    exit: { x: 4, y: 1 },
    enemyAlive: true,
    gemCollected: false
  };
  const actions = [];
  const runLog = [];
  const modelResponses = [];
  let winner = 'TIME_OUT';

  for (let tick = 0; tick < 8; tick++) {
    const prompt = buildOllamaPrompt(strategy, state);
    const decision = await callOllamaAction(model, prompt, options);
    const beforeScore = state.score;
    applyAction(state, decision.action);
    actions.push(decision.action);
    modelResponses.push({
      tick,
      prompt,
      raw: decision.raw,
      action: decision.action,
      durationMs: decision.durationMs
    });
    runLog.push({
      tick,
      action: decision.action,
      reason: decision.raw,
      scoreDelta: state.score - beforeScore
    });

    if (state.health <= 0) {
      winner = 'PLAYER_LOSES';
      break;
    }

    if (state.x === state.exit.x && state.y === state.exit.y) {
      state.score += 2;
      winner = 'PLAYER_WINS';
      break;
    }
  }

  return {
    finalScore: state.score,
    winner,
    won: winner === 'PLAYER_WINS',
    ticks: actions.length,
    decisions: actions.length,
    actions,
    adherence: computeAdherence(strategy, runLog),
    highlights: runLog
      .filter(entry => entry.scoreDelta > 0)
      .map(entry => ({
        tick: entry.tick,
        action: entry.action,
        reason: entry.reason,
        scoreDelta: entry.scoreDelta
      })),
    modelResponses
  };
}

function playOfflineGame(strategy) {
  const policy = classifyStrategy(strategy);
  const route = routeForPolicy(policy);
  const state = {
    x: 0,
    y: 1,
    health: 3,
    score: 0,
    enemy: { x: 2, y: 1 },
    gem: { x: 1, y: 0 },
    exit: { x: 4, y: 1 },
    enemyAlive: true,
    gemCollected: false
  };
  const runLog = [];
  const actions = [];
  let winner = 'TIME_OUT';

  for (let tick = 0; tick < route.length; tick++) {
    const [action, reason] = route[tick];
    const beforeScore = state.score;
    applyAction(state, action);
    actions.push(action);
    runLog.push({
      tick,
      action,
      reason,
      scoreDelta: state.score - beforeScore
    });

    if (state.health <= 0) {
      winner = 'PLAYER_LOSES';
      break;
    }

    if (state.x === state.exit.x && state.y === state.exit.y) {
      state.score += 2;
      winner = 'PLAYER_WINS';
      break;
    }
  }

  return {
    policy,
    finalScore: state.score,
    winner,
    won: winner === 'PLAYER_WINS',
    ticks: actions.length,
    decisions: actions.length,
    actions,
    adherence: computeAdherence(strategy, runLog),
    highlights: runLog
      .filter(entry => entry.scoreDelta > 0)
      .map(entry => ({
        tick: entry.tick,
        action: entry.action,
        reason: entry.reason,
        scoreDelta: entry.scoreDelta
      }))
  };
}

async function runOfflineEvalCase(evalCase) {
  const summary = playOfflineGame(evalCase.strategy);
  return {
    runId: evalCase.runId,
    gameId: evalCase.gameId,
    gameName: evalCase.gameName,
    levelId: evalCase.levelId,
    modelId: evalCase.modelId,
    modelName: evalCase.modelName,
    provider: 'offline',
    modelUsed: 'local-prompt-policy',
    fallback: null,
    strategyId: evalCase.strategyId,
    strategyLabel: evalCase.strategyLabel,
    finalScore: summary.finalScore,
    winner: summary.winner,
    won: summary.won,
    ticks: summary.ticks,
    decisions: summary.decisions,
    actions: summary.actions,
    adherence: summary.adherence,
    highlights: summary.highlights,
    nilActionLoop: false,
    survivedMinTicks: summary.ticks > 0,
    recordedAt: new Date().toISOString()
  };
}

async function runOllamaOfflineEvalCase(evalCase, options = {}) {
  const summary = await playOllamaOfflineGame(evalCase.strategy, {
    ...options,
    modelId: evalCase.modelId
  });
  return {
    runId: evalCase.runId,
    gameId: evalCase.gameId,
    gameName: evalCase.gameName,
    levelId: evalCase.levelId,
    modelId: evalCase.modelId,
    modelName: evalCase.modelName,
    provider: 'ollama-local',
    modelUsed: options.ollamaModel || evalCase.modelId,
    fallback: null,
    strategyId: evalCase.strategyId,
    strategyLabel: evalCase.strategyLabel,
    finalScore: summary.finalScore,
    winner: summary.winner,
    won: summary.won,
    ticks: summary.ticks,
    decisions: summary.decisions,
    actions: summary.actions,
    adherence: summary.adherence,
    highlights: summary.highlights,
    modelResponses: summary.modelResponses,
    nilActionLoop: false,
    survivedMinTicks: summary.ticks > 0,
    recordedAt: new Date().toISOString()
  };
}

module.exports = {
  classifyStrategy,
  playOllamaOfflineGame,
  playOfflineGame,
  runOfflineEvalCase,
  runOllamaOfflineEvalCase
};
