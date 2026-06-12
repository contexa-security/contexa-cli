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

const {
  cleanupBuildFile,
  cleanupYmlFile,
  cleanupJavaFiles,
  findBackupFiles
} = require('../core/cleanup');

const { spawnSync } = require('child_process');

function forceCleanupByPattern(pattern) {
  if (!pattern) return;
  // 1. Find and remove containers matching the pattern
  try {
    const ps = spawnSync('docker', ['ps', '-a', '--filter', `name=${pattern}`, '--format', '{{.Names}}'], { shell: false });
    if (ps.status === 0 && ps.stdout) {
      const names = ps.stdout.toString().split(/\r?\n/).map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        if (name.includes(pattern)) {
          spawnSync('docker', ['rm', '-f', name], { shell: false });
        }
      }
    }
  } catch (e) {
    // Ignore
  }

  // 2. Find and remove volumes matching the pattern
  try {
    const vol = spawnSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { shell: false });
    if (vol.status === 0 && vol.stdout) {
      const names = vol.stdout.toString().split(/\r?\n/).map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        if (name.includes(pattern)) {
          spawnSync('docker', ['volume', 'rm', '-f', name], { shell: false });
        }
      }
    }
  } catch (e) {
    // Ignore
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
    .option('-y, --yes', 'Skip prompts, use defaults')
    .action(async (opts) => {
      let proceed = false;
      if (opts.yes) {
        proceed = true;
      } else {
        const confirmAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: 'reset 명령어 실행 시 설치 전 상태로 모두 초기화 됩니다. 진행하시겠습니까?',
            default: false
          }
        ]);
        proceed = confirmAnswer.proceed;
      }

      if (!proceed) {
        console.log(chalk.yellow('\n  ! 작업을 취소했습니다.'));
        console.log('');
        process.exit(0);
      }

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
      let dockerFailed = false;

      // contexa reset --simulate가 명시되면 contexa init --simulate의 완벽한 대칭형 리셋으로 동작하도록
      // 코드 설정 초기화(runCode)를 함께 활성화합니다.
      if (runSimulate && !runCode && !runInfra && !runAll) {
        runCode = true;
      }

      // 옵션이 전혀 지정되지 않은 경우
      if (!runSimulate && !runInfra && !runCode && !runAll) {
        if (opts.yes) {
          // 비대화형 옵션이 주어졌을 경우 프로젝트를 분석하여 안전하게 감지된 대상을 초기화합니다.
          runCode = true;
          
          let isSimulateProject = false;
          const ymlPath = path.join(projectDir, 'src/main/resources/application.yml');
          if (fs.existsSync(ymlPath)) {
            try {
              const content = fs.readFileSync(ymlPath, 'utf8');
              const rootObj = yaml.load(content);
              if (rootObj && typeof rootObj === 'object') {
                const dbUrl = (rootObj.contexa && rootObj.contexa.datasource && rootObj.contexa.datasource.url) || '';
                const dbUsername = (rootObj.contexa && rootObj.contexa.datasource && rootObj.contexa.datasource.username) || '';
                if (dbUrl.includes('25432') || dbUrl.includes('contexa_sim') || dbUsername === 'contexa_sim') {
                  isSimulateProject = true;
                }
                const springDbUrl = (rootObj.spring && rootObj.spring.datasource && rootObj.spring.datasource.url) || '';
                const springDbUsername = (rootObj.spring && rootObj.spring.datasource && rootObj.spring.datasource.username) || '';
                if (springDbUrl.includes('25432') || springDbUrl.includes('contexa_sim') || springDbUsername === 'contexa_sim') {
                  isSimulateProject = true;
                }
                const redisPort = (rootObj.spring && rootObj.spring.data && rootObj.spring.data.redis && rootObj.spring.data.redis.port) || '';
                if (redisPort.toString().includes('26379')) {
                  isSimulateProject = true;
                }
              }
            } catch (e) {
              // Ignore
            }
          }

          if (isSimulateProject) {
            runSimulate = true;
            runInfra = false;
            console.log(chalk.yellow('  i 시뮬레이션 설정이 감지되었습니다. 시뮬레이션 인프라(ctxa-sim)만 리셋합니다.'));
          } else {
            runSimulate = false;
            runInfra = true;
            console.log(chalk.cyan('  i 일반 환경 설정이 감지되었습니다. 일반 인프라만 리셋합니다.'));
          }
        } else {
          // 대화형 일반 모드인 경우 사용자가 선택할 수 있는 체크박스를 띄웁니다.
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
        }
      } else if (runAll) {
        runCode = true;
        runInfra = true;
        runSimulate = true;
      }

      // 1. Stop and Remove Docker containers
      if (isDockerCliInstalled() && (runSimulate || runInfra)) {
        const s1 = ora(t('reset.stoppingContainers') || 'Stopping and removing Docker containers...').start();
        let dockerErrorMessage = '';
        
        // 1a. Clean simulation project (ctxa-sim)
        if (runSimulate) {
          const simInfraDir = resolveInfraDir('ctxa-sim');
          // If the compose file doesn't exist, temporarily recreate it to allow down -v to clean up orphaned volumes
          if (!fs.existsSync(path.join(simInfraDir, 'docker-compose.yml'))) {
            try {
              const { generateDockerCompose } = require('../core/injector/compose');
              await generateDockerCompose(simInfraDir, { infra: 'distributed', includeOllama: true });
            } catch (err) {
              // Ignore generation error and attempt down anyway
            }
          }
          try {
            const result = dockerCompose(['-p', 'ctxa-sim', 'down', '-v'], { cwd: simInfraDir, stdio: 'pipe' });
            if (result.status !== 0) {
              dockerFailed = true;
              dockerErrorMessage += `ctxa-sim down failed: ${result.stderr ? result.stderr.toString() : 'Unknown error'}\n`;
            }
          } catch (e) {
            dockerFailed = true;
            dockerErrorMessage += `ctxa-sim down execution error: ${e.message}\n`;
          }
        }

        // 1b. Clean default project contexa stack
        if (runInfra) {
          const defaultInfraDir = resolveInfraDir(projectName);
          // If the compose file doesn't exist, temporarily recreate it to allow down -v to clean up orphaned volumes
          if (!fs.existsSync(path.join(defaultInfraDir, 'docker-compose.yml'))) {
            try {
              const { generateDockerCompose } = require('../core/injector/compose');
              await generateDockerCompose(defaultInfraDir, { infra: 'distributed', includeOllama: true });
            } catch (err) {
              // Ignore
            }
          }
          try {
            const result = dockerCompose(['-p', projectName, 'down', '-v'], { cwd: defaultInfraDir, stdio: 'pipe' });
            if (result.status !== 0) {
              dockerFailed = true;
              dockerErrorMessage += `${projectName} down failed: ${result.stderr ? result.stderr.toString() : 'Unknown error'}\n`;
            }
          } catch (e) {
            dockerFailed = true;
            dockerErrorMessage += `${projectName} down execution error: ${e.message}\n`;
          }
          // 프로젝트 루트 디렉토리에서 docker-compose.yml 검색 및 종료 (디렉토리 프로젝트 자동 매핑)
          if (fs.existsSync(path.join(projectDir, 'docker-compose.yml'))) {
            try {
              const result = dockerCompose(['down', '-v'], { cwd: projectDir, stdio: 'pipe' });
              if (result.status !== 0) {
                dockerFailed = true;
                dockerErrorMessage += `project root compose down failed: ${result.stderr ? result.stderr.toString() : 'Unknown error'}\n`;
              }
            } catch (e) {
              dockerFailed = true;
              dockerErrorMessage += `project root compose down execution error: ${e.message}\n`;
            }
          }
        }
        
        if (dockerFailed) {
          s1.fail(`Docker cleanup failed:\n${dockerErrorMessage}`);
        } else {
          // Fallback force cleanup of leftover/orphaned containers and volumes
          if (runSimulate) {
            forceCleanupByPattern('ctxa-sim');
          }
          if (runInfra) {
            forceCleanupByPattern('contexa');
            if (projectName !== 'contexa') {
              forceCleanupByPattern(projectName);
            }
          }
          s1.succeed(t('reset.stoppingContainers') || 'Docker containers stopped and removed.');
        }
      } else if (runSimulate || runInfra) {
        console.log(chalk.gray(`  i ${t('reset.noContainers') || 'Docker CLI not found. Skipping container cleanup.'}`));
      }

      // 2. Restore Backup Files (.bak)
      if (runCode) {
        const s2 = ora(t('reset.restoringFiles') || 'Restoring backup files...').start();
        
        // properties 기반 프로젝트에서 init으로 인해 신규 생성된 application.yml 자동 제거
        const ymlPath = path.join(projectDir, 'src/main/resources/application.yml');
        const backupsDir = path.join(projectDir, 'contexa', 'bak');
        const ymlBackupPath = path.join(backupsDir, 'src/main/resources/application.yml');
        const propsPath = path.join(projectDir, 'src/main/resources/application.properties');
        const propsBackupPath = path.join(backupsDir, 'src/main/resources/application.properties');

        if (fs.existsSync(ymlPath) && !fs.existsSync(ymlBackupPath)) {
          if (fs.existsSync(propsPath) || fs.existsSync(propsBackupPath)) {
            try {
              fs.removeSync(ymlPath);
              console.log(chalk.gray(`    - Removed newly created application.yml to restore properties-only state.`));
            } catch (err) {
              console.log(chalk.red(`    x Failed to remove application.yml: ${err.message}`));
            }
          }
        }

        const backupFiles = fs.existsSync(backupsDir) ? findBackupFiles(backupsDir) : [];
        const restoredOriginals = new Set();
        
        if (backupFiles.length > 0) {
          for (const item of backupFiles) {
            const originalFile = path.join(projectDir, item.relativePath);
            try {
              fs.copySync(item.backupPath, originalFile, { overwrite: true });
              restoredOriginals.add(path.resolve(originalFile));
              console.log(chalk.gray(`    - ${t('reset.restored', originalFile) || `Restored ${path.basename(originalFile)}`}`));
            } catch (err) {
              console.log(chalk.red(`    x Failed to restore ${path.basename(originalFile)}: ${err.message}`));
            }
          }
          // Clean up the backups directory
          try {
            fs.removeSync(backupsDir);
            const parentContexa = path.join(projectDir, 'contexa');
            if (fs.existsSync(parentContexa) && fs.readdirSync(parentContexa).length === 0) {
              fs.removeSync(parentContexa);
            }
          } catch (e) {
            // Ignore
          }
          s2.succeed(t('reset.restoringFiles') || 'Backup files restored.');
        } else {
          s2.info(t('reset.noBackup') || 'No backup files found.');
        }

        // --- 백업본이 없어도 의존성과 설정 코드를 강제 클린업(Clean)하는 Idempotent Cleanup 단계 ---
        const buildPath = project.buildFilePath 
          || (fs.existsSync(path.join(projectDir, 'pom.xml')) ? path.join(projectDir, 'pom.xml')
             : path.join(projectDir, 'build.gradle'));

        // Clean up any sibling .bak files
        try {
          const siblingBaks = [
            ymlPath + '.bak',
            propsPath + '.bak',
            buildPath + '.bak'
          ];
          for (const siblingBak of siblingBaks) {
            if (fs.existsSync(siblingBak)) {
              fs.removeSync(siblingBak);
            }
          }
        } catch (e) {
          // Ignore
        }

        if (buildPath && !restoredOriginals.has(path.resolve(buildPath))) {
          await cleanupBuildFile(buildPath);
        }
        if (fs.existsSync(ymlPath) && !restoredOriginals.has(path.resolve(ymlPath))) {
          await cleanupYmlFile(ymlPath);
        }
        await cleanupJavaFiles(projectDir);
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

        // Remove provisioned GeoLite2-City.mmdb and data folder
        const targetMmdbPath = path.join(projectDir, 'contexa', 'data', 'GeoLite2-City.mmdb');
        if (fs.existsSync(targetMmdbPath)) {
          try {
            fs.removeSync(targetMmdbPath);
            const dataDir = path.join(projectDir, 'contexa', 'data');
            if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) {
              fs.removeSync(dataDir);
            }
            const parentContexa = path.join(projectDir, 'contexa');
            if (fs.existsSync(parentContexa) && fs.readdirSync(parentContexa).length === 0) {
              fs.removeSync(parentContexa);
            }
            console.log(chalk.gray(`    - Removed provisioned GeoLite2-City.mmdb and empty data directory.`));
          } catch (err) {
            console.log(chalk.red(`    x Failed to remove mmdb: ${err.message}`));
          }
        }
      }

      // 4. Remove infrastructure cache/config directories (Contexa owned)
      if ((runSimulate || runInfra) && !dockerFailed) {
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
