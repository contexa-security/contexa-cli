'use strict';

const net = require('net');
const { execSync } = require('child_process');

// Pre-flight checks for the docker-driven infrastructure init step.
// Returns an array of { severity, message, hint } records. The caller decides
// whether to abort, prompt, or proceed based on severity.
//
// severity:
//   error   - infrastructure cannot start (e.g. Docker daemon unreachable)
//   warning - likely conflict but compose may still succeed
//   info    - benign observation worth surfacing once
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

  // Container name collisions. compose will REUSE a stopped container of the
  // same name silently, which can mask config drift. Surface this so the user
  // can decide whether to "docker rm -f" first.
  const names = ['contexa-postgres', 'contexa-ollama'];
  if (distributed) names.push('contexa-redis', 'contexa-zookeeper', 'contexa-kafka');
  let existing = [];
  try {
    const out = execSync('docker ps -a --format "{{.Names}}"',
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    existing = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { /* docker not reachable from this codepath - ignore */ }
  for (const n of names) {
    if (existing.includes(n)) {
      issues.push({
        severity: 'info',
        message: `Container "${n}" already exists.`,
        hint: [
          `compose will reuse it. If its config has drifted, run "docker rm -f ${n}" before re-init.`,
        ],
      });
    }
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
