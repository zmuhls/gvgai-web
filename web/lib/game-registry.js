const fs = require('fs');
const path = require('path');

function projectRoot() {
  return path.resolve(__dirname, '..', '..');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readFeaturedIds(root = projectRoot()) {
  const featuredPath = path.join(root, 'web', 'data', 'featured.json');
  const data = readJson(featuredPath, { featured: [] });
  return Array.isArray(data.featured)
    ? data.featured.map(Number).filter(Number.isInteger)
    : [];
}

function readGameRegistry(root = projectRoot()) {
  const csvPath = path.join(root, 'examples', 'all_games_sp.csv');
  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
  const registry = new Map();

  for (const line of lines) {
    const [idPart, filePart] = line.trim().split(',');
    const id = Number(idPart);
    const file = (filePart || '').trim();
    if (!Number.isInteger(id) || !file) continue;
    registry.set(id, {
      id,
      name: path.basename(file, '.txt'),
      file,
      relativePath: file,
      vgdlPath: path.join(root, file),
      category: file.includes('gridphysics') ? 'gridphysics' : 'contphysics'
    });
  }

  return registry;
}

function parseGameIds(value) {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return raw.map(Number).filter(Number.isInteger);
}

function selectGames(options = {}) {
  const root = options.projectRoot || projectRoot();
  const registry = options.registry || readGameRegistry(root);
  let ids;

  if (options.all) {
    ids = [...registry.keys()].sort((a, b) => a - b);
  } else {
    const requested = parseGameIds(options.gameIds ?? options.gameId);
    ids = requested.length > 0 ? requested : readFeaturedIds(root);
    if (options.gameCount) ids = ids.slice(0, Number(options.gameCount));
  }

  return ids.map(id => registry.get(id)).filter(Boolean);
}

module.exports = {
  projectRoot,
  readFeaturedIds,
  readGameRegistry,
  parseGameIds,
  selectGames
};
