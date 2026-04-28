'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';
const DEFAULT_DB_PASSWORD = 'contexa1234!@#';

module.exports = function (program) {
  program
    .command('scan')
    .description('Scan project for security and configuration issues')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ' + t('scan.title') + '\n'));

      const s = ora('...').start();
      const project = await detectSpringProject(opts.dir);
      await new Promise(r => setTimeout(r, 200));
      s.stop();

      const issues = [], warnings = [], passes = [];

      if (!project.isSpring)              { issues.push(t('scan.notSpring')); }

      if (!project.hasContexta)           { issues.push(t('scan.contexaMissing')); }
      else                                { passes.push(t('scan.contexaInstalled')); }

      if (!project.hasSpringSecurityCore) { warnings.push(t('scan.springSecurityMissing')); }
      else                                { passes.push(t('scan.springSecurity')); }

      // Both files exist - one shadows the other depending on Spring's load order.
      if (project.appPropertiesPath && project.appYmlPath) {
        warnings.push(t('scan.propertiesAndYml'));
      }

      if (project.appYmlPath) {
        passes.push(t('scan.ymlPresent'));
        const yml = await fs.readFile(project.appYmlPath, 'utf8');
        const blockMatch = yml.match(
          new RegExp(`${escapeRegex(MARKER_START)}([\\s\\S]*?)${escapeRegex(MARKER_END)}`)
        );
        if (blockMatch) {
          passes.push(t('scan.blockPresent'));
          const block = blockMatch[1];
          const modeValue = (block.match(/\bzerotrust:[\s\S]*?\bmode:\s*(\w+)/)?.[1]
                          || block.match(/\bmode:\s*(\w+)/)?.[1] || '').toLowerCase();
          if (modeValue === 'shadow' || modeValue === 'shadow') {
            warnings.push(t('scan.shadowMode'));
          } else if (modeValue === 'enforce') {
            passes.push(t('scan.enforceMode'));
          }

          // API key exposed in plaintext (not a ${ENV:default} placeholder).
          if (/api-key:\s*(sk-|sk_)(?!\$\{)/.test(block)) {
            issues.push(t('scan.apiKeyExposed'));
          }

          // Default DB password remained in any datasource block.
          if (block.includes(DEFAULT_DB_PASSWORD)) {
            issues.push(t('scan.defaultDbPassword'));
          }
        } else {
          warnings.push(t('scan.blockMissing'));
        }
      } else if (project.isSpring) {
        warnings.push(t('scan.ymlMissing'));
      }

      passes.forEach(p   => console.log(`  ${chalk.green('v')} ${p}`));
      warnings.forEach(w => console.log(`  ${chalk.yellow('!')} ${w}`));
      issues.forEach(i   => console.log(`  ${chalk.red('x')} ${i}`));

      console.log('');
      console.log(`  ${t('scan.passed')}: ${chalk.green(passes.length)}   ${t('scan.warnings')}: ${chalk.yellow(warnings.length)}   ${t('scan.issues')}: ${chalk.red(issues.length)}\n`);

      if (issues.length > 0) process.exitCode = 1;
    });
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
