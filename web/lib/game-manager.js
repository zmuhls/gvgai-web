const { spawn } = require('child_process');
const path = require('path');
const config = require('../config.json');

class GameManager {
  constructor() {
    this.activeProcesses = new Map();
  }

  startGame(gameId, levelId = 0, visuals = false) {
    const processId = `game_${Date.now()}`;
    const startTime = Date.now();

    const args = [
      '-Djava.awt.headless=true',
      '-cp', config.gvgai.classpath,
      config.gvgai.mainClass,
      '-gameId', gameId.toString(),
      '-clientType', 'java'
    ];

    // Never use visuals - run headless and rely on screenshot generation
    // if (visuals) {
    //   args.push('-visuals');
    // }

    console.log(`[GameManager] Starting game ${gameId} (level ${levelId})`);
    console.log(`[GameManager] Process ID: ${processId}`);
    console.log(`[GameManager] Java command: ${config.gvgai.javaPath} ${args.join(' ')}`);

    const javaProcess = spawn(config.gvgai.javaPath, args, {
      cwd: config.gvgai.projectRoot,
      env: {
        ...process.env,
        JAVA_HOME: '/usr/local/opt/openjdk@11',
        PATH: `/usr/local/opt/openjdk@11/bin:${process.env.PATH}`
      }
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

      this.activeProcesses.delete(processId);
    });

    javaProcess.on('error', (error) => {
      console.error(`[GameManager] Failed to start game:`, error);
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

  stopGame(processId) {
    const processData = this.activeProcesses.get(processId);
    if (processData) {
      const { process, startTime } = processData;
      const lifetime = Date.now() - startTime;

      console.log(`[GameManager] Stopping game process ${processId}`);
      console.log(`[GameManager] PID: ${process.pid}, Lifetime: ${lifetime}ms`);

      process.kill('SIGTERM');

      // Force-kill after 2 seconds if still running
      setTimeout(() => {
        try {
          process.kill(0); // Check if still alive
          console.log(`[GameManager] Process ${processId} still alive, sending SIGKILL`);
          process.kill('SIGKILL');
        } catch (e) {
          // Process already dead, ignore
        }
      }, 2000);

      this.activeProcesses.delete(processId);

      console.log(`[GameManager] SIGTERM sent to process ${processId}`);
      return true;
    }

    console.warn(`[GameManager] Process ${processId} not found`);
    return false;
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
