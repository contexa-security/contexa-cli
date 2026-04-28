'use strict';

const chalk = require('chalk');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

module.exports = function (program) {
  program
    .command('status')
    .description('Show Contexa status')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ' + t('status.title') + '\n'));

      const project = await detectSpringProject(opts.dir);

      console.log(`  ${t('status.spring')}   : ${project.isSpring  ? chalk.green('v') : chalk.red('x')}`);
      console.log(`  ${t('status.contexa')}  : ${project.hasContexta ? chalk.green(t('status.installed')) : chalk.red(t('status.notInstalled'))}`);
      console.log(`  ${t('status.security')} : ${project.hasSpringSecurityCore ? t('init.security.springSecurity') : chalk.yellow(t('init.security.legacy'))}`);

      if (project.appYmlPath && await fs.pathExists(project.appYmlPath)) {
        const yml = await fs.readFile(project.appYmlPath, 'utf8');
        const blockMatch = yml.match(
          new RegExp(`${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`)
        );
        if (blockMatch) {
          const block = blockMatch[1];
          const mode = (block.match(/\bzerotrust:[\s\S]*?\bmode:\s*(\w+)/)?.[1]
                     || block.match(/\bmode:\s*(\w+)/)?.[1] || '').toUpperCase();
          const chatPriority = block.match(/chatModelPriority:\s*([^\n]+)/)?.[1]?.trim();
          const ollamaModel = block.match(/ollama:[\s\S]*?model:[^\n]*?(\S+)\s*$/m)?.[1]?.trim();
          console.log(`  ${t('status.mode')}     : ${mode === 'ENFORCE' ? chalk.green('ENFORCE') : chalk.yellow('SHADOW')}`);
          if (chatPriority) {
            console.log(`  ${t('status.llm')}      : ${chatPriority}${ollamaModel ? ` / ${chalk.cyan(ollamaModel)}` : ''}`);
          }
        } else {
          console.log(`  ${chalk.yellow('!')} ${t('scan.blockMissing')}`);
        }
      }
      console.log('');
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
