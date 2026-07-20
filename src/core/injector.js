'use strict';

// Public facade for the injector subsystem.
//
// Historically this file held all yml/build/compose/standalone logic
// in one ~2100-line module. It has been split into focused submodules under
// src/core/injector/. This file re-exports the same surface so existing
// callers (init.js, scan.js, tests) keep working without any rewrites.

const yml        = require('./injector/yml');
const build      = require('./injector/build');
const compose    = require('./injector/compose');
const standalone = require('./injector/standalone');

module.exports = {
  // yml
  injectYml: yml.injectYml,
  normalOverlayPath: yml.normalOverlayPath,
  buildCliContexaTree: yml.buildCliContexaTree,
  applyCliContexaTree: yml.applyCliContexaTree,
  stripLegacyMarker: yml.stripLegacyMarker,

  // build
  injectMavenDep: build.injectMavenDep,
  injectGradleDep: build.injectGradleDep,
  injectDistributedDeps: build.injectDistributedDeps,
  injectSpringAiDeps: build.injectSpringAiDeps,
  injectEnableAiSecurity: build.injectEnableAiSecurity,
  inspectAiDependencies: build.inspectAiDependencies,
  // Exported for unit testing of the brace-aware Gradle insertion logic.
  findTopLevelDependenciesInsertIndex: build.findTopLevelDependenciesInsertIndex,
  insertIntoTopLevelDependencies: build.insertIntoTopLevelDependencies,

  // compose
  generateDockerCompose: compose.generateDockerCompose,

  // standalone
  injectStandalone: standalone.injectStandalone,
};
