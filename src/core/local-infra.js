'use strict';

// Local services shared by every project on this computer.
//
// One PostgreSQL (with pgvector); when a project uses Ollama and no Ollama is running already,
// one Ollama container; and when Contexa provides the sign-in, a local mail inbox (Mailpit) that
// receives the one-time sign-in codes, so the second sign-in step works without a mail server.
// Each project gets a database of its own inside that PostgreSQL, so two projects never share
// Contexa data, and models are downloaded once.
//
// The services live in the Docker Compose project "contexa-local", defined in
// <Contexa home>/local/docker-compose.yml, and only bind to 127.0.0.1. Ports are picked from
// free ones, so an existing PostgreSQL or Ollama on the default ports is left alone. State
// (ports, registered projects) is kept next to the compose file in state.json.

const crypto = require('crypto');
const fs = require('fs-extra');
const http = require('http');
const net = require('net');
const nodeFs = require('fs');
const path = require('path');
const { composeKind, dockerCompose, dockerTry, isDockerCliInstalled, isDockerDaemonRunning } = require('./docker');
const { processIsRunning } = require('./manifest');
const { osContexaHome } = require('./project');

const COMPOSE_PROJECT = 'contexa-local';
const POSTGRES_CONTAINER = 'contexa-local-postgres';
const OLLAMA_CONTAINER = 'contexa-local-ollama';
const MAIL_CONTAINER = 'contexa-local-mail';
const CONTAINERS = [POSTGRES_CONTAINER, OLLAMA_CONTAINER, MAIL_CONTAINER];
const OWNER_LABEL = 'io.ctxa.owner';
const OWNER_VALUE = 'contexa-cli';
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const OLLAMA_IMAGE = 'ollama/ollama:0.18.2';
const MAIL_IMAGE = 'axllent/mailpit:v1.33';
const DB_USER = 'contexa';
const DB_PASSWORD = 'contexa';
const range = (first, count) => Array.from({ length: count }, (_, index) => first + index);
const POSTGRES_PORTS = range(55432, 30);
const OLLAMA_PORTS = [11434, ...range(51434, 30)];
const MAIL_SMTP_PORTS = range(51025, 30);
const MAIL_UI_PORTS = range(58025, 30);
const NATIVE_OLLAMA_URL = 'http://127.0.0.1:11434';

// Test hook: CONTEXA_TEST_LOCAL_SERVICES=fake plans and "starts" the services without Docker,
// so the project-side behaviour (transactions, locks, reset) can be tested anywhere.
function fakeServices() {
  return process.env.CONTEXA_TEST_LOCAL_SERVICES === 'fake';
}

function localHome() {
  return path.join(osContexaHome(), 'local');
}

function statePath() {
  return path.join(localHome(), 'state.json');
}

function composePath() {
  return path.join(localHome(), 'docker-compose.yml');
}

async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(statePath(), 'utf8'));
    return { version: 1, postgres: null, ollama: null, mail: null, projects: {}, ...state };
  } catch {
    return { version: 1, postgres: null, ollama: null, mail: null, projects: {} };
  }
}

async function saveState(state) {
  await fs.ensureDir(localHome());
  const target = statePath();
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  // Windows refuses the replace for a moment while another program (a virus scanner, a reader)
  // has the file open.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.move(temporary, target, { overwrite: true });
      return;
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await fs.remove(temporary).catch(() => {});
        throw error;
      }
      await sleep(100);
    }
  }
}

const STATE_LOCK_WAIT_MS = 20 * 60 * 1000;

function stateLockPath() {
  return path.join(localHome(), '.lock');
}

// Every change to the shared state, and to the services it describes, happens under one lock for
// this computer: two contexa commands running at the same time (two projects, two terminals) wait
// for each other instead of losing each other's changes. A lock whose process has ended is taken
// over.
async function withStateLock(work) {
  const file = stateLockPath();
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  const token = crypto.randomUUID();
  for (;;) {
    try {
      await fs.ensureDir(localHome());
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      const owner = await fs.readJson(file).catch(() => null);
      const age = await fs.stat(file).then(stat => Date.now() - stat.mtimeMs).catch(() => 0);
      // Unreadable for a moment while its owner writes it; only an old unreadable file is stale.
      const stale = owner ? !processIsRunning(Number(owner.pid)) : age > 10000;
      if (stale) {
        const aside = `${file}.stale-${token}`;
        await fs.rename(file, aside).then(() => fs.remove(aside)).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        const busy = localError('LOCAL_STATE_BUSY', owner ? `PID ${owner.pid}` : file);
        busy.messageKey = 'local.error.stateBusy';
        busy.messageArgs = [owner ? owner.pid : '-'];
        throw busy;
      }
      await sleep(300);
    }
  }
  try {
    return await work();
  } finally {
    const owner = await fs.readJson(file).catch(() => null);
    if (owner && owner.token === token) await fs.remove(file).catch(() => {});
  }
}

// One key per project folder, however it was reached: through --dir, from inside the folder, or
// through a symbolic link (macOS keeps temporary folders behind /var -> /private/var). Without the
// real path, the same project could get a second database (F-53).
function canonicalProjectKey(projectDir) {
  let resolved = path.resolve(projectDir);
  try {
    resolved = (nodeFs.realpathSync.native || nodeFs.realpathSync)(resolved);
  } catch {
    // The folder is gone (a project removed by hand); its resolved path is the key it had.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// --- probes ---------------------------------------------------------------------------------

function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function firstFreePort(candidates, exclude = []) {
  for (const candidate of candidates) {
    if (!exclude.includes(candidate) && await portIsFree(candidate)) return candidate;
  }
  return null;
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, json });
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ status: 0, json: null }));
  });
}

async function ollamaModels(baseUrl) {
  const response = await httpGet(`${baseUrl}/api/tags`);
  if (response.status !== 200 || !response.json || !Array.isArray(response.json.models)) return null;
  return response.json.models.map(model => model.name);
}

function hasModel(models, name) {
  const wanted = name.includes(':') ? name : `${name}:latest`;
  return models.some(model => model === name || model === wanted);
}

function containerState(name) {
  const result = dockerTry(['inspect', '--format', '{{json .}}', name], { stdio: 'pipe', timeout: 10000 });
  if (result.error || result.status !== 0) return { exists: false };
  try {
    const info = JSON.parse(result.stdout.toString());
    const labels = (info.Config && info.Config.Labels) || {};
    const health = info.State && info.State.Health ? info.State.Health.Status : null;
    return {
      exists: true,
      owned: labels[OWNER_LABEL] === OWNER_VALUE,
      running: !!(info.State && info.State.Running),
      health,
    };
  } catch {
    return { exists: true, owned: false, running: false, health: null };
  }
}

// The 127.0.0.1 host port a container publishes for one of its ports, also while it is stopped.
function containerHostPort(name, containerPort) {
  const result = dockerTry(['inspect', '--format', '{{json .HostConfig.PortBindings}}', name], { stdio: 'pipe', timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  try {
    const bindings = JSON.parse(result.stdout.toString()) || {};
    const binding = (bindings[containerPort] || [])[0];
    const port = binding ? Number(binding.HostPort) : NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function dockerStatus() {
  const cli = isDockerCliInstalled();
  const daemon = cli && isDockerDaemonRunning();
  return { cli, daemon, compose: daemon ? composeKind() : null };
}

// --- plan -------------------------------------------------------------------------------------

// What has to happen for this project. Nothing is started here.
//   needOllama: the selected provider uses Ollama for chat or embeddings
//   needPostgres: false when the project uses a PostgreSQL of its own (--db-url)
//   wantMail: Contexa provides the sign-in, so its one-time codes need a mailbox (best effort)
async function planLocalServices({ needOllama, needPostgres = true, wantMail = false }) {
  const state = await loadState();
  if (fakeServices()) {
    return {
      docker: { cli: true, daemon: true },
      state,
      postgres: needPostgres ? { action: 'reuse', port: 55432 } : null,
      ollama: needOllama ? { action: 'reuse', mode: 'native', port: 11434, baseUrl: NATIVE_OLLAMA_URL } : null,
      mail: wantMail ? { action: 'reuse', smtpPort: 51025, uiPort: 58025 } : null,
      problems: [],
    };
  }
  const docker = dockerStatus();
  const plan = { docker, state, postgres: null, ollama: null, mail: null, problems: [] };
  const reserved = [];

  if (needPostgres) {
    const container = docker.daemon ? containerState(POSTGRES_CONTAINER) : { exists: false };
    const port = container.exists && container.owned
      ? (state.postgres && state.postgres.port) || containerHostPort(POSTGRES_CONTAINER, '5432/tcp') : null;
    if (container.exists && !container.owned) {
      plan.problems.push({ code: 'POSTGRES_CONTAINER_FOREIGN', args: [POSTGRES_CONTAINER] });
    } else if (port) {
      // Also when the state file is gone: the container Contexa created is taken over.
      plan.postgres = { action: container.running ? 'reuse' : 'start', port };
      reserved.push(port);
    } else if (!docker.cli) {
      plan.problems.push({ code: 'DOCKER_MISSING' });
    } else if (!docker.daemon) {
      plan.problems.push({ code: 'DOCKER_STOPPED' });
    } else if (!docker.compose) {
      plan.problems.push({ code: 'DOCKER_COMPOSE_MISSING' });
    } else {
      const port = await firstFreePort(POSTGRES_PORTS);
      if (!port) plan.problems.push({ code: 'NO_FREE_PORT', args: ['PostgreSQL'] });
      else { plan.postgres = { action: 'create', port }; reserved.push(port); }
    }
  }

  if (needOllama) {
    const nativeModels = await ollamaModels(NATIVE_OLLAMA_URL);
    const container = docker.daemon ? containerState(OLLAMA_CONTAINER) : { exists: false };
    const port = container.exists && container.owned
      ? (state.ollama && state.ollama.mode === 'docker' && state.ollama.port) || containerHostPort(OLLAMA_CONTAINER, '11434/tcp')
      : null;
    if (port && !(nativeModels && port === 11434 && !container.running)) {
      plan.ollama = {
        action: container.running ? 'reuse' : 'start',
        mode: 'docker',
        port,
        baseUrl: `http://127.0.0.1:${port}`,
      };
    } else if (nativeModels) {
      plan.ollama = { action: 'reuse', mode: 'native', port: 11434, baseUrl: NATIVE_OLLAMA_URL };
    } else if (!docker.cli) {
      plan.problems.push({ code: 'OLLAMA_MISSING' });
    } else if (!docker.daemon) {
      plan.problems.push({ code: 'DOCKER_STOPPED' });
    } else if (!docker.compose) {
      plan.problems.push({ code: 'DOCKER_COMPOSE_MISSING' });
    } else {
      const port = await firstFreePort(OLLAMA_PORTS, reserved);
      if (!port) plan.problems.push({ code: 'NO_FREE_PORT', args: ['Ollama'] });
      else { plan.ollama = { action: 'create', mode: 'docker', port, baseUrl: `http://127.0.0.1:${port}` }; reserved.push(port); }
    }
  }

  if (wantMail && docker.daemon && docker.compose) {
    const container = containerState(MAIL_CONTAINER);
    const ports = container.exists && container.owned
      ? (state.mail || { smtpPort: containerHostPort(MAIL_CONTAINER, '1025/tcp'), uiPort: containerHostPort(MAIL_CONTAINER, '8025/tcp') })
      : null;
    if (ports && ports.smtpPort && ports.uiPort) {
      plan.mail = { action: container.running ? 'reuse' : 'start', smtpPort: ports.smtpPort, uiPort: ports.uiPort };
    } else if (!container.exists) {
      const smtpPort = await firstFreePort(MAIL_SMTP_PORTS, reserved);
      const uiPort = smtpPort && await firstFreePort(MAIL_UI_PORTS, [...reserved, smtpPort]);
      if (smtpPort && uiPort) plan.mail = { action: 'create', smtpPort, uiPort };
    }
  }
  return plan;
}

// --- compose ----------------------------------------------------------------------------------

// `standalone` is the older docker-compose (v1): it needs a version line and does not know `name`
// (the project name is passed with -p either way).
function renderCompose({ postgresPort, ollamaPort, mail, standalone = false }) {
  const label = `      ${OWNER_LABEL}: ${OWNER_VALUE}`;
  const lines = [
    '# Local services for Contexa, managed by `contexa init` and `contexa reset`.',
    '# Shared by every project on this computer; each project has its own database.',
    standalone ? 'version: "3.8"' : `name: ${COMPOSE_PROJECT}`,
    '',
    'services:',
  ];
  if (postgresPort) {
    lines.push(
      '  postgres:',
      `    image: ${POSTGRES_IMAGE}`,
      `    container_name: ${POSTGRES_CONTAINER}`,
      '    labels:',
      label,
      '    environment:',
      `      POSTGRES_USER: ${DB_USER}`,
      `      POSTGRES_PASSWORD: ${DB_PASSWORD}`,
      '      POSTGRES_DB: contexa',
      '    ports:',
      `      - "127.0.0.1:${postgresPort}:5432"`,
      '    volumes:',
      '      - postgres-data:/var/lib/postgresql/data',
      '    healthcheck:',
      `      test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d contexa"]`,
      '      interval: 5s',
      '      timeout: 5s',
      '      retries: 30',
      '    restart: unless-stopped',
    );
  }
  if (ollamaPort) {
    lines.push(
      '  ollama:',
      `    image: ${OLLAMA_IMAGE}`,
      `    container_name: ${OLLAMA_CONTAINER}`,
      '    labels:',
      label,
      '    environment:',
      '      OLLAMA_KEEP_ALIVE: 30m',
      '    ports:',
      `      - "127.0.0.1:${ollamaPort}:11434"`,
      '    volumes:',
      '      - ollama-data:/root/.ollama',
      '    restart: unless-stopped',
    );
  }
  if (mail) {
    lines.push(
      '  mail:',
      `    image: ${MAIL_IMAGE}`,
      `    container_name: ${MAIL_CONTAINER}`,
      '    labels:',
      label,
      '    ports:',
      `      - "127.0.0.1:${mail.smtpPort}:1025"`,
      `      - "127.0.0.1:${mail.uiPort}:8025"`,
      '    restart: unless-stopped',
    );
  }
  const volumes = [];
  if (postgresPort) volumes.push('postgres-data');
  if (ollamaPort) volumes.push('ollama-data');
  if (volumes.length) {
    lines.push('', 'volumes:');
    for (const volume of volumes) lines.push(`  ${volume}:`, '    labels:', `      ${OWNER_LABEL}: ${OWNER_VALUE}`);
  }
  lines.push('');
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function localError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

async function waitForPostgres(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = containerState(POSTGRES_CONTAINER);
    if (state.running && state.health === 'healthy') return;
    await sleep(2000);
  }
  throw localError('POSTGRES_NOT_READY', `${POSTGRES_CONTAINER} did not become healthy`);
}

async function waitForHttp(url, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (accept(await httpGet(url))) return;
    await sleep(2000);
  }
  throw localError(code, `${url} did not answer`);
}

// Starts what the plan needs and records it. Returns the effective endpoints.
async function startLocalServices(plan) {
  return withStateLock(() => startLocalServicesLocked(plan));
}

async function startLocalServicesLocked(plan) {
  // Read again under the lock: another contexa command may have changed the state since the plan
  // was made, and only the services this plan starts are written into it.
  const state = await loadState();
  if (fakeServices()) {
    if (plan.postgres) state.postgres = { port: plan.postgres.port, image: POSTGRES_IMAGE };
    if (plan.mail) state.mail = { smtpPort: plan.mail.smtpPort, uiPort: plan.mail.uiPort, image: MAIL_IMAGE };
    await saveState(state);
    return {
      postgresPort: plan.postgres ? plan.postgres.port : null,
      ollamaBaseUrl: plan.ollama ? plan.ollama.baseUrl : null,
      mail: plan.mail ? { smtpPort: plan.mail.smtpPort, uiUrl: `http://127.0.0.1:${plan.mail.uiPort}` } : null,
    };
  }
  const postgresPort = plan.postgres ? plan.postgres.port
    : (state.postgres && state.postgres.port) || null;
  const ollamaPort = plan.ollama && plan.ollama.mode === 'docker' ? plan.ollama.port
    : (state.ollama && state.ollama.mode === 'docker' ? state.ollama.port : null);
  const mail = plan.mail ? { smtpPort: plan.mail.smtpPort, uiPort: plan.mail.uiPort } : state.mail;
  const services = [];
  if (plan.postgres && plan.postgres.action !== 'reuse') services.push('postgres');
  if (plan.ollama && plan.ollama.mode === 'docker' && plan.ollama.action !== 'reuse') services.push('ollama');
  if (plan.mail && plan.mail.action !== 'reuse') services.push('mail');
  // The compose file is (re)written whenever services change or it is missing (services taken
  // over after the state was lost), so `contexa reset --services` can always take them down.
  if (services.length || !await fs.pathExists(composePath())) {
    await fs.ensureDir(localHome());
    await fs.writeFile(composePath(), renderCompose({ postgresPort, ollamaPort, mail, standalone: composeKind() === 'standalone' }));
  }
  if (services.length) {
    const result = dockerCompose(['-p', COMPOSE_PROJECT, 'up', '-d', ...services], {
      cwd: localHome(),
      stdio: 'pipe',
      timeout: 15 * 60 * 1000,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error ? result.error.message
        : (result.stderr || '').toString().trim().split(/\r?\n/).slice(-3).join(' ');
      throw localError('LOCAL_SERVICES_START_FAILED', detail);
    }
  }
  if (plan.postgres) {
    await waitForPostgres();
    state.postgres = { port: plan.postgres.port, image: POSTGRES_IMAGE };
  }
  if (plan.ollama) {
    await waitForHttp(`${plan.ollama.baseUrl}/api/tags`, response => response.status === 200, 120000, 'OLLAMA_NOT_READY');
    state.ollama = { mode: plan.ollama.mode, port: plan.ollama.port, image: plan.ollama.mode === 'docker' ? OLLAMA_IMAGE : null };
  }
  if (plan.mail) {
    await waitForHttp(`http://127.0.0.1:${plan.mail.uiPort}/`, response => response.status > 0, 60000, 'MAIL_NOT_READY');
    state.mail = { smtpPort: plan.mail.smtpPort, uiPort: plan.mail.uiPort, image: MAIL_IMAGE };
  }
  await saveState(state);
  return {
    postgresPort: plan.postgres ? plan.postgres.port : null,
    ollamaBaseUrl: plan.ollama ? plan.ollama.baseUrl : null,
    mail: plan.mail ? { smtpPort: plan.mail.smtpPort, uiUrl: `http://127.0.0.1:${plan.mail.uiPort}` } : null,
  };
}

function psql(database, sql) {
  return dockerTry(['exec', POSTGRES_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', DB_USER,
    '-d', database, '-tAc', sql], { stdio: 'pipe', timeout: 60000 });
}

// A database name of the project's own. A name another project uses, or a database left behind
// by a project that was reset, is never handed to a different project; the path-derived suffix
// is stable, so the same project gets the same database back when it is set up again.
function databaseNameFor(projectName, projectDir, state, existingDatabases = new Set()) {
  const base = `contexa_${String(projectName || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'app'}`
    .slice(0, 50);
  const key = canonicalProjectKey(projectDir);
  const existing = state.projects[key];
  if (existing && existing.database) return existing.database;
  const taken = new Set(Object.values(state.projects).map(item => item.database));
  if (!taken.has(base) && !existingDatabases.has(base)) return base;
  const suffix = crypto.createHash('sha256').update(key).digest('hex').slice(0, 6);
  return `${base}_${suffix}`;
}

function existingDatabaseNames() {
  const result = psql('contexa', "SELECT datname FROM pg_database WHERE datname LIKE 'contexa\\_%'");
  if (result.error || result.status !== 0) return new Set();
  return new Set(result.stdout.toString().split(/\r?\n/).map(name => name.trim()).filter(Boolean));
}

// Creates the project's database (with the vector extension) if it does not exist yet. Under the
// lock, so two projects set up at the same time never pick the same new database.
async function ensureProjectDatabase(projectDir, projectName) {
  return withStateLock(() => ensureProjectDatabaseLocked(projectDir, projectName));
}

async function ensureProjectDatabaseLocked(projectDir, projectName) {
  const state = await loadState();
  const database = databaseNameFor(projectName, projectDir, state, fakeServices() ? new Set() : existingDatabaseNames());
  if (!/^[a-z0-9_]+$/.test(database)) throw localError('INVALID_DATABASE_NAME', database);
  if (fakeServices()) {
    return {
      database,
      created: true,
      url: `jdbc:postgresql://127.0.0.1:${state.postgres ? state.postgres.port : 55432}/${database}`,
      username: DB_USER,
      password: DB_PASSWORD,
    };
  }
  const exists = psql('contexa', `SELECT 1 FROM pg_database WHERE datname = '${database}'`);
  if (exists.error || exists.status !== 0) {
    throw localError('DATABASE_CHECK_FAILED', (exists.stderr || '').toString().trim());
  }
  let created = false;
  if (exists.stdout.toString().trim() !== '1') {
    const create = psql('contexa', `CREATE DATABASE ${database}`);
    if (create.error || create.status !== 0) {
      throw localError('DATABASE_CREATE_FAILED', (create.stderr || '').toString().trim());
    }
    created = true;
  }
  const extension = psql(database, 'CREATE EXTENSION IF NOT EXISTS vector');
  if (extension.error || extension.status !== 0) {
    throw localError('DATABASE_EXTENSION_FAILED', (extension.stderr || '').toString().trim());
  }
  return {
    database,
    created,
    url: `jdbc:postgresql://127.0.0.1:${state.postgres.port}/${database}`,
    username: DB_USER,
    password: DB_PASSWORD,
  };
}

async function registerProject(projectDir, details) {
  await withStateLock(async () => {
    const state = await loadState();
    state.projects[canonicalProjectKey(projectDir)] = {
      path: path.resolve(projectDir),
      ...details,
      registeredAt: new Date().toISOString(),
    };
    await saveState(state);
  });
}

async function unregisterProject(projectDir) {
  if (!await fs.pathExists(statePath())) return { removed: null, remaining: [] };
  return withStateLock(async () => {
    const state = await loadState();
    const key = canonicalProjectKey(projectDir);
    const removed = state.projects[key] || null;
    delete state.projects[key];
    if (await fs.pathExists(statePath())) await saveState(state);
    return { removed, remaining: Object.values(state.projects) };
  });
}

// Removes the containers and their data. Compose only touches what it created, and only
// containers carrying the Contexa label are reported as removed.
async function removeLocalServices() {
  const result = await withStateLock(removeLocalServicesLocked);
  // Only if still empty: a contexa command waiting for the lock has put its own lock there.
  await fs.rmdir(localHome()).catch(() => {});
  return result;
}

async function removeLocalServicesLocked() {
  if (fakeServices()) {
    const state = await loadState();
    const removed = [
      state.postgres && POSTGRES_CONTAINER,
      state.ollama && state.ollama.mode === 'docker' && OLLAMA_CONTAINER,
      state.mail && MAIL_CONTAINER,
    ].filter(Boolean);
    await removeLocalHomeKeepingLock();
    return { removed };
  }
  const ownedNow = () => CONTAINERS.filter(name => {
    const container = containerState(name);
    return container.exists && container.owned;
  });
  const owned = ownedNow();
  if (owned.length > 0) {
    // Describe exactly the containers that are there (the compose file may be missing or older)
    // so `down -v` removes them together with their volumes.
    await fs.ensureDir(localHome());
    const state = await loadState();
    const postgresPort = owned.includes(POSTGRES_CONTAINER)
      ? (state.postgres && state.postgres.port) || containerHostPort(POSTGRES_CONTAINER, '5432/tcp') : null;
    const ollamaPort = owned.includes(OLLAMA_CONTAINER)
      ? (state.ollama && state.ollama.mode === 'docker' && state.ollama.port) || containerHostPort(OLLAMA_CONTAINER, '11434/tcp') : null;
    const mail = owned.includes(MAIL_CONTAINER)
      ? state.mail || { smtpPort: containerHostPort(MAIL_CONTAINER, '1025/tcp'), uiPort: containerHostPort(MAIL_CONTAINER, '8025/tcp') } : null;
    await fs.writeFile(composePath(), renderCompose({ postgresPort, ollamaPort, mail, standalone: composeKind() === 'standalone' }));
    const down = dockerCompose(['-p', COMPOSE_PROJECT, 'down', '-v', '--remove-orphans', '--timeout', '10'], {
      cwd: localHome(),
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
    });
    if (down.error || down.status !== 0) {
      throw localError('LOCAL_SERVICES_REMOVE_FAILED',
        down.error ? down.error.message : (down.stderr || '').toString().trim());
    }
    const left = ownedNow();
    if (left.length > 0) throw localError('LOCAL_SERVICES_REMOVE_FAILED', `still present: ${left.join(', ')}`);
  }
  await removeLocalHomeKeepingLock();
  return { removed: owned };
}

// Everything in the local folder except the lock, which goes when it is released; the folder
// itself is left empty rather than pulled from under a command waiting for the lock.
async function removeLocalHomeKeepingLock() {
  if (!await fs.pathExists(localHome())) return;
  for (const entry of await fs.readdir(localHome())) {
    if (entry !== path.basename(stateLockPath())) await fs.remove(path.join(localHome(), entry));
  }
}

// Ollama models: which of the wanted ones are missing.
async function missingModels(baseUrl, models) {
  if (fakeServices()) return [];
  const present = await ollamaModels(baseUrl);
  if (!present) return models;
  return models.filter(model => !hasModel(present, model));
}

module.exports = {
  COMPOSE_PROJECT,
  POSTGRES_CONTAINER,
  OLLAMA_CONTAINER,
  MAIL_CONTAINER,
  DB_USER,
  DB_PASSWORD,
  NATIVE_OLLAMA_URL,
  localHome,
  statePath,
  composePath,
  loadState,
  planLocalServices,
  startLocalServices,
  ensureProjectDatabase,
  registerProject,
  unregisterProject,
  removeLocalServices,
  missingModels,
  ollamaModels,
  hasModel,
  containerState,
  dockerStatus,
  portIsFree,
  renderCompose,
  databaseNameFor,
  canonicalProjectKey,
};
