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
const geoSource = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
const {
  INSTALL_MODES,
  acquireInstallLock,
  installLockPath,
  loadManifest,
  manifestPath,
  releaseInstallLock,
} = require('../src/core/manifest');
const { markDockerLifecycleManaged } = require('../src/commands/simulate');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createProject(parent, name, applicationYml = 'server:\n  port: 9080\n') {
  const project = path.join(parent, name);
  await fs.ensureDir(path.join(project, 'src/main/resources'));
  await fs.ensureDir(path.join(project, 'src/main/java/example'));
  await fs.writeFile(path.join(project, 'settings.gradle'),
    `rootProject.name = '${name}'\n`, 'utf8');
  await fs.writeFile(path.join(project, 'build.gradle'), [
    "plugins { id 'org.springframework.boot' version '3.3.0' }",
    'repositories { mavenCentral() }',
    'dependencies {',
    "  implementation 'org.springframework.boot:spring-boot-starter-web'",
    "  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'",
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project, 'src/main/resources/application.yml'),
    applicationYml, 'utf8');
  await fs.writeFile(path.join(project, 'src/main/java/example/SampleApplication.java'), [
    'package example;',
    'import org.springframework.boot.autoconfigure.SpringBootApplication;',
    '@SpringBootApplication',
    'public class SampleApplication {}',
    '',
  ].join('\n'), 'utf8');
  return project;
}

function runCli(project, command, extra = []) {
  const args = [cliPath, command, '--yes', '--dir', project, ...extra];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        CONTEXA_LANG: 'en',
        CONTEXA_GEOLITE2_SOURCE_PATH: geoSource,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
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

function simulationArgs(project) {
  return ['--simulate', '--no-docker', '--infra-dir', path.join(project, 'simulation-infra')];
}

function requireGeo(t) {
  if (!geoSource || !fs.existsSync(geoSource)) {
    t.skip('release-verified GeoLite2 artifact is required');
    return false;
  }
  return true;
}

async function captureHost(project) {
  const build = await fs.readFile(path.join(project, 'build.gradle'));
  const yml = await fs.readFile(path.join(project, 'src/main/resources/application.yml'));
  const normalManifest = manifestPath(project, INSTALL_MODES.NORMAL);
  return {
    build: digest(build),
    yml: digest(yml),
    normalManifest: await fs.pathExists(normalManifest)
      ? digest(await fs.readFile(normalManifest)) : null,
  };
}

test('Phase 4 dependency-only simulation creates and resets only simulation-owned state', async t => {
  if (!requireGeo(t)) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-clean-'));
  const project = await createProject(parent, 'clean');
  try {
    const before = await captureHost(project);
    const init = await runCli(project, 'init', simulationArgs(project));
    assert.equal(init.signal, null, 'simulation init must have a bounded response');
    assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
    assert.deepEqual(await captureHost(project), before);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), true);

    const reset = await runCli(project, 'reset', ['--simulate']);
    assert.equal(reset.signal, null, 'simulation reset must have a bounded response');
    assert.equal(reset.code, 0, `${reset.stdout}\n${reset.stderr}`);
    assert.deepEqual(await captureHost(project), before);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), false);
    assert.equal(await fs.pathExists(path.join(project,
      'src/main/resources/application-contexa-simulation.yml')), false);
    assert.equal(await fs.pathExists(path.join(project,
      'src/main/java/io/contexa/simulation/ContexaSimulationConfiguration.java')), false);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 4 simulate up ownership makes later reset responsible for Docker cleanup', async t => {
  if (!requireGeo(t)) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-lifecycle-'));
  const project = await createProject(parent, 'lifecycle');
  try {
    const init = await runCli(project, 'init', simulationArgs(project));
    assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
    assert.equal((await loadManifest(project,
      INSTALL_MODES.SIMULATION)).metadata.dockerLifecycleManaged, false);

    await markDockerLifecycleManaged({ projectDir: project });

    assert.equal((await loadManifest(project,
      INSTALL_MODES.SIMULATION)).metadata.dockerLifecycleManaged, true);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 4 INF01-INF08 keep host configuration byte-identical', {
  timeout: 180000,
}, async t => {
  if (!requireGeo(t)) return;
  const profiles = [
    ['INF01', 'host-owned:\n  marker: standalone\n'],
    ['INF02', 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg:5432/contexa\n'],
    ['INF03', 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db:5432/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://contexa-db:5432/contexa\n'],
    ['INF04', 'spring:\n  datasource:\n    url: jdbc:postgresql://shared-db:5432/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://shared-db:5432/contexa\n'],
    ['INF05', 'host-owned:\n  marker: distributed\n'],
    ['INF06', 'contexa:\n  infrastructure:\n    mode: DISTRIBUTED\n  datasource:\n    url: jdbc:postgresql://managed-pg:5432/contexa\n'],
    ['INF07', 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg:5432/contexa\nspring:\n  data:\n    redis:\n      host: local-redis\n'],
    ['INF08', 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db:5432/host\nhost-owned:\n  marker: concurrent\n'],
  ];
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-infra-'));
  try {
    for (const [id, yml] of profiles) {
      await t.test(id, async () => {
        const project = await createProject(parent, id.toLowerCase(), yml);
        const before = await captureHost(project);
        const init = await runCli(project, 'init', simulationArgs(project));
        assert.equal(init.code, 0, `${id}: ${init.stdout}\n${init.stderr}`);
        assert.deepEqual(await captureHost(project), before, `${id} host bytes changed`);
        const reset = await runCli(project, 'reset', ['--simulate']);
        assert.equal(reset.code, 0, `${id}: ${reset.stdout}\n${reset.stderr}`);
        assert.deepEqual(await captureHost(project), before, `${id} reset changed host bytes`);
      });
    }
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 4 twenty projects simulate concurrently without cross-project damage', {
  timeout: 180000,
}, async t => {
  if (!requireGeo(t)) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-many-'));
  try {
    const projects = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      createProject(parent, `project-${String(index + 1).padStart(2, '0')}`,
        `host-owned:\n  marker: ${index + 1}\n`)));
    const baselines = await Promise.all(projects.map(captureHost));
    const results = await Promise.all(projects.map(project =>
      runCli(project, 'init', simulationArgs(project))));
    results.forEach((result, index) => {
      assert.equal(result.signal, null, `project ${index + 1} timed out`);
      assert.equal(result.code, 0,
        `project ${index + 1}: ${result.stdout}\n${result.stderr}`);
    });
    for (let index = 0; index < projects.length; index += 1) {
      assert.deepEqual(await captureHost(projects[index]), baselines[index]);
      assert.equal(await fs.pathExists(
        manifestPath(projects[index], INSTALL_MODES.SIMULATION)), true);
    }
    const resets = await Promise.all(projects.map(project =>
      runCli(project, 'reset', ['--simulate'])));
    assert.ok(resets.every(result => result.code === 0 && result.signal === null));
    for (let index = 0; index < projects.length; index += 1) {
      assert.deepEqual(await captureHost(projects[index]), baselines[index]);
      assert.equal(await fs.pathExists(
        manifestPath(projects[index], INSTALL_MODES.SIMULATION)), false);
    }
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 4 same-project simulation lock rejects concurrency and retry succeeds', async t => {
  if (!requireGeo(t)) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-lock-'));
  const project = await createProject(parent, 'same-project');
  try {
    const before = await captureHost(project);
    const held = await acquireInstallLock(project, INSTALL_MODES.SIMULATION);
    const rejected = await Promise.all(Array.from({ length: 10 }, () =>
      runCli(project, 'init', simulationArgs(project))));
    await releaseInstallLock(held);
    assert.ok(rejected.every(result => result.code !== 0 && result.signal === null));
    assert.ok(rejected.every(result =>
      `${result.stdout}\n${result.stderr}`.includes('INIT_ALREADY_RUNNING')));
    assert.deepEqual(await captureHost(project), before);
    const retry = await runCli(project, 'init', simulationArgs(project));
    assert.equal(retry.code, 0, `${retry.stdout}\n${retry.stderr}`);
    assert.equal(await fs.pathExists(
      installLockPath(project, INSTALL_MODES.SIMULATION)), false);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 4 normal init and simulation init are isolated when executed together', async t => {
  if (!requireGeo(t)) return;
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase4-both-'));
  const project = await createProject(parent, 'both',
    'host-owned:\n  marker: normal-and-simulation\n');
  try {
    const originalYml = await fs.readFile(path.join(project,
      'src/main/resources/application.yml'));
    const [normal, simulation] = await Promise.all([
      runCli(project, 'init', ['--no-docker']),
      runCli(project, 'init', simulationArgs(project)),
    ]);
    assert.equal(normal.code, 0, `${normal.stdout}\n${normal.stderr}`);
    assert.equal(simulation.code, 0, `${simulation.stdout}\n${simulation.stderr}`);
    assert.deepEqual(await fs.readFile(path.join(project,
      'src/main/resources/application.yml')), originalYml);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    assert.equal(await fs.pathExists(
      manifestPath(project, INSTALL_MODES.SIMULATION)), true);

    const simulationReset = await runCli(project, 'reset', ['--simulate']);
    assert.equal(simulationReset.code, 0, `${simulationReset.stdout}\n${simulationReset.stderr}`);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    const normalReset = await runCli(project, 'reset');
    assert.equal(normalReset.code, 0, `${normalReset.stdout}\n${normalReset.stderr}`);
    assert.deepEqual(await fs.readFile(path.join(project,
      'src/main/resources/application.yml')), originalYml);
  } finally {
    await fs.remove(parent);
  }
});
