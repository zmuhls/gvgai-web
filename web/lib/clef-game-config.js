const fs = require('node:fs');
const { readGameRegistry } = require('./game-registry');

// The same source rules drive validation and interactive play. No generated
// rule digest or stored human trace can silently replace the game mechanics.
function clefGameConfig(gameId) {
  const game = readGameRegistry().get(Number(gameId));
  if (!game) throw new Error('Unknown GVGAI game');
  return { gameName: game.name, gameContent: fs.readFileSync(game.vgdlPath, 'utf8') };
}

module.exports = { clefGameConfig };
