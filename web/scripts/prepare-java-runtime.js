#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const webRoot = path.resolve(__dirname, '..');
const runtimeRoot = path.resolve(process.env.GVGAI_RUNTIME_ROOT || path.join(webRoot, '.gvgai-runtime'));
const sourceRoot = path.join(runtimeRoot, 'source');
const classesRoot = path.join(runtimeRoot, 'classes');
const sourcesFile = path.join(runtimeRoot, 'sources.txt');

const HOMEBREW_JDK11 = [
  '/opt/homebrew/opt/openjdk@11',
  '/usr/local/opt/openjdk@11'
].find(candidate => fs.existsSync(candidate));

const JAVAC_BIN = process.env.GVGAI_JAVAC_BIN ||
  (HOMEBREW_JDK11 ? path.join(HOMEBREW_JDK11, 'bin', 'javac') : 'javac');

const JAVA_ENV = process.env.GVGAI_JAVAC_BIN
  ? { ...process.env }
  : HOMEBREW_JDK11
  ? { ...process.env, JAVA_HOME: HOMEBREW_JDK11, PATH: `${HOMEBREW_JDK11}/bin:${process.env.PATH}` }
  : { ...process.env };

const archivePaths = ['src', 'examples', 'sprites', 'gson-2.6.2.jar'];
const localOverrides = [
  'src/core/vgdl/VGDLFactory.java',
  'src/tracks/LearningMachine.java',
  'src/tracks/singleLearning/utils/JavaServer.java',
  'src/tracks/singleLearning/utils/SocketComm.java',
  'src/tracks/singleLearning/utils/Comm.java'
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: JAVA_ENV,
    stdio: options.stdio || 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function extractGitArchive() {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['archive', '--format=tar', 'HEAD', ...archivePaths], { cwd: projectRoot });
    const tar = spawn('tar', ['-x', '-C', sourceRoot], { cwd: projectRoot });

    git.stdout.pipe(tar.stdin);

    let done = 0;
    let failed = false;
    const finish = code => {
      done += 1;
      if (code !== 0) failed = true;
      if (done === 2) {
        if (failed) reject(new Error('git archive extraction failed'));
        else resolve();
      }
    };

    git.on('error', reject);
    tar.on('error', reject);
    git.on('close', finish);
    tar.on('close', finish);
  });
}

function copyLocalOverrides() {
  for (const relPath of localOverrides) {
    const src = path.join(projectRoot, relPath);
    const dest = path.join(sourceRoot, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function collectJavaSources(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJavaSources(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.java')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(classesRoot, { recursive: true });

  await extractGitArchive();
  copyLocalOverrides();

  const javaSources = collectJavaSources(path.join(sourceRoot, 'src')).sort();
  fs.writeFileSync(sourcesFile, `${javaSources.join('\n')}\n`);

  run(JAVAC_BIN, [
    '-cp', path.join(sourceRoot, 'gson-2.6.2.jar'),
    '-d', classesRoot,
    `@${sourcesFile}`
  ]);

  const manifest = {
    preparedAt: new Date().toISOString(),
    projectRoot,
    runtimeRoot,
    sourceRoot,
    classesRoot,
    javac: JAVAC_BIN,
    sourceCount: javaSources.length
  };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime.json'), JSON.stringify(manifest, null, 2));
  console.log(`[JavaRuntime] prepared ${javaSources.length} sources at ${runtimeRoot}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('[JavaRuntime] failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  runtimeRoot,
  sourceRoot,
  classesRoot
};
