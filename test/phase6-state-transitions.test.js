'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { inspectInstallationState, INSTALLATION_STATES } = require('../src/core/installation-state');

const cliPath = path.resolve(__dirname, '../src/index.js');
const geoSource = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
const evidenceDir = process.env.CONTEXA_PHASE6_EVIDENCE_DIR
  ? path.resolve(process.env.CONTEXA_PHASE6_EVIDENCE_DIR) : null;
const simulationOptions = ['--simulate', '--yes', '--no-docker'];

async function createFixture({ starterManagedByHost = false, malformedYml = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contexa-phase6-'));
  const project = path.join(root, 'project');
  const infra = path.join(project, 'contexa', 'simulation-infra');
  const build = path.join(project, 'build.gradle');
  const yml = path.join(project, 'src/main/resources/application.yml');
  const overlay = path.join(project, 'src/main/resources/application-contexa.yml');
  const dependencies = ["  implementation 'org.springframework.boot:spring-boot-starter-web'"];
  if (starterManagedByHost) {
    dependencies.push("  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'");
  }
  await fs.outputFile(build, [
    "plugins { id 'org.springframework.boot' version '3.3.0' }",
    'repositories { mavenCentral() }',
    'dependencies {',
    ...dependencies,
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.outputFile(path.join(project, 'settings.gradle'), "rootProject.name = 'phase6-fixture'\n", 'utf8');
  await fs.outputFile(path.join(project, 'src/main/java/example/Phase6Application.java'), [
    'package example;',
    'import org.springframework.boot.SpringApplication;',
    'import org.springframework.boot.autoconfigure.SpringBootApplication;',
    '@SpringBootApplication',
    'public class Phase6Application {',
    '  public static void main(String[] args) { SpringApplication.run(Phase6Application.class, args); }',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.outputFile(yml, 'server:\n  port: 9080\nhost:\n  marker: preserved\n', 'utf8');
  if (malformedYml) await fs.outputFile(overlay, 'contexa:\n  broken: [value\n', 'utf8');
  return {
    root, project, infra, build, yml, overlay,
    baseline: { build: await digest(build), yml: await digest(yml) },
  };
}

function runCli(args) {
  const env = { ...process.env };
  delete env.CONTEXA_PROJECT;
  delete env.CONTEXA_POSTGRES_PORT;
  delete env.CONTEXA_OLLAMA_PORT;
  delete env.CONTEXA_REDIS_PORT;
  delete env.CONTEXA_ZOOKEEPER_PORT;
  delete env.CONTEXA_KAFKA_PORT;
  if (geoSource) env.CONTEXA_GEOLITE2_SOURCE_PATH = geoSource;
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function executeStep(fixture, records, name, args, expectedExit = 0) {
  const result = runCli(args);
  assert.equal(result.signal, null, `${name} timed out`);
  assert.equal(result.status, expectedExit,
    `${name}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const state = await inspectInstallationState(fixture.project);
  records.push({
    name,
    command: ['contexa', ...args].join(' '),
    exitCode: result.status,
    state: state.state,
    buildSha256: await digest(fixture.build),
    ymlSha256: await digest(fixture.yml),
    dockerInventory: simulationDockerInventory(),
  });
  return { result, state };
}

function simulationDockerInventory() {
  const result = spawnSync('docker', [
    'ps', '-a', '--filter', 'name=ctxa-sim-', '--format', '{{.Names}}',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) return { available: false, names: [] };
  return {
    available: true,
    names: result.stdout.split(/\r?\n/).map(value => value.trim())
      .filter(value => value.startsWith('ctxa-sim-')),
  };
}

async function digest(file) {
  if (!await fs.pathExists(file)) return null;
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function saveEvidence(name, records) {
  if (!evidenceDir) return;
  await fs.ensureDir(evidenceDir);
  await fs.writeJson(path.join(evidenceDir, `${name}.json`), { name, records }, { spaces: 2 });
}

function requireGeo(t) {
  if (!geoSource || !fs.existsSync(geoSource)) {
    t.skip('CONTEXA_TEST_GEOLITE2_SOURCE_PATH must reference the release-verified GeoLite2 artifact');
    return false;
  }
  return true;
}

test('clean -> init -> init rerun -> reset -> reset rerun', async () => {
  const fixture = await createFixture();
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'normal init',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    const installedBuild = await digest(fixture.build);
    step = await executeStep(fixture, records, 'normal init rerun',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    assert.equal(await digest(fixture.build), installedBuild);
    step = await executeStep(fixture, records, 'normal reset',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    step = await executeStep(fixture, records, 'normal reset rerun',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    await saveEvidence('01-normal-idempotent-reset', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('clean dependency-only -> init --simulate -> reset --simulate', async t => {
  if (!requireGeo(t)) return;
  const fixture = await createFixture({ starterManagedByHost: true });
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'simulation init', [
      'init', ...simulationOptions, '--dir', fixture.project, '--infra-dir', fixture.infra,
    ]);
    assert.equal(step.state.state, INSTALLATION_STATES.SIMULATION);
    const simulationManifest = await fs.readJson(
      path.join(fixture.project, 'contexa', 'simulation', 'manifest.json'));
    assert.equal(simulationManifest.metadata.dockerLifecycleManaged, false);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    step = await executeStep(fixture, records, 'simulation reset',
      ['reset', '--simulate', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    await saveEvidence('02-clean-simulation-reset', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('clean -> init -> init --simulate -> reset --simulate -> reset', async t => {
  if (!requireGeo(t)) return;
  const fixture = await createFixture();
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'normal init',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    const normalBuild = await digest(fixture.build);
    step = await executeStep(fixture, records, 'simulation init', [
      'init', ...simulationOptions, '--dir', fixture.project, '--infra-dir', fixture.infra,
    ]);
    assert.equal(step.state.state, INSTALLATION_STATES.BOTH);
    assert.equal(await digest(fixture.build), normalBuild);
    step = await executeStep(fixture, records, 'simulation reset',
      ['reset', '--simulate', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    assert.equal(await digest(fixture.build), normalBuild);
    step = await executeStep(fixture, records, 'normal reset',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    await saveEvidence('03-normal-simulation-reset-order', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('clean dependency-only -> init --simulate -> init -> reset -> reset --simulate', async t => {
  if (!requireGeo(t)) return;
  const fixture = await createFixture({ starterManagedByHost: true });
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'simulation init', [
      'init', ...simulationOptions, '--dir', fixture.project, '--infra-dir', fixture.infra,
    ]);
    assert.equal(step.state.state, INSTALLATION_STATES.SIMULATION);
    step = await executeStep(fixture, records, 'normal init',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.BOTH);
    step = await executeStep(fixture, records, 'normal reset',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.SIMULATION);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    step = await executeStep(fixture, records, 'simulation reset',
      ['reset', '--simulate', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    assert.deepEqual({ build: await digest(fixture.build), yml: await digest(fixture.yml) }, fixture.baseline);
    await saveEvidence('04-simulation-normal-reset-order', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('normal -> user build modification -> init rerun -> reset', async () => {
  const fixture = await createFixture();
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'normal init',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    await fs.appendFile(fixture.build, '// user-owned phase6 marker\n', 'utf8');
    const modified = await digest(fixture.build);
    step = await executeStep(fixture, records, 'normal init after user modification',
      ['init', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    assert.equal(await digest(fixture.build), modified);
    step = await executeStep(fixture, records, 'normal reset after user modification',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    const restored = await fs.readFile(fixture.build, 'utf8');
    assert.match(restored, /user-owned phase6 marker/);
    assert.doesNotMatch(restored, /ai\.ctxa:spring-boot-starter-contexa/);
    await saveEvidence('05-user-modification-normal-reset', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('both -> user build modification -> reset --simulate preserves normal bytes', async t => {
  if (!requireGeo(t)) return;
  const fixture = await createFixture();
  const records = [];
  try {
    await executeStep(fixture, records, 'normal init',
      ['init', '--yes', '--dir', fixture.project]);
    let step = await executeStep(fixture, records, 'simulation init', [
      'init', ...simulationOptions, '--dir', fixture.project, '--infra-dir', fixture.infra,
    ]);
    assert.equal(step.state.state, INSTALLATION_STATES.BOTH);
    await fs.appendFile(fixture.build, '// normal user marker while both\n', 'utf8');
    const modifiedBytes = await fs.readFile(fixture.build);
    step = await executeStep(fixture, records, 'simulation reset after user modification',
      ['reset', '--simulate', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    assert.deepEqual(await fs.readFile(fixture.build), modifiedBytes);
    await saveEvidence('06-both-user-modification-simulation-reset', records);
  } finally {
    await fs.remove(fixture.root);
  }
});

test('failed explicit init rolls back and the same command safely retries', async t => {
  if (!requireGeo(t)) return;
  const fixture = await createFixture({ malformedYml: true });
  const records = [];
  try {
    let step = await executeStep(fixture, records, 'malformed explicit init', [
      'init', '--yes', '--enable-ai-security', '--provider', 'ollama',
      '--no-docker', '--dir', fixture.project,
    ], 1);
    assert.equal(step.state.state, INSTALLATION_STATES.PARTIAL_FAILURE);
    // The malformed overlay existed before the failed transaction, so rollback
    // correctly keeps it user-owned. Remove the diagnosed bad input before
    // retrying the identical command; never overwrite an unowned host file.
    await fs.remove(fixture.overlay);
    step = await executeStep(fixture, records, 'explicit init retry', [
      'init', '--yes', '--enable-ai-security', '--provider', 'ollama',
      '--no-docker', '--dir', fixture.project,
    ]);
    assert.equal(step.state.state, INSTALLATION_STATES.NORMAL);
    step = await executeStep(fixture, records, 'explicit reset',
      ['reset', '--yes', '--dir', fixture.project]);
    assert.equal(step.state.state, INSTALLATION_STATES.UNINSTALLED);
    await saveEvidence('07-failure-rollback-retry', records);
  } finally {
    await fs.remove(fixture.root);
  }
});
