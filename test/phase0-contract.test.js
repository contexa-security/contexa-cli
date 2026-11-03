'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');
const releaseManifest = require('../release-manifest.json');
const packageJson = require('../package.json');
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
const {
  createSandbox,
  cliEnv,
  runCliSync,
  resetResult,
  createGradleProject,
  snapshotDirectory: snapshotProject,
  starterCount,
} = require('./harness');

// CLI runs get a sandboxed PC-wide state, fake API keys, English messages and the test hooks
// that keep Docker, the build tool and Java out of the run (test/harness.js).
let cliSandbox;
test.before(async () => { cliSandbox = await createSandbox('ctxa-phase0-cli-'); });
test.after(() => fs.remove(cliSandbox.root));

function cli(args, overrides = {}) {
  return runCliSync(args, { env: cliEnv(cliSandbox, overrides) });
}

async function createSpringFixture(prefix) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const build = path.join(project, 'build.gradle');
  const yml = path.join(project, 'src/main/resources/application.yml');
  const source = path.join(project, 'src/main/java/example/SampleApplication.java');
  const originalBuild = "plugins { id 'org.springframework.boot' version '3.5.4' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n";
  const originalYml = "server:\n  port: 9080\nspring:\n  datasource:\n    url: jdbc:postgresql://127.0.0.1:35433/host-owned\n  security:\n    user:\n      name: host-user\n      password: host-password\n  ai:\n    provider: host-owned\n";
  await fs.outputFile(build, originalBuild, 'utf8');
  await fs.outputFile(path.join(project, 'settings.gradle'), "rootProject.name = 'phase0-fixture'\n", 'utf8');
  await fs.outputFile(yml, originalYml, 'utf8');
  const originalSource = 'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class SampleApplication {}\n';
  await fs.outputFile(source, originalSource, 'utf8');
  return { project, build, yml, source, originalBuild, originalYml, originalSource };
}

test('Phase 0 release and primary-command contract has one canonical source', () => {
  assert.equal(releaseManifest.cliVersion, packageJson.version);
  // The version is raised in package.json and in the manifest together; the release stops at a mismatch.
  assert.equal(releaseManifest.cliVersion, require('../package.json').version);
  assert.equal(releaseManifest.releaseTag, 'v' + releaseManifest.cliVersion);
  assert.equal(releaseManifest.schemaVersion, 2);
  assert.equal(releaseManifest.channel, 'snapshot');
  assert.match(releaseManifest.starter.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(releaseManifest.primaryCommands, [
    'contexa init',
    'contexa doctor',
    'contexa reset',
  ]);
  assert.deepEqual(releaseManifest.dependencyVersions, { springAiBom: '1.1.8', sampleSpringBoot: '3.5.16' });
  assert.equal('resources' in releaseManifest, false, 'no downloadable resources (GeoLite2) any more');
  const common = fs.readFileSync(path.join(root, 'src/core/injector/common.js'), 'utf8');
  assert.match(common, /releaseManifest\.starter\.version/);
  assert.match(common, /releaseManifest\.dependencyVersions/);
  assert.equal(common.includes("CONTEXA_VERSION = '"), false);
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
  assert.equal(packageJson.scripts['test:binary'], 'node test/binary-smoke.cjs');
  assert.equal('test:e2e' in packageJson.scripts, false);
  assert.equal('test:bootrun' in packageJson.scripts, false);
});

test('init prints the complete plan before the first filesystem mutation', async () => {
  const sandbox = await createSandbox('ctxa-phase0-plan-before-write-');
  const project = await createGradleProject(sandbox.root, 'plan-first');
  const { Command } = require('commander');
  const { t } = require('../src/core/i18n');
  const registerInit = require('../src/commands/init');
  const mutableMethods = ['ensureDir', 'writeFile', 'outputFile', 'copy', 'move', 'rename', 'remove'];
  const originals = Object.fromEntries(mutableMethods.map(name => [name, fs[name]]));
  const originalLog = console.log;
  const hooks = {
    LOCALAPPDATA: sandbox.localAppData,
    XDG_CONFIG_HOME: sandbox.xdg,
    CONTEXA_TEST_LOCAL_SERVICES: 'fake',
    CONTEXA_TEST_DEPENDENCY_CHECK: 'pass',
    CONTEXA_TEST_JAVA_VERSION: '17',
  };
  const savedEnv = Object.fromEntries(Object.keys(hooks).map(name => [name, process.env[name]]));
  let planSeen = false;
  let mutationCount = 0;
  try {
    Object.assign(process.env, hooks);
    const before = await snapshotProject(project);
    const homeBefore = await snapshotProject(sandbox.root, { exclude: [path.basename(project)] });
    console.log = (...args) => {
      if (args.map(String).join(' ').includes(t('init.plan.title'))) planSeen = true;
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
      program.parseAsync([process.execPath, 'contexa', 'init', '--yes', '--dir', project]),
      /INJECTED_FIRST_MUTATION_AFTER_PLAN/
    );
    assert.equal(planSeen, true);
    assert.equal(mutationCount, 1);
    for (const [name, implementation] of Object.entries(originals)) fs[name] = implementation;
    assert.deepEqual(await snapshotProject(project), before);
    assert.deepEqual(await snapshotProject(sandbox.root, { exclude: [path.basename(project)] }), homeBefore,
      'the computer-wide Contexa folder was not touched either');
  } finally {
    console.log = originalLog;
    for (const [name, implementation] of Object.entries(originals)) fs[name] = implementation;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.remove(sandbox.root);
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
  assert.match(workflow, /ref: 0af591c80b4fbe7e1e623886ed10e277c07d2291/);
  assert.match(workflow, /name: signed-release-gate-\$\{\{ github\.sha \}\}/);
  assert.equal((workflow.match(/if: startsWith\(github\.ref, 'refs\/tags\/'\)/g) || []).length, 3);
  assert.equal((workflow.match(/^\s*run: npm test\s*$/gm) || []).length, 0);

  // The test steps run what this repository has, on every platform.
  assert.match(workflow, /node --test test\/\*\.test\.js 2>&1 \| tee test-evidence\/unit-\$\{\{ matrix\.label \}\}\.tap/);
  assert.match(workflow, /- name: Compile injected build models\s+if: runner\.os == 'Linux'[\s\S]*?node test\/build-models\.cjs/);
  assert.equal((workflow.match(/run: node test\/binary-smoke\.cjs/g) || []).length, 2, 'binary smoke on POSIX and Windows');
  assert.match(workflow, /CONTEXA_CLI_EXECUTABLE: \$\{\{ github\.workspace \}\}\/dist\/\$\{\{ matrix\.output \}\}/);
  assert.match(workflow, /CONTEXA_CLI_EXECUTABLE: \$\{\{ github\.workspace \}\}\\dist\\\$\{\{ matrix\.output \}\}/);
  for (const script of workflow.match(/node (test\/[\w.-]+\.c?js)/g) || []) {
    const file = script.replace(/^node /, '');
    assert.ok(fs.existsSync(path.join(root, file)), `workflow runs ${file}, which must exist`);
  }
  assert.doesNotMatch(workflow, /GeoLite2|GEOLITE|geoip/i);
  assert.doesNotMatch(workflow, /examples-matrix|examples-bootrun|phase6|simulate|test:e2e/);
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
  const version = cli(['--version']);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), releaseManifest.cliVersion);
  const firstRun = cli([]);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  assert.match(firstRun.stdout, new RegExp(`CONTEXA\\s+v${releaseManifest.cliVersion.replace(/\./g, '\\.')}`));
  assert.match(firstRun.stdout, /Usage: contexa/);
  for (const command of releaseManifest.primaryCommands) {
    const name = command.replace(/^contexa /, '');
    assert.match(firstRun.stdout, new RegExp(`^\\s+${name}\\b`, 'm'), `missing primary command in help: ${command}`);
  }
  assert.match(firstRun.stdout, /contexa init/);
  for (const removed of ['simulate', 'status', 'scan', 'mode', 'ollama']) {
    assert.doesNotMatch(firstRun.stdout, new RegExp(`^\\s+${removed}\\b`, 'm'), `removed command still listed: ${removed}`);
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

test('rollback restores a planned file changed before its manifest record was written', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase0-backup-window-'));
  const source = path.join(project, 'src/main/java/example/SampleApplication.java');
  const original = Buffer.from('package example;\r\npublic class SampleApplication {}\r\n', 'utf8');
  await fs.outputFile(path.join(project, 'build.gradle'), 'plugins {}\n', 'utf8');
  await fs.outputFile(source, original);
  try {
    const transactionId = await beginInstallTransaction(project, { projectName: 'sample' }, INSTALL_MODES.NORMAL, [
      { filePath: source, kind: 'application-source' },
    ]);
    // The process wrote the file but died before recordChange: only the transaction backup knows it.
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
  skip: process.env.CONTEXA_RUN_REAL_DOCKER === '1'
    ? false : 'starts a real PostgreSQL container; set CONTEXA_RUN_REAL_DOCKER=1 to run it',
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
    for (let run = 0; run < 2; run += 1) {
      const result = cli(['reset', '--yes', '--dir', project]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Nothing to undo: contexa init has not changed this project\./);
      assert.equal(resetResult(result.stdout).result, 'NO_OWNED_INSTALLATION');
    }
    assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
    assert.deepEqual(await fs.readdir(project), []);
  } finally {
    await fs.remove(project);
  }
});

test('async command error matrix returns non-zero without success or residual child processes', async t => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-error-matrix-'));
  const boot4 = await createGradleProject(rootDir, 'boot4', { bootVersion: '4.0.1' });
  const plain = path.join(rootDir, 'plain');
  const corruptReset = path.join(rootDir, 'corrupt-reset');
  const emptyFolder = path.join(rootDir, 'empty-doctor');
  await fs.outputFile(path.join(plain, 'pom.xml'), '<project><artifactId>plain</artifactId></project>\n');
  await fs.outputFile(path.join(corruptReset, 'contexa', 'manifest.json'), '{invalid', 'utf8');
  await fs.ensureDir(emptyFolder);
  const cases = [
    { name: 'init on Spring Boot 4', args: ['init', '--yes', '--dir', boot4], code: /SPRING_BOOT_UNSUPPORTED/ },
    { name: 'init without Spring Boot', args: ['init', '--yes', '--dir', plain], code: /SPRING_BOOT_REQUIRED/ },
    { name: 'init with an unknown provider', args: ['init', '--yes', '--provider', 'invalid-provider', '--dir', boot4], code: /invalid-provider/ },
    { name: 'reset with a corrupt record', args: ['reset', '--yes', '--dir', corruptReset], code: /MANIFEST/ },
    { name: 'a removed command', args: ['simulate', 'up'], code: /unknown command 'simulate'/ },
    { name: 'a removed option', args: ['init', '--yes', '--distributed', '--dir', boot4], code: /unknown option '--distributed'/ },
    { name: 'doctor outside a project', args: ['doctor', '--dir', emptyFolder], stdout: /x Project: no Spring Boot application here/ },
  ];
  try {
    for (const command of cases) {
      await t.test(command.name, () => {
        const startedAt = Date.now();
        const result = runCliSync(command.args, { env: cliEnv(cliSandbox), timeoutMs: 15000 });
        assert.notEqual(result.code, 0, `${command.name} unexpectedly succeeded`);
        assert.equal(result.signal, null, `${command.name} exceeded its timeout`);
        if (command.code) assert.match(result.stderr, command.code, `${command.name} did not report its error on stderr`);
        if (command.stdout) assert.match(result.stdout, command.stdout);
        assert.doesNotMatch(result.stdout, /Contexa is set up|Contexa was removed|Everything is in place/);
        assert.ok(Date.now() - startedAt < 15000, `${command.name} did not terminate within the configured timeout`);
      });
    }
    assert.deepEqual((await snapshotProject(boot4)).filter(entry => entry.path.startsWith('contexa')), []);
  } finally {
    await fs.remove(rootDir);
  }
});

test('init provenance distinguishes a user starter and preserves post-init user changes through reset', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-provenance-'));
  try {
    const cliOwned = await createGradleProject(parent, 'cli-owned');
    const cliBuild = path.join(cliOwned, 'build.gradle');
    const originalCliBuild = await fs.readFile(cliBuild, 'utf8');
    const first = cli(['init', '--yes', '--dir', cliOwned]);
    assert.equal(first.code, 0, first.output);
    const firstManifest = await loadManifest(cliOwned, INSTALL_MODES.NORMAL);
    const cliEntry = firstManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(cliEntry.ownership, 'CLI_OWNED');
    assert.equal(cliEntry.cliApplied, true);
    assert.equal(cliEntry.lastCliChecksum, cliEntry.currentChecksum);

    await fs.appendFile(cliBuild, '// customer change after init\n', 'utf8');
    const customerBuild = await fs.readFile(cliBuild);
    const second = cli(['init', '--yes', '--dir', cliOwned]);
    assert.equal(second.code, 0, second.output);
    assert.deepEqual(await fs.readFile(cliBuild), customerBuild, 'a second init adds nothing that is already there');

    const resetCliOwned = cli(['reset', '--yes', '--dir', cliOwned]);
    assert.equal(resetCliOwned.code, 0, resetCliOwned.output);
    assert.match(resetCliOwned.stdout, /kept: build\.gradle - user changes preserved; CLI changes removed/);
    assert.equal(await fs.readFile(cliBuild, 'utf8'), originalCliBuild + '// customer change after init\n');
    assert.equal(await fs.pathExists(manifestPath(cliOwned, INSTALL_MODES.NORMAL)), false);

    // The user already declared the starter: init adds only the AI dependencies, and reset keeps
    // the user's starter while removing what init added.
    const userOwned = await createGradleProject(parent, 'user-owned');
    const userBuild = path.join(userOwned, 'build.gradle');
    const userStarterCoordinate = [
      releaseManifest.starter.groupId,
      releaseManifest.starter.artifactId,
      releaseManifest.starter.version,
    ].join(':');
    const preinstalled = (await fs.readFile(userBuild, 'utf8')).replace(
      "    implementation 'org.springframework.boot:spring-boot-starter-web'",
      `    implementation 'org.springframework.boot:spring-boot-starter-web'\n    implementation '${userStarterCoordinate}'`
    );
    await fs.writeFile(userBuild, preinstalled, 'utf8');
    const initUserOwned = cli(['init', '--yes', '--dir', userOwned]);
    assert.equal(initUserOwned.code, 0, initUserOwned.output);
    const userInstalled = await fs.readFile(userBuild, 'utf8');
    assert.equal(starterCount(userInstalled), 1, 'the user starter is not added twice');
    assert.match(userInstalled, /spring-ai-starter-vector-store-pgvector/);
    const userManifest = await loadManifest(userOwned, INSTALL_MODES.NORMAL);
    const userEntry = userManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(userEntry.ownership, 'CLI_OWNED');
    assert.equal(userEntry.cliApplied, true);
    assert.ok(userEntry.lastCliChecksum);

    const userComment = '// customer change after init\n';
    await fs.writeFile(userBuild, userInstalled + userComment, 'utf8');
    const resetUserOwned = cli(['reset', '--yes', '--dir', userOwned]);
    assert.equal(resetUserOwned.code, 0, resetUserOwned.output);
    assert.equal(await fs.readFile(userBuild, 'utf8'), preinstalled + userComment);
    assert.equal(await fs.pathExists(manifestPath(userOwned, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(parent);
  }
});

test('reset retry accepts a file already restored before a previous partial failure', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-reset-retry-'));
  try {
    const project = await createGradleProject(parent, 'retry');
    const build = path.join(project, 'build.gradle');
    const originalBuild = await fs.readFile(build, 'utf8');
    const before = await snapshotProject(project);
    const init = cli(['init', '--yes', '--dir', project]);
    assert.equal(init.code, 0, init.output);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.ok(manifest.files.find(entry => entry.relativePath === 'build.gradle'));

    await fs.writeFile(build, originalBuild, 'utf8');
    const reset = cli(['reset', '--yes', '--dir', project]);
    assert.equal(reset.code, 0, reset.output);
    assert.match(reset.stdout, /restored: build\.gradle - already at original state/);
    assert.doesNotMatch(reset.stdout, /changed after init|failed:/);
    assert.equal(await fs.readFile(build, 'utf8'), originalBuild);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), false);
    assert.deepEqual(await snapshotProject(project), before);
  } finally {
    await fs.remove(parent);
  }
});
