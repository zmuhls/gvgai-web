const DEFAULT_ACTION_CODES = {
  N: 'ACTION_NIL',
  U: 'ACTION_UP',
  D: 'ACTION_DOWN',
  L: 'ACTION_LEFT',
  R: 'ACTION_RIGHT',
  F: 'ACTION_USE',
  X: 'ACTION_ESCAPE'
};
const DEFAULT_DODGE_LOOKAHEAD_ROWS = 3;
const GRID_ACTION_DELTAS = {
  ACTION_LEFT: [-1, 0],
  ACTION_RIGHT: [1, 0],
  ACTION_UP: [0, -1],
  ACTION_DOWN: [0, 1]
};
const SSO_POSITION_SOURCES = {
  npc: ['NPCPositions', 'NPCPositionsNum'],
  movable: ['movablePositions', 'movablePositionsNum'],
  immovable: ['immovablePositions', 'immovablePositionsNum'],
  resource: ['resourcesPositions', 'resourcesPositionsNum'],
  portal: ['portalsPositions', 'portalsPositionsNum'],
  fromAvatar: ['fromAvatarSpritesPositions', 'fromAvatarSpritesPositionsNum']
};

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

function sign(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function cleanCodes(values, fallback) {
  const list = Array.isArray(values) ? values : fallback;
  return list.map(value => String(value).replace(/[^A-Z0-9_]/g, '')).filter(Boolean);
}

function actionCodeEntries(availableActions, protocol = {}) {
  const allowed = new Set(availableActions || ['ACTION_NIL']);
  const configured = protocol.actionCodes || DEFAULT_ACTION_CODES;
  return Object.entries(configured)
    .filter(([code, action]) => /^[A-Z0-9]$/.test(code) && allowed.has(action));
}

function actionCodeMap(availableActions, protocol = {}) {
  return Object.fromEntries(actionCodeEntries(availableActions, protocol));
}

function actionCodeForAction(actionCodes, action, fallback = null) {
  for (const [code, mappedAction] of Object.entries(actionCodes || {})) {
    if (mappedAction === action) return code;
  }
  return fallback;
}

function invertActionCodes(map) {
  const inverted = {};
  for (const [code, action] of Object.entries(map || {})) {
    inverted[action] = code;
  }
  return inverted;
}

function collectPositionGroups(groups, count, blockSize, playerPos, code, limit = 5) {
  if (!Array.isArray(groups) || !playerPos || !code) return [];
  const found = [];
  const groupCount = Number.isInteger(count) ? count : groups.length;

  for (let i = 0; i < groupCount; i++) {
    const group = groups[i];
    if (!Array.isArray(group)) continue;
    for (const obs of group) {
      const grid = positionToGrid(obs?.position, blockSize);
      if (!grid) continue;
      const dx = grid[0] - playerPos[0];
      const dy = grid[1] - playerPos[1];
      found.push({
        code,
        x: grid[0],
        y: grid[1],
        dx,
        dy,
        distance: Math.abs(dx) + Math.abs(dy),
        obsID: obs?.obsID ?? obs?.obsId ?? null,
        itype: obs?.itype ?? null,
        category: obs?.category ?? null,
        groupIndex: i
      });
    }
  }

  found.sort((a, b) => {
    if (b.y !== a.y) return b.y - a.y;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return Math.abs(a.dx) - Math.abs(b.dx);
  });
  return found.slice(0, limit);
}

function collectSourcePositions(sso, sources, blockSize, playerPos, code, limit = 128) {
  const found = [];
  const selectedSources = Array.isArray(sources) && sources.length > 0 ? sources : ['npc'];

  for (const source of selectedSources) {
    const [groupsKey, countKey] = SSO_POSITION_SOURCES[source] || [];
    if (!groupsKey) continue;
    found.push(...collectPositionGroups(
      sso[groupsKey],
      sso[countKey],
      blockSize,
      playerPos,
      code,
      limit
    ));
  }

  return found.slice(0, limit);
}

function filterByItypes(items, itypes) {
  if (!Array.isArray(itypes) || itypes.length === 0) return items;
  const allowed = new Set(itypes);
  return items.filter(item => allowed.has(item.itype));
}

function gridKey(x, y) {
  return `${x},${y}`;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function gridDimensions(sso, blockSize) {
  const observedW = Number.isInteger(sso.observationGridNum) ? sso.observationGridNum : null;
  const observedH = Number.isInteger(sso.observationGridMaxRow) ? sso.observationGridMaxRow : null;
  if (observedW || observedH) return [observedW, observedH];
  if (!sso.worldDimension) return [null, null];

  const width = readCoordinate(sso.worldDimension, 'width', 0);
  const height = readCoordinate(sso.worldDimension, 'height', 1);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return [null, null];
  return [
    blockSize > 1 ? Math.round(width / blockSize) : Math.round(width),
    blockSize > 1 ? Math.round(height / blockSize) : Math.round(height)
  ];
}

function availableGridMoves(availableActions, codes) {
  return Object.values(codes || {})
    .filter(action => availableActions.includes(action) && GRID_ACTION_DELTAS[action])
    .map(action => ({
      action,
      code: actionCodeForAction(codes, action),
      delta: GRID_ACTION_DELTAS[action]
    }))
    .filter(move => move.code);
}

function addDangerRadius(dangerSet, item, radius) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > radius) continue;
      dangerSet.add(gridKey(item.x + dx, item.y + dy));
    }
  }
}

function formatEntities(items) {
  return items.map(item => `${item.code}:${item.x},${item.y}`).join('|') || '-';
}

function chooseTarget(targets) {
  if (!targets.length) return null;
  return targets[0];
}

function sameObservation(a, b) {
  if (a.obsID !== null && b.obsID !== null) return a.obsID === b.obsID;
  return a.x === b.x && a.y === b.y && a.itype === b.itype;
}

function removeOwnProjectiles(hazards, ownProjectiles) {
  if (ownProjectiles.length === 0) return hazards;
  return hazards.filter(hazard => !ownProjectiles.some(projectile => sameObservation(hazard, projectile)));
}

function columnUnsafe(playerPos, hazards, x, lookaheadRows = DEFAULT_DODGE_LOOKAHEAD_ROWS) {
  if (!playerPos) return false;
  return hazards.some(item => (
    item.x === x &&
    item.y <= playerPos[1] + 1 &&
    item.y >= playerPos[1] - lookaheadRows
  ));
}

function directionAction(direction) {
  return direction === 'L' ? 'ACTION_LEFT' : 'ACTION_RIGHT';
}

function isDirectionSafe(direction, playerPos, hazards, availableActions, lookaheadRows = DEFAULT_DODGE_LOOKAHEAD_ROWS) {
  if (!availableActions.includes(directionAction(direction))) return false;
  const nextX = playerPos[0] + (direction === 'L' ? -1 : 1);
  return !columnUnsafe(playerPos, hazards, nextX, lookaheadRows);
}

function chooseDodge(playerPos, hazards, availableActions, lookaheadRows = DEFAULT_DODGE_LOOKAHEAD_ROWS) {
  if (!playerPos || hazards.length === 0) return 'N';
  const near = hazards.filter(item => Math.abs(item.dx) <= 1 && item.dy <= 1 && item.dy >= -lookaheadRows);
  if (near.length === 0) return 'N';

  near.sort((a, b) => {
    if (Math.abs(a.dy) !== Math.abs(b.dy)) return Math.abs(a.dy) - Math.abs(b.dy);
    return Math.abs(a.dx) - Math.abs(b.dx);
  });

  const primary = near[0];
  const preferred = primary.dx <= 0 ? 'R' : 'L';
  const alternate = preferred === 'R' ? 'L' : 'R';

  if (isDirectionSafe(preferred, playerPos, hazards, availableActions, lookaheadRows)) return preferred;
  if (isDirectionSafe(alternate, playerPos, hazards, availableActions, lookaheadRows)) return alternate;
  return 'N';
}

function chooseMoveCode(dx, availableActions, playerPos, hazards, lookaheadRows = DEFAULT_DODGE_LOOKAHEAD_ROWS) {
  const desired = dx < 0 ? 'L' : dx > 0 ? 'R' : 'N';
  if (desired !== 'N' && isDirectionSafe(desired, playerPos, hazards, availableActions, lookaheadRows)) {
    return desired;
  }

  const alternate = desired === 'L' ? 'R' : desired === 'R' ? 'L' : 'N';
  if (alternate !== 'N' && isDirectionSafe(alternate, playerPos, hazards, availableActions, lookaheadRows)) {
    return alternate;
  }

  return 'N';
}

function chooseBestActionCode({ target, dodge, fire, availableActions, playerPos, hazards, protocol }) {
  const codes = actionCodeMap(availableActions, protocol);
  const forcedCode = protocol?.forceActionCode;
  if (forcedCode) {
    const forcedAction = codes[forcedCode] || (protocol.actionCodes || DEFAULT_ACTION_CODES)[forcedCode];
    if (forcedAction && availableActions.includes(forcedAction)) return forcedCode;
  }

  if (dodge && dodge !== 'N') return dodge;
  const useCode = actionCodeForAction(codes, 'ACTION_USE');
  if (fire && useCode && availableActions.includes('ACTION_USE')) return useCode;
  if (protocol?.preferFire && useCode && availableActions.includes('ACTION_USE')) return useCode;
  if (target) {
    return chooseMoveCode(
      target.dx,
      availableActions,
      playerPos,
      hazards,
      protocol?.dodgeLookaheadRows || DEFAULT_DODGE_LOOKAHEAD_ROWS
    );
  }
  return 'N';
}

function sameGrid(position, x, y) {
  return Array.isArray(position) && position[0] === x && position[1] === y;
}

function hasItemAt(items, x, y, itype = null) {
  return items.some(item => sameGrid([item.x, item.y], x, y) && (itype === null || item.itype === itype));
}

function chooseFleeDangerCode({ moves, start, dangerItems, dangerSet, wallSet, gridW, gridH, targets, protocol, stateTracker, availableActions }) {
  const fleeDistance = Number.isFinite(protocol?.fleeDangerDistance)
    ? protocol.fleeDangerDistance
    : null;
  if (!fleeDistance || dangerItems.length === 0) return null;

  const nearestDangerDistance = Math.min(...dangerItems.map(item => manhattan(start, item)));
  if (nearestDangerDistance > fleeDistance) return null;

  const candidates = moves
    .map(move => ({
      ...move,
      x: start.x + move.delta[0],
      y: start.y + move.delta[1]
    }))
    .filter(move => {
      const key = gridKey(move.x, move.y);
      const inBounds = (
        (!gridW || (move.x >= 0 && move.x < gridW)) &&
        (!gridH || (move.y >= 0 && move.y < gridH))
      );
      return inBounds && !wallSet.has(key) && !dangerSet.has(key);
    })
    .map(move => {
      const dangerDistance = Math.min(...dangerItems.map(item => manhattan(move, item)));
      const targetDistance = targets.length > 0
        ? Math.min(...targets.map(target => manhattan(move, target)))
        : 0;
      return {
        ...move,
        score: (dangerDistance * 100) - targetDistance
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (best && protocol?.fleeLoopBreaker && stateTracker?.dominantSentAction && stateTracker?.suggestAlternativeDirection) {
    const dominant = stateTracker.dominantSentAction();
    const alternativeAction = dominant?.action === best.action && dominant.fraction >= 0.6
      ? stateTracker.suggestAlternativeDirection(availableActions)
      : null;
    const alternative = candidates.find(move => move.action === alternativeAction);
    if (alternative) {
      return {
        code: alternative.code,
        reason: `flee nearby danger ${nearestDangerDistance}; break ${dominant.action}`
      };
    }
  }

  return best ? { code: best.code, reason: `flee nearby danger ${nearestDangerDistance}` } : null;
}

function validAliensMoveCode(desiredCode, sso, protocol, playerPos, codes) {
  if (!desiredCode) return null;

  const availableActions = sso.availableActions || [];
  const desiredAction = codes[desiredCode];
  if (!desiredAction || !availableActions.includes(desiredAction)) return null;

  const blockSize = sso.blockSize || 1;
  const movableHazards = collectPositionGroups(
    sso.movablePositions,
    sso.movablePositionsNum,
    blockSize,
    playerPos,
    'b',
    protocol.hazardLimit || 8
  );
  const ownProjectiles = collectPositionGroups(
    sso.fromAvatarSpritesPositions,
    sso.fromAvatarSpritesPositionsNum,
    blockSize,
    playerPos,
    's',
    protocol.projectileLimit || 8
  );
  const hazards = removeOwnProjectiles(movableHazards, ownProjectiles);
  const lookaheadRows = protocol.dodgeLookaheadRows || DEFAULT_DODGE_LOOKAHEAD_ROWS;

  if (
    desiredCode === 'L' &&
    playerPos &&
    playerPos[0] > 0 &&
    isDirectionSafe('L', playerPos, hazards, availableActions, lookaheadRows)
  ) {
    return 'L';
  }
  if (
    desiredCode === 'R' &&
    playerPos &&
    playerPos[0] < 28 &&
    isDirectionSafe('R', playerPos, hazards, availableActions, lookaheadRows)
  ) {
    return 'R';
  }

  const alternate = desiredCode === 'L' ? 'R' : desiredCode === 'R' ? 'L' : null;
  if (
    alternate &&
    codes[alternate] &&
    isDirectionSafe(alternate, playerPos, hazards, availableActions, lookaheadRows)
  ) {
    return alternate;
  }

  return null;
}

function chooseAliensMovementCode(sso, protocol, playerPos, codes) {
  const tick = Number.isInteger(sso.gameTick) ? sso.gameTick : 0;
  const sequence = Array.isArray(protocol.openingMoveCodes)
    ? protocol.openingMoveCodes
    : [protocol.openingMoveCode].filter(Boolean);
  let desiredCode = sequence[tick];

  if (!desiredCode && Array.isArray(protocol.movementCodes) && protocol.movementCodes.length > 0) {
    const interval = Number.isInteger(protocol.movementIntervalTicks)
      ? protocol.movementIntervalTicks
      : 0;
    if (interval > 0 && tick % interval === 0) {
      desiredCode = protocol.movementCodes[Math.floor(tick / interval) % protocol.movementCodes.length];
    }
  }

  const moveCode = validAliensMoveCode(desiredCode, sso, protocol, playerPos, codes);
  return moveCode ? { code: moveCode, reason: `movement beat ${moveCode}` } : null;
}

function chooseBaitLevel0Code(sso, protocol, playerPos, codes) {
  if (!playerPos) return null;

  const availableActions = sso.availableActions || [];
  const codeFor = (action) => (
    availableActions.includes(action) ? actionCodeForAction(codes, action) : null
  );
  const actionResult = (action, reason) => {
    const code = codeFor(action);
    return code ? { code, reason } : null;
  };

  const keyItype = protocol.keyItype ?? 7;
  const boxItype = protocol.boxItype ?? 9;
  const withKeyAvatarType = protocol.withKeyAvatarType ?? 5;
  const blockSize = sso.blockSize || 1;
  const movables = collectPositionGroups(
    sso.movablePositions,
    sso.movablePositionsNum,
    blockSize,
    playerPos,
    'm',
    protocol.policyEntityLimit || 32
  );
  const keyPresent = movables.some(item => item.itype === keyItype);
  const hasKey = sso.avatarType === withKeyAvatarType || !keyPresent;
  const [x, y] = playerPos;
  const boxAt = (bx, by) => hasItemAt(movables, bx, by, boxItype);

  if (hasKey) {
    if (x === 2 && y === 4) return actionResult('ACTION_UP', 'return from key');
    if (x === 2 && y === 3) return actionResult('ACTION_UP', 'climb from lower corridor');
    if (x === 2 && y === 2) return actionResult('ACTION_UP', 'return to goal row');
    if (x === 2 && y === 1) return actionResult('ACTION_LEFT', 'enter unlocked goal');
    if (x > 2) return actionResult('ACTION_LEFT', 'return to center lane');
    if (x < 2) return actionResult('ACTION_RIGHT', 'return to center lane');
    if (y > 1) return actionResult('ACTION_UP', 'return to goal row');
    return actionResult('ACTION_LEFT', 'enter unlocked goal');
  }

  if (x === 2 && y === 1) return actionResult('ACTION_DOWN', 'approach box puzzle');
  if (x === 2 && y === 2 && boxAt(3, 3)) return actionResult('ACTION_RIGHT', 'stand above right box');
  if (x === 3 && y === 2 && boxAt(3, 3)) return actionResult('ACTION_DOWN', 'push right box down');
  if (x === 3 && y === 3 && boxAt(2, 3)) return actionResult('ACTION_LEFT', 'push center box left');
  if (x === 2 && y === 3 && boxAt(1, 3)) return actionResult('ACTION_DOWN', 'collect key');
  if (x === 2 && y === 4) return actionResult('ACTION_UP', 'key tile reached');
  if (x < 2) return actionResult('ACTION_RIGHT', 'return to center lane');
  if (x > 3) return actionResult('ACTION_LEFT', 'return to push lane');
  if (y < 2) return actionResult('ACTION_DOWN', 'approach box puzzle');
  return actionResult('ACTION_RIGHT', 'recover bait route');
}

function chooseFixedCode(sso, protocol, codes) {
  const availableActions = sso.availableActions || [];
  const fixedCode = protocol.fixedActionCode || protocol.repeatedActionCode;
  const fixedAction = fixedCode ? codes[fixedCode] : null;
  if (fixedCode && fixedAction && availableActions.includes(fixedAction)) {
    return { code: fixedCode, reason: `fixed legal action ${fixedCode}` };
  }

  return null;
}

function chooseGridTargetCode(sso, protocol, playerPos, codes, stateTracker) {
  if (!playerPos) return null;

  const blockSize = sso.blockSize || 1;
  const availableActions = sso.availableActions || [];
  const moves = availableGridMoves(availableActions, codes);
  if (moves.length === 0) return null;

  const entityLimit = protocol.policyEntityLimit || 256;
  const targetCode = protocol.targetEntityCode || 't';
  const wallCode = protocol.wallEntityCode || 'w';
  const dangerCode = protocol.dangerEntityCode || 'd';
  const targets = filterByItypes(
    collectSourcePositions(sso, protocol.targetSources || ['npc'], blockSize, playerPos, targetCode, entityLimit),
    protocol.targetItypes
  );
  if (targets.length === 0) return null;

  const walls = filterByItypes(
    collectSourcePositions(sso, protocol.wallSources || ['immovable'], blockSize, playerPos, wallCode, entityLimit),
    protocol.wallItypes
  );
  const wallSet = new Set(walls.map(item => gridKey(item.x, item.y)));
  const targetSet = new Set(targets.map(item => gridKey(item.x, item.y)));
  const dangerSet = new Set();
  let dangerItems = [];

  if (protocol.dangerSources || protocol.dangerItypes || protocol.dangerNonTargets) {
    const rawDanger = collectSourcePositions(
      sso,
      protocol.dangerSources || protocol.targetSources || ['npc'],
      blockSize,
      playerPos,
      dangerCode,
      entityLimit
    );
    dangerItems = protocol.dangerNonTargets
      ? rawDanger.filter(item => !targetSet.has(gridKey(item.x, item.y)))
      : filterByItypes(rawDanger, protocol.dangerItypes);
    for (const item of dangerItems) {
      addDangerRadius(dangerSet, item, protocol.dangerRadius || 0);
    }
  }

  const pathTargets = protocol.allowDangerousTargets === true
    ? targets
    : targets.filter(target => !dangerSet.has(gridKey(target.x, target.y)));
  const navigableTargets = pathTargets.length > 0 ? pathTargets : targets;

  const start = { x: playerPos[0], y: playerPos[1] };
  const [gridW, gridH] = gridDimensions(sso, blockSize);
  const flee = chooseFleeDangerCode({
    moves,
    start,
    dangerItems,
    dangerSet,
    wallSet,
    gridW,
    gridH,
    targets,
    protocol,
    stateTracker,
    availableActions
  });
  if (flee) return flee;

  const queue = [{ ...start, path: [] }];
  const seen = new Set([gridKey(start.x, start.y)]);

  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = gridKey(current.x, current.y);
    if (current.path.length > 0 && navigableTargets.some(target => gridKey(target.x, target.y) === currentKey)) {
      return {
        code: current.path[0],
        reason: `path to visible target ${current.x},${current.y}`
      };
    }

    const nextMoves = moves
      .map(move => ({
        ...move,
        x: current.x + move.delta[0],
        y: current.y + move.delta[1]
      }))
      .sort((a, b) => (
        Math.min(...navigableTargets.map(target => manhattan(a, target))) -
        Math.min(...navigableTargets.map(target => manhattan(b, target)))
      ));

    for (const move of nextMoves) {
      const key = gridKey(move.x, move.y);
      const inBounds = (
        (!gridW || (move.x >= 0 && move.x < gridW)) &&
        (!gridH || (move.y >= 0 && move.y < gridH))
      );
      if (!inBounds || wallSet.has(key) || seen.has(key)) continue;
      if (dangerSet.has(key)) continue;
      seen.add(key);
      queue.push({
        x: move.x,
        y: move.y,
        path: current.path.concat(move.code)
      });
    }
  }

  const fallback = moves
    .map(move => ({
      ...move,
      x: start.x + move.delta[0],
      y: start.y + move.delta[1]
    }))
    .filter(move => !wallSet.has(gridKey(move.x, move.y)))
    .map(move => ({
      ...move,
      score: -Math.min(...targets.map(target => manhattan(move, target))) -
        (dangerSet.has(gridKey(move.x, move.y)) ? 20 : 0)
    }))
    .sort((a, b) => b.score - a.score)[0];

  return fallback ? { code: fallback.code, reason: 'greedy step to visible target' } : null;
}

function choosePolicyActionCode(sso, protocol, playerPos, codes, stateTracker) {
  switch (protocol?.policyId) {
    case 'aliens-opening-move':
      return chooseAliensMovementCode(sso, protocol, playerPos, codes);
    case 'bait-level0':
      return chooseBaitLevel0Code(sso, protocol, playerPos, codes);
    case 'fixed-code':
      return chooseFixedCode(sso, protocol, codes);
    case 'grid-target':
      return chooseGridTargetCode(sso, protocol, playerPos, codes, stateTracker);
    default:
      return null;
  }
}

function formatHistory(stateTracker, actionCodes) {
  const history = stateTracker?.actionHistory || [];
  if (history.length === 0) return '-';
  const inverted = invertActionCodes(actionCodes);
  return history.slice(-3).map(item => {
    const code = inverted[item.action] || '?';
    return `${code}${item.scoreDelta ? sign(item.scoreDelta) : '+0'}`;
  }).join(',');
}

function buildCodePrompt(sso, promptConfig = {}, stateTracker) {
  const protocol = promptConfig.codeProtocol || {};
  const id = protocol.id || 'GV1';
  const blockSize = sso.blockSize || 1;
  const availableActions = sso.availableActions || ['ACTION_NIL'];
  const codes = actionCodeMap(availableActions, protocol);
  const playerPos = positionToGrid(sso.avatarPosition, blockSize);
  const entityCodes = protocol.entityCodes || {};
  const targets = collectPositionGroups(
    sso.NPCPositions,
    sso.NPCPositionsNum,
    blockSize,
    playerPos,
    entityCodes.npc || 't',
    protocol.entityLimit || 5
  );
  const movableHazards = collectPositionGroups(
    sso.movablePositions,
    sso.movablePositionsNum,
    blockSize,
    playerPos,
    entityCodes.movable || 'h',
    protocol.hazardLimit || 4
  );
  const ownProjectiles = collectPositionGroups(
    sso.fromAvatarSpritesPositions,
    sso.fromAvatarSpritesPositionsNum,
    blockSize,
    playerPos,
    entityCodes.projectile || 's',
    protocol.projectileLimit || 3
  );
  const hazards = removeOwnProjectiles(movableHazards, ownProjectiles);
  const target = chooseTarget(targets);
  const lookaheadRows = protocol.dodgeLookaheadRows || DEFAULT_DODGE_LOOKAHEAD_ROWS;
  const dodge = chooseDodge(playerPos, hazards, availableActions, lookaheadRows);
  const fire = target && target.dx === 0 && dodge === 'N' && availableActions.includes('ACTION_USE') ? 1 : 0;
  const policy = choosePolicyActionCode(sso, protocol, playerPos, codes, stateTracker);
  const best = policy?.code || chooseBestActionCode({ target, dodge, fire, availableActions, playerPos, hazards, protocol });
  const objectives = cleanCodes(protocol.objectiveCodes, ['WIN']);
  const rules = cleanCodes(protocol.ruleCodes, []);
  const actionList = Object.keys(codes).join(',');
  const gameName = promptConfig.gameName || 'game';
  const level = Number.isInteger(sso.levelId) ? sso.levelId : 0;
  const targetText = target ? `${target.code}${target.x},${target.y}` : '-';
  const dxText = target ? sign(target.dx) : '0';
  const history = formatHistory(stateTracker, codes);
  const lines = [
    id,
    `G:${gameName} L:${level} T:${sso.gameTick || 0} S:${sso.gameScore || 0} HP:${sso.avatarHealthPoints || 0}`,
    `A:${actionList}`,
    `P:${playerPos ? `${playerPos[0]},${playerPos[1]}` : '-'}`,
    `O:${objectives.join('|')}`,
    `E:${formatEntities(targets)}`,
    `H:${formatEntities(hazards)}`,
    rules.length > 0 ? `R:${rules.join('|')}` : null,
    `D:target=${targetText} dx=${dxText} fire=${fire} dodge=${dodge}`,
    `B:${best}`,
    `M:${history}`,
    `ANS=[${actionList.replace(/,/g, '|')}]`,
    'ANS:'
  ].filter(Boolean);

  return {
    systemMessage: null,
    userMessage: lines.join('\n'),
    responseMode: 'code',
    actionCodeMap: codes,
    fallbackAction: codes[best] || codes.N || 'ACTION_NIL',
    fallbackActionCode: best,
    policyReason: policy?.reason || null,
    policyAuthoritative: protocol.authoritative === true
  };
}

module.exports = {
  buildCodePrompt,
  actionCodeMap,
  actionCodeForAction,
  DEFAULT_ACTION_CODES,
  chooseBestActionCode,
  choosePolicyActionCode
};
