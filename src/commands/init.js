'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const inquirer = require('inquirer');
const path  = require('path');
const os    = require('os');
const fs    = require('fs-extra');
const { execSync } = require('child_process');
const { Option } = require('commander');

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
const { detectSpringProject } = require('../core/detector');
const { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
        injectStandalone,
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
    //   PostgreSQL + Ollama + Redis + Zookeeper + Kafka
    // --no-docker (only meaningful with --distributed) generates compose/initdb
    // files but does not run "docker compose up -d".
    .option('--distributed', 'Install distributed infrastructure (Postgres + Ollama + Redis + Kafka) for PoC/enterprise demo')
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
    .action(async (opts) => {
      // --simulate isolates this run from any other contexa stack on the same
      // host: separate compose project name, separate container names, and
      // separate ports. Implemented as preset env vars consumed by both the
      // generated docker-compose.yml and the runtime contexa.* / spring.*
      // env-fallback placeholders the CLI writes into application.yml.
      if (opts.simulate) {
        opts.distributed = true;
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
        securityMode: 'full', mode: 'shadow', llmProviders: ['ollama'],
        infra: opts.distributed ? 'distributed' : 'skip',
        injectDep: true,
        startDocker: opts.docker !== false,
      };

      // Each prompt's message is prefixed with "\n" so that there is one blank
      // line above every question. inquirer's rawlist also leaves a blank line
      // after the answer naturally, giving a consistent breathing-room layout
      // (asked for explicitly by the operator).
      const answers = opts.yes ? defaults : await inquirer.prompt([
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
          when: () => explicitIntegrationMode === null,
        },
        {
          type: 'input', name: 'standaloneDir',
          message: '\n' + t('prompt.standaloneDir'),
          default: path.join(opts.dir, 'contexa'),
          when: a => {
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
        },
        {
          type: 'rawlist', name: 'mode',
          message: '\n' + t('prompt.mode'),
          default: 1,
          choices: [
            { name: t('prompt.mode.shadow'), value: 'shadow' },
            { name: t('prompt.mode.enforce'), value: 'enforce' },
          ],
        },
        {
          // checkbox stays as-is because rawlist does not support multiple
          // selection. Hint text in the bundle already explains space/enter.
          type: 'checkbox', name: 'llmProviders',
          message: '\n' + t('prompt.llm'),
          choices: [
            { name: t('prompt.llm.ollama'),    value: 'ollama',    checked: true },
            { name: t('prompt.llm.openai'),    value: 'openai' },
            { name: t('prompt.llm.anthropic'), value: 'anthropic' },
          ],
          validate: a => a.length > 0 ? true : t('prompt.llm.atLeastOne'),
        },
        {
          type: 'rawlist', name: 'infra',
          message: '\n' + t('prompt.infra'),
          // Default = skip: never touch infrastructure unless the user opts in.
          // Distributed is the only auto-provisioning option (Postgres + Ollama +
          // Redis + Zookeeper + Kafka). Customers running their own stack should
          // accept the default.
          default: opts.distributed ? 2 : 1,
          choices: [
            { name: t('prompt.infra.skip'),       value: 'skip' },
            { name: t('prompt.infra.distributed') || 'Yes - install distributed (Postgres + Ollama + Redis + Kafka)', value: 'distributed' },
          ],
          when: () => !opts.distributed,
        },
        {
          type: 'input', name: 'infraDir',
          message: '\n' + t('prompt.infraDir'),
          default: () => resolveInfraDir(resolveProjectName(), {}),
          when: a => {
            const infra = opts.distributed ? 'distributed' : a.infra;
            return infra !== 'skip' && !opts.infraDir;
          },
        },
        {
          type: 'confirm', name: 'startDocker',
          message: '\n' + t('prompt.startDocker'),
          default: true,
          when: a => {
            const infra = opts.distributed ? 'distributed' : a.infra;
            return infra !== 'skip' && project.hasDocker && opts.docker !== false;
          },
        },
      ]);

      // Resolve final integration mode: explicit flag > prompt answer > default.
      answers.integrationMode = explicitIntegrationMode || answers.integrationMode || 'merge';
      // Always inject dependency. --distributed remains authoritative even when
      // the interactive prompt suggested otherwise.
      answers.injectDep = true;
      if (opts.distributed) answers.infra = 'distributed';
      if (opts.docker === false) answers.startDocker = false;
      // Resolve standalone dir: explicit flag > prompt answer > default.
      // Inputs are normalized so "~" expands and relative paths resolve
      // against opts.dir (the customer project root), not process.cwd().
      const standaloneDir = answers.integrationMode === 'standalone'
        ? (normalizePath(opts.standaloneDir, opts.dir)
            || normalizePath(answers.standaloneDir, opts.dir)
            || path.resolve(opts.dir, 'contexa'))
        : null;
      // Resolve infra dir: explicit flag > prompt answer > OS default.
      // Same normalization rule. The OS-default fallback is applied later
      // by resolveInfraDir() when this override is null.
      const infraDirOverride = normalizePath(opts.infraDir, opts.dir)
        || normalizePath(answers.infraDir, opts.dir)
        || null;

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
        const sStandalone = ora(t('step.writingStandalone')).start();
        try {
          // Pass --force so injectStandalone will overwrite an existing
          // non-empty folder. Without --force, a non-empty folder that does
          // not look like a previous contexa-cli output is rejected up-front.
          standaloneResult = await injectStandalone(standaloneDir, project, {
            ...answers, force: !!opts.force,
          });
          sStandalone.succeed(t('step.standaloneWritten'));
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
        const s1 = ora(t('step.updatingYml')).start();
        try {
          await injectYml(ymlPath, answers);
          ymlChanged = true;
          s1.succeed(t('step.ymlUpdated'));
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
            const s2 = ora(t('step.addingDep')).start();
            const ok = project.buildTool === 'maven'
              ? await injectMavenDep(buildPath)
              : await injectGradleDep(buildPath);
            if (ok) buildChanged = true;
            ok ? s2.succeed(t('step.depAdded')) : s2.info(t('step.depAlreadyPresent'));

            // Spring AI provider starters and the pgvector vector-store starter
            // are intentionally NOT added by contexa-cli. They are only needed
            // when the application declares @EnableAISecurity, and even then
            // they belong to the customer's dependency surface - automatically
            // adding them blindly to a customer app without @EnableAISecurity
            // triggers PgVector / ChatModel bean instantiation errors at start.
            // contexa-cli's contract: "we add ONE dependency line and merge
            // contexa.* into your yml. Nothing else." The next.steps section
            // tells the operator which extra deps to add by hand if they
            // declare @EnableAISecurity.

            if (answers.infra === 'distributed') {
              const s2b = ora(t('step.addingDistributedDeps')).start();
              const added = await injectDistributedDeps(buildPath);
              if (added) buildChanged = true;
              added ? s2b.succeed(t('step.distributedDepsAdded')) : s2b.info(t('step.distributedDepsPresent'));
            }
          } catch (err) {
            console.log('');
            console.log(chalk.red('  x Build dependency injection failed.'));
            console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
            console.log('');
            await rollbackOnFailure(ymlPath, ymlChanged, buildPath, buildChanged);
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
        if (answers.infra === 'distributed') {
          console.log(chalk.cyan('\n  Distributed infrastructure: PostgreSQL + Ollama + Redis + Zookeeper + Kafka'));
        } else {
          console.log(chalk.cyan('\n  Standalone infrastructure: PostgreSQL + Ollama'));
        }

        infraDir = resolveInfraDir(resolveProjectName(), { infraDir: infraDirOverride });
        console.log(chalk.gray(`  Infrastructure files location: ${infraDir}`));

        const s3a = ora(t('step.generatingDb')).start();
        const dbResult = await generateInitDbScripts(infraDir);
        seedPassword = dbResult.seedPassword;
        s3a.succeed(t('step.dbGenerated'));

        const s3 = ora(t('step.generatingCompose')).start();
        await generateDockerCompose(infraDir, answers);
        s3.succeed(answers.infra === 'distributed'
          ? t('step.composeGenerated.distributed')
          : t('step.composeGenerated'));

        // 5b. Pre-flight checks before docker compose up. We do this even when
        // --no-docker is set so the user knows what conflicts to expect when
        // they run compose manually later.
        const sPre = ora('Running infrastructure pre-flight checks').start();
        const issues = await inspectInfra({
          infra: answers.infra,
          startDocker: answers.startDocker,
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

        // If preflight detected that EVERY required container is already on
        // this host, skip "docker compose up -d" entirely and reuse what is
        // running. The operator's intent is "I already have contexa infra
        // up, just use it" - re-creating would lose the existing volumes.
        const allContainersExist = issues.some(i => i.code === 'all-containers-exist');

        // 6. Start Docker
        // cwd is the contexa-owned infraDir so the docker-compose.yml that we
        // just generated is the one compose picks up - never the customer's.
        if (allContainersExist) {
          console.log(chalk.green('  v ' + 'Existing infrastructure reused; "docker compose up -d" skipped.'));
        }
        if (answers.startDocker && project.hasDocker && !allContainersExist) {
          const s4 = ora(t('step.startingDocker')).start();
          try {
            execSync('docker compose up -d', { cwd: infraDir, stdio: 'inherit' });
            s4.succeed(t('step.dockerStarted'));

            // 7. Pull Ollama models
            // Container name is project-aware (production: contexa-ollama,
            // simulate: ctxa-sim-ollama, custom CONTEXA_PROJECT: <name>-ollama).
            // Hard-coding "contexa-ollama" would silently target a production
            // container if the user is running --simulate alongside an existing
            // production stack on the same host.
            if (answers.llmProviders && answers.llmProviders.includes('ollama')) {
              const ollamaContainer = containerName('ollama');
              const chatModel = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b';
              const embedModel = process.env.OLLAMA_EMBEDDING_MODEL || 'mxbai-embed-large';
              const s5 = ora(t('step.pullingChat', chatModel)).start();
              try {
                // Wait for Ollama to be ready - bounded by both per-call timeout
                // and absolute wall-clock deadline so a wedged docker daemon
                // can never hang the CLI indefinitely.
                let ready = false;
                const deadlineMs = Date.now() + 90000; // 90s absolute cap
                while (!ready && Date.now() < deadlineMs) {
                  try {
                    execSync(
                      `docker exec ${ollamaContainer} curl -sf http://localhost:11434/api/tags`,
                      { stdio: 'ignore', timeout: 3000 }
                    );
                    ready = true;
                    break;
                  } catch { await sleep(2000); }
                }

                if (ready) {
                  execSync(`docker exec ${ollamaContainer} ollama pull ${chatModel}`,
                    { stdio: 'inherit', timeout: 600000 });
                  s5.succeed(t('step.chatPulled', chatModel));

                  const s6 = ora(t('step.pullingEmbedding', embedModel)).start();
                  execSync(`docker exec ${ollamaContainer} ollama pull ${embedModel}`,
                    { stdio: 'inherit', timeout: 600000 });
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

      // 8. Done - show next steps
      console.log(chalk.green('\n  ' + t('init.done') + '\n'));

      // Standalone mode: surface the one-line wiring the user must add to
      // their own files. Shown right after init.done so operators do not miss
      // it. Skipped in merge mode because there's nothing for the user to
      // wire up.
      if (standaloneResult) {
        console.log(chalk.yellow('  ' + t('standalone.imports.title') + '\n'));
        console.log(chalk.gray('  ' + t('standalone.imports.yml')));
        console.log(chalk.cyan('     spring:'));
        console.log(chalk.cyan('       config:'));
        console.log(chalk.cyan('         import: "optional:file:./contexa/application.yml"'));
        console.log('');
        if (standaloneResult.importHints.isMaven) {
          console.log(chalk.gray('  ' + t('standalone.imports.maven')));
          console.log(chalk.cyan(`     ${standaloneResult.buildFragmentPath}`));
          console.log(chalk.gray('  ' + t('standalone.imports.mavenNote')));
        } else {
          console.log(chalk.gray('  ' + t('standalone.imports.gradleGroovy')));
          console.log(chalk.cyan("     apply from: 'contexa/contexa.gradle'"));
          console.log('');
          console.log(chalk.gray('  ' + t('standalone.imports.gradleKotlin')));
          console.log(chalk.cyan('     apply(from = "contexa/contexa.gradle")'));
        }
        console.log('');
      }

      // Surface the randomly generated seed password ONCE so the operator
      // can record it. After this run, contexa-cli has no record of it.
      if (seedPassword) {
        console.log(chalk.yellow('  ' + t('init.seedPassword.title')));
        console.log(chalk.cyan(`    ${seedPassword}`));
        console.log(chalk.gray('    ' + t('init.seedPassword.note1')));
        console.log(chalk.gray('    ' + t('init.seedPassword.note2') + '\n'));

        // initdb/02-dml.sql contains the BCrypt hash of the password printed
        // above. Committing that file would leak the hash to the repository
        // history. Surface a one-line .gitignore hint right next to the
        // password so the operator does not miss it.
        console.log(chalk.yellow('  ' + t('init.initdb.gitignore.title')));
        console.log(chalk.gray('    ' + t('init.initdb.gitignore.note1')));
        console.log(chalk.gray('    ' + t('init.initdb.gitignore.note2') + '\n'));
      }

      console.log(chalk.white('  ' + t('next.steps') + '\n'));

      if (answers.securityMode === 'sandbox') {
        console.log(chalk.gray('  ' + t('next.step1.sandbox') + '\n'));
        console.log(chalk.cyan('     @EnableAISecurity('));
        console.log(chalk.cyan('         mode = SecurityMode.SANDBOX,'));
        console.log(chalk.cyan('         authBridge = SessionAuthBridge.class,'));
        console.log(chalk.cyan('         sessionUserAttribute = "YOUR_SESSION_ATTRIBUTE"'));
        console.log(chalk.cyan('     )'));
        console.log(chalk.cyan('     @SpringBootApplication'));
        console.log(chalk.cyan('     public class YourApplication { }'));
      } else {
        console.log(chalk.gray('  ' + t('next.step1.full') + '\n'));
        console.log(chalk.cyan('     @EnableAISecurity'));
        console.log(chalk.cyan('     @SpringBootApplication'));
        console.log(chalk.cyan('     public class YourApplication { }'));
      }

      // @EnableAISecurity unlocks the rag-vector + chat-model code paths in
      // contexa-core. Those paths need Spring AI starters that contexa-cli
      // INTENTIONALLY does not auto-add (auto-adding them on every customer
      // breaks the customers who don't declare the annotation). Print the
      // exact lines the operator must add by hand if they declare it.
      console.log(chalk.gray('\n  ' + t('next.aiDeps.title') + '\n'));
      const isMavenForHint = project.buildTool === 'maven';
      if (isMavenForHint) {
        console.log(chalk.cyan('     <dependency>'));
        console.log(chalk.cyan('       <groupId>org.springframework.ai</groupId>'));
        console.log(chalk.cyan('       <artifactId>spring-ai-starter-model-ollama</artifactId>'));
        console.log(chalk.cyan('     </dependency>'));
        console.log(chalk.cyan('     <dependency>'));
        console.log(chalk.cyan('       <groupId>org.springframework.ai</groupId>'));
        console.log(chalk.cyan('       <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>'));
        console.log(chalk.cyan('     </dependency>'));
      } else {
        console.log(chalk.cyan("     implementation 'org.springframework.ai:spring-ai-starter-model-ollama'"));
        console.log(chalk.cyan("     implementation 'org.springframework.ai:spring-ai-starter-vector-store-pgvector'"));
      }
      console.log(chalk.gray('  ' + t('next.aiDeps.providerNote')));

      console.log(chalk.gray('\n  ' + t('next.step2') + '\n'));
      console.log(chalk.cyan('     @Protectable'));
      console.log(chalk.cyan('     @GetMapping("/api/data")'));
      console.log(chalk.cyan('     public ResponseEntity<?> getData() { ... }'));

      console.log(chalk.gray('\n  ' + t('next.step3') + '\n'));

      if (answers.mode === 'shadow') {
        console.log(chalk.yellow('  ' + t('next.shadowActive')));
        console.log(chalk.yellow('  ' + t('next.shadowToggle') + '\n'));
      }

      // Security checklist - non-negotiable items the operator must address
      // before exposing this deployment outside of their own machine.
      console.log(chalk.red.bold('  ' + t('warn.security.title')));
      console.log(chalk.red('    - ' + t('warn.security.envVars')));
      console.log(chalk.red('    - ' + t('warn.security.gitignore')));
      console.log(chalk.red('    - ' + t('warn.security.demoUsers')));
      if (answers.mode === 'shadow') {
        console.log(chalk.red('    - ' + t('warn.security.shadowMode')));
      }
      console.log('');
    });
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Restore application.yml and the build file from their .bak siblings when a
// later step in the (yml + build) transaction fails. The .bak files are left
// in place after restore so the operator can still inspect what we attempted.
async function rollbackOnFailure(ymlPath, ymlChanged, buildPath, buildChanged) {
  const restored = [];
  if (buildChanged) {
    const bak = buildPath + '.bak';
    if (await fs.pathExists(bak)) {
      try { await fs.copy(bak, buildPath, { overwrite: true }); restored.push(path.basename(buildPath)); }
      catch (e) { console.log(chalk.red(`    Failed to restore ${path.basename(buildPath)}: ${e.message}`)); }
    }
  }
  if (ymlChanged) {
    const bak = ymlPath + '.bak';
    if (await fs.pathExists(bak)) {
      try { await fs.copy(bak, ymlPath, { overwrite: true }); restored.push(path.basename(ymlPath)); }
      catch (e) { console.log(chalk.red(`    Failed to restore ${path.basename(ymlPath)}: ${e.message}`)); }
    }
  }
  if (restored.length > 0) {
    console.log(chalk.yellow('  ! Rolled back: ' + restored.join(', ')));
    console.log(chalk.gray('    Your project files have been restored to their pre-init state.'));
    console.log(chalk.gray('    The .bak files are kept on disk for reference.'));
    console.log('');
  } else {
    console.log(chalk.yellow('  ! No automatic rollback was performed (no .bak files found or no changes made).'));
    console.log('');
  }
}
