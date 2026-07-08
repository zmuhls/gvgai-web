const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TIMEOUT_MS = 1500;

const DEFAULT_CONFIG = {
  server: {
    port: 3000
  },
  gvgai: {
    socketPort: 8080,
    javaPath: '',
    projectRoot: PROJECT_ROOT,
    screenshotPath: 'logs/game.png',
    classpath: ['out', 'gson-2.6.2.jar'].join(path.delimiter),
    mainClass: 'tracks.singleLearning.utils.JavaServer',
    runtimeRoot: ''
  },
  openrouter: {
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'gemma3:27b'
  },
  ollamaCloud: {
    apiUrl: 'https://ollama.com/v1/chat/completions'
  },
  ollama: {
    apiUrl: 'http://localhost:11434/v1/chat/completions'
  },
  legion: {
    // Shared Gemma-3-4b base + per-room LoRA adapters served by vLLM on the
    // Legion (CUDA). Default is a local placeholder; the real endpoint is the
    // Tailscale host, set via LEGION_VLLM_URL or config.json.
    apiUrl: 'http://localhost:8000/v1/chat/completions'
  }
};

let cachedConfig = null;
let cachedStatus = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) return { ...base };

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = mergeConfig(base[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function readConfigJsonWithTimeout(filePath = CONFIG_PATH, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const reader = `
    const fs = require('fs');
    const filePath = process.argv[1];
    process.stdout.write(fs.readFileSync(filePath, 'utf8'));
  `;

  return execFileSync(process.execPath, ['-e', reader, filePath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function applyEnvOverrides(config, env = process.env) {
  const next = mergeConfig(config, {});

  if (env.PORT) {
    const port = Number.parseInt(env.PORT, 10);
    if (Number.isInteger(port) && port > 0) next.server.port = port;
  }

  if (env.GVGAI_PROJECT_ROOT) next.gvgai.projectRoot = env.GVGAI_PROJECT_ROOT;
  if (env.GVGAI_SOCKET_PORT) {
    const socketPort = Number.parseInt(env.GVGAI_SOCKET_PORT, 10);
    if (Number.isInteger(socketPort) && socketPort > 0) next.gvgai.socketPort = socketPort;
  }
  if (env.GVGAI_RUNTIME_ROOT) next.gvgai.runtimeRoot = env.GVGAI_RUNTIME_ROOT;

  if (env.LEGION_VLLM_URL) {
    next.legion = { ...(next.legion || {}), apiUrl: env.LEGION_VLLM_URL };
  }

  return next;
}

function normalizeConfig(config, env = process.env, exists = fs.existsSync) {
  const next = applyEnvOverrides(config, env);
  if (!next.gvgai.projectRoot || !exists(next.gvgai.projectRoot)) {
    next.gvgai.projectRoot = PROJECT_ROOT;
  }
  return next;
}

function loadConfig(options = {}) {
  const filePath = options.filePath || CONFIG_PATH;
  const timeoutMs = Number.parseInt(
    options.timeoutMs || process.env.GVGAI_CONFIG_READ_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    10
  );
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const reader = options.reader || readConfigJsonWithTimeout;
  const status = {
    filePath,
    loaded: false,
    fallback: false,
    timedOut: false,
    error: null,
    timeoutMs
  };

  let loadedConfig = {};
  try {
    const raw = reader(filePath, timeoutMs);
    loadedConfig = JSON.parse(raw);
    status.loaded = true;
  } catch (error) {
    status.fallback = true;
    status.timedOut = error.code === 'ETIMEDOUT' || /timed out/i.test(error.message || '');
    status.error = error.message;
  }

  const merged = mergeConfig(DEFAULT_CONFIG, loadedConfig);
  return {
    config: normalizeConfig(merged, env, exists),
    status
  };
}

function getConfig(options = {}) {
  if (!cachedConfig || options.fresh) {
    const loaded = loadConfig(options);
    cachedConfig = loaded.config;
    cachedStatus = loaded.status;
  }
  return cachedConfig;
}

function getConfigLoadStatus() {
  if (!cachedStatus) getConfig();
  return cachedStatus;
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_PATH,
  PROJECT_ROOT,
  getConfig,
  getConfigLoadStatus,
  loadConfig,
  mergeConfig,
  normalizeConfig,
  readConfigJsonWithTimeout
};
