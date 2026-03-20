'use strict';

const chalk = require('chalk');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');

module.exports = function (program) {
  program
    .command('status')
    .description('Show Contexa status')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n🔐 Contexa Status\n'));

      const project = await detectSpringProject(opts.dir);

      console.log(`  Spring   : ${project.isSpring  ? chalk.green('✓') : chalk.red('✗')}`);
      console.log(`  Contexa  : ${project.hasContexta ? chalk.green('installed') : chalk.red('not installed')}`);
      console.log(`  Security : ${project.hasSpringSecurityCore ? 'Spring Security' : chalk.yellow('Legacy Bridge')}`);

      if (project.appYmlPath && await fs.pathExists(project.appYmlPath)) {
        const yml = await fs.readFile(project.appYmlPath, 'utf8');
        const mode = yml.match(/mode: (\w+)/)?.[1];
        const provider = yml.match(/provider: (\w+)/)?.[1];
        const model = yml.match(/model: (.+)/)?.[1]?.trim();
        console.log(`  Mode     : ${mode === 'enforce' ? chalk.green('ENFORCE') : chalk.yellow('SHADOW')}`);
        console.log(`  LLM      : ${provider} / ${chalk.cyan(model)}`);
      }
      console.log('');
    });
};
