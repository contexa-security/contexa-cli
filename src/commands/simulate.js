'use strict';

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawnSync } = require('child_process');
const { dockerCompose: dockerComposeExec } = require('../core/docker');
const { detectSpringProject } = require('../core/detector');
const { INSTALL_MODES, manifestPath, loadManifest, sha256FileSync } = require('../core/manifest');
const {
  SIMULATION_PROJECT,
  SIMULATION_PROFILE,
  SIMULATION_PORTS,
  simulationEnvironment,
  verifySimulationInfrastructure,
  waitForSimulationInfrastructure,
} = require('../core/simulation');

function dockerCompose(args, context, stdio = 'inherit') {
  const result = dockerComposeExec(args, {
    cwd: context.infraDir,
    env: context.env,
    stdio,
    timeout: 150000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited with status ${result.status}`);
  }
  return result;
}

async function buildContext(opts = {}) {
  const projectDir = path.resolve(opts.dir || process.cwd());
  if (!await fs.pathExists(manifestPath(projectDir, INSTALL_MODES.SIMULATION))) {
    throw new Error(`Simulation is not initialized for this project. Run: contexa init --simulate --dir "${projectDir}"`);
  }
  const manifest = await loadManifest(projectDir, INSTALL_MODES.SIMULATION);
  const metadata = manifest.metadata || {};
  const simulation = metadata.simulation || {};
  if (!metadata.installationId || metadata.projectName !== SIMULATION_PROJECT
      || simulation.projectName !== SIMULATION_PROJECT || simulation.profile !== SIMULATION_PROFILE) {
    throw new Error('Simulation manifest identity is incomplete or inconsistent. No Docker resource was changed.');
  }
  if (JSON.stringify(simulation.ports || {}) !== JSON.stringify(SIMULATION_PORTS)) {
    throw new Error('Simulation manifest port contract does not match this CLI release. No Docker resource was changed.');
  }
  const infraDir = metadata.infraDir && path.resolve(metadata.infraDir);
  if (!infraDir || (opts.infraDir && path.resolve(opts.infraDir) !== infraDir)) {
    throw new Error('The requested infrastructure directory does not match the simulation ownership manifest.');
  }
  const composePath = path.join(infraDir, 'docker-compose.yml');
  if (!await fs.pathExists(composePath)) {
    throw new Error(`Manifest-owned simulation compose file is missing: ${composePath}`);
  }
  if (!metadata.composeChecksum || sha256FileSync(composePath) !== metadata.composeChecksum) {
    throw new Error('Simulation compose file has changed since initialization. It was not executed.');
  }
  const containers = metadata.dockerResources && Array.isArray(metadata.dockerResources.containers)
    ? metadata.dockerResources.containers : [];
  const expectedContainers = ['postgres', 'redis', 'zookeeper', 'kafka', 'ollama']
    .map(service => `${SIMULATION_PROJECT}-${service}`).sort();
  if (JSON.stringify([...containers].sort()) !== JSON.stringify(expectedContainers)) {
    throw new Error('Simulation Docker resource contract is incomplete or contains an unexpected container.');
  }
  const ownedPath = relativePath => {
    if (typeof relativePath !== 'string' || !relativePath) {
      throw new Error('Simulation manifest is missing a managed project path.');
    }
    const candidate = path.resolve(projectDir, relativePath);
    if (candidate !== projectDir && !candidate.startsWith(projectDir + path.sep)) {
      throw new Error(`Simulation manifest path escapes the project: ${relativePath}`);
    }
    return candidate;
  };
  return {
    projectDir,
    infraDir,
    installationId: metadata.installationId,
    includeOllama: true,
    overlayPath: ownedPath(simulation.overlayPath),
    configurationPath: ownedPath(simulation.configurationPath),
    env: simulationEnvironment(process.env, metadata.installationId),
  };
}

function executeBuild(project, env) {
  let command;
  let args;
  let cwd = project.projectDir;
  if (project.buildTool === 'gradle') {
    const root = project.gradleRootDir || project.projectDir;
    const relativeModule = path.relative(root, project.projectDir);
    const task = relativeModule && relativeModule !== '.'
      ? `:${relativeModule.split(path.sep).join(':')}:bootRun`
      : 'bootRun';
    cwd = root;
    const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
    if (fs.existsSync(path.join(root, wrapperName))) {
      if (process.platform === 'win32') {
        command = process.env.ComSpec || 'cmd.exe';
        args = ['/d', '/s', '/c', `gradlew.bat ${task}`];
      } else {
        command = './gradlew';
        args = [task];
      }
    } else {
      command = 'gradle';
      args = [task];
    }
  } else if (project.buildTool === 'maven') {
    const wrapperName = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
    if (fs.existsSync(path.join(project.projectDir, wrapperName))) {
      if (process.platform === 'win32') {
        command = process.env.ComSpec || 'cmd.exe';
        args = ['/d', '/s', '/c', 'mvnw.cmd spring-boot:run'];
      } else {
        command = './mvnw';
        args = ['spring-boot:run'];
      }
    } else {
      command = 'mvn';
      args = ['spring-boot:run'];
    }
  } else {
    throw new Error('The simulation project must use Gradle or Maven.');
  }
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Application process exited with status ${result.status}`);
}

function addContextOptions(command) {
  return command
    .option('--dir <path>', 'Spring project directory', process.cwd())
    .option('--infra-dir <path>', 'Require this exact manifest-owned infrastructure directory');
}

module.exports = function registerSimulationCommands(program) {
  const sim = program.command('simulate')
    .description('Manage the isolated stack created by "contexa init --simulate"');

  addContextOptions(sim.command('up').description('Start and verify the simulation stack'))
    .action(async opts => {
      const context = await buildContext(opts);
      dockerCompose(['-p', SIMULATION_PROJECT, 'up', '-d'], context);
      await waitForSimulationInfrastructure(context.installationId, context.includeOllama);
      console.log(chalk.green('  v Simulation infrastructure is healthy and ownership-verified.'));
    });

  addContextOptions(sim.command('down').description('Stop the simulation stack and keep its volumes'))
    .action(async opts => {
      const context = await buildContext(opts);
      dockerCompose(['-p', SIMULATION_PROJECT, 'down', '--timeout', '0'], context);
    });

  addContextOptions(sim.command('reset').description('Recreate only the simulation stack and its volumes'))
    .action(async opts => {
      const context = await buildContext(opts);
      dockerCompose(['-p', SIMULATION_PROJECT, 'down', '-v', '--timeout', '0'], context);
      dockerCompose(['-p', SIMULATION_PROJECT, 'up', '-d'], context);
      await waitForSimulationInfrastructure(context.installationId, context.includeOllama);
    });

  addContextOptions(sim.command('ps').description('Show simulation container status'))
    .action(async opts => dockerCompose(['-p', SIMULATION_PROJECT, 'ps'], await buildContext(opts)));

  addContextOptions(sim.command('logs [service]').description('Stream simulation logs'))
    .action(async (service, opts) => {
      const context = await buildContext(opts);
      const args = ['-p', SIMULATION_PROJECT, 'logs', '-f'];
      if (service) args.push(service);
      dockerCompose(args, context);
    });

  addContextOptions(sim.command('run').description('Run the host application with only the simulation profile'))
    .action(async opts => {
      const context = await buildContext(opts);
      if (!await fs.pathExists(context.overlayPath)) {
        throw new Error(`Simulation overlay is missing: ${context.overlayPath}`);
      }
      if (!await fs.pathExists(context.configurationPath)) {
        throw new Error(`Simulation profile configuration is missing: ${context.configurationPath}`);
      }
      const project = await detectSpringProject(context.projectDir);
      if (!project.isSpring || !project.hasContexta) {
        throw new Error('The manifest project is not a Contexa Spring Boot application.');
      }
      verifySimulationInfrastructure(context.installationId, context.includeOllama);
      executeBuild(project, simulationEnvironment(context.env, context.installationId, true));
    });
};

module.exports.buildContext = buildContext;
