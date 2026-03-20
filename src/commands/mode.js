'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');

module.exports = function (program) {
  program
    .command('mode')
    .description('Switch between shadow and enforce mode')
    .option('--shadow',  'Analyze only, no blocking')
    .option('--enforce', 'Block threats actively')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      if (!opts.shadow && !opts.enforce) {
        console.log(chalk.gray('\n  contexa mode --shadow'));
        console.log(chalk.gray('  contexa mode --enforce\n'));
        return;
      }

      const target = opts.enforce ? 'enforce' : 'shadow';
      const project = await detectSpringProject(opts.dir);

      if (!project.appYmlPath || !await fs.pathExists(project.appYmlPath)) {
        console.log(chalk.red('\n✗ Run contexa init first\n'));
        return;
      }

      const s = ora('Switching mode...').start();
      let yml = await fs.readFile(project.appYmlPath, 'utf8');
      yml = yml.replace(/mode: \w+/, `mode: ${target}`);
      await fs.writeFile(project.appYmlPath, yml);
      s.stop();

      if (target === 'enforce') {
        console.log(chalk.green('\n✅ ENFORCE mode — threats will be blocked'));
      } else {
        console.log(chalk.yellow('\n✅ SHADOW mode — analyze only'));
      }
      console.log(chalk.gray('  Restart your app to apply.\n'));
    });
};
