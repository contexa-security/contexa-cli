'use strict';

// Shared constants and tiny helpers used across the injector submodules.
// Kept minimal on purpose: anything bigger belongs in its domain module
// (config/build).

const releaseManifest = require('../../../release-manifest.json');

const CONTEXA_GROUP_ID = releaseManifest.starter.groupId;
const CONTEXA_ARTIFACT_ID = releaseManifest.starter.artifactId;
const CONTEXA_VERSION = releaseManifest.starter.version;
const DEPENDENCY_VERSION_DEFAULTS = Object.freeze({
  ...releaseManifest.dependencyVersions,
});
const DEPENDENCY_VERSION_ENV = Object.freeze({
  springAiBom: 'CONTEXA_SPRING_AI_VERSION',
  sampleSpringBoot: 'CONTEXA_SAMPLE_SPRING_BOOT_VERSION',
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

module.exports = {
  CONTEXA_GROUP_ID,
  CONTEXA_ARTIFACT_ID,
  CONTEXA_VERSION,
  DEPENDENCY_VERSION_DEFAULTS,
  resolveDependencyVersions,
  springAiProviderArtifacts,
  escapeRegex,
};
