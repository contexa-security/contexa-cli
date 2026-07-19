#!/usr/bin/env node
'use strict';

const { program, Option } = require('commander');
const chalk = require('chalk');
const { detectLocale, setLocale, t } = require('./core/i18n');
const releaseManifest = require('../release-manifest.json');

const argv = process.argv.slice(2);
let explicitLang = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--lang' && argv[i + 1]) {
    explicitLang = argv[i + 1];
    break;
  }
  if (argv[i].startsWith('--lang=')) {
    explicitLang = argv[i].slice(7);
    break;
  }
}
setLocale(detectLocale(explicitLang));

const banner = `
${chalk.cyan('  CONTEXA')}
${chalk.gray('  ' + t('banner.tagline') + ' / ' + t('banner.subtitle'))}  ${chalk.yellow('v' + releaseManifest.cliVersion)}
`;

program
  .name('contexa')
  .description('Contexa CLI - AI-Native Zero Trust Security Platform')
  .version(releaseManifest.cliVersion)
  .addOption(new Option('--lang <code>', 'Interface language (en|ko)').choices(['en', 'ko']))
  .addHelpText('after', '\nPrimary workflows:\n' + releaseManifest.primaryCommands
    .map(command => '  ' + command)
    .join('\n') + '\n');

require('./commands/init')(program);
require('./commands/mode')(program);
require('./commands/status')(program);
require('./commands/scan')(program);
require('./commands/simulate')(program);
require('./commands/doctor')(program);
require('./commands/reset')(program);
require('./commands/ollama')(program);

async function main() {
  if (!argv.length) {
    console.log(banner);
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(chalk.red('  x ' + (error && error.message ? error.message : error)));
  process.exitCode = 1;
});
