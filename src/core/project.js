'use strict';

// Project naming and contexa-owned-directory helpers.
//
// Centralizes:
//   - resolveProjectName()      : resolve the compose project / container prefix.
//                                  Reads CONTEXA_PROJECT env var, falls back to "contexa".
//                                  Other modules (init, simulate, preflight, i18n placeholders)
//                                  must use this so production / simulate / sim variants stay
//                                  consistent across the entire CLI.
//
//   - containerName(svc)        : build a docker container name for a given short service id
//                                  (e.g. "postgres" -> "contexa-postgres" or "ctxa-sim-postgres").
//
//   - osDefaultInfraDir(name)   : platform-appropriate default location for the contexa-owned
//                                  infrastructure files (docker-compose.yml).
//                                  Customers' project directories must NEVER be touched for
//                                  infra files - those go under contexa's own home.
//
//   - resolveInfraDir(name, opts): user-specified --infra-dir wins; otherwise OS default.
//
// The helpers intentionally avoid filesystem side effects. Callers (injector, init, simulate)
// must mkdirp on demand.

const path = require('path');
const os = require('os');
const fs = require('fs-extra');

function resolveProjectName(fallbackName = 'contexa') {
  const envName = process.env.CONTEXA_PROJECT && process.env.CONTEXA_PROJECT.trim();
  return sanitizeProjectName(envName || fallbackName || 'contexa');
}

function containerName(svc, projectName) {
  if (!svc || typeof svc !== 'string') {
    throw new Error('containerName: service short-name is required');
  }
  const project = projectName
    ? sanitizeProjectName(projectName)
    : resolveProjectName();
  return `${project}-${svc}`;
}

// OS-specific contexa home for storing per-project infrastructure artifacts
// (docker-compose.yml). Returns the directory path; caller decides
// whether to create it.
//
//   Linux / macOS : $XDG_CONFIG_HOME/contexa/<projectName>
//                   else $HOME/.contexa/<projectName>
//   Windows       : %LOCALAPPDATA%\Contexa\<projectName>
//                   else %USERPROFILE%\AppData\Local\Contexa\<projectName>
function osContexaHome() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || (process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local'))
      || os.homedir();
    return path.join(localAppData, 'Contexa');
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim();
  if (xdg) return path.join(xdg, 'contexa');
  return path.join(os.homedir(), '.contexa');
}

function osDefaultInfraDir(projectName) {
  return path.join(osContexaHome(), sanitizeProjectName(projectName));
}

// Resolve the effective infrastructure directory: explicit --infra-dir wins,
// otherwise OS default. Returns an absolute path.
function resolveInfraDir(projectName, opts = {}) {
  const explicit = opts.infraDir && String(opts.infraDir).trim();
  const dir = explicit || osDefaultInfraDir(projectName);
  return path.resolve(dir);
}

function pathWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative));
}

function pathsEqual(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function unsafeInfraPathError(message) {
  const error = new Error(message);
  error.code = 'UNSAFE_INFRA_PATH';
  error.messageKey = 'init.error.unsafeInfraPath';
  error.messageArgs = [];
  return error;
}

async function canonicalBoundaryPath(inputPath) {
  const resolved = path.resolve(inputPath);
  let existing = resolved;
  const suffix = [];
  while (!await fs.pathExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const realpath = fs.realpathSync.native || fs.realpathSync;
  const canonicalExisting = realpath(existing);
  return path.resolve(canonicalExisting, ...suffix);
}

async function assertSafeInfraDir(projectDir, infraDir, requestedPath = null) {
  if (!infraDir) return null;
  const raw = requestedPath === null || requestedPath === undefined ? '' : String(requestedPath).trim();
  if (raw && raw.replace(/\\/g, '/').split('/').includes('..')) {
    throw unsafeInfraPathError(`Infrastructure path must not contain parent traversal: ${raw}`);
  }
  const resolvedCandidate = path.resolve(infraDir);
  const allowedVolumeRoots = new Set([projectDir, osContexaHome()]
    .map(value => path.parse(path.resolve(value)).root.toLowerCase()));
  if (!allowedVolumeRoots.has(path.parse(resolvedCandidate).root.toLowerCase())) {
    throw unsafeInfraPathError(`Infrastructure path changes drive or UNC root: ${resolvedCandidate}`);
  }
  const [canonicalProjectRoot, canonicalContexaHome, canonicalCandidate] = await Promise.all([
    canonicalBoundaryPath(projectDir),
    canonicalBoundaryPath(osContexaHome()),
    canonicalBoundaryPath(resolvedCandidate),
  ]);
  const volumeRoot = path.parse(canonicalCandidate).root;
  if (pathsEqual(canonicalCandidate, volumeRoot)
      || pathsEqual(canonicalCandidate, canonicalProjectRoot)
      || pathsEqual(canonicalCandidate, canonicalContexaHome)) {
    throw unsafeInfraPathError(`Infrastructure path must be a dedicated child directory: ${canonicalCandidate}`);
  }
  if (!pathWithinRoot(canonicalProjectRoot, canonicalCandidate)
      && !pathWithinRoot(canonicalContexaHome, canonicalCandidate)) {
    throw unsafeInfraPathError([
      `Infrastructure path is outside Contexa-owned roots: ${path.resolve(infraDir)}`,
      `Allowed project root: ${canonicalProjectRoot}`,
      `Allowed Contexa home: ${canonicalContexaHome}`,
    ].join('\n'));
  }
  return canonicalCandidate;
}

// Project names end up as compose project + container prefix + filesystem path.
// Disallow characters that compose / docker / OS path semantics dislike.
function sanitizeProjectName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'default';
  // compose project name: lowercase letters, digits, hyphen, underscore
  const replaced = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return replaced || 'default';
}

module.exports = {
  resolveProjectName,
  containerName,
  osContexaHome,
  osDefaultInfraDir,
  resolveInfraDir,
  assertSafeInfraDir,
  canonicalBoundaryPath,
  pathsEqual,
  sanitizeProjectName,
};
