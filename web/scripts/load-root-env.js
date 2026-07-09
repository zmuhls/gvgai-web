const { execFile } = require('child_process');
const path = require('path');

function readEnvFileWithTimeout(filePath, timeoutMs) {
  const parser = `
    const fs = require('fs');
    const filePath = process.argv[1];
    const source = fs.readFileSync(filePath, 'utf-8');
    const parsed = {};
    for (const rawLine of source.split(/\\r?\\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*?)\\s*=\\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      parsed[match[1]] = value;
    }
    process.stdout.write(JSON.stringify(parsed));
  `;

  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', parser, filePath], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(JSON.parse(stdout || '{}'));
    });
  });
}

async function loadRootEnv(options = {}) {
  const env = options.env || process.env;
  const requestedPath = options.path || env.GVGAI_ENV_FILE;
  const envPath = path.resolve(requestedPath || path.resolve(__dirname, '..', '..', '.env'));
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 2000;

  if (options.skip || env.TELEMETRY_SKIP_DOTENV === 'true') {
    return { loaded: false, skipped: true, path: envPath };
  }

  try {
    const parsed = await readEnvFileWithTimeout(envPath, timeoutMs);
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
    return { loaded: true, path: envPath, keys: Object.keys(parsed).length };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { loaded: false, missing: true, path: envPath };
    }
    if (error.killed || error.signal || error.code === 'ETIMEDOUT') {
      return { loaded: false, timedOut: true, path: envPath, timeoutMs };
    }
    return { loaded: false, path: envPath, error: error.message };
  }
}

module.exports = {
  readEnvFileWithTimeout,
  loadRootEnv
};
