'use strict';

const chalk = require('chalk');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

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
        const blockMatch = yml.match(
          new RegExp(`${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`)
        );
        if (blockMatch) {
          const block = blockMatch[1];
          const mode = block.match(/\bmode:\s*(\w+)/)?.[1];
          const chatPriority = block.match(/chatModelPriority:\s*([^\n]+)/)?.[1]?.trim();
          const ollamaModel = block.match(/ollama:[\s\S]*?model:\s*([^\n]+)/)?.[1]?.trim();
          console.log(`  Mode     : ${mode === 'enforce' ? chalk.green('ENFORCE') : chalk.yellow('SHADOW')}`);
          if (chatPriority) {
            console.log(`  LLM      : ${chatPriority}${ollamaModel ? ` / ${chalk.cyan(ollamaModel)}` : ''}`);
          }
        } else {
          console.log(`  ${chalk.yellow('!')} application.yml found but Contexa block missing — run contexa init`);
        }
      }
      console.log('');
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
