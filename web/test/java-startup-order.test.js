const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('LearningMachine starts socket communication before VGDL initialization in runGames', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'tracks', 'LearningMachine.java'),
    'utf-8'
  );
  const runGamesStart = source.indexOf('public static void runGames(');
  const runGamesBody = source.slice(runGamesStart, source.indexOf('public static int playOneLevel', runGamesStart));
  const communicationIndex = runGamesBody.indexOf('startPlayerCommunication()');
  const factoryIndex = runGamesBody.indexOf('VGDLFactory.GetInstance().init()');

  assert.ok(communicationIndex !== -1);
  assert.ok(factoryIndex !== -1);
  assert.ok(communicationIndex < factoryIndex);
});

test('VGDLFactory avoids eager sprite and effect class loading at startup', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'core', 'vgdl', 'VGDLFactory.java'),
    'utf-8'
  );
  const initBody = source.slice(source.indexOf('public void init()'), source.indexOf('private Class resolveClass'));

  assert.match(source, /private String\[\] spriteClassNames/);
  assert.match(source, /private String\[\] effectClassNames/);
  assert.match(source, /Class\.forName\(className\)/);
  assert.equal(initBody.includes('spriteClasses[i]'), false);
  assert.equal(initBody.includes('effectClasses[i]'), false);
  assert.equal(initBody.includes('terminationClasses[i]'), false);
});

test('prepared Java runtime copies the local VGDLFactory override', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'prepare-java-runtime.js'),
    'utf-8'
  );

  assert.match(source, /src\/core\/vgdl\/VGDLFactory\.java/);
});
