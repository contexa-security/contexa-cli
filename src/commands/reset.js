'use strict';

// `contexa reset`: put the project back the way it was before `contexa init`.
//
// Only files the CLI changed are restored, from the backups it took; edits made afterwards are
// kept (three-way restore) and overlapping ones are reported as conflicts instead of being
// overwritten. The local PostgreSQL / Ollama services are shared with other projects, so they
// stay unless this was the last project using them and the user agrees (or --services).

const chalk = require('chalk');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const ora = require('ora');
const path = require('path');
const {
  dockerComposeDown,
  inspectDockerLabels,
  isDockerCliInstalled,
  isDockerDaemonRunning,
} = require('../core/docker');
const { t, formatError } = require('../core/i18n');
const {
  INSTALL_MODES, acquireInstallLock, backupRoot, loadManifest, manifestPath, releaseInstallLock,
  restoreExternalResources, saveManifest,
} = require('../core/manifest');
const {
  auditIssueCount, emptyAudit, performOwnedDockerCleanup, restoreProjectFiles,
} = require('../core/reset-service');
const local = require('../core/local-infra');
const { findInstallRoot } = require('./doctor');

const MODE = INSTALL_MODES.NORMAL;

const RESET_RESULTS = Object.freeze({
  SUCCESS: 'SUCCESS',
  NO_OWNED_INSTALLATION: 'NO_OWNED_INSTALLATION',
  CONFLICT: 'CONFLICT',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
});

function sanitizeAudit(audit) {
  return JSON.parse(JSON.stringify(audit).replace(
    /((?:password|secret|credential|token)\s*[:=]\s*)[^\s",}]+/gi, '$1[REDACTED]'));
}

function printAudit(audit, installRoot) {
  const labels = {
    removed: t('reset.audit.removed'),
    restored: t('reset.audit.restored'),
    preserved: t('reset.audit.preserved'),
    conflict: t('reset.audit.conflict'),
    failed: t('reset.audit.failed'),
  };
  for (const status of ['restored', 'removed', 'preserved', 'conflict', 'failed']) {
    for (const item of sanitizeAudit(audit)[status]) {
      const resource = path.isAbsolute(item.resource) ? path.relative(installRoot, item.resource) : item.resource;
      const suffix = item.detail ? ` - ${item.detail}` : '';
      const paint = ['conflict', 'failed'].includes(status) ? chalk.yellow : chalk.gray;
      console.log(paint(`    - ${labels[status]}: ${resource}${suffix}`));
    }
  }
}

// True when the folder holds nothing but empty folders (and the named files).
async function onlyEmptyFolders(dir, ignoredFiles = []) {
  if (!await fs.pathExists(dir)) return true;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!await onlyEmptyFolders(path.join(dir, entry.name))) return false;
    } else if (!ignoredFiles.includes(entry.name)) {
      return false;
    }
  }
  return true;
}

async function removeEmptyParents(file, stopDir) {
  const stop = path.resolve(stopDir);
  let dir = path.dirname(path.resolve(file));
  while (dir.startsWith(stop + path.sep) && dir !== stop) {
    if (!await fs.pathExists(dir) || (await fs.readdir(dir)).length > 0) break;
    await fs.remove(dir);
    dir = path.dirname(dir);
  }
}

// One machine-readable line for scripts and tests; terminals do not need it.
function printResetResult(result, audit) {
  if (process.stdout.isTTY && !process.env.CONTEXA_RESET_RESULT_JSON) return;
  const safeAudit = sanitizeAudit(audit);
  const counts = Object.fromEntries(Object.entries(safeAudit).map(([status, items]) => [status, items.length]));
  console.log(`CONTEXA_RESET_RESULT ${JSON.stringify({
    result,
    mode: MODE,
    changed: counts.removed + counts.restored,
    deleted: counts.removed,
    counts,
    audit: safeAudit,
  })}`);
}

// Installations made by CLI 0.1.x kept a Docker stack per project; remove it with its files.
// Containers whose ownership cannot be verified (Docker stopped, or a compose file another
// installation rewrote) are left alone and reported; that never blocks restoring the project.
async function removeLegacyProjectStack(installRoot, manifest, audit) {
  const metadata = manifest.metadata || {};
  if (!metadata.infra || metadata.infra === 'skip' || !metadata.dockerResources) return;
  const forget = async () => {
    const current = await loadManifest(installRoot, MODE);
    Object.assign(current.metadata, { infra: 'skip', dockerResources: null, composeChecksum: null, dockerLifecycleManaged: false });
    await saveManifest(installRoot, current, MODE);
  };
  const spinner = ora(t('reset.legacyStack')).start();
  try {
    const dockerAudit = await performOwnedDockerCleanup({
      contract: metadata.dockerResources,
      mode: MODE,
      installationId: metadata.installationId,
      projectName: metadata.projectName,
      infraDir: metadata.infraDir,
      composeChecksum: metadata.composeChecksum,
      env: { ...process.env, CONTEXA_PROJECT: metadata.projectName },
    }, {
      isCliInstalled: isDockerCliInstalled,
      isDaemonRunning: isDockerDaemonRunning,
      inspectLabels: inspectDockerLabels,
      composeDown: dockerComposeDown,
    });
    for (const status of Object.keys(audit)) audit[status].push(...(dockerAudit[status] || []));
    const externalAudit = await restoreExternalResources(installRoot, manifest, MODE, {
      metadataUpdates: { infra: 'skip', dockerResources: null, composeChecksum: null, dockerLifecycleManaged: false },
    });
    for (const status of Object.keys(audit)) audit[status].push(...(externalAudit[status] || []));
    spinner.succeed(t('reset.legacyStackDone'));
  } catch (error) {
    spinner.warn(t('reset.legacyStackKept', metadata.infraDir || '-'));
    audit.preserved.push({ resource: metadata.infraDir || 'docker', detail: String(error.message || error).split('\n')[0] });
    await forget();
  }
}

async function offerServiceRemoval(opts, remaining, interactive) {
  const state = await local.loadState();
  const hasServices = !!(state.postgres || (state.ollama && state.ollama.mode === 'docker'));
  if (!hasServices) return;
  if (remaining.length > 0) {
    if (opts.services) {
      console.log(chalk.yellow(`\n  ! ${t('reset.services.inUse', remaining.map(item => item.path).join(', '))}`));
    }
    return;
  }
  let remove = !!opts.services;
  if (!remove && interactive) {
    ({ remove } = await inquirer.prompt([{
      type: 'confirm', name: 'remove', message: t('reset.services.confirm'), default: false,
    }]));
  }
  if (!remove) {
    console.log(chalk.gray(`\n  ${t('reset.services.kept')}`));
    return;
  }
  const spinner = ora(t('reset.services.removing')).start();
  try {
    await local.removeLocalServices();
    spinner.succeed(t('reset.services.removed'));
  } catch (error) {
    spinner.fail(t('reset.services.failed', formatError(error)));
    process.exitCode = 1;
  }
}

async function runReset(opts) {
  const interactive = !opts.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  console.log(chalk.cyan(`\n  ${t('reset.title')}\n`));
  const installRoot = await findInstallRoot(opts.dir || process.cwd());
  const audit = emptyAudit();
  if (!installRoot) {
    console.log(chalk.gray(`  ${t('reset.nothing')}`));
    printResetResult(RESET_RESULTS.NO_OWNED_INSTALLATION, audit);
    if (opts.services) {
      const state = await local.loadState();
      await offerServiceRemoval(opts, Object.values(state.projects), interactive);
    }
    console.log('');
    return;
  }
  let manifest;
  try {
    manifest = await loadManifest(installRoot, MODE);
  } catch (error) {
    console.error(chalk.red(`  x ${formatError(error)}`));
    audit.conflict.push({ resource: manifestPath(installRoot, MODE), detail: formatError(error) });
    printResetResult(RESET_RESULTS.CONFLICT, audit);
    process.exitCode = 1;
    return;
  }

  const files = (manifest.files || []).filter(file => file.cliApplied);
  console.log(chalk.white(`  ${t('reset.plan', installRoot)}`));
  for (const file of files) console.log(chalk.gray(`    - ${file.relativePath}`));
  if (manifest.metadata && manifest.metadata.database && manifest.metadata.database.name) {
    console.log(chalk.gray(`  ${t('reset.plan.database', manifest.metadata.database.name)}`));
  }
  if (interactive) {
    const { proceed } = await inquirer.prompt([{
      type: 'confirm', name: 'proceed', message: t('reset.confirm'), default: true,
    }]);
    if (!proceed) {
      console.log(chalk.yellow(`\n  ${t('reset.cancelled')}\n`));
      return;
    }
  }

  let lock = null;
  let hadIssues = false;
  let stateDir = null;
  try {
    lock = await acquireInstallLock(installRoot, MODE, 'reset');
    await removeLegacyProjectStack(installRoot, manifest, audit);
    const spinner = ora(t('reset.restoring')).start();
    const restore = await restoreProjectFiles(installRoot, MODE);
    for (const status of Object.keys(audit)) audit[status].push(...(restore.audit[status] || []));
    if (auditIssueCount(restore.audit) > 0) {
      hadIssues = true;
      spinner.warn(t('reset.restoredWithIssues', auditIssueCount(restore.audit)));
    } else {
      spinner.succeed(t('reset.restored'));
    }

    // Folders that only held a file Contexa created (src/main/resources/config) go as well, also
    // when an interrupted reset had already removed the file and the retry finds it "original".
    const created = files
      .filter(file => file.generated || file.originalChecksum === null)
      .map(file => file.relativePath);
    if (manifest.metadata && manifest.metadata.configFile) created.push(manifest.metadata.configFile);
    for (const item of restore.audit.removed || []) created.push(item.resource);
    for (const resource of new Set(created)) {
      const target = path.resolve(installRoot, resource);
      if (!await fs.pathExists(target)) await removeEmptyParents(target, installRoot);
    }

    const finalManifest = await loadManifest(installRoot, MODE);
    finalManifest.metadata.lastReset = { at: new Date().toISOString(), result: sanitizeAudit(audit) };
    const ownsInfrastructure = finalManifest.metadata.infra && finalManifest.metadata.infra !== 'skip';
    if (finalManifest.files.length === 0 && !ownsInfrastructure) {
      const finalManifestPath = manifestPath(installRoot, MODE);
      await fs.remove(finalManifestPath);
      await fs.remove(backupRoot(installRoot, MODE));
      stateDir = path.dirname(finalManifestPath);
    } else {
      await saveManifest(installRoot, finalManifest, MODE);
    }
  } finally {
    await releaseInstallLock(lock);
  }
  // Checked after the lock file is gone: the folder held only the record and its backups.
  if (stateDir && await onlyEmptyFolders(stateDir, ['.gitignore'])) await fs.remove(stateDir);

  printAudit(audit, installRoot);
  const { remaining } = await local.unregisterProject(installRoot);
  if (hadIssues) {
    printResetResult(audit.failed.length === 0 ? RESET_RESULTS.CONFLICT : RESET_RESULTS.PARTIAL_FAILURE, audit);
    console.log(chalk.yellow(`\n  ! ${t('reset.issues')}`));
    process.exitCode = 1;
  } else {
    printResetResult(RESET_RESULTS.SUCCESS, audit);
    console.log(chalk.green(`\n  v ${t('reset.done')}`));
  }
  await offerServiceRemoval(opts, remaining, interactive);
  console.log('');
}

module.exports = function registerResetCommand(program) {
  program
    .command('reset')
    .description(t('reset.description'))
    .option('--dir <path>', t('init.option.dir'))
    .option('--services', t('reset.option.services'))
    .option('-y, --yes', t('reset.option.yes'))
    .action(runReset);
};

module.exports.RESET_RESULTS = RESET_RESULTS;
module.exports.runReset = runReset;
