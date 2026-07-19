'use strict';

const fs = require('fs-extra');
const { INSTALL_MODES, loadManifest, manifestPath } = require('./manifest');

const INSTALLATION_STATES = Object.freeze({
  UNINSTALLED: 'UNINSTALLED',
  NORMAL: 'NORMAL',
  SIMULATION: 'SIMULATION',
  BOTH: 'BOTH',
  CONFLICT: 'CONFLICT',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
});

async function inspectMode(projectDir, mode) {
  const path = manifestPath(projectDir, mode);
  if (!await fs.pathExists(path)) return { mode, status: 'ABSENT', path };
  try {
    const manifest = await loadManifest(projectDir, mode);
    const transactionStatus = manifest.transaction ? manifest.transaction.status : 'UNKNOWN';
    if (!manifest.metadata || !manifest.metadata.installationId) {
      return { mode, status: INSTALLATION_STATES.CONFLICT, path, reason: 'installationId is missing' };
    }
    if (transactionStatus !== 'COMMITTED') {
      return {
        mode,
        status: INSTALLATION_STATES.PARTIAL_FAILURE,
        path,
        installationId: manifest.metadata.installationId,
        transactionStatus,
      };
    }
    return {
      mode,
      status: 'COMMITTED',
      path,
      installationId: manifest.metadata.installationId,
      transactionStatus,
    };
  } catch (error) {
    return { mode, status: INSTALLATION_STATES.CONFLICT, path, reason: error.message };
  }
}

async function inspectInstallationState(projectDir) {
  const normal = await inspectMode(projectDir, INSTALL_MODES.NORMAL);
  const simulation = await inspectMode(projectDir, INSTALL_MODES.SIMULATION);
  const modes = [normal, simulation];
  if (modes.some(item => item.status === INSTALLATION_STATES.CONFLICT)) {
    return { state: INSTALLATION_STATES.CONFLICT, normal, simulation };
  }
  if (modes.some(item => item.status === INSTALLATION_STATES.PARTIAL_FAILURE)) {
    return { state: INSTALLATION_STATES.PARTIAL_FAILURE, normal, simulation };
  }
  const hasNormal = normal.status === 'COMMITTED';
  const hasSimulation = simulation.status === 'COMMITTED';
  const state = hasNormal && hasSimulation
    ? INSTALLATION_STATES.BOTH
    : hasNormal
      ? INSTALLATION_STATES.NORMAL
      : hasSimulation
        ? INSTALLATION_STATES.SIMULATION
        : INSTALLATION_STATES.UNINSTALLED;
  return { state, normal, simulation };
}

module.exports = { INSTALLATION_STATES, inspectMode, inspectInstallationState };
