'use strict';

// Shared constants and tiny helpers used across the injector submodules.
// Kept minimal on purpose: anything bigger belongs in its domain module
// (yml/build/compose/initdb/standalone).

const path = require('path');
const fs = require('fs-extra');

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';
const CONTEXA_VERSION = '0.1.0';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function backupFile(filePath) {
  let currentDir = path.dirname(filePath);
  let projectRoot = null;
  
  for (let depth = 0; depth < 5; depth++) {
    if (await fs.pathExists(path.join(currentDir, 'build.gradle')) ||
        await fs.pathExists(path.join(currentDir, 'build.gradle.kts')) ||
        await fs.pathExists(path.join(currentDir, 'pom.xml')) ||
        await fs.pathExists(path.join(currentDir, 'settings.gradle'))) {
      projectRoot = currentDir;
      break;
    }
    const parent = path.resolve(currentDir, '..');
    if (parent === currentDir) break;
    currentDir = parent;
  }
  
  if (!projectRoot) {
    projectRoot = path.dirname(filePath);
  }

  const relativePath = path.relative(projectRoot, filePath);
  const backupDest = path.join(projectRoot, 'contexa', 'bak', relativePath);
  
  // Preserve the initial clean state. If backup already exists, do not overwrite it.
  if (await fs.pathExists(backupDest)) {
    return;
  }
  
  await fs.ensureDir(path.dirname(backupDest));
  await fs.copy(filePath, backupDest, { overwrite: false });
}

module.exports = {
  CONTEXA_GROUP_ID,
  CONTEXA_ARTIFACT_ID,
  CONTEXA_VERSION,
  escapeRegex,
  backupFile,
};
