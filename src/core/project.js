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
//                                  (e.g. "ollama" -> "contexa-ollama" or "ctxa-sim-ollama").
//
//   - osDefaultInfraDir(name)   : platform-appropriate default location for the contexa-owned
//                                  infrastructure files (docker-compose.yml + initdb/*).
//                                  Customers' project directories must NEVER be touched for
//                                  infra files - those go under contexa's own home.
//
//   - resolveInfraDir(name, opts): user-specified --infra-dir wins; otherwise OS default.
//
// The helpers intentionally avoid filesystem side effects. Callers (injector, init, simulate)
// must mkdirp on demand.

const path = require('path');
const os = require('os');

function resolveProjectName() {
  return (process.env.CONTEXA_PROJECT && process.env.CONTEXA_PROJECT.trim())
    || 'contexa';
}

function containerName(svc) {
  if (!svc || typeof svc !== 'string') {
    throw new Error('containerName: service short-name is required');
  }
  return `${resolveProjectName()}-${svc}`;
}

// OS-specific contexa home for storing per-project infrastructure artifacts
// (docker-compose.yml, initdb/*.sql). Returns the directory path; caller decides
// whether to create it.
//
//   Linux / macOS : $XDG_CONFIG_HOME/contexa/<projectName>
//                   else $HOME/.contexa/<projectName>
//   Windows       : %LOCALAPPDATA%\Contexa\<projectName>
//                   else %USERPROFILE%\AppData\Local\Contexa\<projectName>
function osDefaultInfraDir(projectName) {
  const safeName = sanitizeProjectName(projectName);
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || (process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local'))
      || os.homedir();
    return path.join(localAppData, 'Contexa', safeName);
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim();
  if (xdg) return path.join(xdg, 'contexa', safeName);
  return path.join(os.homedir(), '.contexa', safeName);
}

// Resolve the effective infrastructure directory: explicit --infra-dir wins,
// otherwise OS default. Returns an absolute path.
function resolveInfraDir(projectName, opts = {}) {
  const explicit = opts.infraDir && String(opts.infraDir).trim();
  const dir = explicit || osDefaultInfraDir(projectName);
  return path.resolve(dir);
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
  osDefaultInfraDir,
  resolveInfraDir,
  sanitizeProjectName,
};
