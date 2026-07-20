'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const { Option } = require('commander');
const {
  dockerComposeDown,
  inspectDockerLabels,
  isDockerCliInstalled,
  isDockerDaemonRunning,
} = require('../core/docker');
const { t, formatError } = require('../core/i18n');
const {
  INSTALL_MODES, backupRoot, loadManifest, manifestPath, restoreExternalResources, saveManifest,
} = require('../core/manifest');
const {
  auditIssueCount, emptyAudit, performOwnedDockerCleanup, restoreProjectFiles,
} = require('../core/reset-service');
const { simulationEnvironment } = require('../core/simulation');
const { TIMEOUTS } = require('../core/timeouts');
const { assertSafeInfraDir } = require('../core/project');

const RESET_RESULTS = Object.freeze({
  SUCCESS: 'SUCCESS',
  NO_OWNED_INSTALLATION: 'NO_OWNED_INSTALLATION',
  CONFLICT: 'CONFLICT',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
});

function assertExactInfraDir(expectedInfraDir, requestedInfraDir) {
  if (!expectedInfraDir) {
    const error = new Error(`RESET_INFRA_DIR_MISSING ${t('reset.error.infraDirMissing')}`);
    error.code = 'RESET_INFRA_DIR_MISSING';
    error.messageKey = 'reset.error.infraDirMissing';
    error.messageArgs = [];
    throw error;
  }
  const expected = path.resolve(expectedInfraDir);
  if (requestedInfraDir && path.resolve(requestedInfraDir) !== expected) {
    const error = new Error(`RESET_INFRA_DIR_MISMATCH ${t('reset.error.infraDirMismatch', expected)}`);
    error.code = 'RESET_INFRA_DIR_MISMATCH';
    error.messageKey = 'reset.error.infraDirMismatch';
    error.messageArgs = [expected];
    throw error;
  }
  if (fs.existsSync(expected) && fs.lstatSync(expected).isSymbolicLink()) {
    const error = new Error(`RESET_INFRA_DIR_SYMLINK ${t('reset.error.infraDirSymlink', expected)}`);
    error.code = 'RESET_INFRA_DIR_SYMLINK';
    error.messageKey = 'reset.error.infraDirSymlink';
    error.messageArgs = [expected];
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

function mergeAudit(target, source) {
  for (const status of Object.keys(target)) {
    const resources = new Set(target[status].map(item => item.resource));
    for (const item of source[status] || []) {
      if (resources.has(item.resource)) continue;
      target[status].push(item);
      resources.add(item.resource);
    }
  }
}

function printAudit(audit) {
  const displayAudit = sanitizeAudit(audit);
  console.log(chalk.cyan(`  ${t('reset.audit.title')}`));
  for (const status of ['removed', 'restored', 'preserved', 'conflict', 'failed']) {
    for (const item of displayAudit[status]) {
      const suffix = item.detail ? ` - ${item.detail}` : '';
      console.log(chalk.gray(`    - ${status}: ${item.resource}${suffix}`));
    }
  }
}

function sanitizeAudit(audit) {
  return JSON.parse(JSON.stringify(audit).replace(
    /((?:password|secret|credential|token)\s*[:=]\s*)[^\s",}]+/gi, '$1[REDACTED]'));
}

function printResetResult(result, mode, audit, dockerCalls) {
  const safeAudit = sanitizeAudit(audit);
  const counts = Object.fromEntries(Object.entries(safeAudit)
    .map(([status, items]) => [status, items.length]));
  console.log(`CONTEXA_RESET_RESULT ${JSON.stringify({
    result,
    mode,
    changed: counts.removed + counts.restored,
    deleted: counts.removed,
    dockerCalls,
    counts,
    audit: safeAudit,
  })}`);
}

function issueResult(audit) {
  return audit.failed.length === 0 && audit.conflict.length > 0
    ? RESET_RESULTS.CONFLICT : RESET_RESULTS.PARTIAL_FAILURE;
}

function resolveTargets(opts) {
  const targets = {
    simulate: !!opts.simulate,
    infra: !opts.simulate && !!opts.infra,
    code: !!opts.code
  };

  if (opts.simulate) {
    targets.code = true;
  }

  if (opts.all) {
    targets.simulate = !!opts.simulate;
    targets.infra = !opts.simulate;
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
    .option('-s, --simulate', t('reset.option.simulate'))
    .addOption(new Option('--infra-dir <path>', t('reset.option.infraDir')).hideHelp())
    .addOption(new Option('-i, --infra', t('reset.option.infra')).hideHelp())
    .addOption(new Option('-c, --code', t('reset.option.code')).hideHelp())
    .addOption(new Option('-a, --all', t('reset.option.all')).hideHelp())
    .option('-y, --yes', t('reset.option.yes'))
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('reset.starting')}`));
      console.log(chalk.cyan('  =============================================\n'));

      const projectDir = path.resolve(opts.dir);
      const installMode = opts.simulate ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
      const resetManifestPath = manifestPath(projectDir, installMode);
      const hasOwnedManifest = fs.existsSync(resetManifestPath);
      const resetAudit = emptyAudit();
      let dockerCalls = 0;
      let resetManifest;
      try {
        resetManifest = await loadManifest(projectDir, installMode);
      } catch (error) {
    resetAudit.conflict.push({ resource: resetManifestPath, detail: formatError(error) });
        printAudit(resetAudit);
        printResetResult(RESET_RESULTS.CONFLICT, installMode, resetAudit, dockerCalls);
        process.exitCode = 1;
        return;
      }
      if (!hasOwnedManifest) {
        console.log(chalk.yellow(`  i ${t('reset.noManifest.code')}`));
        printAudit(resetAudit);
        printResetResult(RESET_RESULTS.NO_OWNED_INSTALLATION, installMode, resetAudit, dockerCalls);
        return;
      }
      const projectName = resetManifest.metadata && resetManifest.metadata.projectName;
      let targets = resolveTargets(opts);
      let resetHadIssues = false;
      let infraCompleted = false;
      const ownsManifestInfrastructure = Boolean(
        resetManifest.metadata.infra && resetManifest.metadata.infra !== 'skip');

      if (!hasAnyTarget(targets)) {
        targets.code = true;
        targets.infra = hasOwnedManifest
          && resetManifest.metadata.infra
          && resetManifest.metadata.infra !== 'skip';
        console.log(chalk.cyan(targets.infra
          ? `  i ${t('reset.target.autoInfraCode')}`
          : `  i ${t('reset.target.autoCode')}`));
      }

      const dockerLifecycleManaged = resetManifest.metadata.dockerLifecycleManaged !== false;
      if (installMode === INSTALL_MODES.SIMULATION
          && (!ownsManifestInfrastructure || !dockerLifecycleManaged)) {
        targets.simulate = false;
        infraCompleted = true;
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
      if (planSimInfraDir) {
        await assertSafeInfraDir(opts.dir, planSimInfraDir, opts.infraDir);
      }
      if (planInfraDir && planInfraDir !== planSimInfraDir) {
        await assertSafeInfraDir(opts.dir, planInfraDir, opts.infraDir);
      }
      printResetPlan(targets, {
        projectName,
        simInfraDir: planSimInfraDir,
        infraDir: planInfraDir,
        simulationMode: installMode === INSTALL_MODES.SIMULATION,
      });

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

      if (targets.simulate || targets.infra) {
        const spinner = ora(t('reset.stoppingContainers')).start();
        const ownedInfraDir = planSimInfraDir || planInfraDir;
        try {
          dockerCalls += 1;
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
            composeDown: dockerComposeDown,
          });
          mergeAudit(resetAudit, dockerAudit);
          const externalAudit = await restoreExternalResources(
            projectDir,
            resetManifest,
            installMode,
            {
              metadataUpdates: {
                infra: 'skip',
                dockerResources: null,
                composeChecksum: null,
              },
            }
          );
          mergeAudit(resetAudit, externalAudit);
          infraCompleted = true;
          spinner.succeed(t('reset.dockerRemoved'));
        } catch (error) {
          resetHadIssues = true;
        resetAudit.failed.push({ resource: 'docker', detail: formatError(error) });
        spinner.fail(t('reset.error.dockerCleanup', formatError(error)));
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
        printResetResult(RESET_RESULTS.PARTIAL_FAILURE, installMode, resetAudit, dockerCalls);
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
        spinner.fail(t('reset.error.restore', formatError(error)));
          throw error;
        }
      }

      const finalManifest = await loadManifest(projectDir, installMode);
      if (infraCompleted) {
        finalManifest.metadata.infra = 'skip';
        finalManifest.metadata.dockerResources = null;
        finalManifest.metadata.composeChecksum = null;
      }
      const safeAudit = sanitizeAudit(resetAudit);
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
        printResetResult(issueResult(resetAudit), installMode, resetAudit, dockerCalls);
        console.log(chalk.yellow(`\n  ! ${t('reset.completedWithIssues')}\n`));
        process.exitCode = 1;
      } else {
        printResetResult(RESET_RESULTS.SUCCESS, installMode, resetAudit, dockerCalls);
        console.log(chalk.green(`\n  v ${t('reset.success')}\n`));
      }
    });
};

module.exports.RESET_RESULTS = RESET_RESULTS;
module.exports.resolveTargets = resolveTargets;
