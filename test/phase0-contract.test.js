'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');
const releaseManifest = require('../release-manifest.json');
const packageJson = require('../package.json');
const { buildInitDefaults } = require('../src/core/init-input');
const { backupFile } = require('../src/core/injector/common');
const { buildContext: buildSimulationContext } = require('../src/commands/simulate');
const {
  INSTALL_MODES,
  JOURNAL_STATES,
  backupRoot,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareDockerMutation,
  prepareExternalFileChange,
  recordDockerMutationApplied,
  recordChange,
  recordExternalFileChange,
  recordInstallMetadata,
  rollbackInstallTransaction,
  restoreExternalResources,
  saveManifest,
} = require('../src/core/manifest');
const { buildDockerResourceContract, performOwnedDockerCleanup } = require('../src/core/reset-service');
const {
  dockerCompose,
  dockerComposeDown,
  dockerTry,
  inspectDockerLabels,
  isDockerCliInstalled,
  isDockerDaemonRunning,
} = require('../src/core/docker');
const { canonicalBoundaryPath } = require('../src/core/project');

async function createSpringFixture(prefix) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const build = path.join(project, 'build.gradle');
  const yml = path.join(project, 'src/main/resources/application.yml');
  const source = path.join(project, 'src/main/java/example/SampleApplication.java');
  const originalBuild = "plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n";
  const originalYml = "server:\n  port: 9080\nspring:\n  datasource:\n    url: jdbc:postgresql://127.0.0.1:35433/host-owned\n  security:\n    user:\n      name: host-user\n      password: host-password\n  ai:\n    provider: host-owned\n";
  await fs.outputFile(build, originalBuild, 'utf8');
  await fs.outputFile(path.join(project, 'settings.gradle'), "rootProject.name = 'phase0-fixture'\n", 'utf8');
  await fs.outputFile(yml, originalYml, 'utf8');
  const originalSource = 'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class SampleApplication {}\n';
  await fs.outputFile(source, originalSource, 'utf8');
  return { project, build, yml, source, originalBuild, originalYml, originalSource };
}

async function snapshotDirectory(rootDir) {
  const snapshot = [];
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        snapshot.push({ path: relative + '/', type: 'directory' });
        await visit(absolute);
      } else {
        snapshot.push({
          path: relative,
          type: 'file',
          sha256: crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex'),
        });
      }
    }
  }
  await visit(rootDir);
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

test('Phase 0 release and primary-command contract has one canonical source', () => {
  assert.equal(releaseManifest.cliVersion, packageJson.version);
  assert.equal(releaseManifest.releaseTag, 'v' + releaseManifest.cliVersion);
  assert.equal(releaseManifest.channel, 'snapshot');
  assert.match(releaseManifest.starter.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(releaseManifest.primaryCommands, [
    'contexa init',
    'contexa reset',
    'contexa init --simulate',
    'contexa reset --simulate',
  ]);
  const common = fs.readFileSync(path.join(root, 'src/core/injector/common.js'), 'utf8');
  assert.match(common, /releaseManifest\.starter\.version/);
  assert.equal(common.includes("CONTEXA_VERSION = '"), false);
});

test('interactive init defaults are value-based and resolve to the ready-to-run quick installation plan', () => {
  const basic = buildInitDefaults({});
  assert.equal(basic.explicitIntegrationMode, null);
  assert.deepEqual(basic.defaults, {
    setupMode: 'quick',
    integrationMode: 'merge',
    securityMode: 'full',
    mode: 'shadow',
    enableAiSecurity: true,
    autoAnnotate: true,
    llmProviders: ['ollama'],
    infra: 'standalone',
    injectDep: true,
    startDocker: true,
  });
  const explicit = buildInitDefaults({
    standalone: true,
    securityMode: 'full',
    distributed: true,
    docker: false,
    provider: 'ollama',
    autoAnnotate: true,
  });
  assert.equal(explicit.defaults.integrationMode, 'standalone');
  assert.equal(explicit.defaults.securityMode, 'full');
  assert.equal(explicit.defaults.infra, 'distributed');
  assert.equal(explicit.defaults.startDocker, false);
  assert.deepEqual(explicit.defaults.llmProviders, ['ollama']);
  assert.equal(explicit.defaults.enableAiSecurity, true);
  assert.equal(explicit.defaults.autoAnnotate, false);
});

test('init --simulate without the starter fails with zero project writes', async () => {
  const fixture = await createSpringFixture('ctxa-phase0-simulation-starter-required-');
  try {
    const before = await snapshotDirectory(fixture.project);
    const result = spawnSync(process.execPath, [
      cliPath, 'init', '--simulate', '--dir', fixture.project,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path.dirname(process.execPath) },
    });
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr + result.stdout, /SIMULATION_STARTER_REQUIRED/);
    assert.match(result.stderr + result.stdout, /contexa init/);
    assert.deepEqual(await snapshotDirectory(fixture.project), before);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('init rejects an infra path outside owned roots with zero project and infra writes', async () => {
  const fixture = await createSpringFixture('ctxa-phase0-infra-boundary-');
  const outsideInfra = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-outside-infra-'));
  try {
    const projectBefore = await snapshotDirectory(fixture.project);
    const infraBefore = await snapshotDirectory(outsideInfra);
    const result = spawnSync(process.execPath, [
      cliPath,
      'init',
      '--yes',
      '--distributed',
      '--no-docker',
      '--dir',
      fixture.project,
      '--infra-dir',
      outsideInfra,
    ], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: path.dirname(process.execPath) },
    });
    assert.notEqual(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stderr + result.stdout, /UNSAFE_INFRA_PATH/);
    assert.doesNotMatch(result.stderr + result.stdout, /outside Contexa-owned roots/);
    assert.deepEqual(await snapshotDirectory(fixture.project), projectBefore);
    assert.deepEqual(await snapshotDirectory(outsideInfra), infraBefore);
  } finally {
    await fs.remove(fixture.project);
    await fs.remove(outsideInfra);
  }
});

test('init prints the complete plan before the first filesystem mutation', async () => {
  const fixture = await createSpringFixture('ctxa-phase0-plan-before-write-');
  const { Command } = require('commander');
  const { t } = require('../src/core/i18n');
  const registerInit = require('../src/commands/init');
  const mutableMethods = ['ensureDir', 'writeFile', 'outputFile', 'copy', 'rename', 'remove'];
  const originals = Object.fromEntries(mutableMethods.map(name => [name, fs[name]]));
  const originalLog = console.log;
  let planSeen = false;
  let mutationCount = 0;
  try {
    const before = await snapshotDirectory(fixture.project);
    console.log = (...args) => {
      if (args.map(String).join(' ').includes(t('planned.title'))) planSeen = true;
    };
    for (const name of mutableMethods) {
      fs[name] = async () => {
        mutationCount += 1;
        assert.equal(planSeen, true, `${name} ran before the plan was printed`);
        throw new Error('INJECTED_FIRST_MUTATION_AFTER_PLAN');
      };
    }
    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await assert.rejects(
      program.parseAsync([
        process.execPath,
        'contexa',
        'init',
        '--yes',
        '--no-docker',
        '--dir',
        fixture.project,
      ]),
      /INJECTED_FIRST_MUTATION_AFTER_PLAN/
    );
    assert.equal(planSeen, true);
    assert.equal(mutationCount, 1);
    for (const [name, implementation] of Object.entries(originals)) fs[name] = implementation;
    assert.deepEqual(await snapshotDirectory(fixture.project), before);
  } finally {
    console.log = originalLog;
    for (const [name, implementation] of Object.entries(originals)) fs[name] = implementation;
    await fs.remove(fixture.project);
  }
});

test('default Quick command path is ready-to-run and idempotent', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const fixture = await createSpringFixture('ctxa-phase0-plain-init-');
  try {
    const originalYml = await fs.readFile(fixture.yml);
    const originalSource = await fs.readFile(fixture.source);
    const childEnv = {
      ...process.env,
      PATH: path.dirname(process.execPath),
      CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
    };
    const initial = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--no-docker', '--dir', fixture.project], {
      cwd: fixture.project,
      encoding: 'utf8',
      timeout: 10000,
      env: childEnv,
    });
    assert.equal(initial.status, 0, initial.stderr + initial.stdout);
    assert.match(await fs.readFile(fixture.build, 'utf8'), /ai\.ctxa:spring-boot-starter-contexa/);
    assert.deepEqual(await fs.readFile(fixture.yml), originalYml);
    assert.match(await fs.readFile(fixture.source, 'utf8'),
      /@EnableAISecurity\(mode = SecurityMode\.FULL\)/);
    const overlayPath = path.join(fixture.project,
      'src', 'main', 'resources', 'application-contexa.yml');
    assert.equal(await fs.pathExists(overlayPath), true);

    const committed = await snapshotDirectory(fixture.project);
    const repeated = spawnSync(process.execPath, [cliPath, 'init'], {
      cwd: fixture.project,
      encoding: 'utf8',
      timeout: 10000,
      env: childEnv,
    });
    assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
    assert.match(repeated.stdout, /already installed/i);
    assert.match(repeated.stdout, /No project file was changed/);
    assert.match(repeated.stdout, /contexa init --simulate/);
    assert.doesNotMatch(repeated.stdout, /--force|--yes/);
    assert.deepEqual(await snapshotDirectory(fixture.project), committed);

    const reset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', fixture.project], {
      cwd: fixture.project,
      encoding: 'utf8',
      timeout: 10000,
      env: childEnv,
    });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.equal(await fs.readFile(fixture.build, 'utf8'), fixture.originalBuild);
    assert.deepEqual(await fs.readFile(fixture.yml), originalYml);
    assert.deepEqual(await fs.readFile(fixture.source), originalSource);
    assert.equal(await fs.pathExists(overlayPath), false);
    assert.equal(await fs.pathExists(manifestPath(fixture.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('Phase 1 release assets, compatibility and signed-manifest workflow are consistent', () => {
  assert.deepEqual(releaseManifest.assets.map(({ os, arch, file, checksumFile, codeSignature }) => ({
    os, arch, file, checksumFile, codeSignature,
  })), [
    { os: 'linux', arch: 'x64', file: 'contexa-linux-x64', checksumFile: 'contexa-linux-x64.sha256', codeSignature: 'unsigned-snapshot' },
    { os: 'macos', arch: 'arm64', file: 'contexa-macos-arm64', checksumFile: 'contexa-macos-arm64.sha256', codeSignature: 'adhoc-snapshot' },
    { os: 'windows', arch: 'x64', file: 'contexa-win-x64.exe', checksumFile: 'contexa-win-x64.exe.sha256', codeSignature: 'unsigned-snapshot' },
  ]);
  assert.deepEqual(releaseManifest.compatibility, {
    linux: { libc: 'glibc', minimumVersion: '2.28' },
    macos: { minimumVersion: '11' },
    windows: { minimumVersion: '10' },
  });
  assert.deepEqual(releaseManifest.signature, {
    required: true,
    status: 'active',
    algorithm: 'RSA-3072-SHA256',
    file: 'release-manifest.json.sig',
    publicKeyFile: 'release-signing-public.pem',
  });
  const publicKeyFile = path.join(root, releaseManifest.signature.publicKeyFile);
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyFile));
  assert.equal(publicKey.asymmetricKeyType, 'rsa');
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 3072);
  assert.ok(packageJson.files.includes(releaseManifest.signature.publicKeyFile));

  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  for (const asset of releaseManifest.assets) {
    assert.ok(workflow.includes(`output: ${asset.file}`), `workflow matrix is missing ${asset.file}`);
    assert.ok(workflow.includes(asset.checksumFile), `workflow release files are missing ${asset.checksumFile}`);
  }
  assert.match(workflow, /asset\.sha256 = crypto\.createHash\('sha256'\)/);
  assert.match(workflow, /RELEASE_MANIFEST_SIGNING_KEY: \$\{\{ secrets\.RELEASE_MANIFEST_SIGNING_KEY \}\}/);
  assert.match(workflow, /openssl dgst -sha256 -verify release-signing-public\.pem/);
  assert.match(workflow, /require\('\.\/release-manifest\.json'\)\.channel/);
  assert.match(workflow, /prerelease: \$\{\{ steps\.release_metadata\.outputs\.prerelease \}\}/);
  assert.doesNotMatch(workflow, /prerelease: true/);
  assert.ok(workflow.includes("- 'v[0-9]+.[0-9]+.[0-9]+'"));
  assert.match(workflow,
    /- name: Run Phase 6 exact commands against the built binary\s+if: runner\.os == 'Linux'/);
  assert.doesNotMatch(workflow,
    /Run Phase 6 exact commands against the built binary\s+if:.*-phase6\./);
  assert.match(workflow, /ref: 0af591c80b4fbe7e1e623886ed10e277c07d2291/);
  assert.doesNotMatch(workflow, /codex\/extreme-phase6-/);
  assert.match(workflow, /name: signed-release-gate-\$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/if: startsWith\(github\.ref, 'refs\/tags\/'\)/g) || []).length, 3);
  assert.equal((workflow.match(/^\s*run: npm test\s*$/gm) || []).length, 0);
  assert.match(workflow,
    /Run Phase 5 focused regression tests\s+if: runner\.os == 'Linux'/);
  assert.doesNotMatch(workflow, /contains\(github\.ref_name, '-phase/);
  assert.equal(fs.existsSync(path.join(root, '.github/workflows/phase6-extreme.yml')), false);
});

test('Phase 0 snapshot channel is derived, signed, and published from the release contract', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /schemaVersion: 1/);
  assert.match(workflow, /channel: release\.channel/);
  assert.match(workflow, /releaseTag: release\.releaseTag/);
  assert.match(workflow, /cliVersion: release\.cliVersion/);
  assert.match(workflow, /starterVersion: release\.starter\.version/);
  assert.match(workflow, /releaseManifestSha256: crypto\.createHash\('sha256'\)\.update\(releaseBytes\)/);
  assert.match(workflow, /openssl dgst -sha256 -sign .* channel-manifest\.json/);
  assert.match(workflow, /openssl dgst -sha256 -verify .* channel-manifest\.json/);
  assert.match(workflow, /group: contexa-snapshot-channel/);
  assert.match(workflow, /refs\/heads\/snapshot-channel/);
  assert.match(workflow, /git mktree/);
  assert.match(workflow, /commit-tree/);
  assert.match(workflow, /repository: contexa-security\/install-ctxa/);
  assert.match(workflow, /CONTEXA_RELEASE_BUNDLE_ROOT: \$\{\{ github\.workspace \}\}/);
  assert.match(workflow, /CLI release bundle satisfies the installer signature and asset contract/);
  assert.doesNotMatch(workflow, /printf '%s\\n' \+/);
  assert.doesNotMatch(workflow, /github-actions \+\s+commit-tree/);
});

test('CLI version and no-argument first run match the release contract', () => {
  const version = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), releaseManifest.cliVersion);
  const firstRun = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.match(firstRun.stdout, /Usage: contexa/);
  for (const command of releaseManifest.primaryCommands) {
    assert.ok(firstRun.stdout.includes(command), `missing primary workflow in help: ${command}`);
  }
});

test('normal and simulation manifests, backups, and installation IDs are isolated', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-mode-'));
  const build = path.join(project, 'build.gradle');
  const normalInfra = path.join(project, 'owned-infra', 'normal');
  const simulationInfra = path.join(project, 'owned-infra', 'simulation');
  await fs.writeFile(build, "plugins { id 'org.springframework.boot' }\n", 'utf8');
  try {
    const normalId = await beginInstallTransaction(project, { projectName: 'sample', infraDir: normalInfra }, INSTALL_MODES.NORMAL, [
      { filePath: build, kind: 'build-file' },
    ]);
    await commitInstallTransaction(project, normalId, INSTALL_MODES.NORMAL);
    const simulationId = await beginInstallTransaction(project, { projectName: 'ctxa-sim', infraDir: simulationInfra }, INSTALL_MODES.SIMULATION, [
      { filePath: build, kind: 'build-file' },
    ]);
    await commitInstallTransaction(project, simulationId, INSTALL_MODES.SIMULATION);
    assert.notEqual(manifestPath(project, INSTALL_MODES.NORMAL), manifestPath(project, INSTALL_MODES.SIMULATION));
    assert.notEqual(backupRoot(project, INSTALL_MODES.NORMAL), backupRoot(project, INSTALL_MODES.SIMULATION));
    const normal = await loadManifest(project, INSTALL_MODES.NORMAL);
    const simulation = await loadManifest(project, INSTALL_MODES.SIMULATION);
    const canonicalProjectPath = await canonicalBoundaryPath(project);
    assert.equal(normal.metadata.mode, INSTALL_MODES.NORMAL);
    assert.equal(simulation.metadata.mode, INSTALL_MODES.SIMULATION);
    assert.equal(normal.metadata.canonicalProjectPath, canonicalProjectPath);
    assert.equal(simulation.metadata.canonicalProjectPath, canonicalProjectPath);
    assert.notEqual(path.resolve(normal.metadata.infraDir), path.resolve(simulation.metadata.infraDir));
    assert.notEqual(normal.metadata.installationId, simulation.metadata.installationId);
    assert.ok(normal.files.every(entry => entry.mode === INSTALL_MODES.NORMAL
      && entry.installationId === normal.metadata.installationId));
    assert.ok(simulation.files.every(entry => entry.mode === INSTALL_MODES.SIMULATION
      && entry.installationId === simulation.metadata.installationId));
    assert.equal(normal.transaction.status, 'COMMITTED');
    assert.equal(simulation.transaction.status, 'COMMITTED');
  } finally {
    await fs.remove(project);
  }
});

test('failed transaction restores a tracked host file byte-for-byte', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-rollback-'));
  const build = path.join(project, 'build.gradle');
  const original = Buffer.from("plugins { id 'org.springframework.boot' }\r\n", 'utf8');
  await fs.writeFile(build, original);
  try {
    const transactionId = await beginInstallTransaction(project, { projectName: 'sample' }, INSTALL_MODES.NORMAL, [
      { filePath: build, kind: 'build-file' },
    ]);
    await fs.writeFile(build, "dependencies { implementation 'ai.ctxa:broken' }\n", 'utf8');
    await recordChange(project, build, { kind: 'build-file' }, INSTALL_MODES.NORMAL);
    const result = await rollbackInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(await fs.readFile(build), original);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'ROLLED_BACK');
    assert.equal(manifest.files.length, 0);
  } finally {
    await fs.remove(project);
  }
});

test('rollback restores a file backed up before its manifest record was written', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-backup-window-'));
  const source = path.join(project, 'src/main/java/example/SampleApplication.java');
  const original = Buffer.from('package example;\r\npublic class SampleApplication {}\r\n', 'utf8');
  await fs.outputFile(path.join(project, 'build.gradle'), 'plugins {}\n', 'utf8');
  await fs.outputFile(source, original);
  try {
    const transactionId = await beginInstallTransaction(project, { projectName: 'sample' }, INSTALL_MODES.NORMAL);
    await backupFile(source, { mode: INSTALL_MODES.NORMAL });
    await fs.writeFile(source, 'package example; class Broken {}\n', 'utf8');
    const result = await rollbackInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(await fs.readFile(source), original);
  } finally {
    await fs.remove(project);
  }
});

test('an interrupted transaction is recovered before the next transaction starts', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-interrupted-'));
  const infra = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-interrupted-infra-'));
  const build = path.join(project, 'build.gradle');
  const compose = path.join(infra, 'docker-compose.yml');
  const originalBuild = Buffer.from('plugins {}\r\n', 'utf8');
  const originalCompose = Buffer.from('services: {}\r\n', 'utf8');
  await fs.writeFile(build, originalBuild);
  await fs.writeFile(compose, originalCompose);
  try {
    const interruptedId = await beginInstallTransaction(
      project,
      { projectName: 'sample', infraDir: infra },
      INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file' }]
    );
    await prepareExternalFileChange(project, interruptedId, compose, infra, INSTALL_MODES.NORMAL);
    await fs.writeFile(build, 'broken build\n', 'utf8');
    await recordChange(project, build, { kind: 'build-file' }, INSTALL_MODES.NORMAL);
    await fs.writeFile(compose, 'broken compose\n', 'utf8');
    await recordExternalFileChange(project, interruptedId, compose, INSTALL_MODES.NORMAL);

    const recoveredId = await beginInstallTransaction(
      project,
      { projectName: 'sample', infraDir: infra },
      INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file' }]
    );
    assert.notEqual(recoveredId, interruptedId);
    assert.deepEqual(await fs.readFile(build), originalBuild);
    assert.deepEqual(await fs.readFile(compose), originalCompose);
    await rollbackInstallTransaction(project, recoveredId, INSTALL_MODES.NORMAL);
  } finally {
    await fs.remove(project);
    await fs.remove(infra);
  }
});

test('transaction journal persists every lifecycle state and retains an external original through commit', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-journal-'));
  const infra = path.join(project, 'owned-infra');
  const build = path.join(project, 'build.gradle');
  const generatedConfig = path.join(project, 'generated.yml');
  const geo = path.join(project, 'contexa', 'data', 'GeoLite2-City.mmdb');
  const compose = path.join(infra, 'docker-compose.yml');
  const originalCompose = Buffer.from('services: {}\r\n', 'utf8');
  try {
    await fs.outputFile(build, 'plugins {}\n', 'utf8');
    await fs.outputFile(compose, originalCompose);
    const transactionId = await beginInstallTransaction(
      project,
      { projectName: 'journal', infraDir: infra },
      INSTALL_MODES.NORMAL,
      [
        { filePath: build, kind: 'build-file', generated: false },
        { filePath: generatedConfig, kind: 'application-yml', generated: true },
        { filePath: geo, kind: 'geoip-data', generated: true },
      ]
    );
    const prepared = await loadManifest(project);
    assert.equal(prepared.transaction.journal.find(entry => entry.category === 'FILE').state, JOURNAL_STATES.PREPARED);
    assert.equal(prepared.transaction.journal.find(entry => entry.category === 'ARTIFACT').state, JOURNAL_STATES.PREPARED);
    assert.equal(prepared.transaction.journal.find(entry => entry.category === 'MANIFEST').state, JOURNAL_STATES.PLANNED);
    assert.match(prepared.transaction.journalDigest, /^[a-f0-9]{64}$/);

    await fs.writeFile(build, 'plugins { id "java" }\n', 'utf8');
    await recordChange(project, build, { kind: 'build-file' });
    await fs.writeFile(generatedConfig, 'contexa: {}\n', 'utf8');
    await recordChange(project, generatedConfig, { kind: 'application-yml', generated: true });
    await fs.outputFile(geo, 'verified-geoip\n', 'utf8');
    await recordChange(project, geo, { kind: 'geoip-data', generated: true });
    await prepareExternalFileChange(project, transactionId, compose, infra);
    await fs.writeFile(compose, 'services:\n  postgres: {}\n', 'utf8');
    await recordExternalFileChange(project, transactionId, compose);

    const active = await loadManifest(project);
    const contract = buildDockerResourceContract('journal', {
      infra: 'standalone',
      mode: INSTALL_MODES.NORMAL,
      installationId: active.metadata.installationId,
    });
    await recordInstallMetadata(project, {
      dockerResources: contract,
      composeChecksum: crypto.createHash('sha256').update(await fs.readFile(compose)).digest('hex'),
    });
    await prepareDockerMutation(project, transactionId, {
      action: 'REUSE',
      projectName: 'journal',
      infraDir: infra,
      composeChecksum: crypto.createHash('sha256').update(await fs.readFile(compose)).digest('hex'),
      contract,
      services: ['postgres'],
    });
    await recordDockerMutationApplied(project, transactionId);
    await commitInstallTransaction(project, transactionId);

    const committed = await loadManifest(project);
    assert.equal(committed.transaction.status, 'COMMITTED');
    const plannedActions = new Set(committed.transaction.plan.actions.map(entry => entry.action));
    for (const action of ['CREATE', 'MODIFY', 'DOWNLOAD', 'DELETE', 'RESTORE', 'REUSE', 'COMMIT']) {
      assert.ok(plannedActions.has(action), action);
    }
    for (const entry of committed.transaction.journal) {
      const states = entry.history.map(item => item.state);
      assert.ok(states.includes(JOURNAL_STATES.PLANNED), entry.id);
      assert.ok(states.includes(JOURNAL_STATES.PREPARED), entry.id);
      assert.ok(states.includes(JOURNAL_STATES.APPLIED), entry.id);
      assert.ok(states.includes(JOURNAL_STATES.COMMITTED), entry.id);
      assert.equal(entry.state, JOURNAL_STATES.COMMITTED);
    }
    assert.equal(committed.metadata.externalResources.length, 1);

    await restoreExternalResources(project, committed, INSTALL_MODES.NORMAL, {
      metadataUpdates: { infra: 'skip', dockerResources: null, composeChecksum: null },
    });
    assert.deepEqual(await fs.readFile(compose), originalCompose);
    assert.deepEqual((await loadManifest(project)).metadata.externalResources, []);

    const generatedPath = path.join(infra, 'generated.yml');
    const generatedBytes = Buffer.from('generated\n');
    await fs.writeFile(generatedPath, generatedBytes);
    const generatedManifest = await loadManifest(project);
    generatedManifest.metadata.externalResources = [{
      rootPath: infra,
      rootExisted: true,
      filePath: generatedPath,
      originalExisted: false,
      appliedChecksum: crypto.createHash('sha256').update(generatedBytes).digest('hex'),
    }];
    await saveManifest(project, generatedManifest, INSTALL_MODES.NORMAL);
    const generatedAudit = await restoreExternalResources(
      project, generatedManifest, INSTALL_MODES.NORMAL);
    assert.deepEqual(generatedAudit.removed.map(item => item.resource), [generatedPath]);

    const missingPath = path.join(infra, 'already-removed.yml');
    const missingManifest = await loadManifest(project);
    missingManifest.metadata.externalResources = [{
      rootPath: infra,
      rootExisted: true,
      filePath: missingPath,
      originalExisted: false,
      appliedChecksum: crypto.createHash('sha256').update('not-written').digest('hex'),
    }];
    await saveManifest(project, missingManifest, INSTALL_MODES.NORMAL);
    const missingAudit = await restoreExternalResources(
      project, missingManifest, INSTALL_MODES.NORMAL);
    assert.equal(missingAudit.removed.length, 0);
  } finally {
    await fs.remove(project);
  }
});

test('the next transaction recovers Docker PREPARED and APPLIED crash windows before new writes', async t => {
  for (const crashState of [JOURNAL_STATES.PREPARED, JOURNAL_STATES.APPLIED]) {
    await t.test(crashState, async () => {
      const project = await fs.mkdtemp(path.join(os.tmpdir(), `ctxa-phase0-docker-${crashState.toLowerCase()}-`));
      const infra = path.join(project, 'owned-infra');
      const compose = path.join(infra, 'docker-compose.yml');
      try {
        const childScript = [
          "'use strict';",
          "const crypto = require('node:crypto');",
          "const fs = require('fs-extra');",
          "const path = require('node:path');",
          "const manifest = require(" + JSON.stringify(path.join(root, 'src/core/manifest.js')) + ");",
          "const reset = require(" + JSON.stringify(path.join(root, 'src/core/reset-service.js')) + ");",
          "(async () => {",
          "  const project = process.argv[1];",
          "  const infra = process.argv[2];",
          "  const crashState = process.argv[3];",
          "  const compose = path.join(infra, 'docker-compose.yml');",
          "  const interruptedId = await manifest.beginInstallTransaction(project,",
          "    { projectName: 'docker-recovery', infraDir: infra }, manifest.INSTALL_MODES.NORMAL);",
          "  await manifest.prepareExternalFileChange(project, interruptedId, compose, infra);",
          "  await fs.outputFile(compose, 'services:\\n  postgres: {}\\n', 'utf8');",
          "  await manifest.recordExternalFileChange(project, interruptedId, compose);",
          "  const active = await manifest.loadManifest(project);",
          "  const contract = reset.buildDockerResourceContract('docker-recovery', {",
          "    infra: 'standalone', mode: manifest.INSTALL_MODES.NORMAL,",
          "    installationId: active.metadata.installationId,",
          "  });",
          "  const composeChecksum = crypto.createHash('sha256').update(await fs.readFile(compose)).digest('hex');",
          "  await manifest.recordInstallMetadata(project, { dockerResources: contract, composeChecksum });",
          "  await manifest.prepareDockerMutation(project, interruptedId, {",
          "    action: 'START', projectName: 'docker-recovery', infraDir: infra,",
          "    composeChecksum, contract, services: ['postgres'], removeVolumes: true,",
          "  });",
          "  if (crashState === 'APPLIED') {",
          "    await manifest.recordDockerMutationApplied(project, interruptedId);",
          "  }",
          "  process.stdout.write(interruptedId, () => process.exit(91));",
          "})().catch(error => { console.error(error.stack || error); process.exit(92); });",
        ].join('\n');
        const child = spawnSync(
          process.execPath,
          ['-e', childScript, project, infra, crashState],
          { cwd: root, encoding: 'utf8', timeout: 10000 }
        );
        assert.equal(child.status, 91, child.stderr + child.stdout);
        const interruptedId = child.stdout.trim();
        assert.match(interruptedId, /^[a-f0-9-]{36}$/);
        const interrupted = await loadManifest(project);
        const dockerActions = interrupted.transaction.plan.actions
          .filter(entry => entry.category === 'DOCKER')
          .map(entry => entry.action);
        assert.deepEqual(dockerActions, ['START', 'REMOVE']);

        let recovered = 0;
        const nextId = await beginInstallTransaction(
          project,
          { projectName: 'docker-recovery', infraDir: infra },
          INSTALL_MODES.NORMAL,
          [],
          {
            recoverDocker: async mutation => {
              recovered += 1;
              assert.equal(mutation.state, crashState);
              assert.equal(mutation.contract.projectName, 'docker-recovery');
              if (await fs.pathExists(compose)) await fs.remove(compose);
            },
          }
        );
        assert.equal(recovered, 1);
        assert.notEqual(nextId, interruptedId);
        assert.equal(await fs.pathExists(compose), false);
        await rollbackInstallTransaction(project, nextId);
      } finally {
        await fs.remove(project);
      }
    });
  }
});

test('real Docker start followed by process exit is recovered from the persisted exact contract', {
  skip: process.env.CONTEXA_RUN_REAL_DOCKER !== '1',
  timeout: 30000,
}, async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-real-docker-'));
  const infra = path.join(project, 'owned-infra');
  const projectName = `ctxa-p0-${crypto.randomBytes(5).toString('hex')}`;
  const compose = path.join(infra, 'docker-compose.yml');
  const beforeContainers = String(dockerTry(['ps', '--format', '{{.Names}}'], {
    encoding: 'utf8', timeout: 5000,
  }).stdout || '').trim().split(/\r?\n/).filter(Boolean).sort();
  try {
    assert.equal(isDockerCliInstalled(), true);
    assert.equal(isDockerDaemonRunning(), true);
    const childScript = [
      "'use strict';",
      "const fs = require('fs-extra');",
      "const path = require('node:path');",
      "const yaml = require('js-yaml');",
      "const manifest = require(" + JSON.stringify(path.join(root, 'src/core/manifest.js')) + ");",
      "const reset = require(" + JSON.stringify(path.join(root, 'src/core/reset-service.js')) + ");",
      "const docker = require(" + JSON.stringify(path.join(root, 'src/core/docker.js')) + ");",
      "(async () => {",
      "  const project = process.argv[1];",
      "  const infra = process.argv[2];",
      "  const projectName = process.argv[3];",
      "  const compose = path.join(infra, 'docker-compose.yml');",
      "  const id = await manifest.beginInstallTransaction(project,",
      "    { projectName, infraDir: infra }, manifest.INSTALL_MODES.NORMAL);",
      "  const active = await manifest.loadManifest(project);",
      "  const installationId = active.metadata.installationId;",
      "  const labels = {",
      "    'io.ctxa.owner': 'contexa-cli',",
      "    'io.ctxa.mode': 'normal',",
      "    'io.ctxa.installation-id': installationId,",
      "  };",
      "  const model = {",
      "    services: { postgres: {",
      "      image: 'pgvector/pgvector:pg16',",
      "      container_name: projectName + '-postgres',",
      "      environment: { POSTGRES_PASSWORD: 'ctxa-test-only' },",
      "      labels,",
      "      volumes: ['pgdata:/var/lib/postgresql/data'],",
      "    } },",
      "    volumes: { pgdata: { name: projectName + '_pgdata', labels } },",
      "    networks: { default: { name: projectName + '_default', labels } },",
      "  };",
      "  await manifest.prepareExternalFileChange(project, id, compose, infra);",
      "  await fs.outputFile(compose, yaml.dump(model, { noRefs: true }), 'utf8');",
      "  await manifest.recordExternalFileChange(project, id, compose);",
      "  const contract = reset.buildDockerResourceContract(projectName, {",
      "    infra: 'standalone', mode: manifest.INSTALL_MODES.NORMAL, installationId,",
      "  });",
      "  const composeChecksum = manifest.sha256FileSync(compose);",
      "  await manifest.recordInstallMetadata(project, { dockerResources: contract, composeChecksum });",
      "  await manifest.prepareDockerMutation(project, id, {",
      "    action: 'START', projectName, infraDir: infra, composeChecksum, contract,",
      "    services: ['postgres'], removeVolumes: true,",
      "  });",
      "  const started = docker.dockerCompose(['-p', projectName, 'up', '-d', 'postgres'], {",
      "    cwd: infra, stdio: 'pipe', timeout: 15000,",
      "  });",
      "  if (started.error || started.status !== 0) {",
      "    throw started.error || new Error(String(started.stderr || started.stdout));",
      "  }",
      "  process.stdout.write(JSON.stringify({ id, installationId }), () => process.exit(91));",
      "})().catch(error => { console.error(error.stack || error); process.exit(92); });",
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['-e', childScript, project, infra, projectName],
      { cwd: root, encoding: 'utf8', timeout: 25000 }
    );
    assert.equal(child.status, 91, child.stderr + child.stdout);
    const interrupted = JSON.parse(child.stdout);
    const persisted = await loadManifest(project);
    assert.equal(persisted.transaction.id, interrupted.id);
    assert.equal(persisted.transaction.dockerMutation.state, JOURNAL_STATES.PREPARED);
    assert.equal(inspectDockerLabels('container', `${projectName}-postgres`)['io.ctxa.installation-id'],
      interrupted.installationId);

    const nextId = await beginInstallTransaction(
      project,
      { projectName, infraDir: infra },
      INSTALL_MODES.NORMAL,
      [],
      {
        recoverDocker: mutation => performOwnedDockerCleanup({
          contract: mutation.contract,
          mode: mutation.contract.mode,
          installationId: mutation.contract.installationId,
          projectName: mutation.projectName,
          infraDir: mutation.infraDir,
          composeChecksum: mutation.composeChecksum,
          env: { ...process.env, CONTEXA_PROJECT: mutation.projectName },
        }, {
          isCliInstalled: isDockerCliInstalled,
          isDaemonRunning: isDockerDaemonRunning,
          inspectLabels: inspectDockerLabels,
          composeDown: (name, dir, env) => dockerComposeDown(name, dir, env, { removeVolumes: true }),
        }),
      }
    );
    assert.equal(inspectDockerLabels('container', `${projectName}-postgres`), null);
    assert.equal(inspectDockerLabels('volume', `${projectName}_pgdata`), null);
    assert.equal(inspectDockerLabels('network', `${projectName}_default`), null);
    await rollbackInstallTransaction(project, nextId);

    const afterContainers = String(dockerTry(['ps', '--format', '{{.Names}}'], {
      encoding: 'utf8', timeout: 5000,
    }).stdout || '').trim().split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(afterContainers, beforeContainers);
  } finally {
    if (await fs.pathExists(compose)) {
      dockerCompose(['-p', projectName, 'down', '-v', '--timeout', '0'], {
        cwd: infra, stdio: 'pipe', timeout: 10000,
      });
    }
    dockerTry(['rm', '-f', `${projectName}-postgres`], { stdio: 'pipe', timeout: 5000 });
    dockerTry(['volume', 'rm', `${projectName}_pgdata`], { stdio: 'pipe', timeout: 5000 });
    dockerTry(['network', 'rm', `${projectName}_default`], { stdio: 'pipe', timeout: 5000 });
    await fs.remove(project);
  }
});

test('transaction journal tampering is rejected without rewriting recovery state', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-journal-tamper-'));
  try {
    const build = path.join(project, 'build.gradle');
    await fs.writeFile(build, 'plugins {}\n', 'utf8');
    await beginInstallTransaction(
      project,
      { projectName: 'journal-tamper' },
      INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file' }]
    );
    const target = manifestPath(project);
    const tampered = await fs.readJson(target);
    tampered.transaction.journal[0].state = JOURNAL_STATES.COMMITTED;
    await fs.writeJson(target, tampered, { spaces: 2 });
    const exactTamperedBytes = await fs.readFile(target);
    await assert.rejects(loadManifest(project), /transaction journal digest mismatch/);
    assert.deepEqual(await fs.readFile(target), exactTamperedBytes);
  } finally {
    await fs.remove(project);
  }
});

test('transaction rollback restores build, overlay, Java, GeoIP, manifest, and compose stages', async t => {
  const stages = ['overlay', 'java', 'build', 'geoip', 'manifest', 'compose'];
  for (const stage of stages) {
    await t.test(stage, async () => {
      const fixture = await createSpringFixture(`ctxa-phase2-rollback-${stage}-`);
      const infra = path.join(os.tmpdir(), `ctxa-phase2-rollback-infra-${stage}-${path.basename(fixture.project)}`);
      const geo = path.join(fixture.project, 'contexa', 'data', 'GeoLite2-City.mmdb');
      const compose = path.join(infra, 'docker-compose.yml');
      const unrelated = path.join(fixture.project, 'customer-owned.txt');
      await fs.writeFile(unrelated, 'customer-owned\n', 'utf8');
      const before = {
        build: crypto.createHash('sha256').update(await fs.readFile(fixture.build)).digest('hex'),
        yml: crypto.createHash('sha256').update(await fs.readFile(fixture.yml)).digest('hex'),
        source: crypto.createHash('sha256').update(await fs.readFile(fixture.source)).digest('hex'),
        unrelated: crypto.createHash('sha256').update(await fs.readFile(unrelated)).digest('hex'),
      };
      try {
        const transactionId = await beginInstallTransaction(
          fixture.project,
          { projectName: 'rollback-fixture', infraDir: infra },
          INSTALL_MODES.NORMAL,
          [
            { filePath: fixture.build, kind: 'build-file' },
            { filePath: fixture.yml, kind: 'application-yml' },
            { filePath: fixture.source, kind: 'application-source' },
            { filePath: geo, kind: 'geoip-data', generated: true },
          ]
        );

        await fs.writeFile(fixture.yml, 'contexa:\n  changed: true\n', 'utf8');
        await recordChange(fixture.project, fixture.yml, { kind: 'application-yml' }, INSTALL_MODES.NORMAL);
        if (stage !== 'overlay') {
          await fs.writeFile(fixture.source, 'package example; class Changed {}\n', 'utf8');
          await recordChange(fixture.project, fixture.source, { kind: 'application-source' }, INSTALL_MODES.NORMAL);
        }
        if (!['overlay', 'java'].includes(stage)) {
          await fs.writeFile(fixture.build, 'broken build\n', 'utf8');
          if (stage === 'manifest') {
            const originalRename = fs.rename;
            fs.rename = async () => { throw new Error('injected manifest write failure'); };
            try {
              await assert.rejects(
                () => recordChange(fixture.project, fixture.build, { kind: 'build-file' }, INSTALL_MODES.NORMAL),
                /injected manifest write failure/
              );
            } finally {
              fs.rename = originalRename;
            }
          } else {
            await recordChange(fixture.project, fixture.build, { kind: 'build-file' }, INSTALL_MODES.NORMAL);
          }
        }
        if (['geoip', 'compose'].includes(stage)) {
          await fs.outputFile(geo, 'partial geoip\n', 'utf8');
          await recordChange(fixture.project, geo, { kind: 'geoip-data', generated: true }, INSTALL_MODES.NORMAL);
        }
        if (stage === 'compose') {
          await prepareExternalFileChange(fixture.project, transactionId, compose, infra, INSTALL_MODES.NORMAL);
          await fs.outputFile(compose, 'services:\n  broken: {}\n', 'utf8');
          await recordExternalFileChange(fixture.project, transactionId, compose, INSTALL_MODES.NORMAL);
        }

        const rollback = await rollbackInstallTransaction(fixture.project, transactionId, INSTALL_MODES.NORMAL);
        assert.equal(rollback.rolledBack, true, rollback.failures.join('; '));
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(fixture.build)).digest('hex'), before.build);
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(fixture.yml)).digest('hex'), before.yml);
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(fixture.source)).digest('hex'), before.source);
        assert.equal(crypto.createHash('sha256').update(await fs.readFile(unrelated)).digest('hex'), before.unrelated);
        assert.equal(await fs.pathExists(geo), false);
        assert.equal(await fs.pathExists(path.dirname(geo)), false);
        assert.equal(await fs.pathExists(compose), false);
      } finally {
        await fs.remove(fixture.project);
        await fs.remove(infra);
      }
    });
  }
});

test('rollback failure is explicit and preserves recovery metadata', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-rollback-failure-'));
  const build = path.join(project, 'build.gradle');
  await fs.writeFile(build, 'plugins {}\n', 'utf8');
  try {
    const transactionId = await beginInstallTransaction(
      project,
      { projectName: 'sample' },
      INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file' }]
    );
    await fs.remove(path.join(
      backupRoot(project, INSTALL_MODES.NORMAL),
      '__transactions__',
      transactionId,
      'build.gradle'
    ));
    await fs.writeFile(build, 'broken\n', 'utf8');
    const result = await rollbackInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    assert.equal(result.rolledBack, false);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'ROLLBACK_FAILED');
    assert.ok(manifest.transaction.rollbackErrors.length > 0);
    assert.ok(manifest.files.length > 0);
    assert.ok(manifest.transaction.journal.every(entry => entry.state === JOURNAL_STATES.ROLLBACK_FAILED));
  } finally {
    await fs.remove(project);
  }
});

test('manifest replacement failure preserves the last valid manifest', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-manifest-write-'));
  const originalRename = fs.rename;
  try {
    await saveManifest(project, { metadata: { marker: 'valid' }, files: [] }, INSTALL_MODES.NORMAL);
    const before = await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL));
    fs.rename = async () => {
      throw new Error('injected manifest rename failure');
    };
    await assert.rejects(
      saveManifest(project, { metadata: { marker: 'invalid' }, files: [] }, INSTALL_MODES.NORMAL),
      /injected manifest rename failure/
    );
    assert.deepEqual(await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL)), before);
    const stateFiles = await fs.readdir(path.dirname(manifestPath(project, INSTALL_MODES.NORMAL)));
    assert.equal(stateFiles.some(name => name.includes('.tmp-')), false);
  } finally {
    fs.rename = originalRename;
    await fs.remove(project);
  }
});

test('failure matrix restores build, settings, Java, data, and external compose together', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-failure-matrix-'));
  const infra = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-failure-matrix-infra-'));
  const files = {
    build: path.join(project, 'build.gradle'),
    settings: path.join(project, 'src/main/resources/application.yml'),
    java: path.join(project, 'src/main/java/example/SampleApplication.java'),
    data: path.join(project, 'contexa/data/GeoLite2-City.mmdb'),
    compose: path.join(infra, 'docker-compose.yml'),
  };
  const originals = {
    build: Buffer.from('plugins {}\r\n'),
    settings: Buffer.from('server:\r\n  port: 9080\r\n'),
    java: Buffer.from('package example;\r\nclass SampleApplication {}\r\n'),
    compose: Buffer.from('services: {}\r\n'),
  };
  await fs.outputFile(files.build, originals.build);
  await fs.outputFile(files.settings, originals.settings);
  await fs.outputFile(files.java, originals.java);
  await fs.outputFile(files.compose, originals.compose);
  try {
    const transactionId = await beginInstallTransaction(
      project,
      { projectName: 'sample', infraDir: infra },
      INSTALL_MODES.NORMAL,
      [
        { filePath: files.build, kind: 'build-file' },
        { filePath: files.settings, kind: 'application-yml' },
        { filePath: files.java, kind: 'java-annotation' },
        { filePath: files.data, kind: 'geoip-data', generated: true },
      ]
    );
    await prepareExternalFileChange(project, transactionId, files.compose, infra, INSTALL_MODES.NORMAL);
    for (const key of ['build', 'settings', 'java']) {
      await fs.writeFile(files[key], `broken-${key}\n`);
      await recordChange(project, files[key], { kind: key }, INSTALL_MODES.NORMAL);
    }
    await fs.outputFile(files.data, 'generated-data');
    await recordChange(project, files.data, { kind: 'geoip-data', generated: true }, INSTALL_MODES.NORMAL);
    await fs.writeFile(files.compose, 'broken-compose\n');
    await recordExternalFileChange(project, transactionId, files.compose, INSTALL_MODES.NORMAL);

    const result = await rollbackInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(await fs.readFile(files.build), originals.build);
    assert.deepEqual(await fs.readFile(files.settings), originals.settings);
    assert.deepEqual(await fs.readFile(files.java), originals.java);
    assert.deepEqual(await fs.readFile(files.compose), originals.compose);
    assert.equal(await fs.pathExists(files.data), false);
  } finally {
    await fs.remove(project);
    await fs.remove(infra);
  }
});

test('manifestless repeated reset is a safe no-op', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-reset-'));
  try {
    const result = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No matching Contexa ownership manifest exists/);
    assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
  } finally {
    await fs.remove(project);
  }
});

test('async command error matrix returns non-zero on stderr without success or residual child processes', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-error-matrix-'));
  const emptyProject = path.join(rootDir, 'empty-project');
  const missingSimulation = path.join(rootDir, 'missing-simulation');
  const corruptReset = path.join(rootDir, 'corrupt-reset');
  await fs.ensureDir(emptyProject);
  await fs.ensureDir(missingSimulation);
  await fs.outputFile(path.join(corruptReset, 'contexa', 'manifest.json'), '{invalid', 'utf8');
  const cases = [
    { name: 'init', args: ['init', '--yes', '--dir', emptyProject] },
    { name: 'doctor', args: ['doctor', '--provider', 'invalid-provider'] },
    { name: 'mode', args: ['mode', '--dir', emptyProject] },
    { name: 'simulate', args: ['simulate', 'up', '--infra-dir', missingSimulation] },
    { name: 'reset', args: ['reset', '--yes', '--dir', corruptReset] },
  ];
  try {
    for (const command of cases) {
      await t.test(command.name, () => {
        const startedAt = Date.now();
        const result = spawnSync(process.execPath, [cliPath, ...command.args], {
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.notEqual(result.status, 0, `${command.name} unexpectedly succeeded`);
        assert.equal(result.signal, null, `${command.name} exceeded its timeout`);
        assert.ok(result.stderr.trim().length > 0, `${command.name} did not report its error on stderr`);
        assert.doesNotMatch(result.stdout, /successfully completed|initialization completed|All checks passed/i);
        assert.ok(Date.now() - startedAt < 5000, `${command.name} did not terminate within the configured timeout`);
        if (result.pid) {
          assert.throws(() => process.kill(result.pid, 0), undefined, `${command.name} child process is still alive`);
        }
      });
    }
  } finally {
    await fs.remove(rootDir);
  }
});

test('actual Quick init is idempotent and reset preserves the host project byte-for-byte', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const { project, build, yml, source, originalBuild, originalYml, originalSource } = await createSpringFixture('ctxa-phase0-command-');
  try {
    const childEnv = {
      ...process.env,
      PATH: path.dirname(process.execPath),
      CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
    };
    const init = spawnSync(process.execPath,
      [cliPath, 'init', '--yes', '--no-docker', '--dir', project],
      { encoding: 'utf8', env: childEnv });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.match(init.stdout, /Planned changes/);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'COMMITTED');
    assert.equal(manifest.metadata.mode, INSTALL_MODES.NORMAL);
    const installedBuild = await fs.readFile(build, 'utf8');
    const starterCoordinate = [
      releaseManifest.starter.groupId,
      releaseManifest.starter.artifactId,
      releaseManifest.starter.version,
    ].join(':');
    assert.ok(installedBuild.includes(starterCoordinate));
    assert.ok(manifest.files.every(entry => entry.installationId === manifest.metadata.installationId));
    assert.deepEqual(await fs.readFile(yml), Buffer.from(originalYml, 'utf8'));
    assert.match(await fs.readFile(source, 'utf8'),
      /@EnableAISecurity\(mode = SecurityMode\.FULL\)/);
    const overlayPath = path.join(project, 'src/main/resources/application-contexa.yml');
    const overlay = yaml.load(await fs.readFile(overlayPath, 'utf8'));
    assert.equal(overlay.contexa.security.zerotrust.mode, 'SHADOW');
    assert.equal(overlay.contexa.llm.selection.chat.priority, 'ollama');
    const updatedYml = yaml.load(await fs.readFile(yml, 'utf8'));
    assert.equal(updatedYml.spring.security.user.name, 'host-user');
    assert.equal(updatedYml.spring.datasource.url, 'jdbc:postgresql://127.0.0.1:35433/host-owned');
    assert.equal(updatedYml.spring.ai.provider, 'host-owned');

    const firstBuild = await fs.readFile(build);
    const firstSource = await fs.readFile(source);
    const firstOverlay = await fs.readFile(overlayPath);
    const firstManifest = await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL));
    const repeatedInit = spawnSync(process.execPath,
      [cliPath, 'init', '--yes', '--no-docker', '--dir', project],
      { encoding: 'utf8', env: childEnv });
    assert.equal(repeatedInit.status, 0, repeatedInit.stderr + repeatedInit.stdout);
    assert.deepEqual(await fs.readFile(build), firstBuild);
    assert.deepEqual(await fs.readFile(yml), Buffer.from(originalYml, 'utf8'));
    assert.deepEqual(await fs.readFile(source), firstSource);
    assert.deepEqual(await fs.readFile(overlayPath), firstOverlay);
    assert.deepEqual(await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL)), firstManifest);

    const reset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project],
      { encoding: 'utf8', env: childEnv });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.equal(await fs.readFile(build, 'utf8'), originalBuild);
    assert.equal(await fs.readFile(yml, 'utf8'), originalYml);
    assert.equal(await fs.readFile(source, 'utf8'), originalSource);
    assert.equal(await fs.pathExists(overlayPath), false);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), false);

    const repeated = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project],
      { encoding: 'utf8', env: childEnv });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /No matching Contexa ownership manifest exists/);
  } finally {
    await fs.remove(project);
  }
});

test('init provenance distinguishes user starter and preserves post-init user changes through reset', async () => {
  const cliOwned = await createSpringFixture('ctxa-phase2-provenance-cli-');
  const userOwned = await createSpringFixture('ctxa-phase2-provenance-user-');
  try {
    const first = spawnSync(process.execPath, [
      cliPath, 'init', '--yes', '--no-docker', '--infra-dir',
      path.join(cliOwned.project, 'contexa-test-infra'), '--dir', cliOwned.project,
    ], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const firstManifestBytes = await fs.readFile(manifestPath(cliOwned.project, INSTALL_MODES.NORMAL));
    const firstManifest = await loadManifest(cliOwned.project, INSTALL_MODES.NORMAL);
    const cliEntry = firstManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(cliEntry.ownership, 'CLI_OWNED');
    assert.equal(cliEntry.cliApplied, true);
    assert.equal(cliEntry.lastCliChecksum, cliEntry.currentChecksum);

    await fs.appendFile(cliOwned.build, '// customer change after init\n', 'utf8');
    const customerBuild = await fs.readFile(cliOwned.build);
    const second = spawnSync(process.execPath, [
      cliPath, 'init', '--yes', '--no-docker', '--infra-dir',
      path.join(cliOwned.project, 'contexa-test-infra'), '--dir', cliOwned.project,
    ], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.deepEqual(await fs.readFile(cliOwned.build), customerBuild);
    assert.deepEqual(await fs.readFile(manifestPath(cliOwned.project, INSTALL_MODES.NORMAL)), firstManifestBytes);

    const resetCliOwned = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', cliOwned.project], { encoding: 'utf8' });
    assert.equal(resetCliOwned.status, 0, resetCliOwned.stderr + resetCliOwned.stdout);
    assert.match(resetCliOwned.stdout, /preserved: build\.gradle/);
    const mergedBuild = await fs.readFile(cliOwned.build, 'utf8');
    assert.equal(mergedBuild.includes('spring-boot-starter-contexa'), false);
    assert.equal(mergedBuild.includes('// customer change after init'), true);
    assert.equal(await fs.pathExists(manifestPath(cliOwned.project, INSTALL_MODES.NORMAL)), false);

    const userStarterCoordinate = [
      releaseManifest.starter.groupId,
      releaseManifest.starter.artifactId,
      releaseManifest.starter.version,
    ].join(':');
    const preinstalled = userOwned.originalBuild.replace(
      `implementation 'org.springframework.boot:spring-boot-starter-web'`,
      `implementation 'org.springframework.boot:spring-boot-starter-web'\n  implementation '${userStarterCoordinate}'`
    );
    await fs.writeFile(userOwned.build, preinstalled, 'utf8');
    const initUserOwned = spawnSync(process.execPath, [
      cliPath, 'init', '--yes', '--no-docker', '--infra-dir',
      path.join(userOwned.project, 'contexa-test-infra'), '--dir', userOwned.project,
    ], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(initUserOwned.status, 0, initUserOwned.stderr + initUserOwned.stdout);
    const userManifest = await loadManifest(userOwned.project, INSTALL_MODES.NORMAL);
    const userEntry = userManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(userEntry.ownership, 'CLI_OWNED');
    assert.equal(userEntry.cliApplied, true);
    assert.ok(userEntry.lastCliChecksum);
    const dependencyProvenance = userManifest.metadata.dependencyProvenance || [];
    assert.equal(dependencyProvenance.some(coordinate =>
      coordinate.group === releaseManifest.starter.groupId
        && coordinate.artifact === releaseManifest.starter.artifactId), false);
    assert.equal(dependencyProvenance.length > 0, true,
      'Quick provider dependencies added by the CLI must retain canonical provenance');
    const userComment = '// customer change after init\n';
    const userOwnedAfterInit = await fs.readFile(userOwned.build, 'utf8') + userComment;
    await fs.writeFile(userOwned.build, userOwnedAfterInit, 'utf8');
    const resetUserOwned = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', userOwned.project], { encoding: 'utf8' });
    assert.equal(resetUserOwned.status, 0, resetUserOwned.stderr + resetUserOwned.stdout);
    assert.equal(await fs.readFile(userOwned.build, 'utf8'), preinstalled + userComment);
    assert.equal(await fs.pathExists(manifestPath(userOwned.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(cliOwned.project);
    await fs.remove(userOwned.project);
  }
});

test('reset retry accepts a file already restored before a previous partial failure', async () => {
  const fixture = await createSpringFixture('ctxa-phase2-reset-retry-');
  try {
    const init = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', fixture.project], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const manifest = await loadManifest(fixture.project, INSTALL_MODES.NORMAL);
    const buildEntry = manifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.ok(buildEntry);

    await fs.writeFile(fixture.build, fixture.originalBuild, 'utf8');
    const reset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', fixture.project], { encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.match(reset.stdout, /restored: build\.gradle - already at original state/);
    assert.doesNotMatch(reset.stdout, /conflict:|failed:/);
    assert.equal(await fs.readFile(fixture.build, 'utf8'), fixture.originalBuild);
    assert.equal(await fs.pathExists(manifestPath(fixture.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('actual overlay init failure rolls back host files and records ROLLED_BACK', async () => {
  const { project, build, yml, originalBuild, originalYml } =
    await createSpringFixture('ctxa-phase0-command-failure-');
  const infra = path.join(project, '.contexa-test-infra');
  const overlay = path.join(project, 'src/main/resources/application-contexa.yml');
  const invalidYml = Buffer.from('spring: [unterminated\r\n', 'utf8');
  await fs.writeFile(overlay, invalidYml);
  try {
    const args = [
      cliPath, 'init', '--yes', '--distributed', '--no-docker',
      '--dir', project, '--infra-dir', infra,
    ];
    const init = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(init.status, 0, init.stdout);
    assert.doesNotMatch(init.stdout, /Contexa initialization completed successfully/i);
    assert.deepEqual(await fs.readFile(build), Buffer.from(originalBuild, 'utf8'));
    assert.deepEqual(await fs.readFile(yml), Buffer.from(originalYml, 'utf8'));
    assert.deepEqual(await fs.readFile(overlay), invalidYml);
    assert.equal(await fs.pathExists(path.join(infra, 'docker-compose.yml')), false);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'ROLLED_BACK');
    assert.equal(manifest.files.length, 0);

    await fs.remove(overlay);
    const retry = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr + retry.stdout);
    assert.equal(await fs.pathExists(path.join(infra, 'docker-compose.yml')), true);
  } finally {
    await fs.remove(project);
    await fs.remove(infra);
  }
});

test('normal and simulation command states coexist and reset independently', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false
    : 'Phase 4 requires the approved GeoIP artifact through CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const { project, build, yml, originalBuild, originalYml } = await createSpringFixture('ctxa-phase0-coexist-');
  const infraHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-sim-home-'));
  const infraDir = process.platform === 'win32'
    ? path.join(infraHome, 'Contexa', 'ctxa-sim')
    : path.join(infraHome, 'contexa', 'ctxa-sim');
  const geoSource = path.resolve(process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH);
  const childEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath),
    LOCALAPPDATA: infraHome,
    XDG_CONFIG_HOME: infraHome,
    CONTEXA_GEOLITE2_SOURCE_PATH: geoSource,
  };
  try {
    const normalInit = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(normalInit.status, 0, normalInit.stderr + normalInit.stdout);
    const normalBuild = await fs.readFile(build);
    const normalYml = await fs.readFile(yml);
    const normalManifestBytes = await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL));

    const simulationInit = spawnSync(process.execPath, [cliPath, 'init', '--simulate'], {
      cwd: project, encoding: 'utf8', env: childEnv, timeout: 10000,
    });
    assert.equal(simulationInit.status, 0, simulationInit.stderr + simulationInit.stdout);
    assert.match(simulationInit.stdout, /COPY: GeoLite2-City\.mmdb/);
    assert.match(simulationInit.stdout, /DOCKER: SKIP service start/);
    assert.match(simulationInit.stdout, /DELETE: NONE/);
    assert.deepEqual(await fs.readFile(build), normalBuild);
    assert.deepEqual(await fs.readFile(yml), normalYml);
    assert.deepEqual(await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL)), normalManifestBytes);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), true);
    const overlayPath = path.join(project, 'src/main/resources/application-contexa-sim.yml');
    const configurationPath = path.join(project, 'src/main/java/example/ContexaSimulationConfiguration.java');
    const simulationGeoIp = path.join(project, 'contexa/simulation/data/GeoLite2-City.mmdb');
    const overlay = yaml.load(await fs.readFile(overlayPath, 'utf8'));
    assert.equal(overlay.spring.config.activate['on-profile'], 'contexa-sim');
    assert.equal(overlay.server.port, '${CONTEXA_SIMULATION_SERVER_PORT:9080}');
    assert.equal(overlay.contexa.datasource.url, '${CONTEXA_DB_URL}');
    assert.equal(overlay.spring.datasource, undefined);
    assert.equal(overlay.spring.data.redis.host, '${REDIS_HOST}');
    assert.equal(overlay.spring.data.redis.port, '${REDIS_PORT}');
    assert.equal(overlay.spring.kafka['bootstrap-servers'], '${KAFKA_BOOTSTRAP_SERVERS}');
    assert.match(await fs.readFile(configurationPath, 'utf8'), /@Profile\("contexa-sim"\)/);
    assert.equal(await fs.pathExists(simulationGeoIp), true);
    const normalManifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    const simulationManifest = await loadManifest(project, INSTALL_MODES.SIMULATION);
    assert.notEqual(normalManifest.metadata.installationId, simulationManifest.metadata.installationId);
    assert.ok(simulationManifest.files.every(entry => entry.installationId === simulationManifest.metadata.installationId));
    assert.equal(path.resolve(simulationManifest.metadata.infraDir), path.resolve(infraDir));
    const previousProjectEnv = process.env.CONTEXA_PROJECT;
    const previousDbEnv = process.env.CONTEXA_DB_URL;
    process.env.CONTEXA_PROJECT = 'production-project';
    process.env.CONTEXA_DB_URL = 'jdbc:postgresql://production/database';
    try {
      const freshShellContext = await buildSimulationContext({ dir: project });
      assert.equal(freshShellContext.env.CONTEXA_PROJECT, 'ctxa-sim');
      assert.equal(freshShellContext.env.CONTEXA_DB_URL,
        'jdbc:postgresql://127.0.0.1:25432/contexa_sim');
      assert.equal(freshShellContext.overlayPath, overlayPath);
      assert.equal(freshShellContext.configurationPath, configurationPath);
    } finally {
      if (previousProjectEnv === undefined) delete process.env.CONTEXA_PROJECT;
      else process.env.CONTEXA_PROJECT = previousProjectEnv;
      if (previousDbEnv === undefined) delete process.env.CONTEXA_DB_URL;
      else process.env.CONTEXA_DB_URL = previousDbEnv;
    }
    const compose = yaml.load(await fs.readFile(path.join(infraDir, 'docker-compose.yml'), 'utf8'));
    assert.equal(compose['x-contexa-ownership']['io.ctxa.mode'], 'simulation');
    assert.equal(compose['x-contexa-ownership']['io.ctxa.installation-id'], simulationManifest.metadata.installationId);
    for (const service of Object.values(compose.services)) {
      assert.equal(service.labels['io.ctxa.installation-id'], simulationManifest.metadata.installationId);
    }
    for (const volume of Object.values(compose.volumes)) {
      assert.equal(volume.labels['io.ctxa.mode'], 'simulation');
    }
    assert.equal(compose.networks.default.labels['io.ctxa.mode'], 'simulation');

    const repeatNormalInit = spawnSync(process.execPath,
      [cliPath, 'init', '--yes', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(repeatNormalInit.status, 0, repeatNormalInit.stderr + repeatNormalInit.stdout);
    assert.deepEqual(await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL)), normalManifestBytes);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), true);
    const combinedStatus = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(combinedStatus.status, 0, combinedStatus.stderr + combinedStatus.stdout);
    assert.match(combinedStatus.stdout, /Normal installation: COMMITTED/);
    assert.match(combinedStatus.stdout, /Simulation installation: COMMITTED/);

    const simulationReset = spawnSync(process.execPath, [cliPath, 'reset', '--simulate'], {
      cwd: project, encoding: 'utf8', env: childEnv, input: 'y\n', timeout: 10000,
    });
    assert.equal(simulationReset.status, 0, simulationReset.stderr + simulationReset.stdout);
    assert.deepEqual(await fs.readFile(build), normalBuild);
    assert.deepEqual(await fs.readFile(yml), normalYml);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), false);
    assert.equal(await fs.pathExists(overlayPath), false);
    assert.equal(await fs.pathExists(configurationPath), false);
    assert.equal(await fs.pathExists(simulationGeoIp), false);
    const afterSimulationResetStatus = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.match(afterSimulationResetStatus.stdout, /Normal installation: COMMITTED/);
    assert.match(afterSimulationResetStatus.stdout, /Simulation installation: ABSENT/);

    const normalReset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(normalReset.status, 0, normalReset.stderr + normalReset.stdout);
    assert.equal(await fs.readFile(build, 'utf8'), originalBuild);
    assert.equal(await fs.readFile(yml, 'utf8'), originalYml);
  } finally {
    await fs.remove(project);
    await fs.remove(infraHome);
  }
});
