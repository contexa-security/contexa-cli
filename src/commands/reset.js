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

// Recursively find backup files inside .contexa/backups/ returning relative paths
function findBackupFiles(backupsDir, currentDir = backupsDir, filesList = []) {
  if (!fs.existsSync(currentDir)) return filesList;
  
  const files = fs.readdirSync(currentDir);
  for (const file of files) {
    const fullPath = path.join(currentDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      findBackupFiles(backupsDir, fullPath, filesList);
    } else {
      const relative = path.relative(backupsDir, fullPath);
      filesList.push({
        backupPath: fullPath,
        relativePath: relative
      });
    }
  }
  return filesList;
}

// Helper to delete nested object properties and clean up empty parent objects recursively
function deleteIfMatch(obj, pathArr, matchFn) {
  let cur = obj;
  const pathStack = [];
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) return;
    pathStack.push({ parent: cur, key: k });
    cur = cur[k];
  }
  const lastKey = pathArr[pathArr.length - 1];
  if (cur[lastKey] !== undefined && (!matchFn || matchFn(cur[lastKey]))) {
    delete cur[lastKey];
  }
  // Clean up empty parent objects backwards
  for (let i = pathStack.length - 1; i >= 0; i--) {
    const node = pathStack[i];
    const parentObj = node.parent[node.key];
    if (Object.keys(parentObj).length === 0) {
      delete node.parent[node.key];
    }
  }
}

// Clean up contexa and its auto-provisioned dependencies from build file (gradle/maven) without relying on .bak
async function cleanupBuildFile(buildPath) {
  if (!buildPath || !fs.existsSync(buildPath)) return;
  let content = await fs.readFile(buildPath, 'utf8');
  let changed = false;

  if (buildPath.endsWith('.xml')) {
    // Maven pom.xml
    // 1. spring-boot-starter-contexa
    const contexaRegex = /<dependency>\s*<groupId>ai\.ctxa<\/groupId>\s*<artifactId>spring-boot-starter-contexa<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (contexaRegex.test(content)) {
      content = content.replace(contexaRegex, '');
      changed = true;
    }
    // 2. spring-kafka
    const kafkaRegex = /<dependency>\s*<groupId>org\.springframework\.kafka<\/groupId>\s*<artifactId>spring-kafka<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (kafkaRegex.test(content)) {
      content = content.replace(kafkaRegex, '');
      changed = true;
    }
    // 3. redisson
    const redissonRegex = /<dependency>\s*<groupId>org\.redisson<\/groupId>\s*<artifactId>redisson<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (redissonRegex.test(content)) {
      content = content.replace(redissonRegex, '');
      changed = true;
    }
    // 4. spring-boot-starter-data-redis
    const redisRegex = /<dependency>\s*<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot-starter-data-redis<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (redisRegex.test(content)) {
      content = content.replace(redisRegex, '');
      changed = true;
    }
    // 5. spring-ai-bom
    const bomRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-bom<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (bomRegex.test(content)) {
      content = content.replace(bomRegex, '');
      changed = true;
    }
    const emptyMgmtRegex = /<dependencyManagement>\s*<dependencies>\s*<\/dependencies>\s*<\/dependencyManagement>\s*/gi;
    if (emptyMgmtRegex.test(content)) {
      content = content.replace(emptyMgmtRegex, '');
      changed = true;
    }
    // 6. spring-ai-starter-model-openai
    const aiOpenaiRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-openai<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiOpenaiRegex.test(content)) {
      content = content.replace(aiOpenaiRegex, '');
      changed = true;
    }
    // 7. spring-ai-starter-model-anthropic
    const aiAnthropicRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-anthropic<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiAnthropicRegex.test(content)) {
      content = content.replace(aiAnthropicRegex, '');
      changed = true;
    }
    // 8. spring-ai-starter-model-ollama
    const aiOllamaRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-ollama<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiOllamaRegex.test(content)) {
      content = content.replace(aiOllamaRegex, '');
      changed = true;
    }
    // 9. spring-ai-starter-vector-store-pgvector
    const aiPgvectorRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-vector-store-pgvector<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiPgvectorRegex.test(content)) {
      content = content.replace(aiPgvectorRegex, '');
      changed = true;
    }
  } else {
    // Gradle build.gradle / build.gradle.kts
    // 1. spring-boot-starter-contexa
    const contexaRegex = /\s*implementation\s*\(?\s*['"]ai\.ctxa:spring-boot-starter-contexa:[^'"]+['"]\s*\)?\s*/g;
    if (contexaRegex.test(content)) {
      content = content.replace(contexaRegex, '\n');
      changed = true;
    }
    // 2. spring-kafka
    const kafkaRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.kafka:spring-kafka[^'"]*['"]\s*\)?\s*/g;
    if (kafkaRegex.test(content)) {
      content = content.replace(kafkaRegex, '\n');
      changed = true;
    }
    // 3. redisson
    const redissonRegex = /\s*implementation\s*\(?\s*['"]org\.redisson:redisson:[^'"]+['"]\s*\)?\s*/g;
    if (redissonRegex.test(content)) {
      content = content.replace(redissonRegex, '\n');
      changed = true;
    }
    // 4. spring-boot-starter-data-redis
    const redisRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.boot:spring-boot-starter-data-redis[^'"]*['"]\s*\)?\s*/g;
    if (redisRegex.test(content)) {
      content = content.replace(redisRegex, '\n');
      changed = true;
    }
    // 5. spring-ai-bom
    const bomRegex = /\s*implementation\s*\(?\s*platform\s*\(?\s*['"]org\.springframework\.ai:spring-ai-bom:[^'"]+['"]\s*\)?\s*\)?\s*/g;
    if (bomRegex.test(content)) {
      content = content.replace(bomRegex, '\n');
      changed = true;
    }
    // 6. spring-ai-starter-model-openai
    const aiOpenaiRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-openai[^'"]*['"]\s*\)?\s*/g;
    if (aiOpenaiRegex.test(content)) {
      content = content.replace(aiOpenaiRegex, '\n');
      changed = true;
    }
    // 7. spring-ai-starter-model-anthropic
    const aiAnthropicRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-anthropic[^'"]*['"]\s*\)?\s*/g;
    if (aiAnthropicRegex.test(content)) {
      content = content.replace(aiAnthropicRegex, '\n');
      changed = true;
    }
    // 8. spring-ai-starter-model-ollama
    const aiOllamaRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-ollama[^'"]*['"]\s*\)?\s*/g;
    if (aiOllamaRegex.test(content)) {
      content = content.replace(aiOllamaRegex, '\n');
      changed = true;
    }
    // 9. spring-ai-starter-vector-store-pgvector
    const aiPgvectorRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-vector-store-pgvector[^'"]*['"]\s*\)?\s*/g;
    if (aiPgvectorRegex.test(content)) {
      content = content.replace(aiPgvectorRegex, '\n');
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(buildPath, content, 'utf8');
    console.log(chalk.gray(`    - Cleaned contexa and its auto-provisioned dependencies from ${path.basename(buildPath)}`));
  }
}

// Clean up 'contexa:' configuration block from application.yml without relying on .bak
async function cleanupYmlFile(ymlPath) {
  if (!ymlPath || !fs.existsSync(ymlPath)) return;
  try {
    const text = await fs.readFile(ymlPath, 'utf8');
    const rootObj = yaml.load(text);
    if (rootObj && typeof rootObj === 'object') {
      let changed = false;

      if (rootObj.contexa) {
        delete rootObj.contexa;
        changed = true;
      }

      // Cleanup spring.data.redis configurations injected by contexa
      if (rootObj.spring && rootObj.spring.data && rootObj.spring.data.redis) {
        const redis = rootObj.spring.data.redis;
        const host = String(redis.host || '').toLowerCase();
        const port = String(redis.port || '');
        if (
          host.includes('localhost') || 
          host.includes('contexa') || 
          port === '6379' || 
          port === '26379' || 
          port.includes('CONTEXA_REDIS_PORT')
        ) {
          delete rootObj.spring.data.redis;
          if (Object.keys(rootObj.spring.data).length === 0) {
            delete rootObj.spring.data;
          }
          changed = true;
        }
      }

      // Cleanup spring.kafka configurations injected by contexa
      if (rootObj.spring && rootObj.spring.kafka) {
        const kafka = rootObj.spring.kafka;
        const servers = String(kafka['bootstrap-servers'] || '');
        if (
          servers.includes('localhost:9092') ||
          servers.includes('localhost:29092') ||
          servers.includes('CONTEXA_KAFKA_SERVERS')
        ) {
          delete rootObj.spring.kafka;
          changed = true;
        }
      }

      // Cleanup spring.ai configurations injected by contexa
      if (rootObj.spring && rootObj.spring.ai) {
        delete rootObj.spring.ai;
        changed = true;
      }



      // Cleanup management.metrics.enable.lettuce configurations injected by contexa
      if (rootObj.management && rootObj.management.metrics) {
        deleteIfMatch(rootObj, ['management', 'metrics', 'enable', 'lettuce'], val => val === false);
        if (rootObj.management.prometheus && rootObj.management.prometheus.metrics) {
          deleteIfMatch(rootObj, ['management', 'prometheus', 'metrics', 'export', 'exemplars', 'enabled'], val => val === false);
        }
        if (rootObj.management.metrics.enable && Object.keys(rootObj.management.metrics.enable).length === 0) {
          delete rootObj.management.metrics.enable;
        }
        if (Object.keys(rootObj.management.metrics).length === 0) {
          delete rootObj.management.metrics;
        }
        if (rootObj.management.prometheus && rootObj.management.prometheus.metrics && Object.keys(rootObj.management.prometheus.metrics).length === 0) {
          delete rootObj.management.prometheus.metrics;
        }
        if (rootObj.management.prometheus && Object.keys(rootObj.management.prometheus).length === 0) {
          delete rootObj.management.prometheus;
        }
        changed = true;
      }

      // Cleanup empty top-level spring or management keys
      if (rootObj.spring && Object.keys(rootObj.spring).length === 0) {
        delete rootObj.spring;
        changed = true;
      }
      if (rootObj.management && Object.keys(rootObj.management).length === 0) {
        delete rootObj.management;
        changed = true;
      }

      if (changed) {
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
    }
  } catch (err) {
    // Ignore parse errors on corrupted files
  }
}
// Clean up @EnableAISecurity annotation and its imports from java source files
async function cleanupJavaFiles(projectDir) {
  const javaDir = path.join(projectDir, 'src/main/java');
  if (!fs.existsSync(javaDir)) return;

  async function walk(dir) {
    const list = await fs.readdir(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await walk(fullPath);
      } else if (file.endsWith('.java')) {
        let content = await fs.readFile(fullPath, 'utf8');
        let changed = false;

        const importRegex = /import\s+io\.contexa\.[\w.]*EnableAISecurity\s*;\r?\n?/g;
        if (importRegex.test(content)) {
          content = content.replace(importRegex, '');
          changed = true;
        }

        const annotationRegex = /@EnableAISecurity(\s*\([^)]*\))?\r?\n?/g;
        if (annotationRegex.test(content)) {
          content = content.replace(annotationRegex, '');
          changed = true;
        }

        if (changed) {
          await fs.writeFile(fullPath, content, 'utf8');
          console.log(chalk.gray(`    - Removed @EnableAISecurity and imports from ${path.basename(fullPath)}`));
        }
      }
    }
  }

  try {
    await walk(javaDir);
  } catch (err) {
    // Ignore walk errors
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
