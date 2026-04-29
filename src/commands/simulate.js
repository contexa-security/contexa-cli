'use strict';

const chalk = require('chalk');
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// `contexa simulate` - lifecycle helper for the isolated simulation stack
// created by `contexa init --simulate`. Lets a user reset / inspect / tear
// down the simulation stack in one command without learning the full docker
// compose syntax.
//
// Subcommands:
//   contexa simulate up     - start (or restart) the simulation stack
//   contexa simulate down   - stop the simulation stack (keeps volumes)
//   contexa simulate reset  - down + delete volumes (full clean state)
//   contexa simulate ps     - status of simulation containers
//   contexa simulate logs   - stream logs from the simulation stack

const PROJECT = 'ctxa-sim';

function dockerCompose(args, opts = {}) {
  const cmd = `docker compose ${args}`;
  return spawnSync(cmd, {
    cwd: opts.cwd || process.cwd(),
    stdio: 'inherit',
    shell: true,
  });
}

function findCompose(dir) {
  const candidate = path.join(dir, 'docker-compose.yml');
  return fs.existsSync(candidate) ? candidate : null;
}

module.exports = function (program) {
  const sim = program
    .command('simulate')
    .description('Manage the isolated simulation stack created by "contexa init --simulate"')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd());

  sim.command('up')
    .description('Start (or restart) the simulation stack')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd())
    .action((opts) => {
      const compose = findCompose(opts.dir);
      if (!compose) {
        console.log(chalk.red(`\n  x docker-compose.yml not found in ${opts.dir}.`));
        console.log(chalk.gray('    Run "contexa init --simulate" first to generate it.\n'));
        process.exit(1);
      }
      dockerCompose(`-p ${PROJECT} up -d`, { cwd: opts.dir });
    });

  sim.command('down')
    .description('Stop the simulation stack (keeps volumes)')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd())
    .action((opts) => {
      const compose = findCompose(opts.dir);
      if (!compose) {
        // No compose file - just remove containers by project name as a best effort.
        spawnSync(`docker ps -aq -f label=com.docker.compose.project=${PROJECT}`,
          { stdio: 'pipe', shell: true });
        console.log(chalk.gray('\n  No docker-compose.yml found; nothing to stop.\n'));
        return;
      }
      dockerCompose(`-p ${PROJECT} down`, { cwd: opts.dir });
    });

  sim.command('reset')
    .description('Stop the simulation stack AND delete its volumes (clean slate)')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd())
    .action((opts) => {
      const compose = findCompose(opts.dir);
      if (!compose) {
        console.log(chalk.red(`\n  x docker-compose.yml not found in ${opts.dir}.\n`));
        process.exit(1);
      }
      console.log(chalk.yellow(`\n  Resetting simulation stack "${PROJECT}" (down -v + up -d)...\n`));
      dockerCompose(`-p ${PROJECT} down -v`, { cwd: opts.dir });
      dockerCompose(`-p ${PROJECT} up -d`,    { cwd: opts.dir });
    });

  sim.command('ps')
    .description('Show simulation container status')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd())
    .action((opts) => {
      try {
        execSync(`docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`,
          { stdio: 'inherit' });
      } catch {
        console.log(chalk.red('  x Docker not reachable.'));
      }
    });

  sim.command('logs [service]')
    .description('Stream logs from the simulation stack (optional: specific service)')
    .option('--dir <path>', 'Project directory containing docker-compose.yml', process.cwd())
    .action((service, opts) => {
      const compose = findCompose(opts.dir);
      if (!compose) {
        console.log(chalk.red(`\n  x docker-compose.yml not found in ${opts.dir}.\n`));
        process.exit(1);
      }
      const svc = service ? ` ${service}` : '';
      dockerCompose(`-p ${PROJECT} logs -f${svc}`, { cwd: opts.dir });
    });
};
