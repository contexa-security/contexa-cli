'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { runApplication, failureSummary, failureHint } = require('../src/core/app-runner');
const en = require('../src/i18n/en.json');

const PORT_FAILURE = [
  '2026-11-02T10:00:00.000+09:00  INFO 1234 --- [main] o.s.b.w.e.tomcat.TomcatWebServer : Tomcat initialized with port 8080 (http)',
  '2026-11-02T10:00:01.000+09:00 ERROR 1234 --- [main] o.s.b.d.LoggingFailureAnalysisReporter :',
  '',
  '***************************',
  'APPLICATION FAILED TO START',
  '***************************',
  '',
  'Description:',
  '',
  'Web server failed to start. Port 8080 was already in use.',
  '',
  'Action:',
  '',
  "Identify and stop the process that's listening on port 8080 or configure this application to listen on another port.",
  '',
].join('\n');

// --- failureSummary --------------------------------------------------------------------------

test('failureSummary: the APPLICATION FAILED TO START block without banners and blank lines', () => {
  assert.equal(failureSummary(PORT_FAILURE), [
    'Description:',
    'Web server failed to start. Port 8080 was already in use.',
    'Action:',
    "Identify and stop the process that's listening on port 8080 or configure this application to listen on another port.",
  ].join('\n'));
  assert.equal(failureSummary(PORT_FAILURE.replace(/\n/g, '\r\n')).split('\n').length, 4, 'CRLF logs too');
});

test('failureSummary: a long failure block is cut to twelve lines', () => {
  const lines = ['APPLICATION FAILED TO START', '***', ...Array.from({ length: 30 }, (_, index) => `line ${index}`)];
  const summary = failureSummary(lines.join('\n')).split('\n');
  assert.equal(summary.length, 12);
  assert.equal(summary[0], 'line 0');
  assert.equal(summary[11], 'line 11');
});

test('failureSummary: otherwise the last "Caused by:" line', () => {
  const log = [
    'Exception in thread "main" org.springframework.beans.factory.BeanCreationException: Error creating bean',
    'Caused by: java.lang.IllegalStateException: first cause',
    '\tat example.Config.bean(Config.java:10)',
    'Caused by: java.net.ConnectException: Connection refused',
    '\tat java.base/sun.nio.ch.Net.connect0(Native Method)',
  ].join('\n');
  assert.equal(failureSummary(log), 'Caused by: java.net.ConnectException: Connection refused');
  assert.equal(failureSummary(`Caused by: ${'x'.repeat(1000)}`).length, 600);
});

test('failureSummary: otherwise the last ERROR line, then the last lines of the log', () => {
  const errors = [
    '10:00:00.000 ERROR [main] first problem',
    '10:00:00.100 INFO  [main] noise',
    '10:00:00.200 ERROR [main] second problem',
    '10:00:00.300 INFO  [main] shutting down',
  ].join('\n');
  assert.equal(failureSummary(errors), '10:00:00.200 ERROR [main] second problem');

  const plain = Array.from({ length: 12 }, (_, index) => `step ${index}`).join('\n') + '\n\n';
  assert.equal(failureSummary(plain), Array.from({ length: 8 }, (_, index) => `step ${index + 4}`).join('\n'));
  assert.equal(failureSummary(''), '');
});

// --- failureHint -----------------------------------------------------------------------------

test('failureHint maps known causes to the fix to suggest', () => {
  const cases = [
    [PORT_FAILURE, 'run.hint.port'],
    ['java.net.BindException: Address already in use', 'run.hint.port'],
    ['IllegalStateException: contexa.datasource.url must be configured', 'run.hint.datasource'],
    ['Connection to 127.0.0.1:55432 refused. Check that the hostname and port are correct', 'run.hint.database'],
    ['Caused by: java.net.ConnectException: Connection refused', 'run.hint.database'],
    ['IllegalStateException: Spring Boot 4.x is not supported by Contexa', 'run.hint.boot4'],
    ['IllegalArgumentException: OpenAI API key must be set', 'run.hint.apiKey'],
    ['Failed to bind properties under spring.ai.anthropic.api-key', 'run.hint.apiKey'],
    ["Could not find ai.ctxa:spring-boot-starter-contexa:0.1.0.", 'run.hint.starter'],
    ["Could not resolve ai.ctxa:spring-boot-starter-contexa:0.1.0.", 'run.hint.starter'],
    ['Failed to bind properties under some.other.api-key', 'run.hint.doctor'],
    ['something else entirely', 'run.hint.doctor'],
    ['', 'run.hint.doctor'],
  ];
  for (const [log, expected] of cases) {
    assert.equal(failureHint(log), expected, log.slice(0, 80));
    assert.equal(typeof en[expected], 'string', `${expected} is in en.json`);
  }
});

test('failureHint: a port clash wins over a refused connection in the same log', () => {
  assert.equal(failureHint('Connection refused\nPort 8080 was already in use'), 'run.hint.port');
});

// --- runApplication with a stand-in wrapper ----------------------------------------------------

async function projectWithWrapper(lines, exitCode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-app-runner-'));
  const batch = ['@echo off', ...lines.map(line => (line ? `echo ${line}` : 'echo.')), `exit /b ${exitCode}`, ''].join('\r\n');
  const shell = ['#!/bin/sh', ...lines.map(line => `echo '${line}'`), `exit ${exitCode}`, ''].join('\n');
  await fs.writeFile(path.join(dir, 'gradlew.bat'), batch);
  await fs.writeFile(path.join(dir, 'gradlew'), shell, { mode: 0o755 });
  return dir;
}

async function quietly(action) {
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await action();
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

test('runApplication reports the address once Spring says Started', async () => {
  const dir = await projectWithWrapper([
    'Tomcat started on port 8081 (http) with context path /',
    'Started DemoApplication in 1.234 seconds (process running for 1.5)',
  ], 0);
  try {
    const started = [];
    const sigintListeners = process.listenerCount('SIGINT');
    const result = await quietly(() => runApplication({ buildTool: 'gradle', projectDir: dir }, {
      onStarted: info => started.push(info),
    }));
    assert.deepEqual(started, [{ port: 8081 }]);
    assert.equal(result.outcome, 'stopped');
    assert.equal(result.port, 8081);
    assert.equal(process.listenerCount('SIGINT'), sigintListeners, 'the Ctrl+C guard is removed again');
  } finally { await fs.remove(dir); }
});

test('runApplication explains a start that fails before Started', async () => {
  const dir = await projectWithWrapper([
    '***************************',
    'APPLICATION FAILED TO START',
    '***************************',
    '',
    'Description:',
    'Web server failed to start. Port 8080 was already in use.',
  ], 1);
  try {
    let startedCalls = 0;
    const result = await quietly(() => runApplication({ buildTool: 'gradle', projectDir: dir }, {
      onStarted: () => { startedCalls += 1; },
    }));
    assert.equal(startedCalls, 0);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.status, 1);
    assert.match(result.summary, /Port 8080 was already in use/);
    assert.equal(result.hint, 'run.hint.port');
  } finally { await fs.remove(dir); }
});

// A multi-module Maven build: the root has the wrapper, the application is the module "app".
// The stand-in wrapper records every call in calls.txt.
async function mavenModuleWithWrapper({ installFails }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-app-runner-maven-'));
  await fs.outputFile(path.join(root, 'pom.xml'), '<project><modules><module>app</module></modules></project>\n');
  await fs.outputFile(path.join(root, 'app', 'pom.xml'), '<project><artifactId>app</artifactId></project>\n');
  const batch = installFails
    ? ['@echo off', 'echo %*>> "%~dp0calls.txt"', 'echo [ERROR] Failed to execute goal on project app: install failed', 'exit /b 1', '']
    : [
      '@echo off',
      'echo %*>> "%~dp0calls.txt"',
      'echo %*| findstr /C:"spring-boot:run" >nul',
      'if errorlevel 1 exit /b 0',
      'echo Started DemoApplication in 1.0 seconds (process running for 1.2)',
      'exit /b 0',
      '',
    ];
  const shell = installFails
    ? ['#!/bin/sh', 'echo "$*" >> "$(dirname "$0")/calls.txt"', "echo '[ERROR] Failed to execute goal on project app: install failed'", 'exit 1', '']
    : [
      '#!/bin/sh',
      'echo "$*" >> "$(dirname "$0")/calls.txt"',
      "case \"$*\" in *spring-boot:run*) echo 'Started DemoApplication in 1.0 seconds (process running for 1.2)';; esac",
      'exit 0',
      '',
    ];
  await fs.writeFile(path.join(root, 'mvnw.cmd'), batch.join('\r\n'));
  await fs.writeFile(path.join(root, 'mvnw'), shell.join('\n'), { mode: 0o755 });
  return root;
}

async function calls(root) {
  const file = path.join(root, 'calls.txt');
  if (!await fs.pathExists(file)) return [];
  return (await fs.readFile(file, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

test('runApplication installs the modules a Maven module needs, then runs it', async () => {
  const root = await mavenModuleWithWrapper({ installFails: false });
  try {
    const started = [];
    const result = await quietly(() => runApplication({ buildTool: 'maven', projectDir: path.join(root, 'app') }, {
      onStarted: info => started.push(info),
    }));
    assert.equal(result.outcome, 'stopped');
    assert.deepEqual(started, [{ port: 8080 }], 'no port in the log: the default is shown');
    assert.deepEqual(await calls(root), [
      '-B -q -pl app -am install -DskipTests',
      '-B -pl app spring-boot:run',
    ]);
  } finally { await fs.remove(root); }
});

test('runApplication stops with a reason when the preparation step fails, without running the application', async () => {
  const root = await mavenModuleWithWrapper({ installFails: true });
  try {
    const result = await quietly(() => runApplication({ buildTool: 'maven', projectDir: path.join(root, 'app') }));
    assert.equal(result.outcome, 'failed');
    assert.equal(result.status, 1);
    assert.equal(result.summary, '[ERROR] Failed to execute goal on project app: install failed');
    assert.equal(result.hint, 'run.hint.doctor');
    assert.deepEqual(await calls(root), ['-B -q -pl app -am install -DskipTests'], 'spring-boot:run never started');
  } finally { await fs.remove(root); }
});

test('runApplication without a wrapper or a build tool on PATH has nothing to run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-app-runner-none-'));
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.deepEqual(await runApplication({ buildTool: 'gradle', projectDir: dir }), { outcome: 'no-build-tool' });
  } finally {
    process.env.PATH = saved;
    await fs.remove(dir);
  }
});
