'use strict';

const chalk = require('chalk');
const { spawnSync } = require('child_process');
const { isDockerCliInstalled, isDockerDaemonRunning } = require('./docker');
const { t } = require('./i18n');
const { TIMEOUTS } = require('./timeouts');

function diagnosticError() {
  const error = new Error(`PREINSTALL_CHECK_FAILED ${t('init.diagnostic.failed')}`);
  error.code = 'PREINSTALL_CHECK_FAILED';
  return error;
}

function runPreinstallationChecks(opts) {
  if (!opts.check && opts.yes) return false;

  console.log(chalk.cyan(`\n  [${t('init.diagnostic.title')}]`));
  let passed = true;
  try {
    const javaResult = spawnSync('java', ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: TIMEOUTS.javaCommandProbeMs,
    });
    if (javaResult.error || javaResult.status !== 0) throw javaResult.error || new Error('java -version failed');
    const javaOutput = `${javaResult.stdout || ''}\n${javaResult.stderr || ''}`;
    const match = javaOutput.match(/version "(.*?)"/);
    const version = match ? match[1] : 'unknown';
    const supported = version.startsWith('17') || parseInt(version.split('.')[0], 10) >= 17;
    if (!supported) {
      passed = false;
      console.log(chalk.red(`  x ${t('init.diagnostic.javaUnsupported', version)}`));
      console.log(chalk.gray(`    -> ${t('init.diagnostic.javaFix')}`));
    }
  } catch {
    passed = false;
    console.log(chalk.red(`  x ${t('init.diagnostic.javaMissing')}`));
    console.log(chalk.gray(`    -> ${t('init.diagnostic.javaMissingFix')}`));
  }

  const needsDocker = !!(opts.distributed || opts.simulate);
  if (needsDocker) {
    const cliAvailable = isDockerCliInstalled();
    const daemonAvailable = cliAvailable && isDockerDaemonRunning();
    if (!cliAvailable) {
      passed = false;
      console.log(chalk.red(`  x ${t('init.diagnostic.dockerMissing')}`));
      console.log(chalk.gray(`    -> ${t('init.diagnostic.dockerInstall')}`));
    } else if (!daemonAvailable) {
      passed = false;
      console.log(chalk.red(`  x ${t('init.diagnostic.dockerStopped')}`));
      console.log(chalk.gray(`    -> ${t('init.diagnostic.dockerStart')}`));
    }
  } else {
    console.log(chalk.gray(`  - ${t('init.diagnostic.dockerSkipped')}`));
  }

  if (!passed) {
    console.log(chalk.yellow(`\n  ! ${t('init.diagnostic.failed')}`));
    console.log(chalk.yellow(`    ${t('init.diagnostic.doctorHint')}`));
    if (opts.check) throw diagnosticError();
  } else {
    console.log(chalk.green(`  v ${t('init.diagnostic.passed')}`));
    if (opts.check) {
      console.log(chalk.green(`\n  v ${t('init.diagnostic.success')}\n`));
      return true;
    }
  }
  console.log('');
  return false;
}

module.exports = { runPreinstallationChecks };
