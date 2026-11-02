'use strict';

const TIMEOUTS = Object.freeze({
  httpHealthProbeMs: 2000,
  dockerCliProbeMs: 3000,
  dockerInspectMs: 5000,
  dockerDefaultMs: 120000,
  dockerComposeRollbackMs: 30000,
  javaCommandProbeMs: 5000,
  socketIdleMs: 30000,
  ollamaPullMs: 60 * 60 * 1000,
  ollamaPullMaximumMs: 4 * 60 * 60 * 1000,
});

module.exports = { TIMEOUTS };
