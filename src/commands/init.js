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
        generateDockerCompose, generateInitDbScripts } = require('../core/injector');
const { inspectInfra } = require('../core/preflight');
const { resolveProjectName, containerName, resolveInfraDir } = require('../core/project');
const { t, setLocale, getLocale } = require('../core/i18n');

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
    // --no-docker (only meaningful with --distributed) generates compose/initdb
    // files but does not run "docker compose up -d".
    //
    // --include-ollama opts in to the local Ollama LLM runtime. Default behavior
    // routes chat/embedding to OpenAI + Anthropic (cloud). Use --include-ollama
    // for offline operation, no-API-key demos, or regulated environments that
    // cannot call external LLMs.
    .option('--distributed', 'Install distributed infrastructure (Postgres + Redis + Kafka) for PoC/enterprise demo')
    .option('--include-ollama', 'Include the local Ollama LLM runtime (off by default; required for offline / no-API-key operation)')
    .option('--no-docker', 'With --distributed: generate compose/initdb files but do not start containers')
    .option('--simulate', 'Install isolated simulation stack (ctxa-sim-* containers on +20000 ports) so you can practice the manual install flow without colliding with production. Implies --distributed.')
    // The two integration modes. By default the prompt asks the user; these
    // flags exist for prompt-bypass automation.
    .option('--merge', 'Merge mode: write contexa.* into the customer build/yml (default)')
    .option('--standalone', 'Standalone mode: place contexa-only build/yml under a separate directory; never touch customer originals')
    .option('--standalone-dir <path>', 'Standalone mode output directory (default: <projectDir>/contexa)')
    // Infrastructure files (docker-compose.yml + initdb/) are ALWAYS written
    // outside the customer project directory. Default: contexa-owned home
    // (Linux/macOS: $XDG_CONFIG_HOME/contexa/<projectName> or $HOME/.contexa/<name>;
    // Windows: %LOCALAPPDATA%\Contexa\<projectName>). Override with --infra-dir.
    .option('--infra-dir <path>', 'Override the contexa-owned directory used for docker-compose.yml + initdb/')
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

        // Check Docker
        const hasDockerCli = isDockerCliInstalled();
        const hasDockerDaemon = isDockerDaemonRunning();
        if (!hasDockerCli) {
          checkPass = false;
          console.log(chalk.red(`  x Docker CLI is not installed.`));
          console.log(chalk.gray(`    -> FIX: Install Docker Desktop: https://www.docker.com/products/docker-desktop \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
        } else if (!hasDockerDaemon) {
          checkPass = false;
          console.log(chalk.red(`  x Docker daemon is not running.`));
          console.log(chalk.gray(`    -> FIX: Open Docker Desktop or run 'sudo systemctl start docker'. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`));
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

      // Docker is only consulted when the user explicitly opted into infra
      // provisioning via --distributed. Without --distributed, init does not
      // touch infrastructure regardless of whether Docker is installed.
      const wantsContainers = opts.distributed && opts.docker !== false;
      if (!project.hasDocker && wantsContainers) {
        console.log('');
        console.log(chalk.yellow('  ! Docker is required to start the distributed infrastructure.'));
        console.log(chalk.gray('    This run will still write compose/initdb files so you can start them later.'));
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

      const defaults = {
        integrationMode: explicitIntegrationMode || 'merge',
        securityMode: 'full', mode: 'shadow',
        llmProviders: opts.includeOllama ? ['openai', 'anthropic', 'ollama'] : ['openai', 'anthropic'],
        infra: opts.distributed ? 'distributed' : 'skip',
        injectDep: true,
        startDocker: opts.docker !== false,
      };

      // Each prompt's message is prefixed with "\n" so that there is one blank
      // line above every question. inquirer's rawlist also leaves a blank line
      // after the answer naturally, giving a consistent breathing-room layout
      // (asked for explicitly by the operator).
      if (opts.simulate) {
        console.log(chalk.cyan('\n  i --simulate 플래그가 감지되었습니다. 인프라 설정이 자동으로 결정됩니다.'));
        console.log(chalk.gray('    분산 인프라 (PostgreSQL + Redis + Kafka + Ollama) 를 설치합니다.\n'));
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
          when: !opts.simulate,
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
          when: a => a.setupMode === 'advanced',
        },
        {
          type: 'rawlist', name: 'mode',
          message: '\n' + t('prompt.mode'),
          default: 1,
          choices: [
            { name: t('prompt.mode.shadow'), value: 'shadow' },
            { name: t('prompt.mode.enforce'), value: 'enforce' },
          ],
          when: a => a.setupMode === 'advanced',
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
          when: a => a.setupMode === 'advanced',
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
          default: () => resolveInfraDir(resolveProjectName(), {}),
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
        // Quick Start 전용: Ollama 사용 여부 한 줄 질문
        // Advanced 모드는 기존 llmProviders checkbox 에서 Ollama를 직접 선택.
        // --simulate / --include-ollama 플래그가 이미 있으면 묻지 않는다.
        {
          type: 'rawlist', name: 'includeOllamaQuick',
          message: '\n' + t('prompt.ollama.quick'),
          default: 1,
          choices: [
            { name: t('prompt.ollama.quick.no'),  value: false },
            { name: t('prompt.ollama.quick.yes'), value: true  },
          ],
          when: a => a.setupMode === 'quick' && !opts.simulate && !opts.includeOllama,
        },
      ]);

      // Resolve final setup configuration based on chosen track
      if (answers.setupMode === 'quick' || opts.yes || opts.simulate) {
        answers.integrationMode = explicitIntegrationMode || 'merge';
        answers.securityMode = 'full';
        answers.mode = 'shadow';
        // Quick Start: --include-ollama 플래그 > 프롬프트 답변 > 기본값(없음) 순으로 결정
        const wantsOllama = opts.includeOllama || answers.includeOllamaQuick === true;
        answers.llmProviders = wantsOllama ? ['openai', 'anthropic', 'ollama'] : ['openai', 'anthropic'];
        answers.infra = opts.distributed ? 'distributed' : 'skip';
        answers.startDocker = opts.docker !== false;
      } else {
        answers.integrationMode = explicitIntegrationMode || answers.integrationMode || 'merge';
        answers.securityMode = answers.securityMode || 'full';
        answers.mode = answers.mode || 'shadow';
        answers.llmProviders = answers.llmProviders || (opts.includeOllama ? ['openai', 'anthropic', 'ollama'] : ['openai', 'anthropic']);
        answers.infra = opts.distributed ? 'distributed' : (answers.infra || 'skip');
        answers.startDocker = opts.docker !== false && answers.startDocker !== false;
      }

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

      // Provision GeoLite2-City.mmdb (common for all modes)
      const startGeo = process.hrtime.bigint();
      const sGeo = ora('Provisioning GeoLite2-City.mmdb...').start();
      try {
        const targetDataDir = path.join(opts.dir, 'contexa', 'data');
        const targetMmdbPath = path.join(targetDataDir, 'GeoLite2-City.mmdb');
        await fs.ensureDir(targetDataDir);

        if (!(await fs.pathExists(targetMmdbPath))) {
          // 1. Try to copy from local contexa directory if in dev/eval workspace
          const localSource = 'E:\\projects\\contexa\\data\\GeoLite2-City.mmdb';
          if (await fs.pathExists(localSource)) {
            await fs.copy(localSource, targetMmdbPath);
            sGeo.succeed(`GeoLite2-City.mmdb copied from local cache (${(Number(process.hrtime.bigint() - startGeo) / 1e6).toFixed(0)}ms)`);
          } else {
            // 2. Download from public fallback URL
            const downloadUrl = 'https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb';
            await downloadFile(downloadUrl, targetMmdbPath);
            sGeo.succeed(`GeoLite2-City.mmdb downloaded successfully (${(Number(process.hrtime.bigint() - startGeo) / 1e6).toFixed(0)}ms)`);
          }
        } else {
          sGeo.succeed('GeoLite2-City.mmdb already present in data directory');
        }
      } catch (err) {
        sGeo.warn(`Failed to provision GeoLite2-City.mmdb: ${err.message}`);
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
      if (answers.integrationMode === 'standalone') {
        console.log(chalk.cyan('\n  ' + t('standalone.intro')));
        console.log(chalk.gray(`  ${t('standalone.location')} ${standaloneDir}`));
        const startStandalone = process.hrtime.bigint();
        const sStandalone = ora(t('step.writingStandalone')).start();
        try {
          // Pass --force so injectStandalone will overwrite an existing
          // non-empty folder. Without --force, a non-empty folder that does
          // not look like a previous contexa-cli output is rejected up-front.
          standaloneResult = await injectStandalone(standaloneDir, project, {
            ...answers, force: !!opts.force,
          });
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

        // 3. Inject application.yml
        const startYml = process.hrtime.bigint();
        const s1 = ora(t('step.updatingYml')).start();
        try {
          await injectYml(ymlPath, answers);
          ymlChanged = true;
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
            // 3.5. Inject @EnableAISecurity into main class
            try {
              const sAnnot = ora('Injecting @EnableAISecurity into main class...').start();
              const injected = await injectEnableAiSecurity(opts.dir);
              if (injected) {
                sAnnot.succeed('@EnableAISecurity injected into main class');
                // Force project flag to true so that Spring AI dependencies get injected in this run
                project.hasEnableAiSecurity = true;
              } else {
                sAnnot.info('@EnableAISecurity already present or main class not found');
              }
            } catch (err) {
              console.log(chalk.yellow(`  ! Could not automatically inject @EnableAISecurity: ${err.message}`));
            }

            const startDep = process.hrtime.bigint();
            const s2 = ora(t('step.addingDep')).start();
            const ok = project.buildTool === 'maven'
              ? await injectMavenDep(buildPath)
              : await injectGradleDep(buildPath);
            if (ok) buildChanged = true;
            const elapsed = Number(process.hrtime.bigint() - startDep) / 1e6;
            ok ? s2.succeed(`${t('step.depAdded')} (${elapsed.toFixed(0)}ms)`) : s2.info(t('step.depAlreadyPresent'));

            // Spring AI provider starters and the pgvector vector-store starter
            // are automatically added only if @EnableAISecurity is present.
            if (project.hasEnableAiSecurity) {
              const startAiDep = process.hrtime.bigint();
              const sAi = ora('Adding Spring AI and Vector Store dependencies...').start();
              const addedAi = await injectSpringAiDeps(buildPath, answers.llmProviders);
              if (addedAi) buildChanged = true;
              const elapsedAi = Number(process.hrtime.bigint() - startAiDep) / 1e6;
              addedAi ? sAi.succeed(`Spring AI dependencies added (${elapsedAi.toFixed(0)}ms)`) : sAi.info('Spring AI dependencies already present');
            }

            if (answers.infra === 'distributed') {
              const startDistDep = process.hrtime.bigint();
              const s2b = ora(t('step.addingDistributedDeps')).start();
              const added = await injectDistributedDeps(buildPath);
              if (added) buildChanged = true;
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

      // 5. Generate database init scripts + docker-compose.yml
      //
      // Infrastructure files (docker-compose.yml + initdb/) are written to a
      // contexa-owned directory, NEVER the customer project directory. The
      // customer project's existing docker-compose.yml (if any) is therefore
      // never touched. Default location is OS-specific contexa home; users
      // can override via --infra-dir.
      let seedPassword = null;
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

        infraDir = resolveInfraDir(resolveProjectName(), { infraDir: infraDirOverride });
        console.log(chalk.gray(`  Infrastructure files location: ${infraDir}`));

        const startDb = process.hrtime.bigint();
        const s3a = ora(t('step.generatingDb')).start();
        const dbResult = await generateInitDbScripts(infraDir);
        seedPassword = dbResult.seedPassword;
        const elapsedDb = Number(process.hrtime.bigint() - startDb) / 1e6;
        s3a.succeed(`${t('step.dbGenerated')} (${elapsedDb.toFixed(0)}ms)`);

        const startCompose = process.hrtime.bigint();
        const s3 = ora(t('step.generatingCompose')).start();
        await generateDockerCompose(infraDir, {
          ...answers,
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

              // Ollama 모델 다운로드 자동 진행
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
      const isKo = getLocale() === 'ko';

      console.log(chalk.cyan('\n  ============================================================'));
      console.log(chalk.cyan(`     Contexa ${t('init.done')}`));
      console.log(chalk.cyan('  ============================================================\n'));

      console.log(chalk.green(`  [${isKo ? '자동 완료된 작업' : 'Automated Tasks'}]:`));
      if (answers.integrationMode === 'standalone') {
        console.log(chalk.gray(`    v ${isKo ? 'Standalone 폴더 생성 완료' : 'Standalone folder created'}: ${standaloneDir}`));
      } else {
        console.log(chalk.gray(`    v ${isKo ? 'application.yml 내 Contexa 보안 구성 적용 완료' : 'Contexa security config merged into application.yml'}`));
        console.log(chalk.gray(`    v ${isKo ? '빌드 파일 내 spring-boot-starter-contexa 의존성 추가 완료' : 'spring-boot-starter-contexa dependency added to build file'}`));
      }

      if (answers.infra !== 'skip') {
        console.log(chalk.gray(`    v ${isKo ? '인프라 파일 생성 및 컨테이너 가동 작업 완료' : 'Infrastructure files created and docker stack processed'}`));
      }

      // Show Standalone wire-up guide if applicable
      if (standaloneResult) {
        console.log(chalk.yellow(`\n  [${isKo ? 'Standalone 추가 설정 안내' : 'Standalone Wiring Instructions'}]:`));
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

      // Show seed password and gitignore instructions


      console.log(chalk.yellow(`\n  [${isKo ? '사용자 수동 필수 조치' : 'Manual Actions Required'}]:`));
      console.log(chalk.white(`    1. ${isKo ? '메인 애플리케이션 클래스 상단에 @EnableAISecurity 추가' : 'Add @EnableAISecurity to your main Application class'}:`));
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

      console.log(chalk.white(`    2. ${isKo ? 'Spring AI 의존성 확인 (Contexa가 자동으로 빌드 파일에 삽입 완료함)' : 'Spring AI dependencies verification (Contexa has automatically injected them)'}:`));
      const isMavenForHint = project.buildTool === 'maven';
      console.log(chalk.cyan('       ----------------------------------------------------'));
      if (isMavenForHint) {
        console.log(chalk.gray(`       ${isKo ? '(이미 pom.xml에 아래 의존성 및 spring-ai-bom이 추가되었습니다)' : '(The following dependencies and spring-ai-bom have already been added to pom.xml)'}`));
        console.log(chalk.cyan('       <dependency>'));
        console.log(chalk.cyan('         <groupId>org.springframework.ai</groupId>'));
        console.log(chalk.cyan('         <artifactId>spring-ai-starter-model-openai</artifactId>'));
        console.log(chalk.cyan('       </dependency>'));
        console.log(chalk.cyan('       <dependency>'));
        console.log(chalk.cyan('         <groupId>org.springframework.ai</groupId>'));
        console.log(chalk.cyan('         <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>'));
        console.log(chalk.cyan('       </dependency>'));
      } else {
        console.log(chalk.gray(`       ${isKo ? '(이미 build.gradle에 아래 의존성 및 platform(spring-ai-bom)이 추가되었습니다)' : '(The following dependencies and spring-ai-bom have already been added to build.gradle)'}`));
        console.log(chalk.cyan("       implementation 'org.springframework.ai:spring-ai-starter-model-openai'"));
        console.log(chalk.cyan("       implementation 'org.springframework.ai:spring-ai-starter-vector-store-pgvector'"));
      }
      console.log(chalk.cyan('       ----------------------------------------------------'));

      console.log(chalk.white(`    3. ${isKo ? '로컬 서버를 기동하고 환경 상태를 진단하세요' : 'Run the server and diagnose your environment'}:`));
      console.log(chalk.gray(`       - ${isKo ? '서버 기동' : 'Start Server'} : ${project.buildTool === 'maven' ? './mvnw spring-boot:run' : './gradlew bootRun'}`));
      console.log(chalk.gray(`       - ${isKo ? '환경 진단' : 'Diagnose'}     : contexa doctor  ` + chalk.cyan(`\u001b[FIX Guide] \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007[Troubleshooting Guide]\u001b]8;;\u0007`)));

      if (answers.mode === 'shadow') {
        console.log(chalk.yellow(`\n  * ${isKo ? '현재 SHADOW 모드로 설정되었습니다 (차단 없이 관찰만 수행).' : 'SHADOW mode is active (observe only, no blocking).'}`));
        console.log(chalk.gray(`    ${isKo ? '준비되면 다음 명령어로 실시간 차단을 활성화하세요:' : 'Switch to blocking mode when ready:'} contexa mode --enforce`));
      }

      console.log(chalk.red.bold(`\n  [${isKo ? '외부 배포 전 보안 체크리스트' : 'Security Checklist before external deployment'}]:`));
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

// Ollama model identifiers follow the pattern <name>[:tag] where name segments
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
