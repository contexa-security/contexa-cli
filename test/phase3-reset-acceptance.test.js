'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');
const {
  INSTALL_MODES,
  acquireInstallLock,
  releaseInstallLock,
  loadManifest,
  saveManifest,
} = require('../src/core/manifest');

async function createProject(parent, name) {
  const project = path.join(parent, name);
  await fs.ensureDir(path.join(project, 'src/main/resources'));
  await fs.ensureDir(path.join(project, 'src/main/java/example'));
  await fs.writeFile(path.join(project, 'settings.gradle'), `rootProject.name = '${name}'\n`);
  await fs.writeFile(path.join(project, 'build.gradle'),
    "plugins { id 'org.springframework.boot' version '3.3.0' }\n" +
    "dependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");
  await fs.writeFile(path.join(project, 'src/main/resources/application.yml'),
    'host-owned:\n  marker: keep\n');
  await fs.writeFile(path.join(project, 'src/main/java/example/SampleApplication.java'),
    'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n' +
    '@SpringBootApplication\npublic class SampleApplication {}\n');
  return project;
}

function runCli(project, command, extra = [], environment = {}) {
  const safeArgs = [...extra];
  if (command === 'init') {
    if (!safeArgs.includes('--no-docker')) safeArgs.push('--no-docker');
    if (!safeArgs.includes('--infra-dir')) {
      safeArgs.push('--infra-dir', path.join(project, 'contexa-test-infra'));
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [cliPath, command, '--yes', '--dir', project, ...safeArgs], {
        cwd: root,
        env: { ...process.env, ...environment, CONTEXA_LANG: 'en' },
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

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function runInterruptedReset(project, stage, signalPath) {
  const script = [
    "'use strict';",
    "const fs = require('fs-extra');",
    `const cliPath = ${JSON.stringify(cliPath)};`,
    'const project = process.argv[1];',
    'const stage = process.argv[2];',
    'const signalPath = process.argv[3];',
    "const overlay = require('node:path').join(project, 'src/main/resources/application-contexa.yml');",
    "const build = require('node:path').join(project, 'build.gradle');",
    "const manifest = require('node:path').join(project, 'contexa/manifest.json');",
    'let signalled = false;',
    'async function stopAt(name) {',
    '  if (signalled || stage !== name) return;',
    '  signalled = true;',
    "  await fs.writeFile(signalPath, name, 'utf8');",
    '  await new Promise(() => {});',
    '}',
    'const originalRemove = fs.remove;',
    'fs.remove = async target => {',
    '  await originalRemove(target);',
    "  if (String(target) === overlay) await stopAt('overlay-removed');",
    '};',
    'const originalCopy = fs.copy;',
    'fs.copy = async (source, destination, options) => {',
    '  await originalCopy(source, destination, options);',
    "  if (String(destination) === build) await stopAt('build-restored');",
    '};',
    'const originalRename = fs.rename;',
    'fs.rename = async (source, destination) => {',
    '  await originalRename(source, destination);',
    "  if (String(destination) !== manifest || stage !== 'manifest-empty') return;",
    '  const current = await fs.readJson(manifest);',
    "  if (Array.isArray(current.files) && current.files.length === 0) await stopAt('manifest-empty');",
    '};',
    "process.argv = [process.execPath, cliPath, 'reset', '--yes', '--dir', project];",
    'require(cliPath);',
  ].join('\n');
  return spawn(process.execPath, ['-e', script, project, stage, signalPath], {
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
  throw new Error(`Timed out waiting for reset stage: ${filePath}`);
}

function awaitClose(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}
function assertSuccess(result, context) {
  assert.equal(result.code, 0, `${context}: ${output(result)}`);
}

test('Phase 3 reset recovers after termination at every durable file stage', {
  timeout: 120000,
}, async t => {
  const geoIp = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
  assert.ok(geoIp && await fs.pathExists(geoIp));
  for (const stage of ['overlay-removed', 'build-restored', 'manifest-empty']) {
    await t.test(stage, async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), `ctxa-phase3-kill-${stage}-`));
      const project = await createProject(parent, `kill-${stage}`);
      const buildPath = path.join(project, 'build.gradle');
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      const signalPath = path.join(parent, `${stage}.signal`);
      const originalBuild = await fs.readFile(buildPath);
      const originalYml = await fs.readFile(ymlPath);
      try {
        const init = await runCli(project, 'init', ['--enable-ai-security', '--provider', 'ollama'], {
          CONTEXA_GEOLITE2_SOURCE_PATH: geoIp,
        });
        assertSuccess(init, `${stage} init`);
        const child = runInterruptedReset(project, stage, signalPath);
        const closed = awaitClose(child);
        child.stdout.resume();
        child.stderr.resume();
        await awaitFile(signalPath);
        child.kill('SIGKILL');
        await closed;
        const retry = await runCli(project, 'reset');
        assertSuccess(retry, `${stage} retry`);
        assert.deepEqual(await fs.readFile(buildPath), originalBuild);
        assert.deepEqual(await fs.readFile(ymlPath), originalYml);
        assert.equal(await fs.pathExists(path.join(project, 'contexa/manifest.json')), false);
      } finally {
        await fs.remove(parent);
      }
    });
  }
});
test('Phase 3 same-project ten-way reset rejects a live operation and retry succeeds', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-lock-'));
  const project = await createProject(parent, 'same-reset');
  try {
    assertSuccess(await runCli(project, 'init'), 'init');
    const held = await acquireInstallLock(project, INSTALL_MODES.NORMAL, 'test');
    const rejected = await Promise.all(Array.from({ length: 10 }, () => runCli(project, 'reset')));
    await releaseInstallLock(held);
    assert.ok(rejected.every(result => result.code !== 0));
    assert.ok(rejected.every(result => output(result).includes('INIT_ALREADY_RUNNING')));
    const retry = await runCli(project, 'reset');
    assertSuccess(retry, 'retry reset');
    assert.match(output(retry), /CONTEXA_RESET_RESULT .*"result":"SUCCESS"/);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 3 no-docker re-init preserves existing Docker reset ownership', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-docker-ownership-'));
  const project = await createProject(parent, 'docker-ownership');
  const environment = {
    CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
  };
  try {
    assertSuccess(await runCli(project, 'init', [], environment), 'initial no-docker init');
    const manifest = await loadManifest(project, INSTALL_MODES.NORMAL);
    const originalInfraDir = manifest.metadata.infraDir;
    const originalContract = structuredClone(manifest.metadata.dockerResources);
    const originalComposeChecksum = manifest.metadata.composeChecksum;
    const composePath = path.join(originalInfraDir, 'docker-compose.yml');
    const originalCompose = await fs.readFile(composePath);

    manifest.metadata.dockerLifecycleManaged = true;
    await saveManifest(project, manifest, INSTALL_MODES.NORMAL);

    const repeated = await runCli(project, 'init', [], environment);
    assertSuccess(repeated, 'no-docker re-init');
    const updated = await loadManifest(project, INSTALL_MODES.NORMAL);
    assert.equal(updated.metadata.dockerLifecycleManaged, true);
    assert.equal(updated.metadata.infraDir, originalInfraDir);
    assert.deepEqual(updated.metadata.dockerResources, originalContract);
    assert.equal(updated.metadata.composeChecksum, originalComposeChecksum);
    assert.deepEqual(await fs.readFile(composePath), originalCompose);
    assert.match(output(repeated), /Existing Contexa infrastructure remains owned/);
  } finally {
    await fs.remove(parent);
  }
});
test('Phase 3 reset remains a stable no-op across 100 sequential runs', { timeout: 120000 }, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-repeat-'));
  const project = await createProject(parent, 'repeat-reset');
  const buildPath = path.join(project, 'build.gradle');
  const ymlPath = path.join(project, 'src/main/resources/application.yml');
  const originalBuild = await fs.readFile(buildPath);
  const originalYml = await fs.readFile(ymlPath);
  try {
    assertSuccess(await runCli(project, 'init'), 'init');
    for (let index = 0; index < 100; index += 1) {
      const result = await runCli(project, 'reset');
      assertSuccess(result, `reset ${index + 1}`);
      assert.match(output(result), index === 0 ? /"result":"SUCCESS"/ : /"result":"NO_OWNED_INSTALLATION"/);
    }
    assert.deepEqual(await fs.readFile(buildPath), originalBuild);
    assert.deepEqual(await fs.readFile(ymlPath), originalYml);
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 3 INF01-INF08 reset restores project files and owned infra artifacts', {
  timeout: 180000,
}, async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-infra-'));
  const profiles = [
    { id: 'INF01', init: project => ['--no-docker', '--infra-dir', path.join(project, 'infra')] },
    { id: 'INF02', yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg/contexa\n' },
    { id: 'INF03', yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://host-db/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://contexa-db/contexa\n' },
    { id: 'INF04', yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://shared/host\ncontexa:\n  datasource:\n    url: jdbc:postgresql://shared/contexa\n' },
    { id: 'INF05', init: project => ['--distributed', '--no-docker', '--infra-dir', path.join(project, 'infra')] },
    { id: 'INF06', yml: 'contexa:\n  infrastructure:\n    mode: DISTRIBUTED\n  datasource:\n    url: jdbc:postgresql://managed-pg/contexa\n' },
    { id: 'INF07', yml: 'contexa:\n  datasource:\n    url: jdbc:postgresql://external-pg/contexa\nspring:\n  data:\n    redis:\n      host: local-redis\n' },
  ];
  try {
    for (const profile of profiles) {
      await t.test(profile.id, async () => {
        const project = await createProject(parent, profile.id.toLowerCase());
        const buildPath = path.join(project, 'build.gradle');
        const ymlPath = path.join(project, 'src/main/resources/application.yml');
        if (profile.yml) await fs.writeFile(ymlPath, profile.yml, 'utf8');
        const originalBuild = await fs.readFile(buildPath);
        const originalYml = await fs.readFile(ymlPath);
        const initArgs = profile.init ? profile.init(project) : [];
        assertSuccess(await runCli(project, 'init', initArgs), `${profile.id} init`);
        const reset = await runCli(project, 'reset');
        assertSuccess(reset, `${profile.id} reset`);
        assert.deepEqual(await fs.readFile(buildPath), originalBuild);
        assert.deepEqual(await fs.readFile(ymlPath), originalYml);
        assert.equal(await fs.pathExists(path.join(project, 'contexa/manifest.json')), false);
        if (profile.init) {
          assert.match(output(reset), /"dockerCalls":0/);
          assert.equal(await fs.pathExists(path.join(project, 'infra/docker-compose.yml')), false);
        }
      });
    }

    await t.test('INF08', async () => {
      const geoIp = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
      assert.ok(geoIp && await fs.pathExists(geoIp));
      const project = await createProject(parent, 'inf08');
      const buildPath = path.join(project, 'build.gradle');
      const ymlPath = path.join(project, 'src/main/resources/application.yml');
      const originalBuild = await fs.readFile(buildPath);
      const originalYml = await fs.readFile(ymlPath);
      assertSuccess(await runCli(project, 'init'), 'INF08 normal init');
      assertSuccess(await runCli(project, 'init',
        ['--simulate', '--no-docker', '--infra-dir', path.join(project, 'simulation-infra')],
        { CONTEXA_GEOLITE2_SOURCE_PATH: geoIp }), 'INF08 simulation init');
      assertSuccess(await runCli(project, 'reset', ['--simulate']), 'INF08 simulation reset');
      assertSuccess(await runCli(project, 'reset'), 'INF08 normal reset');
      assert.deepEqual(await fs.readFile(buildPath), originalBuild);
      assert.deepEqual(await fs.readFile(ymlPath), originalYml);
    });
  } finally {
    await fs.remove(parent);
  }
});

test('Phase 3 code reset does not terminate a running application process', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase3-running-'));
  const project = await createProject(parent, 'running-app');
  const server = http.createServer((request, response) => response.end('running'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(9080, '127.0.0.1', resolve);
    });
    assertSuccess(await runCli(project, 'init'), 'init');
    assertSuccess(await runCli(project, 'reset', ['--code']), 'reset while running');
    const body = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:9080/', response => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve(data));
      }).once('error', reject);
    });
    assert.equal(body, 'running');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.remove(parent);
  }
});
