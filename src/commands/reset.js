'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const { dockerCompose, dockerTry, isDockerCliInstalled, isDockerDaemonRunning } = require('../core/docker');
const { t } = require('../core/i18n');
const {
  INSTALL_MODES, backupRoot, loadManifest, manifestPath, saveManifest,
} = require('../core/manifest');
const {
  auditIssueCount, emptyAudit, performOwnedDockerCleanup, restoreProjectFiles,
} = require('../core/reset-service');
const { simulationEnvironment } = require('../core/simulation');
const { TIMEOUTS } = require('../core/timeouts');

function inspectDockerLabels(type, name) {
  const args = type === 'container'
    ? ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', name]
    : [type, 'inspect', '--format', '{{json .Labels}}', name];
  const result = dockerTry(args, { stdio: 'pipe' });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.toString().trim() || '{}') || {};
  } catch {
    const error = new Error(`RESET_LABELS_UNREADABLE ${t('reset.error.labelsUnreadable', type, name)}`);
    error.code = 'RESET_LABELS_UNREADABLE';
    throw error;
  }
}

function assertExactInfraDir(expectedInfraDir, requestedInfraDir) {
  if (!expectedInfraDir) {
    const error = new Error(`RESET_INFRA_DIR_MISSING ${t('reset.error.infraDirMissing')}`);
    error.code = 'RESET_INFRA_DIR_MISSING';
    throw error;
  }
  const expected = path.resolve(expectedInfraDir);
  if (requestedInfraDir && path.resolve(requestedInfraDir) !== expected) {
    const error = new Error(`RESET_INFRA_DIR_MISMATCH ${t('reset.error.infraDirMismatch', expected)}`);
    error.code = 'RESET_INFRA_DIR_MISMATCH';
    throw error;
  }
  if (fs.existsSync(expected) && fs.lstatSync(expected).isSymbolicLink()) {
    const error = new Error(`RESET_INFRA_DIR_SYMLINK ${t('reset.error.infraDirSymlink', expected)}`);
    error.code = 'RESET_INFRA_DIR_SYMLINK';
    throw error;
  }
  return expected;
}

function composeEnv(projectName, extra = {}) {
  return {
    ...process.env,
    CONTEXA_PROJECT: projectName,
    ...extra
  };
}

function simulateComposeEnv(installationId) {
  return simulationEnvironment(process.env, installationId);
}

async function composeDown(projectName, infraDir, env) {
  const result = dockerCompose(['-p', projectName, 'down', '-v', '--timeout', '0'], {
    cwd: infraDir, stdio: 'pipe', env, timeout: TIMEOUTS.dockerComposeRollbackMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : 'Unknown error';
    const error = new Error(`RESET_DOCKER_DOWN_FAILED ${t('reset.error.downFailed', projectName, stderr.trim())}`);
    error.code = 'RESET_DOCKER_DOWN_FAILED';
    throw error;
  }
  return { skipped: false };
}

function mergeAudit(target, source) {
  for (const status of Object.keys(target)) target[status].push(...(source[status] || []));
}

function printAudit(audit) {
  console.log(chalk.cyan(`  ${t('reset.audit.title')}`));
  for (const status of ['removed', 'restored', 'preserved', 'conflict', 'failed']) {
    for (const item of audit[status]) {
      const suffix = item.detail ? ` - ${item.detail}` : '';
      console.log(chalk.gray(`    - ${status}: ${item.resource}${suffix}`));
    }
  }
}

function resolveTargets(opts) {
  const targets = {
    simulate: !!opts.simulate,
    infra: !!opts.infra,
    code: !!opts.code
  };

  if (opts.simulate) {
    targets.code = true;
  }

  if (opts.all) {
    targets.simulate = true;
    targets.infra = true;
    targets.code = true;
  }

  return targets;
}

function hasAnyTarget(targets) {
  return targets.simulate || targets.infra || targets.code;
}
function printResetPlan(targets, details) {
  console.log(chalk.cyan(`  ${t('reset.plan.title')}`));
  if (targets.simulate) {
    console.log(chalk.gray(`    - ${t('reset.plan.simulation')}`));
    console.log(chalk.gray(`      ${t('reset.plan.composeDir', details.simInfraDir)}`));
  }
  if (targets.infra) {
    console.log(chalk.gray(`    - ${t('reset.plan.infrastructure', details.projectName)}`));
    console.log(chalk.gray(`      ${t('reset.plan.composeDir', details.infraDir)}`));
  }
  if (targets.code) {
    console.log(chalk.gray(details.simulationMode
      ? `    - ${t('reset.plan.simulationCode')}`
      : `    - ${t('reset.plan.projectCode')}`));
    console.log(chalk.gray(`      ${t('reset.plan.threeWay')}`));
  }
  if (details.simulationMode && !targets.infra) {
    console.log(chalk.gray(`    - ${t('reset.plan.productionPreserved')}`));
  }
  console.log('');
}

module.exports = function (program) {
  program
    .command('reset')
    .description(t('reset.description'))
    .option('--dir <path>', t('reset.option.dir'), process.cwd())
    .option('--infra-dir <path>', t('reset.option.infraDir'))
    .option('-s, --simulate', t('reset.option.simulate'))
    .option('-i, --infra', t('reset.option.infra'))
    .option('-c, --code', t('reset.option.code'))
    .option('-a, --all', t('reset.option.all'))
    .option('-y, --yes', t('reset.option.yes'))
    .action(async (opts) => {
      let proceed = !!opts.yes;
      if (!proceed) {
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'proceed',
          message: t('reset.prompt.confirm'),
          default: false
        }]);
        proceed = answer.proceed;
      }

      if (!proceed) {
        console.log(chalk.yellow(`\n  ! ${t('reset.cancelled')}`));
        console.log('');
        return;
      }

      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('reset.starting')}`));
      console.log(chalk.cyan('  =============================================\n'));

      const projectDir = path.resolve(opts.dir);
      const installMode = opts.simulate ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
      const resetManifestPath = manifestPath(projectDir, installMode);
      const hasOwnedManifest = fs.existsSync(resetManifestPath);
      const resetManifest = await loadManifest(projectDir, installMode);
      const projectName = resetManifest.metadata && resetManifest.metadata.projectName;
      let targets = resolveTargets(opts);
      let resetHadIssues = false;
      let infraCompleted = false;
      const resetAudit = emptyAudit();
      const ownsManifestInfrastructure = Boolean(
        resetManifest.metadata.infra && resetManifest.metadata.infra !== 'skip');

      if (!hasAnyTarget(targets)) {
        if (opts.yes) {
          targets.code = true;
          targets.infra = hasOwnedManifest && resetManifest.metadata.infra && resetManifest.metadata.infra !== 'skip';
          console.log(chalk.cyan(targets.infra
            ? `  i ${t('reset.target.autoInfraCode')}`
            : `  i ${t('reset.target.autoCode')}`));
        } else {
          const answer = await inquirer.prompt([{
            type: 'checkbox',
            name: 'targets',
            message: t('reset.prompt.targets'),
            choices: [
              { name: t('reset.target.infra'), value: 'infra', checked: true },
              { name: t('reset.target.simulate'), value: 'simulate', checked: false },
              { name: t('reset.target.code'), value: 'code', checked: true }
            ]
          }]);

          if (!answer.targets || answer.targets.length === 0) {
            console.log(chalk.yellow(`\n  ! ${t('reset.error.noTarget')}`));
            console.log('');
            return;
          }

          targets = {
            infra: answer.targets.includes('infra'),
            simulate: answer.targets.includes('simulate'),
            code: answer.targets.includes('code')
          };
        }
      }

      const dockerLifecycleManaged = resetManifest.metadata.dockerLifecycleManaged !== false;
      if (installMode === INSTALL_MODES.SIMULATION
          && (!ownsManifestInfrastructure || !dockerLifecycleManaged)) {
        targets.simulate = false;
        infraCompleted = true;
      }

      if (!hasOwnedManifest && (targets.infra || targets.simulate)) {
        console.log(chalk.yellow(`  i ${t('reset.noManifest.infrastructure')}`));
        return;
      }
      if (!hasOwnedManifest && targets.code) {
        console.log(chalk.yellow(`  i ${t('reset.noManifest.code')}`));
        return;
      }
      if ((targets.infra || targets.simulate) && !projectName) {
        const error = new Error(`RESET_PROJECT_NAME_MISSING ${t('reset.error.projectNameMissing')}`);
        error.code = 'RESET_PROJECT_NAME_MISSING';
        throw error;
      }

      const manifestInfraDir = resetManifest.metadata && resetManifest.metadata.infraDir;
      const planSimInfraDir = targets.simulate
        ? assertExactInfraDir(manifestInfraDir, opts.infraDir) : null;
      const planInfraDir = targets.infra
        ? assertExactInfraDir(manifestInfraDir, opts.infraDir) : null;
      printResetPlan(targets, {
        projectName,
        simInfraDir: planSimInfraDir,
        infraDir: planInfraDir,
        simulationMode: installMode === INSTALL_MODES.SIMULATION,
      });

      if (targets.simulate || targets.infra) {
        const spinner = ora(t('reset.stoppingContainers')).start();
        const ownedInfraDir = planSimInfraDir || planInfraDir;
        try {
          const dockerAudit = await performOwnedDockerCleanup({
            contract: resetManifest.metadata && resetManifest.metadata.dockerResources,
            mode: installMode,
            installationId: resetManifest.metadata.installationId,
            projectName,
            infraDir: ownedInfraDir,
            composeChecksum: resetManifest.metadata && resetManifest.metadata.composeChecksum,
            env: installMode === INSTALL_MODES.SIMULATION
              ? simulateComposeEnv(resetManifest.metadata.installationId)
              : composeEnv(projectName),
          }, {
            isCliInstalled: isDockerCliInstalled,
            isDaemonRunning: isDockerDaemonRunning,
            inspectLabels: inspectDockerLabels,
            composeDown,
          });
          mergeAudit(resetAudit, dockerAudit);
          infraCompleted = true;
          spinner.succeed(t('reset.dockerRemoved'));
        } catch (error) {
          resetHadIssues = true;
          resetAudit.failed.push({ resource: 'docker', detail: error.message });
          spinner.fail(t('reset.error.dockerCleanup', error.message));
        }
      }

      if ((targets.simulate || targets.infra) && !infraCompleted) {
        resetAudit.preserved.push({
          resource: installMode === INSTALL_MODES.SIMULATION
            ? 'simulation project files and ownership manifest'
            : 'project files and ownership manifest',
          detail: 'Docker cleanup did not complete; no project-managed state was changed.',
        });
        printAudit(resetAudit);
        console.log(chalk.yellow(`\n  ! ${t('reset.safeStop')}\n`));
        process.exitCode = 1;
        return;
      }

      if (targets.code) {
        const spinner = ora(t('reset.restoringFiles')).start();
        try {
          const restoreResult = await restoreProjectFiles(projectDir, installMode);
          mergeAudit(resetAudit, restoreResult.audit);
          if (auditIssueCount(restoreResult.audit) > 0) {
            resetHadIssues = true;
            spinner.warn(t('reset.restoreIssues', auditIssueCount(restoreResult.audit)));
          } else {
            spinner.succeed(t('reset.filesRestored'));
          }
        } catch (error) {
          spinner.fail(t('reset.error.restore', error.message));
          throw error;
        }
      }

      const finalManifest = await loadManifest(projectDir, installMode);
      if (infraCompleted) {
        finalManifest.metadata.infra = 'skip';
        finalManifest.metadata.dockerResources = null;
        finalManifest.metadata.composeChecksum = null;
      }
      const safeAudit = JSON.parse(JSON.stringify(resetAudit).replace(
        /((?:password|secret|credential|token)\s*[:=]\s*)[^\s",}]+/gi, '$1[REDACTED]'));
      finalManifest.metadata.lastReset = { at: new Date().toISOString(), result: safeAudit };
      const ownsInfrastructure = finalManifest.metadata.infra && finalManifest.metadata.infra !== 'skip';
      if (finalManifest.files.length === 0 && !ownsInfrastructure) {
        const finalManifestPath = manifestPath(projectDir, installMode);
        if (fs.existsSync(finalManifestPath)) fs.removeSync(finalManifestPath);
        const backups = backupRoot(projectDir, installMode);
        if (fs.existsSync(backups)) fs.removeSync(backups);
        const stateDir = path.dirname(finalManifestPath);
        if (fs.existsSync(stateDir) && fs.readdirSync(stateDir).length === 0) fs.removeSync(stateDir);
      } else {
        await saveManifest(projectDir, finalManifest, installMode);
      }

      printAudit(resetAudit);

      if (resetHadIssues) {
        console.log(chalk.yellow(`\n  ! ${t('reset.completedWithIssues')}\n`));
        process.exitCode = 1;
      } else {
        console.log(chalk.green(`\n  v ${t('reset.success')}\n`));
      }
    });
};
