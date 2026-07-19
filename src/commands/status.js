'use strict';

const chalk = require('chalk');
const fs    = require('fs-extra');
const yaml  = require('js-yaml');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');
const { INSTALLATION_STATES, inspectInstallationState } = require('../core/installation-state');

function getPath(obj, pathArr) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

module.exports = function (program) {
  program
    .command('status')
    .description(t('status.description'))
    .option('--dir <path>', t('status.option.dir'), process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ' + t('status.title') + '\n'));

      // status is read-only; do not probe docker (lazy detector).
      const project = await detectSpringProject(opts.dir, { probeDocker: false });

      console.log(`  ${t('status.spring')}   : ${project.isSpring  ? chalk.green('v') : chalk.red('x')}`);
      console.log(`  ${t('status.contexa')}  : ${project.hasContexta ? chalk.green(t('status.installed')) : chalk.red(t('status.notInstalled'))}`);
      console.log(`  ${t('status.security')} : ${project.hasSpringSecurityCore ? t('init.security.springSecurity') : chalk.yellow(t('init.security.legacy'))}`);

      const installation = await inspectInstallationState(opts.dir);
      console.log(`  ${t('status.ownership')} : ${installation.state}`);
      for (const item of [installation.normal, installation.simulation]) {
        const label = item.mode === 'normal' ? t('status.normal') : t('status.simulation');
        const identity = item.installationId ? ` (installationId=${item.installationId})` : '';
        console.log(`  ${label}: ${item.transactionStatus || item.status}${identity}`);
        if (item.reason) console.log(chalk.gray(`    ${item.reason}`));
      }
      if ([INSTALLATION_STATES.CONFLICT, INSTALLATION_STATES.PARTIAL_FAILURE].includes(installation.state)) {
        process.exitCode = 1;
      }

      if (project.appYmlPath && await fs.pathExists(project.appYmlPath)) {
        const content = await fs.readFile(project.appYmlPath, 'utf8');
        let root = null;
        try { root = yaml.load(content); } catch { root = null; }
        if (root && typeof root === 'object' && root.contexa) {
          const modeRaw = getPath(root, ['contexa', 'security', 'zerotrust', 'mode']);
          const mode = (modeRaw || '').toString().toUpperCase();
          // Prefer the new selection-API priority; fall back to the legacy
          // chatModelPriority key for projects still using the deprecated form.
          const chatPriority =
            getPath(root, ['contexa', 'llm', 'selection', 'chat', 'priority']) ||
            getPath(root, ['contexa', 'llm', 'chatModelPriority']);
          if (mode) {
            console.log(`  ${t('status.mode')}     : ${mode === 'ENFORCE' ? chalk.green('ENFORCE') : chalk.yellow('SHADOW')}`);
          }
          if (chatPriority) {
            console.log(`  ${t('status.llm')}      : ${chatPriority}`);
          }
        } else {
          console.log(`  ${chalk.yellow('!')} ${t('scan.blockMissing')}`);
        }
      }
      console.log('');
    });
};
