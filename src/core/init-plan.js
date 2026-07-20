'use strict';

const chalk = require('chalk');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');

const HOST_IAM_CONTRACT = 'HOST_OWNED_UNCHANGED';
const BRIDGE_CONTRACT = 'HOST_PRINCIPAL_INPUT_ONLY';
const FULL_MODE_CONTRACT = 'CONTEXA_POLICY_ENFORCEMENT_ONLY';

function normalizePath(input, baseDir) {
  if (!input) return null;
  let normalized = String(input).trim();
  if (!normalized) return null;
  if (normalized === '~') normalized = os.homedir();
  else if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(baseDir, normalized);
}

function aiProviderSelected(answers) {
  return Array.isArray(answers.llmProviders) && answers.llmProviders.length > 0;
}

function activationResult(answers, project, state = {}) {
  const requested = !!answers.enableAiSecurity;
  const providers = Array.isArray(answers.llmProviders)
    ? [...answers.llmProviders] : [];
  const annotationActive = !!(
    answers.simulate || project.hasEnableAiSecurity || state.aiAnnotationApplied);
  const dependenciesReady = !!state.aiDependenciesProcessed;
  const enabled = requested && providers.length > 0
    && annotationActive && dependenciesReady;
  return {
    requested,
    enabled,
    status: !requested ? 'DISABLED'
      : !annotationActive ? 'PENDING_ANNOTATION'
        : !dependenciesReady ? 'PENDING_DEPENDENCIES'
          : 'ACTIVE',
    securityMode: String(answers.securityMode || 'sandbox').toUpperCase(),
    runtimeMode: String(answers.mode || 'shadow').toUpperCase(),
    providers,
    annotationActive,
    dependenciesReady,
    hostIamContract: HOST_IAM_CONTRACT,
    bridgeContract: BRIDGE_CONTRACT,
    fullModeContract: FULL_MODE_CONTRACT,
  };
}

function trackedFileState(manifest, projectDir, filePath) {
  const relativePath = path.relative(projectDir, filePath).split(path.sep).join('/');
  const entry = (manifest.files || []).find(file => file.relativePath === relativePath) || null;
  const transactionFile = manifest.transaction && Array.isArray(manifest.transaction.files)
    ? manifest.transaction.files.find(file => file.relativePath === relativePath)
    : null;
  const lastCliChecksum = entry && (entry.lastCliChecksum || entry.currentChecksum);
  return {
    entry,
    userModified: !!(entry && entry.ownership === 'CLI_OWNED' && lastCliChecksum
      && transactionFile && transactionFile.startChecksum !== lastCliChecksum),
  };
}

function printPlannedChanges(answers, project, paths) {
  console.log(chalk.cyan(`\n  ${t('planned.title')}`));
  const items = [t('planned.setupQuick')];
  if (answers.integrationMode === 'standalone') {
    items.push(t('planned.integrationStandalone'));
    items.push(t('planned.pathAction', 'CREATE', t('planned.createStandalone'), paths.standaloneDir));
  } else {
    items.push(t('planned.integrationMerge'));
    if (answers.simulate) {
      items.push(t('planned.normalBuildNone'));
      items.push(t('planned.pathAction', paths.ymlExists ? 'MODIFY' : 'CREATE',
        t('planned.simulationOverlay'), paths.ymlPath));
      items.push(t('planned.pathAction', paths.simulationConfigExists ? 'KEEP' : 'CREATE',
        t('planned.simulationConfiguration'), paths.simulationConfigPath));
    } else {
      items.push(t('planned.pathAction', paths.buildExists ? 'MODIFY' : 'CREATE',
        t('planned.addStarter'), paths.buildPath));
    }
    if (paths.writeOverlay) {
      if (!answers.simulate) {
        items.push(`${paths.ymlExists ? 'MODIFY' : 'CREATE'}: ${t('planned.applyMinimal')}: ${paths.ymlPath}`);
      }
    } else {
      items.push(t('planned.hostConfigNone'));
    }
  }
  if (answers.enableAiSecurity) {
    items.push(`${t('planned.enableAi')} (${answers.llmProviders.join(', ')})`);
    if (answers.simulate) {
      items.push(t('planned.simulationActivation'));
    } else if (answers.autoAnnotate) {
      items.push(t('planned.autoAnnotate'));
    } else if (!project.hasEnableAiSecurity) {
      items.push(t('planned.manualAnnotate'));
    }
  } else {
    items.push(t('planned.aiDisabled'));
  }
  if (answers.infra !== 'skip') {
    items.push(t('planned.pathAction', paths.composeExists ? 'MODIFY' : 'CREATE',
      t('planned.createInfra'), paths.composePath));
    items.push(answers.startDocker ? t('planned.dockerStart') : t('planned.dockerSkip'));
  } else {
    items.push(t('planned.dockerNone'));
  }
  if (paths.geoIpPath) {
    items.push(t('planned.pathAction',
      paths.geoIpExists ? 'KEEP' : (paths.geoIpLocalSource ? 'COPY' : 'DOWNLOAD'),
      'GeoLite2-City.mmdb', paths.geoIpPath));
  } else {
    items.push(t('planned.externalNone'));
  }
  items.push(t('planned.deleteNone'));
  for (const item of items) console.log(chalk.gray(`    - ${item}`));
}

module.exports = {
  HOST_IAM_CONTRACT,
  BRIDGE_CONTRACT,
  FULL_MODE_CONTRACT,
  activationResult,
  aiProviderSelected,
  normalizePath,
  printPlannedChanges,
  trackedFileState,
};
