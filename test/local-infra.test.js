'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const local = require('../src/core/local-infra');

function emptyState() {
  return { version: 1, postgres: null, ollama: null, mail: null, projects: {} };
}

// Runs `action` with the PC-wide Contexa folder in a temporary directory and the fake
// local-services hook on, restoring the environment afterwards.
async function withFakeHome(action) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-local-infra-'));
  const names = ['LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CONTEXA_TEST_LOCAL_SERVICES'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.LOCALAPPDATA = home;
  process.env.XDG_CONFIG_HOME = home;
  process.env.CONTEXA_TEST_LOCAL_SERVICES = 'fake';
  try {
    return await action(home);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.remove(home);
  }
}

// --- compose file ----------------------------------------------------------------------------

test('renderCompose binds every port to 127.0.0.1 and labels containers and volumes', () => {
  const text = local.renderCompose({ postgresPort: 55433, ollamaPort: 51434, mail: { smtpPort: 51026, uiPort: 58027 } });
  const compose = yaml.load(text);
  assert.equal(compose.name, local.COMPOSE_PROJECT);
  assert.deepEqual(Object.keys(compose.services), ['postgres', 'ollama', 'mail']);
  assert.deepEqual(compose.services.postgres.ports, ['127.0.0.1:55433:5432']);
  assert.deepEqual(compose.services.ollama.ports, ['127.0.0.1:51434:11434']);
  assert.deepEqual(compose.services.mail.ports, ['127.0.0.1:51026:1025', '127.0.0.1:58027:8025']);
  for (const [name, service] of Object.entries(compose.services)) {
    assert.deepEqual(service.labels, { 'io.ctxa.owner': 'contexa-cli' }, `${name} label`);
    for (const binding of service.ports) assert.match(binding, /^127\.0\.0\.1:\d+:\d+$/, `${name} ${binding}`);
  }
  assert.equal(compose.services.postgres.container_name, local.POSTGRES_CONTAINER);
  assert.equal(compose.services.ollama.container_name, local.OLLAMA_CONTAINER);
  assert.equal(compose.services.mail.container_name, local.MAIL_CONTAINER);
  assert.equal(compose.services.postgres.environment.POSTGRES_USER, local.DB_USER);
  assert.match(compose.services.postgres.image, /^pgvector\/pgvector:/);
  assert.deepEqual(Object.keys(compose.volumes), ['postgres-data', 'ollama-data']);
  for (const volume of Object.values(compose.volumes)) {
    assert.deepEqual(volume.labels, { 'io.ctxa.owner': 'contexa-cli' });
  }
  assert.doesNotMatch(text, /0\.0\.0\.0/);
});

test('renderCompose for the standalone docker-compose (v1) writes a version line instead of name', () => {
  const pluginText = local.renderCompose({ postgresPort: 55432, ollamaPort: null, mail: null });
  assert.match(pluginText, /^name: contexa-local$/m);
  assert.doesNotMatch(pluginText, /^version:/m);

  const text = local.renderCompose({
    postgresPort: 55432, ollamaPort: null, mail: { smtpPort: 51025, uiPort: 58025 }, standalone: true,
  });
  assert.match(text, /^version: "3\.8"$/m);
  assert.doesNotMatch(text, /^name:/m);
  const compose = yaml.load(text);
  assert.equal(compose.version, '3.8');
  assert.deepEqual(Object.keys(compose.services), ['postgres', 'mail']);
  assert.deepEqual(compose.services.mail.ports, ['127.0.0.1:51025:1025', '127.0.0.1:58025:8025']);
  assert.deepEqual(compose.services.postgres.labels, { 'io.ctxa.owner': 'contexa-cli' });
});

test('renderCompose leaves out what the plan does not need', () => {
  const compose = yaml.load(local.renderCompose({ postgresPort: 55432, ollamaPort: null, mail: null }));
  assert.deepEqual(Object.keys(compose.services), ['postgres']);
  assert.deepEqual(Object.keys(compose.volumes), ['postgres-data']);
  const ollamaOnly = yaml.load(local.renderCompose({ postgresPort: null, ollamaPort: 11434, mail: null }));
  assert.deepEqual(Object.keys(ollamaOnly.services), ['ollama']);
  assert.deepEqual(ollamaOnly.services.ollama.ports, ['127.0.0.1:11434:11434']);
});

// --- one database per project ----------------------------------------------------------------

test('databaseNameFor derives a safe name from the project name', () => {
  const state = emptyState();
  assert.equal(local.databaseNameFor('shop', '/work/shop', state), 'contexa_shop');
  assert.equal(local.databaseNameFor('My-Shop App', '/work/a', state), 'contexa_my_shop_app');
  assert.equal(local.databaseNameFor('--', '/work/b', state), 'contexa_app');
  assert.equal(local.databaseNameFor(null, '/work/c', state), 'contexa_app');
  const long = local.databaseNameFor('x'.repeat(80), '/work/d', state);
  assert.equal(long.length, 50);
  assert.match(long, /^[a-z0-9_]+$/);
});

test('databaseNameFor gives a registered project its database back', () => {
  const projectDir = path.resolve('work', 'shop');
  const state = emptyState();
  state.projects[local.canonicalProjectKey(projectDir)] = { path: projectDir, database: 'contexa_shop_custom' };
  assert.equal(local.databaseNameFor('shop', projectDir, state), 'contexa_shop_custom');
  assert.equal(local.databaseNameFor('shop', projectDir, state, new Set(['contexa_shop_custom'])), 'contexa_shop_custom');
});

test('databaseNameFor adds a stable path suffix when another project uses the name', () => {
  const first = path.resolve('work', 'one', 'shop');
  const second = path.resolve('work', 'two', 'shop');
  const third = path.resolve('work', 'three', 'shop');
  const state = emptyState();
  state.projects[local.canonicalProjectKey(first)] = { path: first, database: 'contexa_shop' };

  const name = local.databaseNameFor('shop', second, state);
  const expectedSuffix = crypto.createHash('sha256').update(local.canonicalProjectKey(second)).digest('hex').slice(0, 6);
  assert.equal(name, `contexa_shop_${expectedSuffix}`);
  assert.equal(local.databaseNameFor('shop', second, state), name, 'the suffix is stable for the same folder');
  assert.notEqual(local.databaseNameFor('shop', third, state), name, 'another folder gets another suffix');
  assert.match(name, /^contexa_shop_[0-9a-f]{6}$/);
});

test('databaseNameFor never hands out a database that already exists in PostgreSQL', () => {
  const projectDir = path.resolve('work', 'fresh', 'shop');
  const leftOver = new Set(['contexa_shop']);
  const name = local.databaseNameFor('shop', projectDir, emptyState(), leftOver);
  assert.notEqual(name, 'contexa_shop');
  assert.equal(name, local.databaseNameFor('shop', projectDir, emptyState(), leftOver));
  assert.equal(local.databaseNameFor('shop', projectDir, emptyState(), new Set(['contexa_other'])), 'contexa_shop');
});

test('canonicalProjectKey ignores letter case only on Windows', () => {
  const dir = path.resolve('Work', 'Shop');
  if (process.platform === 'win32') {
    assert.equal(local.canonicalProjectKey(dir), local.canonicalProjectKey(dir.toUpperCase()));
    const state = emptyState();
    state.projects[local.canonicalProjectKey(dir)] = { path: dir, database: 'contexa_shop' };
    assert.equal(local.databaseNameFor('shop', dir.toLowerCase(), state), 'contexa_shop');
  } else {
    assert.notEqual(local.canonicalProjectKey(dir), local.canonicalProjectKey(dir.toUpperCase()));
  }
});

// --- Ollama models ---------------------------------------------------------------------------

test('hasModel treats a name without a tag as :latest', () => {
  const present = ['qwen3:8b', 'mxbai-embed-large:latest', 'llama3.2:latest'];
  assert.equal(local.hasModel(present, 'mxbai-embed-large'), true);
  assert.equal(local.hasModel(present, 'mxbai-embed-large:latest'), true);
  assert.equal(local.hasModel(present, 'qwen3:8b'), true);
  assert.equal(local.hasModel(present, 'llama3.2'), true);
  assert.equal(local.hasModel(present, 'qwen3'), false, 'qwen3 means qwen3:latest, not qwen3:8b');
  assert.equal(local.hasModel(present, 'qwen3:14b'), false);
  assert.equal(local.hasModel([], 'qwen3:8b'), false);
});

// --- fake mode (CONTEXA_TEST_LOCAL_SERVICES=fake) --------------------------------------------

test('fake mode plans the services from the request without Docker and with no problems', async () => {
  await withFakeHome(async () => {
    const full = await local.planLocalServices({ needOllama: true, needPostgres: true, wantMail: true });
    assert.deepEqual(full.docker, { cli: true, daemon: true });
    assert.deepEqual(full.postgres, { action: 'reuse', port: 55432 });
    assert.deepEqual(full.ollama, { action: 'reuse', mode: 'native', port: 11434, baseUrl: local.NATIVE_OLLAMA_URL });
    assert.deepEqual(full.mail, { action: 'reuse', smtpPort: 51025, uiPort: 58025 });
    assert.deepEqual(full.problems, []);

    const minimal = await local.planLocalServices({ needOllama: false, needPostgres: false });
    assert.equal(minimal.postgres, null);
    assert.equal(minimal.ollama, null);
    assert.equal(minimal.mail, null);
    assert.deepEqual(minimal.problems, []);
  });
});

test('fake mode start, database, registration and models touch only the state file', async () => {
  await withFakeHome(async home => {
    const contexaHome = process.platform === 'win32' ? path.join(home, 'Contexa') : path.join(home, 'contexa');
    assert.equal(local.localHome(), path.join(contexaHome, 'local'));
    assert.deepEqual(await local.loadState(), emptyState());

    const plan = await local.planLocalServices({ needOllama: true, needPostgres: true, wantMail: true });
    const endpoints = await local.startLocalServices(plan);
    assert.deepEqual(endpoints, {
      postgresPort: 55432,
      ollamaBaseUrl: local.NATIVE_OLLAMA_URL,
      mail: { smtpPort: 51025, uiUrl: 'http://127.0.0.1:58025' },
    });
    assert.equal(await fs.pathExists(local.composePath()), false, 'no compose file in fake mode');
    const state = await local.loadState();
    assert.equal(state.postgres.port, 55432);
    assert.equal(state.mail.uiPort, 58025);

    const projectDir = path.join(home, 'projects', 'shop');
    const database = await local.ensureProjectDatabase(projectDir, 'shop');
    assert.deepEqual(database, {
      database: 'contexa_shop',
      created: true,
      url: 'jdbc:postgresql://127.0.0.1:55432/contexa_shop',
      username: local.DB_USER,
      password: local.DB_PASSWORD,
    });
    assert.deepEqual(await local.missingModels(local.NATIVE_OLLAMA_URL, ['qwen3:8b', 'mxbai-embed-large']), []);

    await local.registerProject(projectDir, { database: database.database, provider: 'ollama' });
    const other = path.join(home, 'projects', 'other', 'shop');
    const otherDatabase = await local.ensureProjectDatabase(other, 'shop');
    assert.match(otherDatabase.database, /^contexa_shop_[0-9a-f]{6}$/, 'a second project named shop gets its own database');
    await local.registerProject(other, { database: otherDatabase.database, provider: 'openai' });

    const registered = await local.loadState();
    assert.deepEqual(Object.values(registered.projects).map(item => item.database).sort(),
      ['contexa_shop', otherDatabase.database].sort());
    assert.equal((await local.ensureProjectDatabase(projectDir, 'shop')).database, 'contexa_shop');

    const first = await local.unregisterProject(projectDir);
    assert.equal(first.removed.database, 'contexa_shop');
    assert.deepEqual(first.remaining.map(item => item.database), [otherDatabase.database]);
    const second = await local.unregisterProject(other);
    assert.deepEqual(second.remaining, []);
    assert.equal((await local.unregisterProject(other)).removed, null);
  });
});

test('loadState falls back to an empty state when the file is unreadable', async () => {
  await withFakeHome(async () => {
    await fs.outputFile(local.statePath(), '{ not json');
    assert.deepEqual(await local.loadState(), emptyState());
  });
});
