#!/usr/bin/env node
'use strict';

const { program, Option } = require('commander');
const chalk = require('chalk');
const { detectLocale, setLocale, t } = require('./core/i18n');

// Pre-parse --lang so that i18n is initialized before any subcommand action runs.
// CLI arg wins over env vars; absent arg falls back to env / OS default.
const argv = process.argv.slice(2);
let explicitLang = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--lang' && argv[i + 1]) { explicitLang = argv[i + 1]; break; }
  if (argv[i].startsWith('--lang=')) { explicitLang = argv[i].slice(7); break; }
}
setLocale(detectLocale(explicitLang));

// Pin console output to UTF-8 for the banner's box-drawing glyphs. On Korean
// Windows (PowerShell 5.x + conhost) the default OutputEncoding is cp949,
// which mojibakes every byte > 0x7F (the user reported seeing 'â' instead of
// '█'). We restore the original encoding right after printing the banner so
// downstream commands keep their default expectations.
let __originalConsoleEncoding = null;
if (process.stdout && process.stdout.isTTY && process.platform === 'win32') {
  try {
    __originalConsoleEncoding = process.stdout.getDefaultEncoding && process.stdout.getDefaultEncoding();
    if (process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8');
  } catch { /* non-Win or restricted host - silently fall back */ }
}

const banner = `
${chalk.cyan('  ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗ █████╗ ')}
${chalk.cyan(' ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗')}
${chalk.cyan(' ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝ ███████║')}
${chalk.cyan(' ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗ ██╔══██║')}
${chalk.cyan(' ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗██║  ██║')}
${chalk.cyan('  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝')}
${chalk.gray('  ' + t('banner.tagline') + ' / ' + t('banner.subtitle'))}  ${chalk.yellow('v1.0.0')}
`;

program
  .name('contexa')
  .description('Contexa CLI - AI-Native Zero Trust Security Platform')
  .version('1.0.0')
  .addOption(new Option('--lang <code>', 'Interface language (en|ko)').choices(['en', 'ko']));

require('./commands/init')(program);
require('./commands/mode')(program);
require('./commands/status')(program);
require('./commands/scan')(program);
require('./commands/simulate')(program);
require('./commands/doctor')(program);
require('./commands/reset')(program);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  console.log(banner);
  program.outputHelp();
}