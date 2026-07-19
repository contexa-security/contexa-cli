'use strict';

// Centralized docker / docker-compose execution helpers.
//
// Every docker invocation in the CLI MUST go through this module. The
// previous code spread execSync(`docker ...`) calls across init.js /
// preflight.js / simulate.js, which interpolated arbitrary values into
// a shell command. Two problems:
//
//   1. Shell injection surface. A model name like "a;rm -rf /" would expand
//      into the shell unmodified. This module passes args as an array to
//      spawnSync without `shell: true`, so the OS executes docker directly
//      with each argument as a separate argv entry.
//
//   2. Inconsistent error semantics. execSync throws on non-zero exit but
//      spawnSync returns a result object. Mixing both styles made callers
//      unsure whether to wrap in try/catch. dockerSync() restores the
//      throw-on-non-zero contract, dockerTry() returns the result object
//      so callers that need to branch on status can do so cleanly.

const { spawnSync } = require('child_process');
const { TIMEOUTS } = require('./timeouts');
const DEFAULT_DOCKER_TIMEOUT_MS = TIMEOUTS.dockerDefaultMs;

function boundedOptions(opts, defaultTimeoutMs = DEFAULT_DOCKER_TIMEOUT_MS) {
  return opts.timeout === undefined ? { ...opts, timeout: defaultTimeoutMs } : opts;
}

// Run `docker <args>` and throw if the process exits non-zero or fails to
// spawn. Mirrors execSync's contract so existing call sites can switch over
// without restructuring control flow.
function dockerSync(args, opts = {}) {
  const r = spawnSync('docker', args, { ...boundedOptions(opts), shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = new Error(`docker ${args.join(' ')} exited with status ${r.status}`);
    err.status = r.status;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return r;
}

// Run `docker <args>` without throwing. Caller inspects the result object.
// Use this when non-zero exit is a meaningful signal (e.g. health probes,
// presence checks) rather than an error.
function dockerTry(args, opts = {}) {
  return spawnSync('docker', args, { ...boundedOptions(opts), shell: false });
}

// Run `docker compose <args>` in the given working directory. Same array-arg
// safety guarantee as dockerSync. cwd is required because compose is always
// scoped to a specific directory in this CLI.
function dockerCompose(args, opts = {}) {
  return spawnSync('docker', ['compose', ...args], { ...boundedOptions(opts), shell: false });
}

// True if the docker CLI is on PATH. Used by detector.js / preflight.js to
// distinguish "not installed" from "installed but daemon stopped".
function isDockerCliInstalled(timeoutMs = TIMEOUTS.dockerCliProbeMs) {
  const r = dockerTry(['--version'], { stdio: 'ignore', timeout: timeoutMs });
  return !r.error && r.status === 0;
}

// True if the docker daemon is reachable. Assumes isDockerCliInstalled()
// already returned true.
function isDockerDaemonRunning(timeoutMs = TIMEOUTS.dockerInspectMs) {
  const r = dockerTry(['info'], { stdio: 'ignore', timeout: timeoutMs });
  return !r.error && r.status === 0;
}

module.exports = {
  dockerSync,
  dockerTry,
  dockerCompose,
  DEFAULT_DOCKER_TIMEOUT_MS,
  isDockerCliInstalled,
  isDockerDaemonRunning,
};
