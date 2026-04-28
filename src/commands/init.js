'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const inquirer = require('inquirer');
const path  = require('path');
const { execSync } = require('child_process');
const { Option } = require('commander');
const { detectSpringProject } = require('../core/detector');
const { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
        generateDockerCompose, generateInitDbScripts } = require('../core/injector');
const { t } = require('../core/i18n');

module.exports = function (program) {
  program
    .command('init')
    .description('Initialize Contexa AI Security in your Spring project')
    .option('--yes', 'Skip prompts, use defaults')
    .option('--force', 'Reinitialize even if already configured')
    .option('--dir <path>', 'Project directory', process.cwd())
    // Hidden flag: provisions Redis + Kafka infrastructure for PoC / enterprise demos.
    // Production deployments should use Kubernetes + Helm; not advertised in --help.
    .addOption(new Option('--distributed', 'PoC/enterprise demo with Redis + Kafka').hideHelp())
    .action(async (opts) => {
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
      const defaults = {
        securityMode: 'full', mode: 'shadow', llmProviders: ['ollama'],
        infra: opts.distributed ? 'distributed' : 'standalone',
        injectDep: true,
        startDocker: true,
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
          choices: [
            { name: t('prompt.infra.standalone'), value: 'standalone' },
            { name: t('prompt.infra.skip'),       value: 'skip' },
          ],
        },
        {
          type: 'confirm', name: 'startDocker',
          message: t('prompt.startDocker'),
          default: true,
          when: a => a.infra !== 'skip' && project.hasDocker,
        },
      ]);

      // Always inject dependency. --distributed forces the distributed profile
      // even when the user picked Standard interactively.
      answers.injectDep = true;
      if (opts.distributed) answers.infra = 'distributed';

      console.log('');

      // 3. Inject application.yml
      const s1 = ora(t('step.updatingYml')).start();
      const ymlPath = project.appYmlPath || path.join(opts.dir, 'src/main/resources/application.yml');
      await injectYml(ymlPath, answers);
      s1.succeed(t('step.ymlUpdated'));

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

        if (answers.infra === 'distributed') {
          const s2b = ora(t('step.addingDistributedDeps')).start();
          const added = await injectDistributedDeps(buildPath);
          added ? s2b.succeed(t('step.distributedDepsAdded')) : s2b.info(t('step.distributedDepsPresent'));
        }
      }

      // 5. Generate database init scripts + docker-compose.yml
      let seedPassword = null;
      if (answers.infra !== 'skip') {
        const s3a = ora(t('step.generatingDb')).start();
        const dbResult = await generateInitDbScripts(opts.dir);
        seedPassword = dbResult.seedPassword;
        s3a.succeed(t('step.dbGenerated'));

        const s3 = ora(t('step.generatingCompose')).start();
        await generateDockerCompose(opts.dir, answers);
        s3.succeed(answers.infra === 'distributed'
          ? t('step.composeGenerated.distributed')
          : t('step.composeGenerated'));

        // 6. Start Docker
        if (answers.startDocker && project.hasDocker) {
          const s4 = ora(t('step.startingDocker')).start();
          try {
            execSync('docker compose up -d', { cwd: opts.dir, stdio: 'inherit' });
            s4.succeed(t('step.dockerStarted'));

            // 7. Pull Ollama models
            if (answers.llmProviders && answers.llmProviders.includes('ollama')) {
              const chatModel = 'qwen2.5:7b';
              const embedModel = 'mxbai-embed-large';
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
