'use strict';

// `contexa init`: add Contexa to a Spring Boot 3 application and get it running.
//
//   1. Find the application (or create a sample one in an empty folder).
//   2. Check what would stop it before anything is changed: Spring Boot and Java versions,
//      the main class, Docker or an existing PostgreSQL, Ollama or an API key.
//   3. Ask at most one question (the AI model provider) and show the plan.
//   4. Prepare the local services (PostgreSQL, Ollama, models). The project is untouched so far.
//   5. Change the project in one transaction: build file, @EnableAISecurity, Contexa settings.
//      Resolve the dependencies with the project's own build tool; on failure every change is
//      rolled back and the reason shown.
//   6. Offer to start the application and confirm it is up.
//
// Running it again is safe: what is already in place is kept, what is missing is added.

const chalk = require('chalk');
const crypto = require('crypto');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const ora = require('ora');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const releaseManifest = require('../../release-manifest.json');
const { t } = require('./i18n');
const { detectSpringProject } = require('./detector');
const {
  INSTALL_MODES,
  acquireInstallLock,
  backupRoot,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  recordChange,
  recordInstallMetadata,
  releaseInstallLock,
  rollbackInstallTransaction,
  sha256FileSync,
  stateRoot,
} = require('./manifest');
const {
  injectGradleDep,
  injectMavenDep,
  injectSpringAiDeps,
  injectEnableAiSecurity,
} = require('./injector/build');
const {
  planContexaConfig,
  ADMIN_PASSWORD_PROPERTY,
  APP_USER_PASSWORD_PROPERTY,
  buildContexaSettings,
  writeContexaConfig,
  providerKey,
} = require('./injector/config');
const {
  APPROXIMATE_MODEL_SIZE_GB,
  normalizeProvider,
  ollamaModels,
  usesOllama,
} = require('./provider');
const local = require('./local-infra');
const { pullOllamaModelWithProgress } = require('./ollama');
const { checkDependencies, runCommandText } = require('./build-tool');
const { hasCredential, readCredential, saveCredential, credentialsPath } = require('./credentials');
const { sampleTarget, createSampleProject } = require('./sample-project');
const { runApplication } = require('./app-runner');

const MODE = INSTALL_MODES.NORMAL;

function initError(code, key, ...args) {
  const error = new Error(`${code} ${t(key, ...args)}`);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

function isInteractive(opts) {
  return !opts.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function relative(baseDir, file) {
  return path.relative(baseDir, file).split(path.sep).join('/') || '.';
}

function step(text) {
  return ora({ text, discardStdin: false }).start();
}

// --- 1. the application ---------------------------------------------------------------------

// A build file that cannot be parsed is reported as such, before anything is changed.
async function detectProject(dir) {
  try {
    return await detectSpringProject(dir, { probeDocker: false });
  } catch (error) {
    if (/malformed|unexpected|unclosed/i.test(error.message || '')) {
      throw initError('INVALID_BUILD_FILE', 'init.error.invalidBuildFile', error.message);
    }
    throw error;
  }
}

async function findApplication(opts, interactive) {
  let dir = path.resolve(opts.dir || process.cwd());
  let project = await detectProject(dir);

  if (project.ambiguousModules.length > 0) {
    if (!interactive) {
      throw initError('MODULE_AMBIGUOUS', 'init.error.moduleAmbiguous',
        project.ambiguousModules.map(module => relative(dir, module)).join(', '));
    }
    const { module } = await inquirer.prompt([{
      type: 'rawlist',
      name: 'module',
      message: t('init.prompt.module'),
      choices: project.ambiguousModules.map(module => ({ name: relative(dir, module), value: module })),
    }]);
    project = await detectProject(module);
  }

  if (!project.isSpring) {
    if (project.buildTool) {
      throw initError('SPRING_BOOT_REQUIRED', 'init.error.notSpringBoot', relative(dir, project.buildFilePath));
    }
    const target = await sampleTarget(dir);
    console.log(chalk.yellow(`  ${t('init.sample.none')}`));
    let create = !interactive;
    if (interactive) {
      ({ create } = await inquirer.prompt([{
        type: 'confirm',
        name: 'create',
        message: t('init.sample.confirm', target),
        default: true,
      }]));
    }
    if (!create) throw initError('CANCELLED', 'init.cancelled');
    const sample = await createSampleProject(target);
    console.log(chalk.green(`  v ${t('init.sample.created', sample.projectDir)}`));
    dir = sample.projectDir;
    project = await detectProject(dir);
    project.createdSample = true;
  }
  return { installRoot: dir, project };
}

// --- 2. checks before any change ------------------------------------------------------------

// The Java the Gradle and Maven wrappers run on: JAVA_HOME when set, otherwise java on PATH.
function javaExecutable() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'java';
}

function javaMajorVersion() {
  // Test hook: the Java version without running java.
  if (process.env.CONTEXA_TEST_JAVA_VERSION) return Number(process.env.CONTEXA_TEST_JAVA_VERSION) || null;
  const result = spawnSync(javaExecutable(), ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

// Spring Boot versions Contexa 0.1.x starts on: 3.5.x. On 3.4 and older its task executor bean
// clashes with the one Spring Boot names taskExecutor, and the application does not start (F-52);
// 4.x is not supported yet.
function bootSupport(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)/);
  if (!match) return 'unknown';
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major >= 4) return 'too-new';
  if (major < 3 || (major === 3 && minor < 5)) return 'too-old';
  return 'supported';
}

function checkProject(project, java = javaMajorVersion()) {
  const warnings = [];
  const version = project.springBootVersion;
  if (version) {
    const support = bootSupport(version);
    if (support === 'too-new') throw initError('SPRING_BOOT_UNSUPPORTED', 'init.error.boot4', version);
    if (support === 'too-old') throw initError('SPRING_BOOT_TOO_OLD', 'init.error.bootOld', version);
  } else {
    warnings.push(t('init.warn.bootUnknown'));
  }
  if (java === null) throw initError('JAVA_REQUIRED', 'init.error.javaMissing');
  if (java < 17) warnings.push(t('init.warn.javaOld', java));
  if (project.mainApplicationCandidates.length === 0) {
    throw initError('MAIN_CLASS_MISSING', 'init.error.mainClassMissing');
  }
  return { warnings, java };
}

async function chooseMainClass(project, installRoot, interactive) {
  const candidates = project.mainApplicationCandidates;
  if (candidates.length === 1 || project.hasEnableAiSecurity) return candidates[0];
  if (!interactive) {
    throw initError('MAIN_CLASS_AMBIGUOUS', 'init.error.mainClassAmbiguous',
      candidates.map(file => relative(installRoot, file)).join(', '));
  }
  const { file } = await inquirer.prompt([{
    type: 'rawlist',
    name: 'file',
    message: t('init.prompt.mainClass'),
    choices: candidates.map(candidate => ({ name: relative(installRoot, candidate), value: candidate })),
  }]);
  return file;
}

// --- 3. the one question --------------------------------------------------------------------

async function chooseProvider(opts, previous, interactive) {
  const fromFlag = normalizeProvider(opts.provider);
  if (fromFlag) return fromFlag;
  if (!interactive) return previous || 'ollama';
  const { provider } = await inquirer.prompt([{
    type: 'rawlist',
    name: 'provider',
    message: t('init.prompt.provider'),
    default: ['ollama', 'openai', 'anthropic'].indexOf(previous || 'ollama'),
    choices: [
      { name: t('init.prompt.provider.ollama'), value: 'ollama' },
      { name: t('init.prompt.provider.openai'), value: 'openai' },
      { name: t('init.prompt.provider.anthropic'), value: 'anthropic' },
    ],
  }]);
  return provider;
}

// The admin-console account when Contexa provides the sign-in of an existing application (the
// example application has the sample accounts). Contexa creates it at the first start from
// contexa.iam.seed.admin.password; the password is made once and kept with the API keys, outside
// the project, so a deployment without that file never gets this account. An application that
// configures Contexa's seed accounts itself is left to its own settings.
async function planAdministrator(project, securityMode) {
  if (securityMode !== 'full' || project.createdSample) return null;
  for (const key of project.hostConfigKeys) {
    if (key.startsWith('contexa.iam.seed.admin.') || key === 'contexa.iam.seed.accounts.enabled') return null;
  }
  const saved = await readCredential(ADMIN_PASSWORD_PROPERTY);
  return { username: 'admin', password: saved || generatePassword(), saved: !!saved };
}

// An application that keeps its own sign-in and relies on Spring Boot's default user (the
// password Spring Boot logs at the start) would lose it with Contexa: Spring Boot does not create
// the user once the OAuth2 classes of the starter are on the classpath, and with Contexa's
// delegating password encoder it would store a generated password that no sign-in can match
// (F-50). So the user is kept with a password made once and kept outside the project, like the
// admin-console password. Applications with users of their own, with OAuth2 or SAML of their own,
// or with spring.security.user.* set are left alone.
async function planBootDefaultUser(project, securityMode) {
  if (securityMode !== 'sandbox' || project.hostDefinesUsers || project.hostSecurityAlternative) return null;
  if ([...project.hostConfigKeys].some(key => key.startsWith('spring.security.user.'))) return null;
  const saved = await readCredential(APP_USER_PASSWORD_PROPERTY);
  const password = saved ? saved.replace(/^\{noop\}/, '') : generatePassword();
  return { username: 'user', password, saved: !!saved };
}

// Letters and digits that cannot be mistaken for each other when typed from the screen.
function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

// API key for OpenAI / Anthropic: set in the application, an environment variable, a key saved
// earlier, or entered now (then kept outside the project).
async function ensureApiKey(provider, project, interactive) {
  const key = providerKey(provider);
  if (!key) return { source: null };
  if (project.hostConfigKeys.has(key.property)) return { source: 'application' };
  if (process.env[key.env]) return { source: 'environment', env: key.env };
  if (await hasCredential(key.property)) return { source: 'saved' };
  if (!interactive) throw initError('API_KEY_REQUIRED', 'init.error.apiKeyMissing', key.env);
  const { value } = await inquirer.prompt([{
    type: 'password',
    name: 'value',
    mask: '*',
    message: t('init.prompt.apiKey', provider === 'openai' ? 'OpenAI' : 'Anthropic'),
    validate: input => (String(input).trim().length >= 10 ? true : t('init.prompt.apiKey.invalid')),
  }]);
  return { source: 'entered', property: key.property, value: String(value).trim() };
}

// --- local services -------------------------------------------------------------------------

function localProblemError(problem) {
  const error = initError(problem.code, `init.problem.${problem.code}`, ...(problem.args || []));
  error.hintKey = `init.problem.${problem.code}.hint`;
  return error;
}

async function resolveLocalServices(opts, provider, interactive, securityMode) {
  for (;;) {
    const external = opts.dbUrl ? {
      url: opts.dbUrl,
      username: opts.dbUsername || 'contexa',
      password: null,
    } : null;
    const plan = await local.planLocalServices({
      needOllama: usesOllama(provider),
      needPostgres: !external,
      wantMail: securityMode === 'full',
    });
    if (plan.problems.length === 0) return { plan, external };
    const problem = plan.problems[0];
    if (!interactive) throw localProblemError(problem);
    const choices = [];
    if (problem.code === 'DOCKER_STOPPED') {
      choices.push({ name: t('init.problem.retryDocker'), value: 'retry' });
    }
    if (problem.code === 'OLLAMA_MISSING') {
      choices.push({ name: t('init.problem.retryOllama'), value: 'retry' });
      if (provider === 'ollama') choices.push({ name: t('init.problem.useOpenAi'), value: 'openai' });
    }
    if (['DOCKER_MISSING', 'DOCKER_STOPPED', 'DOCKER_COMPOSE_MISSING'].includes(problem.code) && !external) {
      choices.push({ name: t('init.problem.ownPostgres'), value: 'own-db' });
    }
    choices.push({ name: t('init.problem.cancel'), value: 'cancel' });
    console.log(chalk.yellow(`\n  ! ${t(`init.problem.${problem.code}`, ...(problem.args || []))}`));
    console.log(chalk.gray(`    ${t(`init.problem.${problem.code}.hint`)}`));
    const { action } = await inquirer.prompt([{
      type: 'rawlist', name: 'action', message: t('init.problem.question'), choices,
    }]);
    if (action === 'cancel') throw initError('CANCELLED', 'init.cancelled');
    if (action === 'openai') return { switchProvider: 'openai' };
    if (action === 'own-db') {
      const answers = await inquirer.prompt([
        {
          type: 'input', name: 'url', message: t('init.prompt.dbUrl'),
          validate: input => (/^jdbc:postgresql:\/\/.+/.test(String(input).trim()) ? true : t('init.prompt.dbUrl.invalid')),
        },
        { type: 'input', name: 'username', message: t('init.prompt.dbUsername'), default: 'contexa' },
      ]);
      opts.dbUrl = answers.url.trim();
      opts.dbUsername = answers.username.trim();
    }
  }
}

async function prepareLocalServices(plan, project, installRoot, provider, models) {
  const starting = (plan.postgres && plan.postgres.action !== 'reuse')
    || (plan.ollama && plan.ollama.mode === 'docker' && plan.ollama.action !== 'reuse');
  const spinner = step(starting ? t('init.step.startingServices') : t('init.step.checkingServices'));
  let endpoints;
  try {
    endpoints = await local.startLocalServices(plan);
    spinner.succeed(starting ? t('init.step.servicesStarted') : t('init.step.servicesReady'));
  } catch (error) {
    spinner.fail(t('init.step.servicesFailed'));
    throw error;
  }
  let database = null;
  if (plan.postgres) {
    const dbSpinner = step(t('init.step.database'));
    try {
      database = await local.ensureProjectDatabase(installRoot, project.projectName);
      dbSpinner.succeed(t(database.created ? 'init.step.databaseCreated' : 'init.step.databaseReady', database.database));
    } catch (error) {
      dbSpinner.fail(t('init.step.databaseFailed'));
      throw error;
    }
  }
  if (endpoints.ollamaBaseUrl) {
    const wanted = provider === 'ollama' ? [models.chat, models.embedding] : [models.embedding];
    const missing = await local.missingModels(endpoints.ollamaBaseUrl, wanted);
    const port = Number(new URL(endpoints.ollamaBaseUrl).port || 11434);
    for (const model of missing) {
      const label = t('init.step.model', model);
      const modelSpinner = step(label);
      try {
        await pullOllamaModelWithProgress(port, model, modelSpinner, label, { timeoutMs: 60 * 60 * 1000 });
        modelSpinner.succeed(t('init.step.modelReady', model));
      } catch (error) {
        modelSpinner.fail(t('init.step.modelFailed', model));
        throw initError('MODEL_DOWNLOAD_FAILED', 'init.error.modelDownload', model, error.message);
      }
    }
  }
  return { endpoints, database };
}

// --- plan ------------------------------------------------------------------------------------

function printPlan(context) {
  const { project, installRoot, mainClass, securityMode, configPlan, provider, services, external, models, apiKey } = context;
  const out = line => console.log(chalk.gray(`    - ${line}`));
  console.log(chalk.cyan(`\n  ${t('init.plan.title')}`));
  console.log(chalk.white(`  ${t('init.plan.project')}`));
  out(t('init.plan.build', relative(installRoot, project.buildFilePath)));
  if (!project.hasEnableAiSecurity) {
    out(t(securityMode === 'full' ? 'init.plan.annotationFull' : 'init.plan.annotationSandbox',
      relative(installRoot, mainClass)));
  }
  const configKey = editedSinceLastInit(context.existing, installRoot, configPlan.filePath) ? 'init.plan.configKept'
    : fs.existsSync(configPlan.filePath) ? 'init.plan.configUpdate' : 'init.plan.config';
  out(t(configKey, relative(installRoot, configPlan.filePath)));
  if (configPlan.importTarget) out(t('init.plan.import', relative(installRoot, configPlan.importTarget)));
  else out(t('init.plan.hostConfigKept'));
  console.log(chalk.white(`  ${t('init.plan.computer')}`));
  if (external) {
    out(t('init.plan.externalDb', external.url));
  } else if (services.postgres) {
    out(t(services.postgres.action === 'create' ? 'init.plan.postgresCreate'
      : services.postgres.action === 'start' ? 'init.plan.postgresStart' : 'init.plan.postgresReuse',
    services.postgres.port));
    out(t('init.plan.database'));
  }
  if (services.ollama) {
    out(t(services.ollama.mode === 'native' ? 'init.plan.ollamaNative'
      : services.ollama.action === 'create' ? 'init.plan.ollamaCreate'
        : services.ollama.action === 'start' ? 'init.plan.ollamaStart' : 'init.plan.ollamaReuse',
    services.ollama.baseUrl));
    const wanted = provider === 'ollama' ? [models.chat, models.embedding] : [models.embedding];
    const toDownload = Array.isArray(context.missingModels) ? context.missingModels : wanted;
    if (toDownload.length === 0) {
      out(t('init.plan.modelsPresent', wanted.join(', ')));
    } else {
      const size = toDownload.reduce((sum, model) => sum + (APPROXIMATE_MODEL_SIZE_GB[model] || 0), 0);
      out(t('init.plan.models', toDownload.join(', '), size ? `~${size.toFixed(1)} GB` : '?'));
    }
  }
  if (services.mail) {
    out(t(services.mail.action === 'create' ? 'init.plan.mailCreate' : 'init.plan.mailReuse',
      `http://127.0.0.1:${services.mail.uiPort}`));
  }
  if (context.administrator) {
    out(t(context.administrator.saved ? 'init.plan.adminReuse' : 'init.plan.adminCreate', credentialsPath()));
  }
  if (context.bootDefaultUser) out(t('init.plan.bootUser', credentialsPath()));
  if (apiKey && apiKey.source === 'entered') out(t('init.plan.apiKeySaved', credentialsPath()));
  if (apiKey && apiKey.source === 'environment') out(t('init.plan.apiKeyEnv', apiKey.env));
  console.log(chalk.gray(`  ${t('init.plan.undo')}`));
}

// --- 5. project changes ---------------------------------------------------------------------

function aiProviderArtifacts(provider) {
  return provider === 'anthropic' ? ['anthropic', 'ollama'] : [provider];
}

async function applyProjectChanges(context) {
  const { installRoot, project, mainClass, securityMode, configPlan, settings, provider } = context;
  const plannedFiles = [
    { filePath: project.buildFilePath, kind: 'build-file' },
    { filePath: configPlan.filePath, kind: 'contexa-config' },
  ];
  if (!project.hasEnableAiSecurity) plannedFiles.push({ filePath: mainClass, kind: 'application-source' });
  if (configPlan.importTarget) plannedFiles.push({ filePath: configPlan.importTarget, kind: 'config-import' });

  const transactionId = await beginInstallTransaction(installRoot, {
    projectName: project.projectName,
    integrationMode: 'merge',
    infra: 'skip',
    aiSecurityRequested: true,
  }, MODE, plannedFiles);
  try {
    const options = { mode: MODE, targetModule: relative(installRoot, project.projectDir) };
    const spinner = step(t('init.step.build'));
    const starterAdded = project.buildTool === 'maven'
      ? await injectMavenDep(project.buildFilePath, options)
      : await injectGradleDep(project.buildFilePath, options);
    const aiAdded = await injectSpringAiDeps(project.buildFilePath, aiProviderArtifacts(provider), options);
    if (starterAdded || aiAdded) {
      await recordChange(installRoot, project.buildFilePath, { kind: 'build-file', reason: 'Contexa dependencies' }, MODE);
    }
    spinner.succeed(t(starterAdded || aiAdded ? 'init.step.buildDone' : 'init.step.buildPresent',
      relative(installRoot, project.buildFilePath)));

    if (!project.hasEnableAiSecurity) {
      const annotation = step(t('init.step.annotation'));
      const result = await injectEnableAiSecurity(installRoot, {
        mode: MODE,
        securityMode,
        mainApplicationCandidates: [mainClass],
      });
      if (result.changed) {
        await recordChange(installRoot, result.filePath, { kind: 'application-source', reason: '@EnableAISecurity' }, MODE);
      }
      annotation.succeed(t('init.step.annotationDone', relative(installRoot, result.filePath)));
    }

    const config = step(t('init.step.config'));
    if (editedSinceLastInit(context.existing, installRoot, configPlan.filePath)) {
      // The user changed the settings file after the last init; their version stays. What this
      // run would set differently (another model provider, a new database) is listed, so it can
      // be changed by hand instead of being lost silently.
      const differences = settingsDifferences(context.existing, installRoot, configPlan.filePath, settings);
      if (differences.length === 0) {
        config.info(t('init.step.configKept', relative(installRoot, configPlan.filePath)));
      } else {
        config.warn(t('init.step.configKeptDiffers', relative(installRoot, configPlan.filePath)));
        for (const line of differences) console.log(chalk.yellow(`      ${line}`));
      }
    } else {
      await writeContexaConfig(configPlan, settings);
      await recordChange(installRoot, configPlan.filePath, { kind: 'contexa-config', generated: true, reason: 'Contexa settings' }, MODE);
      if (configPlan.importTarget) {
        await recordChange(installRoot, configPlan.importTarget, { kind: 'config-import', reason: 'spring.config.import' }, MODE);
      }
      config.succeed(t('init.step.configDone', relative(installRoot, configPlan.filePath)));
    }

    // The dependencies have to resolve with the project's own repositories; otherwise the first
    // build would fail, so nothing is kept.
    const check = step(t('init.step.dependencies'));
    const result = await checkDependencies(project);
    if (result.skipped) {
      check.warn(t('init.step.dependenciesSkipped'));
    } else if (!result.ok) {
      check.fail(t('init.step.dependenciesFailed'));
      const starterMissing = result.problems.some(problem => problem.startsWith(`${releaseManifest.starter.groupId}:`));
      const error = initError(starterMissing ? 'STARTER_UNAVAILABLE' : 'DEPENDENCY_RESOLUTION_FAILED',
        starterMissing ? 'init.error.starterUnavailable' : 'init.error.dependencies',
        result.problems.join(', ') || '-');
      if (result.problems.length === 0) error.detail = result.tail;
      throw error;
    } else {
      check.succeed(t('init.step.dependenciesDone'));
    }
    await commitInstallTransaction(installRoot, transactionId, MODE);
  } catch (caught) {
    const error = friendlyFileError(caught);
    const rollback = await rollbackInstallTransaction(installRoot, transactionId, MODE, { failures: [] });
    if (rollback.rolledBack) {
      console.log(chalk.yellow(`  ! ${t('init.rolledBack')}`));
    } else {
      error.message = `${error.message}; ${t('init.rollbackFailed', rollback.failures.join('; '))}`;
    }
    throw error;
  }
}

// Settings this run changes compared with what the last init wrote (another model provider, a
// new database) and that the kept file does not have yet. Values the last init wrote too are the
// user's business: what they changed there by hand is never listed.
function settingsDifferences(manifest, installRoot, filePath, settings) {
  const flatten = (node, prefix, out) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
    } else if (prefix) {
      out[prefix] = node;
    }
    return out;
  };
  const read = file => {
    try {
      return flatten(yaml.load(fs.readFileSync(file, 'utf8')) || {}, '', {});
    } catch {
      return null;
    }
  };
  const entry = manifest && Array.isArray(manifest.files)
    ? manifest.files.find(file => file.relativePath === relative(installRoot, filePath)) : null;
  const last = entry && entry.appliedRelativePath
    ? read(path.join(backupRoot(installRoot, MODE), entry.appliedRelativePath)) : null;
  const current = read(filePath) || {};
  const same = (left, right) => String(left) === String(right);
  return Object.entries(flatten(settings, '', {}))
    .filter(([key, value]) => !(last && key in last && same(last[key], value)))
    .filter(([key, value]) => !(key in current && same(current[key], value)))
    .map(([key, value]) => `${key}: ${value}`);
}

// True when a file the last init wrote has been changed by hand since.
function editedSinceLastInit(manifest, installRoot, filePath) {
  if (!manifest || !Array.isArray(manifest.files) || !fs.existsSync(filePath)) return false;
  const entry = manifest.files.find(file => file.relativePath === relative(installRoot, filePath));
  if (!entry || !entry.cliApplied || !entry.lastCliChecksum) return false;
  return sha256FileSync(filePath) !== entry.lastCliChecksum;
}

// File system errors in plain words: which file, and that nothing was kept.
function friendlyFileError(error) {
  if (!error || error.messageKey || !['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(error.code)) return error;
  return initError('FILE_NOT_WRITABLE', 'init.error.fileNotWritable', error.path || '-');
}

// A failed first init leaves no Contexa state folder behind. This runs while the lock is held and
// keeps the lock file; the folder itself goes after the lock is released, and only if it is empty,
// so a contexa command that took the lock in between keeps its state.
async function clearFailedFirstInit(installRoot, lock) {
  if (await fs.pathExists(manifestPath(installRoot, MODE))) {
    const manifest = await loadManifest(installRoot, MODE).catch(() => null);
    if (!manifest || (Array.isArray(manifest.files) && manifest.files.some(file => file.cliApplied))) return false;
  }
  const root = stateRoot(installRoot, MODE);
  if (!await fs.pathExists(root)) return false;
  for (const entry of await fs.readdir(root)) {
    const entryPath = path.join(root, entry);
    if (path.resolve(entryPath) !== path.resolve(lock.filePath)) await fs.remove(entryPath);
  }
  return true;
}

async function removeFolderIfEmpty(dir) {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
  }
}

// The state folder ignores itself, so backups never end up in source control.
async function ensureStateIgnored(installRoot) {
  const root = stateRoot(installRoot, MODE);
  if (await fs.pathExists(root)) {
    const ignore = path.join(root, '.gitignore');
    if (!await fs.pathExists(ignore)) await fs.writeFile(ignore, '# Contexa installation record and backups\n*\n');
  }
}

// --- 6. done ---------------------------------------------------------------------------------

function printDone(context) {
  const { project, installRoot, apiKey, securityMode } = context;
  console.log(chalk.green(`\n  ${t('init.done.title')}`));
  console.log(chalk.gray(`    - ${t('init.done.mode')}`));
  console.log(chalk.gray(`    - ${t(securityMode === 'full' ? 'init.done.signInContexa' : 'init.done.signInApp')}`));
  if (context.bootDefaultUser) {
    const { username, password } = context.bootDefaultUser;
    console.log(chalk.white(`    - ${t('init.done.bootUser', username, password, credentialsPath())}`));
  }
  if (securityMode === 'full') {
    console.log(chalk.gray(`    - ${context.mailUi ? t('init.done.mailbox', context.mailUi) : t('init.done.mailMissing')}`));
    if (project.createdSample) {
      console.log(chalk.gray(`    - ${t('init.done.sampleAccounts', 'http://localhost:8080/contexa/admin')}`));
    } else if (context.administrator) {
      const { username, password } = context.administrator;
      console.log(chalk.white(`    - ${t('init.done.adminAccount', '/contexa/admin', username, password, credentialsPath())}`));
    }
  }
  if (apiKey && apiKey.source === 'entered') console.log(chalk.gray(`    - ${t('init.done.apiKey', credentialsPath())}`));
  if (context.external) console.log(chalk.yellow(`    - ${t('init.done.dbPassword', context.external.url)}`));
  console.log(chalk.white(`\n  ${t('init.done.run')}`));
  // A folder below the current one reads best as a relative path, anything else as absolute.
  // Both sides as real paths, so a symbolic link in either (macOS /var) does not hide the relation.
  const real = dir => {
    try { return (require('fs').realpathSync.native || require('fs').realpathSync)(dir); } catch { return dir; }
  };
  const below = relative(real(process.cwd()), real(installRoot));
  const runDir = below.startsWith('..') ? installRoot : below;
  if (runDir !== '.') console.log(chalk.cyan(`    cd ${runDir}`));
  for (const line of runCommandText(project).split('\n')) console.log(chalk.cyan(`    ${line}`));
  console.log(chalk.gray(`\n  ${t('init.done.doctor')}`));
  console.log(chalk.gray(`  ${t('init.done.reset')}`));
}

async function offerRun(context) {
  const { project } = context;
  const { run } = await inquirer.prompt([{
    type: 'confirm', name: 'run', message: t('init.run.confirm'), default: true,
  }]);
  if (!run) return;
  console.log(chalk.gray(`\n  ${t('init.run.starting', runCommandText(project).split('\n').join(' ; '))}\n`));
  const result = await runApplication(project, {
    onStarted: ({ port }) => {
      console.log(chalk.green(`\n  v ${t('init.run.started', `http://localhost:${port}`)}`));
      if (context.securityMode === 'full') {
        console.log(chalk.gray(`    ${t('init.run.console', `http://localhost:${port}/contexa/admin`)}`));
      }
      console.log(chalk.gray(`    ${t('init.run.stop')}\n`));
    },
  });
  if (result.outcome === 'failed') {
    console.log(chalk.red(`\n  x ${t('init.run.failed')}`));
    if (result.summary) console.log(chalk.gray(result.summary.split('\n').map(line => `    ${line}`).join('\n')));
    console.log(chalk.yellow(`  -> ${t(result.hint)}`));
    process.exitCode = 1;
  }
}

// --- main ------------------------------------------------------------------------------------

async function executeInit(opts) {
  const interactive = isInteractive(opts);
  console.log(chalk.cyan(`\n  Contexa ${releaseManifest.cliVersion} - ${t('init.title')}\n`));

  const { installRoot, project } = await findApplication(opts, interactive);
  const { warnings } = checkProject(project);
  console.log(chalk.green(`  v ${t('init.found', project.projectName || path.basename(project.projectDir),
    project.buildTool === 'maven' ? 'Maven' : 'Gradle', project.springBootVersion || '?')}`));
  for (const warning of warnings) console.log(chalk.yellow(`  ! ${warning}`));

  const existing = await fs.pathExists(manifestPath(installRoot, MODE))
    ? await loadManifest(installRoot, MODE).catch(() => null) : null;
  if (existing && project.hasContexta) console.log(chalk.gray(`  ${t('init.again')}`));

  const mainClass = await chooseMainClass(project, installRoot, interactive);
  // The application keeps sign-in when it declares its own SecurityFilterChain (Contexa's
  // SANDBOX default); otherwise Contexa provides sign-in (FULL).
  const securityMode = project.hasHostSecurityFilterChain ? 'sandbox' : 'full';

  let provider = await chooseProvider(opts, existing && existing.metadata && existing.metadata.provider, interactive);
  let resolved = await resolveLocalServices(opts, provider, interactive, securityMode);
  if (resolved.switchProvider) {
    provider = resolved.switchProvider;
    resolved = await resolveLocalServices(opts, provider, interactive, securityMode);
  }
  const { plan, external } = resolved;
  const apiKey = await ensureApiKey(provider, project, interactive);
  const administrator = await planAdministrator(project, securityMode);
  const bootDefaultUser = await planBootDefaultUser(project, securityMode);
  const models = ollamaModels();

  // Only the settings file Contexa wrote is its own: the application's file that got the import
  // line is recorded as changed too, but it stays the application's (F-51).
  const ownedPaths = new Set(((existing && existing.files) || [])
    .filter(file => file.cliApplied && file.kind === 'contexa-config')
    .map(file => relative(project.projectDir, path.join(installRoot, file.relativePath))));
  const configPlan = await planContexaConfig(project.projectDir, ownedPaths);

  // Which models still have to be downloaded, when Ollama can already be asked.
  let missingModels = null;
  if (plan.ollama) {
    const wanted = provider === 'ollama' ? [models.chat, models.embedding] : [models.embedding];
    if (plan.ollama.action === 'create') missingModels = wanted;
    else if (plan.ollama.action === 'reuse') missingModels = await local.missingModels(plan.ollama.baseUrl, wanted);
  }

  const context = {
    installRoot, project, mainClass, securityMode, configPlan, provider,
    services: plan, external, models, apiKey, missingModels, existing, administrator, bootDefaultUser,
  };
  printPlan(context);
  if (interactive) {
    const { proceed } = await inquirer.prompt([{
      type: 'confirm', name: 'proceed', message: t('init.plan.confirm'), default: true,
    }]);
    if (!proceed) {
      console.log(chalk.yellow(`\n  ${t('init.cancelled')}\n`));
      return;
    }
  }
  console.log('');

  // Local services first: if they cannot be prepared, the project stays as it was.
  const prepared = await prepareLocalServices(plan, project, installRoot, provider, models);
  const database = external || prepared.database;
  context.mailUi = prepared.endpoints.mail ? prepared.endpoints.mail.uiUrl : null;
  if (apiKey.source === 'entered') await saveCredential(apiKey.property, apiKey.value);
  if (administrator && !administrator.saved) await saveCredential(ADMIN_PASSWORD_PROPERTY, administrator.password);
  if (bootDefaultUser && !bootDefaultUser.saved) {
    await saveCredential(APP_USER_PASSWORD_PROPERTY, `{noop}${bootDefaultUser.password}`);
  }

  context.settings = buildContexaSettings({
    database,
    provider,
    ollamaBaseUrl: prepared.endpoints.ollamaBaseUrl,
    mail: prepared.endpoints.mail,
    chatModel: models.chat,
    embeddingModel: models.embedding,
    hostOwnsDatabase: project.hostOwnsDatabase,
    hostConfigKeys: project.hostConfigKeys,
    credentialsImport: !!administrator || !!bootDefaultUser,
    bootDefaultUser: !!bootDefaultUser,
  });

  // Taken outside the try: when another contexa command holds the project, its state is not
  // touched at all.
  let lock = await acquireInstallLock(installRoot, MODE, 'init');
  try {
    await applyProjectChanges(context);
    await recordInstallMetadata(installRoot, {
      provider,
      securityMode,
      configFile: relative(installRoot, configPlan.filePath),
      database: database ? { name: database.database || null, url: database.url, external: !!external } : null,
      localServices: { postgres: !!plan.postgres, ollama: plan.ollama ? plan.ollama.mode : null },
    }, MODE);
    await ensureStateIgnored(installRoot);
  } catch (error) {
    const cleared = await clearFailedFirstInit(installRoot, lock).catch(() => false);
    await releaseInstallLock(lock);
    lock = null;
    if (cleared) await removeFolderIfEmpty(stateRoot(installRoot, MODE));
    throw error;
  } finally {
    await releaseInstallLock(lock);
  }
  if (!external) {
    await local.registerProject(installRoot, { database: database && database.database, provider });
  }

  printDone(context);
  if (interactive) await offerRun(context);
  console.log('');
}

module.exports = { executeInit, checkProject, bootSupport, javaMajorVersion };
