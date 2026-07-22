'use strict';

const crypto = require('crypto');
const net = require('net');
const http = require('http');
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
  const expectedInstallationId = opts.installationId || null;
  const dependencies = opts.dependencies || {};
  const cliInstalled = dependencies.isDockerCliInstalled || isDockerCliInstalled;
  const daemonRunning = dependencies.isDockerDaemonRunning || isDockerDaemonRunning;
  const runDocker = dependencies.dockerTry || dockerTry;
  const portBound = dependencies.isPortBound || isPortBound;
  const probeIdentity = dependencies.probeServiceIdentity || probeOwnedServiceIdentity;
  const probeHostIdentity =
    dependencies.probeHostServiceIdentity || probeHostServiceIdentity;
  const databaseName = process.env.CONTEXA_DB_NAME || 'contexa';
  const databaseUser = process.env.CONTEXA_DB_USERNAME || 'contexa';

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
  const portStates = [];

  // Local TCP port collisions. Probe an existing listener without binding the
  // port ourselves. Binding here creates a false EADDRINUSE race when several
  // independent projects run preflight concurrently.
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
    const bound = await portBound(port);
    const state = { name, port, serviceKey, bound, ownershipVerified: false,
      protocol: 'not-probed', identityVerified: false, fingerprint: null };
    portStates.push(state);
    if (bound) portCollisions.push({ name, port, serviceKey, state });
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
  const identityConflicts = [];
  const identityFingerprints = {};
  for (const service of services.filter(item => present.includes(item.container))) {
    const inspected = runDocker([
      'inspect', '--format',
      '{{index .Config.Labels "io.ctxa.owner"}}|{{index .Config.Labels "io.ctxa.mode"}}|{{index .Config.Labels "com.docker.compose.project"}}',
      service.container,
    ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    const identity = !inspected.error && inspected.status === 0 && inspected.stdout
      ? inspected.stdout.toString().trim().split('|') : [];
    const labelInspection = runDocker(
      ['inspect', '--format', '{{json .Config.Labels}}', service.container],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    let labels = {};
    try {
      labels = !labelInspection.error && labelInspection.status === 0 && labelInspection.stdout
        ? JSON.parse(labelInspection.stdout.toString().trim() || '{}') : {};
    } catch {
      labels = {};
    }
    if (identity[0] === 'contexa-cli' && identity[1] === expectedMode
        && identity[2] === expectedProject
        && expectedInstallationId
        && labels['io.ctxa.installation-id'] === expectedInstallationId
        && labels['com.docker.compose.service'] === service.key) {
      const probe = await probeIdentity(service.key, service.container, {
        runDocker,
        databaseName,
        databaseUser,
        hostPort: portStates.find(state => state.serviceKey === service.key)?.port,
      });
      if (probe && probe.verified) {
        ownedPresent.push(service);
        identityFingerprints[service.key] = nonSensitiveFingerprint(service.key, probe.identity);
        if (!skippedServices.includes(service.key)) skippedServices.push(service.key);
      } else {
        identityConflicts.push(service.key);
      }
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

  if (identityConflicts.length > 0) {
    issues.push({
      severity: 'error',
      code: 'service-identity-mismatch',
      message: t('preflight.serviceIdentityMismatch', identityConflicts.join(', ')),
      hint: [t('preflight.serviceIdentityHint')],
    });
  }

  for (const collision of portCollisions) {
    const verifiedOwner = ownedPresent.some(service => service.key === collision.serviceKey);
    collision.state.ownershipVerified = verifiedOwner;
    if (verifiedOwner) {
      collision.state.protocol = collision.serviceKey;
      collision.state.identityVerified = true;
      collision.state.fingerprint = identityFingerprints[collision.serviceKey] || null;
      issues.push({
        severity: 'info',
        code: 'owned-port-in-use',
        message: t('preflight.ownedPort', collision.port, collision.name),
        hint: [t('preflight.ownedPortHint')],
      });
    } else {
      const hostProbe = await probeHostIdentity(
        collision.serviceKey, '127.0.0.1', collision.port, {
          databaseName,
          databaseUser,
          timeoutMs: TIMEOUTS.httpHealthProbeMs,
        });
      collision.state.protocol = hostProbe.protocol || 'unknown';
      collision.state.identityVerified = !!hostProbe.verified;
      collision.state.fingerprint = nonSensitiveFingerprint(
        collision.serviceKey, hostProbe.identity || hostProbe.protocol || 'unknown');
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

  if (strictIsolation && present.length > 0 && ownedPresent.length !== names.length) {
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
  issues.identityFingerprints = identityFingerprints;
  issues.portStates = portStates;

  return issues;
}

async function probeHostServiceIdentity(serviceKey, host, port, context = {}) {
  const timeoutMs = Number(context.timeoutMs) > 0
    ? Number(context.timeoutMs) : TIMEOUTS.httpHealthProbeMs;
  if (serviceKey === 'ollama') return probeOllama(host, port, timeoutMs);
  if (serviceKey === 'postgres') {
    const user = String(context.databaseUser || 'contexa');
    const database = String(context.databaseName || 'contexa');
    const parameters = Buffer.from(`user\0${user}\0database\0${database}\0\0`, 'utf8');
    const startup = Buffer.alloc(8 + parameters.length);
    startup.writeInt32BE(startup.length, 0);
    startup.writeInt32BE(196608, 4);
    parameters.copy(startup, 8);
    return probeTcp(host, port, startup, timeoutMs, data => {
      if (data.length < 5 || !['R', 'E'].includes(String.fromCharCode(data[0]))) {
        return null;
      }
      const authCode = data[0] === 0x52 && data.length >= 9 ? data.readInt32BE(5) : -1;
      return {
        protocol: 'postgres',
        verified: authCode === 0,
        identity: authCode === 0
          ? `postgres:authenticated:${database}:${user}`
          : 'postgres:authentication-required',
      };
    });
  }
  if (serviceKey === 'redis') {
    const commands = Buffer.from(
      '*1\r\n$4\r\nPING\r\n*2\r\n$4\r\nINFO\r\n$6\r\nserver\r\n');
    return probeTcp(host, port, commands, timeoutMs, data => {
      const response = data.toString('utf8');
      if (/^-NOAUTH\b/m.test(response)) {
        return { protocol: 'redis', verified: false, identity: 'redis:authentication-required' };
      }
      const version = /^redis_version:([^\r\n]+)$/m.exec(response)?.[1]?.trim();
      return /^\+PONG\r?\n/.test(response) && version
        ? { protocol: 'redis', verified: true, identity: `redis:${version}` } : null;
    });
  }
  if (serviceKey === 'zookeeper') {
    return probeTcp(host, port, Buffer.from('srvr'), timeoutMs, data => {
      const response = data.toString('utf8');
      const version = /^Zookeeper version:\s*([^,\r\n]+)/mi.exec(response)?.[1]?.trim();
      return version
        ? { protocol: 'zookeeper', verified: true, identity: `zookeeper:${version}` } : null;
    });
  }
  if (serviceKey === 'kafka') {
    const client = Buffer.from('ctxa-preflight', 'utf8');
    const request = Buffer.alloc(4 + 2 + 2 + 4 + 2 + client.length + 4);
    request.writeInt32BE(request.length - 4, 0);
    request.writeInt16BE(3, 4);
    request.writeInt16BE(2, 6);
    request.writeInt32BE(2, 8);
    request.writeInt16BE(client.length, 12);
    client.copy(request, 14);
    request.writeInt32BE(-1, 14 + client.length);
    return probeTcp(host, port, request, timeoutMs, data => {
      const clusterId = kafkaMetadataClusterId(data, 2);
      return clusterId
        ? { protocol: 'kafka', verified: true, identity: `kafka:cluster:${clusterId}` }
        : null;
    });
  }
  return { protocol: 'unknown', verified: false, identity: 'unsupported-service' };
}

function kafkaMetadataClusterId(data, correlationId) {
  if (data.length < 20 || data.readInt32BE(4) !== correlationId) return null;
  let offset = 12;
  const brokerCount = data.readInt32BE(offset);
  offset += 4;
  if (brokerCount < 0 || brokerCount > 1000) return null;
  for (let index = 0; index < brokerCount; index++) {
    if (offset + 6 > data.length) return null;
    offset += 4;
    const hostLength = data.readInt16BE(offset);
    offset += 2;
    if (hostLength < 0 || offset + hostLength + 6 > data.length) return null;
    offset += hostLength + 4;
    const rackLength = data.readInt16BE(offset);
    offset += 2;
    if (rackLength >= 0) offset += rackLength;
    if (offset > data.length) return null;
  }
  if (offset + 2 > data.length) return null;
  const clusterIdLength = data.readInt16BE(offset);
  offset += 2;
  if (clusterIdLength <= 0 || offset + clusterIdLength + 4 > data.length) return null;
  return data.subarray(offset, offset + clusterIdLength).toString('utf8').trim() || null;
}

function probeTcp(host, port, payload, timeoutMs, classify) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result || { protocol: 'unknown', verified: false, identity: 'unrecognized' });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(payload));
    socket.on('data', chunk => {
      chunks.push(chunk);
      try {
        const result = classify(Buffer.concat(chunks));
        if (result) finish(result);
      } catch {
        finish(null);
      }
    });
    socket.once('timeout', () => finish({
      protocol: 'silent', verified: false, identity: 'timeout',
    }));
    socket.once('error', () => finish(null));
    socket.once('end', () => {
      if (!settled) {
        let result = null;
        try { result = classify(Buffer.concat(chunks)); } catch {}
        finish(result);
      }
    });
  });
}

function probeOllama(host, port, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result || { protocol: 'unknown', verified: false, identity: 'unrecognized' });
    };
    const request = http.get({ host, port, path: '/api/version', timeout: timeoutMs }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const version = typeof body.version === 'string' ? body.version : '';
          finish(version
            ? { protocol: 'ollama', verified: true, identity: `ollama:${version}` }
            : null);
        } catch {
          finish(null);
        }
      });
    });
    request.once('timeout', () => {
      request.destroy();
      finish({ protocol: 'silent', verified: false, identity: 'timeout' });
    });
    request.once('error', () => finish(null));
  });
}

function probeOwnedServiceIdentity(serviceKey, container, context) {
  let result;
  if (serviceKey === 'postgres') {
    result = context.runDocker([
      'exec', container, 'psql', '--no-password',
      '-U', context.databaseUser, '-d', context.databaseName,
      '-Atc', 'select current_database() || chr(124) || current_user',
    ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    const actual = dockerStdout(result);
    const expected = `${context.databaseName}|${context.databaseUser}`;
    return { verified: actual === expected, identity: actual };
  }
  if (serviceKey === 'redis') {
    result = context.runDocker(
      ['exec', container, 'redis-cli', '--raw', 'INFO', 'server'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    const version = /^redis_version:([^\r\n]+)$/m.exec(dockerStdout(result))?.[1]?.trim();
    return { verified: !!version, identity: version ? `redis:${version}` : '' };
  }
  if (serviceKey === 'kafka') {
    result = context.runDocker(
      ['exec', container, 'kafka-cluster', 'cluster-id', '--bootstrap-server', 'kafka:9093'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUTS.dockerInspectMs });
    const actual = dockerStdout(result);
    const clusterId = /^Cluster ID:\s*(\S+)$/m.exec(actual)?.[1]?.trim();
    return { verified: !!clusterId, identity: clusterId ? `kafka:cluster:${clusterId}` : '' };
  }
  if (serviceKey === 'zookeeper' || serviceKey === 'ollama') {
    return probeHostServiceIdentity(serviceKey, '127.0.0.1', context.hostPort, {
      timeoutMs: TIMEOUTS.httpHealthProbeMs,
    });
  }
  return { verified: true, identity: `${serviceKey}:ownership-labels` };
}

function dockerStdout(result) {
  if (!result || result.error || result.status !== 0 || !result.stdout) return '';
  return result.stdout.toString().trim();
}

function nonSensitiveFingerprint(serviceKey, identity) {
  const digest = crypto.createHash('sha256').update(`${serviceKey}|${identity || ''}`).digest('hex');
  return `sha256:${digest}`;
}

function isPortBound(port) {
  return new Promise((resolve) => {
    const tester = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (bound) => {
      if (done) return;
      done = true;
      tester.destroy();
      resolve(bound);
    };
    tester.setTimeout(1500);
    tester.once('connect', () => finish(true));
    tester.once('timeout', () => finish(false));
    tester.once('error', error => finish(!['ECONNREFUSED', 'EHOSTUNREACH']
      .includes(error && error.code)));
  });
}

module.exports = {
  inspectInfra,
  isPortBound,
  probeHostServiceIdentity,
};
