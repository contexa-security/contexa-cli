'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const { spawnSync } = require('child_process');
const { dockerCompose, isDockerCliInstalled } = require('../core/docker');
const { resolveProjectName, resolveInfraDir } = require('../core/project');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');

const { findBackupFiles } = require('../core/cleanup');
const { loadManifest, manifestPath } = require('../core/manifest');

const COMPOSE_SERVICES = ['postgres', 'ollama', 'redis', 'zookeeper', 'kafka'];
const COMPOSE_VOLUMES = ['pgdata', 'ollama-data', 'redis-data', 'zookeeper-data', 'kafka-data'];

function dockerTry(args, opts = {}) {
  try {
    return spawnSync('docker', args, { ...opts, shell: false });
  } catch (error) {
    return { error, status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(error.message || '') };
  }
}

function collectDockerNames(args) {
  const result = dockerTry(args);
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .toString()
    .split(/\r?\n/)
    .map(name => name.trim())
    .filter(Boolean);
}

function forceCleanupComposeProject(projectName) {
  if (!projectName) return;

  const containers = new Set(collectDockerNames([
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
    '--format',
    '{{.Names}}'
  ]));
  for (const service of COMPOSE_SERVICES) {
    containers.add(`${projectName}-${service}`);
  }
  for (const name of containers) {
    dockerTry(['rm', '-f', name], { stdio: 'ignore' });
  }

  const volumes = new Set(collectDockerNames([
    'volume',
    'ls',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
    '--format',
    '{{.Name}}'
  ]));
  for (const volume of COMPOSE_VOLUMES) {
    volumes.add(`${projectName}_${volume}`);
  }
  for (const name of volumes) {
    dockerTry(['volume', 'rm', '-f', name], { stdio: 'ignore' });
  }
}

async function ensureComposeForDown(infraDir) {
  if (fs.existsSync(path.join(infraDir, 'docker-compose.yml'))) return;
  const { generateDockerCompose } = require('../core/injector/compose');
  await generateDockerCompose(infraDir, { infra: 'distributed', includeOllama: true });
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
  await ensureComposeForDown(infraDir);
  const result = dockerCompose(['-p', projectName, 'down', '-v'], { cwd: infraDir, stdio: 'pipe', env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : 'Unknown error';
    throw new Error(`${projectName} down failed: ${stderr.trim()}`);
  }
}

function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.removeSync(dir);
  }
}

async function restoreProjectFiles(projectDir) {
  const backupsDir = path.join(projectDir, 'contexa', 'bak');
  const manifest = await loadManifest(projectDir);
  const manifestFiles = Array.isArray(manifest.files) ? manifest.files : [];

  if (manifestFiles.length > 0) {
    const sorted = [...manifestFiles].sort((a, b) => {
      if (a.relativePath === 'contexa') return 1;
      if (b.relativePath === 'contexa') return -1;
      return b.relativePath.length - a.relativePath.length;
    });

    for (const entry of sorted) {
      const originalFile = path.join(projectDir, entry.relativePath);
      const backupPath = path.join(backupsDir, entry.relativePath);
      if (fs.existsSync(backupPath)) {
        fs.ensureDirSync(path.dirname(originalFile));
        fs.copySync(backupPath, originalFile, { overwrite: true });
        console.log(chalk.gray(`    - ${t('reset.restored', originalFile) || `Restored ${path.basename(originalFile)}`}`));
      } else if (entry.generated && fs.existsSync(originalFile)) {
        fs.removeSync(originalFile);
        console.log(chalk.gray(`    - Removed CLI-generated file: ${originalFile}`));
      }
    }

    const mPath = manifestPath(projectDir);
    if (fs.existsSync(mPath)) fs.removeSync(mPath);
    if (fs.existsSync(backupsDir)) fs.removeSync(backupsDir);
    const parentContexa = path.join(projectDir, 'contexa');
    if (fs.existsSync(parentContexa)) removeIfEmpty(parentContexa);
    return;
  }

  const backupFiles = fs.existsSync(backupsDir) ? findBackupFiles(backupsDir) : [];
  if (backupFiles.length > 0) {
    for (const item of backupFiles) {
      const originalFile = path.join(projectDir, item.relativePath);
      fs.ensureDirSync(path.dirname(originalFile));
      fs.copySync(item.backupPath, originalFile, { overwrite: true });
      console.log(chalk.gray(`    - ${t('reset.restored', originalFile) || `Restored ${path.basename(originalFile)}`}`));
    }
    fs.removeSync(backupsDir);
    const parentContexa = path.join(projectDir, 'contexa');
    if (fs.existsSync(parentContexa)) removeIfEmpty(parentContexa);
    return;
  }

  console.log(chalk.yellow(`    - ${t('reset.noBackup') || 'No manifest or backup files found; project source files were not modified.'}`));
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
        process.exit(0);
      }

      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('reset.starting') || 'Starting Contexa Reset...'}`));
      console.log(chalk.cyan('  =============================================\n'));

      const projectDir = path.resolve(opts.dir);
      const projectName = resolveProjectName();
      let targets = resolveTargets(opts);
      let dockerFailed = false;

      if (!hasAnyTarget(targets)) {
        if (opts.yes) {
          targets.infra = true;
          targets.code = true;
          console.log(chalk.cyan('  i Reset target: project infrastructure and project file restore. Use --simulate for the ctxa-sim flow.'));
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
            process.exit(0);
          }

          targets = {
            infra: answer.targets.includes('infra'),
            simulate: answer.targets.includes('simulate'),
            code: answer.targets.includes('code')
          };
        }
      }

      if (isDockerCliInstalled() && (targets.simulate || targets.infra)) {
        const spinner = ora(t('reset.stoppingContainers') || 'Stopping and removing Docker containers...').start();
        const errors = [];

        if (targets.simulate) {
          const simInfraDir = resolveInfraDir('ctxa-sim', { infraDir: opts.infraDir });
          try {
            await composeDown('ctxa-sim', simInfraDir, simulateComposeEnv());
          } catch (error) {
            errors.push(error.message);
          }
        }

        if (targets.infra) {
          const infraDir = resolveInfraDir(projectName, { infraDir: opts.infraDir });
          try {
            await composeDown(projectName, infraDir, composeEnv(projectName));
          } catch (error) {
            errors.push(error.message);
          }
        }

        if (errors.length > 0) {
          dockerFailed = true;
          spinner.fail(`Docker cleanup failed:\n${errors.join('\n')}`);
        } else {
          if (targets.simulate) forceCleanupComposeProject('ctxa-sim');
          if (targets.infra) forceCleanupComposeProject(projectName);
          spinner.succeed(t('reset.stoppingContainers') || 'Docker containers stopped and removed.');
        }
      } else if (targets.simulate || targets.infra) {
        console.log(chalk.gray(`  i ${t('reset.noContainers') || 'Docker CLI not found. Skipping container cleanup.'}`));
      }

      if (targets.code) {
        const spinner = ora(t('reset.restoringFiles') || 'Restoring backup files...').start();
        try {
          await restoreProjectFiles(projectDir);
          spinner.succeed(t('reset.restoringFiles') || 'Backup files restored.');
        } catch (error) {
          spinner.fail(`Project file restore failed: ${error.message}`);
          process.exit(1);
        }
      }

      if ((targets.simulate || targets.infra) && !dockerFailed) {
        const spinner = ora(t('reset.removingDir') || 'Cleaning Contexa owned cache/config...').start();
        try {
          if (targets.simulate) {
            const simCacheDir = resolveInfraDir('ctxa-sim', { infraDir: opts.infraDir });
            if (fs.existsSync(simCacheDir)) fs.removeSync(simCacheDir);
          }
          if (targets.infra) {
            const infraCacheDir = resolveInfraDir(projectName, { infraDir: opts.infraDir });
            if (fs.existsSync(infraCacheDir)) fs.removeSync(infraCacheDir);
          }
          spinner.succeed(t('reset.removingDir') || 'Contexa directories cleaned.');
        } catch (error) {
          spinner.fail(`Failed to clean Contexa directories: ${error.message}`);
        }
      }

      console.log(chalk.green(`\n  v ${t('reset.success') || 'Contexa reset successfully completed.'}\n`));
    });
};
