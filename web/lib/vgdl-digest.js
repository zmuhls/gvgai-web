const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIGEST_SCHEMA_VERSION = 1;

function normalizeVGDL(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.replace(/\t/g, '    ').replace(/\s+$/g, ''))
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('#');
    })
    .join('\n');
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseProperties(tokens) {
  const props = {};
  for (const token of tokens) {
    const index = token.indexOf('=');
    if (index > 0) {
      props[token.slice(0, index)] = token.slice(index + 1);
    }
  }
  return props;
}

function parseVGDL(content) {
  const lines = String(content || '').split(/\r?\n/);
  const result = {
    avatarType: null,
    avatarStype: null,
    sprites: {},
    interactions: [],
    terminations: [],
    hasKeyHandler: null
  };

  const firstLine = lines.find(line => line.trim() && !line.trim().startsWith('#')) || '';
  const keyHandlerMatch = firstLine.match(/key_handler=(\w+)/);
  if (keyHandlerMatch) result.hasKeyHandler = keyHandlerMatch[1];

  let section = null;
  const indentStack = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'SpriteSet') { section = 'sprites'; continue; }
    if (trimmed === 'InteractionSet') { section = 'interactions'; continue; }
    if (trimmed === 'TerminationSet') { section = 'terminations'; continue; }
    if (trimmed === 'LevelMapping') { section = 'levelmapping'; continue; }

    if (section === 'sprites') {
      const spriteMatch = trimmed.match(/^(\w+)\s*>\s*(.*)/);
      if (!spriteMatch) continue;

      const name = spriteMatch[1];
      const rest = spriteMatch[2].trim();
      const indent = rawLine.replace(/\t/g, '    ').search(/\S/);
      const tokens = rest.split(/\s+/).filter(Boolean);
      let type = null;
      const props = {};

      for (const token of tokens) {
        if (token.includes('=')) {
          const index = token.indexOf('=');
          props[token.slice(0, index)] = token.slice(index + 1);
        } else if (!type) {
          type = token;
        }
      }

      while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indent) {
        indentStack.pop();
      }
      const parent = indentStack.length > 0 ? indentStack[indentStack.length - 1].name : null;
      indentStack.push({ name, indent });

      result.sprites[name] = { type, parent, props, indent };

      const isAvatarType = type && (
        type.includes('Avatar') ||
        type === 'FlakAvatar' ||
        type === 'ShootAvatar' ||
        type === 'MovingAvatar' ||
        type === 'OrientedAvatar' ||
        type === 'HorizontalAvatar' ||
        type === 'VerticalAvatar' ||
        type === 'MissileAvatar' ||
        type === 'PlatformerAvatar' ||
        type === 'BirdAvatar' ||
        type === 'NullAvatar' ||
        type === 'InertialAvatar'
      );
      const nameIsAvatar = name === 'avatar' || name === 'bomberman' || name === 'pacman';

      if (isAvatarType || nameIsAvatar) {
        if (type && type.includes('Avatar')) result.avatarType = type;
        if (props.stype) result.avatarStype = props.stype;
      }
    }

    if (section === 'interactions') {
      const interactionMatch = trimmed.match(/^(.+?)\s*>\s*(.+)/);
      if (!interactionMatch) continue;
      const leftSide = interactionMatch[1].trim().split(/\s+/);
      const rightTokens = interactionMatch[2].trim().split(/\s+/);
      result.interactions.push({
        sprites: leftSide,
        effect: rightTokens[0],
        props: parseProperties(rightTokens.slice(1))
      });
    }

    if (section === 'terminations') {
      const tokens = trimmed.split(/\s+/);
      result.terminations.push({
        type: tokens[0],
        props: parseProperties(tokens.slice(1))
      });
    }
  }

  if (!result.avatarType) {
    for (const sprite of Object.values(result.sprites)) {
      if (sprite.type && sprite.type.includes('Avatar')) {
        result.avatarType = sprite.type;
        if (sprite.props.stype) result.avatarStype = sprite.props.stype;
        break;
      }
    }
  }

  return result;
}

function getActionLabels(parsed) {
  const avatarType = parsed.avatarType || 'MovingAvatar';
  const stype = parsed.avatarStype;
  let useLabel = 'USE';

  if (stype) {
    const stypeLower = stype.toLowerCase();
    const stypeSprite = parsed.sprites[stype];
    const stypeType = stypeSprite?.type?.toLowerCase() || '';
    const stypeParent = stypeSprite?.parent?.toLowerCase() || '';

    if (stypeLower.includes('bomb') || stypeType.includes('bomb')) {
      useLabel = 'BOMB';
    } else if (stypeLower.includes('sword') || stypeLower.includes('slash') || stypeLower.includes('blade')) {
      useLabel = 'ATTACK';
    } else if (stypeLower.includes('shovel') || stypeLower.includes('pick') || stypeLower.includes('dig')) {
      useLabel = 'DIG';
    } else if (stypeLower.includes('beam') || stypeLower.includes('laser')) {
      useLabel = 'FIRE';
    } else if (
      stypeType === 'missile' ||
      stypeParent === 'missile' ||
      stypeLower.includes('sam') ||
      stypeLower.includes('bullet') ||
      stypeLower.includes('missile') ||
      stypeLower.includes('arrow') ||
      stypeLower.includes('fire')
    ) {
      useLabel = 'SHOOT';
    } else if (stypeType.includes('flicker') || stypeType.includes('oriented')) {
      useLabel = 'ATTACK';
    } else {
      useLabel = 'SHOOT';
    }
  }

  switch (avatarType) {
    case 'FlakAvatar':
      return { actions: ['LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['LEFT', 'RIGHT'], useLabel };
    case 'HorizontalAvatar':
      return { actions: ['LEFT', 'RIGHT', 'WAIT'], directions: ['LEFT', 'RIGHT'], useLabel };
    case 'VerticalAvatar':
      return { actions: ['UP', 'DOWN', 'WAIT'], directions: ['UP', 'DOWN'], useLabel };
    case 'ShootAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'], useLabel };
    case 'OrientedAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'], useLabel };
    case 'PlatformerAvatar':
      return { actions: ['LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['LEFT', 'RIGHT'], useLabel };
    case 'BirdAvatar':
      return { actions: ['UP', 'WAIT'], directions: ['UP'], useLabel };
    case 'MissileAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'], useLabel };
    case 'NullAvatar':
      return { actions: [useLabel, 'WAIT'], directions: [], useLabel };
    case 'InertialAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'], useLabel };
    case 'MovingAvatar':
    default:
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'], useLabel };
  }
}

function isAvatarSprite(name, parsed) {
  if (name === 'avatar') return true;
  let current = name;
  for (let i = 0; i < 5; i++) {
    const sprite = parsed.sprites[current];
    if (!sprite) break;
    if (sprite.parent === 'avatar' || sprite.parent === 'bomberman' || sprite.parent === 'pacman') return true;
    if (sprite.type && sprite.type.includes('Avatar')) return true;
    current = sprite.parent;
    if (!current) break;
  }
  const sprite = parsed.sprites[name];
  return Boolean(sprite && sprite.type && sprite.type.includes('Avatar'));
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function summarizeGameParts(parsed) {
  const scoring = [];
  const hazards = [];
  const winConditions = [];
  const loseConditions = [];
  const mechanics = [];

  for (const interaction of parsed.interactions) {
    const [first, second] = interaction.sprites;
    const avatarInvolved = interaction.sprites.some(sprite => isAvatarSprite(sprite, parsed));

    if (interaction.props.scoreChange) {
      const score = Number.parseInt(interaction.props.scoreChange, 10);
      if (avatarInvolved) {
        const other = isAvatarSprite(first, parsed) ? second : first;
        if (score > 0) {
          if (interaction.effect === 'killSprite' || interaction.effect === 'killBoth') {
            pushUnique(scoring, `kill ${other} (+${score})`);
          } else if (interaction.effect === 'collectResource' || interaction.effect === 'transformTo') {
            pushUnique(scoring, `collect ${other} (+${score})`);
          } else {
            pushUnique(scoring, `${other} (+${score})`);
          }
        } else {
          pushUnique(scoring, `${other} (${score})`);
        }
      } else if (score > 0) {
        pushUnique(scoring, `${first} hit by ${second} (+${score})`);
      }
    }

    if ((interaction.effect === 'killSprite' || interaction.effect === 'killBoth') && isAvatarSprite(first, parsed)) {
      pushUnique(hazards, second);
    }
    if (interaction.effect === 'transformTo' && avatarInvolved) {
      const other = interaction.sprites.find(sprite => !isAvatarSprite(sprite, parsed));
      pushUnique(mechanics, other ? `collect ${other} to transform` : null);
    }
    if (interaction.effect === 'collectResource' && avatarInvolved) {
      const other = interaction.sprites.find(sprite => !isAvatarSprite(sprite, parsed));
      pushUnique(mechanics, other ? `collect ${other}` : null);
    }
    if (interaction.effect === 'bounceForward') pushUnique(mechanics, `push ${first}`);
    if (interaction.effect === 'pullWithIt') pushUnique(mechanics, `ride on ${second}`);
  }

  for (const termination of parsed.terminations) {
    const win = termination.props.win === 'True';
    const stype = termination.props.stype || termination.props.stype1;
    const limit = termination.props.limit || '0';

    if (termination.type === 'SpriteCounter') {
      if (win) {
        pushUnique(winConditions, limit === '0' ? `clear all ${stype}` : `${stype} count reaches ${limit}`);
      } else if (stype && isAvatarSprite(stype, parsed)) {
        pushUnique(loseConditions, 'die');
      } else {
        pushUnique(loseConditions, `${stype} count reaches ${limit}`);
      }
    } else if (termination.type === 'MultiSpriteCounter') {
      const types = [termination.props.stype1, termination.props.stype2].filter(Boolean);
      pushUnique(win ? winConditions : loseConditions, `${win ? 'clear all' : 'all'} ${types.join(' and ')}${win ? '' : ' gone'}`);
    } else if (termination.type === 'Timeout') {
      pushUnique(win ? winConditions : loseConditions, win ? 'survive until timeout' : 'timeout');
    }
  }

  return { scoring, hazards, winConditions, loseConditions, mechanics };
}

function summarizeGameLogic(parsed) {
  const parts = summarizeGameParts(parsed);
  const lines = [];
  if (parts.scoring.length > 0) lines.push(`Scoring: ${parts.scoring.join(', ')}.`);
  if (parts.hazards.length > 0) lines.push(`Avoid: ${parts.hazards.join(', ')}.`);
  if (parts.winConditions.length > 0) lines.push(`Win: ${parts.winConditions.join('; ')}.`);
  if (parts.loseConditions.length > 0) lines.push(`Lose: ${parts.loseConditions.join('; ')}.`);
  if (parts.mechanics.length > 0) lines.push(`Mechanics: ${parts.mechanics.join(', ')}.`);
  return lines.join(' ');
}

function deriveStrategyTags(parts, parsed, controls) {
  const tags = [];
  if (parts.hazards.length > 0) tags.push('avoid-collisions');
  if (parts.scoring.some(item => /\bcollect\b/.test(item))) tags.push('collect-resources');
  if (parts.scoring.some(item => /\bkill\b|hit by/.test(item))) tags.push('attack-targets');
  if (parts.mechanics.some(item => /\bpush\b/.test(item))) tags.push('position-puzzle');
  if (parts.mechanics.some(item => /\btransform\b/.test(item))) tags.push('state-change');
  if (parts.winConditions.some(item => /\bclear all\b/.test(item))) tags.push('clear-objectives');
  if (parts.winConditions.some(item => /\btimeout\b/.test(item))) tags.push('survive');
  if (controls.actions.some(action => ['SHOOT', 'ATTACK', 'FIRE', 'BOMB', 'DIG'].includes(action))) tags.push('use-action');
  if (parsed.avatarType === 'FlakAvatar') tags.push('lane-control');
  return tags.length > 0 ? [...new Set(tags)] : ['balanced-navigation'];
}

function buildPromptText(digest) {
  const lines = [
    `Strategic digest ${digest.digestHash.slice(7, 19)} for ${digest.gameName}.`,
    `Controls: ${digest.controls.actions.join('|')}. Avatar: ${digest.avatar.type || 'unknown'}.`
  ];
  if (digest.scoring.length > 0) lines.push(`Score by: ${digest.scoring.join(', ')}.`);
  if (digest.hazards.length > 0) lines.push(`Avoid: ${digest.hazards.join(', ')}.`);
  if (digest.mechanics.length > 0) lines.push(`Mechanics: ${digest.mechanics.join(', ')}.`);
  if (digest.winConditions.length > 0) lines.push(`Win: ${digest.winConditions.join('; ')}.`);
  if (digest.loseConditions.length > 0) lines.push(`Lose: ${digest.loseConditions.join('; ')}.`);
  lines.push(`Strategy tags: ${digest.strategyTags.join(', ')}.`);
  return lines.join('\n');
}

function buildStrategicDigest(content, options = {}) {
  const normalized = normalizeVGDL(content);
  const parsed = parseVGDL(content);
  const controls = getActionLabels(parsed);
  const parts = summarizeGameParts(parsed);
  const baseDigest = {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    gameId: options.gameId ?? null,
    gameName: options.gameName || 'unknown',
    rulesHash: sha256(normalized),
    avatar: {
      type: parsed.avatarType || null,
      stype: parsed.avatarStype || null,
      keyHandler: parsed.hasKeyHandler || null
    },
    controls: {
      actions: controls.actions,
      directions: controls.directions,
      useLabel: controls.useLabel
    },
    scoring: parts.scoring,
    hazards: parts.hazards,
    mechanics: parts.mechanics,
    winConditions: parts.winConditions,
    loseConditions: parts.loseConditions,
    strategyTags: deriveStrategyTags(parts, parsed, controls)
  };
  const digestHash = sha256(stableStringify(baseDigest));
  const digest = { ...baseDigest, digestHash };
  return { ...digest, promptText: buildPromptText(digest) };
}

function buildStrategicDigestFromFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return buildStrategicDigest(content, {
    gameName: options.gameName || path.basename(filePath, '.txt'),
    gameId: options.gameId
  });
}

module.exports = {
  DIGEST_SCHEMA_VERSION,
  normalizeVGDL,
  sha256,
  stableStringify,
  parseVGDL,
  getActionLabels,
  isAvatarSprite,
  summarizeGameParts,
  summarizeGameLogic,
  deriveStrategyTags,
  buildStrategicDigest,
  buildStrategicDigestFromFile
};
