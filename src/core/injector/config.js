'use strict';

// Contexa configuration file.
//
// Spring Boot reads classpath:/config/application.yml on its own (one of its default config
// locations), so writing Contexa's settings to src/main/resources/config/application.yml makes
// them take effect without touching the application's own application.yml/.properties.
// When the application already keeps its own file in that folder, the settings go to
// src/main/resources/application-contexa.yml and that file gets one spring.config.import line.
//
// Only keys the application does not set itself are written: Spring gives the config/ folder
// precedence over the classpath root, so writing a key the application already sets would
// silently override it.

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_DIR_FILE = path.join('src', 'main', 'resources', 'config', 'application.yml');
const FALLBACK_FILE = path.join('src', 'main', 'resources', 'application-contexa.yml');
const FALLBACK_IMPORT = 'optional:classpath:application-contexa.yml';
const CREDENTIALS_IMPORT = 'optional:file:${user.home}/.contexa/credentials.properties';
// The core creates one administrator with this password at the first start (O-7a); contexa init
// keeps the password in the credentials file, never in the project.
const ADMIN_PASSWORD_PROPERTY = 'contexa.iam.seed.admin.password';
// Spring Boot's default user in an application that keeps its own sign-in (F-50). The value is kept
// with a {noop} prefix: Contexa's delegating password encoder cannot check a password without one.
const APP_USER_PASSWORD_PROPERTY = 'spring.security.user.password';
const USER_CONFIG_DIR_FILES = ['application.yml', 'application.yaml', 'application.properties'];
// Spring AI's own default is a model of an earlier generation with the same vector size. Contexa
// follows the application's model and never sets it, so the installation names this one here, in
// a file the application can read and change.
const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

// First line of every file Contexa writes; tells its own file from the application's.
const SETTINGS_MARKER = '# Contexa settings, written by `contexa init`.';
const HEADER = [
  SETTINGS_MARKER,
  '# Spring Boot loads this file by itself; your own application settings were not changed.',
  '# Values in ${NAME:default} form can be overridden with environment variables.',
  '# To remove Contexa from this project again: contexa reset',
  '',
];

function isContexaSettings(text) {
  return String(text || '').replace(/^\uFEFF/, '').startsWith(SETTINGS_MARKER);
}

// Where the settings go for this project. `ownedPaths` holds the project-relative paths the CLI
// already owns (from its installation record), so a file it wrote earlier is not mistaken for
// the application's own; its first line tells the same when the record is gone.
async function planContexaConfig(projectDir, ownedPaths = new Set()) {
  const configDir = path.join(projectDir, 'src', 'main', 'resources', 'config');
  const relative = file => path.relative(projectDir, file).split(path.sep).join('/');
  const userFiles = [];
  for (const name of USER_CONFIG_DIR_FILES) {
    const file = path.join(configDir, name);
    if (!await fs.pathExists(file) || ownedPaths.has(relative(file))) continue;
    if (isContexaSettings(await fs.readFile(file, 'utf8').catch(() => ''))) continue;
    userFiles.push(file);
  }
  if (userFiles.length === 0) {
    return { filePath: path.join(projectDir, CONFIG_DIR_FILE), importTarget: null };
  }
  return {
    filePath: path.join(projectDir, FALLBACK_FILE),
    importTarget: userFiles.find(file => file.endsWith('.properties')) || userFiles[0],
  };
}

function providerKey(provider) {
  return provider === 'openai'
    ? { property: 'spring.ai.openai.api-key', env: 'OPENAI_API_KEY' }
    : provider === 'anthropic'
      ? { property: 'spring.ai.anthropic.api-key', env: 'ANTHROPIC_API_KEY' }
      : null;
}

// The settings this installation needs, as a nested object.
//   database: { url, username, password } with the values the local services use
//   provider: 'ollama' | 'openai' | 'anthropic'
//   ollamaBaseUrl: when Ollama serves chat or embeddings
//   hostOwnsDatabase: the application has its own DataSource
//   hostConfigKeys: leaf keys the application already sets (kebab-case)
//   credentialsImport: the credentials file holds something this application needs (the
//     admin-console password), also without an API key
//   bootDefaultUser: keep Spring Boot's default user, which the OAuth2 classes of the starter would
//     turn off; its password comes from the credentials file (spring.security.user.password)
function buildContexaSettings(options) {
  const {
    database,
    provider,
    ollamaBaseUrl,
    chatModel,
    embeddingModel,
    hostOwnsDatabase,
    hostConfigKeys = new Set(),
    mail = null,
    credentialsImport = false,
    bootDefaultUser = false,
  } = options;
  const settings = {};
  const put = (dottedKey, value) => {
    if (value === undefined || value === null) return;
    // spring.config.import is not one value: Spring Boot imports what every file lists, so the
    // application's own imports do not replace this one.
    if (hostConfigKeys.has(dottedKey) && dottedKey !== 'spring.config.import') return;
    const parts = dottedKey.split('.');
    let node = settings;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] && typeof node[part] === 'object' ? node[part] : {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  };

  put('contexa.datasource.url', `\${CONTEXA_DB_URL:${database.url}}`);
  put('contexa.datasource.username', `\${CONTEXA_DB_USERNAME:${database.username}}`);
  put('contexa.datasource.password', database.password === null
    ? '${CONTEXA_DB_PASSWORD}'
    : `\${CONTEXA_DB_PASSWORD:${database.password}}`);
  // Without a database of its own, the application's DataSource has to be Contexa's.
  put('contexa.datasource.isolation.contexa-owned-application', !hostOwnsDatabase);
  put('contexa.security.zerotrust.mode', 'SHADOW');

  const chatPriority = provider === 'anthropic' ? 'anthropic,ollama' : provider;
  const embeddingPriority = provider === 'openai' ? 'openai' : 'ollama';
  put('contexa.llm.selection.chat.mode', 'dynamic-priority');
  put('contexa.llm.selection.chat.priority', chatPriority);
  put('contexa.llm.selection.embedding.mode', 'fixed');
  put('contexa.llm.selection.embedding.priority', embeddingPriority);
  if (embeddingPriority === 'openai') put('spring.ai.openai.embedding.options.model', OPENAI_EMBEDDING_MODEL);
  if (ollamaBaseUrl) {
    put('contexa.llm.chat.ollama.base-url', `\${CONTEXA_OLLAMA_BASE_URL:${ollamaBaseUrl}}`);
    put('contexa.llm.chat.ollama.model', chatModel);
    put('contexa.llm.embedding.ollama.model', embeddingModel);
  }
  const key = providerKey(provider);
  if (key) put(key.property, `\${${key.env}:}`);
  if (key || credentialsImport) put('spring.config.import', CREDENTIALS_IMPORT);
  if (bootDefaultUser) put('spring.security.user.name', 'user');
  // Contexa's sign-in sends a one-time code by e-mail as the second step; the local inbox
  // receives it when the application has no mail server of its own.
  if (mail) {
    put('spring.mail.host', '${CONTEXA_MAIL_HOST:127.0.0.1}');
    put('spring.mail.port', `\${CONTEXA_MAIL_PORT:${mail.smtpPort}}`);
  }
  return settings;
}

function renderContexaSettings(settings) {
  const body = yaml.dump(settings, { lineWidth: 200, noRefs: true, sortKeys: false });
  return HEADER.join('\n') + '\n' + body;
}

// Adds one spring.config.import entry to an application file, keeping everything else as is.
async function addConfigImport(filePath, location) {
  const text = await fs.readFile(filePath, 'utf8');
  if (text.includes(location)) return false;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const trailing = text.length === 0 || text.endsWith('\n') ? '' : newline;
  if (filePath.endsWith('.properties')) {
    const existing = text.match(/^(\s*spring\.config\.import\s*[=:]\s*)(.*)$/m);
    const updated = existing
      ? text.replace(existing[0], `${existing[1]}${existing[2].trim()},${location}`)
      : `${text}${trailing}spring.config.import=${location}${newline}`;
    await fs.writeFile(filePath, updated);
    return true;
  }
  // YAML: a document of its own at the end, so no existing line is rewritten.
  const document = ['---', 'spring:', '  config:', `    import: "${location}"`, ''].join(newline);
  await fs.writeFile(filePath, `${text}${trailing}${document}`);
  return true;
}

async function writeContexaConfig(plan, settings) {
  await fs.ensureDir(path.dirname(plan.filePath));
  await fs.writeFile(plan.filePath, renderContexaSettings(settings));
  if (plan.importTarget) await addConfigImport(plan.importTarget, FALLBACK_IMPORT);
}

module.exports = {
  CONFIG_DIR_FILE,
  FALLBACK_FILE,
  FALLBACK_IMPORT,
  CREDENTIALS_IMPORT,
  ADMIN_PASSWORD_PROPERTY,
  APP_USER_PASSWORD_PROPERTY,
  SETTINGS_MARKER,
  isContexaSettings,
  planContexaConfig,
  buildContexaSettings,
  renderContexaSettings,
  addConfigImport,
  writeContexaConfig,
  providerKey,
};
