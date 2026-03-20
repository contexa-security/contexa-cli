#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');

const banner = `
${chalk.cyan('  ██████╗ ██████╗ ███╗   ██╗████████╗███████╗██╗  ██╗ █████╗ ')}
${chalk.cyan(' ██╔════╝██╔═══██╗████╗  ██║╚══██╔══╝██╔════╝╚██╗██╔╝██╔══██╗')}
${chalk.cyan(' ██║     ██║   ██║██╔██╗ ██║   ██║   █████╗   ╚███╔╝ ███████║')}
${chalk.cyan(' ██║     ██║   ██║██║╚██╗██║   ██║   ██╔══╝   ██╔██╗ ██╔══██║')}
${chalk.cyan(' ╚██████╗╚██████╔╝██║ ╚████║   ██║   ███████╗██╔╝ ██╗██║  ██║')}
${chalk.cyan('  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝')}
${chalk.gray('  AI-Native Zero Trust Security for Spring')}  ${chalk.yellow('v1.0.0')}
`;

// Always show banner on startup
console.log(banner);

program
  .name('contexa')
  .description('Contexa CLI - AI-Native Zero Trust Security Platform')
  .version('1.0.0');

require('./commands/init')(program);
require('./commands/mode')(program);
require('./commands/status')(program);
require('./commands/scan')(program);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}