'use strict';

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const yaml = require('js-yaml');

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

// Clean up contexa and its auto-provisioned dependencies from build file (gradle/maven)
async function cleanupBuildFile(buildPath) {
  if (!buildPath || !fs.existsSync(buildPath)) return;
  let content = await fs.readFile(buildPath, 'utf8');
  let changed = false;

  if (buildPath.endsWith('.xml')) {
    // Maven pom.xml
    const contexaRegex = /<dependency>\s*<groupId>ai\.ctxa<\/groupId>\s*<artifactId>spring-boot-starter-contexa<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (contexaRegex.test(content)) {
      content = content.replace(contexaRegex, '');
      changed = true;
    }
    const kafkaRegex = /<dependency>\s*<groupId>org\.springframework\.kafka<\/groupId>\s*<artifactId>spring-kafka<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (kafkaRegex.test(content)) {
      content = content.replace(kafkaRegex, '');
      changed = true;
    }
    const redissonRegex = /<dependency>\s*<groupId>org\.redisson<\/groupId>\s*<artifactId>redisson<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (redissonRegex.test(content)) {
      content = content.replace(redissonRegex, '');
      changed = true;
    }
    const redisRegex = /<dependency>\s*<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot-starter-data-redis<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (redisRegex.test(content)) {
      content = content.replace(redisRegex, '');
      changed = true;
    }
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
    const aiOpenaiRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-openai<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiOpenaiRegex.test(content)) {
      content = content.replace(aiOpenaiRegex, '');
      changed = true;
    }
    const aiAnthropicRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-anthropic<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiAnthropicRegex.test(content)) {
      content = content.replace(aiAnthropicRegex, '');
      changed = true;
    }
    const aiOllamaRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-model-ollama<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiOllamaRegex.test(content)) {
      content = content.replace(aiOllamaRegex, '');
      changed = true;
    }
    const aiPgvectorRegex = /<dependency>\s*<groupId>org\.springframework\.ai<\/groupId>\s*<artifactId>spring-ai-starter-vector-store-pgvector<\/artifactId>[\s\S]*?<\/dependency>\s*/gi;
    if (aiPgvectorRegex.test(content)) {
      content = content.replace(aiPgvectorRegex, '');
      changed = true;
    }
  } else {
    // Gradle build.gradle / build.gradle.kts
    const contexaRegex = /\s*implementation\s*\(?\s*['"]ai\.ctxa:spring-boot-starter-contexa:[^'"]+['"]\s*\)?\s*/g;
    if (contexaRegex.test(content)) {
      content = content.replace(contexaRegex, '\n');
      changed = true;
    }
    const kafkaRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.kafka:spring-kafka[^'"]*['"]\s*\)?\s*/g;
    if (kafkaRegex.test(content)) {
      content = content.replace(kafkaRegex, '\n');
      changed = true;
    }
    const redissonRegex = /\s*implementation\s*\(?\s*['"]org\.redisson:redisson:[^'"]+['"]\s*\)?\s*/g;
    if (redissonRegex.test(content)) {
      content = content.replace(redissonRegex, '\n');
      changed = true;
    }
    const redisRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.boot:spring-boot-starter-data-redis[^'"]*['"]\s*\)?\s*/g;
    if (redisRegex.test(content)) {
      content = content.replace(redisRegex, '\n');
      changed = true;
    }
    const bomRegex = /\s*implementation\s*\(?\s*platform\s*\(?\s*['"]org\.springframework\.ai:spring-ai-bom:[^'"]+['"]\s*\)?\s*\)?\s*/g;
    if (bomRegex.test(content)) {
      content = content.replace(bomRegex, '\n');
      changed = true;
    }
    const aiOpenaiRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-openai[^'"]*['"]\s*\)?\s*/g;
    if (aiOpenaiRegex.test(content)) {
      content = content.replace(aiOpenaiRegex, '\n');
      changed = true;
    }
    const aiAnthropicRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-anthropic[^'"]*['"]\s*\)?\s*/g;
    if (aiAnthropicRegex.test(content)) {
      content = content.replace(aiAnthropicRegex, '\n');
      changed = true;
    }
    const aiOllamaRegex = /\s*implementation\s*\(?\s*['"]org\.springframework\.ai:spring-ai-starter-model-ollama[^'"]*['"]\s*\)?\s*/g;
    if (aiOllamaRegex.test(content)) {
      content = content.replace(aiOllamaRegex, '\n');
      changed = true;
    }
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

// Clean up 'contexa:' configuration block from application.yml
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

// Recursively find backup files inside backups directory
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

module.exports = {
  deleteIfMatch,
  cleanupBuildFile,
  cleanupYmlFile,
  cleanupJavaFiles,
  findBackupFiles
};
