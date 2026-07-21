'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');
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
const { collectInitAnswers } = require('../src/core/init-input');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createProject(parent, name) {
  const project = path.join(parent, name);
  await fs.ensureDir(path.join(project, 'src', 'main', 'resources'));
  await fs.ensureDir(path.join(project, 'src', 'main', 'java', 'example'));
  await fs.writeFile(path.join(project, 'settings.gradle'), `rootProject.name = '${name.replace(/[^a-zA-Z0-9-]/g, '-')}'\n`);
  await fs.writeFile(path.join(project, 'build.gradle'),
    "plugins { id 'org.springframework.boot' version '3.3.0' }\n" +
    "dependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");
  await fs.writeFile(path.join(project, 'src', 'main', 'resources', 'application.yml'),
    'server:\n  port: 9080\nspring:\n  datasource:\n    url: jdbc:postgresql://host-db:5432/host\n');
  await fs.writeFile(path.join(project, 'src', 'main', 'java', 'example', 'SampleApplication.java'),
    'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n' +
    '@SpringBootApplication\npublic class SampleApplication {}\n');
  return project;
}

function runInit(project, extra = [], extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [cliPath, 'init', '--yes', '--dir', project, ...extra],
      { cwd: root, env: { ...process.env, ...extraEnvironment, CONTEXA_LANG: 'en' }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function runInterruptedInit(project, targetState, signalPath) {
  const script = [
    "'use strict';",
    "const fs = require('fs-extra');",
    `const manifestPath = ${JSON.stringify(path.join(root, 'src/core/manifest.js'))};`,
    `const initPath = ${JSON.stringify(path.join(root, 'src/core/init-application.js'))};`,
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
    "executeInit({ dir: project, yes: true, docker: false })",
    '  .then(() => process.exit(0))',
    '  .catch(error => { console.error(error.stack || error); process.exit(2); });',
  ].join('\n');
  return spawn(process.execPath, ['-e', script, project, targetState, signalPath], {
    cwd: root,
    env: { ...process.env, CONTEXA_LANG: 'en' },
    windowsHide: true,
  });
}

async function awaitFile(filePath, timeoutMs = 10000) {
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
function starterCount(buildText) {
  return (buildText.match(/ai\.ctxa:spring-boot-starter-contexa/g) || []).length;
}
function runInitWithoutFlags(project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'init'], {
      cwd: project,
      env: { ...process.env, CONTEXA_LANG: 'en' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('Phase 2 no-op init refreshes release provenance without changing customer files', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-provenance-'));
  t.after(() => fs.remove(parent));
  const project = await createProject(parent, 'provenance-refresh');
  const initial = await runInit(project);
  assert.equal(initial.code, 0, initial.stderr + initial.stdout);

  const customerFiles = [
    path.join(project, 'build.gradle'),
    path.join(project, 'src', 'main', 'resources', 'application.yml'),
    path.join(project, 'src', 'main', 'java', 'example', 'SampleApplication.java'),
  ];
  const before = new Map();
  for (const file of customerFiles) before.set(file, sha256(await fs.readFile(file)));

  const current = await loadManifest(project, INSTALL_MODES.NORMAL);
  current.metadata.cliVersion = '0.0.0';
  current.metadata.starterVersion = '0.0.0-SNAPSHOT';
  current.metadata.resourceDigest = calculateResourceDigest(current);
  await fs.writeJson(manifestPath(project, INSTALL_MODES.NORMAL), current, { spaces: 2 });

  const repeated = await runInitWithoutFlags(project);
  assert.equal(repeated.code, 0, repeated.stderr + repeated.stdout);
  for (const file of customerFiles) {
    assert.equal(sha256(await fs.readFile(file)), before.get(file), file);
  }
  const refreshed = await loadManifest(project, INSTALL_MODES.NORMAL);
  assert.equal(refreshed.metadata.cliVersion, releaseManifest.cliVersion);
  assert.equal(refreshed.metadata.starterVersion, releaseManifest.starter.version);
});

test('Phase 2 existing infra-dir option selects PostgreSQL-only infrastructure without changing quick init', async () => {
  const answers = await collectInitAnswers(
    { dir: process.cwd(), yes: true, docker: false, infraDir: path.join(process.cwd(), 'infra') },
    { hasDocker: true, hasEnableAiSecurity: false, hasHostSecurityFilterChain: false },
    'phase2-project');
  assert.equal(answers.setupMode, 'quick');
  assert.equal(answers.infra, 'standalone');
  assert.equal(answers.startDocker, false);
});

test('Phase 2 malformed Contexa YAML and malformed build fail without customer-file mutation', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-malformed-'));
  try {
    await t.test('malformed Contexa YAML', async () => {
      const project = await createProject(parent, 'malformed-yaml');
      const buildPath = path.join(project, 'build.gradle');
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      const overlayPath = path.join(project, 'src/main/resources/application-contexa.yml');
      await fs.writeFile(overlayPath, 'contexa:\n  security: [\n', 'utf8');
      const beforeBuild = await fs.readFile(buildPath);
      const beforeYml = await fs.readFile(ymlPath);
      const beforeOverlay = await fs.readFile(overlayPath);
      const result = await runInit(project,
        ['--distributed', '--no-docker', '--infra-dir', path.join(project, 'infra')]);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0);
      assert.match(output, /CONTEXA_OVERLAY_USER_OWNED/);
      assert.match(output, /will not overwrite/);
      assert.deepEqual(await fs.readFile(buildPath), beforeBuild);
      assert.deepEqual(await fs.readFile(ymlPath), beforeYml);
      assert.deepEqual(await fs.readFile(overlayPath), beforeOverlay);
      assert.equal(await fs.pathExists(installLockPath(project)), false);
    });

    await t.test('malformed Gradle build', async () => {
      const project = await createProject(parent, 'malformed-build');
      const buildPath = path.join(project, 'build.gradle');
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      await fs.writeFile(buildPath, "plugins {\n  id 'org.springframework.boot'\n", 'utf8');
      const beforeBuild = await fs.readFile(buildPath);
      const beforeYml = await fs.readFile(ymlPath);
      const result = await runInit(project);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.code, 0);
      assert.match(output, /INVALID_BUILD_FILE/);
      assert.match(output, /Fix the build syntax/);
      assert.deepEqual(await fs.readFile(buildPath), beforeBuild);
      assert.deepEqual(await fs.readFile(ymlPath), beforeYml);
      assert.equal(await fs.pathExists(installLockPath(project)), false);
    });
  } finally {
    await fs.remove(parent);
  }
});
test('Phase 2 lock rejects a live owner, recovers a stale owner, and isolates simulation', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-lock-'));
  try {
    const normal = await acquireInstallLock(project, INSTALL_MODES.NORMAL);
    await assert.rejects(
      acquireInstallLock(project, INSTALL_MODES.NORMAL),
      error => error.code === 'INIT_ALREADY_RUNNING');
    const simulation = await acquireInstallLock(project, INSTALL_MODES.SIMULATION);
    await releaseInstallLock(simulation);
    await releaseInstallLock(normal);

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

test('Phase 2 same-project ten-way init is safely rejected and retry succeeds', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-same-'));
  const project = await createProject(parent, 'same-project');
  try {
    const originalBuild = await fs.readFile(path.join(project, 'build.gradle'));
    const originalYml = await fs.readFile(path.join(project, 'src/main/resources/application.yml'));
    const held = await acquireInstallLock(project, INSTALL_MODES.NORMAL);
    const rejected = await Promise.all(Array.from({ length: 10 }, () => runInit(project)));
    await releaseInstallLock(held);
    assert.ok(rejected.every(result => result.code !== 0));
    assert.ok(rejected.every(result =>
      `${result.stdout}\n${result.stderr}`.includes('INIT_ALREADY_RUNNING')));
    assert.deepEqual(await fs.readFile(path.join(project, 'build.gradle')), originalBuild);
    assert.deepEqual(await fs.readFile(path.join(project, 'src/main/resources/application.yml')), originalYml);

    const retry = await runInit(project);
    assert.equal(retry.code, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
    assert.deepEqual(await fs.readFile(path.join(project, 'src/main/resources/application.yml')), originalYml);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 2 actual init process recovers after termination at every durable state', async t => {
  for (const state of ['PREPARED', 'APPLIED', 'COMMITTED']) {
    await t.test(state, async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), `ctxa-phase2-kill-${state}-`));
      const project = await createProject(parent, `kill-${state.toLowerCase()}`);
      const signalPath = path.join(parent, `${state}.signal`);
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      const originalYml = await fs.readFile(ymlPath);
      try {
        const child = runInterruptedInit(project, state, signalPath);
        child.stdout.resume();
        child.stderr.resume();
        await awaitFile(signalPath);
        const closed = awaitClose(child);
        child.kill('SIGKILL');
        await closed;

        const retry = await runInit(project);
        assert.equal(retry.code, 0, `${state}: ${retry.stdout}\n${retry.stderr}`);
        assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
        assert.deepEqual(await fs.readFile(ymlPath), originalYml);
        assert.equal(await fs.pathExists(installLockPath(project)), false);
        assert.equal((await loadManifest(project)).transaction.status, 'COMMITTED');
      } finally {
        await fs.remove(parent);
      }
    });
  }
});
test('Phase 2 twenty different projects initialize concurrently without cross-project damage', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-many-'));
  try {
    const projects = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      createProject(parent, `project-${index}`)));
    const results = await Promise.all(projects.map(project => runInit(project)));
    results.forEach((result, index) =>
      assert.equal(result.code, 0, `project ${index}: ${result.stdout}\n${result.stderr}`));
    for (const project of projects) {
      assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 1);
      assert.match(await fs.readFile(path.join(project, 'src/main/resources/application.yml'), 'utf8'),
        /jdbc:postgresql:\/\/host-db:5432\/host/);
      assert.equal(await fs.pathExists(installLockPath(project)), false);
    }
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 2 init remains idempotent for 100 sequential runs', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-repeat-'));
  const project = await createProject(parent, 'repeat-project');
  try {
    const first = await runInit(project);
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const buildPath = path.join(project, 'build.gradle');
    const ymlPath = path.join(project, 'src/main/resources/application.yml');
    const expectedBuild = await fs.readFile(buildPath);
    const expectedYml = await fs.readFile(ymlPath);
    const expectedDigest = (await loadManifest(project)).metadata.resourceDigest;
    for (let index = 0; index < 99; index += 1) {
      const result = await runInit(project);
      assert.equal(result.code, 0, `run ${index + 2}: ${result.stdout}\n${result.stderr}`);
    }
    assert.deepEqual(await fs.readFile(buildPath), expectedBuild);
    assert.deepEqual(await fs.readFile(ymlPath), expectedYml);
    assert.equal(starterCount(expectedBuild.toString('utf8')), 1);
    assert.equal((await loadManifest(project)).metadata.resourceDigest, expectedDigest);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 2 init supports spaces, Korean, and a long project path', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-path-'));
  const project = await createProject(parent,
    `공백 한글 ${'long-segment-'.repeat(8)}`);
  try {
    const result = await runInit(project);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const build = await fs.readFile(path.join(project, 'build.gradle'), 'utf8');
    assert.equal(starterCount(build), 1);
    assert.equal(sha256(await fs.readFile(path.join(project, 'src/main/resources/application.yml'))).length, 64);
  } finally {
    await fs.remove(parent);
  }
});
test('Phase 2 INF01-INF08 profiles remain isolated across five init repetitions', {
  timeout: 180000,
}, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-infra-matrix-'));
  const profiles = [
    { id: 'INF01', local: 'standalone', yml: 'host-owned:\n  marker: inf01\n' },
    { id: 'INF02', yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg:5432/contexa\n' },
    { id: 'INF03', yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db:5432/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://contexa-db:5432/contexa\n' },
    { id: 'INF04', yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://shared-db:5432/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://shared-db:5432/contexa\n' },
    { id: 'INF05', local: 'distributed', yml: 'host-owned:\n  marker: inf05\n' },
    { id: 'INF06', yml: 'contexa:\n  infrastructure:\n    mode: DISTRIBUTED\n  datasource:\n    url: jdbc:postgresql://managed-pg:5432/contexa\nspring:\n  data:\n    redis:\n      host: managed-redis\n  kafka:\n    bootstrap-servers: managed-kafka:9092\n' },
    { id: 'INF07', yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg:5432/contexa\nspring:\n  data:\n    redis:\n      host: local-redis\n  kafka:\n    bootstrap-servers: local-kafka:9092\n' },
  ];
  try {
    for (const profile of profiles) {
      await t.test(profile.id, async () => {
        const project = await createProject(parent, profile.id.toLowerCase());
        const ymlPath = path.join(project, 'src/main/resources/application.yml');
        await fs.writeFile(ymlPath, profile.yml, 'utf8');
        const originalYml = await fs.readFile(ymlPath);
        const infraDir = path.join(project, 'owned-infra');
        const args = profile.local === 'distributed'
          ? ['--distributed', '--no-docker', '--infra-dir', infraDir]
          : profile.local === 'standalone'
            ? ['--no-docker', '--infra-dir', infraDir]
            : [];
        let stableBuild = null;
        for (let repeat = 0; repeat < 5; repeat += 1) {
          const result = await runInit(project, args);
          assert.equal(result.code, 0,
            `${profile.id} repeat ${repeat + 1}: ${result.stdout}\n${result.stderr}`);
          const currentBuild = await fs.readFile(path.join(project, 'build.gradle'));
          if (stableBuild) assert.deepEqual(currentBuild, stableBuild);
          stableBuild = currentBuild;
          assert.deepEqual(await fs.readFile(ymlPath), originalYml);
          assert.equal(starterCount(currentBuild.toString('utf8')), 1);
        }
        if (profile.local) {
          const compose = await fs.readFile(path.join(infraDir, 'docker-compose.yml'), 'utf8');
          assert.match(compose, /^\s*postgres:/m);
          if (profile.local === 'standalone') {
            assert.doesNotMatch(compose, /^\s*redis:/m);
            assert.equal(await fs.pathExists(
              path.join(project, 'src/main/resources/application-contexa.yml')), false);
          } else {
            assert.match(compose, /^\s*redis:/m);
            assert.match(compose, /^\s*kafka:/m);
            assert.match(compose, /^\s*zookeeper:/m);
            const overlay = await fs.readFile(
              path.join(project, 'src/main/resources/application-contexa.yml'), 'utf8');
            assert.match(overlay, /^\s*mode:\s*DISTRIBUTED\s*$/m);
            assert.doesNotMatch(overlay, /^server:/m);
            assert.doesNotMatch(overlay, /^\s*security:/m);
          }
        }
      });
    }

    await t.test('INF08', async () => {
      const geoIp = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
      assert.ok(geoIp && await fs.pathExists(geoIp),
        'CONTEXA_TEST_GEOLITE2_SOURCE_PATH must reference the release-verified artifact');
      const project = await createProject(parent, 'inf08');
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      const originalYml = await fs.readFile(ymlPath);
      const normal = await runInit(project);
      assert.equal(normal.code, 0, `${normal.stdout}\n${normal.stderr}`);
      const simulationArgs = [
        '--simulate', '--no-docker', '--infra-dir', path.join(project, 'simulation-infra'),
      ];
      const environment = { CONTEXA_GEOLITE2_SOURCE_PATH: geoIp };
      for (let repeat = 0; repeat < 5; repeat += 1) {
        const [normalResult, simulationResult] = await Promise.all([
          runInit(project),
          runInit(project, simulationArgs, environment),
        ]);
        assert.equal(normalResult.code, 0,
          `INF08 normal repeat ${repeat + 1}: ${normalResult.stdout}\n${normalResult.stderr}`);
        assert.equal(simulationResult.code, 0,
          `INF08 simulation repeat ${repeat + 1}: ${simulationResult.stdout}\n${simulationResult.stderr}`);
      }
      assert.deepEqual(await fs.readFile(ymlPath), originalYml);
      assert.equal(await fs.pathExists(path.join(project, 'contexa', 'manifest.json')), true);
      assert.equal(await fs.pathExists(
        path.join(project, 'contexa', 'simulation', 'manifest.json')), true);
      assert.equal(await fs.pathExists(installLockPath(project)), false);
      assert.equal(await fs.pathExists(
        installLockPath(project, INSTALL_MODES.SIMULATION)), false);
    });
  } finally {
    await fs.remove(parent);
  }
});
