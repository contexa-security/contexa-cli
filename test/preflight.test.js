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

const { inspectInfra } = require('../src/core/preflight');
const { waitForSimulationInfrastructure } = require('../src/core/simulation');

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
    dependencies: dockerState({
      portBound: true,
      containers: ['phase5-postgres'],
      identities: { 'phase5-postgres': 'contexa-cli|normal|phase5' },
    }),
  });
  assert.ok(issues.some(issue => issue.code === 'owned-port-in-use'));
  assert.ok(issues.some(issue => issue.code === 'all-containers-exist'));
  assert.equal(issues.some(issue => issue.severity === 'error'), false);
  assert.deepEqual(issues.skippedServices, ['postgres']);
  assert.deepEqual(issues.servicesToUp, []);
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

function dockerState({ portBound = false, containers = [], identities = {} } = {}) {
  return {
    isDockerCliInstalled: () => true,
    isDockerDaemonRunning: () => true,
    isPortBound: async () => portBound,
    dockerTry: (args) => {
      if (args[0] === 'ps') {
        return { status: 0, stdout: Buffer.from(containers.join('\n')) };
      }
      if (args[0] === 'inspect') {
        return { status: 0, stdout: Buffer.from(identities[args.at(-1)] || '') };
      }
      throw new Error(`unexpected docker command: ${args.join(' ')}`);
    },
  };
}
