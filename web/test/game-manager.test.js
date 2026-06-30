const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gameManagerModule = require('../lib/game-manager');
const { resolveScreenshotPath } = require('../lib/screenshot-path');
const {
  GameManager,
  buildJavaArgs,
  prepareScreenshotTarget,
  resolveJavaRuntime
} = gameManagerModule;

test('completed Java process output remains available for diagnostics', () => {
  const manager = new GameManager();
  manager.activeProcesses.set('game_1', {
    stdoutChunks: ['[GAME] ready\n', '[PHASE] start\n'],
    stderrChunks: ['warn\n'],
    startTime: Date.now()
  });

  manager.rememberCompletedProcess('game_1', manager.activeProcesses.get('game_1'));
  manager.activeProcesses.delete('game_1');

  assert.deepEqual(manager.getProcessOutput('game_1'), {
    stdout: '[GAME] ready\n[PHASE] start\n',
    stderr: 'warn\n'
  });
});

test('missing configured Java path falls back to system Java before Homebrew 11', () => {
  const exists = candidate => candidate === '/usr/bin/java' || candidate === '/usr/local/opt/openjdk@11';
  const runtime = resolveJavaRuntime(
    { javaPath: '/missing/openjdk@11/bin/java' },
    { PATH: '/usr/bin' },
    exists
  );

  assert.equal(runtime.javaBin, '/usr/bin/java');
  assert.equal(runtime.javaEnv.PATH, '/usr/bin');
});

test('Java launch args include the streamed screenshot path', () => {
  const screenshotPath = path.join(os.tmpdir(), 'gvgai-frame.png');
  const args = buildJavaArgs({
    classpath: ['classes', 'gson.jar'].join(path.delimiter),
    gamesDir: '/tmp/gvgai-runtime/source'
  }, 3, 2, screenshotPath);

  assert.equal(args[0], '-Djava.awt.headless=true');
  assert.deepEqual(args.slice(args.indexOf('-gameId'), args.indexOf('-gameId') + 2), ['-gameId', '3']);
  assert.deepEqual(args.slice(args.indexOf('-levelId'), args.indexOf('-levelId') + 2), ['-levelId', '2']);
  assert.deepEqual(args.slice(args.indexOf('-imgPath'), args.indexOf('-imgPath') + 2), ['-imgPath', screenshotPath]);
  assert.deepEqual(args.slice(args.indexOf('-gamesDir'), args.indexOf('-gamesDir') + 2), ['-gamesDir', '/tmp/gvgai-runtime/source']);
});

test('screenshot target preparation removes a stale frame', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvgai-frame-'));
  const target = path.join(tmpDir, 'frames', 'game.png');

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stale');

    prepareScreenshotTarget(target);

    assert.equal(fs.existsSync(path.dirname(target)), true);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('screenshot path resolver keeps absolute paths and roots relative paths', () => {
  assert.equal(
    resolveScreenshotPath({ projectRoot: '/tmp/gvgai', screenshotPath: 'gameStateByBytes.png' }),
    path.resolve('/tmp/gvgai', 'gameStateByBytes.png')
  );
  assert.equal(
    resolveScreenshotPath({ projectRoot: '/tmp/gvgai', screenshotPath: '/tmp/frame.png' }),
    '/tmp/frame.png'
  );
});
