const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPrompt, extractSpatialContext } = require('../lib/state-converter');

function createAliensState(overrides = {}) {
  return {
    blockSize: 10,
    worldDimension: [30, 110],
    observationGridNum: 30,
    observationGridMaxRow: 11,
    avatarPosition: [160, 100],
    avatarHealthPoints: 100,
    gameScore: 0,
    gameTick: 0,
    availableActions: ['ACTION_NIL', 'ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_USE'],
    ...overrides
  };
}

function gridPosition([x, y]) {
  return { x: x * 10, y: y * 10 };
}

function createBaitState({
  avatar = [2, 1],
  avatarType = 4,
  key = [2, 4],
  boxes = [[2, 3], [3, 3]],
  score = 0,
  tick = 0
} = {}) {
  const movableGroups = [];
  if (key) {
    movableGroups.push([{ position: gridPosition(key), itype: 7, category: 6, obsID: 26 }]);
  }
  movableGroups.push(boxes.map((box, index) => ({
    position: gridPosition(box),
    itype: 9,
    category: 6,
    obsID: 19 + index
  })));

  return {
    blockSize: 10,
    worldDimension: [50, 60],
    avatarPosition: [avatar[0] * 10, avatar[1] * 10],
    avatarType,
    avatarHealthPoints: 0,
    gameScore: score,
    gameTick: tick,
    availableActions: ['ACTION_LEFT', 'ACTION_RIGHT', 'ACTION_DOWN', 'ACTION_UP'],
    immovablePositionsNum: 2,
    immovablePositions: [
      [],
      [{ position: gridPosition([1, 1]), itype: 8, category: 4, obsID: 6 }]
    ],
    movablePositionsNum: movableGroups.length,
    movablePositions: movableGroups
  };
}

function createGridTargetState({
  avatar = [3, 2],
  targets = [[1, 2, 6]],
  dangers = [],
  walls = []
} = {}) {
  const npcItems = targets.concat(dangers).map(([x, y, itype], index) => ({
    position: gridPosition([x, y]),
    itype,
    category: 3,
    obsID: 100 + index
  }));
  const wallItems = walls.map(([x, y], index) => ({
    position: gridPosition([x, y]),
    itype: 0,
    category: 4,
    obsID: 200 + index
  }));

  return {
    blockSize: 10,
    observationGridNum: 6,
    observationGridMaxRow: 5,
    avatarPosition: gridPosition(avatar),
    avatarHealthPoints: 0,
    gameScore: 0,
    gameTick: 0,
    availableActions: ['ACTION_UP', 'ACTION_DOWN', 'ACTION_LEFT', 'ACTION_RIGHT'],
    NPCPositionsNum: 1,
    NPCPositions: [npcItems],
    immovablePositionsNum: 1,
    immovablePositions: [wallItems]
  };
}

function baitPromptFor(state) {
  return buildPrompt(state, {
    gameName: 'bait',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'bait-level0',
      authoritative: true,
      actionCodes: {
        U: 'ACTION_UP',
        D: 'ACTION_DOWN',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT'
      },
      objectiveCodes: ['GET_KEY', 'OPEN_GOAL'],
      ruleCodes: ['PUSH_RIGHT_BOX_DOWN', 'PUSH_CENTER_BOX_LEFT', 'COLLECT_KEY', 'ENTER_GOAL'],
      keyItype: 7,
      boxItype: 9,
      withKeyAvatarType: 5
    }
  });
}

function gridTargetPromptFor(state, protocolOverrides = {}) {
  return buildPrompt(state, {
    gameName: 'grid-target-test',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'grid-target',
      authoritative: true,
      actionCodes: {
        U: 'ACTION_UP',
        D: 'ACTION_DOWN',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT'
      },
      targetSources: ['npc'],
      targetItypes: [6],
      wallSources: ['immovable'],
      wallItypes: [0],
      dangerSources: ['npc'],
      dangerNonTargets: true,
      dangerRadius: 0,
      ...protocolOverrides
    }
  });
}

test('spatial context uses observation grid dimensions when worldDimension is mixed with blockSize', () => {
  const context = extractSpatialContext(createAliensState());

  assert.match(context, /Position: \(16, 10\) on 30x11 grid/);
  assert.doesNotMatch(context, /on 3x11 grid/);
});

test('template grid size uses observation grid dimensions', () => {
  const prompt = buildPrompt(createAliensState(), {
    systemContent: null,
    gameContent: 'Player {{playerPosition}} on {{gridSize}}',
    levelContent: '',
    actionAliases: null
  });

  assert.match(prompt.userMessage, /Player \(16, 10\) on 30x11/);
});

test('spatial context keeps portal goals at zero coordinates', () => {
  const context = extractSpatialContext(createAliensState({
    portalsPositionsNum: 1,
    portalsPositions: [[{ position: { x: 0, y: 0 } }]]
  }));

  assert.match(context, /Goals: exit\/portal 10 up, 16 left \(26 away\)/);
});

test('spatial context reports moving hazards such as alien bombs', () => {
  const context = extractSpatialContext(createAliensState({
    movablePositionsNum: 1,
    movablePositions: [[{ position: { x: 150, y: 90 }, itype: 6, category: 6 }]]
  }));

  assert.match(context, /Moving hazards: 1 up, 1 left \(2 away\)/);
});

test('aliens code protocol feeds a compact GV1 tape instead of paragraph rules', () => {
  const prompt = buildPrompt(createAliensState({
    gameTick: 423,
    gameScore: 22,
    NPCPositionsNum: 1,
    NPCPositions: [[
      { position: { x: 130, y: 70 }, itype: 4, category: 3 },
      { position: { x: 180, y: 70 }, itype: 4, category: 3 }
    ]],
    movablePositionsNum: 1,
    movablePositions: [[{ position: { x: 150, y: 90 }, itype: 6, category: 6 }]]
  }), {
    gameName: 'aliens',
    systemContent: 'You play {{gameName}}, a 2D grid game. Output exactly ONE token.',
    gameContent: 'Space invaders variant. Aliens scroll horizontally and drop bombs.',
    levelContent: '',
    actionAliases: {
      ACTION_NIL: 'WAIT',
      ACTION_LEFT: 'LEFT',
      ACTION_RIGHT: 'RIGHT',
      ACTION_USE: 'SHOOT'
    },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      objectiveCodes: ['KILL_ALL', 'AVOID_HAZARD'],
      ruleCodes: ['ALIGN_SHOOT', 'DODGE_NEAR', 'CLEAR_LOW'],
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.equal(prompt.responseMode, 'code');
  assert.deepEqual(prompt.actionCodeMap, {
    N: 'ACTION_NIL',
    L: 'ACTION_LEFT',
    R: 'ACTION_RIGHT',
    U: 'ACTION_USE'
  });
  assert.equal(prompt.systemMessage, null);
  assert.match(prompt.userMessage, /^GV1\n/);
  assert.match(prompt.userMessage, /Reply with exactly ONE code/);
  assert.match(prompt.userMessage, /G:aliens L:0 T:423 S:22 HP:100/);
  assert.match(prompt.userMessage, /A:N,L,R,U/);
  assert.match(prompt.userMessage, /P:16,10/);
  assert.match(prompt.userMessage, /O:KILL_ALL\|AVOID_HAZARD/);
  assert.match(prompt.userMessage, /E:a:18,7\|a:13,7/);
  assert.match(prompt.userMessage, /H:b:15,9/);
  assert.match(prompt.userMessage, /D:target=a18,7 dx=\+2 fire=0 dodge=R/);
  assert.match(prompt.userMessage, /B:R/);
  assert.equal(prompt.fallbackAction, 'ACTION_RIGHT');
  assert.equal(prompt.fallbackActionCode, 'R');
  assert.match(prompt.userMessage, /ANS=\[N\|L\|R\|U\]\nANS:$/);
  assert.doesNotMatch(prompt.userMessage, /controller|Return exactly|No words/);
  assert.doesNotMatch(prompt.userMessage, /Space invaders variant/);
  assert.doesNotMatch(prompt.userMessage, /Aliens scroll horizontally/);
});

test('code protocol carries the live combinatorial tactic into the compact tape', () => {
  const prompt = buildPrompt(createAliensState(), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  }, null, 'Rotate LEFT, RIGHT, and SHOOT instead of holding one direction.');

  assert.match(prompt.userMessage, /T:Rotate LEFT, RIGHT, and SHOOT/);
});

test('code protocol can request a compact multi-action plan for async play', () => {
  const prompt = buildPrompt(createAliensState(), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      planSteps: 4,
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /PLAN:<4 comma-separated codes/);
  assert.match(prompt.userMessage, /PLAN:$/);
  assert.doesNotMatch(prompt.userMessage, /Reply with exactly ONE code/);
});

test('aliens code protocol recommends shooting when aligned and safe', () => {
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 160, y: 70 }, itype: 4, category: 3 }]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /D:target=a16,7 dx=0 fire=1 dodge=N/);
  assert.match(prompt.userMessage, /B:U/);
  assert.equal(prompt.fallbackAction, 'ACTION_USE');
});

test('aliens code protocol dodges bombs before they reach the avatar', () => {
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 160, y: 70 }, itype: 4, category: 3 }]],
    movablePositionsNum: 1,
    movablePositions: [[{ position: { x: 160, y: 70 }, itype: 6, category: 6 }]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /D:target=a16,7 dx=0 fire=0 dodge=R/);
  assert.match(prompt.userMessage, /B:R/);
  assert.equal(prompt.fallbackAction, 'ACTION_RIGHT');
});

test('aliens code protocol can prefer firing over target chasing', () => {
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      preferFire: true,
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /D:target=a18,7 dx=\+2 fire=0 dodge=N/);
  assert.match(prompt.userMessage, /B:U/);
  assert.equal(prompt.fallbackAction, 'ACTION_USE');
});

test('aliens code protocol can force a game-specific action code', () => {
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]],
    movablePositionsNum: 1,
    movablePositions: [[{ position: { x: 160, y: 70 }, itype: 6, category: 6 }]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      forceActionCode: 'U',
      authoritative: true,
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /B:U/);
  assert.equal(prompt.fallbackAction, 'ACTION_USE');
  assert.equal(prompt.policyAuthoritative, true);
});

test('aliens code policy moves on a cadence between shots', () => {
  const codeProtocol = {
    enabled: true,
    id: 'GV1',
    policyId: 'aliens-opening-move',
    movementCodes: ['R', 'L'],
    movementIntervalTicks: 6,
    forceActionCode: 'U',
    authoritative: true,
    entityCodes: {
      npc: 'a',
      movable: 'b'
    },
    actionCodes: {
      N: 'ACTION_NIL',
      L: 'ACTION_LEFT',
      R: 'ACTION_RIGHT',
      U: 'ACTION_USE'
    }
  };

  const firstTick = buildPrompt(createAliensState({ gameTick: 0 }), {
    gameName: 'aliens',
    codeProtocol
  });
  const secondTick = buildPrompt(createAliensState({ gameTick: 1 }), {
    gameName: 'aliens',
    codeProtocol
  });
  const laterTick = buildPrompt(createAliensState({ gameTick: 2 }), {
    gameName: 'aliens',
    codeProtocol
  });
  const leftBeat = buildPrompt(createAliensState({ gameTick: 6 }), {
    gameName: 'aliens',
    codeProtocol
  });
  const rightBeat = buildPrompt(createAliensState({ gameTick: 12 }), {
    gameName: 'aliens',
    codeProtocol
  });

  assert.equal(firstTick.fallbackActionCode, 'R');
  assert.equal(firstTick.fallbackAction, 'ACTION_RIGHT');
  assert.equal(firstTick.policyReason, 'movement beat R');
  assert.equal(secondTick.fallbackActionCode, 'U');
  assert.equal(secondTick.fallbackAction, 'ACTION_USE');
  assert.equal(laterTick.fallbackActionCode, 'U');
  assert.equal(laterTick.fallbackAction, 'ACTION_USE');
  assert.equal(leftBeat.fallbackActionCode, 'L');
  assert.equal(leftBeat.fallbackAction, 'ACTION_LEFT');
  assert.equal(leftBeat.policyReason, 'movement beat L');
  assert.equal(rightBeat.fallbackActionCode, 'R');
  assert.equal(rightBeat.fallbackAction, 'ACTION_RIGHT');
});

test('aliens code protocol avoids moving into a bomb column', () => {
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 180, y: 70 }, itype: 4, category: 3 }]],
    movablePositionsNum: 1,
    movablePositions: [[{ position: { x: 170, y: 70 }, itype: 6, category: 6 }]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      entityCodes: {
        npc: 'a',
        movable: 'b'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /D:target=a18,7 dx=\+2 fire=0 dodge=L/);
  assert.match(prompt.userMessage, /B:L/);
  assert.equal(prompt.fallbackAction, 'ACTION_LEFT');
});

test('aliens code protocol does not dodge the avatar projectile', () => {
  const projectile = { position: { x: 160, y: 80 }, itype: 5, category: 6, obsID: 101 };
  const prompt = buildPrompt(createAliensState({
    NPCPositionsNum: 1,
    NPCPositions: [[{ position: { x: 160, y: 70 }, itype: 4, category: 3 }]],
    movablePositionsNum: 1,
    movablePositions: [[projectile]],
    fromAvatarSpritesPositionsNum: 1,
    fromAvatarSpritesPositions: [[projectile]]
  }), {
    gameName: 'aliens',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      entityCodes: {
        npc: 'a',
        movable: 'b',
        projectile: 's'
      },
      actionCodes: {
        N: 'ACTION_NIL',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT',
        U: 'ACTION_USE'
      }
    }
  });

  assert.match(prompt.userMessage, /H:-/);
  assert.match(prompt.userMessage, /D:target=a16,7 dx=0 fire=1 dodge=N/);
  assert.match(prompt.userMessage, /B:U/);
});

test('bait code policy follows the verified level 0 box route', () => {
  const states = [
    [createBaitState({ avatar: [2, 1], boxes: [[2, 3], [3, 3]] }), 'D', 'ACTION_DOWN'],
    [createBaitState({ avatar: [2, 2], boxes: [[2, 3], [3, 3]] }), 'R', 'ACTION_RIGHT'],
    [createBaitState({ avatar: [3, 2], boxes: [[2, 3], [3, 3]] }), 'D', 'ACTION_DOWN'],
    [createBaitState({ avatar: [3, 3], boxes: [[2, 3], [3, 4]] }), 'L', 'ACTION_LEFT'],
    [createBaitState({ avatar: [2, 3], boxes: [[1, 3], [3, 4]] }), 'D', 'ACTION_DOWN'],
    [createBaitState({ avatar: [2, 4], avatarType: 5, key: null, boxes: [[1, 3], [3, 4]] }), 'U', 'ACTION_UP'],
    [createBaitState({ avatar: [2, 1], avatarType: 5, key: null, boxes: [[1, 3], [3, 4]] }), 'L', 'ACTION_LEFT']
  ];

  for (const [state, code, action] of states) {
    const prompt = baitPromptFor(state);
    assert.equal(prompt.responseMode, 'code');
    assert.equal(prompt.policyAuthoritative, true);
    assert.equal(prompt.fallbackActionCode, code);
    assert.equal(prompt.fallbackAction, action);
    assert.match(prompt.userMessage, new RegExp(`B:${code}`));
  }
});

test('fixed code policy repeats a configured legal action', () => {
  const prompt = buildPrompt(createGridTargetState(), {
    gameName: 'camelRace',
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'fixed-code',
      authoritative: true,
      fixedActionCode: 'R',
      actionCodes: {
        U: 'ACTION_UP',
        D: 'ACTION_DOWN',
        L: 'ACTION_LEFT',
        R: 'ACTION_RIGHT'
      }
    }
  });

  assert.equal(prompt.responseMode, 'code');
  assert.equal(prompt.policyAuthoritative, true);
  assert.equal(prompt.fallbackActionCode, 'R');
  assert.equal(prompt.fallbackAction, 'ACTION_RIGHT');
  assert.equal(prompt.policyReason, 'fixed legal action R');
});

test('grid target policy paths to a visible target', () => {
  const prompt = gridTargetPromptFor(createGridTargetState({
    avatar: [3, 2],
    targets: [[1, 2, 6]]
  }));

  assert.equal(prompt.responseMode, 'code');
  assert.equal(prompt.policyAuthoritative, true);
  assert.equal(prompt.fallbackActionCode, 'L');
  assert.equal(prompt.fallbackAction, 'ACTION_LEFT');
  assert.match(prompt.userMessage, /B:L/);
});

test('grid target policy routes around non-target danger', () => {
  const prompt = gridTargetPromptFor(createGridTargetState({
    avatar: [3, 2],
    targets: [[1, 2, 6]],
    dangers: [[2, 2, 5]]
  }));

  assert.equal(prompt.fallbackActionCode, 'U');
  assert.equal(prompt.fallbackAction, 'ACTION_UP');
  assert.match(prompt.userMessage, /B:U/);
});

test('grid target policy skips targets inside a danger radius when safer targets exist', () => {
  const prompt = gridTargetPromptFor(createGridTargetState({
    avatar: [3, 2],
    targets: [[1, 2, 6], [3, 4, 6]],
    dangers: [[1, 1, 5]]
  }), { dangerRadius: 1 });

  assert.equal(prompt.fallbackActionCode, 'D');
  assert.equal(prompt.fallbackAction, 'ACTION_DOWN');
  assert.match(prompt.userMessage, /B:D/);
});

test('macro-enabled game with a strategy asks for a PLAN closing contract', () => {
  const prompt = buildPrompt(createAliensState(), {
    gameName: 'aliens',
    macroActions: { enabled: true, maxSteps: 4 }
  }, null, 'rush the left column');

  assert.match(prompt.userMessage, /PLAN: <4 actions when the path is safe, never fewer than 2/);
  assert.match(prompt.userMessage, /example: ACTION_LEFT, ACTION_LEFT, ACTION_RIGHT, ACTION_RIGHT/);
  assert.doesNotMatch(prompt.userMessage, /ACTION: <one action/);
  assert.match(prompt.userMessage, /REASON: <one short sentence/);
});

test('macro config without a strategy keeps the legacy single-word contract', () => {
  const prompt = buildPrompt(createAliensState(), {
    gameName: 'aliens',
    macroActions: { enabled: true, maxSteps: 4 }
  }, null, null);

  assert.match(prompt.userMessage, /Choose ONE action\. Respond with ONLY the action word\./);
  assert.doesNotMatch(prompt.userMessage, /PLAN:/);
});

test('strategy without macro config keeps the REASON/ACTION contract', () => {
  const prompt = buildPrompt(createAliensState(), {
    gameName: 'aliens'
  }, null, 'rush the left column');

  assert.match(prompt.userMessage, /ACTION: <one action from the list above>/);
  assert.doesNotMatch(prompt.userMessage, /PLAN:/);
});

test('codeProtocol still short-circuits before the macro closing branch', () => {
  const prompt = buildPrompt(createBaitState(), {
    gameName: 'bait',
    macroActions: { enabled: true },
    codeProtocol: {
      enabled: true,
      id: 'GV1',
      policyId: 'bait-level0',
      authoritative: true,
      actionCodes: { U: 'ACTION_UP', D: 'ACTION_DOWN', L: 'ACTION_LEFT', R: 'ACTION_RIGHT' },
      keyItype: 7,
      boxItype: 9,
      withKeyAvatarType: 5
    }
  }, null, 'push the boxes');

  assert.equal(prompt.responseMode, 'code');
  assert.doesNotMatch(prompt.userMessage, /PLAN: <1 to/);
});

// --- GameStateTracker reward attribution ---------------------------------
// An action's outcome is only visible at the NEXT tick. In synchronous
// (eval/marble) mode the decision is recorded on the same tick it was made,
// so same-tick deltas are always zero — the history layer then reports
// "no effect" for every action of the run, which misleads the model.
const { GameStateTracker } = require('../lib/state-converter');

test('sync-mode reward attribution: score lands on the action at the next tick', () => {
  const tracker = new GameStateTracker();
  tracker.recordTick({ gameTick: 5, gameScore: 0, avatarHealthPoints: 100, avatarPosition: [16, 10] });
  tracker.recordAction('ACTION_USE', 5); // decided on tick 5's state
  tracker.recordTick({ gameTick: 6, gameScore: 2, avatarHealthPoints: 100, avatarPosition: [16, 10] });
  const history = tracker.buildHistoryContext();
  assert.match(history, /ACTION_USE, score \+2/);
  assert.ok(!history.includes('no effect'), `history still claims no effect: ${history}`);
});

test('sync-mode reward attribution: movement lands on the action at the next tick', () => {
  const tracker = new GameStateTracker();
  tracker.recordTick({ gameTick: 1, gameScore: 0, avatarHealthPoints: 100, avatarPosition: [3, 4] });
  tracker.recordAction('ACTION_RIGHT', 1);
  tracker.recordTick({ gameTick: 2, gameScore: 0, avatarHealthPoints: 100, avatarPosition: [4, 4] });
  assert.match(tracker.buildHistoryContext(), /moved \(1, 0\)/);
});

test('a genuinely blocked move still reads as no effect after attribution', () => {
  const tracker = new GameStateTracker();
  tracker.recordTick({ gameTick: 1, gameScore: 0, avatarHealthPoints: 100, avatarPosition: [3, 4] });
  tracker.recordAction('ACTION_DOWN', 1);
  tracker.recordTick({ gameTick: 2, gameScore: 0, avatarHealthPoints: 100, avatarPosition: [3, 4] });
  assert.match(tracker.buildHistoryContext(), /ACTION_DOWN, no effect/);
});
