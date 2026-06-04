'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const { Option } = require('commander');
const { dockerCompose, isDockerCliInstalled } = require('../core/docker');
const { resolveProjectName, osDefaultInfraDir, resolveInfraDir } = require('../core/project');
const { t } = require('../core/i18n');

// Recursively find specific backup files in the directory, excluding node_modules and .git
function findBackupFiles(dir, filesList = []) {
  if (!fs.existsSync(dir)) return filesList;
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    
    // Skip common ignored directories
    if (file === 'node_modules' || file === '.git' || file === '.gradle' || file === '.idea' || file === 'build' || file === 'target') {
      continue;
    }
    
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      findBackupFiles(fullPath, filesList);
    } else if (file.endsWith('.bak') && (
      file === 'application.yml.bak' || 
      file === 'application.properties.bak' || 
      file === 'pom.xml.bak' || 
      file === 'build.gradle.bak' || 
      file === 'build.gradle.kts.bak'
    )) {
      filesList.push(fullPath);
    }
  }
  return filesList;
}

module.exports = function (program) {
  program
    .command('reset')
    .description(t('reset.description') || 'Reset Contexa configuration, container stack, and restore backed-up files')
    .option('--dir <path>', 'Project directory', process.cwd())
    .action(async (opts) => {
      console.log(chalk.cyan(`\n  =============================================`));
      console.log(chalk.cyan(`  ${t('reset.starting') || 'Starting Contexa Reset...'}`));
      console.log(chalk.cyan(`  =============================================\n`));

      const projectDir = path.resolve(opts.dir);
      const projectName = resolveProjectName();

      // 1. Stop and Remove Docker containers
      if (isDockerCliInstalled()) {
        const s1 = ora(t('reset.stoppingContainers') || 'Stopping and removing Docker containers...').start();
        
        // 1a. Clean simulation project (ctxa-sim)
        const simInfraDir = resolveInfraDir('ctxa-sim');
        if (fs.existsSync(path.join(simInfraDir, 'docker-compose.yml'))) {
          try {
            dockerCompose(['-p', 'ctxa-sim', 'down', '-v'], { cwd: simInfraDir, stdio: 'ignore' });
          } catch (e) {
            // Ignore down failures if container already stopped/removed
          }
        }

        // 1b. Clean default project contexa stack
        const defaultInfraDir = resolveInfraDir(projectName);
        if (fs.existsSync(path.join(defaultInfraDir, 'docker-compose.yml'))) {
          try {
            dockerCompose(['-p', projectName, 'down', '-v'], { cwd: defaultInfraDir, stdio: 'ignore' });
          } catch (e) {
            // Ignore
          }
        }
        
        s1.succeed(t('reset.stoppingContainers') || 'Docker containers stopped and removed.');
      } else {
        console.log(chalk.gray(`  i ${t('reset.noContainers') || 'Docker CLI not found. Skipping container cleanup.'}`));
      }

      // 2. Restore Backup Files (.bak)
      const s2 = ora(t('reset.restoringFiles') || 'Restoring backup files...').start();
      const backupFiles = findBackupFiles(projectDir);
      
      if (backupFiles.length > 0) {
        for (const bakFile of backupFiles) {
          const originalFile = bakFile.slice(0, -4); // Remove '.bak'
          try {
            if (fs.existsSync(bakFile)) {
              fs.copySync(bakFile, originalFile, { overwrite: true });
              fs.removeSync(bakFile);
              console.log(chalk.gray(`    - ${t('reset.restored', originalFile) || `Restored ${path.basename(originalFile)}`}`));
            }
          } catch (err) {
            console.log(chalk.red(`    x Failed to restore ${path.basename(originalFile)}: ${err.message}`));
          }
        }
        s2.succeed(t('reset.restoringFiles') || 'Backup files restored.');
      } else {
        s2.info(t('reset.noBackup') || 'No backup files found.');
      }

      // 3. Remove Standalone folder if exists
      const standalonePath = path.join(projectDir, 'contexa');
      if (fs.existsSync(standalonePath)) {
        const s3 = ora(t('reset.removingDir') || 'Removing Contexa directories...').start();
        try {
          fs.removeSync(standalonePath);
          s3.succeed(`${t('reset.restoredStandalone') || 'Removed Standalone output folder'}: ${standalonePath}`);
        } catch (err) {
          s3.fail(`Failed to remove standalone folder: ${err.message}`);
        }
      }

      // 4. Remove infrastructure cache/config directories (Contexa owned)
      const s4 = ora(t('reset.removingDir') || 'Cleaning Contexa owned cache/config...').start();
      try {
        const simCacheDir = osDefaultInfraDir('ctxa-sim');
        const defaultCacheDir = osDefaultInfraDir(projectName);
        
        if (fs.existsSync(simCacheDir)) {
          fs.removeSync(simCacheDir);
        }
        if (fs.existsSync(defaultCacheDir)) {
          fs.removeSync(defaultCacheDir);
        }
        s4.succeed(t('reset.removingDir') || 'Contexa directories cleaned.');
      } catch (err) {
        s4.fail(`Failed to clean Contexa directories: ${err.message}`);
      }

      console.log(chalk.green(`\n  v ${t('reset.success') || 'Contexa reset successfully completed.'}\n`));
    });
};
