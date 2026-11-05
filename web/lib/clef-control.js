// A CLEF choice may authorize a short key hold. Never choose a different key
// here: observe every tick, stop on uncertainty, then ask CLEF again.
const DIRECTIONS = {
  ACTION_LEFT: [-1, 0], ACTION_RIGHT: [1, 0],
  ACTION_UP: [0, -1], ACTION_DOWN: [0, 1]
};
const MAX_HOLD_TICKS = 6;

function position(sso) {
  return sso.avatarPosition?.map(v => v / sso.blockSize);
}

function moving(sso, action) {
  const from = position(sso), to = sso.actionOutcomes?.[action]?.immediate?.position;
  const direction = DIRECTIONS[action];
  if (!from || !to || !direction) return false;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  return direction[0] ? dx * direction[0] > 0 && Math.abs(dy) < 0.001
    : dy * direction[1] > 0 && Math.abs(dx) < 0.001;
}

function safeToHold(sso, action) {
  const candidate = sso.actionOutcomes?.[action];
  if (!candidate || candidate.riskSamples < 7 || candidate.immediateLosses !== 0 ||
      candidate.immediate?.terminal || candidate.immediate?.deadlocked ||
      candidate.immediate?.health < sso.avatarHealthPoints || candidate.immediate?.scoreDelta < 0 ||
      !(sso.availableActions || []).includes(action) ||
      (action !== 'ACTION_USE' && !moving(sso, action))) return false;
  const here = position(sso), next = candidate.immediate.position;
  // Nearby dynamic sprites can change the right decision before the next tick.
  // Movables include pushable puzzle objects; those stay under single-step control.
  for (const sprite of [...(sso.NPCPositions || []).flat(), ...(sso.movablePositions || []).flat()]) {
    const p = sprite.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    const x = p.x / sso.blockSize, y = p.y / sso.blockSize;
    if (Math.min(Math.abs(x-here[0])+Math.abs(y-here[1]),
      Math.abs(x-next[0])+Math.abs(y-next[1])) <= 3) return false;
  }
  return true;
}

function limits(sso, gameName, requestedTicks = 1) {
  const max = Math.max(1, Math.min(MAX_HOLD_TICKS, Math.floor(Number(requestedTicks)) || 1));
  return Object.fromEntries((sso.availableActions || []).map(action => [action,
    gameName !== 'sokoban' && safeToHold(sso, action) ? max : 1]));
}

function mayContinue(hold, sso, revision) {
  if (!hold || hold.remaining < 1 || revision !== hold.revision ||
      sso.gameTick !== hold.previous.gameTick + 1 || sso.isGameOver ||
      sso.avatarType !== hold.previous.avatarType ||
      sso.avatarHealthPoints < hold.previous.avatarHealthPoints ||
      sso.gameScore < hold.previous.gameScore ||
      JSON.stringify(sso.avatarResources) !== JSON.stringify(hold.previous.avatarResources) ||
      !safeToHold(sso, hold.action)) return false;
  const here = position(sso), before = position(hold.previous);
  const expected = hold.previous.actionOutcomes?.[hold.action]?.immediate?.position;
  if (!here || !before || !expected || here.some((v,i) => Math.abs(v-expected[i]) > 0.001)) return false;
  if (hold.action === 'ACTION_USE') return true;
  if (here.every((v,i) => v === before[i])) return false;
  // Stop at a newly opened perpendicular turn, rather than sailing past it.
  const direction = DIRECTIONS[hold.action];
  const turns = direction[0] ? ['ACTION_UP', 'ACTION_DOWN'] : ['ACTION_LEFT', 'ACTION_RIGHT'];
  return !turns.some(action => moving(sso, action) && !moving(hold.previous, action));
}

module.exports = { limits, mayContinue, MAX_HOLD_TICKS };
