'use strict';

// Shared constants and tiny helpers used across the injector submodules.
// Kept minimal on purpose: anything bigger belongs in its domain module
// (yml/build/compose/initdb/standalone).

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';
const CONTEXA_VERSION = '0.1.0';

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  CONTEXA_GROUP_ID,
  CONTEXA_ARTIFACT_ID,
  CONTEXA_VERSION,
  escapeRegex,
};
