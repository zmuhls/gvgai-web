const path = require('path');

function resolveScreenshotPath(gvgaiConfig) {
  const root = gvgaiConfig.projectRoot || process.cwd();
  const screenshotPath = gvgaiConfig.screenshotPath || 'gameStateByBytes.png';
  return path.resolve(root, screenshotPath);
}

module.exports = {
  resolveScreenshotPath
};
