'use strict';

const { Option } = require('commander');
const { t } = require('../core/i18n');
const { executeInit } = require('../core/init-application');

module.exports = function registerInitCommand(program) {
  program
    .command('init')
    .description(t('init.description'))
    .option('--dir <path>', t('init.option.dir'))
    .addOption(new Option('--provider <name>', t('init.option.provider')).choices(['ollama', 'openai', 'anthropic']))
    .addOption(new Option('--ownership <owner>', t('init.option.ownership')).choices(['host', 'contexa']))
    .option('--yes', t('init.option.yes'))
    .option('--db-url <jdbc-url>', t('init.option.dbUrl'))
    .option('--db-username <name>', t('init.option.dbUsername'))
    .action(executeInit);
};
