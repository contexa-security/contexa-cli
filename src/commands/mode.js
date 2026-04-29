'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const yaml  = require('js-yaml');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

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
      const targetUpper = target.toUpperCase();
      const project = await detectSpringProject(opts.dir);

      if (!project.appYmlPath || !await fs.pathExists(project.appYmlPath)) {
        console.log(chalk.red('\n  x ' + t('mode.notInstalled') + '\n'));
        return;
      }

      const s = ora('...').start();
      const content = await fs.readFile(project.appYmlPath, 'utf8');

      let root;
      try {
        root = yaml.load(content);
      } catch (err) {
        s.stop();
        console.log(chalk.red('\n  x cannot parse application.yml: ' + err.message + '\n'));
        return;
      }
      if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

      const previous = root?.contexa?.security?.zerotrust?.mode;
      if (!root.contexa || !root.contexa.security || !root.contexa.security.zerotrust) {
        s.stop();
        console.log(chalk.red('\n  x ' + t('mode.noBlock') + '\n'));
        return;
      }
      const previousUpper = (previous || '').toString().toUpperCase();
      if (previousUpper === targetUpper) {
        s.stop();
        console.log(chalk.gray('\n  - ' + t('mode.unchanged', targetUpper) + '\n'));
        return;
      }

      await fs.copy(project.appYmlPath, project.appYmlPath + '.bak');
      root.contexa.security.zerotrust.mode = targetUpper;
      const out = yaml.dump(root, { lineWidth: 200, noRefs: true, sortKeys: false, quotingType: '"' });
      await fs.writeFile(project.appYmlPath, out);
      s.stop();

      console.log(chalk.green('\n  v ' + t('mode.changed', previousUpper || 'unset', targetUpper) + '\n'));
    });
};
