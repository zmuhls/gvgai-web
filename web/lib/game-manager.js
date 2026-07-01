const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getConfig } = require('./runtime-config');
const { resolveScreenshotPath } = require('./screenshot-path');
const config = getConfig();
const MAX_COMPLETED_PROCESSES = 20;

function resolveJavaBinary(gvgaiConfig, baseEnv = process.env, exists = fs.existsSync) {
  if (baseEnv.GVGAI_JAVA_BIN) {
    return { javaBin: baseEnv.GVGAI_JAVA_BIN, javaEnv: { ...baseEnv } };
  }

  if (gvgaiConfig.javaPath && exists(gvgaiConfig.javaPath)) {
    return { javaBin: gvgaiConfig.javaPath, javaEnv: { ...baseEnv } };
  }

  if (exists('/usr/bin/java')) {
    return { javaBin: '/usr/bin/java', javaEnv: { ...baseEnv } };
  }

  const homebrewJdk11 = [
    '/opt/homebrew/opt/openjdk@11',
    '/usr/local/opt/openjdk@11'
  ].find(candidate => exists(candidate));

  if (homebrewJdk11) {
    return {
      javaBin: path.join(homebrewJdk11, 'bin', 'java'),
      javaEnv: {
        ...baseEnv,
        JAVA_HOME: homebrewJdk11,
        PATH: `${homebrewJdk11}/bin:${baseEnv.PATH || ''}`
      }
    };
  }

  return { javaBin: 'java', javaEnv: { ...baseEnv } };
}

const { javaBin: JAVA_BIN, javaEnv: JAVA_ENV } = resolveJavaBinary(config.gvgai);
const DEFAULT_RUNTIME_ROOT = path.resolve(__dirname, '..', '.gvgai-runtime');
const RUNTIME_ROOT = path.resolve(process.env.GVGAI_RUNTIME_ROOT || config.gvgai.runtimeRoot || DEFAULT_RUNTIME_ROOT);
const RUNTIME_SOURCE_ROOT = path.join(RUNTIME_ROOT, 'source');
const RUNTIME_CLASSES_ROOT = path.join(RUNTIME_ROOT, 'classes');
const RUNTIME_GSON = path.join(RUNTIME_SOURCE_ROOT, 'gson-2.6.2.jar');
const RUNTIME_MANIFEST = path.join(RUNTIME_ROOT, 'runtime.json');

function preparedRuntimeExists() {
  return fs.existsSync(RUNTIME_MANIFEST) &&
    fs.existsSync(RUNTIME_CLASSES_ROOT) &&
    fs.existsSync(RUNTIME_GSON) &&
    fs.existsSync(path.join(RUNTIME_SOURCE_ROOT, 'examples', 'gridphysics', 'aliens.txt'));
}

function prepareRuntime() {
  if (preparedRuntimeExists()) return Promise.resolve(true);

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'prepare-java-runtime.js');
  console.log(`[GameManager] Preparing hydrated GVGAI runtime at ${RUNTIME_ROOT}`);
  const prepProcess = spawn(process.execPath, [scriptPath], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, GVGAI_RUNTIME_ROOT: RUNTIME_ROOT },
    stdio: 'inherit'
  });

  return new Promise((resolve) => {
    prepProcess.on('close', code => {
      if (code !== 0) {
        console.error(`[GameManager] Java runtime preparation failed with status ${code}`);
        resolve(false);
        return;
      }
      resolve(preparedRuntimeExists());
    });
    prepProcess.on('error', error => {
      console.error('[GameManager] Java runtime preparation could not start:', error.message);
      resolve(false);
    });
  });
}

async function resolveEngineRuntime() {
  const prepared = preparedRuntimeExists() || await prepareRuntime();
  if (prepared) {
    return {
      classpath: [RUNTIME_CLASSES_ROOT, RUNTIME_GSON].join(path.delimiter),
      gamesDir: RUNTIME_SOURCE_ROOT,
      cwd: RUNTIME_SOURCE_ROOT,
      hydrated: true
    };
  }

  return {
    classpath: config.gvgai.classpath,
    gamesDir: null,
    cwd: config.gvgai.projectRoot,
    hydrated: false
  };
}

function prepareScreenshotTarget(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function buildJavaArgs(runtime, gameId, levelId, screenshotPath) {
  const args = [
    '-Djava.awt.headless=true',
    '-cp', runtime.classpath,
    config.gvgai.mainClass,
    '-gameId', gameId.toString(),
    '-levelId', levelId.toString(),
    '-clientType', 'java',
    '-imgPath', screenshotPath
  ];

  if (runtime.gamesDir) {
    args.push('-gamesDir', runtime.gamesDir);
  }

  return args;
}

class GameManager {
  constructor() {
    this.activeProcesses = new Map();
    this.completedProcesses = new Map();
  }

  async startGame(gameId, levelId = 0, visuals = false) {
    const processId = `game_${Date.now()}`;
    const startTime = Date.now();
    const runtime = await resolveEngineRuntime();
    const screenshotPath = resolveScreenshotPath(config.gvgai);
    prepareScreenshotTarget(screenshotPath);

    const args = buildJavaArgs(runtime, gameId, levelId, screenshotPath);

    // Never use visuals - run headless and rely on screenshot generation
    // if (visuals) {
    //   args.push('-visuals');
    // }

    console.log(`[GameManager] Starting game ${gameId} (level ${levelId})`);
    console.log(`[GameManager] Process ID: ${processId}`);
    console.log(`[GameManager] Runtime: ${runtime.hydrated ? runtime.cwd : 'configured project tree'}`);
    console.log(`[GameManager] Java command: ${JAVA_BIN} ${args.join(' ')}`);

    const javaProcess = spawn(JAVA_BIN, args, {
      cwd: runtime.cwd,
      env: JAVA_ENV
    });

    console.log(`[GameManager] Java process spawned with PID: ${javaProcess.pid}`);

    // Track stdout for ready detection
    const stdoutChunks = [];
    javaProcess.stdout.on('data', (data) => {
      const text = data.toString();
      console.log(`[GVGAI stdout]: ${text}`);
      stdoutChunks.push(text);
    });

    const stderrChunks = [];
    javaProcess.stderr.on('data', (data) => {
      const text = data.toString();
      console.error(`[GVGAI stderr]: ${text}`);
      stderrChunks.push(text);
    });

    javaProcess.on('close', (code, signal) => {
      const processData = this.activeProcesses.get(processId);
      const lifetime = processData ? Date.now() - processData.startTime : 0;

      console.log(`[GameManager] Process ${processId} exited`);
      console.log(`[GameManager] Exit code: ${code}, Signal: ${signal}`);
      console.log(`[GameManager] Lifetime: ${lifetime}ms`);
      console.log(`[GameManager] PID was: ${javaProcess.pid}`);

      if (code === 143) {
        console.log('[GameManager] Process was killed with SIGTERM');
      } else if (code !== 0 && code !== null) {
        console.error(`[GameManager] Process exited abnormally with code ${code}`);
      }

      if (processData) {
        this.rememberCompletedProcess(processId, processData);
      }
      this.activeProcesses.delete(processId);
    });

    javaProcess.on('error', (error) => {
      console.error(`[GameManager] Failed to start game:`, error);
      const processData = this.activeProcesses.get(processId);
      if (processData) {
        this.rememberCompletedProcess(processId, processData);
      }
      this.activeProcesses.delete(processId);
    });

    this.activeProcesses.set(processId, { process: javaProcess, startTime, stdoutChunks, stderrChunks });

    return {
      processId,
      pid: javaProcess.pid
    };
  }

  /**
   * Wait for Java process to report socket is listening.
   * Watches stdout for "[SocketComm] ServerSocket listening" marker.
   */
  waitForReady(processId, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const processData = this.activeProcesses.get(processId);
      if (!processData) {
        resolve(false);
        return;
      }

      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const allOutput = processData.stdoutChunks.join('');

        if (allOutput.includes('ServerSocket listening')) {
          clearInterval(checkInterval);
          console.log(`[GameManager] Java socket ready after ${Date.now() - startTime}ms`);
          resolve(true);
          return;
        }

        // Check for fatal errors in both stdout and stderr
        const allErrors = processData.stderrChunks.join('');
        if (allOutput.includes('already in use') || allOutput.includes('BindException') ||
            allErrors.includes('already in use') || allErrors.includes('BindException')) {
          clearInterval(checkInterval);
          console.error('[GameManager] Java failed to bind socket port');
          resolve(false);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          console.error(`[GameManager] Java not ready after ${timeoutMs}ms`);
          resolve(false);
        }
      }, 50);

      // Also resolve false if process exits early
      processData.process.once('close', () => {
        clearInterval(checkInterval);
        resolve(false);
      });
    });
  }

  rememberCompletedProcess(processId, processData) {
    this.completedProcesses.set(processId, {
      stdoutChunks: [...processData.stdoutChunks],
      stderrChunks: [...processData.stderrChunks],
      startTime: processData.startTime,
      completedAt: Date.now()
    });

    while (this.completedProcesses.size > MAX_COMPLETED_PROCESSES) {
      const oldestProcessId = this.completedProcesses.keys().next().value;
      this.completedProcesses.delete(oldestProcessId);
    }
  }

  getProcessOutput(processId) {
    const processData = this.activeProcesses.get(processId) || this.completedProcesses.get(processId);
    if (!processData) return { stdout: '', stderr: '' };
    return {
      stdout: processData.stdoutChunks.join(''),
      stderr: processData.stderrChunks.join('')
    };
  }

  stopGame(processId) {
    const processData = this.activeProcesses.get(processId);
    if (processData) {
      const { process, startTime } = processData;
      const lifetime = Date.now() - startTime;

      console.log(`[GameManager] Stopping game process ${processId}`);
      console.log(`[GameManager] PID: ${process.pid}, Lifetime: ${lifetime}ms`);

      process.kill('SIGTERM');

      // Force-kill after 2 seconds if still running
      const forceKillTimer = setTimeout(() => {
        try {
          if (process.exitCode === null && process.signalCode === null) {
            process.kill(0); // Check if still alive
            console.log(`[GameManager] Process ${processId} still alive, sending SIGKILL`);
            process.kill('SIGKILL');
          }
        } catch (e) {
          // Process already dead, ignore
        }
      }, 2000);

      process.once('close', () => clearTimeout(forceKillTimer));

      console.log(`[GameManager] SIGTERM sent to process ${processId}`);
      return true;
    }

    console.warn(`[GameManager] Process ${processId} not found`);
    return false;
  }

  // Stop a game and resolve once the OS process has actually exited (or a timeout),
  // so the caller can guarantee the fixed socket port is free before spawning again.
  stopGameAndWait(processId, timeoutMs = 3000) {
    const processData = this.activeProcesses.get(processId);
    if (!processData) return Promise.resolve(false);
    const { process } = processData;
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      if (process.exitCode !== null || process.signalCode !== null) {
        done(true);
        return;
      }
      process.once('close', () => done(true));
      this.stopGame(processId);
    });
  }

  stopAll() {
    for (const [processId, processData] of this.activeProcesses) {
      const { process } = processData;
      process.kill('SIGTERM');
      console.log(`[GameManager] Stopped process ${processId} (PID: ${process.pid})`);
    }
    this.activeProcesses.clear();
  }
}

module.exports = new GameManager();
module.exports.GameManager = GameManager;
module.exports.resolveJavaRuntime = resolveJavaBinary;
module.exports.resolveEngineRuntime = resolveEngineRuntime;
module.exports.buildJavaArgs = buildJavaArgs;
module.exports.prepareScreenshotTarget = prepareScreenshotTarget;
