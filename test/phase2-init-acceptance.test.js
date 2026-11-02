'use strict';

// Acceptance tests for `contexa init` as a process: locking, concurrency, termination at every
// durable state, repetition, and unusual paths. The CLI runs with the test hooks from
// test/harness.js (no Docker, build tool, Java or network).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { spawn } = require('node:child_process');

const {
  ROOT,
  createSandbox,
  localStatePath,
  cliEnv,
  runCli,
  createGradleProject,
  snapshotDirectory,
  starterCount,
} = require('./harness');
const releaseManifest = require('../release-manifest.json');
const {
  INSTALL_MODES,
  acquireInstallLock,
  calculateResourceDigest,
  installLockPath,
  loadManifest,
  manifestPath,
  releaseInstallLock,
} = require('../src/core/manifest');

const YML = path.join('src', 'main', 'resources', 'application.yml');
const CONFIG = path.join('src', 'main', 'resources', 'config', 'application.yml');
const MAIN_CLASS = path.join('src', 'main', 'java', 'example', 'SampleApplication.java');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function sandboxFor(t, prefix) {
  const sandbox = await createSandbox(prefix);
  t.after(() => fs.remove(sandbox.root));
  return sandbox;
}

function runInit(project, sandbox, extra = [], overrides = {}) {
  return runCli(['init', '--yes', '--dir', project, ...extra], { env: cliEnv(sandbox, overrides) });
}

// Starts init in a child process that stops for good right after the manifest reaches
// `targetState`, and writes `signalPath` at that moment.
function runInterruptedInit(project, sandbox, targetState, signalPath) {
  const script = [
    "'use strict';",
    "const fs = require('fs-extra');",
    `const manifestPath = ${JSON.stringify(path.join(ROOT, 'src/core/manifest.js'))};`,
    `const initPath = ${JSON.stringify(path.join(ROOT, 'src/core/init-application.js'))};`,
    'const project = process.argv[1];',
    'const targetState = process.argv[2];',
    'const signalPath = process.argv[3];',
    'const originalRename = fs.rename;',
    'let signalled = false;',
    'fs.rename = async (source, destination) => {',
    '  await originalRename(source, destination);',
    "  if (signalled || !String(destination).endsWith('manifest.json')) return;",
    '  const current = await fs.readJson(destination);',
    '  const transaction = current.transaction;',
    '  const states = new Set((transaction && transaction.journal || []).map(entry => entry.state));',
    "  const reached = targetState === 'PREPARED'",
    "    ? transaction && transaction.status === 'IN_PROGRESS' && states.has('PREPARED')",
    "    : targetState === 'APPLIED'",
    "      ? transaction && transaction.status === 'IN_PROGRESS' && states.has('APPLIED')",
    "      : transaction && transaction.status === 'COMMITTED';",
    '  if (!reached) return;',
    '  signalled = true;',
    "  await fs.writeFile(signalPath, targetState, 'utf8');",
    '  setInterval(() => {}, 1000);',
    '  await new Promise(() => {});',
    '};',
    'require(manifestPath);',
    'const { executeInit } = require(initPath);',
    'executeInit({ dir: project, yes: true })',
    '  .then(() => process.exit(0))',
    '  .catch(error => { console.error(error.stack || error); process.exit(2); });',
  ].join('\n');
  return spawn(process.execPath, ['-e', script, project, targetState, signalPath], {
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
  throw new Error(`Timed out waiting for durable init state: ${filePath}`);
}

function awaitClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

test('Phase 2 no-op init refreshes release provenance without changing customer files', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-provenance-');
  const project = await createGradleProject(sandbox.root, 'provenance-refresh');
  const initial = await runInit(project, sandbox);
  assert.equal(initial.code, 0, initial.output);

  const customerFiles = ['build.gradle', YML, MAIN_CLASS, CONFIG].map(file => path.join(project, file));
  const before = new Map();
  for (const file of customerFiles) before.set(file, sha256(await fs.readFile(file)));

  const current = await loadManifest(project, INSTALL_MODES.NORMAL);
  current.metadata.cliVersion = '0.0.0';
  current.metadata.starterVersion = '0.0.0-SNAPSHOT';
  current.metadata.resourceDigest = calculateResourceDigest(current);
  await fs.writeJson(manifestPath(project, INSTALL_MODES.NORMAL), current, { spaces: 2 });

  // Plain `contexa init` in the project folder, without flags (stdin is not a terminal here).
  const repeated = await runCli(['init'], { cwd: project, env: cliEnv(sandbox) });
  assert.equal(repeated.code, 0, repeated.output);
  for (const file of customerFiles) {
    assert.equal(sha256(await fs.readFile(file)), before.get(file), file);
  }
  const refreshed = await loadManifest(project, INSTALL_MODES.NORMAL);
  assert.equal(refreshed.metadata.cliVersion, releaseManifest.cliVersion);
  assert.equal(refreshed.metadata.starterVersion, releaseManifest.starter.version);
});

test('Phase 2 malformed Gradle build fails without customer-file mutation', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-malformed-');
  const project = await createGradleProject(sandbox.root, 'malformed-build');
  const buildPath = path.join(project, 'build.gradle');
  await fs.writeFile(buildPath, "plugins {\n  id 'org.springframework.boot'\n", 'utf8');
  const before = await snapshotDirectory(project);
  const result = await runInit(project, sandbox);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /INVALID_BUILD_FILE/);
  assert.match(result.stderr, /Gradle script is malformed/);
  assert.match(result.stderr, /Fix it and run contexa init again/);
  assert.deepEqual(await snapshotDirectory(project), before);
  assert.equal(await fs.pathExists(installLockPath(project)), false);
});

test('Phase 2 lock rejects a live owner and recovers a stale owner', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-lock-'));
  try {
    const normal = await acquireInstallLock(project, INSTALL_MODES.NORMAL);
    await assert.rejects(
      acquireInstallLock(project, INSTALL_MODES.NORMAL, 'reset'),
      error => error.code === 'INIT_ALREADY_RUNNING' && error.messageKey === 'init.error.alreadyRunning');
    await releaseInstallLock(normal);
    assert.equal(await fs.pathExists(installLockPath(project)), false);

    await fs.ensureDir(path.dirname(installLockPath(project)));
    await fs.writeJson(installLockPath(project), {
      pid: 2147483647,
      token: 'terminated-owner',
      mode: INSTALL_MODES.NORMAL,
    });
    const recovered = await acquireInstallLock(project, INSTALL_MODES.NORMAL);
    await releaseInstallLock(recovered);
    assert.equal(await fs.pathExists(installLockPath(project)), false);
  } finally {
    await fs.remove(project);
  }
});

test('Phase 2 init is rejected ten times while another process holds the lock, then retry succeeds', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-same-');
  const project = await createGradleProject(sandbox.root, 'same-project');
  const before = await snapshotDirectory(project);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Re-taken before every attempt: a rejected init currently removes the owner's lock file
    // (see the TODO test below).
    const held = await acquireInstallLock(project, INSTALL_MODES.NORMAL, 'test');
    const rejected = await runInit(project, sandbox);
    await releaseInstallLock(held);
    assert.notEqual(rejected.code, 0, `attempt ${attempt + 1}`);
    assert.match(rejected.stderr, /INIT_ALREADY_RUNNING/);
    assert.deepEqual(await snapshotDirectory(project, { exclude: ['contexa'] }),
      before.filter(entry => !entry.path.startsWith('contexa')));
  }

  const retry = await runInit(project, sandbox);
  assert.equal(retry.code, 0, retry.output);
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
  assert.equal(await fs.readFile(path.join(project, YML), 'utf8'), 'server:\n  port: 9080\nhost-owned:\n  marker: keep\n');
  assert.equal(await fs.pathExists(installLockPath(project)), false);
});

test('Phase 2 a rejected init leaves the running owner\'s lock in place', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-lock-kept-');
  const project = await createGradleProject(sandbox.root, 'lock-kept');
  const held = await acquireInstallLock(project, INSTALL_MODES.NORMAL, 'test');
  try {
    const rejected = await runInit(project, sandbox);
    assert.match(rejected.stderr, /INIT_ALREADY_RUNNING/);
    assert.equal(await fs.pathExists(held.filePath), true, 'the owner\'s lock file survives');
    const third = await runInit(project, sandbox);
    assert.notEqual(third.code, 0, 'a further init is still rejected');
  } finally {
    await releaseInstallLock(held);
  }
});

test('Phase 2 actual init process recovers after termination at every durable state', { timeout: 180000 }, async t => {
  for (const state of ['PREPARED', 'APPLIED', 'COMMITTED']) {
    await t.test(state, async () => {
      const sandbox = await createSandbox(`ctxa-phase2-kill-${state.toLowerCase()}-`);
      const project = await createGradleProject(sandbox.root, `kill-${state.toLowerCase()}`);
      const signalPath = path.join(sandbox.root, `${state}.signal`);
      const ymlPath = path.join(project, YML);
      const originalYml = await fs.readFile(ymlPath);
      try {
        const child = runInterruptedInit(project, sandbox, state, signalPath);
        child.stdout.resume();
        child.stderr.resume();
        const closed = awaitClose(child);
        await awaitFile(signalPath);
        child.kill('SIGKILL');
        await closed;

        const retry = await runInit(project, sandbox);
        assert.equal(retry.code, 0, `${state}: ${retry.output}`);
        assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
        assert.equal(((await fs.readFile(path.join(project, MAIN_CLASS), 'utf8')).match(/@EnableAISecurity/g) || []).length, 1);
        assert.deepEqual(await fs.readFile(ymlPath), originalYml);
        assert.equal(await fs.pathExists(installLockPath(project)), false);
        assert.equal((await loadManifest(project)).transaction.status, 'COMMITTED');
        assert.ok(await fs.pathExists(path.join(project, 'contexa', '.gitignore')));

        const removed = await runCli(['reset', '--yes', '--dir', project], { env: cliEnv(sandbox) });
        assert.equal(removed.code, 0, `${state} reset: ${removed.output}`);
        assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 0);
        assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
      } finally {
        await fs.remove(sandbox.root);
      }
    });
  }
});

test('Phase 2 twenty different projects initialize concurrently without cross-project damage', { timeout: 180000 }, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-many-'));
  try {
    // One computer-wide state per project; the shared state file is tested on its own below.
    const sandboxes = await Promise.all(Array.from({ length: 20 }, () => createSandbox('ctxa-phase2-many-home-')));
    const projects = await Promise.all(sandboxes.map((sandbox, index) =>
      createGradleProject(parent, `project-${index}`)));
    const results = await Promise.all(projects.map((project, index) => runInit(project, sandboxes[index])));
    results.forEach((result, index) =>
      assert.equal(result.code, 0, `project ${index}: ${result.output}`));
    for (const [index, project] of projects.entries()) {
      assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
      assert.equal(await fs.readFile(path.join(project, YML), 'utf8'), 'server:\n  port: 9080\nhost-owned:\n  marker: keep\n');
      const settings = yaml.load(await fs.readFile(path.join(project, CONFIG), 'utf8'));
      assert.equal(settings.contexa.datasource.url, `\${CONTEXA_DB_URL:jdbc:postgresql://127.0.0.1:55432/contexa_project_${index}}`);
      assert.equal(await fs.pathExists(installLockPath(project)), false);
    }
    await Promise.all(sandboxes.map(sandbox => fs.remove(sandbox.root)));
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 2 concurrent inits on one computer all succeed and are all registered', { timeout: 180000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-shared-');
  const projects = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    createGradleProject(sandbox.root, `shared-${index}`)));
  const results = await Promise.all(projects.map(project => runInit(project, sandbox)));
  assert.deepEqual(results.map(result => result.code), projects.map(() => 0),
    results.filter(result => result.code !== 0).map(result => result.stderr.trim().split('\n').pop()).join('\n'));
  const state = await fs.readJson(localStatePath(sandbox));
  assert.equal(Object.keys(state.projects).length, projects.length);
});

test('Phase 2 init remains idempotent for 100 sequential runs', { timeout: 600000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-repeat-');
  const project = await createGradleProject(sandbox.root, 'repeat-project');
  const first = await runInit(project, sandbox);
  assert.equal(first.code, 0, first.output);
  const expected = await snapshotDirectory(project, { exclude: ['contexa'] });
  const firstManifest = await loadManifest(project);
  for (let index = 0; index < 99; index += 1) {
    const result = await runInit(project, sandbox);
    assert.equal(result.code, 0, `run ${index + 2}: ${result.output}`);
  }
  assert.deepEqual(await snapshotDirectory(project, { exclude: ['contexa'] }), expected);
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
  const lastManifest = await loadManifest(project);
  assert.equal(lastManifest.transaction.status, 'COMMITTED');
  assert.equal(lastManifest.metadata.installationId, firstManifest.metadata.installationId);
  assert.deepEqual(lastManifest.files.map(file => [file.relativePath, file.originalChecksum]).sort(),
    firstManifest.files.map(file => [file.relativePath, file.originalChecksum]).sort());
  const transactions = path.join(project, 'contexa', '.cli', 'bak', '__transactions__');
  const leftovers = (await fs.pathExists(transactions)) ? await fs.readdir(transactions) : [];
  assert.ok(leftovers.length <= 1, `committed transaction backups are not piling up: ${leftovers.length}`);
  const state = await fs.readJson(localStatePath(sandbox));
  assert.equal(Object.keys(state.projects).length, 1);
});

test('Phase 2 init and reset support spaces, Korean, and a long project path', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-path-');
  const project = await createGradleProject(sandbox.root, `공백 한글 ${'long-segment-'.repeat(8)}`,
    { projectName: 'path-test' });
  const before = await snapshotDirectory(project);
  const result = await runInit(project, sandbox);
  assert.equal(result.code, 0, result.output);
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
  assert.ok(await fs.pathExists(path.join(project, CONFIG)));
  const state = await fs.readJson(localStatePath(sandbox));
  assert.deepEqual(Object.values(state.projects).map(item => item.path), [path.resolve(project)]);

  const removed = await runCli(['reset', '--yes', '--dir', project], { env: cliEnv(sandbox) });
  assert.equal(removed.code, 0, removed.output);
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('Phase 2 host database profiles stay untouched across five init repetitions', { timeout: 180000 }, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-phase2-profiles-');
  const profiles = [
    {
      id: 'external-contexa-db',
      yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg:5432/contexa\n',
      expect: settings => {
        assert.equal(settings.contexa.datasource.url, undefined, 'the host URL is not overridden');
        assert.equal(settings.contexa.datasource.isolation['contexa-owned-application'], true);
      },
    },
    {
      id: 'separate-host-and-contexa-db',
      yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db:5432/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://contexa-db:5432/contexa\n',
      expect: settings => {
        assert.equal(settings.contexa.datasource.url, undefined);
        assert.equal(settings.contexa.datasource.isolation['contexa-owned-application'], false);
      },
    },
    {
      id: 'host-db-only',
      yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://shared-db:5432/host\n',
      expect: settings => {
        assert.match(settings.contexa.datasource.url, /^\$\{CONTEXA_DB_URL:jdbc:postgresql:\/\/127\.0\.0\.1:55432\/contexa_/);
        assert.equal(settings.contexa.datasource.isolation['contexa-owned-application'], false);
      },
    },
  ];
  for (const profile of profiles) {
    await t.test(profile.id, async () => {
      const project = await createGradleProject(sandbox.root, profile.id, { yml: profile.yml });
      const ymlPath = path.join(project, YML);
      const originalYml = await fs.readFile(ymlPath);
      let stable = null;
      for (let repeat = 0; repeat < 5; repeat += 1) {
        const result = await runInit(project, sandbox);
        assert.equal(result.code, 0, `${profile.id} repeat ${repeat + 1}: ${result.output}`);
        const current = await snapshotDirectory(project, { exclude: ['contexa'] });
        if (stable) assert.deepEqual(current, stable);
        stable = current;
        assert.deepEqual(await fs.readFile(ymlPath), originalYml);
        assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
      }
      profile.expect(yaml.load(await fs.readFile(path.join(project, CONFIG), 'utf8')));
    });
  }
});
