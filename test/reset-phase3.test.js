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
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareExternalFileChange,
  recordChange,
  recordExternalFileChange,
  rollbackInstallTransaction,
  saveManifest,
  sha256FileSync,
} = require('../src/core/manifest');
const {
  buildDockerResourceContract,
  inverseTextMerge,
  performOwnedDockerCleanup,
  restoreProjectFiles,
  yamlManagedPathMerge,
} = require('../src/core/reset-service');

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-reset-'));
}

const cliPath = path.resolve(__dirname, '../src/index.js');

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
      metadata: { mode: 'normal', canonicalProjectPath: project, installationId: 'phase3' },
      files: [{ relativePath: '../outside.txt', installationId: 'phase3', mode: 'normal' }],
    })],
    ['directory entry', async project => {
      await fs.ensureDir(path.join(project, 'owned-dir'));
      return JSON.stringify({
        version: 3,
        metadata: { mode: 'normal', canonicalProjectPath: project, installationId: 'phase3' },
        files: [{ relativePath: 'owned-dir', installationId: 'phase3', mode: 'normal', generated: true }],
      });
    }],
    ['backup mismatch', async project => {
      await fs.writeFile(path.join(project, 'host.txt'), 'cli-applied');
      const backup = path.join(project, 'contexa', 'bak', 'host.txt');
      await fs.ensureDir(path.dirname(backup));
      await fs.writeFile(backup, 'original');
      return JSON.stringify({
        version: 3,
        metadata: { mode: 'normal', canonicalProjectPath: project, installationId: 'phase3' },
        files: [{
          relativePath: 'host.txt', installationId: 'phase3', mode: 'normal', generated: false,
          cliApplied: true, originalChecksum: 'present', backupChecksum: 'wrong',
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
        metadata: { mode: 'normal', canonicalProjectPath: project, installationId: 'phase3' },
        files: [{
          relativePath: 'host.txt', installationId: 'phase3', mode: 'normal', generated: false,
          cliApplied: true, originalChecksum: sha256FileSync(backup),
          backupChecksum: sha256FileSync(backup), appliedRelativePath: 'host.txt',
        }],
      });
    }],
    ['external transaction path escape', async project => JSON.stringify({
      version: 3,
      metadata: {
        mode: 'normal', canonicalProjectPath: project, installationId: 'phase3',
        infraDir: path.join(project, 'owned-infra'),
      },
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
      metadata: { mode: 'normal', canonicalProjectPath: project, installationId: 'phase3' },
      files: [{ relativePath: 'linked/customer.txt', installationId: 'phase3', mode: 'normal', generated: true }],
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
          ...contract.containers.map(value => [`container:${value}`, { ...labels }]),
          ...contract.volumes.map(value => [`volume:${value}`, { ...labels }]),
          ...contract.networks.map(value => [`network:${value}`, { ...labels }]),
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
      ...contract.containers.map(value => [`container:${value}`, { ...labels }]),
      ...contract.volumes.map(value => [`volume:${value}`, { ...labels }]),
      ...contract.networks.map(value => [`network:${value}`, { ...labels }]),
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
      [cliPath, 'reset', '--yes', '--code', '--dir', project], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await fs.pathExists(manifestPath(project, INSTALL_MODES.NORMAL)), false);
    assert.deepEqual(await fs.readFile(simulationPath), before);
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
  const infraDir = await tempProject();
  try {
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
    await fs.remove(infraDir);
  }
});
