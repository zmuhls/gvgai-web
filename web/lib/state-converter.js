// Convert GVGAI SerializableStateObservation to LLM prompt
const { renderAsciiGrid, detectBackgroundItypes, DEFAULT_LEGEND } = require('./grid-renderer');
const { buildCodePrompt } = require('./code-protocol');

// Rolling game state tracker for iterative, context-aware prompts
class GameStateTracker {
  constructor(maxHistory = 5, maxActions = 3) {
    this.maxHistory = maxHistory;
    this.maxActions = maxActions;
    this.stateHistory = [];   // Last N tick snapshots: { tick, score, health, position }
    this.actionHistory = [];  // Last N LLM decisions: { tick, action, scoreDelta, healthDelta, positionDelta }
    this.lastState = null;
    this.backgroundItypes = null; // Cached background sprite itypes (detected on first tick)
  }

  // Record a tick's game state (called on every ACT tick)
  recordTick(sso) {
    const snapshot = {
      tick: sso.gameTick || 0,
      score: sso.gameScore || 0,
      health: sso.avatarHealthPoints || 0,
      position: sso.avatarPosition
        ? [sso.avatarPosition[0], sso.avatarPosition[1]]
        : [0, 0]
    };
    this.lastState = snapshot;
    this.stateHistory.push(snapshot);
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.shift();
    }
  }

  // Record an LLM action result (called when LLM responds)
  recordAction(action, tickAtCall) {
    const current = this.lastState;
    // Find the state at the tick when the LLM call was initiated
    const callState = this.stateHistory.find(s => s.tick === tickAtCall) || this.stateHistory[0];
    if (!current || !callState) {
      this.actionHistory.push({ tick: current?.tick || 0, action, scoreDelta: 0, healthDelta: 0, positionDelta: '(0, 0)' });
    } else {
      this.actionHistory.push({
        tick: current.tick,
        action,
        scoreDelta: current.score - callState.score,
        healthDelta: current.health - callState.health,
        positionDelta: `(${current.position[0] - callState.position[0]}, ${current.position[1] - callState.position[1]})`
      });
    }
    if (this.actionHistory.length > this.maxActions) {
      this.actionHistory.shift();
    }
  }

  // Build a compact history string for inclusion in prompts
  buildHistoryContext() {
    if (this.actionHistory.length === 0) return '';

    const lines = this.actionHistory.map(a => {
      const parts = [`Tick ${a.tick}: ${a.action}`];
      if (a.scoreDelta !== 0) parts.push(`score ${a.scoreDelta > 0 ? '+' : ''}${a.scoreDelta}`);
      if (a.healthDelta !== 0) parts.push(`health ${a.healthDelta > 0 ? '+' : ''}${a.healthDelta}`);
      if (a.positionDelta !== '(0, 0)') parts.push(`moved ${a.positionDelta}`);
      if (a.scoreDelta === 0 && a.healthDelta === 0 && a.positionDelta === '(0, 0)') parts.push('no change');
      return `- ${parts.join(', ')}`;
    });

    return `Recent history:\n${lines.join('\n')}`;
  }

  // Compute deltas from last recorded state to current
  buildDeltaContext(sso) {
    if (!this.lastState) return '';
    const scoreDelta = (sso.gameScore || 0) - this.lastState.score;
    const healthDelta = (sso.avatarHealthPoints || 0) - this.lastState.health;
    const parts = [];
    if (scoreDelta !== 0) parts.push(`Score ${scoreDelta > 0 ? '+' : ''}${scoreDelta} since last decision`);
    if (healthDelta !== 0) parts.push(`Health ${healthDelta > 0 ? '+' : ''}${healthDelta} since last decision`);
    return parts.length > 0 ? parts.join('. ') + '.' : '';
  }

  // Detect action loops: same action repeated with no position change
  detectLoop() {
    if (this.actionHistory.length < 2) return '';
    const last = this.actionHistory[this.actionHistory.length - 1];
    let repeatCount = 0;
    for (let i = this.actionHistory.length - 1; i >= 0; i--) {
      const a = this.actionHistory[i];
      if (a.action === last.action && a.positionDelta === '(0, 0)') {
        repeatCount++;
      } else {
        break;
      }
    }
    if (repeatCount >= 2) {
      return `WARNING: ${last.action} repeated ${repeatCount}x with no movement. Pick a DIFFERENT action.`;
    }
    return '';
  }

  // Detect and cache background itypes from the observation grid (call once per level)
  ensureBackgroundDetected(sso) {
    if (this.backgroundItypes === null && sso.observationGrid) {
      this.backgroundItypes = detectBackgroundItypes(sso);
    }
  }

  reset() {
    this.stateHistory = [];
    this.actionHistory = [];
    this.lastState = null;
    this.backgroundItypes = null;
  }
}

function readPositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function readCoordinate(position, key, index) {
  if (!position) return null;
  if (Array.isArray(position)) return position[index] ?? null;
  return position[key] ?? position[index] ?? null;
}

function positionToGrid(position, blockSize) {
  const x = readCoordinate(position, 'x', 0);
  const y = readCoordinate(position, 'y', 1);
  if (x === null || y === null) return null;
  return [Math.round(x / blockSize), Math.round(y / blockSize)];
}

function getObservationDimensions(sso) {
  const explicitW = readPositiveInteger(sso.observationGridNum);
  const explicitH = readPositiveInteger(sso.observationGridMaxRow);
  if (explicitW || explicitH) {
    return [explicitW, explicitH];
  }

  if (!Array.isArray(sso.observationGrid) || sso.observationGrid.length === 0) {
    return [null, null];
  }

  const inferredH = sso.observationGrid.reduce((max, column) => (
    Array.isArray(column) ? Math.max(max, column.length) : max
  ), 0);
  return [sso.observationGrid.length, inferredH || null];
}

function getGridDimensions(sso) {
  const [observedW, observedH] = getObservationDimensions(sso);
  if (observedW || observedH) {
    return [observedW, observedH];
  }

  if (!sso.worldDimension) {
    return [null, null];
  }

  const rawW = readPositiveInteger(sso.worldDimension[0]);
  const rawH = readPositiveInteger(sso.worldDimension[1]);
  if (!rawW || !rawH) {
    return [rawW, rawH];
  }

  const blockSize = readPositiveInteger(sso.blockSize) || 1;
  if (blockSize <= 1) {
    return [rawW, rawH];
  }

  const dividedW = Math.round(rawW / blockSize);
  const dividedH = Math.round(rawH / blockSize);
  const playerPos = positionToGrid(sso.avatarPosition, blockSize);
  const dividedGridCannotContainPlayer = playerPos && (
    playerPos[0] >= dividedW || playerPos[1] >= dividedH
  );

  if (dividedGridCannotContainPlayer || rawW <= 80 || rawH <= 80) {
    return [rawW, rawH];
  }

  return [dividedW, dividedH];
}

// Extract compact spatial context from full SSO (called only during LLM prompt build)
function extractSpatialContext(sso) {
  const blockSize = sso.blockSize || 1;
  const toGrid = (pos) => positionToGrid(pos, blockSize);

  // Player position in grid coords
  const playerPos = toGrid(sso.avatarPosition);
  const [gridW, gridH] = getGridDimensions(sso);

  const parts = [];

  // Position + grid bounds
  if (playerPos && gridW && gridH) {
    parts.push(`Position: (${playerPos[0]}, ${playerPos[1]}) on ${gridW}x${gridH} grid`);
  } else if (playerPos) {
    parts.push(`Position: (${playerPos[0]}, ${playerPos[1]})`);
  }

  // Blocked directions (at grid edges)
  if (playerPos && gridW && gridH) {
    const blocked = [];
    if (playerPos[0] <= 0) blocked.push('LEFT');
    if (playerPos[0] >= gridW - 1) blocked.push('RIGHT');
    if (playerPos[1] <= 0) blocked.push('UP');
    if (playerPos[1] >= gridH - 1) blocked.push('DOWN');
    if (blocked.length > 0) {
      parts.push(`Blocked: ${blocked.join(', ')}`);
    }
  }

  // Signed axis split: e.g. dx=-3, dy=1 -> "3 left, 1 down". Models reason far
  // better with component distances than with compound direction words.
  const axisLabel = (dx, dy) => {
    const dir = [];
    if (dy < 0) dir.push(`${-dy} up`);
    if (dy > 0) dir.push(`${dy} down`);
    if (dx < 0) dir.push(`${-dx} left`);
    if (dx > 0) dir.push(`${dx} right`);
    return dir.join(', ') || 'adjacent';
  };

  // Collect nearest observations from a position-group array (NPCs, resources, portals)
  const nearest = (groups, num, limit) => {
    if (!groups || !playerPos) return [];
    const found = [];
    for (let i = 0; i < (num || groups.length || 0); i++) {
      if (!groups[i]) continue;
      for (let j = 0; j < groups[i].length; j++) {
        const obs = groups[i][j];
        if (obs && obs.position) {
          const gp = toGrid(obs.position);
          if (gp) {
            const dx = gp[0] - playerPos[0];
            const dy = gp[1] - playerPos[1];
            const dist = Math.abs(dx) + Math.abs(dy);
            found.push({ dist, label: `${axisLabel(dx, dy)} (${dist} away)` });
          }
        }
      }
    }
    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, limit);
  };

  // Nearest NPCs (threats)
  const npcs = nearest(sso.NPCPositions, sso.NPCPositionsNum, 3);
  if (npcs.length > 0) {
    parts.push(`Threats: ${npcs.map(n => n.label).join('; ')}`);
  }

  const movables = nearest(sso.movablePositions, sso.movablePositionsNum, 2);
  if (movables.length > 0) {
    parts.push(`Moving hazards: ${movables.map(n => n.label).join('; ')}`);
  }

  // Nearest goals (collectible resources + portals/exits)
  const goals = [];
  const res = nearest(sso.resourcesPositions, sso.resourcesPositionsNum, 1);
  if (res.length > 0) goals.push(`resource ${res[0].label}`);
  const portals = nearest(sso.portalsPositions, sso.portalsPositionsNum, 1);
  if (portals.length > 0) goals.push(`exit/portal ${portals[0].label}`);
  if (goals.length > 0) {
    parts.push(`Goals: ${goals.join('; ')}`);
  }

  return parts.join('\n');
}

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
  const blockSize = sso.blockSize || 1;
  const gridPos = sso.avatarPosition
    ? `(${Math.round(sso.avatarPosition[0] / blockSize)}, ${Math.round(sso.avatarPosition[1] / blockSize)})`
    : '(0, 0)';
  const [resolvedGridW, resolvedGridH] = getGridDimensions(sso);
  const gridW = resolvedGridW || '?';
  const gridH = resolvedGridH || '?';

  // Compute blocked directions
  let blockedDirs = 'NONE';
  if (sso.avatarPosition && sso.worldDimension) {
    const gx = Math.round(sso.avatarPosition[0] / blockSize);
    const gy = Math.round(sso.avatarPosition[1] / blockSize);
    const blocked = [];
    if (gx <= 0) blocked.push('LEFT');
    if (gx >= gridW - 1) blocked.push('RIGHT');
    if (gy <= 0) blocked.push('UP');
    if (gy >= gridH - 1) blocked.push('DOWN');
    if (blocked.length > 0) blockedDirs = blocked.join(', ');
  }

  const vars = {
    gameName: extraVars?.gameName || 'unknown',
    gameScore: sso.gameScore || 0,
    avatarHealthPoints: sso.avatarHealthPoints || 0,
    gameTick: sso.gameTick || 0,
    availableActions: (sso.availableActions || ['ACTION_NIL']).join(', '),
    avatarPosition: sso.avatarPosition
      ? `(${sso.avatarPosition[0]}, ${sso.avatarPosition[1]})`
      : '(0, 0)',
    playerPosition: gridPos,
    gridSize: `${gridW}x${gridH}`,
    blockedDirections: blockedDirs,
    lastAction: sso.avatarLastAction || 'none',
    asciiGrid: extraVars?.asciiGrid || ''
  };
  return templateContent.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? String(vars[key]) : match;
  });
}

// Build layered prompt from prompt config (dashboard-configured)
// Returns { systemMessage, userMessage } for multi-message API call
// Optional stateTracker provides rolling history context
// Optional sessionStrategy is an ephemeral, per-session player directive (never persisted)
function buildPrompt(sso, promptConfig, stateTracker, sessionStrategy) {
  if (!promptConfig) {
    // Fallback to legacy single-message prompt
    return { systemMessage: null, userMessage: buildDescriptivePrompt(sso) };
  }

  if (promptConfig.codeProtocol?.enabled) {
    return buildCodePrompt(sso, promptConfig, stateTracker, sessionStrategy);
  }

  // Detect background itypes on first call per level
  if (stateTracker) {
    stateTracker.ensureBackgroundDetected(sso);
  }

  // Render ASCII grid map
  const gameSymbolMap = promptConfig.gridSymbolMap || null;
  const bgItypes = stateTracker ? stateTracker.backgroundItypes : null;
  const asciiGrid = renderAsciiGrid(sso, gameSymbolMap, bgItypes);

  const extraVars = { gameName: promptConfig.gameName, asciiGrid: asciiGrid || '' };

  // Layer 1: System prompt
  const systemMessage = resolveTemplate(promptConfig.systemContent, sso, extraVars);

  // Layer 2: Game context
  const gameContext = resolveTemplate(promptConfig.gameContent, sso, extraVars);

  // Layer 3: Progression/level context
  const levelContext = resolveTemplate(promptConfig.levelContent, sso, extraVars);

  // Layer 4: Rolling history context (from state tracker)
  const historyContext = stateTracker
    ? [stateTracker.buildHistoryContext(), stateTracker.buildDeltaContext(sso)].filter(Boolean).join('\n')
    : '';

  // Layer 5: Loop detection warning
  const loopWarning = stateTracker ? stateTracker.detectLoop() : '';

  // Layer 6: Spatial context (position, threats, boundaries)
  const spatialContext = extractSpatialContext(sso);

  // Layer 6b: ASCII grid map (full spatial layout)
  // Orientation legend removes a common confusion about which way UP moves on the grid.
  const legend = promptConfig.gridLegend || DEFAULT_LEGEND;
  const gridContext = asciiGrid
    ? `Map — row 0 = top, col 0 = left, @ = you (${legend}):\n${asciiGrid}`
    : '';

  // Layer 7: Per-tick state (always auto-generated)
  const actions = sso.availableActions || ['ACTION_NIL'];
  const lastAction = sso.avatarLastAction || null;

  // Apply per-game action aliases so the prompt uses game-appropriate labels
  // e.g., ACTION_USE → SHOOT for Aliens, ACTION_NIL → WAIT
  const actionAliases = promptConfig.actionAliases || null;
  const displayActions = actionAliases
    ? actions.map(a => actionAliases[a] || a)
    : actions;
  const displayLastAction = lastAction && actionAliases
    ? (actionAliases[lastAction] || lastAction)
    : lastAction;

  // Layer 0: ephemeral player directive (the walk-up user's strategy).
  // Worded as a mandatory goal the model must NAME in its reasoning, so the
  // narration panel and adherence signal have something to surface.
  const strategyLayer = sessionStrategy
    ? `YOUR ASSIGNED STRATEGY (a human player gave you this — follow it, and name it in your REASON):\n"${sessionStrategy}"`
    : '';

  // When a strategy is active we ask for a structured reply (rationale + action).
  // ACTION: comes LAST so a truncated/rambling reply still ends on the action.
  const narrate = !!sessionStrategy;
  const closing = narrate
    ? `Respond in EXACTLY this format, nothing else:
REASON: <one short sentence; say how this move follows your assigned strategy>
ACTION: <one action from the list above>`
    : `Choose ONE action. Respond with ONLY the action word.`;

  const tickState = `Current State — Score: ${sso.gameScore || 0} | Health: ${sso.avatarHealthPoints || 100} | Tick: ${sso.gameTick || 0}${displayLastAction ? ` | Last action: ${displayLastAction}` : ''}
${spatialContext ? spatialContext + '\n' : ''}Available actions: ${displayActions.join(', ')}
${loopWarning ? '\n' + loopWarning + '\n' : ''}
${closing}`;

  // Combine layers into user message
  const userMessage = [strategyLayer, gameContext, levelContext, historyContext, gridContext, tickState]
    .filter(Boolean)
    .join('\n\n');

  return { systemMessage, userMessage };
}

// Compute a coarse strategy-adherence signal from the run log, with no extra LLM call.
// It measures whether the model's STATED rationale references the strategy's keywords —
// honest about what it can know (stated intent, not provable behavior change).
const ADHERENCE_STOPWORDS = new Set([
  'the','and','for','with','your','you','this','that','game','games','play','playing',
  'try','keep','make','get','all','any','its','it','to','of','in','on','as','be','do',
  'go','move','moving','action','actions','when','where','what','then','than','from',
  'are','was','will','can','should','need','want','take','use','using'
]);

function computeAdherence(strategy, runLog) {
  const total = runLog ? runLog.length : 0;
  if (!strategy || total === 0) {
    return { label: 'No strategy', mentioned: 0, total, keywords: [] };
  }
  const words = strategy.toLowerCase().match(/[a-z]+/g) || [];
  const keywords = [...new Set(words.filter(w => w.length >= 3 && !ADHERENCE_STOPWORDS.has(w)))];
  if (keywords.length === 0) {
    return { label: 'Partially followed', mentioned: 0, total, keywords };
  }
  let mentioned = 0;
  for (const entry of runLog) {
    const r = (entry.reason || '').toLowerCase();
    if (keywords.some(k => r.includes(k))) mentioned++;
  }
  const ratio = total ? mentioned / total : 0;
  let label;
  if (ratio >= 0.6) label = 'Strongly followed';
  else if (ratio >= 0.25) label = 'Partially followed';
  else label = 'Drifted';
  return { label, mentioned, total, keywords };
}

module.exports = {
  buildDescriptivePrompt,
  buildMinimalPrompt,
  buildPrompt,
  extractSpatialContext,
  computeAdherence,
  GameStateTracker
};
