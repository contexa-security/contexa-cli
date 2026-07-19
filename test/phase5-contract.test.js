'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { normalizeProviders, isValidOllamaModel } = require('../src/core/provider');
const {
  DEFAULT_INFRASTRUCTURE_PORTS,
  SIMULATION_PORTS,
  INFRASTRUCTURE_IMAGE_DEFAULTS,
  DEFAULT_DEVELOPMENT_DB_PASSWORD,
  configuredPort,
} = require('../src/core/infrastructure');
const { INSTALLATION_STATES, inspectInstallationState } = require('../src/core/installation-state');
const { TIMEOUTS } = require('../src/core/timeouts');
const { executeCompose } = require('../src/commands/simulate');
const {
  INSTALL_MODES,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  recordChange,
} = require('../src/core/manifest');

const cliPath = path.resolve(__dirname, '../src/index.js');

async function temporaryProject(prefix = 'contexa-phase5-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createSpringProject() {
  const project = await temporaryProject();
  const yml = path.join(project, 'src/main/resources/application.yml');
  await fs.outputFile(path.join(project, 'build.gradle'),
    "plugins { id 'org.springframework.boot' version '3.3.0' }\n", 'utf8');
  await fs.outputFile(path.join(project, 'settings.gradle'), "rootProject.name = 'phase5'\n", 'utf8');
  await fs.outputFile(path.join(project, 'src/main/java/example/App.java'),
    'package example; import org.springframework.boot.autoconfigure.SpringBootApplication; @SpringBootApplication class App {}\n', 'utf8');
  await fs.outputFile(yml, 'server:\n  port: 9080\n', 'utf8');
  return { project, yml };
}

async function commitEmptyInstallation(project, mode) {
  const id = await beginInstallTransaction(project, { projectName: `phase5-${mode}` }, mode);
  await commitInstallTransaction(project, id, mode);
}

test('provider, model, port, and credential defaults have canonical validation', () => {
  assert.deepEqual(normalizeProviders('OpenAI,ollama,openai'), ['openai', 'ollama']);
  assert.deepEqual(normalizeProviders('none', { includeOllama: true }), []);
  assert.deepEqual(normalizeProviders(null, { simulate: true }), ['ollama']);
  assert.throws(() => normalizeProviders('invalid'), error => error.code === 'INVALID_PROVIDER');
  assert.equal(isValidOllamaModel('qwen2.5:7b'), true);
  assert.equal(isValidOllamaModel('bad model; stop'), false);
  assert.equal(configuredPort('MISSING_PORT', DEFAULT_INFRASTRUCTURE_PORTS.postgres, {}), 5432);
  assert.equal(configuredPort('PORT', SIMULATION_PORTS.kafka, { PORT: '29092' }), 29092);
  assert.throws(() => configuredPort('PORT', 5432, { PORT: '70000' }), error => error.code === 'INVALID_PORT');
  assert.equal(INFRASTRUCTURE_IMAGE_DEFAULTS.pgvector, 'pg16');
  assert.equal(INFRASTRUCTURE_IMAGE_DEFAULTS.kafkaPlatform, '7.4.0');
  assert.equal(DEFAULT_DEVELOPMENT_DB_PASSWORD, 'contexa1234!@#');
  assert.equal(TIMEOUTS.httpHealthProbeMs, 2000);
  assert.equal(TIMEOUTS.javaCommandProbeMs, 5000);
  assert.equal(TIMEOUTS.dockerComposeMutationMs, 150000);
  assert.equal(TIMEOUTS.ollamaPullMs, 600000);
});

test('status classifier distinguishes uninstalled, normal, both, partial failure, and conflict', async () => {
  const project = await temporaryProject();
  try {
    assert.equal((await inspectInstallationState(project)).state, INSTALLATION_STATES.UNINSTALLED);
    await commitEmptyInstallation(project, INSTALL_MODES.NORMAL);
    assert.equal((await inspectInstallationState(project)).state, INSTALLATION_STATES.NORMAL);
    await commitEmptyInstallation(project, INSTALL_MODES.SIMULATION);
    assert.equal((await inspectInstallationState(project)).state, INSTALLATION_STATES.BOTH);

    const partial = await temporaryProject();
    try {
      await beginInstallTransaction(partial, { projectName: 'partial' }, INSTALL_MODES.NORMAL);
      assert.equal((await inspectInstallationState(partial)).state, INSTALLATION_STATES.PARTIAL_FAILURE);
    } finally {
      await fs.remove(partial);
    }

    await fs.writeFile(manifestPath(project, INSTALL_MODES.NORMAL), '{broken', 'utf8');
    assert.equal((await inspectInstallationState(project)).state, INSTALLATION_STATES.CONFLICT);
  } finally {
    await fs.remove(project);
  }
});

test('status command prints stable ownership tokens and returns non-zero for conflict', async () => {
  const project = await temporaryProject();
  const simulationOnly = await temporaryProject();
  const partial = await temporaryProject();
  try {
    const absent = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8' });
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /UNINSTALLED/);
    await commitEmptyInstallation(project, INSTALL_MODES.NORMAL);
    const normal = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8' });
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stdout, /NORMAL/);
    await commitEmptyInstallation(simulationOnly, INSTALL_MODES.SIMULATION);
    const simulation = spawnSync(process.execPath,
      [cliPath, 'status', '--dir', simulationOnly], { encoding: 'utf8' });
    assert.equal(simulation.status, 0, simulation.stderr);
    assert.match(simulation.stdout, /SIMULATION/);
    await commitEmptyInstallation(project, INSTALL_MODES.SIMULATION);
    const both = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8' });
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /BOTH/);
    await beginInstallTransaction(partial, { projectName: 'partial-status' }, INSTALL_MODES.NORMAL);
    const failed = spawnSync(process.execPath, [cliPath, 'status', '--dir', partial], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /PARTIAL_FAILURE/);
    await fs.outputFile(manifestPath(project, INSTALL_MODES.NORMAL), '{broken', 'utf8');
    const conflict = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8' });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stdout, /CONFLICT/);
  } finally {
    await fs.remove(project);
    await fs.remove(simulationOnly);
    await fs.remove(partial);
  }
});

test('doctor rejects an unsupported provider with a stable non-zero error', () => {
  const result = spawnSync(process.execPath,
    [cliPath, 'doctor', '--provider', 'unsupported-provider'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_PROVIDER/);
});

test('simulate compose propagates child process errors and non-zero status', () => {
  const context = { infraDir: 'C:/ctxa-sim', env: {} };
  const childError = new Error('spawn failed');
  assert.throws(
    () => executeCompose(['up', '-d'], context, 'pipe', () => ({ error: childError, status: null })),
    error => error === childError
  );
  assert.throws(
    () => executeCompose(['down'], context, 'pipe', () => ({ status: 7 })),
    error => error.code === 'SIMULATION_DOCKER_FAILED' && /status 7/.test(error.message)
  );
  const success = { status: 0 };
  assert.equal(executeCompose(['ps'], context, 'pipe', () => success), success);
});

test('Korean starter-only init and reset expose no raw key and preserve host configuration', async () => {
  const fixture = await createSpringProject();
  try {
    const before = await fs.readFile(fixture.yml);
    const diagnostic = spawnSync(process.execPath,
      [cliPath, '--lang', 'ko', 'init', '--check', '--dir', fixture.project],
      { encoding: 'utf8' });
    assert.equal(diagnostic.status, 0, diagnostic.stderr);
    assert.match(diagnostic.stdout, /진단: 설치 전 확인/);
    assert.doesNotMatch(diagnostic.stdout, /\binit\.diagnostic\.[a-z][\w.]*/);
    const initialized = spawnSync(process.execPath,
      [cliPath, '--lang', 'ko', 'init', '--yes', '--dir', fixture.project],
      { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /예정된 변경/);
    assert.doesNotMatch(initialized.stdout, /\b(?:planned|init)\.[a-z][\w.]*/);
    assert.equal(initialized.stdout.includes('\uFFFD'), false);
    assert.deepEqual(await fs.readFile(fixture.yml), before);

    const reset = spawnSync(process.execPath,
      [cliPath, '--lang', 'ko', 'reset', '--yes', '--dir', fixture.project],
      { encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr);
    assert.doesNotMatch(reset.stdout, /\breset\.[a-z][\w.]*/);
    assert.equal(reset.stdout.includes('\uFFFD'), false);
    assert.deepEqual(await fs.readFile(fixture.yml), before);

    const rejected = spawnSync(process.execPath,
      [cliPath, 'init', '--yes', '--auto-annotate', '--dir', fixture.project],
      { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /AUTO_ANNOTATE_PROVIDER_REQUIRED/);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('mode refuses unowned host YAML and changes a CLI-owned path transactionally', async () => {
  const unowned = await createSpringProject();
  try {
    const before = await fs.readFile(unowned.yml);
    const denied = spawnSync(process.execPath,
      [cliPath, 'mode', '--enforce', '--dir', unowned.project], { encoding: 'utf8' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /MODE_OWNERSHIP_REQUIRED/);
    assert.deepEqual(await fs.readFile(unowned.yml), before);
  } finally {
    await fs.remove(unowned.project);
  }

  const owned = await createSpringProject();
  try {
    const transactionId = await beginInstallTransaction(owned.project,
      { projectName: 'phase5-mode' }, INSTALL_MODES.NORMAL, [{
        filePath: owned.yml,
        kind: 'application-yml',
      }]);
    await fs.writeFile(owned.yml,
      'server:\n  port: 9080\ncontexa:\n  security:\n    zerotrust:\n      mode: SHADOW\n', 'utf8');
    await recordChange(owned.project, owned.yml, {
      kind: 'application-yml',
      managedPaths: ['security.zerotrust.mode'],
    }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(owned.project, transactionId, INSTALL_MODES.NORMAL);

    const changed = spawnSync(process.execPath,
      [cliPath, 'mode', '--enforce', '--dir', owned.project], { encoding: 'utf8' });
    assert.equal(changed.status, 0, changed.stderr + changed.stdout);
    assert.equal(yaml.load(await fs.readFile(owned.yml, 'utf8')).contexa.security.zerotrust.mode, 'ENFORCE');
    assert.equal((await loadManifest(owned.project, INSTALL_MODES.NORMAL)).transaction.status, 'COMMITTED');

    await fs.appendFile(owned.yml, '# user change\n', 'utf8');
    const userBytes = await fs.readFile(owned.yml);
    const refused = spawnSync(process.execPath,
      [cliPath, 'mode', '--shadow', '--dir', owned.project], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /MODE_OWNERSHIP_REQUIRED/);
    assert.deepEqual(await fs.readFile(owned.yml), userBytes);
  } finally {
    await fs.remove(owned.project);
  }
});

test('English and Korean bundles are key-identical and command help exposes no raw key', () => {
  const en = require('../src/i18n/en.json');
  const ko = require('../src/i18n/ko.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  for (const value of [...Object.values(en), ...Object.values(ko)]) {
    assert.equal(value.includes('\uFFFD'), false);
  }
  const helpCommands = [
    ['init', '--help'],
    ['reset', '--help'],
    ['simulate', '--help'],
    ['doctor', '--help'],
    ['ollama', 'pull', '--help'],
  ];
  for (const locale of ['en', 'ko']) {
    for (const args of helpCommands) {
      const result = spawnSync(process.execPath,
        [cliPath, '--lang', locale, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${locale} ${args.join(' ')}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /\b(?:init|reset|simulate|doctor|ollama)\.[a-z][\w.]*/);
      assert.equal(result.stdout.includes('\uFFFD'), false);
    }
  }
});

test('dead cleanup and command-local Docker/Ollama duplicates are absent', async () => {
  assert.equal(await fs.pathExists(path.resolve(__dirname, '../src/core/cleanup.js')), false);
  const reset = await fs.readFile(path.resolve(__dirname, '../src/commands/reset.js'), 'utf8');
  const ollamaCommand = await fs.readFile(path.resolve(__dirname, '../src/commands/ollama.js'), 'utf8');
  assert.doesNotMatch(reset, /function dockerTry\s*\(/);
  assert.doesNotMatch(ollamaCommand, /function pullOllamaModelWithProgress\s*\(/);
  assert.doesNotMatch(ollamaCommand, /function detectOllamaSource\s*\(/);
  const initCommand = await fs.readFile(path.resolve(__dirname, '../src/commands/init.js'), 'utf8');
  const artifact = await fs.readFile(path.resolve(__dirname, '../src/core/artifact.js'), 'utf8');
  assert.equal((artifact.match(/function downloadToFile\s*\(/g) || []).length, 1);
  for (const commandSource of [reset, ollamaCommand, initCommand]) {
    assert.doesNotMatch(commandSource, /https?\.get\s*\(|function\s+download\w*\s*\(/);
  }
  assert.doesNotMatch(initCommand, /function (?:normalizePath|trackedFileState|printPlannedChanges)\s*\(/);
  assert.doesNotMatch(initCommand, /inquirer\.prompt|require\(['"]inquirer['"]\)/);
  assert.equal(await fs.pathExists(path.resolve(__dirname, '../src/core/init-plan.js')), true);
  assert.equal(await fs.pathExists(path.resolve(__dirname, '../src/core/init-input.js')), true);
  assert.equal(await fs.pathExists(path.resolve(__dirname, '../src/core/init-diagnostics.js')), true);
  assert.equal(await fs.pathExists(path.resolve(__dirname, '../src/core/init-report.js')), true);
});
