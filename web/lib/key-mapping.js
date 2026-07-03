'use strict';

/**
 * Raw mapping of KeyboardEvent.code → GVGAI action name.
 */
const FULL_KEY_MAP = {
  // Arrow keys
  ArrowLeft: 'ACTION_LEFT',
  ArrowRight: 'ACTION_RIGHT',
  ArrowUp: 'ACTION_UP',
  ArrowDown: 'ACTION_DOWN',
  // Action keys
  Space: 'ACTION_USE',
  Enter: 'ACTION_USE',
  // Z/X/C as alternative action keys
  KeyZ: 'ACTION_USE',
  KeyX: 'ACTION_USE',
  KeyC: 'ACTION_USE',
  // WASD as alternative movement keys
  KeyA: 'ACTION_LEFT',
  KeyD: 'ACTION_RIGHT',
  KeyW: 'ACTION_UP',
  KeyS: 'ACTION_DOWN',
};

/**
 * Convert a KeyboardEvent.code into a human-readable label.
 * ArrowLeft → "Left", KeyA → "A", Space → "SPACE", Enter → "ENTER"
 */
function keyLabel(code) {
  if (code.startsWith('Arrow')) {
    return code.slice(5); // "Left", "Right", "Up", "Down"
  }
  if (code.startsWith('Key')) {
    return code.slice(3); // single letter
  }
  if (code === 'Space') return 'SPACE';
  if (code === 'Enter') return 'ENTER';
  return code;
}

/**
 * Map a browser KeyboardEvent.code to a GVGAI action name.
 *
 * @param {string} code - The KeyboardEvent.code value.
 * @param {string[]} [availableActions] - Optional list of actions the current game supports.
 *   If provided, returns null when the mapped action isn't in this list.
 * @returns {string|null} The action name, or null.
 */
function mapKeyToAction(code, availableActions) {
  const action = FULL_KEY_MAP[code];
  if (!action) return null;
  if (availableActions && !availableActions.includes(action)) return null;
  return action;
}

/**
 * Build an on-screen control reference for the given game.
 *
 * @param {string[]} [availableActions] - Actions the game supports. If omitted, all mapped actions are included.
 * @param {Object<string,string>} [actionAliases] - Per-game labels, e.g. { ACTION_USE: "SHOOT" }.
 * @returns {Array<{keys: string[], action: string, label: string}>}
 */
function buildControlReference(availableActions, actionAliases) {
  // Group keys by action
  const groups = {};
  for (const [code, action] of Object.entries(FULL_KEY_MAP)) {
    if (availableActions && !availableActions.includes(action)) continue;
    if (!groups[action]) {
      groups[action] = [];
    }
    groups[action].push(keyLabel(code));
  }

  // Build entries, preferring the order actions appear in availableActions
  let actionOrder;
  if (availableActions && availableActions.length > 0) {
    actionOrder = availableActions.filter(a => groups[a]);
  } else {
    actionOrder = Object.keys(groups);
  }

  return actionOrder.map(action => ({
    keys: groups[action],
    action,
    label: (actionAliases && actionAliases[action]) || action,
  }));
}

module.exports = {
  FULL_KEY_MAP,
  mapKeyToAction,
  buildControlReference,
};