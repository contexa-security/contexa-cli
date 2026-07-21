'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');
const { t } = require('./i18n');
const { aiProviderSelected } = require('./init-plan');
const { normalizeProviders } = require('./provider');
const { resolveInfraDir } = require('./project');

function initInputError(code, key) {
  const error = new Error(`${code} ${t(key)}`);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = [];
  return error;
}

function buildInitDefaults(opts) {
  const explicitIntegrationMode = opts.standalone ? 'standalone'
    : opts.merge ? 'merge'
    : null;
  const providerFromFlags = normalizeProviders(opts.provider, {
    includeOllama: opts.includeOllama,
  });
  const explicitAiSecurity = !!(
    opts.enableAiSecurity || opts.autoAnnotate || opts.provider
    || opts.includeOllama || opts.simulate
  );
  return {
    explicitIntegrationMode,
    providerFromFlags,
    defaults: {
      setupMode: 'quick',
      integrationMode: explicitIntegrationMode || 'merge',
      securityMode: opts.securityMode || 'sandbox',
      mode: 'shadow',
      enableAiSecurity: explicitAiSecurity && providerFromFlags.length > 0,
      autoAnnotate: !!opts.autoAnnotate,
      llmProviders: explicitAiSecurity ? providerFromFlags : [],
      infra: opts.distributed ? 'distributed' : opts.infraDir ? 'standalone' : 'skip',
      injectDep: true,
      startDocker: opts.docker !== false,
    },
  };
}

async function collectInitAnswers(opts, project, cliProjectName) {
  const { explicitIntegrationMode, providerFromFlags, defaults } = buildInitDefaults(opts);

  if (opts.simulate) {
    console.log(chalk.cyan(`\n  i ${t('init.simulation.selected')}`));
    console.log(chalk.gray(`    ${t('init.simulation.infrastructure')}\n`));
  }

  const answers = opts.yes ? defaults : await inquirer.prompt([
    {
      type: 'confirm', name: 'enableAiSecurity',
      message: '\n' + t('prompt.enableAiSecurity'),
      default: false,
      when: () => !opts.simulate && !opts.enableAiSecurity && !opts.provider && !opts.autoAnnotate,
    },
    {
      type: 'rawlist', name: 'providerQuick',
      message: '\n' + t('prompt.provider'),
      default: 'openai',
      choices: [
        { name: t('prompt.provider.openai'), value: 'openai' },
        { name: t('prompt.provider.anthropic'), value: 'anthropic' },
        { name: t('prompt.provider.ollama'), value: 'ollama' },
        { name: t('prompt.provider.none'), value: 'none' },
      ],
      when: answer => answer.setupMode !== 'advanced'
        && (opts.enableAiSecurity || opts.autoAnnotate || answer.enableAiSecurity === true)
        && !opts.provider,
    },
    {
      type: 'confirm', name: 'autoAnnotate',
      message: '\n' + t('prompt.autoAnnotate'),
      default: false,
      when: answer => (opts.enableAiSecurity || opts.provider || answer.enableAiSecurity === true)
        && !opts.autoAnnotate,
    },
    {
      type: 'rawlist', name: 'integrationMode',
      message: '\n' + t('prompt.integrationMode'),
      default: 'merge',
      choices: [
        { name: t('prompt.integrationMode.merge'), value: 'merge' },
        { name: t('prompt.integrationMode.standalone'), value: 'standalone' },
      ],
      when: answer => answer.setupMode === 'advanced' && explicitIntegrationMode === null,
    },
    {
      type: 'input', name: 'standaloneDir',
      message: '\n' + t('prompt.standaloneDir'),
      default: path.join(opts.dir, 'contexa'),
      when: answer => {
        if (answer.setupMode !== 'advanced') return false;
        const mode = explicitIntegrationMode || answer.integrationMode;
        return mode === 'standalone' && !opts.standaloneDir;
      },
    },
    {
      type: 'rawlist', name: 'securityMode',
      message: '\n' + t('prompt.securityMode'),
      default: 'sandbox',
      choices: [
        { name: t('prompt.securityMode.full'), value: 'full' },
        { name: t('prompt.securityMode.sandbox'), value: 'sandbox' },
      ],
      when: answer => answer.setupMode === 'advanced'
        && (opts.enableAiSecurity || opts.provider || answer.enableAiSecurity === true),
    },
    {
      type: 'rawlist', name: 'mode',
      message: '\n' + t('prompt.mode'),
      default: 'shadow',
      choices: [
        { name: t('prompt.mode.shadow'), value: 'shadow' },
        { name: t('prompt.mode.enforce'), value: 'enforce' },
      ],
      when: answer => answer.setupMode === 'advanced'
        && (opts.enableAiSecurity || opts.provider || answer.enableAiSecurity === true),
    },
    {
      type: 'checkbox', name: 'llmProviders',
      message: '\n' + t('prompt.llm'),
      choices: [
        { name: t('prompt.llm.openai'), value: 'openai', checked: true },
        { name: t('prompt.llm.anthropic'), value: 'anthropic', checked: true },
        { name: t('prompt.llm.ollama'), value: 'ollama', checked: !!opts.includeOllama },
      ],
      validate: answer => answer.length > 0 ? true : t('prompt.llm.atLeastOne'),
      when: answer => answer.setupMode === 'advanced'
        && (opts.enableAiSecurity || opts.provider || opts.autoAnnotate
          || answer.enableAiSecurity === true),
    },
    {
      type: 'rawlist', name: 'infra',
      message: '\n' + t('prompt.infra'),
      default: opts.distributed ? 'distributed' : 'skip',
      choices: [
        { name: t('prompt.infra.skip'), value: 'skip' },
        { name: t('prompt.infra.distributed'), value: 'distributed' },
      ],
      when: answer => answer.setupMode === 'advanced' && !opts.distributed,
    },
    {
      type: 'input', name: 'infraDir',
      message: '\n' + t('prompt.infraDir'),
      default: () => resolveInfraDir(cliProjectName, {}),
      when: answer => {
        if (answer.setupMode !== 'advanced') return false;
        const infra = opts.distributed ? 'distributed' : answer.infra;
        return infra !== 'skip' && !opts.infraDir;
      },
    },
    {
      type: 'confirm', name: 'startDocker',
      message: '\n' + t('prompt.startDocker'),
      default: true,
      when: answer => {
        if (answer.setupMode !== 'advanced') return false;
        const infra = opts.distributed ? 'distributed' : answer.infra;
        return infra !== 'skip' && project.hasDocker && opts.docker !== false;
      },
    },
  ]);

  const promptProvider = answers.providerQuick || null;
  const requestedAiSecurity = !!(
    opts.simulate || opts.enableAiSecurity || opts.autoAnnotate || opts.provider
    || opts.includeOllama || answers.enableAiSecurity === true
  );

  answers.integrationMode = explicitIntegrationMode || answers.integrationMode || 'merge';
  if (opts.simulate && answers.integrationMode !== 'merge') {
    throw initInputError('SIMULATION_MERGE_REQUIRED', 'init.error.simulationMergeRequired');
  }
  answers.securityMode = opts.securityMode || answers.securityMode || 'sandbox';
  answers.mode = answers.mode || 'shadow';
  answers.infra = opts.distributed ? 'distributed'
    : opts.infraDir ? 'standalone'
    : (answers.infra || 'skip');
  answers.startDocker = opts.docker !== false && answers.startDocker !== false;

  if (promptProvider) {
    answers.llmProviders = normalizeProviders(promptProvider);
  } else if (opts.provider || opts.includeOllama || opts.enableAiSecurity
      || opts.autoAnnotate || opts.simulate) {
    answers.llmProviders = providerFromFlags;
  } else if (!Array.isArray(answers.llmProviders)) {
    answers.llmProviders = [];
  }

  answers.autoAnnotate = !!(opts.autoAnnotate || answers.autoAnnotate === true);
  if (answers.autoAnnotate && !aiProviderSelected(answers)) {
    throw initInputError('AUTO_ANNOTATE_PROVIDER_REQUIRED', 'init.error.autoAnnotateProviderRequired');
  }
  if (requestedAiSecurity && !aiProviderSelected(answers)) {
    throw initInputError('AI_SECURITY_PROVIDER_REQUIRED', 'init.error.aiSecurityProviderRequired');
  }
  answers.enableAiSecurity = !!(requestedAiSecurity && aiProviderSelected(answers));
  answers.simulate = !!opts.simulate;
  answers.hasEnableAiSecurity = !!project.hasEnableAiSecurity;
  answers.hostSecurityFilterChain = !!project.hasHostSecurityFilterChain;
  answers.injectDep = !opts.simulate;
  if (opts.distributed) answers.infra = 'distributed';
  if (opts.docker === false) answers.startDocker = false;
  return answers;
}

module.exports = { buildInitDefaults, collectInitAnswers };
