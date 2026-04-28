'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

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
        console.log(chalk.red('\n  x ' + t('mode.notInstalled') + '\n'));
        return;
      }

      const s = ora('...').start();
      const yml = await fs.readFile(project.appYmlPath, 'utf8');

      // Capture the current mode value to report old -> new.
      const blockRegex = new RegExp(
        `(${escapeRegex(MARKER_START)}[\\s\\S]*?)(\\bmode:\\s*)(\\w+)([\\s\\S]*?${escapeRegex(MARKER_END)})`
      );
      const match = yml.match(blockRegex);
      if (!match) {
        s.stop();
        console.log(chalk.red('\n  x ' + t('mode.noBlock') + '\n'));
        return;
      }

      const previous = (match[3] || '').toLowerCase();
      const targetUpper = target.toUpperCase();
      if (previous === targetUpper.toLowerCase() || previous === targetUpper) {
        s.stop();
        console.log(chalk.gray('\n  - ' + t('mode.unchanged', targetUpper) + '\n'));
        return;
      }

      // Backup before modification
      await fs.copy(project.appYmlPath, project.appYmlPath + '.bak');

      const updated = yml.replace(blockRegex, `$1$2${targetUpper}$4`);
      await fs.writeFile(project.appYmlPath, updated);
      s.stop();

      console.log(chalk.green('\n  v ' + t('mode.changed', previous.toUpperCase(), targetUpper) + '\n'));
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
