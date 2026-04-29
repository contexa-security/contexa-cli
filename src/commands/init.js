'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const inquirer = require('inquirer');
const path  = require('path');
const { execSync } = require('child_process');
const { Option } = require('commander');
const { detectSpringProject } = require('../core/detector');
const { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
        injectAiStarterDeps,
        generateDockerCompose, generateInitDbScripts } = require('../core/injector');
const { inspectInfra } = require('../core/preflight');
const { t } = require('../core/i18n');

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
      // Infrastructure is opt-in. Without --distributed the CLI never touches
      // compose/initdb/containers. The interactive prompt still offers a
      // distributed install for users who want one but did not pass the flag.
      const defaults = {
        securityMode: 'full', mode: 'shadow', llmProviders: ['ollama'],
        infra: opts.distributed ? 'distributed' : 'skip',
        injectDep: true,
        startDocker: opts.docker !== false,
      };

      const answers = opts.yes ? defaults : await inquirer.prompt([
        {
          type: 'list', name: 'securityMode',
          message: t('prompt.securityMode'),
          choices: [
            { name: t('prompt.securityMode.full'), value: 'full' },
            { name: t('prompt.securityMode.sandbox'), value: 'sandbox' },
          ],
        },
        {
          type: 'list', name: 'mode', message: t('prompt.mode'),
          choices: [
            { name: t('prompt.mode.shadow'), value: 'shadow' },
            { name: t('prompt.mode.enforce'), value: 'enforce' },
          ],
        },
        {
          type: 'checkbox', name: 'llmProviders', message: t('prompt.llm'),
          choices: [
            { name: t('prompt.llm.ollama'),    value: 'ollama',    checked: true },
            { name: t('prompt.llm.openai'),    value: 'openai' },
            { name: t('prompt.llm.anthropic'), value: 'anthropic' },
          ],
          validate: a => a.length > 0 ? true : t('prompt.llm.atLeastOne'),
        },
        {
          type: 'list', name: 'infra', message: t('prompt.infra'),
          // Default = skip: never touch infrastructure unless the user opts in.
          // Distributed is the only auto-provisioning option (Postgres + Ollama +
          // Redis + Zookeeper + Kafka). Customers running their own stack should
          // accept the default.
          default: 'skip',
          choices: [
            { name: t('prompt.infra.skip'),       value: 'skip' },
            { name: t('prompt.infra.distributed') || 'Yes - install distributed (Postgres + Ollama + Redis + Kafka)', value: 'distributed' },
          ],
        },
        {
          type: 'confirm', name: 'startDocker',
          message: t('prompt.startDocker'),
          default: true,
          when: a => a.infra !== 'skip' && project.hasDocker,
        },
      ]);

      // Always inject dependency. --distributed remains authoritative even when
      // the interactive prompt suggested otherwise.
      answers.injectDep = true;
      if (opts.distributed) answers.infra = 'distributed';
      if (opts.docker === false) answers.startDocker = false;

      console.log('');

      // 3. Inject application.yml
      const s1 = ora(t('step.updatingYml')).start();
      const ymlPath = project.appYmlPath || path.join(opts.dir, 'src/main/resources/application.yml');
      try {
        await injectYml(ymlPath, answers);
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

      // 4. Inject dependency
      if (answers.injectDep) {
        const s2 = ora(t('step.addingDep')).start();
        const buildPath = project.buildFilePath
          || (project.buildTool === 'maven'
            ? path.join(opts.dir, 'pom.xml')
            : path.join(opts.dir, 'build.gradle'));
        const ok = project.buildTool === 'maven'
          ? await injectMavenDep(buildPath)
          : await injectGradleDep(buildPath);
        ok ? s2.succeed(t('step.depAdded')) : s2.info(t('step.depAlreadyPresent'));

        // Spring AI provider starters are ONLY required when the application
        // declares @EnableAISecurity. Adding them blindly to a user app that
        // depends on spring-boot-starter-contexa without that annotation can
        // trigger PgVector / ChatModel bean instantiation errors. Detector
        // scans src/main/java for the annotation to decide.
        if (project.hasEnableAiSecurity && answers.llmProviders && answers.llmProviders.length > 0) {
          const s2a = ora('Adding Spring AI provider starter dependencies').start();
          const added = await injectAiStarterDeps(buildPath, answers.llmProviders);
          added ? s2a.succeed('Spring AI starters added: ' + answers.llmProviders.join(', '))
                : s2a.info('Spring AI starters already present');
        } else if (!project.hasEnableAiSecurity) {
          console.log(chalk.gray('  i Spring AI provider starters skipped (no @EnableAISecurity in src/main/java).'));
          console.log(chalk.gray('    They will be auto-added the next time you run "contexa init"'));
          console.log(chalk.gray('    after declaring @EnableAISecurity on a @SpringBootApplication class.'));
        }

        if (answers.infra === 'distributed') {
          const s2b = ora(t('step.addingDistributedDeps')).start();
          const added = await injectDistributedDeps(buildPath);
          added ? s2b.succeed(t('step.distributedDepsAdded')) : s2b.info(t('step.distributedDepsPresent'));
        }
      }

      // 5. Generate database init scripts + docker-compose.yml
      let seedPassword = null;
      if (answers.infra !== 'skip') {
        if (answers.infra === 'distributed') {
          console.log(chalk.cyan('\n  Distributed infrastructure: PostgreSQL + Ollama + Redis + Zookeeper + Kafka'));
        } else {
          console.log(chalk.cyan('\n  Standalone infrastructure: PostgreSQL + Ollama'));
        }

        const s3a = ora(t('step.generatingDb')).start();
        const dbResult = await generateInitDbScripts(opts.dir);
        seedPassword = dbResult.seedPassword;
        s3a.succeed(t('step.dbGenerated'));

        const s3 = ora(t('step.generatingCompose')).start();
        await generateDockerCompose(opts.dir, answers);
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

        // 6. Start Docker
        if (answers.startDocker && project.hasDocker) {
          const s4 = ora(t('step.startingDocker')).start();
          try {
            execSync('docker compose up -d', { cwd: opts.dir, stdio: 'inherit' });
            s4.succeed(t('step.dockerStarted'));

            // 7. Pull Ollama models
            if (answers.llmProviders && answers.llmProviders.includes('ollama')) {
              const chatModel = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b';
              const embedModel = process.env.OLLAMA_EMBEDDING_MODEL || 'mxbai-embed-large';
              const s5 = ora(t('step.pullingChat', chatModel)).start();
              try {
                // Wait for Ollama to be ready
                let ready = false;
                for (let i = 0; i < 30; i++) {
                  try {
                    execSync('docker exec contexa-ollama curl -sf http://localhost:11434/api/tags', { stdio: 'ignore' });
                    ready = true;
                    break;
                  } catch { await sleep(2000); }
                }

                if (ready) {
                  execSync(`docker exec contexa-ollama ollama pull ${chatModel}`, { stdio: 'inherit' });
                  s5.succeed(t('step.chatPulled', chatModel));

                  const s6 = ora(t('step.pullingEmbedding', embedModel)).start();
                  execSync(`docker exec contexa-ollama ollama pull ${embedModel}`, { stdio: 'inherit' });
                  s6.succeed(t('step.embeddingPulled'));
                } else {
                  s5.warn(t('step.ollamaNotReady', chatModel));
                }
              } catch (e) {
                s5.warn(t('step.modelPullFailed', chatModel));
              }
            }
          } catch (e) {
            s4.fail(t('step.dockerFailed'));
          }
        }
      }

      // 8. Done - show next steps
      console.log(chalk.green('\n  ' + t('init.done') + '\n'));

      // Surface the randomly generated seed password ONCE so the operator
      // can record it. After this run, contexa-cli has no record of it.
      if (seedPassword) {
        console.log(chalk.yellow('  ' + t('init.seedPassword.title')));
        console.log(chalk.cyan(`    ${seedPassword}`));
        console.log(chalk.gray('    ' + t('init.seedPassword.note1')));
        console.log(chalk.gray('    ' + t('init.seedPassword.note2') + '\n'));
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
