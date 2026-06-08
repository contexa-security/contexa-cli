'use strict';

const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const yaml = require('js-yaml');
const { dockerCompose, isDockerCliInstalled } = require('../core/docker');
const { resolveProjectName, osDefaultInfraDir, resolveInfraDir } = require('../core/project');
const { detectSpringProject } = require('../core/detector');
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

// Clean up spring-boot-starter-contexa dependency from build file (gradle/maven) without relying on .bak
async function cleanupBuildFile(buildPath) {
  if (!buildPath || !fs.existsSync(buildPath)) return;
  let content = await fs.readFile(buildPath, 'utf8');
  let changed = false;

  if (buildPath.endsWith('.xml')) {
    // Maven pom.xml
    const regex = /<dependency>\s*<groupId>ai\.ctxa<\/groupId>\s*<artifactId>spring-boot-starter-contexa<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (regex.test(content)) {
      content = content.replace(regex, '');
      changed = true;
    }
  } else {
    // Gradle build.gradle / build.gradle.kts
    const regex = /\s*implementation\s*\(?\s*['"]ai\.ctxa:spring-boot-starter-contexa:[^'"]+['"]\s*\)?\s*/g;
    if (regex.test(content)) {
      content = content.replace(regex, '\n');
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(buildPath, content, 'utf8');
    console.log(chalk.gray(`    - Cleaned contexa dependency from ${path.basename(buildPath)}`));
  }
}

// Clean up 'contexa:' configuration block from application.yml without relying on .bak
async function cleanupYmlFile(ymlPath) {
  if (!ymlPath || !fs.existsSync(ymlPath)) return;
  try {
    const text = await fs.readFile(ymlPath, 'utf8');
    const rootObj = yaml.load(text);
    if (rootObj && typeof rootObj === 'object' && rootObj.contexa) {
      delete rootObj.contexa;
      
      // If the object becomes completely empty, remove the file entirely
      if (Object.keys(rootObj).length === 0) {
        await fs.remove(ymlPath);
        console.log(chalk.gray(`    - Removed empty application.yml after cleaning contexa settings`));
      } else {
        const out = yaml.dump(rootObj, { lineWidth: 200, noRefs: true, sortKeys: false, quotingType: '"' });
        await fs.writeFile(ymlPath, out, 'utf8');
        console.log(chalk.gray(`    - Cleaned contexa configuration block from application.yml`));
      }
    }
  } catch (err) {
    // Ignore parse errors on corrupted files
  }
}

module.exports = function (program) {
  program
    .command('reset')
    .description(t('reset.description') || 'Reset Contexa configuration, container stack, and restore backed-up files')
    .option('--dir <path>', 'Project directory', process.cwd())
    .option('-s, --simulate', 'Reset only simulation (ctxa-sim) Docker stack and cache')
    .option('-i, --infra', 'Reset only project-specific Docker stack')
    .option('-c, --code', 'Restore only project source code and settings from backups')
    .option('-a, --all', 'Force reset all components (code, project infra, and simulation stack)')
    .action(async (opts) => {
      console.log(chalk.cyan(`\n  =============================================`));
      console.log(chalk.cyan(`  ${t('reset.starting') || 'Starting Contexa Reset...'}`));
      console.log(chalk.cyan(`  =============================================\n`));

      const projectDir = path.resolve(opts.dir);
      const projectName = resolveProjectName();
      const project = await detectSpringProject(projectDir);

      let runSimulate = !!opts.simulate;
      let runInfra = !!opts.infra;
      let runCode = !!opts.code;
      let runAll = !!opts.all;

      // 옵션이 전혀 지정되지 않은 경우 대화형 체크박스 질문 노출
      if (!runSimulate && !runInfra && !runCode && !runAll) {
        const answers = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'targets',
            message: t('reset.prompt.targets') || 'Choose targets to reset:',
            choices: [
              { name: t('reset.target.code') || 'Restore project source code & settings from backups', value: 'code', checked: true },
              { name: t('reset.target.infra') || 'Remove project-specific Docker infrastructure', value: 'infra', checked: true },
              { name: t('reset.target.simulate') || 'Remove simulation (ctxa-sim) Docker infrastructure', value: 'simulate', checked: false }
            ]
          }
        ]);

        if (!answers.targets || answers.targets.length === 0) {
          console.log(chalk.yellow(`\n  ! ${t('reset.error.noTarget') || 'No targets selected. Aborting reset.'}`));
          console.log('');
          process.exit(0);
        }

        runCode = answers.targets.includes('code');
        runInfra = answers.targets.includes('infra');
        runSimulate = answers.targets.includes('simulate');
      } else if (runAll) {
        runCode = true;
        runInfra = true;
        runSimulate = true;
      }

      // 1. Stop and Remove Docker containers
      if (isDockerCliInstalled() && (runSimulate || runInfra)) {
        const s1 = ora(t('reset.stoppingContainers') || 'Stopping and removing Docker containers...').start();
        
        // 1a. Clean simulation project (ctxa-sim)
        if (runSimulate) {
          const simInfraDir = resolveInfraDir('ctxa-sim');
          if (fs.existsSync(path.join(simInfraDir, 'docker-compose.yml'))) {
            try {
              dockerCompose(['-p', 'ctxa-sim', 'down', '-v'], { cwd: simInfraDir, stdio: 'ignore' });
            } catch (e) {
              // Ignore down failures if container already stopped/removed
            }
          }
        }

        // 1b. Clean default project contexa stack
        if (runInfra) {
          const defaultInfraDir = resolveInfraDir(projectName);
          if (fs.existsSync(path.join(defaultInfraDir, 'docker-compose.yml'))) {
            try {
              dockerCompose(['-p', projectName, 'down', '-v'], { cwd: defaultInfraDir, stdio: 'ignore' });
            } catch (e) {
              // Ignore
            }
          }
          // 프로젝트 루트 디렉토리에서 docker-compose.yml 검색 및 종료 (디렉토리 프로젝트 자동 매핑)
          if (fs.existsSync(path.join(projectDir, 'docker-compose.yml'))) {
            try {
              dockerCompose(['down', '-v'], { cwd: projectDir, stdio: 'ignore' });
            } catch (e) {
              // Ignore
            }
          }
        }
        
        s1.succeed(t('reset.stoppingContainers') || 'Docker containers stopped and removed.');
      } else if (runSimulate || runInfra) {
        console.log(chalk.gray(`  i ${t('reset.noContainers') || 'Docker CLI not found. Skipping container cleanup.'}`));
      }

      // 2. Restore Backup Files (.bak)
      if (runCode) {
        const s2 = ora(t('reset.restoringFiles') || 'Restoring backup files...').start();
        
        // properties 기반 프로젝트에서 init으로 인해 신규 생성된 application.yml 자동 제거
        const ymlPath = path.join(projectDir, 'src/main/resources/application.yml');
        const ymlBakPath = ymlPath + '.bak';
        const propsPath = path.join(projectDir, 'src/main/resources/application.properties');
        const propsBakPath = propsPath + '.bak';

        if (fs.existsSync(ymlPath) && !fs.existsSync(ymlBakPath)) {
          if (fs.existsSync(propsPath) || fs.existsSync(propsBakPath)) {
            try {
              fs.removeSync(ymlPath);
              console.log(chalk.gray(`    - Removed newly created application.yml to restore properties-only state.`));
            } catch (err) {
              console.log(chalk.red(`    x Failed to remove application.yml: ${err.message}`));
            }
          }
        }

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

        // --- 백업본이 없어도 의존성과 설정 코드를 강제 클린업(Clean)하는 Idempotent Cleanup 단계 ---
        const buildPath = project.buildFilePath 
          || (fs.existsSync(path.join(projectDir, 'pom.xml')) ? path.join(projectDir, 'pom.xml')
             : path.join(projectDir, 'build.gradle'));

        await cleanupBuildFile(buildPath);
        if (fs.existsSync(ymlPath)) {
          await cleanupYmlFile(ymlPath);
        }
      }

      // 3. Remove Standalone folder if exists
      if (runCode) {
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
      }

      // 4. Remove infrastructure cache/config directories (Contexa owned)
      if (runSimulate || runInfra) {
        const s4 = ora(t('reset.removingDir') || 'Cleaning Contexa owned cache/config...').start();
        try {
          if (runSimulate) {
            const simCacheDir = osDefaultInfraDir('ctxa-sim');
            if (fs.existsSync(simCacheDir)) {
              fs.removeSync(simCacheDir);
            }
          }
          if (runInfra) {
            const defaultCacheDir = osDefaultInfraDir(projectName);
            if (fs.existsSync(defaultCacheDir)) {
              fs.removeSync(defaultCacheDir);
            }
          }
          s4.succeed(t('reset.removingDir') || 'Contexa directories cleaned.');
        } catch (err) {
          s4.fail(`Failed to clean Contexa directories: ${err.message}`);
        }
      }

      console.log(chalk.green(`\n  v ${t('reset.success') || 'Contexa reset successfully completed.'}\n`));
    });
};
