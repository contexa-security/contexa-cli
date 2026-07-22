'use strict';

const { Option } = require('commander');
const { t } = require('../core/i18n');
const { executeInit } = require('../core/init-application');

module.exports = function registerInitCommand(program) {
  program
    .command('init')
    .description(t('init.description'))
    .option('--yes', t('init.option.yes'))
    .option('--force', t('init.option.force'))
    .option('--dir <path>', t('init.option.dir'), process.cwd())
    .option('--distributed', t('init.option.distributed'))
    .option('--include-ollama', t('init.option.includeOllama'))
    .option('--no-docker', t('init.option.noDocker'))
    .option('--simulate', t('init.option.simulate'))
    .option('--quick', t('init.option.quick'))
    .option('--enable-ai-security', t('init.option.enableAiSecurity'))
    .option('--provider <name>', t('init.option.provider'))
    .option('--auto-annotate', t('init.option.autoAnnotate'))
    .addOption(new Option('--security-mode <mode>', t('init.option.securityMode'))
      .choices(['sandbox', 'full']))
    .option('--merge', t('init.option.merge'))
    .option('--standalone', t('init.option.standalone'))
    .option('--standalone-dir <path>', t('init.option.standaloneDir'))
    .option('--infra-dir <path>', t('init.option.infraDir'))
    .option('--check', t('init.option.check'))
    .action(executeInit);
};
