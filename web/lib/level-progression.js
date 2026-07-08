const DEFAULT_INITIAL_LEVEL_ID = 0;
const DEFAULT_MAX_LEVEL_ID = 4;
const FINISH_TRAINING_RESPONSE = 'END_TRAINING';

function normalizeLevelId(value, fallback = DEFAULT_INITIAL_LEVEL_ID) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function didPlayerWin(winner) {
  return winner === true || winner === 'PLAYER_WINS';
}

function nextLevelResponse(currentLevelId, winner, options = {}) {
  const currentLevel = normalizeLevelId(currentLevelId);
  const maxLevelId = normalizeLevelId(options.maxLevelId, DEFAULT_MAX_LEVEL_ID);
  const won = didPlayerWin(winner);
  const nextLevelId = won ? currentLevel + 1 : currentLevel;

  if (nextLevelId > maxLevelId) {
    return {
      response: options.finishResponse || FINISH_TRAINING_RESPONSE,
      currentLevel,
      nextLevelId: null,
      won,
      finished: true
    };
  }

  return {
    response: String(nextLevelId),
    currentLevel,
    nextLevelId,
    won,
    finished: false
  };
}

module.exports = {
  DEFAULT_INITIAL_LEVEL_ID,
  DEFAULT_MAX_LEVEL_ID,
  FINISH_TRAINING_RESPONSE,
  didPlayerWin,
  nextLevelResponse,
  normalizeLevelId
};
