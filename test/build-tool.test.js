'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const MODULE_ID = require.resolve('../src/core/build-tool');
const buildTool = require('../src/core/build-tool');

// build-tool decides between Windows and POSIX when it is loaded; load a copy as the other
// platform to check the commands it shows there.
function loadBuildToolAs(platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const cached = require.cache[MODULE_ID];
  delete require.cache[MODULE_ID];
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return require(MODULE_ID);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    delete require.cache[MODULE_ID];
    if (cached) require.cache[MODULE_ID] = cached;
  }
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-build-tool-'));
}

async function touch(file, content = '') {
  await fs.outputFile(file, content);
}

// Both wrapper flavours, so either platform's lookup finds one.
async function gradleWrappers(dir) {
  await touch(path.join(dir, 'gradlew'), '#!/bin/sh\n');
  await touch(path.join(dir, 'gradlew.bat'), '@echo off\r\n');
}

async function mavenWrappers(dir) {
  await touch(path.join(dir, 'mvnw'), '#!/bin/sh\n');
  await touch(path.join(dir, 'mvnw.cmd'), '@echo off\r\n');
}

async function withEnv(values, action) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const windows = loadBuildToolAs('win32');
const posix = loadBuildToolAs('linux');

// --- resolutionProblems ----------------------------------------------------------------------

test('resolutionProblems: Gradle FAILED lines name the unresolved coordinates', () => {
  const output = [
    "runtimeClasspath - Runtime classpath of source set 'main'.",
    '+--- org.springframework.boot:spring-boot-starter-web -> 3.5.4',
    '+--- ai.ctxa:spring-boot-starter-contexa:0.1.0 FAILED',
    '+--- org.springframework.ai:spring-ai-starter-model-ollama -> 1.1.8 FAILED',
    '\\--- org.springframework.ai:spring-ai-starter-model-ollama -> 1.1.8 FAILED',
  ].join('\n');
  assert.deepEqual(buildTool.resolutionProblems('gradle', output), [
    'ai.ctxa:spring-boot-starter-contexa:0.1.0',
    'org.springframework.ai:spring-ai-starter-model-ollama',
  ]);
});

test('resolutionProblems: Gradle "Could not find" lines name the missing coordinate', () => {
  const output = [
    "Execution failed for task ':dependencies'.",
    "> Could not resolve all files for configuration ':runtimeClasspath'.",
    '   > Could not find ai.ctxa:spring-boot-starter-contexa:0.1.0',
    '     Required by:',
    '         project :',
  ].join('\r\n');
  assert.deepEqual(buildTool.resolutionProblems('gradle', output), ['ai.ctxa:spring-boot-starter-contexa:0.1.0']);
});

test('resolutionProblems: Gradle prints "Could not find g:a:v." with a period, which is not part of the version', () => {
  const output = [
    '+--- ai.ctxa:spring-boot-starter-contexa:0.1.0 FAILED',
    '   > Could not find ai.ctxa:spring-boot-starter-contexa:0.1.0.',
  ].join('\n');
  assert.deepEqual(buildTool.resolutionProblems('gradle', output), ['ai.ctxa:spring-boot-starter-contexa:0.1.0']);
});

test('resolutionProblems: Maven "Could not find artifact" and "Failure to find" lines', () => {
  assert.deepEqual(buildTool.resolutionProblems('maven',
    '[ERROR] Could not find artifact ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 in central (https://repo.maven.apache.org/maven2)'),
  ['ai.ctxa:spring-boot-starter-contexa:jar:0.1.0']);
  assert.deepEqual(buildTool.resolutionProblems('maven', [
    '[ERROR] Failure to find ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 in https://repo.maven.apache.org/maven2 was cached in the local repository',
    '[ERROR] Failure to find org.springframework.ai:spring-ai-bom:pom:9.9.9 in https://repo.maven.apache.org/maven2 was cached in the local repository',
    '[ERROR] Failure to find ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 in https://repo.maven.apache.org/maven2 was cached in the local repository',
  ].join('\r\n')), [
    'ai.ctxa:spring-boot-starter-contexa:jar:0.1.0',
    'org.springframework.ai:spring-ai-bom:pom:9.9.9',
  ]);
  assert.deepEqual(buildTool.resolutionProblems('maven', '[INFO] BUILD SUCCESS'), []);
  assert.deepEqual(buildTool.resolutionProblems('gradle', 'BUILD SUCCESSFUL in 2s'), []);
});

test('resolutionProblems: Maven\'s one-line error names the missing artifact, not the project', () => {
  const line = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-dependency-plugin:3.8.1:tree (default-cli) on project demo: '
    + 'Could not resolve dependencies for project com.example:demo:jar:0.0.1-SNAPSHOT: The following artifacts could not be resolved: '
    + 'ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 (absent): Could not find artifact ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 '
    + 'in central (https://repo.maven.apache.org/maven2) -> [Help 1]';
  assert.deepEqual(buildTool.resolutionProblems('maven', line), ['ai.ctxa:spring-boot-starter-contexa:jar:0.1.0']);
});

test('resolutionProblems: Maven cached failures and download failures name the artifact', () => {
  const cached = '[ERROR] Failed to execute goal on project demo: Could not resolve dependencies for project com.example:demo:jar:0.0.1-SNAPSHOT: '
    + 'The following artifacts could not be resolved: ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 (absent): '
    + 'ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 was not found in https://repo.maven.apache.org/maven2 during a previous attempt.';
  assert.deepEqual(buildTool.resolutionProblems('maven', cached), ['ai.ctxa:spring-boot-starter-contexa:jar:0.1.0']);
  const offline = '[ERROR] Could not transfer artifact ai.ctxa:spring-boot-starter-contexa:jar:0.1.0 from/to central '
    + '(https://repo.maven.apache.org/maven2): repo.maven.apache.org: Unknown host';
  assert.deepEqual(buildTool.resolutionProblems('maven', offline), ['ai.ctxa:spring-boot-starter-contexa:jar:0.1.0']);
});

// --- buildInvocation -------------------------------------------------------------------------

test('buildInvocation: Gradle at the build root uses the wrapper without a task prefix', async () => {
  const dir = await tempDir();
  try {
    await gradleWrappers(dir);
    const invocation = buildTool.buildInvocation({ buildTool: 'gradle', projectDir: dir, gradleRootDir: null });
    assert.deepEqual(invocation, {
      tool: 'gradle',
      cwd: dir,
      command: path.join(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
      wrapper: true,
      taskPrefix: '',
    });
    assert.equal(posix.buildInvocation({ buildTool: 'gradle', projectDir: dir }).command, path.join(dir, 'gradlew'));
    assert.equal(windows.buildInvocation({ buildTool: 'gradle', projectDir: dir }).command, path.join(dir, 'gradlew.bat'));
  } finally { await fs.remove(dir); }
});

test('buildInvocation: a Gradle module runs from the root wrapper with a :module: prefix', async () => {
  const dir = await tempDir();
  try {
    await gradleWrappers(dir);
    const app = path.join(dir, 'app');
    const nested = path.join(dir, 'services', 'api');
    const module = buildTool.buildInvocation({ buildTool: 'gradle', projectDir: app, gradleRootDir: dir });
    assert.equal(module.cwd, dir);
    assert.equal(module.taskPrefix, ':app:');
    assert.equal(buildTool.buildInvocation({ buildTool: 'gradle', projectDir: nested, gradleRootDir: dir }).taskPrefix,
      ':services:api:');
  } finally { await fs.remove(dir); }
});

test('buildInvocation: Maven uses the wrapper, from the parent folder for a module', async () => {
  const dir = await tempDir();
  try {
    await mavenWrappers(dir);
    await touch(path.join(dir, 'pom.xml'), '<project/>');
    assert.deepEqual(buildTool.buildInvocation({ buildTool: 'maven', projectDir: dir }), {
      tool: 'maven',
      cwd: dir,
      command: path.join(dir, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'),
      wrapper: true,
      moduleArgs: [],
    });
    const app = path.join(dir, 'app');
    await touch(path.join(app, 'pom.xml'), '<project/>');
    const module = buildTool.buildInvocation({ buildTool: 'maven', projectDir: app });
    assert.equal(module.cwd, dir);
    assert.deepEqual(module.moduleArgs, ['-pl', 'app', '-am']);
  } finally { await fs.remove(dir); }
});

test('buildInvocation: without a wrapper or a build tool on PATH there is nothing to run', async () => {
  const dir = await tempDir();
  const emptyPath = await tempDir();
  try {
    // process.env is case-insensitive on Windows, so PATH also replaces Path there.
    await withEnv({ PATH: emptyPath }, async () => {
      assert.equal(buildTool.buildInvocation({ buildTool: 'gradle', projectDir: dir }), null);
      assert.equal(buildTool.buildInvocation({ buildTool: 'maven', projectDir: dir }), null);
      assert.equal(buildTool.runCommandText({ buildTool: 'gradle', projectDir: dir }), 'gradle bootRun');
      assert.equal(buildTool.runCommandText({ buildTool: 'maven', projectDir: dir }), 'mvn spring-boot:run');
    });
  } finally {
    await fs.remove(dir);
    await fs.remove(emptyPath);
  }
});

// --- runCommandText / runArgs / spawnArgs ----------------------------------------------------

test('runCommandText: Windows shows .\\gradlew and .\\mvnw (PowerShell does not run a bare gradlew.bat)', async () => {
  const dir = await tempDir();
  try {
    await gradleWrappers(dir);
    await mavenWrappers(dir);
    await touch(path.join(dir, 'pom.xml'), '<project/>');
    await touch(path.join(dir, 'app', 'pom.xml'), '<project/>');
    assert.equal(windows.runCommandText({ buildTool: 'gradle', projectDir: dir }), '.\\gradlew bootRun');
    assert.equal(windows.runCommandText({ buildTool: 'gradle', projectDir: path.join(dir, 'app'), gradleRootDir: dir }),
      '.\\gradlew :app:bootRun');
    assert.equal(windows.runCommandText({ buildTool: 'maven', projectDir: dir }), '.\\mvnw spring-boot:run');
    // A Maven module: install what it depends on first, then run it (one command per line;
    // Windows PowerShell 5.1 has no &&).
    assert.equal(windows.runCommandText({ buildTool: 'maven', projectDir: path.join(dir, 'app') }),
      '.\\mvnw -pl app -am install -DskipTests\n.\\mvnw -pl app spring-boot:run');
  } finally { await fs.remove(dir); }
});

test('runCommandText: POSIX shows ./gradlew and ./mvnw', async () => {
  const dir = await tempDir();
  try {
    await gradleWrappers(dir);
    await mavenWrappers(dir);
    assert.equal(posix.runCommandText({ buildTool: 'gradle', projectDir: dir }), './gradlew bootRun');
    assert.equal(posix.runCommandText({ buildTool: 'gradle', projectDir: path.join(dir, 'app'), gradleRootDir: dir }),
      './gradlew :app:bootRun');
    assert.equal(posix.runCommandText({ buildTool: 'maven', projectDir: dir }), './mvnw spring-boot:run');
    await touch(path.join(dir, 'pom.xml'), '<project/>');
    await touch(path.join(dir, 'services', 'pom.xml'), '<project/>');
    await touch(path.join(dir, 'services', 'api', 'pom.xml'), '<project/>');
    assert.equal(posix.runCommandText({ buildTool: 'maven', projectDir: path.join(dir, 'services', 'api') }),
      './mvnw -pl services/api -am install -DskipTests\n./mvnw -pl services/api spring-boot:run');
  } finally { await fs.remove(dir); }
});

test('runSteps: Gradle bootRun, Maven spring-boot:run, a Maven module installs its dependencies first', async () => {
  await withEnv({ CONTEXA_TEST_GRADLE_INIT_SCRIPT: undefined }, async () => {
    assert.deepEqual(buildTool.runSteps({ tool: 'gradle', taskPrefix: ':app:' }), [['--console=plain', ':app:bootRun']]);
    assert.deepEqual(buildTool.runSteps({ tool: 'maven', moduleArgs: [] }), [['-B', 'spring-boot:run']]);
    // `-am spring-boot:run` would run the goal on the parent too and fail there.
    assert.deepEqual(buildTool.runSteps({ tool: 'maven', moduleArgs: ['-pl', 'app', '-am'] }), [
      ['-B', '-q', '-pl', 'app', '-am', 'install', '-DskipTests'],
      ['-B', '-pl', 'app', 'spring-boot:run'],
    ]);
  });
  await withEnv({ CONTEXA_TEST_GRADLE_INIT_SCRIPT: 'local-repo.gradle' }, async () => {
    assert.deepEqual(buildTool.runSteps({ tool: 'gradle', taskPrefix: '' }),
      [['-I', 'local-repo.gradle', '--console=plain', 'bootRun']]);
    assert.deepEqual(buildTool.runSteps({ tool: 'maven', moduleArgs: [] }), [['-B', 'spring-boot:run']],
      'Maven reads MAVEN_ARGS itself');
  });
  await withEnv({ CONTEXA_TEST_GRADLE_INIT_SCRIPT: undefined }, async () => {
    assert.deepEqual(buildTool.runSteps({ tool: 'gradle', taskPrefix: '' }, { initScript: 'explicit.gradle' }),
      [['-I', 'explicit.gradle', '--console=plain', 'bootRun']]);
  });
});

test('runArgs: the last step, the one that runs the application', async () => {
  await withEnv({ CONTEXA_TEST_GRADLE_INIT_SCRIPT: undefined }, async () => {
    assert.deepEqual(buildTool.runArgs({ tool: 'gradle', taskPrefix: ':app:' }), ['--console=plain', ':app:bootRun']);
    assert.deepEqual(buildTool.runArgs({ tool: 'maven', moduleArgs: [] }), ['-B', 'spring-boot:run']);
    assert.deepEqual(buildTool.runArgs({ tool: 'maven', moduleArgs: ['-pl', 'app', '-am'] }),
      ['-B', '-pl', 'app', 'spring-boot:run']);
  });
});

test('spawnArgs: Windows goes through cmd.exe with quoted paths, POSIX runs the wrapper directly', () => {
  const [command, args] = windows.spawnArgs({ command: 'C:\\My Projects\\shop\\gradlew.bat', wrapper: true },
    ['-q', ':app:dependencies']);
  assert.equal(command, 'cmd.exe');
  assert.deepEqual(args, ['/d', '/s', '/c', '""C:\\My Projects\\shop\\gradlew.bat" -q :app:dependencies"']);
  assert.deepEqual(posix.spawnArgs({ command: 'mvn', wrapper: false }, ['-B', 'spring-boot:run']),
    ['mvn', ['-B', 'spring-boot:run']]);
});

// --- checkDependencies test hooks ------------------------------------------------------------

test('checkDependencies: CONTEXA_TEST_DEPENDENCY_CHECK replaces the build tool in tests', async () => {
  await withEnv({ CONTEXA_TEST_DEPENDENCY_CHECK: 'pass' }, async () => {
    assert.deepEqual(await buildTool.checkDependencies({ buildTool: 'gradle', projectDir: os.tmpdir() }),
      { skipped: false, ok: true, problems: [], tail: '' });
  });
  await withEnv({ CONTEXA_TEST_DEPENDENCY_CHECK: 'starter-missing' }, async () => {
    const result = await buildTool.checkDependencies({ buildTool: 'maven', projectDir: os.tmpdir() });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ['ai.ctxa:spring-boot-starter-contexa:0.1.0']);
  });
});
