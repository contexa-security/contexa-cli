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
const { backupFile } = require('../src/core/injector/common');
const {
  INSTALL_MODES,
  backupRoot,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareExternalFileChange,
  recordChange,
  recordExternalFileChange,
  rollbackInstallTransaction,
  saveManifest,
} = require('../src/core/manifest');

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

test('Phase 0 release and primary-command contract has one canonical source', () => {
  assert.equal(releaseManifest.cliVersion, packageJson.version);
  assert.equal(releaseManifest.releaseTag, 'v' + releaseManifest.cliVersion);
  assert.equal(releaseManifest.channel, 'snapshot');
  assert.match(releaseManifest.starter.version, /-SNAPSHOT$/);
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

test('interactive init defaults are value-based and resolve to the safe quick starter-only plan', () => {
  const initSource = fs.readFileSync(path.join(root, 'src/commands/init.js'), 'utf8');
  assert.doesNotMatch(initSource, /default:\s*\d+/);
  assert.match(initSource, /setupMode:\s*'quick'/);
  assert.match(initSource, /integrationMode:\s*explicitIntegrationMode \|\| 'merge'/);
  assert.match(initSource, /securityMode:\s*opts\.securityMode \|\| 'sandbox'/);
  assert.match(initSource, /infra:\s*opts\.distributed \? 'distributed' : 'skip'/);
  assert.match(initSource, /name: 'enableAiSecurity',[\s\S]*?default: false/);
  assert.match(initSource, /name: 'autoAnnotate',[\s\S]*?default: false/);
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
  assert.match(workflow, /prerelease: \$\{\{ contains\(github\.ref_name, '-'\) \}\}/);
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
    assert.equal(normal.metadata.mode, INSTALL_MODES.NORMAL);
    assert.equal(simulation.metadata.mode, INSTALL_MODES.SIMULATION);
    assert.equal(normal.metadata.canonicalProjectPath, path.resolve(project));
    assert.equal(simulation.metadata.canonicalProjectPath, path.resolve(project));
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

test('actual starter-only init is idempotent and reset preserves the host project byte-for-byte', async () => {
  const { project, build, yml, source, originalBuild, originalYml, originalSource } = await createSpringFixture('ctxa-phase0-command-');
  try {
    const init = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', project], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr + init.stdout);
    assert.match(init.stdout, /Planned changes/);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'COMMITTED');
    assert.equal(manifest.metadata.mode, INSTALL_MODES.NORMAL);
    assert.match(await fs.readFile(build, 'utf8'), /ai\.ctxa:spring-boot-starter-contexa:0\.1\.0-SNAPSHOT/);
    assert.ok(manifest.files.every(entry => entry.installationId === manifest.metadata.installationId));
    assert.deepEqual(await fs.readFile(yml), Buffer.from(originalYml, 'utf8'));
    assert.deepEqual(await fs.readFile(source), Buffer.from(originalSource, 'utf8'));
    const updatedYml = yaml.load(await fs.readFile(yml, 'utf8'));
    assert.equal(updatedYml.spring.security.user.name, 'host-user');
    assert.equal(updatedYml.spring.datasource.url, 'jdbc:postgresql://127.0.0.1:35433/host-owned');
    assert.equal(updatedYml.spring.ai.provider, 'host-owned');

    const firstBuild = await fs.readFile(build);
    const firstManifest = await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL));
    const repeatedInit = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', project], { encoding: 'utf8' });
    assert.equal(repeatedInit.status, 0, repeatedInit.stderr + repeatedInit.stdout);
    assert.deepEqual(await fs.readFile(build), firstBuild);
    assert.deepEqual(await fs.readFile(yml), Buffer.from(originalYml, 'utf8'));
    assert.deepEqual(await fs.readFile(source), Buffer.from(originalSource, 'utf8'));
    assert.deepEqual(await fs.readFile(manifestPath(project, INSTALL_MODES.NORMAL)), firstManifest);

    const reset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.equal(await fs.readFile(build, 'utf8'), originalBuild);
    assert.equal(await fs.readFile(yml, 'utf8'), originalYml);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), false);

    const repeated = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
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
    const first = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', cliOwned.project], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const firstManifestBytes = await fs.readFile(manifestPath(cliOwned.project, INSTALL_MODES.NORMAL));
    const firstManifest = await loadManifest(cliOwned.project, INSTALL_MODES.NORMAL);
    const cliEntry = firstManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(cliEntry.ownership, 'CLI_OWNED');
    assert.equal(cliEntry.cliApplied, true);
    assert.equal(cliEntry.lastCliChecksum, cliEntry.currentChecksum);

    await fs.appendFile(cliOwned.build, '// customer change after init\n', 'utf8');
    const customerBuild = await fs.readFile(cliOwned.build);
    const second = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', cliOwned.project], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr + second.stdout);
    assert.deepEqual(await fs.readFile(cliOwned.build), customerBuild);
    assert.deepEqual(await fs.readFile(manifestPath(cliOwned.project, INSTALL_MODES.NORMAL)), firstManifestBytes);

    const resetCliOwned = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', cliOwned.project], { encoding: 'utf8' });
    assert.notEqual(resetCliOwned.status, 0);
    assert.match(resetCliOwned.stdout, /Skipped user-modified file/);
    assert.deepEqual(await fs.readFile(cliOwned.build), customerBuild);

    const preinstalled = userOwned.originalBuild.replace(
      `implementation 'org.springframework.boot:spring-boot-starter-web'`,
      `implementation 'org.springframework.boot:spring-boot-starter-web'\n  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'`
    );
    await fs.writeFile(userOwned.build, preinstalled, 'utf8');
    const initUserOwned = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', userOwned.project], { encoding: 'utf8' });
    assert.equal(initUserOwned.status, 0, initUserOwned.stderr + initUserOwned.stdout);
    const userManifest = await loadManifest(userOwned.project, INSTALL_MODES.NORMAL);
    const userEntry = userManifest.files.find(entry => entry.relativePath === 'build.gradle');
    assert.equal(userEntry.ownership, 'USER_OWNED');
    assert.equal(userEntry.cliApplied, false);
    assert.equal(userEntry.lastCliChecksum, null);
    const resetUserOwned = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', userOwned.project], { encoding: 'utf8' });
    assert.equal(resetUserOwned.status, 0, resetUserOwned.stderr + resetUserOwned.stdout);
    assert.equal(await fs.readFile(userOwned.build, 'utf8'), preinstalled);
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
    assert.match(reset.stdout, /Already restored/);
    assert.doesNotMatch(reset.stdout, /Skipped user-modified file/);
    assert.equal(await fs.readFile(fixture.build, 'utf8'), fixture.originalBuild);
    assert.equal(await fs.pathExists(manifestPath(fixture.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('actual init failure rolls back host files and records ROLLED_BACK', async () => {
  const { project, build, yml, originalBuild } = await createSpringFixture('ctxa-phase0-command-failure-');
  const infra = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase2-command-failure-infra-'));
  const invalidYml = Buffer.from('spring: [unterminated\r\n', 'utf8');
  await fs.writeFile(yml, invalidYml);
  try {
    const args = [
      cliPath, 'init', '--yes', '--distributed', '--no-docker',
      '--dir', project, '--infra-dir', infra,
    ];
    const init = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.notEqual(init.status, 0, init.stdout);
    assert.doesNotMatch(init.stdout, /Contexa initialization completed successfully/i);
    assert.deepEqual(await fs.readFile(build), Buffer.from(originalBuild, 'utf8'));
    assert.deepEqual(await fs.readFile(yml), invalidYml);
    assert.equal(await fs.pathExists(path.join(infra, 'docker-compose.yml')), false);
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(manifest.transaction.status, 'ROLLED_BACK');
    assert.equal(manifest.files.length, 0);

    await fs.writeFile(yml, 'server:\n  port: 9080\n', 'utf8');
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
  const infraDir = path.join(os.tmpdir(), 'ctxa-phase0-sim-infra-' + path.basename(project));
  const geoSource = path.resolve(process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH);
  const childEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath),
    CONTEXA_GEOLITE2_SOURCE_PATH: geoSource,
  };
  try {
    const normalInit = spawnSync(process.execPath, [cliPath, 'init', '--yes', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(normalInit.status, 0, normalInit.stderr + normalInit.stdout);
    const normalBuild = await fs.readFile(build);
    const normalYml = await fs.readFile(yml);

    const simulationInit = spawnSync(process.execPath, [
      cliPath, 'init', '--simulate', '--no-docker', '--yes', '--dir', project, '--infra-dir', infraDir,
    ], { encoding: 'utf8', env: childEnv });
    assert.equal(simulationInit.status, 0, simulationInit.stderr + simulationInit.stdout);
    assert.match(simulationInit.stdout, /COPY: GeoLite2-City\.mmdb/);
    assert.match(simulationInit.stdout, /DOCKER: SKIP service start/);
    assert.match(simulationInit.stdout, /DELETE: NONE/);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), true);
    const normalManifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    const simulationManifest = await loadManifest(project, INSTALL_MODES.SIMULATION);
    assert.notEqual(normalManifest.metadata.installationId, simulationManifest.metadata.installationId);
    assert.ok(simulationManifest.files.every(entry => entry.installationId === simulationManifest.metadata.installationId));
    assert.equal(path.resolve(simulationManifest.metadata.infraDir), path.resolve(infraDir));
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
    const combinedStatus = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(combinedStatus.status, 0, combinedStatus.stderr + combinedStatus.stdout);
    assert.match(combinedStatus.stdout, /Normal installation: COMMITTED/);
    assert.match(combinedStatus.stdout, /Simulation installation: COMMITTED/);

    const simulationReset = spawnSync(process.execPath, [
      cliPath, 'reset', '--simulate', '--yes', '--dir', project, '--infra-dir', infraDir,
    ], { encoding: 'utf8', env: childEnv });
    assert.equal(simulationReset.status, 0, simulationReset.stderr + simulationReset.stdout);
    assert.deepEqual(await fs.readFile(build), normalBuild);
    assert.deepEqual(await fs.readFile(yml), normalYml);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), true);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), false);
    const afterSimulationResetStatus = spawnSync(process.execPath, [cliPath, 'status', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.match(afterSimulationResetStatus.stdout, /Normal installation: COMMITTED/);
    assert.match(afterSimulationResetStatus.stdout, /Simulation installation: not installed/);

    const normalReset = spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8', env: childEnv });
    assert.equal(normalReset.status, 0, normalReset.stderr + normalReset.stdout);
    assert.equal(await fs.readFile(build, 'utf8'), originalBuild);
    assert.equal(await fs.readFile(yml, 'utf8'), originalYml);
  } finally {
    await fs.remove(project);
    await fs.remove(infraDir);
  }
});
