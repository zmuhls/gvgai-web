const { buildStrategicDigestFromFile } = require('./vgdl-digest');
const { readGameRegistry } = require('./game-registry');

const CLASSIFIER_VERSION = 1;

const ARCHETYPES = [
  'shooter-lane',
  'shooter-roaming',
  'pusher-puzzle',
  'collector',
  'chaser',
  'survivor',
  'reflex-pilot',
  'navigator'
];

const PACES = ['twitch', 'reactive', 'deliberate'];

const REFLEX_AVATARS = new Set(['BirdAvatar', 'MissileAvatar', 'InertialAvatar']);
const SHOOT_LABELS = new Set(['SHOOT', 'FIRE', 'BOMB', 'ATTACK']);

// First-match ordered rules. Avatar-type rules come first (the control reality
// dominates whatever the interaction set says), then win-condition-driven rules,
// then scoring-driven rules — a Timeout win makes a game a survivor even when it
// also scores by collecting, and boulderdash's incidental dig-attack must not
// outrank its diamond collecting.
function deriveArchetype(digest) {
  const tags = new Set(digest.strategyTags || []);
  const avatarType = digest.avatar?.type || null;
  const useLabel = digest.controls?.useLabel || null;

  if (avatarType === 'FlakAvatar') return 'shooter-lane';
  if (REFLEX_AVATARS.has(avatarType)) return 'reflex-pilot';
  if (tags.has('position-puzzle')) return 'pusher-puzzle';
  if (tags.has('survive')) return 'survivor';
  if (tags.has('collect-resources') && tags.has('clear-objectives')) return 'collector';
  if (tags.has('use-action') && tags.has('attack-targets') && SHOOT_LABELS.has(useLabel)) return 'shooter-roaming';
  if (tags.has('attack-targets') && !tags.has('use-action')) return 'chaser';
  return 'navigator';
}

function deriveSubtypes(digest, archetype) {
  const tags = new Set(digest.strategyTags || []);
  const subtypes = [];
  if ((digest.hazards || []).length >= 3) subtypes.push('hazard-dense');
  if ((digest.loseConditions || []).includes('timeout')) subtypes.push('timed');
  if (tags.has('state-change')) subtypes.push('transform');
  if (tags.has('collect-resources') && archetype !== 'collector') subtypes.push('resource');
  if (digest.controls?.useLabel === 'DIG') subtypes.push('digger');
  if (tags.has('lane-control')) subtypes.push('lane');
  return subtypes;
}

// Pace is the axis that matters for the 40ms tick / ~10-tick-stale-decision
// constraint: twitch games can't be rescued by better prompts.
function derivePace(digest, physicsCategory) {
  if (physicsCategory === 'contphysics') return 'twitch';
  if (REFLEX_AVATARS.has(digest.avatar?.type)) return 'twitch';
  if ((digest.hazards || []).length > 0) return 'reactive';
  return 'deliberate';
}

// Pure classification over an already-built strategic digest. Never feeds back
// into the digest itself — adding fields to the hashed digest would churn every
// digestHash, which is the strategy-memory key.
function classifyDigest(digest, options = {}) {
  const physicsCategory = options.physicsCategory || null;
  const archetype = deriveArchetype(digest);
  return {
    classifierVersion: CLASSIFIER_VERSION,
    archetype,
    subtypes: deriveSubtypes(digest, archetype),
    pace: derivePace(digest, physicsCategory),
    inputs: {
      avatarType: digest.avatar?.type || null,
      physicsCategory
    }
  };
}

// Classify a registry game entry ({ id, name, vgdlPath, category }). Throw-safe:
// a VGDL that fails to parse gets the conservative fallback so batch runs over
// all 122 games never abort.
function classifyGame(game) {
  try {
    const digest = buildStrategicDigestFromFile(game.vgdlPath, {
      gameId: game.id,
      gameName: game.name
    });
    return classifyDigest(digest, { physicsCategory: game.category });
  } catch (error) {
    return {
      classifierVersion: CLASSIFIER_VERSION,
      archetype: 'navigator',
      subtypes: [],
      pace: game.category === 'contphysics' ? 'twitch' : 'deliberate',
      inputs: {
        avatarType: null,
        physicsCategory: game.category || null,
        error: error.message
      }
    };
  }
}

// VGDL files are static, so classification per game id is cached for the
// process lifetime (same rationale as the digestCache in routes/games-local.js).
const _classificationCache = new Map();
let _registry = null;

function clearClassifierCache() {
  _classificationCache.clear();
  _registry = null;
}

function getCachedClassification(gameId, options = {}) {
  const id = Number(gameId);
  if (!Number.isInteger(id)) return null;
  if (_classificationCache.has(id)) return _classificationCache.get(id);

  if (!_registry || options.projectRoot) {
    _registry = readGameRegistry(options.projectRoot);
  }
  const game = _registry.get(id);
  if (!game) return null;

  const classification = classifyGame(game);
  _classificationCache.set(id, classification);
  return classification;
}

module.exports = {
  CLASSIFIER_VERSION,
  ARCHETYPES,
  PACES,
  classifyDigest,
  classifyGame,
  getCachedClassification,
  clearClassifierCache
};
