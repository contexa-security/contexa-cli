'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const {
  INSTALL_MODES,
  MANIFEST_VERSION,
  RESOURCE_DIGEST_VERSION,
  backupRoot,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareExternalFileChange,
  recordChange,
  recordExternalFileChange,
  recordInstallMetadata,
  rollbackInstallTransaction,
  saveManifest,
  sha256FileSync,
} = require('../src/core/manifest');
const { inspectMode } = require('../src/core/installation-state');
const { assertSafeInfraDir, canonicalBoundaryPath } = require('../src/core/project');
const {
  buildDockerResourceContract,
  inverseTextMerge,
  performOwnedDockerCleanup,
  restoreProjectFiles,
  dependencyProvenanceMatches,
  yamlManagedPathMerge,
} = require('../src/core/reset-service');
const { injectDistributedDeps } = require('../src/core/injector/build');

test('canonical boundary identity uses native realpath and preserves missing suffixes', async () => {
  const project = await tempProject();
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    const nativeProject = path.resolve(realpath(project));
    assert.equal(await canonicalBoundaryPath(project), nativeProject);
    assert.equal(await canonicalBoundaryPath(path.join(project, 'future', 'child')),
      path.join(nativeProject, 'future', 'child'));
  } finally {
    await fs.remove(project);
  }
});

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-reset-'));
}

test('canonical dependency provenance rejects version changes and decoy groups', () => {
  const expected = [{
    group: 'ai.ctxa',
    artifact: 'spring-boot-starter-contexa',
    configuration: 'implementation',
    version: '0.1.0-SNAPSHOT',
    versionSource: 'literal',
    targetModule: '.',
  }];
  assert.equal(dependencyProvenanceMatches(
    'build.gradle',
    "dependencies { implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT' }\n",
    expected), true);
  assert.equal(dependencyProvenanceMatches(
    'build.gradle',
    "dependencies { implementation 'ai.ctxa:spring-boot-starter-contexa:customer' }\n",
    expected), false);
  assert.equal(dependencyProvenanceMatches(
    'build.gradle',
    "dependencies { implementation 'decoy.group:spring-boot-starter-contexa:0.1.0-SNAPSHOT' }\n",
    expected), false);
});

test('reset keeps the build file and ownership metadata when canonical provenance changed', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    await fs.writeFile(build, "dependencies {\n}\n");
    const transactionId = await beginInstallTransaction(project, {
      projectName: 'provenance-conflict',
      infra: 'skip',
    }, INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
    const addedDependencies = [];
    const { injectGradleDep } = require('../src/core/injector/build');
    assert.equal(await injectGradleDep(build, {
      mode: INSTALL_MODES.NORMAL,
      targetModule: '.',
      addedDependencies,
    }), true);
    await recordChange(project, build, { kind: 'build-file', generated: false });
    await recordInstallMetadata(project, { dependencyProvenance: addedDependencies });
    await commitInstallTransaction(project, transactionId);

    const changed = (await fs.readFile(build, 'utf8'))
      .replace('0.1.0-SNAPSHOT', 'customer-version');
    await fs.writeFile(build, changed, 'utf8');
    const restored = await restoreProjectFiles(project);
    assert.equal(restored.audit.conflict.length, 1);
    assert.equal(await fs.readFile(build, 'utf8'), changed);
    assert.equal((await loadManifest(project)).metadata.dependencyProvenance.length, 1);
  } finally {
    await fs.remove(project);
  }
});

const cliPath = path.resolve(__dirname, '../src/index.js');

function provenLegacyMetadata(project, extra = {}) {
  return {
    mode: INSTALL_MODES.NORMAL,
    canonicalProjectPath: path.resolve(project),
    installationId: 'phase3',
    cliVersion: '0.1.0-SNAPSHOT',
    starterVersion: '0.1.0-SNAPSHOT',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...extra,
  };
}

test('manifest v4 records distinct deterministic resource digests for normal and simulation', async () => {
  const project = await tempProject();
  try {
    const normalInfra = path.join(project, 'contexa', 'normal-infra');
    const simulationInfra = path.join(project, 'contexa', 'simulation-infra');
    await saveManifest(project, {
      metadata: {
        mode: INSTALL_MODES.NORMAL,
        infraDir: normalInfra,
        dockerResources: { projectName: 'contexa', resources: [] },
      },
      files: [],
    }, INSTALL_MODES.NORMAL);
    await saveManifest(project, {
      metadata: {
        mode: INSTALL_MODES.SIMULATION,
        infraDir: simulationInfra,
        dockerResources: { projectName: 'ctxa-sim', resources: [] },
      },
      files: [],
    }, INSTALL_MODES.SIMULATION);

    const normal = await loadManifest(project, INSTALL_MODES.NORMAL);
    const simulation = await loadManifest(project, INSTALL_MODES.SIMULATION);
    assert.equal(normal.version, MANIFEST_VERSION);
    assert.equal(simulation.version, MANIFEST_VERSION);
    assert.equal(normal.metadata.resourceDigestVersion, RESOURCE_DIGEST_VERSION);
    assert.equal(simulation.metadata.resourceDigestVersion, RESOURCE_DIGEST_VERSION);
    assert.match(normal.metadata.resourceDigest, /^[a-f0-9]{64}$/);
    assert.match(simulation.metadata.resourceDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(normal.metadata.installationId, simulation.metadata.installationId);
    assert.notEqual(normal.metadata.resourceDigest, simulation.metadata.resourceDigest);

    const stableDigest = normal.metadata.resourceDigest;
    await saveManifest(project, normal, INSTALL_MODES.NORMAL);
    assert.equal((await loadManifest(project, INSTALL_MODES.NORMAL)).metadata.resourceDigest, stableDigest);
  } finally {
    await fs.remove(project);
  }
});

test('manifest digest tampering is rejected without rewriting the manifest and status names the conflict', async () => {
  const project = await tempProject();
  try {
    await saveManifest(project, {
      metadata: { mode: INSTALL_MODES.NORMAL, infraDir: path.join(project, 'contexa', 'infra') },
      files: [],
    }, INSTALL_MODES.NORMAL);
    const target = manifestPath(project, INSTALL_MODES.NORMAL);
    const tampered = await fs.readJson(target);
    tampered.metadata.infraDir = path.join(project, 'changed-without-digest-update');
    await fs.writeJson(target, tampered, { spaces: 2 });
    const exactTamperedBytes = await fs.readFile(target);

    await assert.rejects(loadManifest(project, INSTALL_MODES.NORMAL), /resource digest mismatch/);
    assert.deepEqual(await fs.readFile(target), exactTamperedBytes);
    const status = await inspectMode(project, INSTALL_MODES.NORMAL);
    assert.equal(status.status, 'CONFLICT');
    assert.equal(status.conflictType, 'MANIFEST_DIGEST_CONFLICT');
  } finally {
    await fs.remove(project);
  }
});

test('only ownership-proven v3 manifests migrate to v4 on the next normal save', async () => {
  const project = await tempProject();
  try {
    const target = manifestPath(project, INSTALL_MODES.NORMAL);
    await fs.ensureDir(path.dirname(target));
    const legacy = {
      version: 3,
      metadata: {
        mode: INSTALL_MODES.NORMAL,
        installationId: 'legacy-proven',
        canonicalProjectPath: path.resolve(project),
        cliVersion: '0.1.0-SNAPSHOT',
        starterVersion: '0.1.0-SNAPSHOT',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      files: [],
      transaction: null,
    };
    await fs.writeJson(target, legacy, { spaces: 2 });
    const loadedLegacy = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(loadedLegacy.version, 3);
    await saveManifest(project, loadedLegacy, INSTALL_MODES.NORMAL);
    const migrated = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(migrated.version, MANIFEST_VERSION);
    assert.equal(migrated.metadata.installationId, legacy.metadata.installationId);
    assert.match(migrated.metadata.resourceDigest, /^[a-f0-9]{64}$/);

    const unproven = {
      ...legacy,
      files: [{
        relativePath: 'host.txt',
        mode: INSTALL_MODES.NORMAL,
        installationId: legacy.metadata.installationId,
      }],
    };
    await fs.writeJson(target, unproven, { spaces: 2 });
    const unprovenBytes = await fs.readFile(target);
    await assert.rejects(loadManifest(project, INSTALL_MODES.NORMAL), /automatic migration is forbidden/);
    assert.deepEqual(await fs.readFile(target), unprovenBytes);
  } finally {
    await fs.remove(project);
  }
});

test('infra boundary rejects parent traversal, outside roots, symlink escape, and foreign volume before writes', async t => {
  const project = await tempProject();
  const outside = await tempProject();
  try {
    const allowed = path.join(project, 'contexa', 'infra');
    assert.equal(await assertSafeInfraDir(project, allowed), await canonicalBoundaryPath(allowed));

    const traversalTarget = path.join(project, 'escaped');
    await assert.rejects(
      assertSafeInfraDir(project, traversalTarget, 'contexa/../escaped'),
      /parent traversal/);
    await assert.rejects(assertSafeInfraDir(project, outside), /outside Contexa-owned roots/);
    assert.equal(await fs.pathExists(path.join(traversalTarget, 'docker-compose.yml')), false);
    assert.equal(await fs.pathExists(path.join(outside, 'docker-compose.yml')), false);

    if (process.platform === 'win32') {
      const currentDrive = path.parse(project).root.slice(0, 1).toUpperCase();
      const foreignDrive = currentDrive === 'Z' ? 'Y' : 'Z';
      await assert.rejects(
        assertSafeInfraDir(project, `${foreignDrive}:\\contexa-infra`),
        /changes drive or UNC root/);
      await assert.rejects(
        assertSafeInfraDir(project, '\\\\ctxa-invalid-host\\share\\infra'),
        /changes drive or UNC root/);
    }

    const linkPath = path.join(project, 'infra-link');
    try {
      await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(assertSafeInfraDir(project, linkPath), /outside Contexa-owned roots/);
      assert.equal(await fs.pathExists(path.join(outside, 'docker-compose.yml')), false);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') t.diagnostic('symlink fixture unavailable');
      else throw error;
    }
  } finally {
    await fs.remove(project);
    await fs.remove(outside);
  }
});

function labelsForResource(contract, type, name, base) {
  if (type === 'container') {
    const service = ['postgres', 'ollama', 'redis', 'zookeeper', 'kafka']
      .find(candidate => name === `${contract.projectName}-${candidate}`);
    return { ...base, 'com.docker.compose.service': service };
  }
  if (type === 'volume') {
    const volume = ['pgdata', 'ollama-data', 'redis-data', 'zookeeper-data', 'zookeeper-log', 'kafka-data']
      .find(candidate => name === `${contract.projectName}_${candidate}`);
    return { ...base, 'com.docker.compose.volume': volume };
  }
  return { ...base, 'com.docker.compose.network': 'default' };
}

test('3-way text reset removes only the CLI dependency and preserves later user changes', () => {
  const base = "dependencies {\n    implementation 'org.example:host:1.0'\n}\n";
  const applied = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'\n    implementation 'org.example:host:1.0'\n}\n";
  const current = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'\n    implementation 'org.example:host:1.0'\n    implementation 'org.example:user-added:2.0'\n}\n";
  assert.equal(inverseTextMerge(base, applied, current),
    "dependencies {\n    implementation 'org.example:host:1.0'\n    implementation 'org.example:user-added:2.0'\n}\n");
});

test('3-way text reset refuses a user edit to the CLI-owned line', () => {
  const base = "dependencies {\n}\n";
  const applied = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'\n}\n";
  const current = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:custom'\n}\n";
  assert.equal(inverseTextMerge(base, applied, current), null);
});

test('managed YAML reset preserves a user key added inside a generated overlay', () => {
  const applied = yaml.dump({ contexa: { security: { zerotrust: { mode: 'SHADOW' } } } });
  const current = yaml.dump({ contexa: { security: { zerotrust: { mode: 'SHADOW' } }, customer: { retained: true } } });
  const merged = yamlManagedPathMerge('', applied, current, ['security.zerotrust.mode'], true);
  assert.deepEqual(yaml.load(merged), { contexa: { customer: { retained: true } } });
});

test('restoreProjectFiles uses original, applied, and current states and keeps the manifest retry-safe', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    const base = "dependencies {\n    implementation 'org.example:host:1.0'\n}\n";
    const applied = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'\n    implementation 'org.example:host:1.0'\n}\n";
    await fs.writeFile(build, base);
    const transactionId = await beginInstallTransaction(project,
      { projectName: 'phase3', infra: 'skip' }, INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, applied);
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    await fs.writeFile(build, applied.replace("}\n", "    implementation 'org.example:user-added:2.0'\n}\n"));

    const result = await restoreProjectFiles(project, INSTALL_MODES.NORMAL);
    const restored = await fs.readFile(build, 'utf8');
    assert.equal(restored.includes('spring-boot-starter-contexa'), false);
    assert.equal(restored.includes('org.example:user-added:2.0'), true);
    assert.equal(result.audit.preserved.length, 1);
    assert.equal(result.manifest.files.length, 0);
    assert.equal(await fs.pathExists(manifestPath(project)), true,
      'command finalization, not file restore, owns manifest deletion');
  } finally {
    await fs.remove(project);
  }
});

test('failed re-init restores the previous CLI-applied snapshot separately from later user changes', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    const base = "dependencies {\n}\n";
    const firstApplied = "dependencies {\n    implementation 'ai.ctxa:first'\n}\n";
    const userCurrent = "dependencies {\n    implementation 'ai.ctxa:first'\n}\n// host:user-added\n";
    const secondApplied = "dependencies {\n    implementation 'ai.ctxa:second'\n}\n// host:user-added\n";
    await fs.writeFile(build, base);

    let transactionId = await beginInstallTransaction(project,
      { canonicalProjectPath: project, projectName: 'phase3', infra: 'skip' },
      INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, firstApplied);
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    await fs.writeFile(build, userCurrent);

    transactionId = await beginInstallTransaction(project,
      { canonicalProjectPath: project, projectName: 'phase3', infra: 'skip' },
      INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, secondApplied);
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    const rollback = await rollbackInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);

    assert.equal(rollback.rolledBack, true);
    assert.equal(await fs.readFile(build, 'utf8'), userCurrent);
    const restoredManifest = await loadManifest(project);
    const appliedSnapshot = path.join(
      path.dirname(manifestPath(project)), 'bak', restoredManifest.files[0].appliedRelativePath);
    assert.equal(await fs.readFile(appliedSnapshot, 'utf8'), firstApplied);

    const reset = await restoreProjectFiles(project, INSTALL_MODES.NORMAL);
    assert.equal(reset.audit.conflict.length, 0);
    assert.equal((await fs.readFile(build, 'utf8')).includes('ai.ctxa:first'), false);
    assert.equal((await fs.readFile(build, 'utf8')).includes('host:user-added'), true);
  } finally {
    await fs.remove(project);
  }
});

test('repeated external transactions roll back to the immediately previous compose bytes', async () => {
  const project = await tempProject();
  const infraDir = await tempProject();
  const composePath = path.join(infraDir, 'docker-compose.yml');
  try {
    await fs.writeFile(composePath, 'version: one\n');
    const first = await beginInstallTransaction(project, { infraDir }, INSTALL_MODES.NORMAL, []);
    await prepareExternalFileChange(project, first, composePath, infraDir, INSTALL_MODES.NORMAL);
    await fs.writeFile(composePath, 'version: two\n');
    await recordExternalFileChange(project, first, composePath, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, first, INSTALL_MODES.NORMAL);
    assert.equal((await loadManifest(project)).transaction.externalFiles, undefined);

    const second = await beginInstallTransaction(project, { infraDir }, INSTALL_MODES.NORMAL, []);
    await prepareExternalFileChange(project, second, composePath, infraDir, INSTALL_MODES.NORMAL);
    await fs.writeFile(composePath, 'version: three\n');
    await recordExternalFileChange(project, second, composePath, INSTALL_MODES.NORMAL);
    const rollback = await rollbackInstallTransaction(project, second, INSTALL_MODES.NORMAL);
    assert.equal(rollback.rolledBack, true);
    assert.equal(await fs.readFile(composePath, 'utf8'), 'version: two\n');
  } finally {
    await fs.remove(project);
    await fs.remove(infraDir);
  }
});

test('repeated init preserves original CLI-generated file ownership', async () => {
  const project = await tempProject();
  const generated = path.join(project, 'generated.yml');
  try {
    const first = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL,
            [{ filePath: generated, generated: true }]);
    await fs.writeFile(generated, 'version: one\n');
    await recordChange(project, generated, { generated: true }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, first, INSTALL_MODES.NORMAL);

    const second = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL,
            [{ filePath: generated, generated: false }]);
    await fs.writeFile(generated, 'version: two\n');
    await recordChange(project, generated, { generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, second, INSTALL_MODES.NORMAL);

    const entry = (await loadManifest(project)).files.find(file => file.relativePath === 'generated.yml');
    assert.equal(entry.generated, true);
    assert.equal(entry.originalChecksum, null);
  } finally {
    await fs.remove(project);
  }
});

test('loadManifest rejects invalid JSON, unsupported version, path escape, directory entry, and backup mismatch', async (t) => {
  const cases = [
    ['invalid JSON', async project => '{invalid'],
    ['unsupported version', async project => JSON.stringify({ version: 999, metadata: { mode: 'normal' }, files: [] })],
    ['path escape', async project => JSON.stringify({
      version: 3,
      metadata: provenLegacyMetadata(project),
      files: [{
        relativePath: '../outside.txt', installationId: 'phase3', mode: 'normal', ownership: 'CLI_OWNED',
      }],
    })],
    ['directory entry', async project => {
      await fs.ensureDir(path.join(project, 'owned-dir'));
      return JSON.stringify({
        version: 3,
        metadata: provenLegacyMetadata(project),
        files: [{
          relativePath: 'owned-dir', installationId: 'phase3', mode: 'normal',
          ownership: 'CLI_OWNED', generated: true,
        }],
      });
    }],
    ['backup mismatch', async project => {
      await fs.writeFile(path.join(project, 'host.txt'), 'cli-applied');
      const backup = path.join(project, 'contexa', 'bak', 'host.txt');
      await fs.ensureDir(path.dirname(backup));
      await fs.writeFile(backup, 'original');
      return JSON.stringify({
        version: 3,
        metadata: provenLegacyMetadata(project),
        files: [{
          relativePath: 'host.txt', installationId: 'phase3', mode: 'normal', generated: false,
          ownership: 'CLI_OWNED', cliApplied: true, originalChecksum: 'present', backupChecksum: 'wrong',
        }],
      });
    }],
    ['applied snapshot alias', async project => {
      await fs.writeFile(path.join(project, 'host.txt'), 'cli-applied');
      const backup = path.join(project, 'contexa', 'bak', 'host.txt');
      await fs.ensureDir(path.dirname(backup));
      await fs.writeFile(backup, 'original');
      return JSON.stringify({
        version: 3,
        metadata: provenLegacyMetadata(project),
        files: [{
          relativePath: 'host.txt', installationId: 'phase3', mode: 'normal', generated: false,
          ownership: 'CLI_OWNED', cliApplied: true, originalChecksum: sha256FileSync(backup),
          backupChecksum: sha256FileSync(backup), appliedRelativePath: 'host.txt',
        }],
      });
    }],
    ['external transaction path escape', async project => JSON.stringify({
      version: 3,
      metadata: provenLegacyMetadata(project, { infraDir: path.join(project, 'owned-infra') }),
      files: [],
      transaction: {
        externalFiles: [{
          rootPath: path.join(project, 'owned-infra'),
          filePath: path.join(project, 'outside.txt'),
          backupRelativePath: '__external__/outside.bak',
        }],
      },
    })],
  ];
  for (const [name, contentFactory] of cases) {
    await t.test(name, async () => {
      const project = await tempProject();
      try {
        const target = manifestPath(project);
        await fs.ensureDir(path.dirname(target));
        await fs.writeFile(target, await contentFactory(project));
        await assert.rejects(loadManifest(project), error => {
          assert.match(error.message, /Manifest was kept unchanged/);
          assert.match(error.message, /Safe backups/);
          return true;
        });
        assert.equal(await fs.pathExists(target), true);
      } finally {
        await fs.remove(project);
      }
    });
  }
});

test('loadManifest rejects a symlink escape without changing the manifest', async t => {
  const project = await tempProject();
  const outside = await tempProject();
  try {
    await fs.writeFile(path.join(outside, 'customer.txt'), 'customer');
    const linkPath = path.join(project, 'linked');
    try {
      await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlink creation is not permitted');
      throw error;
    }
    const target = manifestPath(project);
    await fs.ensureDir(path.dirname(target));
    await fs.writeJson(target, {
      version: 3,
      metadata: provenLegacyMetadata(project),
      files: [{
        relativePath: 'linked/customer.txt', installationId: 'phase3', mode: 'normal',
        ownership: 'CLI_OWNED', generated: true,
      }],
    });
    await assert.rejects(loadManifest(project), /symbolic link/);
    assert.equal(await fs.pathExists(path.join(outside, 'customer.txt')), true);
    assert.equal(await fs.pathExists(target), true);
  } finally {
    await fs.remove(project);
    await fs.remove(outside);
  }
});

test('saveManifest redacts secret-bearing fields and error text', async () => {
  const project = await tempProject();
  try {
    await saveManifest(project, {
      metadata: { mode: 'normal', password: 'do-not-store', note: 'token=raw-token' },
      files: [],
      transaction: null,
    });
    const raw = await fs.readFile(manifestPath(project), 'utf8');
    assert.equal(raw.includes('do-not-store'), false);
    assert.equal(raw.includes('raw-token'), false);
    assert.match(raw, /\[REDACTED\]/);
  } finally {
    await fs.remove(project);
  }
});

test('Docker cleanup failures preserve compose management data and exact owned resources', async t => {
  const cases = [
    ['CLI unavailable', adapter => { adapter.isCliInstalled = () => false; }, /Docker CLI is unavailable/],
    ['daemon unavailable', adapter => { adapter.isDaemonRunning = () => false; }, /Docker daemon is unavailable/],
    ['ownership mismatch', (adapter, state) => {
      const first = state.keys().next().value;
      state.get(first)['io.ctxa.installation-id'] = 'different-installation';
    }, /ownership mismatch/],
    ['compose service label mismatch', (adapter, state) => {
      const first = [...state.keys()].find(key => key.startsWith('container:'));
      state.get(first)['com.docker.compose.service'] = 'different-service';
    }, /ownership mismatch/],
    ['compose down failure', adapter => {
      adapter.composeDown = async () => { throw new Error('injected compose down failure'); };
    }, /injected compose down failure/],
    ['partial remove failure', adapter => {
      adapter.composeDown = async () => {
        for (const key of [...adapter.state.keys()]) {
          if (key.startsWith('container:')) adapter.state.delete(key);
        }
      };
    }, /left owned resources/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const infraDir = await tempProject();
      try {
        const composePath = path.join(infraDir, 'docker-compose.yml');
        await fs.writeFile(composePath, 'services: {}\n');
        const contract = buildDockerResourceContract('phase3', {
          infra: 'standalone', mode: 'normal', installationId: 'phase3-installation',
        });
        const labels = {
          'io.ctxa.owner': 'contexa-cli',
          'io.ctxa.mode': 'normal',
          'io.ctxa.installation-id': 'phase3-installation',
          'com.docker.compose.project': 'phase3',
        };
        const state = new Map([
          ...contract.containers.map(value => [
            `container:${value}`, labelsForResource(contract, 'container', value, labels)]),
          ...contract.volumes.map(value => [
            `volume:${value}`, labelsForResource(contract, 'volume', value, labels)]),
          ...contract.networks.map(value => [
            `network:${value}`, labelsForResource(contract, 'network', value, labels)]),
        ]);
        const adapter = {
          state,
          isCliInstalled: () => true,
          isDaemonRunning: () => true,
          inspectLabels: (type, resourceName) => state.get(`${type}:${resourceName}`) || null,
          composeDown: async () => { state.clear(); },
        };
        mutate(adapter, state);
        await assert.rejects(performOwnedDockerCleanup({
          contract,
          mode: 'normal',
          installationId: 'phase3-installation',
          projectName: 'phase3',
          infraDir,
          composeChecksum: sha256FileSync(composePath),
          env: {},
        }, adapter), expected);
        assert.equal(await fs.pathExists(composePath), true, 'compose must remain for retry');
      } finally {
        await fs.remove(infraDir);
      }
    });
  }
});

test('Docker cleanup removes only exact contract resources after labels and absence are verified', async () => {
  const infraDir = await tempProject();
  try {
    const composePath = path.join(infraDir, 'docker-compose.yml');
    await fs.writeFile(composePath, 'services: {}\n');
    const contract = buildDockerResourceContract('phase3', {
      infra: 'distributed', includeOllama: true, mode: 'normal', installationId: 'phase3-installation',
    });
    const labels = {
      'io.ctxa.owner': 'contexa-cli',
      'io.ctxa.mode': 'normal',
      'io.ctxa.installation-id': 'phase3-installation',
      'com.docker.compose.project': 'phase3',
    };
    const state = new Map([
      ...contract.containers.map(value => [
        `container:${value}`, labelsForResource(contract, 'container', value, labels)]),
      ...contract.volumes.map(value => [
        `volume:${value}`, labelsForResource(contract, 'volume', value, labels)]),
      ...contract.networks.map(value => [
        `network:${value}`, labelsForResource(contract, 'network', value, labels)]),
      ['container:contexa-postgres', {
        ...labels,
        'io.ctxa.installation-id': 'unrelated-installation',
        'com.docker.compose.project': 'unrelated-project',
      }],
    ]);
    const audit = await performOwnedDockerCleanup({
      contract,
      mode: 'normal',
      installationId: 'phase3-installation',
      projectName: 'phase3',
      infraDir,
      composeChecksum: sha256FileSync(composePath),
      env: {},
    }, {
      isCliInstalled: () => true,
      isDaemonRunning: () => true,
      inspectLabels: (type, resourceName) => state.get(`${type}:${resourceName}`) || null,
      composeDown: async () => {
        for (const resourceName of contract.containers) state.delete(`container:${resourceName}`);
        for (const resourceName of contract.volumes) state.delete(`volume:${resourceName}`);
        for (const resourceName of contract.networks) state.delete(`network:${resourceName}`);
      },
    });
    assert.equal(state.size, 1);
    assert.equal(state.has('container:contexa-postgres'), true,
      'an unrecorded conventional name must never be removed');
    assert.equal(audit.removed.length, contract.containers.length + contract.volumes.length + contract.networks.length + 1);
    assert.equal(await fs.pathExists(composePath), false);
    assert.equal(await fs.pathExists(infraDir), false);
  } finally {
    await fs.remove(infraDir);
  }
});

test('reset rejects an arbitrary --infra-dir before Docker or directory changes', async () => {
  const project = await tempProject();
  const ownedInfra = await tempProject();
  const arbitrary = await tempProject();
  try {
    const sentinel = path.join(arbitrary, 'customer.txt');
    await fs.writeFile(sentinel, 'customer');
    await saveManifest(project, {
      metadata: {
        mode: 'normal', canonicalProjectPath: project, installationId: 'phase3-installation',
        projectName: 'phase3', infra: 'standalone', infraDir: ownedInfra,
        dockerResources: buildDockerResourceContract('phase3', {
          infra: 'standalone', mode: 'normal', installationId: 'phase3-installation',
        }),
      },
      files: [],
      transaction: null,
    });
    const result = spawnSync(process.execPath, [
      cliPath, 'reset', '--yes', '--infra', '--dir', project, '--infra-dir', arbitrary,
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--infra-dir does not match/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'customer');
    assert.equal(await fs.pathExists(manifestPath(project)), true);
  } finally {
    await fs.remove(project);
    await fs.remove(ownedInfra);
    await fs.remove(arbitrary);
  }
});

test('normal reset leaves the simulation ownership manifest byte-for-byte unchanged', async () => {
  const project = await tempProject();
  try {
    const common = { canonicalProjectPath: project, projectName: 'phase3', infra: 'skip' };
    await saveManifest(project, {
      metadata: { ...common, mode: 'normal', installationId: 'normal-installation' },
      files: [],
      transaction: null,
    }, INSTALL_MODES.NORMAL);
    await saveManifest(project, {
      metadata: { ...common, mode: 'simulation', installationId: 'simulation-installation' },
      files: [],
      transaction: null,
    }, INSTALL_MODES.SIMULATION);
    const simulationPath = manifestPath(project, INSTALL_MODES.SIMULATION);
    const before = await fs.readFile(simulationPath);

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), false);
    assert.deepEqual(await fs.readFile(simulationPath), before);
  } finally {
    await fs.remove(project);
  }
});

test('simulation reset leaves the normal ownership manifest byte-for-byte unchanged', async () => {
  const project = await tempProject();
  try {
    const common = { canonicalProjectPath: project, projectName: 'phase3', infra: 'skip' };
    await saveManifest(project, {
      metadata: { ...common, mode: 'normal', installationId: 'normal-installation' },
      files: [],
      transaction: null,
    }, INSTALL_MODES.NORMAL);
    await saveManifest(project, {
      metadata: {
        ...common,
        mode: 'simulation',
        installationId: 'simulation-installation',
        dockerLifecycleManaged: false,
      },
      files: [],
      transaction: null,
    }, INSTALL_MODES.SIMULATION);
    const normalPath = manifestPath(project, INSTALL_MODES.NORMAL);
    const before = await fs.readFile(normalPath);

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--simulate', '--dir', project], { encoding: 'utf8' });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.SIMULATION)), false);
    assert.deepEqual(await fs.readFile(normalPath), before);
  } finally {
    await fs.remove(project);
  }
});

test('manifestless reset emits an explicit machine-readable no-op audit without changing user files', async () => {
  const project = await tempProject();
  try {
    const userFile = path.join(project, 'customer.txt');
    await fs.writeFile(userFile, 'customer-owned\n');
    const before = await fs.readFile(userFile);

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    const marker = output.split(/\r?\n/)
      .find(line => line.startsWith('CONTEXA_RESET_RESULT '));
    const summary = JSON.parse(marker.slice('CONTEXA_RESET_RESULT '.length));

    assert.equal(result.status, 0, output);
    assert.equal(summary.result, 'NO_OWNED_INSTALLATION');
    assert.equal(summary.changed, 0);
    assert.equal(summary.deleted, 0);
    assert.equal(summary.dockerCalls, 0);
    assert.deepEqual(summary.counts,
      { removed: 0, restored: 0, preserved: 0, conflict: 0, failed: 0 });
    assert.deepEqual(await fs.readFile(userFile), before);
  } finally {
    await fs.remove(project);
  }
});

test('corrupt manifest is preserved and classified as a machine-readable conflict', async () => {
  const project = await tempProject();
  try {
    const target = manifestPath(project);
    await fs.ensureDir(path.dirname(target));
    const corrupt = Buffer.from('{invalid-manifest');
    await fs.writeFile(target, corrupt);

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    const marker = output.split(/\r?\n/)
      .find(line => line.startsWith('CONTEXA_RESET_RESULT '));
    const summary = JSON.parse(marker.slice('CONTEXA_RESET_RESULT '.length));

    assert.notEqual(result.status, 0);
    assert.equal(summary.result, 'CONFLICT');
    assert.equal(summary.changed, 0);
    assert.equal(summary.dockerCalls, 0);
    assert.deepEqual(await fs.readFile(target), corrupt);
  } finally {
    await fs.remove(project);
  }
});

test('infra guard refuses filesystem and ownership roots themselves', async () => {
  const project = await tempProject();
  try {
    await assert.rejects(assertSafeInfraDir(project, project), /dedicated child directory/);
    await assert.rejects(
      assertSafeInfraDir(project, path.parse(project).root),
      /dedicated child directory|outside Contexa-owned roots/);
  } finally {
    await fs.remove(project);
  }
});

test('manifest project identity accepts Windows path case variants only for the same real path',
  { skip: process.platform !== 'win32' }, async () => {
    const project = await tempProject();
    try {
      await saveManifest(project, {
        metadata: { mode: 'normal', projectName: 'phase3', infra: 'skip' },
        files: [],
        transaction: null,
      });
      const loaded = await loadManifest(project.toUpperCase());
      assert.equal(loaded.metadata.mode, 'normal');
    } finally {
      await fs.remove(project);
    }
  });

test('reset command keeps current bytes and ownership data when 3-way restore conflicts', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    const base = "dependencies {\n}\n";
    const applied = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0-SNAPSHOT'\n}\n";
    const current = "dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:customer-version'\n}\n";
    await fs.writeFile(build, base);
    const transactionId = await beginInstallTransaction(project, {
      canonicalProjectPath: project, projectName: 'phase3', infra: 'skip', installationId: 'phase3-installation',
    }, INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, applied);
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    await fs.writeFile(build, current);

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--code', '--dir', project], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.equal(await fs.readFile(build, 'utf8'), current);
    assert.equal(await fs.pathExists(manifestPath(project)), true);
    assert.match(output, /conflict/);
    assert.doesNotMatch(output, /successfully completed/);
  } finally {
    await fs.remove(project);
  }
});

test('reset command retains compose and manifest on deterministic infrastructure failure', async () => {
  const project = await tempProject();
  const infraDir = path.join(project, 'contexa-owned-infra');
  try {
    await fs.ensureDir(infraDir);
    const composePath = path.join(infraDir, 'docker-compose.yml');
    await fs.writeFile(composePath, 'services: {}\n');
    await saveManifest(project, {
      metadata: {
        mode: 'normal', canonicalProjectPath: project, installationId: 'phase3-installation',
        projectName: 'phase3', infra: 'standalone', infraDir,
        composeChecksum: sha256FileSync(composePath),
      },
      files: [],
      transaction: null,
    });
    const manifestBeforeReset = await fs.readFile(manifestPath(project));

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--infra', '--dir', project, '--infra-dir', infraDir], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0);
    assert.equal(await fs.pathExists(composePath), true);
    assert.equal(await fs.pathExists(manifestPath(project)), true);
    assert.match(output, /failed|issues/i);
    assert.doesNotMatch(output, /successfully completed/);
    const retained = await loadManifest(project);
    assert.equal(retained.metadata.infra, 'standalone');
    assert.equal(retained.metadata.lastReset, undefined);
    assert.deepEqual(await fs.readFile(manifestPath(project)), manifestBeforeReset);
  } finally {
    await fs.remove(project);
  }
});

for (const buildCase of [
  {
    name: 'Gradle',
    file: 'build.gradle',
    source: ['dependencies {', "  implementation 'org.springframework.boot:spring-boot-starter-web'", '}', ''].join('\n'),
  },
  {
    name: 'Maven',
    file: 'pom.xml',
    source: '<project><dependencies><dependency><groupId>org.springframework.boot</groupId>'
      + '<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n',
  },
]) {
  test(`distributed ${buildCase.name} mutation is backed up before write and reset restores exact bytes`, async () => {
    const project = await tempProject();
    try {
      const build = path.join(project, buildCase.file);
      const original = Buffer.from(buildCase.source);
      await fs.writeFile(build, original);
      const transactionId = await beginInstallTransaction(project,
        { canonicalProjectPath: project, projectName: 'phase7', infra: 'skip' },
        INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
      const transactionManifest = await loadManifest(project);
      const transactionEntry = transactionManifest.transaction.files[0];
      assert.equal(transactionEntry.startChecksum, sha256FileSync(build));
      assert.equal(await fs.pathExists(path.join(backupRoot(project), buildCase.file)), true);

      assert.equal(await injectDistributedDeps(build, { mode: INSTALL_MODES.NORMAL }), true);
      await recordChange(project, build,
        { kind: 'build-file', generated: false, reason: 'Explicit distributed infrastructure dependencies' },
        INSTALL_MODES.NORMAL);
      await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);

      const committed = await loadManifest(project);
      const entry = committed.files.find(item => item.relativePath === buildCase.file);
      assert.match(entry.originalChecksum, /^[a-f0-9]{64}$/);
      assert.match(entry.backupChecksum, /^[a-f0-9]{64}$/);
      assert.equal(entry.originalChecksum, entry.backupChecksum);
      const injected = await fs.readFile(build, 'utf8');
      assert.match(injected, /spring-kafka/);
      assert.match(injected, /redisson/);

      const restored = await restoreProjectFiles(project, INSTALL_MODES.NORMAL);
      assert.equal(restored.audit.conflict.length, 0);
      assert.deepEqual(await fs.readFile(build), original);
      assert.equal(restored.manifest.files.length, 0);
    } finally {
      await fs.remove(project);
    }
  });
}

test('reset fails closed and keeps the manifest when a required build backup is missing', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    const original = "dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n}\n";
    await fs.writeFile(build, original);
    const transactionId = await beginInstallTransaction(project,
      { canonicalProjectPath: project, projectName: 'phase7', infra: 'skip' },
      INSTALL_MODES.NORMAL, [{ filePath: build, kind: 'build-file', generated: false }]);
    await injectDistributedDeps(build, { mode: INSTALL_MODES.NORMAL });
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, transactionId, INSTALL_MODES.NORMAL);
    const injected = await fs.readFile(build);
    await fs.remove(path.join(backupRoot(project), 'build.gradle'));

    const result = spawnSync(process.execPath,
      [cliPath, 'reset', '--yes', '--dir', project], { encoding: 'utf8' });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.equal(await fs.pathExists(manifestPath(project)), true);
    assert.deepEqual(await fs.readFile(build), injected);
    assert.match(output, /MANIFEST_OWNERSHIP_CONFLICT/);
    assert.doesNotMatch(output, /required backup is missing/i);
    assert.doesNotMatch(output, /successfully completed/);
  } finally {
    await fs.remove(project);
  }
});

test('forced re-init preserves an unchanged legacy file whose applied snapshot is unavailable', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    const yml = path.join(project, 'application.yml');
    await fs.writeFile(build, "dependencies {\n}\n");
    const first = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, "dependencies {\n  implementation 'ai.ctxa:starter:test'\n}\n");
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, first, INSTALL_MODES.NORMAL);

    const legacyManifest = await fs.readJson(manifestPath(project));
    const legacyEntry = legacyManifest.files.find(entry => entry.relativePath === 'build.gradle');
    await fs.remove(path.join(backupRoot(project), legacyEntry.appliedRelativePath));
    delete legacyEntry.appliedRelativePath;
    delete legacyEntry.appliedChecksum;
    legacyEntry.lastCliChecksum = null;
    legacyManifest.version = 3;
    delete legacyManifest.metadata.resourceDigestVersion;
    delete legacyManifest.metadata.resourceDigest;
    await fs.writeJson(manifestPath(project), legacyManifest, { spaces: 2 });
    const preservedBuild = await fs.readFile(build);

    const second = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL, [
      { filePath: build, kind: 'build-file', generated: false },
      { filePath: yml, kind: 'application-yml', generated: true },
    ]);
    await fs.writeFile(yml, 'contexa:\n  security: enabled\n');
    await recordChange(project, yml, { kind: 'application-yml', generated: true }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, second, INSTALL_MODES.NORMAL);

    const migrated = await loadManifest(project);
    assert.equal(migrated.files.some(entry => entry.relativePath === 'build.gradle'), false);
    assert.equal(await fs.pathExists(path.join(backupRoot(project), 'build.gradle')), false);
    assert.deepEqual(await fs.readFile(build), preservedBuild);

    const restored = await restoreProjectFiles(project, INSTALL_MODES.NORMAL);
    assert.equal(restored.audit.conflict.length, 0);
    assert.deepEqual(await fs.readFile(build), preservedBuild);
    assert.equal(await fs.pathExists(yml), false);
  } finally {
    await fs.remove(project);
  }
});

test('no-op forced re-init still releases unverifiable legacy ownership', async () => {
  const project = await tempProject();
  try {
    const build = path.join(project, 'build.gradle');
    await fs.writeFile(build, "dependencies {\n}\n");
    const first = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file', generated: false }]);
    await fs.writeFile(build, "dependencies {\n  implementation 'ai.ctxa:starter:test'\n}\n");
    await recordChange(project, build, { kind: 'build-file', generated: false }, INSTALL_MODES.NORMAL);
    await commitInstallTransaction(project, first, INSTALL_MODES.NORMAL);
    const preservedBuild = await fs.readFile(build);

    const legacyManifest = await fs.readJson(manifestPath(project));
    const legacyEntry = legacyManifest.files.find(entry => entry.relativePath === 'build.gradle');
    await fs.remove(path.join(backupRoot(project), legacyEntry.appliedRelativePath));
    delete legacyEntry.appliedRelativePath;
    delete legacyEntry.appliedChecksum;
    legacyManifest.version = 3;
    delete legacyManifest.metadata.resourceDigestVersion;
    delete legacyManifest.metadata.resourceDigest;
    await fs.writeJson(manifestPath(project), legacyManifest, { spaces: 2 });

    const second = await beginInstallTransaction(project, {}, INSTALL_MODES.NORMAL,
      [{ filePath: build, kind: 'build-file', generated: false }]);
    const committed = await commitInstallTransaction(project, second, INSTALL_MODES.NORMAL);

    assert.equal(committed.changed, true);
    assert.equal((await loadManifest(project)).files.length, 0);
    assert.deepEqual(await fs.readFile(build), preservedBuild);
  } finally {
    await fs.remove(project);
  }
});
