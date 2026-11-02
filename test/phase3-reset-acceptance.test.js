'use strict';

// Acceptance tests for `contexa reset` as a process: termination at every durable stage, locking,
// repetition, project shapes, and an installation left by CLI 0.1.x. The CLI runs with the test
// hooks from test/harness.js (no Docker, build tool, Java or network).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  ROOT,
  CLI_PATH,
  createSandbox,
  localStatePath,
  cliEnv,
  pathWithoutDocker,
  runCli,
  resetResult,
  createGradleProject,
  snapshotDirectory,
  starterCount,
} = require('./harness');
const {
  INSTALL_MODES,
  acquireInstallLock,
  beginInstallTransaction,
  commitInstallTransaction,
  installLockPath,
  manifestPath,
  recordChange,
  releaseInstallLock,
} = require('../src/core/manifest');
const { buildDockerResourceContract } = require('../src/core/reset-service');

async function sandboxFor(t, prefix) {
  const sandbox = await createSandbox(prefix);
  t.after(() => fs.remove(sandbox.root));
  return sandbox;
}

function runInit(project, sandbox, extra = []) {
  return runCli(['init', '--yes', '--dir', project, ...extra], { env: cliEnv(sandbox) });
}

function runReset(project, sandbox, extra = [], overrides = {}) {
  return runCli(['reset', '--yes', '--dir', project, ...extra], { env: cliEnv(sandbox, overrides) });
}

function assertSuccess(result, context) {
  assert.equal(result.code, 0, `${context}: ${result.output}`);
}

// Starts reset in a child process that stops for good right after `stage`, and writes
// `signalPath` at that moment.
function runInterruptedReset(project, sandbox, stage, signalPath) {
  const script = [
    "'use strict';",
    "const fs = require('fs-extra');",
    "const path = require('node:path');",
    `const cliPath = ${JSON.stringify(CLI_PATH)};`,
    'const project = process.argv[1];',
    'const stage = process.argv[2];',
    'const signalPath = process.argv[3];',
    "const config = path.join(project, 'src', 'main', 'resources', 'config', 'application.yml');",
    "const build = path.join(project, 'build.gradle');",
    "const manifest = path.join(project, 'contexa', 'manifest.json');",
    'let signalled = false;',
    'async function stopAt(name) {',
    '  if (signalled || stage !== name) return;',
    '  signalled = true;',
    "  await fs.writeFile(signalPath, name, 'utf8');",
    '  setInterval(() => {}, 1000);',
    '  await new Promise(() => {});',
    '}',
    'const originalRemove = fs.remove;',
    'fs.remove = async target => {',
    '  await originalRemove(target);',
    "  if (String(target) === config) await stopAt('config-removed');",
    '};',
    'const originalCopy = fs.copy;',
    'fs.copy = async (source, destination, options) => {',
    '  await originalCopy(source, destination, options);',
    "  if (String(destination) === build) await stopAt('build-restored');",
    '};',
    'const originalRename = fs.rename;',
    'fs.rename = async (source, destination) => {',
    '  await originalRename(source, destination);',
    "  if (String(destination) !== manifest || stage !== 'manifest-empty') return;",
    '  const current = await fs.readJson(manifest);',
    "  if (Array.isArray(current.files) && current.files.length === 0) await stopAt('manifest-empty');",
    '};',
    "process.argv = [process.execPath, cliPath, 'reset', '--yes', '--dir', project];",
    'require(cliPath);',
  ].join('\n');
  return spawn(process.execPath, ['-e', script, project, stage, signalPath], {
    cwd: ROOT,
    env: cliEnv(sandbox),
    windowsHide: true,
  });
}

async function awaitFile(filePath, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fs.pathExists(filePath)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for reset stage: ${filePath}`);
}

function awaitClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

test('Phase 3 reset recovers after termination at every durable file stage', { timeout: 180000 }, async t => {
  for (const stage of ['config-removed', 'build-restored', 'manifest-empty']) {
    await t.test(stage, async () => {
      const sandbox = await createSandbox(`ctxa-phase3-kill-${stage}-`);
      try {
        const project = await createGradleProject(sandbox.root, `kill-${stage}`);
        const signalPath = path.join(sandbox.root, `${stage}.signal`);
        const before = await snapshotDirectory(project);
        assertSuccess(await runInit(project, sandbox), `${stage} init`);

        const child = runInterruptedReset(project, sandbox, stage, signalPath);
        const closed = awaitClose(child);
        child.stdout.resume();
        child.stderr.resume();
        await awaitFile(signalPath);
        child.kill('SIGKILL');
        await closed;

        const retry = await runReset(project, sandbox);
        assertSuccess(retry, `${stage} retry`);
        assert.equal(resetResult(retry.stdout).result, 'SUCCESS');
        // Every file is the original, and the config/ folder init created is gone again.
        assert.deepEqual(await snapshotDirectory(project), before, `${stage}: the project is as it was`);
        assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
      } finally {
        await fs.remove(sandbox.root);
      }
    });
  }
});

test('Phase 3 a reset retried after termination also removes the config folder init created', { timeout: 60000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-kill-folder-');
  const project = await createGradleProject(sandbox.root, 'kill-folder');
  const signalPath = path.join(sandbox.root, 'config-removed.signal');
  const before = await snapshotDirectory(project);
  assertSuccess(await runInit(project, sandbox), 'init');
  const child = runInterruptedReset(project, sandbox, 'config-removed', signalPath);
  const closed = awaitClose(child);
  child.stdout.resume();
  child.stderr.resume();
  await awaitFile(signalPath);
  child.kill('SIGKILL');
  await closed;
  assertSuccess(await runReset(project, sandbox), 'retry');
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('Phase 3 same-project ten-way reset rejects a live operation and retry succeeds', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-lock-');
  const project = await createGradleProject(sandbox.root, 'same-reset');
  assertSuccess(await runInit(project, sandbox), 'init');
  const installed = await snapshotDirectory(project, { exclude: ['contexa'] });
  const held = await acquireInstallLock(project, INSTALL_MODES.NORMAL, 'test');
  const rejected = await Promise.all(Array.from({ length: 10 }, () => runReset(project, sandbox)));
  assert.equal(await fs.pathExists(held.filePath), true, 'a rejected reset leaves the owner\'s lock alone');
  await releaseInstallLock(held);
  assert.ok(rejected.every(result => result.code !== 0));
  assert.ok(rejected.every(result => /INIT_ALREADY_RUNNING/.test(result.stderr)));
  assert.deepEqual(await snapshotDirectory(project, { exclude: ['contexa'] }), installed);

  const retry = await runReset(project, sandbox);
  assertSuccess(retry, 'retry reset');
  assert.equal(resetResult(retry.stdout).result, 'SUCCESS');
  assert.equal(await fs.pathExists(installLockPath(project)), false);
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 0);
});

test('Phase 3 reset remains a stable no-op across 100 sequential runs', { timeout: 600000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-repeat-');
  const project = await createGradleProject(sandbox.root, 'repeat-reset');
  const before = await snapshotDirectory(project);
  assertSuccess(await runInit(project, sandbox), 'init');
  for (let index = 0; index < 100; index += 1) {
    const result = await runReset(project, sandbox);
    assertSuccess(result, `reset ${index + 1}`);
    assert.equal(resetResult(result.stdout).result, index === 0 ? 'SUCCESS' : 'NO_OWNED_INSTALLATION', `reset ${index + 1}`);
  }
  assert.deepEqual(await snapshotDirectory(project), before);
  assert.deepEqual((await fs.readJson(localStatePath(sandbox))).projects, {});
});

test('Phase 3 reset restores every project shape byte-for-byte', { timeout: 180000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-shapes-');
  const shapes = [
    { id: 'plain' },
    { id: 'host-contexa-db', options: { yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg/contexa\n' } },
    { id: 'host-db', options: { yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db/host\n' } },
    { id: 'user-config-dir', options: { extraFiles: { 'src/main/resources/config/application.properties': 'app.feature=on\r\n' } } },
    { id: 'own-security', options: { security: true } },
    { id: 'openai', args: ['--provider', 'openai'] },
    { id: 'anthropic', args: ['--provider', 'anthropic'] },
    { id: 'external-db', args: ['--db-url', 'jdbc:postgresql://db.example.invalid:5432/contexa'] },
  ];
  for (const shape of shapes) {
    await t.test(shape.id, async () => {
      const project = await createGradleProject(sandbox.root, shape.id, shape.options || {});
      const before = await snapshotDirectory(project);
      assertSuccess(await runInit(project, sandbox, shape.args || []), `${shape.id} init`);
      assert.notDeepEqual(await snapshotDirectory(project), before, `${shape.id}: init changed the project`);
      const reset = await runReset(project, sandbox);
      assertSuccess(reset, `${shape.id} reset`);
      assert.equal(resetResult(reset.stdout).result, 'SUCCESS');
      assert.deepEqual(await snapshotDirectory(project), before, `${shape.id}: byte-for-byte original`);
    });
  }
  const sample = path.join(sandbox.root, 'empty-folder');
  await fs.ensureDir(sample);
  await t.test('sample application', async () => {
    assertSuccess(await runInit(sample, sandbox), 'sample init');
    const reset = await runReset(sample, sandbox);
    assertSuccess(reset, 'sample reset');
    // The sample was created before the installation; reset undoes the installation only.
    const pom = await fs.readFile(path.join(sample, 'pom.xml'), 'utf8');
    assert.doesNotMatch(pom, /spring-boot-starter-contexa|spring-ai-bom/);
    assert.match(pom, /spring-boot-starter-web/);
    assert.equal(await fs.pathExists(path.join(sample, 'contexa')), false);
    assert.equal(await fs.pathExists(path.join(sample, 'src', 'main', 'resources', 'config')), false);
  });
  assert.deepEqual((await fs.readJson(localStatePath(sandbox))).projects, {});
});

test('Phase 3 reset of a 0.1.x installation with an unverifiable Docker stack keeps the stack and restores the project', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-legacy-');
  const project = await createGradleProject(sandbox.root, 'legacy');
  const build = path.join(project, 'build.gradle');
  const original = await fs.readFile(build);
  const infraDir = path.join(project, 'contexa', 'infra');
  const compose = path.join(infraDir, 'docker-compose.yml');
  await fs.outputFile(compose, 'services: {}\n');
  const transactionId = await beginInstallTransaction(project, {
    projectName: 'legacy',
    infra: 'standalone',
    infraDir,
    dockerResources: buildDockerResourceContract('legacy', {
      infra: 'standalone', mode: INSTALL_MODES.NORMAL, installationId: 'legacy-installation',
    }),
  }, INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file' }]);
  await fs.appendFile(build, "dependencies { implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0' }\n");
  await recordChange(project, build, { kind: 'build-file' }, INSTALL_MODES.NORMAL);
  await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);

  // Without a docker executable the old stack cannot be verified, so it is never removed.
  const env = cliEnv(sandbox);
  const result = await runReset(project, sandbox, [], { PATH: pathWithoutDocker(env) });
  assertSuccess(result, 'legacy reset');
  const summary = resetResult(result.stdout);
  assert.equal(summary.result, 'SUCCESS');
  assert.deepEqual(summary.audit.restored.map(item => item.resource), ['build.gradle']);
  assert.ok(summary.audit.preserved.some(item => /Docker CLI is unavailable/.test(item.detail || '')),
    JSON.stringify(summary.audit.preserved));
  assert.match(result.stderr, /could not be matched to this project/);
  assert.deepEqual(await fs.readFile(build), original);
  assert.equal(await fs.pathExists(compose), true, 'the unverified Docker files are left for the user');
  assert.equal(await fs.pathExists(manifestPath(project)), false);
});

test('Phase 3 reset does not stop a running application', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase3-running-');
  const project = await createGradleProject(sandbox.root, 'running-app');
  const server = http.createServer((request, response) => response.end('running'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    assertSuccess(await runInit(project, sandbox), 'init');
    assertSuccess(await runReset(project, sandbox), 'reset while running');
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve(data));
      }).once('error', reject);
    });
    assert.equal(body, 'running');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
