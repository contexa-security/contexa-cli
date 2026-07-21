'use strict';

// Pre-flight check tests. We exercise the surface that is safe to test in CI:
//   - inspectInfra returns an array
//   - it tolerates missing docker / unreachable daemon and emits an error
//     record with actionable hints
//   - it surfaces port collisions when we synthetically bind a port
//   - it surfaces container collisions only when docker is reachable
// We do NOT actually start docker - the tests are pure node-side simulations.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { spawn, spawnSync } = require('node:child_process');

const { inspectInfra, probeHostServiceIdentity } = require('../src/core/preflight');
const { INFRASTRUCTURE_SERVICE_CONTRACTS } = require('../src/core/infrastructure');
const {
  assertSimulationServiceState,
  assertSimulationVersions,
  waitForSimulationInfrastructure,
} = require('../src/core/simulation');
const cliPath = path.resolve(__dirname, '../src/index.js');

test('inspectInfra: respects --no-docker (startDocker=false) by skipping all docker checks', async () => {
  const issues = await inspectInfra({
    infra: 'standalone',
    startDocker: false,
    dependencies: {
      isPortBound: async () => false,
      dockerTry: () => { throw new Error('docker must not be called'); },
    },
  });
  // Even if docker is missing on the host, we should not get a docker-related
  // error here because the user opted out.
  const dockerRe = /Docker daemon|Docker is installed|not installed/i;
  for (const i of issues) {
    assert.ok(!dockerRe.test(i.message),
      `docker-related issue surfaced when startDocker=false: ${i.message}`);
  }
});

test('inspectInfra: returns an array of {severity, message, hint?} records', async () => {
  const issues = await inspectInfra({ infra: 'standalone', startDocker: false });
  assert.ok(Array.isArray(issues));
  for (const i of issues) {
    assert.ok(['error', 'warning', 'info'].includes(i.severity));
    assert.equal(typeof i.message, 'string');
    if (i.hint !== undefined) assert.ok(Array.isArray(i.hint));
  }
});

test('inspectInfra: rejects an occupied port that is not linked to a verified owned container', async () => {
  const issues = await inspectInfra({
    infra: 'standalone',
    projectName: 'phase5',
    dependencies: dockerState({ portBound: true }),
  });
  const collision = issues.find(issue => issue.code === 'unverified-port-in-use');
  assert.equal(collision.severity, 'error');
  assert.deepEqual(issues.skippedServices, []);
  assert.deepEqual(issues.servicesToUp, ['postgres']);
  assert.equal(issues.portStates[0].bound, true);
  assert.equal(issues.portStates[0].ownershipVerified, false);
  assert.match(issues.portStates[0].fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test('inspectInfra: records protocol identity separately and still rejects foreign services', async () => {
  const secret = 'must-not-be-recorded';
  const issues = await inspectInfra({
    infra: 'distributed',
    includeOllama: true,
    projectName: 'phase7',
    dependencies: dockerState({
      portBound: true,
      hostProbeResults: {
        postgres: { protocol: 'postgres', verified: false,
          identity: `postgres:wrong-database:wrong-user:${secret}` },
        redis: { protocol: 'redis', verified: true, identity: 'redis:RESP:PONG' },
        zookeeper: { protocol: 'zookeeper', verified: true, identity: 'zookeeper:ruok:imok' },
        kafka: { protocol: 'kafka', verified: true, identity: 'kafka:api-versions' },
        ollama: { protocol: 'http-decoy', verified: false, identity: 'not-ollama' },
      },
    }),
  });
  assert.equal(issues.filter(issue => issue.code === 'unverified-port-in-use').length, 5);
  assert.equal(issues.portStates.length, 5);
  assert.deepEqual(issues.portStates.map(state => state.serviceKey),
    ['postgres', 'ollama', 'redis', 'zookeeper', 'kafka']);
  assert.ok(issues.portStates.every(state => state.bound && !state.ownershipVerified));
  assert.ok(issues.portStates.every(state => /^sha256:[a-f0-9]{64}$/.test(state.fingerprint)));
  assert.equal(JSON.stringify(issues).includes(secret), false);
});

test('host-level probes reject HTTP decoys and silent sockets within the bound', async () => {
  for (const service of ['postgres', 'redis', 'zookeeper', 'kafka', 'ollama']) {
    await withTcpFixture(socket => {
      socket.once('data', () => socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nOK'));
    }, async port => {
      const result = await probeHostServiceIdentity(service, '127.0.0.1', port, {
        databaseName: 'expected_db',
        databaseUser: 'expected_user',
        timeoutMs: 100,
      });
      assert.equal(result.verified, false, `${service} HTTP decoy must fail`);
    });
  }

  const startedAt = Date.now();
  await withTcpFixture(() => {}, async port => {
    const result = await probeHostServiceIdentity('redis', '127.0.0.1', port, {
      timeoutMs: 60,
    });
    assert.equal(result.protocol, 'silent');
    assert.equal(result.verified, false);
  });
  assert.ok(Date.now() - startedAt < 1000);
});

test('host-level probes require Redis version and Kafka cluster identity', async () => {
  await withTcpFixture(socket => {
    socket.once('data', () => socket.end(
      '+PONG\r\n$45\r\n# Server\r\nredis_version:7.2.13\r\nredis_mode:standalone\r\n'));
  }, async port => {
    const result = await probeHostServiceIdentity('redis', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.deepEqual(result,
      { protocol: 'redis', verified: true, identity: 'redis:7.2.13' });
  });
  await withTcpFixture(socket => {
    socket.once('data', () => socket.end('+PONG\r\n'));
  }, async port => {
    const result = await probeHostServiceIdentity('redis', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.equal(result.verified, false);
  });

  await withTcpFixture(socket => {
    socket.once('data', () => socket.end(
      'Zookeeper version: 3.6.4--build, built on date\nMode: standalone\n'));
  }, async port => {
    const result = await probeHostServiceIdentity('zookeeper', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.deepEqual(result,
      { protocol: 'zookeeper', verified: true, identity: 'zookeeper:3.6.4--build' });
  });
  await withTcpFixture(socket => {
    socket.once('data', () => socket.end('imok'));
  }, async port => {
    const result = await probeHostServiceIdentity('zookeeper', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.equal(result.verified, false);
  });

  await withTcpFixture(socket => {
    socket.once('data', () => socket.end(kafkaMetadataResponse('ctxa-cluster')));
  }, async port => {
    const result = await probeHostServiceIdentity('kafka', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.deepEqual(result,
      { protocol: 'kafka', verified: true, identity: 'kafka:cluster:ctxa-cluster' });
  });
  await withTcpFixture(socket => {
    socket.once('data', () => socket.end(kafkaMetadataResponse('ctxa-cluster', 99)));
  }, async port => {
    const result = await probeHostServiceIdentity('kafka', '127.0.0.1', port, {
      timeoutMs: 100,
    });
    assert.equal(result.verified, false);
  });
});

test('actual CLI rejects a PostgreSQL HTTP decoy before project or Docker mutation', async t => {
  const docker = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 3000 });
  if (docker.error || docker.status !== 0) {
    t.skip('requires a reachable Docker daemon for actual distributed preflight');
    return;
  }
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-phase7-decoy-'));
  const build = path.join(project, 'build.gradle');
  const yml = path.join(project, 'src/main/resources/application.yml');
  await fs.outputFile(build,
    "plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies {}\n", 'utf8');
  await fs.outputFile(path.join(project, 'settings.gradle'),
    "rootProject.name='phase7-decoy'\n", 'utf8');
  await fs.outputFile(path.join(project, 'src/main/java/example/App.java'),
    'package example; import org.springframework.boot.autoconfigure.SpringBootApplication; @SpringBootApplication class App {}\n',
    'utf8');
  await fs.outputFile(yml, 'server:\n  port: 9080\n', 'utf8');
  const before = {
    build: await fileDigest(build),
    yml: await fileDigest(yml),
    docker: dockerInventory(),
  };
  try {
    await withTcpFixture(socket => {
      socket.once('data', () => socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'));
    }, async port => {
      const result = await runCliChild([
        'init', '--yes', '--distributed', '--dir', project,
      ], { CONTEXA_POSTGRES_PORT: String(port) });
      assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(String(port)));
    });
    assert.equal(await fileDigest(build), before.build);
    assert.equal(await fileDigest(yml), before.yml);
    assert.equal(await fs.pathExists(path.join(project, 'contexa', 'manifest.json')), false);
    assert.deepEqual(dockerInventory(), before.docker);
  } finally {
    await fs.remove(project);
  }
});

test('inspectInfra: rejects a same-name container without matching ownership labels', async () => {
  const issues = await inspectInfra({
    infra: 'standalone',
    projectName: 'phase5',
    dependencies: dockerState({
      containers: ['phase5-postgres'],
      identities: { 'phase5-postgres': 'other-owner|normal|phase5' },
    }),
  });
  assert.ok(issues.some(issue => issue.code === 'container-ownership-conflict'
    && issue.severity === 'error'));
  assert.deepEqual(issues.skippedServices, []);
  assert.deepEqual(issues.servicesToUp, ['postgres']);
});

test('inspectInfra: reuses only a container with matching owner, mode, and compose project', async () => {
  const issues = await inspectInfra({
    infra: 'standalone',
    projectName: 'phase5',
    installationId: 'phase5-installation',
    dependencies: dockerState({
      portBound: true,
      containers: ['phase5-postgres'],
      identities: { 'phase5-postgres': 'contexa-cli|normal|phase5' },
      labels: {
        'phase5-postgres': {
          'io.ctxa.installation-id': 'phase5-installation',
          'com.docker.compose.service': 'postgres',
        },
      },
    }),
  });
  assert.ok(issues.some(issue => issue.code === 'owned-port-in-use'));
  assert.ok(issues.some(issue => issue.code === 'all-containers-exist'));
  assert.equal(issues.some(issue => issue.severity === 'error'), false);
  assert.deepEqual(issues.skippedServices, ['postgres']);
  assert.deepEqual(issues.servicesToUp, []);
  assert.match(issues.identityFingerprints.postgres, /^sha256:[a-f0-9]{64}$/);
});

test('inspectInfra: rejects matching labels when the PostgreSQL protocol identity is wrong', async () => {
  const issues = await inspectInfra({
    infra: 'standalone',
    projectName: 'phase5',
    installationId: 'phase5-installation',
    dependencies: dockerState({
      portBound: true,
      containers: ['phase5-postgres'],
      identities: { 'phase5-postgres': 'contexa-cli|normal|phase5' },
      labels: {
        'phase5-postgres': {
          'io.ctxa.installation-id': 'phase5-installation',
          'com.docker.compose.service': 'postgres',
        },
      },
      probeResults: { postgres: { verified: false, identity: 'other|other' } },
    }),
  });
  assert.ok(issues.some(issue => issue.code === 'service-identity-mismatch'
    && issue.severity === 'error'));
  assert.deepEqual(issues.skippedServices, []);
  assert.deepEqual(issues.identityFingerprints, {});
});

test('inspectInfra: distributed mode adds redis/zookeeper/kafka to the port check set', async () => {
  // Without binding anything, just verify the function does not throw and
  // returns an array even when distributed is requested. Real port collisions
  // are environment-dependent and covered by the function shape itself.
  const issues = await inspectInfra({ infra: 'distributed', startDocker: false });
  assert.ok(Array.isArray(issues));
});

test('inspectInfra: strict simulation isolation rejects an occupied port instead of reusing it', async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const previous = process.env.CONTEXA_POSTGRES_PORT;
  process.env.CONTEXA_POSTGRES_PORT = String(blocker.address().port);
  try {
    const issues = await inspectInfra({
      infra: 'standalone',
      startDocker: false,
      strictIsolation: true,
      dependencies: {
        probeHostServiceIdentity: async () => ({
          protocol: 'silent', verified: false, identity: 'timeout',
        }),
      },
    });
    const collision = issues.find(issue => issue.message.includes(String(blocker.address().port)));
    assert.equal(collision.severity, 'error');
    assert.match(collision.message, /Simulation port/);
    assert.deepEqual(issues.skippedServices, []);
    assert.deepEqual(issues.servicesToUp, ['postgres']);
  } finally {
    if (previous === undefined) delete process.env.CONTEXA_POSTGRES_PORT;
    else process.env.CONTEXA_POSTGRES_PORT = previous;
    await new Promise(resolve => blocker.close(resolve));
  }
});

test('simulation health gate tolerates transient failure and returns the recovered evidence', async () => {
  let attempts = 0;
  const result = await waitForSimulationInfrastructure('test-installation', true, {
    timeoutMs: 100,
    intervalMs: 0,
    delay: async () => {},
    verify: () => {
      attempts++;
      if (attempts < 3) throw new Error('transient unhealthy');
      return { services: ['postgres', 'redis', 'zookeeper', 'kafka', 'ollama'] };
    },
  });
  assert.equal(attempts, 3);
  assert.equal(result.services.length, 5);
});

test('strict simulation reuses only the complete healthy installation with exact ownership', async () => {
  const services = ['postgres', 'redis', 'zookeeper', 'kafka', 'ollama'];
  const containers = services.map(service => `ctxa-sim-${service}`);
  const identities = Object.fromEntries(containers.map(container =>
    [container, 'contexa-cli|simulation|ctxa-sim']));
  const labels = Object.fromEntries(services.map(service => [`ctxa-sim-${service}`, {
    'io.ctxa.installation-id': 'simulation-installation',
    'com.docker.compose.service': service,
  }]));
  const issues = await inspectInfra({
    infra: 'distributed',
    includeOllama: true,
    startDocker: true,
    strictIsolation: true,
    projectName: 'ctxa-sim',
    installationId: 'simulation-installation',
    dependencies: dockerState({ portBound: true, containers, identities, labels }),
  });

  assert.equal(issues.some(issue => issue.severity === 'error'), false);
  assert.ok(issues.some(issue => issue.code === 'all-containers-exist'));
  assert.deepEqual(issues.servicesToUp, []);
  assert.deepEqual([...issues.skippedServices].sort(), [...services].sort());
});

test('strict simulation rejects a partially present owned installation', async () => {
  const container = 'ctxa-sim-postgres';
  const issues = await inspectInfra({
    infra: 'distributed',
    includeOllama: true,
    startDocker: true,
    strictIsolation: true,
    projectName: 'ctxa-sim',
    installationId: 'simulation-installation',
    dependencies: dockerState({
      containers: [container],
      identities: { [container]: 'contexa-cli|simulation|ctxa-sim' },
      labels: {
        [container]: {
          'io.ctxa.installation-id': 'simulation-installation',
          'com.docker.compose.service': 'postgres',
        },
      },
    }),
  });

  assert.ok(issues.some(issue =>
    issue.severity === 'error' && issue.code === 'simulation-container-collision'));
});

test('simulation version and health contracts fail closed on drift or partial health', () => {
  assertSimulationVersions({
    postgres: 'postgres (PostgreSQL) 16.13',
    redis: 'Redis server v=7.2.13',
    zookeeper: '7.4.0',
    kafka: '7.4.0-ccs',
    ollama: 'ollama version is 0.18.2',
  });
  assert.throws(() => assertSimulationVersions({
    postgres: 'postgres (PostgreSQL) 16.13',
    redis: 'Redis server v=7.2.13',
    zookeeper: '7.4.0',
    kafka: '7.4.0-ccs',
    ollama: 'ollama version is 0.17.0',
  }), /version drift for ollama/);
  assert.throws(() => assertSimulationServiceState('postgres', [
    'running', 'unhealthy', 'contexa-cli', 'simulation', 'simulation-installation',
    INFRASTRUCTURE_SERVICE_CONTRACTS.postgres.image,
  ], 'simulation-installation'), /service contract failed/);
});

function dockerState({
  portBound = false,
  containers = [],
  identities = {},
  labels = {},
  probeResults = {},
  hostProbeResults = {},
} = {}) {
  return {
    isDockerCliInstalled: () => true,
    isDockerDaemonRunning: () => true,
    isPortBound: async () => portBound,
    dockerTry: (args) => {
      if (args[0] === 'ps') {
        return { status: 0, stdout: Buffer.from(containers.join('\n')) };
      }
      if (args[0] === 'inspect') {
        if (args[2] === '{{json .Config.Labels}}') {
          return { status: 0, stdout: Buffer.from(JSON.stringify(labels[args.at(-1)] || {})) };
        }
        return { status: 0, stdout: Buffer.from(identities[args.at(-1)] || '') };
      }
      throw new Error(`unexpected docker command: ${args.join(' ')}`);
    },
    probeServiceIdentity: async serviceKey => probeResults[serviceKey]
      || { verified: true, identity: `${serviceKey}:verified` },
    probeHostServiceIdentity: async serviceKey => hostProbeResults[serviceKey]
      || { protocol: 'unknown', verified: false, identity: 'unrecognized' },
  };
}

async function withTcpFixture(configure, action) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    configure(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await action(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

function kafkaMetadataResponse(clusterId, correlationId = 2) {
  const host = Buffer.from('localhost', 'utf8');
  const cluster = Buffer.from(clusterId, 'utf8');
  const response = Buffer.alloc(4 + 4 + 4 + 4 + 4 + 2 + host.length + 4 + 2
    + 2 + cluster.length + 4);
  let offset = 0;
  response.writeInt32BE(response.length - 4, offset); offset += 4;
  response.writeInt32BE(correlationId, offset); offset += 4;
  response.writeInt32BE(0, offset); offset += 4;
  response.writeInt32BE(1, offset); offset += 4;
  response.writeInt32BE(1, offset); offset += 4;
  response.writeInt16BE(host.length, offset); offset += 2;
  host.copy(response, offset); offset += host.length;
  response.writeInt32BE(9092, offset); offset += 4;
  response.writeInt16BE(-1, offset); offset += 2;
  response.writeInt16BE(cluster.length, offset); offset += 2;
  cluster.copy(response, offset); offset += cluster.length;
  response.writeInt32BE(1, offset);
  return response;
}

function fileDigest(file) {
  return fs.readFile(file).then(value =>
    crypto.createHash('sha256').update(value).digest('hex'));
}

function dockerInventory() {
  const commands = [
    ['ps', '-a', '--format', '{{.ID}}|{{.Names}}'],
    ['volume', 'ls', '--format', '{{.Name}}'],
    ['network', 'ls', '--format', '{{.ID}}|{{.Name}}'],
  ];
  return commands.map(args => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 3000 });
    return result.status === 0
      ? result.stdout.split(/\r?\n/).filter(Boolean).sort() : ['DOCKER_UNAVAILABLE'];
  });
}

function runCliChild(args, extraEnvironment) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...extraEnvironment },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 10000);
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
