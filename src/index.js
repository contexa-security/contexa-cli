#!/usr/bin/env node
'use strict';

const { program, Option } = require('commander');
const chalk = require('chalk');
const { detectLocale, setLocale, t, formatError } = require('./core/i18n');
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
${chalk.cyan('  CONTEXA')}  ${chalk.yellow('v' + releaseManifest.cliVersion)}
${chalk.gray('  ' + t('banner.tagline'))}
`;

program
  .name('contexa')
  .description(t('banner.tagline'))
  .version(releaseManifest.cliVersion)
  .addOption(new Option('--lang <code>', t('option.lang')).choices(['en', 'ko']))
  .addHelpText('after', `\n${t('help.start')}\n  cd <your-spring-boot-project>\n  contexa init\n`);

require('./commands/init')(program);
require('./commands/doctor')(program);
require('./commands/reset')(program);

async function main() {
  if (!argv.length) {
    console.log(banner);
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(chalk.red(`\n  x ${formatError(error)}`));
  if (error && error.hintKey) console.error(chalk.yellow(`    -> ${t(error.hintKey)}`));
  if (error && error.detail) {
    console.error(chalk.gray(String(error.detail).split('\n').map(line => `    ${line}`).join('\n')));
  }
  console.error('');
  process.exitCode = 1;
});
