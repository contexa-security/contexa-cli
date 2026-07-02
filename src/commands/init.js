'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const inquirer = require('inquirer');
const path  = require('path');
const os    = require('os');
const fs    = require('fs-extra');
const { Option } = require('commander');
const { dockerSync, dockerTry, dockerCompose, isDockerCliInstalled, isDockerDaemonRunning } = require('../core/docker');
const { execSync } = require('child_process');
const http = require('http');
const https = require('https');

// Normalize a user-entered path so that:
//   1) "~" or "~/..." is expanded to the OS home directory (shells do this
//      for command-line args, but inquirer prompt input does not).
//   2) Relative paths resolve against `baseDir` (typically opts.dir, the
//      customer's project root). path.resolve() alone resolves against
//      process.cwd(), which is wrong when the user passed --dir <other>.
function normalizePath(input, baseDir) {
  if (!input) return null;
  let p = String(input).trim();
  if (!p) return null;
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(2));
  }
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir, p);
}
function normalizeProviders(providerOpt, includeOllama) {
  if (providerOpt) {
    const values = String(providerOpt).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
    if (values.includes('none')) return [];
    const allowed = new Set(['openai', 'anthropic', 'ollama']);
    const invalid = values.filter(v => !allowed.has(v));
    if (invalid.length > 0) {
      throw new Error(`Unsupported provider: ${invalid.join(', ')}. Use openai, anthropic, ollama, or none.`);
    }
    return [...new Set(values)];
  }
  return includeOllama ? ['ollama'] : [];
}

function aiProviderSelected(answers) {
  return Array.isArray(answers.llmProviders) && answers.llmProviders.length > 0;
}

function printPlannedChanges(answers, project, paths) {
  const msg = (key, fallback) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };

  console.log(chalk.cyan(`\n  ${msg('planned.title', 'Planned changes')}`));
  const items = [];
  if (answers.integrationMode === 'standalone') {
    items.push(`${msg('planned.createStandalone', 'Create Contexa-only files')}: ${paths.standaloneDir}`);
  } else {
    items.push(`${msg('planned.addStarter', 'Add starter dependency')}: ${paths.buildPath}`);
    items.push(`${msg('planned.applyMinimal', 'Apply minimal Contexa settings')}: ${paths.ymlPath}`);
  }
  if (answers.enableAiSecurity) {
    items.push(`${msg('planned.enableAi', 'Enable AI security settings')} (${answers.llmProviders.join(', ')})`);
    if (answers.autoAnnotate) {
      items.push(msg('planned.autoAnnotate', 'Auto-add @EnableAISecurity'));
    } else if (!project.hasEnableAiSecurity) {
      items.push(msg('planned.manualAnnotate', 'Add @EnableAISecurity manually after init'));
    }
  } else {
    items.push(msg('planned.aiDisabled', 'AI security remains disabled for now'));
  }
  if (answers.infra !== 'skip') {
    items.push(msg('planned.createInfra', 'Create selected infrastructure files'));
  }
  for (const item of items) console.log(chalk.gray(`    - ${item}`));
}
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

const { detectSpringProject } = require('../core/detector');
const { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
        injectSpringAiDeps, injectEnableAiSecurity, injectStandalone,
        generateDockerCompose } = require('../core/injector');
const { inspectInfra } = require('../core/preflight');
const { resolveProjectName, containerName, resolveInfraDir } = require('../core/project');
const { t, setLocale, getLocale } = require('../core/i18n');
const { recordChange, recordInstallMetadata } = require('../core/manifest');

module.exports = function (program) {
  program
    .command('init')
    .description('Initialize Contexa AI Security in your Spring project')
    .option('--yes', 'Skip prompts, use defaults')
    .option('--force', 'Reinitialize even if already configured')
    .option('--dir <path>', 'Project directory', process.cwd())
    // Infrastructure provisioning is OPT-IN. Without --distributed, contexa init
    // only updates application.yml and adds the starter dependency - it does NOT
    // generate docker-compose.yml, does NOT generate initdb scripts, and does NOT
    // start any containers. Customers who already run their own Postgres/Ollama
    // (and Redis/Kafka) infrastructure are unaffected by re-running init.
    //
    // --distributed installs the full PoC/demo stack:
    //   PostgreSQL + Redis + Zookeeper + Kafka  (+ Ollama if --include-ollama)
    // --no-docker (only meaningful with --distributed) generates compose files
    // but does not run "docker compose up -d". Database schema/seed data is
    // installed by the contexa-iam runtime initializer when the application
    // starts, not by contexa-cli.
    //
    // AI security is opt-in. Basic init installs the starter and minimal Contexa
    // settings only. --enable-ai-security / wizard consent controls provider
    // dependencies, LLM settings, and optional @EnableAISecurity insertion.
    // --include-ollama only opts in to the local Ollama runtime when AI security
    // is explicitly enabled or simulation is requested.
    .option('--distributed', 'Install distributed infrastructure (Postgres + Redis + Kafka) for PoC/enterprise demo')
    .option('--include-ollama', 'Include the local Ollama LLM runtime (off by default; required for offline / no-API-key operation)')
    .option('--no-docker', 'With --distributed: generate compose files but do not start containers')
    .option('--simulate', 'Install isolated simulation stack (ctxa-sim-* containers on +20000 ports) so you can practice the manual install flow without colliding with production. Implies --distributed.')
    .option('--quick', 'Use the guided quick path without showing advanced choices')
    .option('--enable-ai-security', 'Enable AI security integration during init')
    .option('--provider <name>', 'AI provider to configure for explicit AI security activation: openai, anthropic, ollama, none. Comma-separated values are allowed.')
    .option('--auto-annotate', 'When AI security is enabled, add @EnableAISecurity to the main Spring Boot application class')
    // The two integration modes. By default the prompt asks the user; these
    // flags exist for prompt-bypass automation.
    .option('--merge', 'Merge mode: write contexa.* into the customer build/yml (default)')
    .option('--standalone', 'Standalone mode: place contexa-only build/yml under a separate directory; never touch customer originals')
    .option('--standalone-dir <path>', 'Standalone mode output directory (default: <projectDir>/contexa)')
    // Infrastructure files (docker-compose.yml) are ALWAYS written
    // outside the customer project directory. Default: contexa-owned home
    // (Linux/macOS: $XDG_CONFIG_HOME/contexa/<projectName> or $HOME/.contexa/<name>;
    // Windows: %LOCALAPPDATA%\Contexa\<projectName>). Override with --infra-dir.
    .option('--infra-dir <path>', 'Override the contexa-owned directory used for docker-compose.yml')
    .option('--check', 'Run environment diagnostic check and exit')
    .action(async (opts) => {
      // --simulate isolates this run from any other contexa stack on the same
      // host: separate compose project name, separate container names, and
      // separate ports. Implemented as preset env vars consumed by both the
      // generated docker-compose.yml and the runtime contexa.* / spring.*
      // env-fallback placeholders the CLI writes into application.yml.
      if (opts.simulate) {
        opts.distributed = true;
        // --simulate stack is fully isolated and meant for hands-on practice
        // without external API keys; Ollama is auto-included here so the demo
        // works end-to-end with no cloud credentials.
        opts.includeOllama = true;
        const setIfAbsent = (k, v) => { if (!process.env[k]) process.env[k] = v; };
        setIfAbsent('CONTEXA_PROJECT',          'ctxa-sim');
        setIfAbsent('CONTEXA_POSTGRES_PORT',    '25432');
        setIfAbsent('CONTEXA_OLLAMA_PORT',      '31434');
        setIfAbsent('CONTEXA_REDIS_PORT',       '26379');
        setIfAbsent('CONTEXA_ZOOKEEPER_PORT',   '22181');
        setIfAbsent('CONTEXA_KAFKA_PORT',       '29092');
        setIfAbsent('CONTEXA_DB_NAME',          'contexa_sim');
        setIfAbsent('CONTEXA_DB_USERNAME',      'contexa_sim');
        setIfAbsent('CONTEXA_DB_PASSWORD',      'contexa_sim_pw');
        setIfAbsent('CONTEXA_DB_URL',           `jdbc:postgresql://localhost:${process.env.CONTEXA_POSTGRES_PORT}/${process.env.CONTEXA_DB_NAME}`);
        setIfAbsent('OLLAMA_BASE_URL',          `http://127.0.0.1:${process.env.CONTEXA_OLLAMA_PORT}`);
        setIfAbsent('REDIS_HOST',               'localhost');
        setIfAbsent('REDIS_PORT',               process.env.CONTEXA_REDIS_PORT);
        setIfAbsent('KAFKA_BOOTSTRAP_SERVERS',  `localhost:${process.env.CONTEXA_KAFKA_PORT}`);
        console.log(chalk.cyan('\n  Simulation mode: isolated stack "ctxa-sim"'));
        console.log(chalk.gray(`    Postgres : 127.0.0.1:${process.env.CONTEXA_POSTGRES_PORT}  (production stays on 5432)`));
        console.log(chalk.gray(`    Ollama   : 127.0.0.1:${process.env.CONTEXA_OLLAMA_PORT}  (production stays on 11434)`));
        console.log(chalk.gray(`    Redis    : 127.0.0.1:${process.env.CONTEXA_REDIS_PORT}`));
        console.log(chalk.gray(`    Kafka    : 127.0.0.1:${process.env.CONTEXA_KAFKA_PORT}`));
        console.log(chalk.gray('    Reset anytime: docker compose -p ctxa-sim down -v && docker compose -p ctxa-sim up -d'));
      }
      if (opts.distributed) {
        console.log(chalk.yellow('\n  ! ' + t('init.distributed.warning')));
        console.log(chalk.gray('    ' + t('init.distributed.note') + '\n'));
      }
      console.log('');

      // 0. Pre-installation environment check (--check or forced diagnostic check)
      if (opts.check || !opts.yes) {
        console.log(chalk.cyan(`\n  [Diagnostic] Running Pre-installation Checks...`));
        let checkPass = true;

        // Check Java
        try {
          const javaVerOutput = execSync('java -version 2>&1').toString();
          const match = javaVerOutput.match(/version "(.*?)"/);
          const version = match ? match[1] : 'unknown';
          const isJava17 = version.startsWith('17') || parseInt(version.split('.')[0], 10) >= 17;
          if (!isJava17) {
            checkPass = false;
            console.log(chalk.red(`  x Java version: ${version} (Java 17+ required)`));
            console.log(chalk.gray(`    -> FIX: Install OpenJDK 17+. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
          }
        } catch {
          checkPass = false;
          console.log(chalk.red(`  x Java is not installed or not in PATH.`));
          console.log(chalk.gray(`    -> FIX: Install JDK 17 and configure JAVA_HOME. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
        }

        // Docker is required only when the user explicitly asks for local infrastructure.
        const needsDockerPrecheck = !!(opts.distributed || opts.simulate);
        if (needsDockerPrecheck) {
          const hasDockerCli = isDockerCliInstalled();
          const hasDockerDaemon = hasDockerCli && isDockerDaemonRunning();
          if (!hasDockerCli) {
            checkPass = false;
            console.log(chalk.red(`  x Docker CLI is not installed.`));
            console.log(chalk.gray(`    -> FIX: Install Docker Desktop: https://www.docker.com/products/docker-desktop \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
          } else if (!hasDockerDaemon) {
            checkPass = false;
            console.log(chalk.red(`  x Docker daemon is not running.`));
            console.log(chalk.gray(`    -> FIX: Open Docker Desktop or run 'sudo systemctl start docker'. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
          }
        } else {
          console.log(chalk.gray(`  - Docker check skipped. Basic init does not install local infrastructure.`));
        }

        if (!checkPass) {
          console.log(chalk.yellow(`\n  ! Pre-installation checks encountered issues.`));
          console.log(chalk.yellow(`    Please run 'contexa doctor' for a full diagnostic report.`));
          if (opts.check) {
            process.exit(1);
          }
        } else {
          console.log(chalk.green(`  v Pre-installation checks passed.`));
          if (opts.check) {
            console.log(chalk.green(`\n  v Environment check successful. You can safely run 'contexa init'.\n`));
            process.exit(0);
          }
        }
        console.log('');
      }

      // 1. Detect project
      const spinner = ora(t('init.detecting')).start();
      const project = await detectSpringProject(opts.dir);
      spinner.stop();

      if (!project.isSpring) {
        console.log(chalk.red('  x ' + t('init.notSpring')));
        console.log(chalk.gray('    ' + t('init.notSpring.hint') + '\n'));
        process.exit(1);
      }

      console.log(chalk.green('  v ' + t('init.detected')));
      console.log(chalk.gray(`    ${t('init.detected.project')} : ${project.projectName || 'unknown'}`));
      console.log(chalk.gray(`    ${t('init.detected.build')}   : ${project.buildTool}`));
      console.log(chalk.gray(`    ${t('init.detected.security')}: ${project.hasSpringSecurityCore ? t('init.security.springSecurity') : chalk.yellow(t('init.security.legacy'))}`));
      console.log(chalk.gray(`    ${t('init.detected.docker')}  : ${project.hasDocker ? chalk.green(t('init.docker.installed')) : chalk.yellow(t('init.docker.missing'))}`));

      const cliProjectName = opts.simulate
        ? 'ctxa-sim'
        : resolveProjectName(project.projectName || path.basename(path.resolve(opts.dir)));
      if (!process.env.CONTEXA_PROJECT) {
        process.env.CONTEXA_PROJECT = cliProjectName;
      }

      // Docker is only consulted when the user explicitly opted into infra
      // provisioning via --distributed. Without --distributed, init does not
      // touch infrastructure regardless of whether Docker is installed.
      const wantsContainers = opts.distributed && opts.docker !== false;
      if (!project.hasDocker && wantsContainers) {
        console.log('');
        console.log(chalk.yellow('  ! Docker is required to start the distributed infrastructure.'));
        console.log(chalk.gray('    This run will still write compose files so you can start them later.'));
        console.log(chalk.gray('    To install Docker:'));
        console.log(chalk.gray('      Windows / macOS : https://www.docker.com/products/docker-desktop'));
        console.log(chalk.gray('      Linux           : https://docs.docker.com/engine/install/'));
        console.log(chalk.gray('    To skip infrastructure entirely, abort and re-run without --distributed.'));
        console.log('');
        // Auto-flip to "files only" mode so we never try to call docker compose.
        opts.docker = false;
      }

      // Warn when both application.properties and application.yml exist - one shadows the other.
      if (project.appPropertiesPath && project.appYmlPath) {
        console.log(chalk.yellow('  ! ' + t('scan.propertiesAndYml')));
      }

      if (project.hasContexta) {
        if (!opts.force && !opts.yes) {
          console.log(chalk.yellow('  ' + t('init.alreadyDetected')));
          console.log(chalk.gray('    ' + t('init.alreadyDetected.hint') + '\n'));
          process.exit(0);
        }
        console.log(chalk.yellow('  ' + t('init.alreadyDetected.update') + '\n'));
      }

      // 2. Prompts
      //
      // Decision policy: the user is NOT expected to know any flag names. Every
      // non-trivial decision is asked by inquirer when running `contexa init`
      // without flags. Flags only exist as prompt-bypass for advanced users /
      // CI automation:
      //   --lang ko|en                  bypass the language prompt
      //   --merge / --standalone        bypass the integration-mode prompt
      //   --standalone-dir <path>       bypass the standalone-folder prompt
      //   --infra-dir <path>            bypass the infra-folder prompt
      //   --distributed                 explicit "install distributed infra" intent
      //   --simulate                    explicit "isolated simulation" intent
      //   --no-docker                   explicit "do not start containers" intent
      //   --yes                         CI automation: skip every prompt
      //
      // Step 2a: language. Asked first so every subsequent prompt renders in
      // the operator's preferred language. Skipped when --lang or --yes is
      // explicitly given (CI / scripted runs).
      const langFlagGiven = process.argv.includes('--lang');
      if (!langFlagGiven && !opts.yes) {
        console.log('');
        const langAnswer = await inquirer.prompt([{
          type: 'rawlist',
          name: 'lang',
          message: t('lang.choose') + '\n',
          default: getLocale() === 'ko' ? 2 : 1,
          choices: [
            { name: t('lang.choice.en'), value: 'en' },
            { name: t('lang.choice.ko'), value: 'ko' },
          ],
        }]);
        setLocale(langAnswer.lang);
      }

      const explicitIntegrationMode = opts.standalone ? 'standalone'
        : opts.merge ? 'merge'
        : null;

      const providerFromFlags = normalizeProviders(opts.provider, opts.includeOllama);
      const explicitAiSecurity = !!(opts.enableAiSecurity || opts.autoAnnotate || opts.provider || opts.includeOllama || opts.simulate);
      const defaults = {
        setupMode: opts.quick ? 'quick' : 'quick',
        integrationMode: explicitIntegrationMode || 'merge',
        securityMode: 'full',
        mode: 'shadow',
        enableAiSecurity: explicitAiSecurity && providerFromFlags.length > 0,
        autoAnnotate: !!opts.autoAnnotate,
        llmProviders: explicitAiSecurity ? providerFromFlags : [],
        infra: opts.distributed ? 'distributed' : 'skip',
        injectDep: true,
        startDocker: opts.docker !== false,
      };

      // Each prompt's message is prefixed with "\n" so that there is one blank
      // line above every question. inquirer's rawlist also leaves a blank line
      // after the answer naturally, giving a consistent breathing-room layout
      // (asked for explicitly by the operator).
      if (opts.simulate) {
        console.log(chalk.cyan('\n  i --simulate selected. Contexa will prepare simulation infrastructure automatically.'));
        console.log(chalk.gray('    Distributed simulation infrastructure includes PostgreSQL, Redis, Kafka, and Ollama.\n'));
      }

      const answers = opts.yes ? defaults : await inquirer.prompt([
        {
          type: 'rawlist', name: 'setupMode',
          message: '\n' + t('prompt.setupMode'),
          default: 1,
          choices: [
            { name: t('prompt.setupMode.quick'),    value: 'quick' },
            { name: t('prompt.setupMode.advanced'), value: 'advanced' },
          ],
          when: !opts.simulate && !opts.quick,
        },
        {
          type: 'rawlist', name: 'enableAiSecurity',
          message: '\n' + t('prompt.enableAiSecurity'),
          default: 1,
          choices: [
            { name: t('prompt.enableAiSecurity.yes'), value: true },
            { name: t('prompt.enableAiSecurity.no'), value: false },
          ],
          when: a => !opts.simulate && !opts.enableAiSecurity && !opts.provider && !opts.autoAnnotate,
        },
        {
          type: 'rawlist', name: 'providerQuick',
          message: '\n' + t('prompt.provider'),
          default: 1,
          choices: [
            { name: t('prompt.provider.openai'), value: 'openai' },
            { name: t('prompt.provider.anthropic'), value: 'anthropic' },
            { name: t('prompt.provider.ollama'), value: 'ollama' },
            { name: t('prompt.provider.none'), value: 'none' },
          ],
          when: a => (a.setupMode !== 'advanced') && (opts.enableAiSecurity || opts.autoAnnotate || a.enableAiSecurity === true) && !opts.provider,
        },
        {
          type: 'rawlist', name: 'autoAnnotate',
          message: '\n' + t('prompt.autoAnnotate'),
          default: 1,
          choices: [
            { name: t('prompt.autoAnnotate.no'), value: false },
            { name: t('prompt.autoAnnotate.yes'), value: true },
          ],
          when: a => (opts.enableAiSecurity || opts.provider || a.enableAiSecurity === true) && !opts.autoAnnotate,
        },
        {
          type: 'rawlist', name: 'integrationMode',
          message: '\n' + t('prompt.integrationMode'),
          // Merge is the default because most projects want a one-line install
          // and treat the contexa.* keys as part of their config. Standalone
          // is for projects that must keep the customer files byte-identical
          // (e.g. heavily reviewed monorepos, vendored builds).
          default: 1,
          choices: [
            { name: t('prompt.integrationMode.merge'),      value: 'merge' },
            { name: t('prompt.integrationMode.standalone'), value: 'standalone' },
          ],
          when: (a) => a.setupMode === 'advanced' && explicitIntegrationMode === null,
        },
        {
          type: 'input', name: 'standaloneDir',
          message: '\n' + t('prompt.standaloneDir'),
          default: path.join(opts.dir, 'contexa'),
          when: a => {
            if (a.setupMode !== 'advanced') return false;
            const mode = explicitIntegrationMode || a.integrationMode;
            return mode === 'standalone' && !opts.standaloneDir;
          },
        },
        {
          type: 'rawlist', name: 'securityMode',
          message: '\n' + t('prompt.securityMode'),
          default: 1,
          choices: [
            { name: t('prompt.securityMode.full'), value: 'full' },
            { name: t('prompt.securityMode.sandbox'), value: 'sandbox' },
          ],
          when: a => a.setupMode === 'advanced' && (opts.enableAiSecurity || opts.provider || a.enableAiSecurity === true),
        },
        {
          type: 'rawlist', name: 'mode',
          message: '\n' + t('prompt.mode'),
          default: 1,
          choices: [
            { name: t('prompt.mode.shadow'), value: 'shadow' },
            { name: t('prompt.mode.enforce'), value: 'enforce' },
          ],
          when: a => a.setupMode === 'advanced' && (opts.enableAiSecurity || opts.provider || a.enableAiSecurity === true),
        },
        {
          // checkbox stays as-is because rawlist does not support multiple
          // selection. Hint text in the bundle already explains space/enter.
          type: 'checkbox', name: 'llmProviders',
          message: '\n' + t('prompt.llm'),
          choices: [
            { name: t('prompt.llm.openai'),    value: 'openai',    checked: true },
            { name: t('prompt.llm.anthropic'), value: 'anthropic', checked: true },
            { name: t('prompt.llm.ollama'),    value: 'ollama',    checked: !!opts.includeOllama },
          ],
          validate: a => a.length > 0 ? true : t('prompt.llm.atLeastOne'),
          when: a => a.setupMode === 'advanced' && (opts.enableAiSecurity || opts.provider || opts.autoAnnotate || a.enableAiSecurity === true),
        },
        {
          type: 'rawlist', name: 'infra',
          message: '\n' + t('prompt.infra'),
          // Default = skip: never touch infrastructure unless the user opts in.
          // Distributed is the only auto-provisioning option (Postgres + Redis +
          // Zookeeper + Kafka). Customers running their own stack should accept
          // the default.
          default: opts.distributed ? 2 : 1,
          choices: [
            { name: t('prompt.infra.skip'),       value: 'skip' },
            { name: t('prompt.infra.distributed') || 'Yes - install distributed (Postgres + Redis + Kafka)', value: 'distributed' },
          ],
          when: (a) => a.setupMode === 'advanced' && !opts.distributed,
        },
        {
          type: 'input', name: 'infraDir',
          message: '\n' + t('prompt.infraDir'),
          default: () => resolveInfraDir(cliProjectName, {}),
          when: a => {
            if (a.setupMode !== 'advanced') return false;
            const infra = opts.distributed ? 'distributed' : a.infra;
            return infra !== 'skip' && !opts.infraDir;
          },
        },
        {
          type: 'confirm', name: 'startDocker',
          message: '\n' + t('prompt.startDocker'),
          default: true,
          when: a => {
            if (a.setupMode !== 'advanced') return false;
            const infra = opts.distributed ? 'distributed' : a.infra;
            return infra !== 'skip' && project.hasDocker && opts.docker !== false;
          },
        },
      ]);

            // Resolve final setup configuration based on chosen track.
      const promptProvider = answers.providerQuick || null;
      const requestedAiSecurity = !!(
        opts.simulate ||
        opts.enableAiSecurity ||
        opts.autoAnnotate ||
        opts.provider ||
        opts.includeOllama ||
        answers.enableAiSecurity === true
      );

      answers.integrationMode = explicitIntegrationMode || answers.integrationMode || 'merge';
      answers.securityMode = answers.securityMode || 'full';
      answers.mode = answers.mode || 'shadow';
      answers.infra = opts.distributed ? 'distributed' : (answers.infra || 'skip');
      answers.startDocker = opts.docker !== false && answers.startDocker !== false;

      if (promptProvider) {
        answers.llmProviders = normalizeProviders(promptProvider, false);
      } else if (opts.provider || opts.includeOllama || opts.enableAiSecurity || opts.autoAnnotate || opts.simulate) {
        answers.llmProviders = providerFromFlags;
      } else if (Array.isArray(answers.llmProviders)) {
        answers.llmProviders = answers.llmProviders;
      } else {
        answers.llmProviders = [];
      }

      answers.autoAnnotate = !!(opts.autoAnnotate || answers.autoAnnotate === true);
      if (answers.autoAnnotate && !aiProviderSelected(answers)) {
        console.error(chalk.red('  x --auto-annotate requires an explicit AI provider. Re-run with --provider openai, anthropic, or ollama.'));
        process.exit(1);
      }
      answers.enableAiSecurity = !!(requestedAiSecurity && aiProviderSelected(answers));

      answers.simulate = !!opts.simulate;
      answers.hasEnableAiSecurity = !!project.hasEnableAiSecurity;
      answers.injectDep = true;
      if (opts.distributed) answers.infra = 'distributed';
      if (opts.docker === false) answers.startDocker = false;

      // Resolve standalone dir
      const standaloneDir = answers.integrationMode === 'standalone'
        ? (normalizePath(opts.standaloneDir, opts.dir)
            || normalizePath(answers.standaloneDir, opts.dir)
            || path.resolve(opts.dir, 'contexa'))
        : null;

      // Resolve infra dir
      const infraDirOverride = normalizePath(opts.infraDir, opts.dir)
        || normalizePath(answers.infraDir, opts.dir)
        || null;

      await recordInstallMetadata(opts.dir, {
        projectName: cliProjectName,
        integrationMode: answers.integrationMode,
        infra: answers.infra,
        infraDir: answers.infra !== 'skip' ? resolveInfraDir(cliProjectName, { infraDir: infraDirOverride }) : null,
        simInfraDir: opts.simulate ? resolveInfraDir('ctxa-sim', { infraDir: infraDirOverride }) : null,
        aiSecurityEnabled: !!answers.enableAiSecurity,
      });

      if (answers.enableAiSecurity || answers.simulate) {
        // Provision GeoLite2-City.mmdb only when AI security or simulation is explicitly selected.
        const startGeo = process.hrtime.bigint();
        const sGeo = ora('Provisioning GeoLite2-City.mmdb...').start();
        try {
          const targetDataDir = path.join(opts.dir, 'contexa', 'data');
          const targetMmdbPath = path.join(targetDataDir, 'GeoLite2-City.mmdb');
          await fs.ensureDir(targetDataDir);

          if (!(await fs.pathExists(targetMmdbPath))) {
            const localSource = process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
            if (localSource && await fs.pathExists(localSource)) {
              await fs.copy(localSource, targetMmdbPath);
              await recordChange(opts.dir, targetMmdbPath, { kind: 'geoip-data', generated: true, reason: 'GeoIP context for explicit AI security setup' });
              sGeo.succeed(`GeoLite2-City.mmdb copied from local cache (${(Number(process.hrtime.bigint() - startGeo) / 1e6).toFixed(0)}ms)`);
            } else {
              const downloadUrl = 'https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb';
              await downloadFile(downloadUrl, targetMmdbPath);
              await recordChange(opts.dir, targetMmdbPath, { kind: 'geoip-data', generated: true, reason: 'GeoIP context for explicit AI security setup' });
              sGeo.succeed(`GeoLite2-City.mmdb downloaded successfully (${(Number(process.hrtime.bigint() - startGeo) / 1e6).toFixed(0)}ms)`);
            }
          } else {
            sGeo.succeed('GeoLite2-City.mmdb already present in data directory');
          }
        } catch (err) {
          sGeo.warn(`Failed to provision GeoLite2-City.mmdb: ${err.message}`);
        }
      }

      console.log('');

      // 3 + 4. Apply contexa configuration to the customer project.
      //
      // Two integration modes:
      //   merge      - mutate the customer's application.yml and build file
      //                in-place (single transaction with .bak rollback).
      //   standalone - write contexa-only artifacts to a separate folder; the
      //                customer's project files are NEVER touched.
      let standaloneResult = null;
      let aiAnnotationApplied = !!project.hasEnableAiSecurity;
      let aiDependenciesProcessed = false;
      if (answers.integrationMode === 'standalone') {
        console.log(chalk.cyan('\n  ' + t('standalone.intro')));
        console.log(chalk.gray(`  ${t('standalone.location')} ${standaloneDir}`));
        printPlannedChanges(answers, project, { standaloneDir });
        const startStandalone = process.hrtime.bigint();
        const sStandalone = ora(t('step.writingStandalone')).start();
        try {
          // Pass --force so injectStandalone will overwrite an existing
          // non-empty folder. Without --force, a non-empty folder that does
          // not look like a previous contexa-cli output is rejected up-front.
          standaloneResult = await injectStandalone(standaloneDir, project, {
            ...answers, force: !!opts.force,
          });
          await recordChange(opts.dir, standaloneDir, { kind: 'standalone-output', generated: true, reason: 'Contexa standalone configuration output' });
          const elapsed = Number(process.hrtime.bigint() - startStandalone) / 1e6;
          sStandalone.succeed(`${t('step.standaloneWritten')} (${elapsed.toFixed(0)}ms)`);
        } catch (err) {
          sStandalone.fail(t('step.standaloneWritten'));
          console.log('');
          console.log(chalk.red('  x Standalone artifacts could not be written.'));
          console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
          console.log('');
          process.exit(1);
        }
      } else {
        // Merge mode: yml + build mutation as a SINGLE transaction. If any step
        // inside fails, every change in this block is rolled back from its .bak
        // so the customer never ends up with a half-applied install (e.g. yml
        // mutated but build dep missing).
        const ymlPath = project.appYmlPath || path.join(opts.dir, 'src/main/resources/application.yml');
        const buildPath = project.buildFilePath
          || (project.buildTool === 'maven'
            ? path.join(opts.dir, 'pom.xml')
            : path.join(opts.dir, 'build.gradle'));
        let ymlChanged = false;
        let buildChanged = false;
        const ymlExistedBefore = await fs.pathExists(ymlPath);
        printPlannedChanges(answers, project, { ymlPath, buildPath });

        // 3. Inject application.yml
        const startYml = process.hrtime.bigint();
        const s1 = ora(t('step.updatingYml')).start();
        try {
          await injectYml(ymlPath, answers);
          ymlChanged = true;
          await recordChange(opts.dir, ymlPath, { kind: 'application-yml', generated: !ymlExistedBefore, reason: answers.enableAiSecurity ? 'Contexa AI security configuration' : 'Contexa starter configuration' });
          const elapsed = Number(process.hrtime.bigint() - startYml) / 1e6;
          s1.succeed(`${t('step.ymlUpdated')} (${elapsed.toFixed(0)}ms)`);
        } catch (err) {
          s1.fail(t('step.ymlUpdated'));
          console.log('');
          console.log(chalk.red('  x application.yml could not be updated.'));
          console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
          console.log('');
          process.exit(1);
        }


        // application.properties + application.yml coexistence is a load-order
        // hazard in Spring Boot. Surface a single-line resolution hint here so
        // the user does not have to dig through docs.
        if (project.appPropertiesPath && project.appYmlPath) {
          console.log(chalk.yellow('  ! Both application.properties and application.yml exist.'));
          console.log(chalk.gray('    Spring Boot will load one and silently shadow the other.'));
          console.log(chalk.gray('    Recommended: keep one source of truth (yml). Move properties content into yml.'));
        }

        // 4. Inject dependency (rolls back yml on failure)
        if (answers.injectDep) {
          try {
            // 3.5. Inject @EnableAISecurity only when the user explicitly allowed source annotation.
            if (answers.enableAiSecurity && answers.autoAnnotate) {
              try {
                const sAnnot = ora('Injecting @EnableAISecurity into main class...').start();
                const injected = await injectEnableAiSecurity(opts.dir);
                if (injected && injected.changed) {
                  sAnnot.succeed('@EnableAISecurity injected into main class');
                  await recordChange(opts.dir, injected.filePath, { kind: 'java-annotation', generated: false, reason: 'Explicit --auto-annotate AI security activation' });
                  project.hasEnableAiSecurity = true;
                  aiAnnotationApplied = true;
                } else {
                  aiAnnotationApplied = aiAnnotationApplied || !!project.hasEnableAiSecurity || !!(injected && injected.filePath);
                  sAnnot.info('@EnableAISecurity already present or main class not found');
                }
              } catch (err) {
                console.log(chalk.yellow(`  ! Could not automatically inject @EnableAISecurity: ${err.message}`));
              }
            }

            const startDep = process.hrtime.bigint();
            const s2 = ora(t('step.addingDep')).start();
            const ok = project.buildTool === 'maven'
              ? await injectMavenDep(buildPath)
              : await injectGradleDep(buildPath);
            if (ok) {
              buildChanged = true;
              await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Contexa starter dependency' });
            }
            const elapsed = Number(process.hrtime.bigint() - startDep) / 1e6;
            ok ? s2.succeed(`${t('step.depAdded')} (${elapsed.toFixed(0)}ms)`) : s2.info(t('step.depAlreadyPresent'));

            // Spring AI provider starters and vector-store are added only for explicit AI security setup.
            if (answers.enableAiSecurity && aiProviderSelected(answers)) {
              const startAiDep = process.hrtime.bigint();
              const sAi = ora('Adding Spring AI and Vector Store dependencies...').start();
              const addedAi = await injectSpringAiDeps(buildPath, answers.llmProviders);
              if (addedAi) {
                buildChanged = true;
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit AI provider dependencies' });
              }
              aiDependenciesProcessed = true;
              const elapsedAi = Number(process.hrtime.bigint() - startAiDep) / 1e6;
              addedAi ? sAi.succeed(`Spring AI dependencies added (${elapsedAi.toFixed(0)}ms)`) : sAi.info('Spring AI dependencies already present');
            }

            if (answers.infra === 'distributed') {
              const startDistDep = process.hrtime.bigint();
              const s2b = ora(t('step.addingDistributedDeps')).start();
              const added = await injectDistributedDeps(buildPath);
              if (added) {
                buildChanged = true;
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit distributed infrastructure dependencies' });
              }
              const elapsedDist = Number(process.hrtime.bigint() - startDistDep) / 1e6;
              added ? s2b.succeed(`${t('step.distributedDepsAdded')} (${elapsedDist.toFixed(0)}ms)`) : s2b.info(t('step.distributedDepsPresent'));
            }
          } catch (err) {
            console.log('');
            console.log(chalk.red('  x Build dependency injection failed.'));
            console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
            console.log('');
            await rollbackOnFailure(ymlPath, ymlChanged, buildPath, buildChanged, opts.dir);
            process.exit(1);
          }
        }
      }

      // 5. Generate docker-compose.yml
      //
      // Infrastructure files (docker-compose.yml) are written to a
      // contexa-owned directory, NEVER the customer project directory. The
      // customer project's existing docker-compose.yml (if any) is therefore
      // never touched. Default location is OS-specific contexa home; users
      // can override via --infra-dir.
      let infraDir = null;
      if (answers.infra !== 'skip') {
        const includesOllama = !!(answers.llmProviders && answers.llmProviders.includes('ollama'));
        if (answers.infra === 'distributed') {
          console.log(chalk.cyan('\n  Distributed infrastructure: PostgreSQL + Redis + Zookeeper + Kafka'
            + (includesOllama ? ' + Ollama' : '')));
        } else {
          console.log(chalk.cyan('\n  Standalone infrastructure: PostgreSQL'
            + (includesOllama ? ' + Ollama' : '')));
        }

        infraDir = resolveInfraDir(cliProjectName, { infraDir: infraDirOverride });
        console.log(chalk.gray(`  Infrastructure files location: ${infraDir}`));
        console.log(chalk.gray('  Database schema and seed data will be installed by contexa-iam when the application starts.'));

        const startCompose = process.hrtime.bigint();
        const s3 = ora(t('step.generatingCompose')).start();
        await generateDockerCompose(infraDir, {
          ...answers,
          projectName: cliProjectName,
          includeOllama: !!(answers.llmProviders && answers.llmProviders.includes('ollama')),
        });
        const elapsedCompose = Number(process.hrtime.bigint() - startCompose) / 1e6;
        s3.succeed((answers.infra === 'distributed'
          ? t('step.composeGenerated.distributed')
          : t('step.composeGenerated')) + ` (${elapsedCompose.toFixed(0)}ms)`);

        // 5b. Pre-flight checks before docker compose up. We do this even when
        // --no-docker is set so the user knows what conflicts to expect when
        // they run compose manually later.
        const sPre = ora('Running infrastructure pre-flight checks').start();
        const issues = await inspectInfra({
          infra: answers.infra,
          startDocker: answers.startDocker,
          includeOllama: !!(answers.llmProviders && answers.llmProviders.includes('ollama')),
        });
        sPre.stop();
        const errs  = issues.filter(i => i.severity === 'error');
        const warns = issues.filter(i => i.severity === 'warning');
        const infos = issues.filter(i => i.severity === 'info');
        for (const i of errs) {
          console.log(chalk.red(`  x ${i.message}`));
          for (const h of (i.hint || [])) console.log(chalk.gray(`    - ${h}`));
        }
        for (const i of warns) {
          console.log(chalk.yellow(`  ! ${i.message}`));
          for (const h of (i.hint || [])) console.log(chalk.gray(`    - ${h}`));
        }
        for (const i of infos) {
          console.log(chalk.gray(`  i ${i.message}`));
          for (const h of (i.hint || [])) console.log(chalk.gray(`    - ${h}`));
        }
        if (errs.length > 0) {
          console.log(chalk.red('\n  Infrastructure cannot start. Resolve the errors above and re-run "contexa init".'));
          console.log('');
          process.exit(1);
        }

        const servicesToUp = issues.servicesToUp || [];
        const skippedServices = issues.skippedServices || [];

        // 6. Start Docker
        // cwd is the contexa-owned infraDir so the docker-compose.yml that we
        // just generated is the one compose picks up - never the customer's.
        if (skippedServices.length > 0) {
          console.log(chalk.green(`  v Existing/conflicting services skipped: ${skippedServices.join(', ')}`));
        }

        if (answers.startDocker && project.hasDocker) {
          if (servicesToUp.length === 0) {
            console.log(chalk.green('  v All services are already running or skipped; "docker compose up -d" bypassed.'));
          } else {
            const s4 = ora(`${t('step.startingDocker')} (${servicesToUp.join(', ')})`).start();
            try {
              const upResult = dockerCompose(['up', '-d', ...servicesToUp], { cwd: infraDir, stdio: 'inherit' });
              if (upResult.error) throw upResult.error;
              if (upResult.status !== 0) throw new Error(`docker compose up exited with status ${upResult.status}`);
              s4.succeed(t('step.dockerStarted'));

            // 7. Pull Ollama models (only if Ollama was explicitly included)
            // Container name is project-aware (production: contexa-ollama,
            // simulate: ctxa-sim-ollama, custom CONTEXA_PROJECT: <name>-ollama).
            if (answers.llmProviders && answers.llmProviders.includes('ollama')) {
              const ollamaContainer = containerName('ollama');
              const chatModel = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b';
              const embedModel = process.env.OLLAMA_EMBEDDING_MODEL || 'mxbai-embed-large';
              if (!isValidOllamaModel(chatModel)) throw new Error(`Invalid OLLAMA_CHAT_MODEL value: ${chatModel}`);
              if (!isValidOllamaModel(embedModel)) throw new Error(`Invalid OLLAMA_EMBEDDING_MODEL value: ${embedModel}`);
              // Pull selected Ollama models when local Ollama is enabled.
              const ollamaPort = process.env.CONTEXA_OLLAMA_PORT ? parseInt(process.env.CONTEXA_OLLAMA_PORT, 10) : 11434;
                const s5 = ora(t('step.pullingChat', chatModel)).start();
                try {
                  let ready = false;
                  const deadlineMs = Date.now() + 90000; // 90s absolute cap
                  while (!ready && Date.now() < deadlineMs) {
                    const probe = dockerTry(
                      ['exec', ollamaContainer, 'ollama', 'list'],
                      { stdio: 'ignore', timeout: 3000 }
                    );
                    if (!probe.error && probe.status === 0) { ready = true; break; }
                    await sleep(2000);
                  }

                  if (ready) {
                    await pullOllamaModelWithProgress(ollamaPort, chatModel, s5, t('step.pullingChat', chatModel).replace('...', ''));
                    s5.succeed(t('step.chatPulled', chatModel));

                    const s6 = ora(t('step.pullingEmbedding', embedModel)).start();
                    await pullOllamaModelWithProgress(ollamaPort, embedModel, s6, t('step.pullingEmbedding', embedModel).replace('...', ''));
                    s6.succeed(t('step.embeddingPulled'));
                  } else {
                    s5.warn(t('step.ollamaNotReady', chatModel));
                    console.log(chalk.gray(`    To retry manually: docker exec ${ollamaContainer} ollama pull ${chatModel}`));
                  }
                } catch (e) {
                  s5.warn(t('step.modelPullFailed', chatModel));
                  console.log(chalk.gray(`    To retry manually: docker exec ${ollamaContainer} ollama pull ${chatModel}`));
                }
              }
            } catch (e) {
              s4.fail(t('step.dockerFailed'));
            }
        }
      }
    }

      // 8. Done - show visual Guide Board for FTX optimization
      // 8. Done - show visual guide
      console.log(chalk.cyan('\n  ============================================================'));
      console.log(chalk.cyan(`     Contexa ${t('init.done')}`));
      console.log(chalk.cyan('  ============================================================\n'));

      console.log(chalk.green('  [Automated Tasks]:'));
      if (answers.integrationMode === 'standalone') {
        console.log(chalk.gray(`    v Standalone folder created: ${standaloneDir}`));
      } else {
        console.log(chalk.gray('    v Contexa configuration merged into application.yml'));
        console.log(chalk.gray('    v spring-boot-starter-contexa dependency added to build file'));
      }

      if (answers.infra !== 'skip') {
        console.log(chalk.gray('    v Infrastructure files created and Docker stack processed'));
      }

      if (standaloneResult) {
        console.log(chalk.yellow('\n  [Standalone Wiring Instructions]:'));
        console.log(chalk.gray(`    ${t('standalone.imports.yml')}`));
        console.log(chalk.cyan('       spring:'));
        console.log(chalk.cyan('         config:'));
        console.log(chalk.cyan('           import: "optional:file:./contexa/application.yml"'));

        if (standaloneResult.importHints.isMaven) {
          console.log(chalk.gray(`\n    ${t('standalone.imports.maven')}`));
          console.log(chalk.cyan(`       ${standaloneResult.buildFragmentPath}`));
          console.log(chalk.gray(`      ${t('standalone.imports.mavenNote')}`));
        } else {
          console.log(chalk.gray(`\n    ${t('standalone.imports.gradleGroovy')}`));
          console.log(chalk.cyan("       apply from: 'contexa/contexa.gradle'"));
        }
      }

      console.log(chalk.yellow('\n  [Next checks]:'));
      let manualStep = 1;
      if (answers.enableAiSecurity && !aiAnnotationApplied) {
        console.log(chalk.white(`    ${manualStep++}. Add @EnableAISecurity to your main Application class:`));
        console.log(chalk.cyan('       ----------------------------------------------------'));
        if (answers.securityMode === 'sandbox') {
          console.log(chalk.cyan('       @EnableAISecurity('));
          console.log(chalk.cyan('           mode = SecurityMode.SANDBOX,'));
          console.log(chalk.cyan('           authBridge = SessionAuthBridge.class'));
          console.log(chalk.cyan('       )'));
        } else {
          console.log(chalk.cyan('       @EnableAISecurity'));
        }
        console.log(chalk.cyan('       @SpringBootApplication'));
        console.log(chalk.cyan('       public class YourApplication { }'));
        console.log(chalk.cyan('       ----------------------------------------------------'));
      }

      if (answers.enableAiSecurity) {
        console.log(chalk.white(`    ${manualStep++}. Verify selected AI provider settings:`));
        console.log(chalk.gray(`       - Providers: ${answers.llmProviders.join(', ')}`));
        console.log(chalk.gray('       - Keep API keys and model values in environment variables or application config.'));
        if (aiDependenciesProcessed) {
          console.log(chalk.gray('       - Explicit AI provider dependencies were processed.'));
        }
      } else {
        console.log(chalk.white(`    ${manualStep++}. AI security is not enabled yet:`));
        console.log(chalk.gray('       Re-run contexa init and choose AI security when you are ready.'));
      }

      console.log(chalk.white(`    ${manualStep++}. Run the server and diagnose your environment:`));
      console.log(chalk.gray(`       - Start server : ${project.buildTool === 'maven' ? './mvnw spring-boot:run' : './gradlew bootRun'}`));
      const doctorProvider = aiProviderSelected(answers) ? ` --provider ${answers.llmProviders.join(',')}` : '';
      console.log(chalk.gray(`       - Diagnose     : contexa doctor${doctorProvider}`));

      if (answers.enableAiSecurity && answers.mode === 'shadow') {
        console.log(chalk.yellow('\n  * SHADOW mode is active: analysis/logging only, no blocking.'));
        console.log(chalk.gray('    Switch to enforce mode only after operational validation.'));
      }

      console.log(chalk.red.bold('\n  [Security Checklist before external deployment]:'));
      console.log(chalk.red(`    - ${t('warn.security.envVars')}`));
      console.log(chalk.red(`    - ${t('warn.security.gitignore')}`));
      console.log(chalk.red(`    - ${t('warn.security.demoUsers')}`));

      console.log(chalk.cyan('\n  ============================================================\n'));

    });
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pullOllamaModelWithProgress(port, modelName, spinnerInstance, stepTextTemplate) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ name: modelName });
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/pull',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Ollama returned status ${res.statusCode}`));
        return;
      }

      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.error) {
              reject(new Error(json.error));
              return;
            }
            
            let statusText = json.status || 'pulling';
            if (json.total && json.completed) {
              const percent = Math.floor((json.completed / json.total) * 100);
              spinnerInstance.text = `${stepTextTemplate} [${percent}%]`;
            } else {
              spinnerInstance.text = `${stepTextTemplate} (${statusText})`;
            }
          } catch (e) {
            // Ignore parse errors from partial chunks
          }
        }
      });

      res.on('end', () => {
        resolve();
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}
              // Pull selected Ollama models when local Ollama is enabled.
// are alphanumerics with limited punctuation (`-`, `_`, `.`, `/`). Values come
// from OLLAMA_CHAT_MODEL / OLLAMA_EMBEDDING_MODEL env vars and end up as a
// docker exec argv entry. We pass via spawnSync (no shell) but still reject
// obviously malformed input so the failure mode is a clean CLI error.
function isValidOllamaModel(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[A-Za-z0-9._:/\-]+$/.test(s);
}

// Restore application.yml and the build file from their .bak siblings when a
// later step in the (yml + build) transaction fails. The .bak files are left
// in place after restore so the operator can still inspect what we attempted.
async function rollbackOnFailure(ymlPath, ymlChanged, buildPath, buildChanged, projectDir) {
  const restored = [];
  if (buildChanged) {
    const bak1 = buildPath + '.bak';
    const bak2 = projectDir ? path.join(projectDir, 'contexa', 'bak', path.relative(projectDir, buildPath)) : null;
    const bak = (await fs.pathExists(bak1)) ? bak1 : (bak2 && (await fs.pathExists(bak2)) ? bak2 : null);
    if (bak) {
      try {
        await fs.copy(bak, buildPath, { overwrite: true });
        restored.push(path.basename(buildPath));
      } catch (e) {
        console.log(chalk.red(`    Failed to restore ${path.basename(buildPath)}: ${e.message}`));
      }
    }
  }
  if (ymlChanged) {
    const bak1 = ymlPath + '.bak';
    const bak2 = projectDir ? path.join(projectDir, 'contexa', 'bak', path.relative(projectDir, ymlPath)) : null;
    const bak = (await fs.pathExists(bak1)) ? bak1 : (bak2 && (await fs.pathExists(bak2)) ? bak2 : null);
    if (bak) {
      try {
        await fs.copy(bak, ymlPath, { overwrite: true });
        restored.push(path.basename(ymlPath));
      } catch (e) {
        console.log(chalk.red(`    Failed to restore ${path.basename(ymlPath)}: ${e.message}`));
      }
    }
  }
  // Clean up backups dir if empty or after restore
  if (projectDir) {
    try {
      const backupsDir = path.join(projectDir, 'contexa', 'bak');
      if (await fs.pathExists(backupsDir)) {
        await fs.remove(backupsDir);
        const parentContexa = path.join(projectDir, 'contexa');
        if (await fs.pathExists(parentContexa) && (await fs.readdir(parentContexa)).length === 0) {
          await fs.remove(parentContexa);
        }
      }
    } catch (e) {
      // Ignore
    }
  }
  if (restored.length > 0) {
    console.log(chalk.yellow('  ! Rolled back: ' + restored.join(', ')));
    console.log(chalk.gray('    Your project files have been restored to their pre-init state.'));
    console.log('');
  } else {
    console.log(chalk.yellow('  ! No automatic rollback was performed (no .bak files found or no changes made).'));
    console.log('');
  }
}
