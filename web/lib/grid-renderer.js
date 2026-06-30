// Convert GVGAI observationGrid to ASCII character map for LLM spatial awareness

// Default category-to-symbol mapping (game-agnostic)
const CATEGORY_SYMBOLS = {
  0: '@',  // TYPE_AVATAR - player
  1: '$',  // TYPE_RESOURCE - collectible
  2: 'O',  // TYPE_PORTAL - portal/spawner
  3: 'E',  // TYPE_NPC - enemy
  4: '#',  // TYPE_STATIC - wall/immovable
  5: '*',  // TYPE_FROMAVATAR - player projectile
  6: 'M',  // TYPE_MOVABLE - movable object
};

const DEFAULT_LEGEND = '@ = you, E = enemy, # = wall, . = empty, $ = item, O = portal, * = projectile, M = movable';

// Priority order for rendering when multiple sprites occupy same cell
// Lower index = higher priority (avatar > npc > projectile > resource > portal > movable > static)
const CATEGORY_PRIORITY = [0, 3, 5, 1, 2, 6, 4];

/**
 * Detect background sprite itypes by finding category-4 sprites present in >90% of cells.
 * Call once on first tick, then cache the result.
 * @param {Object} sso - Parsed SSO JSON
 * @returns {Set<number>} Set of itype values considered background
 */
function detectBackgroundItypes(sso) {
  const grid = sso.observationGrid;
  if (!grid) return new Set();

  const cols = sso.observationGridNum || 0;
  const rows = sso.observationGridMaxRow || 0;
  if (cols === 0 || rows === 0) return new Set();

  const totalCells = cols * rows;
  const itypeCounts = new Map(); // itype -> count of cells containing it

  for (let x = 0; x < cols; x++) {
    if (!grid[x]) continue;
    for (let y = 0; y < rows; y++) {
      const cell = grid[x][y];
      if (!cell) continue;
      const seenInCell = new Set();
      for (const obs of cell) {
        if (obs && obs.category === 4 && obs.itype >= 0 && !seenInCell.has(obs.itype)) {
          seenInCell.add(obs.itype);
          itypeCounts.set(obs.itype, (itypeCounts.get(obs.itype) || 0) + 1);
        }
      }
    }
  }

  const backgroundItypes = new Set();
  for (const [itype, count] of itypeCounts) {
    if (count / totalCells > 0.9) {
      backgroundItypes.add(itype);
    }
  }
  return backgroundItypes;
}

/**
 * Render the observation grid as an ASCII character map.
 * @param {Object} sso - Parsed SSO JSON containing observationGrid
 * @param {Object|null} gameSymbolMap - Optional per-game itype-to-character mapping (string keys)
 * @param {Set<number>|null} backgroundItypes - Set of itype values to treat as empty background
 * @returns {string|null} ASCII grid string, or null if no grid data
 */
function renderAsciiGrid(sso, gameSymbolMap, backgroundItypes) {
  const grid = sso.observationGrid;
  if (!grid) return null;

  const cols = sso.observationGridNum || 0;
  const rows = sso.observationGridMaxRow || 0;
  if (cols === 0 || rows === 0) return null;

  const bgSet = backgroundItypes || new Set();
  const lines = [];

  // observationGrid is [x][y][sprites] — iterate y as outer loop for row-by-row output
  for (let y = 0; y < rows; y++) {
    let row = '';
    for (let x = 0; x < cols; x++) {
      const cell = grid[x] && grid[x][y];
      if (!cell || cell.length === 0) {
        row += '.';
        continue;
      }

      // Filter out background sprites and null entries
      const sprites = [];
      for (const obs of cell) {
        if (!obs || obs.category === undefined || obs.category < 0) continue;
        if (obs.category === 4 && bgSet.has(obs.itype)) continue;
        sprites.push(obs);
      }

      if (sprites.length === 0) {
        row += '.';
        continue;
      }

      // Pick highest-priority sprite
      let best = sprites[0];
      let bestPri = CATEGORY_PRIORITY.indexOf(best.category);
      if (bestPri === -1) bestPri = CATEGORY_PRIORITY.length;

      for (let i = 1; i < sprites.length; i++) {
        let pri = CATEGORY_PRIORITY.indexOf(sprites[i].category);
        if (pri === -1) pri = CATEGORY_PRIORITY.length;
        if (pri < bestPri) {
          best = sprites[i];
          bestPri = pri;
        }
      }

      // Use game-specific itype mapping if available
      if (gameSymbolMap && gameSymbolMap[String(best.itype)] !== undefined) {
        row += gameSymbolMap[String(best.itype)];
      } else {
        row += CATEGORY_SYMBOLS[best.category] || '?';
      }
    }
    lines.push(row);
  }

  return lines.join('\n');
}

module.exports = {
  renderAsciiGrid,
  detectBackgroundItypes,
  CATEGORY_SYMBOLS,
  DEFAULT_LEGEND,
};
