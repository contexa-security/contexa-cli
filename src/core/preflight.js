'use strict';

const net = require('net');
const {
  DEFAULT_INFRASTRUCTURE_PORTS,
  SIMULATION_PORTS,
  configuredPort,
} = require('./infrastructure');
const { containerName, resolveProjectName } = require('./project');
const { dockerTry, isDockerCliInstalled, isDockerDaemonRunning } = require('./docker');
const { TIMEOUTS } = require('./timeouts');
const { t } = require('./i18n');

// Pre-flight checks for the docker-driven infrastructure init step.
// Returns an array of { severity, message, hint, code? } records.
//
// severity:
//   error   - infrastructure cannot start (e.g. Docker daemon unreachable)
//   warning - half-built state the operator must resolve
//   info    - benign observation worth surfacing once
//
// code (optional): a stable token the caller can branch on programmatically.
//   'all-containers-exist'     - every required container already exists,
//                                init should auto-skip "docker compose up -d"
//                                and reuse what is already running.
//   'partial-containers-exist' - half-built state; init must NOT auto-up.
async function inspectInfra(opts = {}) {
  const issues = [];
  const distributed = opts.infra === 'distributed';
  const includeOllama = !!opts.includeOllama;
  const strictIsolation = !!opts.strictIsolation;
  const expectedMode = strictIsolation ? 'simulation' : 'normal';
  const expectedProject = opts.projectName || resolveProjectName();
  const dependencies = opts.dependencies || {};
  const cliInstalled = dependencies.isDockerCliInstalled || isDockerCliInstalled;
  const daemonRunning = dependencies.isDockerDaemonRunning || isDockerDaemonRunning;
  const runDocker = dependencies.dockerTry || dockerTry;
  const portBound = dependencies.isPortBound || isPortBound;

  // Step 1: is the docker CLI even installed? Distinguish "not installed" from
  // "installed but daemon stopped" - the user-visible fix is very different.
  if (opts.startDocker !== false) {
    if (!cliInstalled()) {
      issues.push({
        severity: 'error',
        message: t('preflight.dockerMissing'),
        hint: [
          t('preflight.dockerMissing.desktop'),
          t('preflight.dockerMissing.linux'),
          t('preflight.dockerMissing.retry'),
          t('preflight.dockerMissing.external'),
        ],
      });
      return issues;
    }

    // Step 2: CLI is present - is the daemon actually running?
    // `docker info` hits the daemon and surfaces "Cannot connect to the Docker daemon" early.
    if (!daemonRunning()) {
      issues.push({
        severity: 'error',
        message: t('preflight.dockerStopped'),
        hint: [
          t('preflight.dockerStopped.desktop'),
          t('preflight.dockerStopped.linux'),
          t('preflight.dockerStopped.noDocker'),
        ],
      });
      // No point checking ports/containers when the daemon is down.
      return issues;
    }
  }

  const skippedServices = [];
  const portCollisions = [];

  // Local TCP port collisions. We bind to 127.0.0.1 to mirror the compose
  // bind host. A port already bound (EADDRINUSE) signals an existing service
  // that may belong to another contexa-cli run, a host postgres, etc.
  const defaults = strictIsolation ? SIMULATION_PORTS : DEFAULT_INFRASTRUCTURE_PORTS;
  const postgresPort = configuredPort('CONTEXA_POSTGRES_PORT', defaults.postgres);
  const ollamaPort = configuredPort('CONTEXA_OLLAMA_PORT', defaults.ollama);
  const redisPort = configuredPort('CONTEXA_REDIS_PORT', defaults.redis);
  const zookeeperPort = configuredPort('CONTEXA_ZOOKEEPER_PORT', defaults.zookeeper);
  const kafkaPort = configuredPort('CONTEXA_KAFKA_PORT', defaults.kafka);

  const ports = [['PostgreSQL', postgresPort, 'postgres']];
  if (includeOllama) ports.push(['Ollama', ollamaPort, 'ollama']);
  if (distributed) {
    ports.push(
      ['Redis', redisPort, 'redis'],
      ['Zookeeper', zookeeperPort, 'zookeeper'],
      ['Kafka', kafkaPort, 'kafka']
    );
  }
  for (const [name, port, serviceKey] of ports) {
    if (await portBound(port)) portCollisions.push({ name, port, serviceKey });
  }

  // Container reuse decision.
  const services = [
    { key: 'postgres', container: containerName('postgres', expectedProject) }
  ];
  if (includeOllama) services.push({ key: 'ollama', container: containerName('ollama', expectedProject) });
  if (distributed) {
    services.push(
      { key: 'redis', container: containerName('redis', expectedProject) },
      { key: 'zookeeper', container: containerName('zookeeper', expectedProject) },
      { key: 'kafka', container: containerName('kafka', expectedProject) }
    );
  }

  const names = services.map(s => s.container);
  let existing = [];
  if (opts.startDocker !== false) {
    // dockerTry: array-arg invocation, no shell. {{.Names}} is a literal Go
    // template string and never reaches a shell parser this way.
    const psResult = runDocker(['ps', '-a', '--format', '{{.Names}}'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    if (!psResult.error && psResult.status === 0 && psResult.stdout) {
      existing = psResult.stdout.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
  }

  const present = names.filter(n => existing.includes(n));
  const missing = names.filter(n => !existing.includes(n));
  const ownedPresent = [];
  const ownershipConflicts = [];
  for (const service of services.filter(item => present.includes(item.container))) {
    const inspected = runDocker([
      'inspect', '--format',
      '{{index .Config.Labels "io.ctxa.owner"}}|{{index .Config.Labels "io.ctxa.mode"}}|{{index .Config.Labels "com.docker.compose.project"}}',
      service.container,
    ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    const identity = !inspected.error && inspected.status === 0 && inspected.stdout
      ? inspected.stdout.toString().trim().split('|') : [];
    if (identity[0] === 'contexa-cli' && identity[1] === expectedMode
        && identity[2] === expectedProject) {
      ownedPresent.push(service);
      if (!strictIsolation && !skippedServices.includes(service.key)) skippedServices.push(service.key);
    } else {
      ownershipConflicts.push(service.container);
    }
  }

  if (ownershipConflicts.length > 0) {
    issues.push({
      severity: 'error',
      code: 'container-ownership-conflict',
      message: t('preflight.containerOwnershipConflict', ownershipConflicts.join(', ')),
      hint: [t('preflight.containerOwnershipHint')],
    });
  }

  for (const collision of portCollisions) {
    const verifiedOwner = ownedPresent.some(service => service.key === collision.serviceKey);
    if (verifiedOwner && !strictIsolation) {
      issues.push({
        severity: 'info',
        code: 'owned-port-in-use',
        message: t('preflight.ownedPort', collision.port, collision.name),
        hint: [t('preflight.ownedPortHint')],
      });
    } else {
      issues.push({
        severity: strictIsolation || opts.startDocker !== false ? 'error' : 'warning',
        code: 'unverified-port-in-use',
        message: strictIsolation
          ? t('preflight.simulationPort', collision.port, collision.name)
          : t('preflight.unverifiedPort', collision.port, collision.name),
        hint: [t('preflight.unverifiedPortHint')],
      });
    }
  }

  if (strictIsolation && present.length > 0) {
    issues.push({
      severity: 'error',
      code: 'simulation-container-collision',
      message: t('preflight.simulationContainerCollision', present.join(', ')),
      hint: [t('preflight.simulationContainerCollisionHint')],
    });
  } else if (ownedPresent.length === names.length) {
    issues.push({
      severity: 'info',
      code: 'all-containers-exist',
      message: t('preflight.allContainersExist', present.join(', ')),
      hint: [
        t('preflight.allContainersExist.skip'),
        t('preflight.allContainersExist.drift', present.join(' ')),
      ],
    });
  } else if (ownedPresent.length > 0 && ownershipConflicts.length === 0) {
    issues.push({
      severity: 'info',
      code: 'partial-containers-exist',
      message: t('preflight.partialContainersExist', present.join(', '), missing.join(', ')),
      hint: [
        t('preflight.partialContainersExist.hint'),
      ],
    });
  }

  const allServices = services.map(s => s.key);
  const servicesToUp = allServices.filter(s => !skippedServices.includes(s));

  // Attach properties to the issues array for backward compatibility
  issues.servicesToUp = servicesToUp;
  issues.skippedServices = skippedServices;

  return issues;
}

function isPortBound(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    tester.once('error', () => finish(true));
    tester.once('listening', () => tester.close(() => finish(false)));
    tester.listen(port, '127.0.0.1');
    setTimeout(() => { try { tester.close(); } catch {} finish(false); }, 1500);
  });
}

module.exports = { inspectInfra, isPortBound };
