'use strict';

const chalk = require('chalk');
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { osDefaultInfraDir } = require('../core/project');

// `contexa simulate` is the lifecycle helper for the SIMULATION stack created
// by `contexa init --simulate` (compose project name "ctxa-sim", containers
// ctxa-sim-postgres / ctxa-sim-ollama / ..., on +20000 ports).
//
// Design rule: the user is NOT expected to know any flag names, environment
// variables, or directory paths. `contexa simulate <subcommand>` MUST work
// out of the box right after `contexa init --simulate`, with no flags and
// no environment setup. To make that possible, this command is HARD-WIRED
// to the ctxa-sim project (osDefaultInfraDir('ctxa-sim')) and never reads
// CONTEXA_PROJECT or any user-side env variable. The "production" stack
// is intentionally NOT covered here - that one is the customer's existing
// docker-compose, not contexa-cli's responsibility.
//
// Subcommands:
//   contexa simulate up     - start (or restart) the ctxa-sim stack
//   contexa simulate down   - stop it (keeps volumes)
//   contexa simulate reset  - down -v + up -d (clean slate)
//   contexa simulate ps     - status of ctxa-sim containers
//   contexa simulate logs   - stream logs from the ctxa-sim stack
//
// docker-compose.yml is read from the contexa-owned infra directory
// (~/.contexa/ctxa-sim or %LOCALAPPDATA%\Contexa\ctxa-sim), NEVER from the
// customer project directory.

const SIM_PROJECT = 'ctxa-sim';

function dockerCompose(args, cwd) {
  const cmd = `docker compose ${args}`;
  return spawnSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function findCompose(infraDir) {
  const candidate = path.join(infraDir, 'docker-compose.yml');
  return fs.existsSync(candidate) ? candidate : null;
}

// Resolve the simulation infra directory. The user can still override the
// location with --infra-dir for advanced setups (e.g. CI runners that need
// the artifacts on a tmpfs), but a plain `contexa simulate up` works with
// no flags whatsoever - that's the whole point.
function buildContext(opts = {}) {
  const explicit = opts && opts.infraDir;
  const infraDir = explicit
    ? path.resolve(String(explicit))
    : osDefaultInfraDir(SIM_PROJECT);
  return { projectName: SIM_PROJECT, infraDir };
}

function notReadyHint(infraDir) {
  console.log(chalk.gray(`    Expected location  : ${infraDir}`));
  console.log(chalk.gray('    To create it, run  : contexa init --simulate'));
  console.log(chalk.gray('    (this prepares an isolated PostgreSQL + Ollama + Redis + Kafka stack'));
  console.log(chalk.gray('     that does NOT collide with any production stack on the same host)\n'));
}

module.exports = function (program) {
  const sim = program
    .command('simulate')
    .description('Manage the simulation stack (ctxa-sim) created by "contexa init --simulate"');

  sim.command('up')
    .description('Start (or restart) the simulation stack')
    .option('--infra-dir <path>', 'Override the simulation infra directory (advanced)')
    .action((opts) => {
      const { projectName, infraDir } = buildContext(opts);
      const compose = findCompose(infraDir);
      if (!compose) {
        console.log(chalk.red('\n  x Simulation stack not initialized.'));
        notReadyHint(infraDir);
        process.exit(1);
      }
      console.log(chalk.cyan(`\n  Starting simulation stack "${projectName}"`));
      console.log(chalk.gray(`    Infra dir : ${infraDir}\n`));
      dockerCompose(`-p ${projectName} up -d`, infraDir);
    });

  sim.command('down')
    .description('Stop the simulation stack (keeps volumes)')
    .option('--infra-dir <path>', 'Override the simulation infra directory (advanced)')
    .action((opts) => {
      const { projectName, infraDir } = buildContext(opts);
      const compose = findCompose(infraDir);
      if (!compose) {
        console.log(chalk.gray('\n  Simulation stack not initialized; nothing to stop.\n'));
        return;
      }
      console.log(chalk.cyan(`\n  Stopping simulation stack "${projectName}"\n`));
      dockerCompose(`-p ${projectName} down`, infraDir);
    });

  sim.command('reset')
    .description('Stop the simulation stack AND delete its volumes (clean slate)')
    .option('--infra-dir <path>', 'Override the simulation infra directory (advanced)')
    .action((opts) => {
      const { projectName, infraDir } = buildContext(opts);
      const compose = findCompose(infraDir);
      if (!compose) {
        console.log(chalk.red('\n  x Simulation stack not initialized.'));
        notReadyHint(infraDir);
        process.exit(1);
      }
      console.log(chalk.yellow(`\n  Resetting simulation stack "${projectName}" (down -v + up -d)...\n`));
      dockerCompose(`-p ${projectName} down -v`, infraDir);
      dockerCompose(`-p ${projectName} up -d`,   infraDir);
    });

  sim.command('ps')
    .description('Show simulation stack container status')
    .option('--infra-dir <path>', 'Override the simulation infra directory (advanced)')
    .action((opts) => {
      const { projectName } = buildContext(opts);
      try {
        execSync(
          `docker ps -a --filter "label=com.docker.compose.project=${projectName}" --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"`,
          { stdio: 'inherit' });
      } catch {
        console.log(chalk.red('  x Docker not reachable.'));
      }
    });

  sim.command('logs [service]')
    .description('Stream logs from the simulation stack (optional: specific service)')
    .option('--infra-dir <path>', 'Override the simulation infra directory (advanced)')
    .action((service, opts) => {
      const { projectName, infraDir } = buildContext(opts);
      const compose = findCompose(infraDir);
      if (!compose) {
        console.log(chalk.red('\n  x Simulation stack not initialized.'));
        notReadyHint(infraDir);
        process.exit(1);
      }
      const svc = service ? ` ${service}` : '';
      dockerCompose(`-p ${projectName} logs -f${svc}`, infraDir);
    });
};
