'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  CONFIG_DIR_FILE,
  FALLBACK_FILE,
  FALLBACK_IMPORT,
  CREDENTIALS_IMPORT,
  SETTINGS_MARKER,
  isContexaSettings,
  planContexaConfig,
  buildContexaSettings,
  renderContexaSettings,
  addConfigImport,
  writeContexaConfig,
  providerKey,
} = require('../src/core/injector/config');

const DATABASE = {
  url: 'jdbc:postgresql://127.0.0.1:55432/contexa_shop',
  username: 'contexa',
  password: 'contexa',
};

function settingsFor(overrides = {}) {
  return buildContexaSettings({
    database: DATABASE,
    provider: 'ollama',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    chatModel: 'qwen3:8b',
    embeddingModel: 'mxbai-embed-large',
    hostOwnsDatabase: false,
    ...overrides,
  });
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-config-'));
}

// --- settings per provider -------------------------------------------------------------------

test('ollama: Contexa database, SHADOW mode, Ollama chat and embeddings, no API key', () => {
  assert.deepEqual(settingsFor(), {
    contexa: {
      datasource: {
        url: '${CONTEXA_DB_URL:jdbc:postgresql://127.0.0.1:55432/contexa_shop}',
        username: '${CONTEXA_DB_USERNAME:contexa}',
        password: '${CONTEXA_DB_PASSWORD:contexa}',
        isolation: { 'contexa-owned-application': true },
      },
      security: { zerotrust: { mode: 'SHADOW' } },
      llm: {
        selection: {
          chat: { mode: 'dynamic-priority', priority: 'ollama' },
          embedding: { mode: 'fixed', priority: 'ollama' },
        },
        chat: { ollama: { 'base-url': '${CONTEXA_OLLAMA_BASE_URL:http://127.0.0.1:11434}', model: 'qwen3:8b' } },
        embedding: { ollama: { model: 'mxbai-embed-large' } },
      },
    },
  });
});

test('openai: OpenAI chat and embeddings, api-key placeholder and the credentials import', () => {
  const settings = settingsFor({ provider: 'openai', ollamaBaseUrl: null });
  assert.equal(settings.contexa.llm.selection.chat.priority, 'openai');
  assert.equal(settings.contexa.llm.selection.embedding.priority, 'openai');
  assert.equal(settings.contexa.llm.chat, undefined, 'no Ollama settings without an Ollama base URL');
  assert.equal(settings.contexa.llm.embedding, undefined);
  assert.equal(settings.spring.ai.openai['api-key'], '${OPENAI_API_KEY:}');
  assert.equal(settings.spring.ai.anthropic, undefined);
  assert.equal(settings.spring.config.import, CREDENTIALS_IMPORT);
  assert.equal(CREDENTIALS_IMPORT, 'optional:file:${user.home}/.contexa/credentials.properties');
});

// Contexa follows the application's embedding model and never sets it, so the installation names
// the model in a file the application can read.
test('openai: the embedding model is named in the settings', () => {
  const settings = settingsFor({ provider: 'openai', ollamaBaseUrl: null });
  assert.equal(settings.spring.ai.openai.embedding.options.model, 'text-embedding-3-small');
});

test('openai: an embedding model the application already chose is left to it', () => {
  const settings = settingsFor({
    provider: 'openai',
    ollamaBaseUrl: null,
    hostConfigKeys: new Set(['spring.ai.openai.embedding.options.model']),
  });
  assert.equal(settings.spring.ai.openai.embedding, undefined);
});

test('ollama: no OpenAI embedding setting', () => {
  assert.equal(settingsFor({ provider: 'ollama' }).spring?.ai?.openai, undefined);
});

test('anthropic: Anthropic chat with Ollama fallback and Ollama embeddings', () => {
  const settings = settingsFor({ provider: 'anthropic' });
  assert.equal(settings.contexa.llm.selection.chat.priority, 'anthropic,ollama');
  assert.equal(settings.contexa.llm.selection.embedding.priority, 'ollama');
  assert.equal(settings.contexa.llm.chat.ollama['base-url'], '${CONTEXA_OLLAMA_BASE_URL:http://127.0.0.1:11434}');
  assert.equal(settings.contexa.llm.embedding.ollama.model, 'mxbai-embed-large');
  assert.equal(settings.spring.ai.anthropic['api-key'], '${ANTHROPIC_API_KEY:}');
  assert.equal(settings.spring.ai.openai, undefined);
  assert.equal(settings.spring.config.import, CREDENTIALS_IMPORT);
});

test('providerKey maps providers to their property and environment variable', () => {
  assert.deepEqual(providerKey('openai'), { property: 'spring.ai.openai.api-key', env: 'OPENAI_API_KEY' });
  assert.deepEqual(providerKey('anthropic'), { property: 'spring.ai.anthropic.api-key', env: 'ANTHROPIC_API_KEY' });
  assert.equal(providerKey('ollama'), null);
});

test('keys the application already sets are never written', () => {
  const hostConfigKeys = new Set([
    'contexa.datasource.url',
    'contexa.security.zerotrust.mode',
    'spring.ai.openai.api-key',
    'spring.config.import',
    'spring.mail.host',
  ]);
  const settings = settingsFor({ provider: 'openai', ollamaBaseUrl: null, hostConfigKeys, mail: { smtpPort: 51025 } });
  assert.equal(settings.contexa.datasource.url, undefined);
  assert.equal(settings.contexa.datasource.username, '${CONTEXA_DB_USERNAME:contexa}');
  assert.equal(settings.contexa.security, undefined);
  assert.equal(settings.spring.ai.openai['api-key'], undefined);
  // Spring Boot imports what every file lists, so the application's own import does not stop this one.
  assert.equal(settings.spring.config.import, CREDENTIALS_IMPORT);
  assert.equal(settings.spring.mail.host, undefined);
  assert.equal(settings.spring.mail.port, '${CONTEXA_MAIL_PORT:51025}');
});

test('contexa-owned-application is the opposite of hostOwnsDatabase', () => {
  assert.equal(settingsFor({ hostOwnsDatabase: false }).contexa.datasource.isolation['contexa-owned-application'], true);
  assert.equal(settingsFor({ hostOwnsDatabase: true }).contexa.datasource.isolation['contexa-owned-application'], false);
});

test('an external database without a known password asks for CONTEXA_DB_PASSWORD', () => {
  const settings = settingsFor({ database: { url: 'jdbc:postgresql://db.example:5432/app', username: 'app', password: null } });
  assert.equal(settings.contexa.datasource.url, '${CONTEXA_DB_URL:jdbc:postgresql://db.example:5432/app}');
  assert.equal(settings.contexa.datasource.username, '${CONTEXA_DB_USERNAME:app}');
  assert.equal(settings.contexa.datasource.password, '${CONTEXA_DB_PASSWORD}');
});

test('mail settings point at the local inbox only when one is given', () => {
  const withMail = settingsFor({ mail: { smtpPort: 51026, uiUrl: 'http://127.0.0.1:58025' } });
  assert.deepEqual(withMail.spring.mail, {
    host: '${CONTEXA_MAIL_HOST:127.0.0.1}',
    port: '${CONTEXA_MAIL_PORT:51026}',
  });
  assert.equal(settingsFor().spring, undefined);
});

test('renderContexaSettings writes a commented header and parseable YAML', () => {
  const settings = settingsFor({ provider: 'anthropic', mail: { smtpPort: 51025 } });
  const text = renderContexaSettings(settings);
  assert.match(text, /^# Contexa settings, written by `contexa init`\./);
  assert.match(text, /# To remove Contexa from this project again: contexa reset/);
  assert.deepEqual(yaml.load(text), settings);
  assert.equal((text.match(/^contexa:/gm) || []).length, 1);
});

// --- where the settings go -------------------------------------------------------------------

test('planContexaConfig: config/application.yml when the application has no file of its own there', async () => {
  const dir = await tempDir();
  try {
    await fs.outputFile(path.join(dir, 'src/main/resources/application.yml'), 'server:\n  port: 8080\n');
    assert.deepEqual(await planContexaConfig(dir), {
      filePath: path.join(dir, CONFIG_DIR_FILE),
      importTarget: null,
    });
    assert.equal(CONFIG_DIR_FILE, path.join('src', 'main', 'resources', 'config', 'application.yml'));
  } finally { await fs.remove(dir); }
});

test('planContexaConfig: application-contexa.yml plus an import when config/application.* is the user\'s', async () => {
  const dir = await tempDir();
  try {
    const userYml = path.join(dir, 'src/main/resources/config/application.yml');
    await fs.outputFile(userYml, 'server:\n  port: 8080\n');
    assert.deepEqual(await planContexaConfig(dir), {
      filePath: path.join(dir, FALLBACK_FILE),
      importTarget: userYml,
    });

    // With both, the .properties file receives the import line.
    const userProperties = path.join(dir, 'src/main/resources/config/application.properties');
    await fs.outputFile(userProperties, 'server.port=8080\n');
    assert.deepEqual(await planContexaConfig(dir), {
      filePath: path.join(dir, FALLBACK_FILE),
      importTarget: userProperties,
    });
  } finally { await fs.remove(dir); }
});

test('planContexaConfig: a config/application.yml the CLI wrote earlier is not the user\'s', async () => {
  const dir = await tempDir();
  try {
    await fs.outputFile(path.join(dir, CONFIG_DIR_FILE), '# Contexa settings\n');
    const owned = new Set(['src/main/resources/config/application.yml']);
    assert.deepEqual(await planContexaConfig(dir, owned), {
      filePath: path.join(dir, CONFIG_DIR_FILE),
      importTarget: null,
    });
    assert.equal((await planContexaConfig(dir)).filePath, path.join(dir, FALLBACK_FILE));
  } finally { await fs.remove(dir); }
});

test('planContexaConfig: a file Contexa wrote is recognised by its first line when the record is gone', async () => {
  const dir = await tempDir();
  try {
    await fs.outputFile(path.join(dir, CONFIG_DIR_FILE), renderContexaSettings(settingsFor()));
    assert.deepEqual(await planContexaConfig(dir), { filePath: path.join(dir, CONFIG_DIR_FILE), importTarget: null });
    assert.equal(isContexaSettings(`\uFEFF${SETTINGS_MARKER}\nkey: value\n`), true);
    assert.equal(isContexaSettings('# my settings\n'), false);
  } finally { await fs.remove(dir); }
});

// --- spring.config.import --------------------------------------------------------------------

test('addConfigImport: properties without an import get a new line', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'application.properties');
    await fs.writeFile(file, 'server.port=8080\n');
    assert.equal(await addConfigImport(file, FALLBACK_IMPORT), true);
    assert.equal(await fs.readFile(file, 'utf8'),
      'server.port=8080\nspring.config.import=optional:classpath:application-contexa.yml\n');

    const noTrailingNewline = path.join(dir, 'no-newline.properties');
    await fs.writeFile(noTrailingNewline, 'server.port=8080');
    await addConfigImport(noTrailingNewline, FALLBACK_IMPORT);
    assert.equal(await fs.readFile(noTrailingNewline, 'utf8'),
      'server.port=8080\nspring.config.import=optional:classpath:application-contexa.yml\n');
  } finally { await fs.remove(dir); }
});

test('addConfigImport: an existing spring.config.import line is extended, not duplicated', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'application.properties');
    await fs.writeFile(file, 'spring.config.import = optional:file:./secrets.properties \nserver.port=8080\n');
    assert.equal(await addConfigImport(file, FALLBACK_IMPORT), true);
    assert.equal(await fs.readFile(file, 'utf8'),
      'spring.config.import = optional:file:./secrets.properties,optional:classpath:application-contexa.yml\nserver.port=8080\n');
    assert.equal(((await fs.readFile(file, 'utf8')).match(/spring\.config\.import/g) || []).length, 1);
  } finally { await fs.remove(dir); }
});

test('addConfigImport: YAML gets a document of its own and keeps every existing line', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'application.yml');
    const original = 'server:\n  port: 8080\nspring:\n  application:\n    name: shop\n';
    await fs.writeFile(file, original);
    assert.equal(await addConfigImport(file, FALLBACK_IMPORT), true);
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.startsWith(original));
    assert.equal(text.slice(original.length),
      '---\nspring:\n  config:\n    import: "optional:classpath:application-contexa.yml"\n');
    const documents = yaml.loadAll(text);
    assert.equal(documents.length, 2);
    assert.equal(documents[0].spring.application.name, 'shop');
    assert.equal(documents[1].spring.config.import, FALLBACK_IMPORT);
  } finally { await fs.remove(dir); }
});

test('addConfigImport: a file that already imports the location is left unchanged', async () => {
  const dir = await tempDir();
  try {
    const properties = path.join(dir, 'application.properties');
    const yml = path.join(dir, 'application.yml');
    const propertiesText = 'spring.config.import=optional:classpath:application-contexa.yml\n';
    const ymlText = 'spring:\n  config:\n    import: "optional:classpath:application-contexa.yml"\n';
    await fs.writeFile(properties, propertiesText);
    await fs.writeFile(yml, ymlText);
    assert.equal(await addConfigImport(properties, FALLBACK_IMPORT), false);
    assert.equal(await addConfigImport(yml, FALLBACK_IMPORT), false);
    assert.equal(await fs.readFile(properties, 'utf8'), propertiesText);
    assert.equal(await fs.readFile(yml, 'utf8'), ymlText);
  } finally { await fs.remove(dir); }
});

test('addConfigImport: CRLF files stay CRLF', async () => {
  const dir = await tempDir();
  try {
    const properties = path.join(dir, 'application.properties');
    await fs.writeFile(properties, 'server.port=8080\r\nspring.config.import=optional:file:./a.properties\r\n');
    await addConfigImport(properties, FALLBACK_IMPORT);
    assert.equal(await fs.readFile(properties, 'utf8'),
      'server.port=8080\r\nspring.config.import=optional:file:./a.properties,optional:classpath:application-contexa.yml\r\n');

    const appended = path.join(dir, 'appended.properties');
    await fs.writeFile(appended, 'server.port=8080\r\n');
    await addConfigImport(appended, FALLBACK_IMPORT);
    assert.equal(await fs.readFile(appended, 'utf8'),
      'server.port=8080\r\nspring.config.import=optional:classpath:application-contexa.yml\r\n');

    const yml = path.join(dir, 'application.yml');
    await fs.writeFile(yml, 'server:\r\n  port: 8080\r\n');
    await addConfigImport(yml, FALLBACK_IMPORT);
    const text = await fs.readFile(yml, 'utf8');
    assert.equal(text, 'server:\r\n  port: 8080\r\n---\r\nspring:\r\n  config:\r\n    import: "optional:classpath:application-contexa.yml"\r\n');
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF');
  } finally { await fs.remove(dir); }
});

test('writeContexaConfig writes the settings file and the import together', async () => {
  const dir = await tempDir();
  try {
    const userProperties = path.join(dir, 'src/main/resources/config/application.properties');
    await fs.outputFile(userProperties, 'server.port=8080\n');
    const plan = await planContexaConfig(dir);
    const settings = settingsFor();
    await writeContexaConfig(plan, settings);
    assert.deepEqual(yaml.load(await fs.readFile(path.join(dir, FALLBACK_FILE), 'utf8')), settings);
    assert.match(await fs.readFile(userProperties, 'utf8'), /^spring\.config\.import=optional:classpath:application-contexa\.yml$/m);

    const fresh = await tempDir();
    try {
      const freshPlan = await planContexaConfig(fresh);
      await writeContexaConfig(freshPlan, settings);
      assert.deepEqual(yaml.load(await fs.readFile(path.join(fresh, CONFIG_DIR_FILE), 'utf8')), settings);
    } finally { await fs.remove(fresh); }
  } finally { await fs.remove(dir); }
});

test('the credentials import is written for the admin-console password also without an API key', () => {
  assert.equal(settingsFor().spring, undefined, 'Ollama without an admin password needs no import');
  assert.equal(settingsFor({ credentialsImport: true }).spring.config.import, CREDENTIALS_IMPORT);
  assert.equal(settingsFor({ provider: 'openai', ollamaBaseUrl: null, credentialsImport: true }).spring.config.import, CREDENTIALS_IMPORT);
});

test('bootDefaultUser writes only the name of Spring Boot\'s default user, never a password', () => {
  assert.equal(settingsFor().spring, undefined);
  assert.deepEqual(settingsFor({ bootDefaultUser: true }).spring.security, { user: { name: 'user' } });
  assert.equal(settingsFor({ bootDefaultUser: true, hostConfigKeys: new Set(['spring.security.user.name']) }).spring, undefined);
});
