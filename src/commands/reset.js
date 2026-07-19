'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const { spawnSync } = require('child_process');
const { dockerCompose, isDockerCliInstalled, isDockerDaemonRunning } = require('../core/docker');
const { t } = require('../core/i18n');
const {
  INSTALL_MODES, backupRoot, loadManifest, manifestPath, saveManifest,
} = require('../core/manifest');
const {
  auditIssueCount, emptyAudit, performOwnedDockerCleanup, restoreProjectFiles,
} = require('../core/reset-service');

function dockerTry(args, opts = {}) {
  try {
    return spawnSync('docker', args, { ...opts, shell: false });
  } catch (error) {
    return { error, status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message || '') };
  }
}

function inspectDockerLabels(type, name) {
  const args = type === 'container'
    ? ['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}', name]
    : [type, 'inspect', '--format', '{{json .Labels}}', name];
  const result = dockerTry(args, { stdio: 'pipe' });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout.toString().trim() || '{}') || {};
  } catch {
    throw new Error(`Docker ${type} labels are unreadable: ${name}`);
  }
}

function assertExactInfraDir(expectedInfraDir, requestedInfraDir) {
  if (!expectedInfraDir) throw new Error('The ownership manifest does not contain an infrastructure directory.');
  const expected = path.resolve(expectedInfraDir);
  if (requestedInfraDir && path.resolve(requestedInfraDir) !== expected) {
    throw new Error(`--infra-dir does not match the manifest-owned directory: ${expected}`);
  }
  if (fs.existsSync(expected) && fs.lstatSync(expected).isSymbolicLink()) {
    throw new Error(`Infrastructure directory must not be a symbolic link: ${expected}`);
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

function simulateComposeEnv() {
  return composeEnv('ctxa-sim', {
    CONTEXA_POSTGRES_PORT: process.env.CONTEXA_POSTGRES_PORT || '25432',
    CONTEXA_OLLAMA_PORT: process.env.CONTEXA_OLLAMA_PORT || '31434',
    CONTEXA_REDIS_PORT: process.env.CONTEXA_REDIS_PORT || '26379',
    CONTEXA_ZOOKEEPER_PORT: process.env.CONTEXA_ZOOKEEPER_PORT || '22181',
    CONTEXA_KAFKA_PORT: process.env.CONTEXA_KAFKA_PORT || '29092',
    CONTEXA_DB_NAME: process.env.CONTEXA_DB_NAME || 'contexa_sim',
    CONTEXA_DB_USERNAME: process.env.CONTEXA_DB_USERNAME || 'contexa_sim',
    CONTEXA_DB_PASSWORD: process.env.CONTEXA_DB_PASSWORD || 'contexa_sim_pw'
  });
}

async function composeDown(projectName, infraDir, env) {
  const result = dockerCompose(['-p', projectName, 'down', '-v'], { cwd: infraDir, stdio: 'pipe', env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : 'Unknown error';
    throw new Error(`${projectName} down failed: ${stderr.trim()}`);
  }
  return { skipped: false };
}

function mergeAudit(target, source) {
  for (const status of Object.keys(target)) target[status].push(...(source[status] || []));
}

function printAudit(audit) {
  console.log(chalk.cyan('  Reset audit'));
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
  console.log(chalk.cyan('  Reset plan'));
  if (targets.simulate) {
    console.log(chalk.gray('    - Simulation Docker stack: ctxa-sim containers and volumes only'));
    console.log(chalk.gray(`      compose dir: ${details.simInfraDir}`));
  }
  if (targets.infra) {
    console.log(chalk.gray(`    - Project Docker stack: ${details.projectName} containers and volumes`));
    console.log(chalk.gray(`      compose dir: ${details.infraDir}`));
  }
  if (targets.code) {
    console.log(chalk.gray('    - Project files: restore only CLI-tracked changes from contexa/manifest.json backups'));
    console.log(chalk.gray('      later user changes are preserved by 3-way restore; overlapping edits are reported as conflicts'));
  }
  if (targets.simulate && !targets.infra) {
    console.log(chalk.gray('    - Production/project Docker stack is not targeted by --simulate'));
  }
  console.log('');
}

module.exports = function (program) {
  program
    .command('reset')
    .description(t('reset.description') || 'Reset Contexa infrastructure; use --simulate for the isolated ctxa-sim stack')
    .option('--dir <path>', 'Project directory', process.cwd())
    .option('--infra-dir <path>', 'Override the contexa-owned infrastructure directory')
    .option('-s, --simulate', 'Reset simulation (ctxa-sim) Docker stack/cache and restore project files')
    .option('-i, --infra', 'Reset only project-specific Docker stack')
    .option('-c, --code', 'Restore only project source code and settings from backups')
    .option('-a, --all', 'Force reset all components (code, project infra, and simulation stack)')
    .option('-y, --yes', 'Skip prompts, use defaults')
    .action(async (opts) => {
      let proceed = !!opts.yes;
      if (!proceed) {
        const answer = await inquirer.prompt([{
          type: 'confirm',
          name: 'proceed',
          message: 'Run reset for the selected Contexa target? Use --simulate for the ctxa-sim flow.',
          default: false
        }]);
        proceed = answer.proceed;
      }

      if (!proceed) {
        console.log(chalk.yellow('\n  ! Reset cancelled.'));
        console.log('');
        return;
      }

      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('reset.starting') || 'Starting Contexa Reset...'}`));
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

      if (!hasAnyTarget(targets)) {
        if (opts.yes) {
          targets.code = true;
          targets.infra = hasOwnedManifest && resetManifest.metadata.infra && resetManifest.metadata.infra !== 'skip';
          console.log(chalk.cyan(targets.infra
            ? '  i Reset target: manifest-owned project infrastructure and project file restore.'
            : '  i Reset target: manifest-owned project file restore only.'));
        } else {
          const answer = await inquirer.prompt([{
            type: 'checkbox',
            name: 'targets',
            message: t('reset.prompt.targets') || 'Choose targets to reset:',
            choices: [
              { name: t('reset.target.infra') || 'Remove project-specific Docker infrastructure', value: 'infra', checked: true },
              { name: t('reset.target.simulate') || 'Remove simulation (ctxa-sim) Docker infrastructure', value: 'simulate', checked: false },
              { name: t('reset.target.code') || 'Restore project source code & settings from backups', value: 'code', checked: true }
            ]
          }]);

          if (!answer.targets || answer.targets.length === 0) {
            console.log(chalk.yellow(`\n  ! ${t('reset.error.noTarget') || 'No targets selected. Aborting reset.'}`));
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

      if (!hasOwnedManifest && (targets.infra || targets.simulate)) {
        console.log(chalk.yellow('  i No matching Contexa ownership manifest exists. No infrastructure or volume was changed.'));
        return;
      }
      if (!hasOwnedManifest && targets.code) {
        console.log(chalk.yellow('  i No matching Contexa ownership manifest exists. No project file was changed.'));
        return;
      }
      if ((targets.infra || targets.simulate) && !projectName) {
        throw new Error('The ownership manifest does not contain a project name; infrastructure reset was refused.');
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
      });

      if (targets.simulate || targets.infra) {
        const spinner = ora(t('reset.stoppingContainers') || 'Stopping and removing Docker containers...').start();
        const ownedInfraDir = planSimInfraDir || planInfraDir;
        try {
          const dockerAudit = await performOwnedDockerCleanup({
            contract: resetManifest.metadata && resetManifest.metadata.dockerResources,
            mode: installMode,
            installationId: resetManifest.metadata.installationId,
            projectName,
            infraDir: ownedInfraDir,
            composeChecksum: resetManifest.metadata && resetManifest.metadata.composeChecksum,
            env: installMode === INSTALL_MODES.SIMULATION ? simulateComposeEnv() : composeEnv(projectName),
          }, {
            isCliInstalled: isDockerCliInstalled,
            isDaemonRunning: isDockerDaemonRunning,
            inspectLabels: inspectDockerLabels,
            composeDown,
          });
          mergeAudit(resetAudit, dockerAudit);
          infraCompleted = true;
          spinner.succeed(t('reset.stoppingContainers') || 'Docker containers stopped and removed.');
        } catch (error) {
          resetHadIssues = true;
          resetAudit.failed.push({ resource: 'docker', detail: error.message });
          spinner.fail(`Docker cleanup failed: ${error.message}`);
        }
      }

      if (targets.code) {
        const spinner = ora(t('reset.restoringFiles') || 'Restoring backup files...').start();
        try {
          const restoreResult = await restoreProjectFiles(projectDir, installMode);
          mergeAudit(resetAudit, restoreResult.audit);
          if (auditIssueCount(restoreResult.audit) > 0) {
            resetHadIssues = true;
            spinner.warn(`Project file restore has ${auditIssueCount(restoreResult.audit)} conflict or failed item(s).`);
          } else {
            spinner.succeed(t('reset.restoringFiles') || 'Backup files restored.');
          }
        } catch (error) {
          spinner.fail(`Project file restore failed: ${error.message}`);
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
        console.log(chalk.yellow(`\n  ! Contexa reset completed with issues. Review the messages above before re-running.\n`));
        process.exitCode = 1;
      } else {
        console.log(chalk.green(`\n  v ${t('reset.success') || 'Contexa reset successfully completed.'}\n`));
      }
    });
};
