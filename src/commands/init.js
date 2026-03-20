'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const inquirer = require('inquirer');
const path  = require('path');
const { execSync } = require('child_process');
const { detectSpringProject } = require('../core/detector');
const { injectYml, injectMavenDep, injectGradleDep, generateDockerCompose } = require('../core/injector');

module.exports = function (program) {
  program
    .command('init')
    .description('Initialize Contexa AI Security in your Spring project')
    .option('--yes', 'Skip prompts, use defaults')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log('');

      // 1. Detect project
      const spinner = ora('Detecting Spring project...').start();
      const project = await detectSpringProject(opts.dir);
      spinner.stop();

      if (!project.isSpring) {
        console.log(chalk.red('  x Spring project not found.'));
        console.log(chalk.gray('    Run this command inside your Spring project root.\n'));
        process.exit(1);
      }

      console.log(chalk.green('  v Spring project detected'));
      console.log(chalk.gray(`    Project : ${project.projectName || 'unknown'}`));
      console.log(chalk.gray(`    Build   : ${project.buildTool}`));
      console.log(chalk.gray(`    Security: ${project.hasSpringSecurityCore ? 'Spring Security' : chalk.yellow('none (Legacy)')}`));
      console.log(chalk.gray(`    Docker  : ${project.hasDocker ? chalk.green('installed') : chalk.yellow('not found')}`));

      if (project.hasContexta) {
        console.log(chalk.yellow('\n  Already initialized. Use: contexa status\n'));
        return;
      }

      // 2. Prompts
      const defaults = {
        securityMode: 'full', mode: 'shadow', llmProviders: ['ollama'],
        infra: 'standalone', injectDep: true,
        startDocker: true,
      };

      const answers = opts.yes ? defaults : await inquirer.prompt([
        {
          type: 'list', name: 'securityMode',
          message: 'Your project type (New project / Legacy system):',
          choices: [
            { name: 'New project     - Contexa handles login + security  (default)', value: 'full' },
            { name: 'Legacy system  - Keep your login, add AI security',             value: 'sandbox' },
          ],
        },
        {
          type: 'list', name: 'mode', message: 'Enable AI security immediately:',
          choices: [
            { name: 'No, observe   - monitor and log only  (default)', value: 'shadow' },
            { name: 'Yes, enforce  - detect and block immediately',    value: 'enforce' },
          ],
        },
        {
          type: 'checkbox', name: 'llmProviders', message: 'AI / LLM Model (space to select, enter to confirm):',
          choices: [
            { name: 'Ollama     - runs locally, no data leaves your server  (default)',  value: 'ollama',    checked: true },
            { name: 'OpenAI     - cloud API, fast (requires API key)',                   value: 'openai' },
            { name: 'Anthropic  - cloud API, advanced (requires API key)',               value: 'anthropic' },
          ],
          validate: a => a.length > 0 ? true : 'Select at least one',
        },
        {
          type: 'list', name: 'infra', message: 'Infrastructure setup (Docker):',
          choices: [
            { name: 'Standard      - PostgreSQL + Ollama + In Memory  (default)',  value: 'standalone' },
            { name: 'Distributed   - PostgreSQL + Ollama + Redis + Kafka',         value: 'distributed' },
            { name: 'Skip          - I will set up infrastructure myself',         value: 'skip' },
          ],
        },
        {
          type: 'confirm', name: 'startDocker',
          message: 'Start Docker containers now? (default: Yes)',
          default: true,
          when: a => a.infra !== 'skip' && project.hasDocker,
        },
      ]);

      // Always inject dependency
      answers.injectDep = true;

      console.log('');

      // 3. Inject application.yml
      const s1 = ora('Updating application.yml...').start();
      const ymlPath = project.appYmlPath || path.join(opts.dir, 'src/main/resources/application.yml');
      await injectYml(ymlPath, answers);
      s1.succeed('application.yml updated');

      // 4. Inject dependency
      if (answers.injectDep) {
        const s2 = ora('Adding dependency...').start();
        const ok = project.buildTool === 'maven'
          ? await injectMavenDep(path.join(opts.dir, 'pom.xml'))
          : await injectGradleDep(path.join(opts.dir, 'build.gradle'));
        ok ? s2.succeed('Dependency added') : s2.info('Already present');
      }

      // 5. Generate docker-compose.yml
      if (answers.infra !== 'skip') {
        const s3 = ora('Generating docker-compose.yml...').start();
        await generateDockerCompose(opts.dir, answers);
        s3.succeed('docker-compose.yml generated');

        // 6. Start Docker
        if (answers.startDocker && project.hasDocker) {
          const s4 = ora('Starting Docker containers...').start();
          try {
            execSync('docker compose up -d', { cwd: opts.dir, stdio: 'inherit' });
            s4.succeed('Docker containers started');

            // 7. Pull Ollama models
            if (answers.llmProvider === 'ollama') {
              const s5 = ora(`Pulling LLM model: ${answers.llmModel}...`).start();
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
                  execSync(`docker exec contexa-ollama ollama pull ${answers.llmModel}`, { stdio: 'inherit' });
                  s5.succeed(`Model ${answers.llmModel} pulled`);

                  const s6 = ora('Pulling embedding model: mxbai-embed-large...').start();
                  execSync('docker exec contexa-ollama ollama pull mxbai-embed-large', { stdio: 'inherit' });
                  s6.succeed('Embedding model pulled');
                } else {
                  s5.warn('Ollama not ready. Pull models manually: docker exec contexa-ollama ollama pull ' + answers.llmModel);
                }
              } catch (e) {
                s5.warn('Model pull failed. Pull manually: docker exec contexa-ollama ollama pull ' + answers.llmModel);
              }
            }
          } catch (e) {
            s4.fail('Docker start failed. Run manually: docker compose up -d');
          }
        }
      }

      // 8. Done - show next steps
      console.log(chalk.green('\n  Done!\n'));
      console.log(chalk.white('  Next steps:\n'));

      if (answers.securityMode === 'sandbox') {
        console.log(chalk.gray('  1. Add to your main class:\n'));
        console.log(chalk.cyan('     @EnableAISecurity('));
        console.log(chalk.cyan('         mode = SecurityMode.SANDBOX,'));
        console.log(chalk.cyan('         authBridge = SessionAuthBridge.class,'));
        console.log(chalk.cyan('         sessionUserAttribute = "YOUR_SESSION_ATTRIBUTE"'));
        console.log(chalk.cyan('     )'));
        console.log(chalk.cyan('     @SpringBootApplication'));
        console.log(chalk.cyan('     public class YourApplication { }'));
      } else {
        console.log(chalk.gray('  1. Add to your main class:\n'));
        console.log(chalk.cyan('     @EnableAISecurity'));
        console.log(chalk.cyan('     @SpringBootApplication'));
        console.log(chalk.cyan('     public class YourApplication { }'));
      }

      console.log(chalk.gray('\n  2. Add to endpoints you want to protect:\n'));
      console.log(chalk.cyan('     @Protectable'));
      console.log(chalk.cyan('     @GetMapping("/api/data")'));
      console.log(chalk.cyan('     public ResponseEntity<?> getData() { ... }'));

      console.log(chalk.gray('\n  3. Restart your application\n'));

      if (answers.mode === 'shadow') {
        console.log(chalk.yellow('  Shadow mode active - analyze only, no blocking.'));
        console.log(chalk.yellow('  Run: contexa mode --enforce  when ready.\n'));
      }
    });
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
