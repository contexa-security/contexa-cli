'use strict';

const chalk = require('chalk');
const inquirer = require('inquirer');
const path = require('path');
const { getLocale, setLocale, t, SUPPORTED } = require('./i18n');
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

function explicitLanguageSelected(opts = {}) {
  if (SUPPORTED.includes(String(opts.lang || '').toLowerCase())) return true;
  if (process.argv.some(argument => argument === '--lang' || argument.startsWith('--lang='))) {
    return true;
  }
  const environmentLanguage = String(process.env.CONTEXA_LANG || '')
    .toLowerCase().match(/^([a-z]{2})/);
  return !!(environmentLanguage && SUPPORTED.includes(environmentLanguage[1]));
}

async function selectInitLocale(opts = {}, interactive = process.stdin.isTTY === true) {
  if (!interactive || opts.yes || opts.check || explicitLanguageSelected(opts)) return getLocale();
  const answer = await inquirer.prompt([{
    type: 'rawlist',
    name: 'lang',
    message: t('lang.choose') + '\n',
    default: getLocale(),
    choices: [
      { name: t('lang.choice.en'), value: 'en' },
      { name: t('lang.choice.ko'), value: 'ko' },
    ],
  }]);
  return setLocale(SUPPORTED.includes(answer.lang) ? answer.lang : getLocale());
}

function buildInitDefaults(opts) {
  if (opts.merge && opts.standalone) {
    throw initInputError('INTEGRATION_MODE_CONFLICT', 'init.error.integrationModeConflict');
  }
  const explicitIntegrationMode = opts.standalone ? 'standalone'
    : opts.merge ? 'merge'
    : null;
  const providerFromFlags = normalizeProviders(opts.provider, {
    includeOllama: opts.includeOllama,
  });
  const quickProviders = providerFromFlags.length > 0 ? providerFromFlags : ['ollama'];
  return {
    explicitIntegrationMode,
    providerFromFlags,
    defaults: {
      setupMode: 'quick',
      integrationMode: explicitIntegrationMode || 'merge',
      securityMode: opts.securityMode || 'full',
      mode: 'shadow',
      enableAiSecurity: true,
      autoAnnotate: !opts.simulate && explicitIntegrationMode !== 'standalone',
      llmProviders: quickProviders,
      infra: opts.distributed ? 'distributed' : 'standalone',
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
      type: 'rawlist', name: 'setupMode',
      message: '\n' + t('prompt.setupMode'),
      default: 'quick',
      choices: [
        { name: t('prompt.setupMode.quick'), value: 'quick' },
        { name: t('prompt.setupMode.advanced'), value: 'advanced' },
      ],
      when: () => !opts.simulate && !opts.quick,
    },
    {
      type: 'rawlist', name: 'providerQuick',
      message: '\n' + t('prompt.provider'),
      default: 'ollama',
      choices: [
        { name: t('prompt.provider.openai'), value: 'openai' },
        { name: t('prompt.provider.anthropic'), value: 'anthropic' },
        { name: t('prompt.provider.ollama'), value: 'ollama' },

      ],
      when: answer => answer.setupMode !== 'advanced'
        && !opts.simulate && !opts.provider && !opts.includeOllama,
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
      type: 'confirm', name: 'autoAnnotate',
      message: '\n' + t('prompt.autoAnnotate'),
      default: true,
      when: answer => {
        if (opts.simulate || opts.autoAnnotate) return false;
        const integration = explicitIntegrationMode
          || (answer.setupMode === 'advanced' ? answer.integrationMode : 'merge');
        return integration !== 'standalone';
      },
    },
    {
      type: 'rawlist', name: 'securityMode',
      message: '\n' + t('prompt.securityMode'),
      default: 'full',
      choices: [
        { name: t('prompt.securityMode.full'), value: 'full' },
        { name: t('prompt.securityMode.sandbox'), value: 'sandbox' },
      ],
      when: answer => answer.setupMode === 'advanced' && !opts.securityMode,
    },
    {
      type: 'rawlist', name: 'mode',
      message: '\n' + t('prompt.mode'),
      default: 'shadow',
      choices: [
        { name: t('prompt.mode.shadow'), value: 'shadow' },
        { name: t('prompt.mode.enforce'), value: 'enforce' },
      ],
      when: answer => answer.setupMode === 'advanced',
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
      when: answer => answer.setupMode === 'advanced' && !opts.provider,
    },
    {
      type: 'rawlist', name: 'infra',
      message: '\n' + t('prompt.infra'),
      default: opts.distributed ? 'distributed' : 'standalone',
      choices: [
        { name: t('prompt.infra.standalone'), value: 'standalone' },
        { name: t('prompt.infra.distributed'), value: 'distributed' },
        { name: t('prompt.infra.skip'), value: 'skip' },
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
  answers.setupMode = answers.setupMode || defaults.setupMode;
  answers.integrationMode = answers.setupMode === 'quick'
    ? (explicitIntegrationMode || 'merge')
    : (explicitIntegrationMode || answers.integrationMode || 'merge');
  if (opts.simulate && answers.integrationMode !== 'merge') {
    throw initInputError('SIMULATION_MERGE_REQUIRED', 'init.error.simulationMergeRequired');
  }
  answers.securityMode = opts.securityMode || answers.securityMode
    || (answers.setupMode === 'quick' ? 'full' : 'sandbox');
  answers.mode = answers.mode || 'shadow';
  answers.infra = opts.distributed ? 'distributed'
    : (answers.infra || (answers.setupMode === 'quick' ? 'standalone' : 'skip'));
  answers.startDocker = answers.infra !== 'skip'
    && project.hasDocker === true
    && opts.docker !== false
    && answers.startDocker !== false;

  if (promptProvider) {
    answers.llmProviders = normalizeProviders(promptProvider);
  } else if (opts.provider || opts.includeOllama) {
    answers.llmProviders = providerFromFlags;
  } else if (!Array.isArray(answers.llmProviders)) {
    answers.llmProviders = answers.setupMode === 'quick' ? ['ollama'] : [];
  }

  if (answers.integrationMode === 'standalone' && opts.autoAnnotate) {
    throw initInputError('STANDALONE_AUTO_ANNOTATE_CONFLICT',
      'init.error.standaloneAutoAnnotateConflict');
  }
  answers.autoAnnotate = !opts.simulate && answers.integrationMode !== 'standalone'
    && !!(opts.autoAnnotate || answers.autoAnnotate === true);
  if (!aiProviderSelected(answers)) {
    throw initInputError('AI_SECURITY_PROVIDER_REQUIRED', 'init.error.aiSecurityProviderRequired');
  }
  answers.enableAiSecurity = true;
  answers.simulate = !!opts.simulate;
  answers.hasEnableAiSecurity = !!project.hasEnableAiSecurity;
  answers.hostSecurityFilterChain = !!project.hasHostSecurityFilterChain;
  answers.injectDep = !opts.simulate;
  if (opts.distributed) answers.infra = 'distributed';
  if (opts.docker === false) answers.startDocker = false;
  return answers;
}

module.exports = { buildInitDefaults, collectInitAnswers, selectInitLocale };
