'use strict';

const TIMEOUTS = Object.freeze({
  httpHealthProbeMs: 2000,
  dockerCliProbeMs: 3000,
  dockerInspectMs: 5000,
  dockerDefaultMs: 120000,
  dockerCommandProbeMs: 15000,
  javaCommandProbeMs: 5000,
  dockerComposeRollbackMs: 30000,
  dockerComposeMutationMs: 150000,
  artifactDownloadMs: 120000,
  socketIdleMs: 30000,
  simulationHealthMs: 120000,
  simulationPollMs: 2000,
  ollamaReadyMs: 90000,
  ollamaCommandProbeMs: 3000,
  ollamaPullMs: 10 * 60 * 1000,
  ollamaPullMaximumMs: 60 * 60 * 1000,
});

module.exports = { TIMEOUTS };
