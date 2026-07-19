'use strict';

// Shared constants and tiny helpers used across the injector submodules.
// Kept minimal on purpose: anything bigger belongs in its domain module
// (yml/build/compose/standalone).

const path = require('path');
const fs = require('fs-extra');
const releaseManifest = require('../../../release-manifest.json');

const CONTEXA_GROUP_ID = releaseManifest.starter.groupId;
const CONTEXA_ARTIFACT_ID = releaseManifest.starter.artifactId;
const CONTEXA_VERSION = releaseManifest.starter.version;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function backupFile(filePath, options = {}) {
  const mode = typeof options === 'string' ? options : options.mode;
  const stateSegments = mode === 'simulation'
    ? ['contexa', 'simulation', 'bak']
    : ['contexa', 'bak'];
  let currentDir = path.dirname(filePath);
  let projectRoot = null;
  
  for (let depth = 0; depth < 10; depth++) {
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
  const backupDest = path.join(projectRoot, ...stateSegments, relativePath);
  
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
