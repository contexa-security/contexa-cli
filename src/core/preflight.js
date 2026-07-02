'use strict';

const net = require('net');
const { containerName } = require('./project');
const { dockerTry, isDockerCliInstalled, isDockerDaemonRunning } = require('./docker');

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

  // Step 1: is the docker CLI even installed? Distinguish "not installed" from
  // "installed but daemon stopped" - the user-visible fix is very different.
  if (opts.startDocker !== false) {
    if (!isDockerCliInstalled()) {
      issues.push({
        severity: 'error',
        message: 'Docker is not installed on this machine.',
        hint: [
          'Install Docker Desktop:',
          '  Windows / macOS : https://www.docker.com/products/docker-desktop',
          '  Linux           : https://docs.docker.com/engine/install/',
          'After installation, open a new terminal and re-run "contexa init".',
          'Docker is only required for simulation or distributed infrastructure.',
          'If you cannot install Docker, run the normal guided setup with "contexa init"',
          'and use your own PostgreSQL or managed infrastructure instead.',
        ],
      });
      return issues;
    }

    // Step 2: CLI is present - is the daemon actually running?
    // `docker info` hits the daemon and surfaces "Cannot connect to the Docker daemon" early.
    if (!isDockerDaemonRunning()) {
      issues.push({
        severity: 'error',
        message: 'Docker is installed but the daemon is not running.',
        hint: [
          'Windows / macOS : open Docker Desktop and wait for the whale icon to settle.',
          'Linux           : sudo systemctl start docker',
          'If you selected infrastructure setup, re-run with "contexa init --no-docker"',
          'to generate compose files without starting containers.',
        ],
      });
      // No point checking ports/containers when the daemon is down.
      return issues;
    }
  }

  const skippedServices = [];

  // Local TCP port collisions. We bind to 127.0.0.1 to mirror the compose
  // bind host. A port already bound (EADDRINUSE) signals an existing service
  // that may belong to another contexa-cli run, a host postgres, etc.
  const postgresPort = parseInt(process.env.CONTEXA_POSTGRES_PORT || '5432', 10);
  const ollamaPort = parseInt(process.env.CONTEXA_OLLAMA_PORT || '11434', 10);
  const redisPort = parseInt(process.env.CONTEXA_REDIS_PORT || '6379', 10);
  const zookeeperPort = parseInt(process.env.CONTEXA_ZOOKEEPER_PORT || '2181', 10);
  const kafkaPort = parseInt(process.env.CONTEXA_KAFKA_PORT || '9092', 10);

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
    if (await isPortBound(port)) {
      skippedServices.push(serviceKey);
      issues.push({
        severity: 'warning',
        message: `Port ${port} (${name}) is already in use on 127.0.0.1.`,
        hint: [
          `Local service ${name} is already running on host. Contexa will skip starting this docker container and reuse the host service.`,
        ],
      });
    }
  }

  // Container reuse decision.
  const services = [
    { key: 'postgres', container: containerName('postgres') }
  ];
  if (includeOllama) services.push({ key: 'ollama', container: containerName('ollama') });
  if (distributed) {
    services.push(
      { key: 'redis', container: containerName('redis') },
      { key: 'zookeeper', container: containerName('zookeeper') },
      { key: 'kafka', container: containerName('kafka') }
    );
  }

  const names = services.map(s => s.container);
  let existing = [];
  // dockerTry: array-arg invocation, no shell. {{.Names}} is a literal Go
  // template string and never reaches a shell parser this way.
  const psResult = dockerTry(['ps', '-a', '--format', '{{.Names}}'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  if (!psResult.error && psResult.status === 0 && psResult.stdout) {
    existing = psResult.stdout.toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  // If a container already exists, skip it to avoid conflicts and data loss
  for (const svc of services) {
    if (existing.includes(svc.container)) {
      if (!skippedServices.includes(svc.key)) {
        skippedServices.push(svc.key);
      }
    }
  }

  const present = names.filter(n => existing.includes(n));
  const missing = names.filter(n => !existing.includes(n));
  if (present.length === names.length) {
    issues.push({
      severity: 'info',
      code: 'all-containers-exist',
      message: `Existing infrastructure detected (${present.join(', ')}); reusing it.`,
      hint: [
        `"docker compose up -d" will be skipped this run.`,
        `If the existing config has drifted from what contexa expects, run`,
        `  docker rm -f ${present.join(' ')}`,
        `and re-run "contexa init" to recreate them with fresh defaults.`,
      ],
    });
  } else if (present.length > 0) {
    issues.push({
      severity: 'info',
      code: 'partial-containers-exist',
      message: `Existing container(s) detected: ${present.join(', ')}. Remaining missing container(s): ${missing.join(', ')}.`,
      hint: [
        `Contexa will skip recreating existing containers and only start the missing ones.`,
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

module.exports = { inspectInfra };
