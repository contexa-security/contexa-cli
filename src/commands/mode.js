'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const fs    = require('fs-extra');
const yaml  = require('js-yaml');
const path  = require('path');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');
const {
  INSTALL_MODES,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  recordChange,
  rollbackInstallTransaction,
  sha256FileSync,
} = require('../core/manifest');

function ownershipError(message) {
  const error = new Error(`MODE_OWNERSHIP_REQUIRED ${message}`);
  error.code = 'MODE_OWNERSHIP_REQUIRED';
  return error;
}

module.exports = function (program) {
  program
    .command('mode')
    .description(t('mode.description'))
    .option('--shadow', t('mode.option.shadow'))
    .option('--enforce', t('mode.option.enforce'))
    .option('--dir <path>', t('mode.option.dir'), process.cwd())
    .action(async (opts) => {
      if (!opts.shadow && !opts.enforce) {
        console.log(chalk.gray('\n  contexa mode --shadow'));
        console.log(chalk.gray('  contexa mode --enforce\n'));
        throw new Error('Choose exactly one mode: --shadow or --enforce.');
      }

      const target = opts.enforce ? 'enforce' : 'shadow';
      const targetUpper = target.toUpperCase();
      // mode only mutates application.yml; no docker probe needed.
      const project = await detectSpringProject(opts.dir, { probeDocker: false });

      if (!project.appYmlPath || !await fs.pathExists(project.appYmlPath)) {
        console.log(chalk.red('\n  x ' + t('mode.notInstalled') + '\n'));
        throw new Error('Contexa mode configuration was not found.');
      }

      if (!await fs.pathExists(manifestPath(opts.dir, INSTALL_MODES.NORMAL))) {
        throw ownershipError('Normal installation manifest was not found; host configuration was not changed.');
      }
      const manifest = await loadManifest(opts.dir, INSTALL_MODES.NORMAL);
      if (!manifest.transaction || manifest.transaction.status !== 'COMMITTED') {
        throw ownershipError('Normal installation is not in COMMITTED state; host configuration was not changed.');
      }
      const relativePath = path.relative(opts.dir, project.appYmlPath).split(path.sep).join('/');
      const entry = (manifest.files || []).find(file => file.relativePath === relativePath);
      if (!entry || !Array.isArray(entry.managedPaths)
          || !entry.managedPaths.includes('security.zerotrust.mode')) {
        throw ownershipError('The zero-trust mode is not owned by this CLI installation.');
      }
      const expectedChecksum = entry.lastCliChecksum || entry.currentChecksum;
      if (!expectedChecksum || sha256FileSync(project.appYmlPath) !== expectedChecksum) {
        throw ownershipError('application.yml changed after the last CLI transaction.');
      }

      const s = ora('...').start();
      const content = await fs.readFile(project.appYmlPath, 'utf8');

      let root;
      try {
        root = yaml.load(content);
      } catch (err) {
        s.stop();
        console.log(chalk.red('\n  x cannot parse application.yml: ' + err.message + '\n'));
        throw new Error(`Cannot parse application.yml: ${err.message}`);
      }
      if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};

      const previous = root?.contexa?.security?.zerotrust?.mode;
      if (!root.contexa || !root.contexa.security || !root.contexa.security.zerotrust) {
        s.stop();
        console.log(chalk.red('\n  x ' + t('mode.noBlock') + '\n'));
        throw new Error('The Contexa zero-trust mode block was not found.');
      }
      const previousUpper = (previous || '').toString().toUpperCase();
      if (previousUpper === targetUpper) {
        s.stop();
        console.log(chalk.gray('\n  - ' + t('mode.unchanged', targetUpper) + '\n'));
        return;
      }

      root.contexa.security.zerotrust.mode = targetUpper;
      const out = yaml.dump(root, { lineWidth: 200, noRefs: true, sortKeys: false, quotingType: '"' });
      const transactionId = await beginInstallTransaction(opts.dir, {
        lastCommand: 'mode',
      }, INSTALL_MODES.NORMAL, [{
        filePath: project.appYmlPath,
        kind: 'application-yml',
        generated: entry.generated,
        reason: 'CLI-owned zero-trust mode change',
      }]);
      try {
        await fs.writeFile(project.appYmlPath, out);
        await recordChange(opts.dir, project.appYmlPath, {
          kind: 'application-yml',
          generated: entry.generated,
          reason: 'CLI-owned zero-trust mode change',
          managedPaths: entry.managedPaths,
        }, INSTALL_MODES.NORMAL);
        await commitInstallTransaction(opts.dir, transactionId, INSTALL_MODES.NORMAL);
      } catch (error) {
        const rollback = await rollbackInstallTransaction(opts.dir, transactionId, INSTALL_MODES.NORMAL);
        if (!rollback.rolledBack) {
          throw new Error(`${error.message}; mode rollback failed: ${rollback.failures.join('; ')}`);
        }
        throw error;
      }
      s.stop();

      console.log(chalk.green('\n  v ' + t('mode.changed', previousUpper || 'unset', targetUpper) + '\n'));
    });
};
