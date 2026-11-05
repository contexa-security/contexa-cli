'use strict';

// `contexa doctor`: is everything the application needs for Contexa in place? Each line is a
// check that would otherwise surface as a startup failure, with the fix next to it.

const chalk = require('chalk');
const fs = require('fs-extra');
const net = require('net');
const path = require('path');
const yaml = require('js-yaml');
const { t } = require('../core/i18n');
const releaseManifest = require('../../release-manifest.json');
const { detectSpringProject } = require('../core/detector');
const { bootSupport, javaMajorVersion } = require('../core/init-application');
const { INSTALL_MODES, loadManifest, manifestPath } = require('../core/manifest');
const {
  CONFIG_DIR_FILE, FALLBACK_FILE, FALLBACK_IMPORT, isContexaSettings, providerKey,
} = require('../core/injector/config');
const { hasCredential, credentialsPath } = require('../core/credentials');
const local = require('../core/local-infra');
const { runCommandText } = require('../core/build-tool');

// The folder holding Contexa's installation record: this one or a parent (a module of a
// multi-module build was given).
async function findInstallRoot(dir) {
  let current = path.resolve(dir);
  for (let depth = 0; depth < 6; depth++) {
    if (await fs.pathExists(manifestPath(current, INSTALL_MODES.NORMAL))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolvePlaceholder(value, environment = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z0-9_.-]+)(?::([^}]*))?\}/g, (match, name, fallback) => {
    if (environment[name] !== undefined && environment[name] !== '') return environment[name];
    return fallback === undefined ? match : fallback;
  });
}

function readYamlValue(file, dottedKey) {
  try {
    for (const document of yaml.loadAll(fs.readFileSync(file, 'utf8'))) {
      let node = document;
      for (const part of dottedKey.split('.')) {
        if (!node || typeof node !== 'object') { node = undefined; break; }
        node = node[part];
      }
      if (node !== undefined && node !== null && typeof node !== 'object') return String(node);
    }
  } catch { /* unreadable: reported by the settings check */ }
  return null;
}

function readPropertiesValue(file, dottedKey) {
  try {
    const match = fs.readFileSync(file, 'utf8').match(
      new RegExp(`^\\s*${dottedKey.replace(/[.-]/g, '\\$&')}\\s*[=:]\\s*(.*)$`, 'm'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// The effective value of a key, looking where Spring would: Contexa's settings file first
// (it has precedence), then the application's own files.
function configValue(settingsFile, hostFiles, dottedKey) {
  const candidates = [settingsFile, ...hostFiles].filter(Boolean);
  for (const file of candidates) {
    const value = file.endsWith('.properties') ? readPropertiesValue(file, dottedKey) : readYamlValue(file, dottedKey);
    if (value !== null) return resolvePlaceholder(value);
  }
  return null;
}

function tcpReachable(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = result => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function parseJdbcUrl(url) {
  const match = String(url || '').match(/^jdbc:postgresql:\/\/([^:/?]+)(?::(\d+))?\/([^?]+)/);
  return match ? { host: match[1], port: Number(match[2] || 5432), database: match[3] } : null;
}

async function runDoctor(opts) {
  const results = [];
  const add = (status, label, detail, fix) => results.push({ status, label, detail, fix });
  const dir = path.resolve(opts.dir || process.cwd());
  console.log(chalk.cyan(`\n  Contexa doctor (CLI ${releaseManifest.cliVersion})\n`));

  const installRoot = await findInstallRoot(dir);
  const project = await detectSpringProject(dir, { probeDocker: false });
  if (!project.isSpring) {
    add('fail', t('doctor.project'), t('doctor.project.none'), t('doctor.project.fix'));
    return print(results);
  }
  add('ok', t('doctor.project'), `${project.projectName} (${project.buildTool === 'maven' ? 'Maven' : 'Gradle'})`);

  const boot = project.springBootVersion;
  const support = bootSupport(boot);
  if (support === 'unknown') add('warn', 'Spring Boot', t('doctor.boot.unknown'));
  else if (support === 'supported') add('ok', 'Spring Boot', boot);
  else add('fail', 'Spring Boot', boot, t('doctor.boot.fix'));

  const java = javaMajorVersion();
  if (java === null) add('fail', 'Java', t('doctor.java.missing'), t('doctor.java.fix'));
  else if (java < 17) add('warn', 'Java', String(java), t('doctor.java.fix'));
  else add('ok', 'Java', String(java));

  if (!project.hasContexta && !project.hasEnableAiSecurity && !installRoot) {
    // Nothing of Contexa here yet: one line instead of a failure per missing piece.
    add('fail', 'Contexa', t('doctor.notSetUp'), t('doctor.runInit'));
    print(results);
    console.log('');
    return results;
  }
  if (!project.hasContexta) {
    add('fail', t('doctor.starter'), t('doctor.starter.missing'), t('doctor.runInit'));
  } else {
    add('ok', t('doctor.starter'), `${releaseManifest.starter.artifactId}:${project.contextaVersion || '?'}`);
  }
  if (!project.hasEnableAiSecurity) add('fail', '@EnableAISecurity', t('doctor.annotation.missing'), t('doctor.runInit'));
  else add('ok', '@EnableAISecurity', t(project.hasHostSecurityFilterChain ? 'doctor.annotation.app' : 'doctor.annotation.contexa'));
  if (project.hasEnableAiSecurity && !project.hasSpringSecurityCore) {
    add('fail', 'Spring Security', t('doctor.security.missing'), t('doctor.security.fix'));
  }

  // config/application.yml is Contexa's only when Contexa wrote it; an application that keeps its
  // own file there has Contexa's settings in application-contexa.yml.
  const configDirFile = path.join(project.projectDir, CONFIG_DIR_FILE);
  const fallbackFile = path.join(project.projectDir, FALLBACK_FILE);
  let settingsFile = null;
  if (isContexaSettings(await fs.readFile(configDirFile, 'utf8').catch(() => ''))) settingsFile = configDirFile;
  else if (await fs.pathExists(fallbackFile)) settingsFile = fallbackFile;
  const hostFiles = project.applicationConfigPaths.filter(file => /application\.(?:yml|yaml|properties)$/.test(file))
    .concat(project.configDirPaths || []);
  if (settingsFile && settingsFile.endsWith('application-contexa.yml')) {
    const imported = hostFiles.concat(
      ['application.yml', 'application.yaml', 'application.properties']
        .map(name => path.join(project.projectDir, 'src', 'main', 'resources', 'config', name)))
      .some(file => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(FALLBACK_IMPORT));
    if (!imported) {
      add('fail', t('doctor.settings'), t('doctor.settings.notLoaded', path.relative(dir, settingsFile)), t('doctor.runInit'));
      settingsFile = null;
    }
  }
  if (settingsFile) add('ok', t('doctor.settings'), path.relative(dir, settingsFile));
  else if (!results.some(result => result.label === t('doctor.settings'))) {
    add('warn', t('doctor.settings'), t('doctor.settings.none'), t('doctor.runInit'));
  }

  const manifest = installRoot ? await loadManifest(installRoot, INSTALL_MODES.NORMAL).catch(() => null) : null;
  const metadata = (manifest && manifest.metadata) || {};

  // Database
  const url = configValue(settingsFile, hostFiles, 'contexa.datasource.url');
  if (!url || url.includes('${')) {
    add('fail', t('doctor.database'), t('doctor.database.missing'), t('doctor.runInit'));
  } else {
    const target = parseJdbcUrl(url);
    const reachable = target ? await tcpReachable(target.host, target.port) : false;
    if (reachable) {
      add('ok', t('doctor.database'), url);
    } else {
      const container = local.containerState(local.POSTGRES_CONTAINER);
      const fix = container.exists && !container.running
        ? t('doctor.database.startContainer', local.POSTGRES_CONTAINER)
        : metadata.localServices && metadata.localServices.postgres
          ? t('doctor.database.rerunInit')
          : t('doctor.database.fix');
      add('fail', t('doctor.database'), t('doctor.database.unreachable', url), fix);
    }
  }
  const password = configValue(settingsFile, hostFiles, 'contexa.datasource.password');
  if (password && password.includes('${CONTEXA_DB_PASSWORD}')) {
    add('fail', t('doctor.databasePassword'), t('doctor.databasePassword.missing'), t('doctor.databasePassword.fix'));
  }

  // AI provider
  const priority = (configValue(settingsFile, hostFiles, 'contexa.llm.selection.chat.priority') || metadata.provider || '').split(',')[0].trim();
  const provider = ['ollama', 'openai', 'anthropic'].includes(priority) ? priority : null;
  if (!provider) {
    add('warn', t('doctor.ai'), t('doctor.ai.unknown'));
  } else {
    const needsOllama = provider === 'ollama' || provider === 'anthropic'
      || configValue(settingsFile, hostFiles, 'contexa.llm.selection.embedding.priority') === 'ollama';
    if (needsOllama) {
      const baseUrl = configValue(settingsFile, hostFiles, 'contexa.llm.chat.ollama.base-url') || local.NATIVE_OLLAMA_URL;
      const models = await local.ollamaModels(baseUrl);
      if (!models) {
        add('fail', 'Ollama', t('doctor.ollama.unreachable', baseUrl), t('doctor.ollama.fix'));
      } else {
        const wanted = [
          provider === 'ollama' ? configValue(settingsFile, hostFiles, 'contexa.llm.chat.ollama.model') || 'qwen3:8b' : null,
          configValue(settingsFile, hostFiles, 'contexa.llm.embedding.ollama.model') || 'mxbai-embed-large',
        ].filter(Boolean);
        const missing = wanted.filter(model => !local.hasModel(models, model));
        if (missing.length) add('fail', 'Ollama', t('doctor.ollama.models', missing.join(', ')), t('doctor.runInit'));
        else add('ok', 'Ollama', `${baseUrl} (${wanted.join(', ')})`);
      }
    }
    const key = providerKey(provider);
    if (key) {
      const configured = configValue(settingsFile, hostFiles, key.property);
      if ((configured && !configured.includes('${')) || process.env[key.env] || await hasCredential(key.property)) {
        add('ok', t('doctor.apiKey', provider), t('doctor.apiKey.found'));
      } else {
        add('fail', t('doctor.apiKey', provider), t('doctor.apiKey.missing'), t('doctor.apiKey.fix', key.env, credentialsPath()));
      }
    }
  }

  if (!installRoot) add('warn', t('doctor.record'), t('doctor.record.none'));
  print(results);
  if (!results.some(result => result.status === 'fail')) {
    console.log(chalk.white(`\n  ${t('doctor.ready')}`));
    for (const line of runCommandText(project).split('\n')) console.log(chalk.cyan(`    ${line}`));
  }
  console.log('');
  return results;
}

function print(results) {
  for (const result of results) {
    const mark = result.status === 'ok' ? chalk.green('v') : result.status === 'warn' ? chalk.yellow('!') : chalk.red('x');
    const detail = result.detail ? chalk.gray(` ${result.detail}`) : '';
    console.log(`  ${mark} ${result.label}:${detail}`);
    if (result.fix) console.log(chalk.yellow(`      -> ${result.fix}`));
  }
  if (results.some(result => result.status === 'fail')) process.exitCode = 1;
  return results;
}

module.exports = function registerDoctorCommand(program) {
  program
    .command('doctor')
    .description(t('doctor.description'))
    .option('--dir <path>', t('init.option.dir'))
    .action(runDoctor);
};
module.exports.runDoctor = runDoctor;
module.exports.findInstallRoot = findInstallRoot;
module.exports.resolvePlaceholder = resolvePlaceholder;
module.exports.parseJdbcUrl = parseJdbcUrl;
