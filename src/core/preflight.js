'use strict';

const net = require('net');
const { execSync } = require('child_process');
const { resolveProjectName, containerName } = require('./project');

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

  // Step 1: is the docker CLI even installed? Distinguish "not installed" from
  // "installed but daemon stopped" - the user-visible fix is very different.
  if (opts.startDocker !== false) {
    let cliInstalled = true;
    try {
      execSync('docker --version', { stdio: 'ignore', timeout: 3000 });
    } catch {
      cliInstalled = false;
    }
    if (!cliInstalled) {
      issues.push({
        severity: 'error',
        message: 'Docker is not installed on this machine.',
        hint: [
          'Install Docker Desktop:',
          '  Windows / macOS : https://www.docker.com/products/docker-desktop',
          '  Linux           : https://docs.docker.com/engine/install/',
          'After installation, open a new terminal and re-run "contexa init".',
          'If you cannot install Docker, re-run with "--no-infra" to skip',
          'infrastructure provisioning - you will need to run PostgreSQL, Ollama',
          '(and Redis/Kafka if --distributed) yourself before starting the app.',
        ],
      });
      return issues;
    }

    // Step 2: CLI is present - is the daemon actually running?
    // `docker info` hits the daemon and surfaces "Cannot connect to the Docker daemon" early.
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    } catch {
      issues.push({
        severity: 'error',
        message: 'Docker is installed but the daemon is not running.',
        hint: [
          'Windows / macOS : open Docker Desktop and wait for the whale icon to settle.',
          'Linux           : sudo systemctl start docker',
          'Or re-run "contexa init --no-docker" to generate compose/initdb files',
          'without starting containers (you can `docker compose up -d` later).',
        ],
      });
      // No point checking ports/containers when the daemon is down.
      return issues;
    }
  }

  // Local TCP port collisions. We bind to 127.0.0.1 to mirror the compose
  // bind host. A port already bound (EADDRINUSE) signals an existing service
  // that may belong to another contexa-cli run, a host postgres, etc.
  const ports = [['PostgreSQL', 5432], ['Ollama', 11434]];
  if (distributed) {
    ports.push(['Redis', 6379], ['Zookeeper', 2181], ['Kafka', 9092]);
  }
  for (const [name, port] of ports) {
    if (await isPortBound(port)) {
      issues.push({
        severity: 'warning',
        message: `Port ${port} (${name}) is already in use on 127.0.0.1.`,
        hint: [
          `Stop the conflicting service, OR set COMPOSE_BIND_HOST=0.0.0.0 to bind elsewhere,`,
          `OR re-run with --no-docker and start compose manually after resolving the conflict.`,
        ],
      });
    }
  }

  // Container reuse decision.
  //
  // The docker-compose.yml we generate pins each container_name to
  // ${CONTEXA_PROJECT}-{postgres,ollama,...}. If those containers already
  // exist on the host, "docker compose up -d" fails with a name conflict.
  // The operator's intent in that situation is overwhelmingly: "I already
  // have the infrastructure running, just use it." So our policy is:
  //
  //   - All required containers already exist (running or stopped)
  //         -> auto-skip "docker compose up -d". Reuse what's there.
  //
  //   - SOME but not all required containers exist
  //         -> half-built state. Surface as a warning so the operator can
  //            either remove the stragglers and let init recreate, or finish
  //            the missing ones manually. We do NOT auto-up because compose
  //            would then conflict on the names that already exist.
  //
  //   - None of the required containers exist
  //         -> normal path; init proceeds with "docker compose up -d".
  const names = [containerName('postgres'), containerName('ollama')];
  if (distributed) names.push(containerName('redis'), containerName('zookeeper'), containerName('kafka'));
  let existing = [];
  try {
    const out = execSync('docker ps -a --format "{{.Names}}"',
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    existing = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { /* docker not reachable from this codepath - ignore */ }
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
      severity: 'warning',
      code: 'partial-containers-exist',
      message: `Half-built infrastructure: ${present.length} container(s) exist, ${missing.length} are missing.`,
      hint: [
        `Existing : ${present.join(', ')}`,
        `Missing  : ${missing.join(', ')}`,
        `"docker compose up -d" would conflict on the existing names. Two options:`,
        `  1) Remove the existing ones and let contexa recreate the full stack:`,
        `       docker rm -f ${present.join(' ')}`,
        `       (then re-run "contexa init")`,
        `  2) Run side-by-side without touching them:`,
        `       contexa init --simulate    (uses ctxa-sim-* containers on +20000 ports)`,
      ],
    });
  }

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
