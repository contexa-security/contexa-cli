'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

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
      const yml = await fs.readFile(project.appYmlPath, 'utf8');

      // Only touch the mode line inside the Contexa-managed block.
      const blockRegex = new RegExp(
        `(${escapeRegex(MARKER_START)}[\\s\\S]*?)(\\bmode:\\s*)\\w+([\\s\\S]*?${escapeRegex(MARKER_END)})`
      );
      if (!blockRegex.test(yml)) {
        s.stop();
        console.log(chalk.red('\n✗ Contexa block not found in application.yml — run contexa init first\n'));
        return;
      }

      // Backup before modification
      await fs.copy(project.appYmlPath, project.appYmlPath + '.bak');

      const updated = yml.replace(blockRegex, `$1$2${target}$3`);
      await fs.writeFile(project.appYmlPath, updated);
      s.stop();

      if (target === 'enforce') {
        console.log(chalk.green('\n✅ ENFORCE mode — threats will be blocked'));
      } else {
        console.log(chalk.yellow('\n✅ SHADOW mode — analyze only'));
      }
      console.log(chalk.gray('  Restart your app to apply.\n'));
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
