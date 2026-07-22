'use strict';

// Shared constants and tiny helpers used across the injector submodules.
// Kept minimal on purpose: anything bigger belongs in its domain module
// (yml/build/compose/standalone).

const path = require('path');
const fs = require('fs-extra');
const releaseManifest = require('../../../release-manifest.json');
const { backupRoot, INSTALL_MODES } = require('../manifest');

const CONTEXA_GROUP_ID = releaseManifest.starter.groupId;
const CONTEXA_ARTIFACT_ID = releaseManifest.starter.artifactId;
const CONTEXA_VERSION = releaseManifest.starter.version;
const DEPENDENCY_VERSION_DEFAULTS = Object.freeze({
  ...releaseManifest.dependencyVersions,
});
const DEPENDENCY_VERSION_ENV = Object.freeze({
  springAiBom: 'CONTEXA_SPRING_AI_VERSION',
  redisson: 'CONTEXA_REDISSON_VERSION',
  springStateMachine: 'CONTEXA_SPRING_STATEMACHINE_VERSION',
});
const DEPENDENCY_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SPRING_AI_PROVIDER_ARTIFACTS = Object.freeze({
  openai: 'spring-ai-starter-model-openai',
  anthropic: 'spring-ai-starter-model-anthropic',
  ollama: 'spring-ai-starter-model-ollama',
});

function resolveDependencyVersions(overrides = {}, environment = process.env) {
  const resolved = {};
  for (const [name, fallback] of Object.entries(DEPENDENCY_VERSION_DEFAULTS)) {
    const environmentName = DEPENDENCY_VERSION_ENV[name];
    const candidate = overrides[name] || environment[environmentName] || fallback;
    if (!DEPENDENCY_VERSION_PATTERN.test(String(candidate))) {
      const error = new Error(
        `INVALID_DEPENDENCY_VERSION ${environmentName} has an unsupported value.`
      );
      error.code = 'INVALID_DEPENDENCY_VERSION';
      error.messageKey = 'common.invalidDependencyVersion';
      error.messageArgs = [environmentName];
      throw error;
    }
    resolved[name] = String(candidate);
  }
  return Object.freeze(resolved);
}

function springAiProviderArtifacts(providers = []) {
  return [...new Set(providers)]
    .filter(provider => Object.hasOwn(SPRING_AI_PROVIDER_ARTIFACTS, provider))
    .map(provider => SPRING_AI_PROVIDER_ARTIFACTS[provider]);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function backupFile(filePath, options = {}) {
  const mode = typeof options === 'string' ? options : options.mode;
  const installMode = mode === INSTALL_MODES.SIMULATION
    ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
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
  const backupDest = path.join(backupRoot(projectRoot, installMode), relativePath);
  
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
  DEPENDENCY_VERSION_DEFAULTS,
  resolveDependencyVersions,
  springAiProviderArtifacts,
  escapeRegex,
  backupFile,
};
