#!/usr/bin/env node
// Parses all VGDL game definitions and generates compact LLM prompt configs
// for every game in the library.
//
// Usage: node web/scripts/generate-game-prompts.js [--dry-run]

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CSV_PATH = path.join(PROJECT_ROOT, 'examples', 'all_games_sp.csv');
const GAMES_DIR = path.join(__dirname, '..', 'data', 'games');
const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const INDEX_PATH = path.join(TEMPLATES_DIR, '_index.json');

const dryRun = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// VGDL parser — extracts avatar type, interactions, termination, and sprites
// ---------------------------------------------------------------------------

function parseVGDL(content) {
  const lines = content.split('\n');
  const result = {
    avatarType: null,
    avatarStype: null,       // what USE spawns (projectile/weapon)
    avatarParentChain: [],   // for nested avatar definitions
    sprites: {},             // name → { type, parent, props }
    interactions: [],        // { sprite1, sprite2, effect, props }
    terminations: [],        // { type, props }
    hasKeyHandler: null,
  };

  // Check for key_handler
  const firstLine = lines[0] || '';
  const khMatch = firstLine.match(/key_handler=(\w+)/);
  if (khMatch) result.hasKeyHandler = khMatch[1];

  let section = null;
  const indentStack = []; // track sprite hierarchy by indent level

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Detect section headers
    if (trimmed === 'SpriteSet') { section = 'sprites'; continue; }
    if (trimmed === 'InteractionSet') { section = 'interactions'; continue; }
    if (trimmed === 'TerminationSet') { section = 'terminations'; continue; }
    if (trimmed === 'LevelMapping') { section = 'levelmapping'; continue; }

    if (section === 'sprites') {
      // Parse sprite definition: name > Type prop1=val1 prop2=val2
      const spriteMatch = trimmed.match(/^(\w+)\s*>\s*(.*)/);
      if (!spriteMatch) continue;

      const name = spriteMatch[1];
      const rest = spriteMatch[2].trim();

      // Determine indent level for hierarchy
      const indent = rawLine.search(/\S/);

      // Parse type and properties
      const tokens = rest.split(/\s+/).filter(Boolean);
      let type = null;
      const props = {};

      for (const token of tokens) {
        if (token.includes('=')) {
          const [k, v] = token.split('=');
          props[k] = v;
        } else if (!type) {
          type = token;
        }
      }

      // Track hierarchy
      while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indent) {
        indentStack.pop();
      }
      const parent = indentStack.length > 0 ? indentStack[indentStack.length - 1].name : null;
      indentStack.push({ name, indent });

      result.sprites[name] = { type, parent, props, indent };

      // Detect avatar
      const isAvatar = type && (
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
        type === 'NullAvatar'
      );
      // Also check if the name is 'avatar' or parent chain includes avatar
      const nameIsAvatar = name === 'avatar' || name === 'bomberman' || name === 'pacman';

      if (isAvatar || nameIsAvatar) {
        if (type && type.includes('Avatar')) {
          result.avatarType = type;
        }
        if (props.stype) {
          result.avatarStype = props.stype;
        }
      }

      // Check if parent is avatar-like (sub-avatars like nokey/withkey in zelda)
      if (parent && (parent === 'avatar' || parent === 'bomberman' || parent === 'pacman')) {
        // This is a sub-avatar state, not a new avatar type
      }
    }

    if (section === 'interactions') {
      // Parse: sprite1 sprite2 [sprite3...] > effect prop1=val1 ...
      const intMatch = trimmed.match(/^(.+?)\s*>\s*(.+)/);
      if (!intMatch) continue;

      const leftSide = intMatch[1].trim().split(/\s+/);
      const rightSide = intMatch[2].trim();
      const rightTokens = rightSide.split(/\s+/);
      const effect = rightTokens[0];
      const props = {};
      for (let i = 1; i < rightTokens.length; i++) {
        if (rightTokens[i].includes('=')) {
          const [k, v] = rightTokens[i].split('=');
          props[k] = v;
        }
      }

      result.interactions.push({
        sprites: leftSide,
        effect,
        props
      });
    }

    if (section === 'terminations') {
      // Parse: TermType prop1=val1 prop2=val2
      const tokens = trimmed.split(/\s+/);
      const type = tokens[0];
      const props = {};
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i].includes('=')) {
          const [k, v] = tokens[i].split('=');
          props[k] = v;
        }
      }
      result.terminations.push({ type, props });
    }
  }

  // If avatar type wasn't found directly, search sprites for avatar-like entries
  if (!result.avatarType) {
    for (const [name, sprite] of Object.entries(result.sprites)) {
      if (sprite.type && sprite.type.includes('Avatar')) {
        result.avatarType = sprite.type;
        if (sprite.props.stype) result.avatarStype = sprite.props.stype;
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Action mapping — avatar type → friendly action names
// ---------------------------------------------------------------------------

function getActionLabels(parsed) {
  const avatarType = parsed.avatarType || 'MovingAvatar';
  const stype = parsed.avatarStype;

  // Determine what USE does based on the avatar's stype (projectile/weapon)
  let useLabel = 'USE';
  if (stype) {
    const stypeLower = stype.toLowerCase();
    // Check what the stype sprite actually is
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
    } else if (stypeType === 'missile' || stypeParent === 'missile' ||
               stypeLower.includes('sam') || stypeLower.includes('bullet') ||
               stypeLower.includes('missile') || stypeLower.includes('arrow') ||
               stypeLower.includes('fire')) {
      useLabel = 'SHOOT';
    } else {
      // Default: if the stype is a flicker (melee) → ATTACK, if missile-like → SHOOT
      if (stypeType.includes('flicker') || stypeType.includes('oriented')) {
        useLabel = 'ATTACK';
      } else {
        useLabel = 'SHOOT';
      }
    }
  }

  switch (avatarType) {
    case 'FlakAvatar':
      return { actions: ['LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['LEFT', 'RIGHT'] };
    case 'HorizontalAvatar':
      return { actions: ['LEFT', 'RIGHT', 'WAIT'], directions: ['LEFT', 'RIGHT'] };
    case 'VerticalAvatar':
      return { actions: ['UP', 'DOWN', 'WAIT'], directions: ['UP', 'DOWN'] };
    case 'ShootAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'] };
    case 'OrientedAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'] };
    case 'PlatformerAvatar':
      return { actions: ['LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['LEFT', 'RIGHT'] };
    case 'BirdAvatar':
      return { actions: ['UP', 'WAIT'], directions: ['UP'] };
    case 'MissileAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', useLabel, 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'] };
    case 'NullAvatar':
      return { actions: [useLabel, 'WAIT'], directions: [] };
    case 'InertialAvatar':
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'] };
    case 'MovingAvatar':
    default:
      return { actions: ['UP', 'DOWN', 'LEFT', 'RIGHT', 'WAIT'], directions: ['UP', 'DOWN', 'LEFT', 'RIGHT'] };
  }
}

// ---------------------------------------------------------------------------
// Game logic summarizer — extracts scoring, hazards, objectives from VGDL
// ---------------------------------------------------------------------------

function isAvatarSprite(name, parsed) {
  if (name === 'avatar') return true;
  // Check if it's a child of avatar
  let current = name;
  for (let i = 0; i < 5; i++) {
    const sprite = parsed.sprites[current];
    if (!sprite) break;
    if (sprite.parent === 'avatar' || sprite.parent === 'bomberman' || sprite.parent === 'pacman') return true;
    if (sprite.type && sprite.type.includes('Avatar')) return true;
    current = sprite.parent;
    if (!current) break;
  }
  // Also check by type
  const sprite = parsed.sprites[name];
  if (sprite && sprite.type && sprite.type.includes('Avatar')) return true;
  return false;
}

function getSpriteDisplayName(name, parsed) {
  // Clean up sprite names for display
  return name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}

function summarizeGameLogic(parsed, gameName) {
  const parts = [];

  // 1. Scoring interactions
  const scoring = [];
  for (const int of parsed.interactions) {
    if (int.props.scoreChange) {
      const score = parseInt(int.props.scoreChange);
      const s1 = int.sprites[0];
      const s2 = int.sprites[1];
      const avatarInvolved = int.sprites.some(s => isAvatarSprite(s, parsed));

      if (avatarInvolved) {
        const other = isAvatarSprite(s1, parsed) ? s2 : s1;
        if (score > 0) {
          if (int.effect === 'killSprite' || int.effect === 'killBoth') {
            scoring.push(`kill ${other} (+${score})`);
          } else if (int.effect === 'collectResource' || int.effect === 'transformTo') {
            scoring.push(`collect ${other} (+${score})`);
          } else {
            scoring.push(`${other} (+${score})`);
          }
        } else {
          scoring.push(`${other} (${score})`);
        }
      } else {
        // Non-avatar scoring (e.g., bomb kills enemy)
        if (score > 0) {
          scoring.push(`${s1} hit by ${s2} (+${score})`);
        }
      }
    }
  }

  if (scoring.length > 0) {
    parts.push(`Scoring: ${scoring.join(', ')}.`);
  }

  // 2. What kills the avatar (hazards)
  const hazards = [];
  for (const int of parsed.interactions) {
    if (int.effect === 'killSprite' || int.effect === 'killBoth') {
      const s1 = int.sprites[0];
      if (isAvatarSprite(s1, parsed)) {
        hazards.push(int.sprites[1]);
      }
    }
  }
  if (hazards.length > 0) {
    const uniqueHazards = [...new Set(hazards)];
    parts.push(`Avoid: ${uniqueHazards.join(', ')}.`);
  }

  // 3. Win/lose conditions
  const winConditions = [];
  const loseConditions = [];
  for (const term of parsed.terminations) {
    const win = term.props.win === 'True';
    const stype = term.props.stype || term.props.stype1;
    const limit = term.props.limit || '0';

    if (term.type === 'SpriteCounter') {
      if (win) {
        if (limit === '0') winConditions.push(`clear all ${stype}`);
        else winConditions.push(`${stype} count reaches ${limit}`);
      } else {
        if (stype && isAvatarSprite(stype, parsed)) {
          loseConditions.push('die');
        } else {
          loseConditions.push(`${stype} count reaches ${limit}`);
        }
      }
    } else if (term.type === 'MultiSpriteCounter') {
      const types = [term.props.stype1, term.props.stype2].filter(Boolean);
      if (win) winConditions.push(`clear all ${types.join(' and ')}`);
      else loseConditions.push(`all ${types.join(' and ')} gone`);
    } else if (term.type === 'Timeout') {
      if (win) winConditions.push('survive until timeout');
      else loseConditions.push('timeout');
    }
  }

  if (winConditions.length > 0) parts.push(`Win: ${winConditions.join('; ')}.`);
  if (loseConditions.length > 0) parts.push(`Lose: ${loseConditions.join('; ')}.`);

  // 4. Key mechanics (transformTo with key, resource collection, etc.)
  const mechanics = [];
  for (const int of parsed.interactions) {
    if (int.effect === 'transformTo' && int.sprites.some(s => isAvatarSprite(s, parsed))) {
      const other = int.sprites.find(s => !isAvatarSprite(s, parsed));
      if (other && !mechanics.includes(`collect ${other}`)) {
        mechanics.push(`collect ${other} to transform`);
      }
    }
    if (int.effect === 'collectResource' && int.sprites.some(s => isAvatarSprite(s, parsed))) {
      const other = int.sprites.find(s => !isAvatarSprite(s, parsed));
      if (other && !mechanics.includes(`collect ${other}`)) {
        mechanics.push(`collect ${other}`);
      }
    }
    if (int.effect === 'bounceForward') {
      mechanics.push(`push ${int.sprites[0]}`);
    }
    if (int.effect === 'pullWithIt') {
      mechanics.push(`ride on ${int.sprites[1]}`);
    }
  }

  if (mechanics.length > 0) {
    // Deduplicate
    const unique = [...new Set(mechanics)];
    if (unique.length > 0) parts.push(`Mechanics: ${unique.join(', ')}.`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Generate prompt config for a single game
// ---------------------------------------------------------------------------

function generateGameConfig(gameId, vgdlPath, gameName) {
  const content = fs.readFileSync(vgdlPath, 'utf-8');
  const parsed = parseVGDL(content);
  const { actions } = getActionLabels(parsed);
  const logic = summarizeGameLogic(parsed, gameName);

  // Build the compact customOverride prompt
  const controlLine = `Output ONE token: ${actions.join('|')}`;
  const customOverride = logic ? `${controlLine}\n${logic}` : controlLine;

  return {
    gameId,
    gameName,
    systemTemplateId: 'default-system',
    gameContext: {
      templateId: null,
      customOverride
    },
    progressionContexts: {},
    llmSettings: {
      maxTokens: 100,
      temperature: 0.5
    }
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Read game list
  const csv = fs.readFileSync(CSV_PATH, 'utf-8').trim().split('\n');
  console.log(`Found ${csv.length} games in CSV`);

  // Ensure output directory exists
  if (!fs.existsSync(GAMES_DIR)) {
    fs.mkdirSync(GAMES_DIR, { recursive: true });
  }

  const results = [];
  let errors = 0;

  for (const line of csv) {
    const [idStr, relPath] = line.split(',').map(s => s.trim());
    const gameId = parseInt(idStr);
    const vgdlPath = path.join(PROJECT_ROOT, relPath);
    const gameName = path.basename(relPath, '.txt');

    try {
      const config = generateGameConfig(gameId, vgdlPath, gameName);
      config.updatedAt = new Date().toISOString();
      results.push(config);

      if (dryRun) {
        console.log(`[${gameId}] ${gameName}: ${config.gameContext.customOverride.split('\n')[0]}`);
        if (config.gameContext.customOverride.includes('\n')) {
          console.log(`    ${config.gameContext.customOverride.split('\n').slice(1).join('\n    ')}`);
        }
      } else {
        const outPath = path.join(GAMES_DIR, `${gameId}.json`);
        fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');
      }
    } catch (err) {
      console.error(`[${gameId}] ${gameName}: ERROR - ${err.message}`);
      errors++;
    }
  }

  if (!dryRun) {
    console.log(`\nGenerated ${results.length} game configs in ${GAMES_DIR}`);
  } else {
    console.log(`\n[DRY RUN] Would generate ${results.length} game configs`);
  }
  if (errors > 0) {
    console.log(`${errors} errors encountered`);
  }
}

main();
