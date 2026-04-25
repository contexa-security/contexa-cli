'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const path  = require('path');
const { detectSpringProject } = require('../core/detector');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

module.exports = function (program) {
  program
    .command('scan')
    .description('Scan project for security issues')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n🔍 Contexa Scan\n'));

      const s = ora('Scanning...').start();
      const project = await detectSpringProject(opts.dir);
      await new Promise(r => setTimeout(r, 500));
      s.stop();

      const issues = [], warnings = [], passes = [];

      if (!project.isSpring)       { issues.push('Spring project not found'); }
      else                         { passes.push('Spring project detected'); }

      if (!project.hasContexta)    { issues.push('Contexa not installed — run: contexa init'); }
      else                         { passes.push('Contexa installed'); }

      if (!project.hasSpringSecurityCore) { warnings.push('No Spring Security — Legacy Bridge will be used'); }
      else                                { passes.push('Spring Security present'); }

      if (project.appYmlPath) {
        const yml = await fs.readFile(project.appYmlPath, 'utf8');
        const blockMatch = yml.match(
          new RegExp(`${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`)
        );
        if (blockMatch) {
          const block = blockMatch[1];
          const modeValue = block.match(/\bmode:\s*(\w+)/)?.[1];
          if (modeValue === 'shadow') warnings.push('Shadow mode — not blocking yet');
          if (/api-key:\s*sk-(?!\$\{)/.test(block)) issues.push('API key exposed in yml — use env variable');
          passes.push('application.yml found (Contexa block detected)');
        } else {
          warnings.push('application.yml found but Contexa block missing — run contexa init');
        }
      } else {
        warnings.push('application.yml not found');
      }

      passes.forEach(p  => console.log(`  ${chalk.green('✓')} ${p}`));
      warnings.forEach(w => console.log(`  ${chalk.yellow('⚠')} ${w}`));
      issues.forEach(i  => console.log(`  ${chalk.red('✗')} ${i}`));

      console.log('');
      console.log(`  Passed: ${chalk.green(passes.length)}  Warnings: ${chalk.yellow(warnings.length)}  Issues: ${chalk.red(issues.length)}`);

      if (issues.length === 0) {
        console.log(chalk.green('\n  ✅ Ready!\n'));
      } else {
        console.log(chalk.red(`\n  ✗ Fix ${issues.length} issue(s)\n`));
      }
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
