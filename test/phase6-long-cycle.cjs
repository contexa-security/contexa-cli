'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repositoryRoot, 'src/index.js');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const cycles = Number(argument('--cycles', '100'));
const evidencePath = path.resolve(argument('--evidence',
  path.join(repositoryRoot, 'phase6-evidence', 'cycle.json')));
if (!Number.isInteger(cycles) || cycles <= 0) {
  throw new Error('--cycles must be a positive integer');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runCli(project, command) {
  const args = [cliPath, command, '--yes', '--dir', project];
  if (command === 'init') args.push('--no-docker');
  const result = spawnSync(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, CONTEXA_LANG: 'en' },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.signal, null,
    `${command} exceeded the bounded 15 second contract`);
  assert.equal(result.status, 0,
    `${command} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function requestHealth() {
  return new Promise(resolve => {
    const request = http.get({
      hostname: '127.0.0.1', port: 9080, path: '/actuator/health', timeout: 250,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('timeout', () => { request.destroy(); resolve(null); });
    request.once('error', () => resolve(null));
  });
}

async function waitForHealth(child, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`cycle server exited before readiness: ${child.exitCode}`);
    }
    const response = await requestHealth();
    if (response && response.status === 200 && response.body.includes('UP')) return response;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`cycle server did not become ready within ${timeoutMs}ms`);
}

function stopProcessTree(child) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

function awaitExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `cycle server process ${child.pid} did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

function startCycleServer(project) {
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'gradlew.bat bootRun'], {
      cwd: project,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  return spawn('./gradlew', ['bootRun'], {
    cwd: project,
    stdio: 'ignore',
    detached: true,
  });
}

async function bootAndStop(project) {
  const child = startCycleServer(project);
  try {
    const health = await waitForHealth(child);
    assert.equal(health.status, 200);
  } finally {
    stopProcessTree(child);
    await awaitExit(child);
  }
  await waitForPortRelease(9080);
  return { pid: child.pid, exitConfirmed: child.exitCode !== null };
}

async function waitForPortRelease(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portBound(port)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`port ${port} remained active after ${timeoutMs}ms`);
}

function portBound(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function dockerInventory() {
  const result = spawnSync('docker', [
    'ps', '-a', '--format', '{{.ID}}|{{.Names}}|{{.Image}}',
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || result.status !== 0) return { available: false, resources: [] };
  return {
    available: true,
    resources: result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).sort(),
  };
}

function prefixedTempCount() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('ctxa-phase6-cycle-')).length;
  } catch {
    return null;
  }
}

function starterCount(text) {
  return (text.match(/ai\.ctxa:spring-boot-starter-contexa/g) || []).length;
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase6-cycle-'));
  const project = path.join(root, 'customer-project');
  await fs.ensureDir(path.join(project, 'src/main/resources'));
  await fs.ensureDir(path.join(project, 'src/main/java/example'));
  await fs.writeFile(path.join(project, 'settings.gradle'),
    "rootProject.name = 'phase6-cycle'\n", 'utf8');
  await fs.writeFile(path.join(project, 'build.gradle'), [
    "plugins { id 'org.springframework.boot' version '3.3.0' }",
    'repositories { mavenCentral() }',
    'dependencies {',
    "  implementation 'org.springframework.boot:spring-boot-starter-web'",
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project, 'src/main/resources/application.yml'),
    'server:\n  port: 9080\nhost-owned:\n  marker: preserve-me\n', 'utf8');
  await fs.writeFile(path.join(project, 'src/main/java/example/SampleApplication.java'),
    'package example;\n@org.springframework.boot.autoconfigure.SpringBootApplication\n' +
    'public class SampleApplication {}\n', 'utf8');
  await fs.writeFile(path.join(project, 'customer-change.txt'),
    'customer-owned-canary\n', 'utf8');
  await fs.writeFile(path.join(project, 'cycle-server.cjs'), [
    "'use strict';",
    "const http=require('node:http');",
    "const server=http.createServer((request,response)=>{",
    "  response.writeHead(200,{'content-type':'application/json'});",
    "  response.end(JSON.stringify({status:'UP'}));",
    '});',
    'server.listen(9080,\'127.0.0.1\');',
    "for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));",
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project, 'gradlew.bat'),
    '@echo off\r\nnode cycle-server.cjs\r\n', 'utf8');
  await fs.writeFile(path.join(project, 'gradlew'),
    '#!/bin/sh\nexec node cycle-server.cjs\n', { encoding: 'utf8', mode: 0o755 });
  return { root, project };
}

async function fileSnapshot(project) {
  const entries = {};
  for (const relative of [
    'build.gradle',
    'settings.gradle',
    'src/main/resources/application.yml',
    'src/main/java/example/SampleApplication.java',
    'customer-change.txt',
    'cycle-server.cjs',
    'gradlew',
    'gradlew.bat',
  ]) {
    entries[relative] = sha256(await fs.readFile(path.join(project, relative)));
  }
  return entries;
}

async function main() {
  const startedAt = Date.now();
  const tempBefore = prefixedTempCount();
  const dockerBefore = dockerInventory();
  const fixture = await createFixture();
  const checkpoints = [];
  const launchedProcesses = [];
  let baseline;
  try {
    baseline = await fileSnapshot(fixture.project);
    const initialRss = process.memoryUsage().rss;
    const initialHandles = process._getActiveHandles().length;
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      runCli(fixture.project, 'init');
      const installedBuild = await fs.readFile(
        path.join(fixture.project, 'build.gradle'), 'utf8');
      assert.equal(starterCount(installedBuild), 1);
      launchedProcesses.push(await bootAndStop(fixture.project));

      runCli(fixture.project, 'reset');
      assert.deepEqual(await fileSnapshot(fixture.project), baseline);

      runCli(fixture.project, 'init');
      const reinstalledBuild = await fs.readFile(
        path.join(fixture.project, 'build.gradle'), 'utf8');
      assert.equal(starterCount(reinstalledBuild), 1);
      launchedProcesses.push(await bootAndStop(fixture.project));

      runCli(fixture.project, 'reset');
      assert.deepEqual(await fileSnapshot(fixture.project), baseline);
      assert.equal(await fs.pathExists(path.join(fixture.project, 'contexa/manifest.json')), false);
      await waitForPortRelease(9080);

      if (cycle === 1 || cycle % 10 === 0 || cycle === cycles) {
        checkpoints.push({
          cycle,
          rss: process.memoryUsage().rss,
          activeHandles: process._getActiveHandles().length,
          port9080Bound: await portBound(9080),
          customerSha256: sha256(await fs.readFile(
            path.join(fixture.project, 'customer-change.txt'))),
        });
        console.log(`PHASE6_PROGRESS cycle=${cycle}/${cycles}`);
      }
    }
    const peakRss = Math.max(...checkpoints.map(item => item.rss));
    assert.ok(peakRss - initialRss < 128 * 1024 * 1024,
      `runner RSS grew by ${peakRss - initialRss} bytes`);
    const peakHandles = Math.max(...checkpoints.map(item => item.activeHandles));
    assert.ok(peakHandles <= initialHandles + 5,
      `active handles grew from ${initialHandles} to ${peakHandles}`);
  } finally {
    await fs.remove(fixture.root);
  }

  const dockerAfter = dockerInventory();
  const tempAfter = prefixedTempCount();
  const survivingPids = launchedProcesses
    .filter(process => !process.exitConfirmed)
    .map(process => process.pid);
  assert.deepEqual(dockerAfter, dockerBefore, 'Docker inventory changed during no-docker cycles');
  assert.equal(tempAfter, tempBefore, 'temporary fixture directories accumulated');
  assert.deepEqual(survivingPids, [], 'cycle server processes accumulated');
  await waitForPortRelease(9080);

  const evidence = {
    result: 'PASS',
    cycles,
    launches: launchedProcesses.length,
    launchedProcessIds: launchedProcesses.map(process => process.pid),
    exitConfirmedCount: launchedProcesses.filter(process => process.exitConfirmed).length,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    durationMs: Date.now() - startedAt,
    dockerBefore,
    dockerAfter,
    tempBefore,
    tempAfter,
    survivingPids,
    checkpoints,
    baseline,
  };
  await fs.outputJson(evidencePath, evidence, { spaces: 2 });
  console.log(`PHASE6_RESULT PASS cycles=${cycles} launches=${launchedProcesses.length}`);
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
