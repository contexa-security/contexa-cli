'use strict';

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { dockerCompose: dockerComposeExec } = require('../core/docker');
const { detectSpringProject } = require('../core/detector');
const { t } = require('../core/i18n');
const {
  INSTALL_MODES,
  acquireInstallLock,
  manifestPath,
  loadManifest,
  recordInstallMetadata,
  releaseInstallLock,
  sha256FileSync,
} = require('../core/manifest');
const { TIMEOUTS } = require('../core/timeouts');
const {
  SIMULATION_PROJECT,
  SIMULATION_PROFILE,
  SIMULATION_PORTS,
  simulationEnvironment,
  verifySimulationInfrastructure,
  waitForSimulationInfrastructure,
} = require('../core/simulation');

function simulationError(code, key, ...args) {
  const error = new Error(`${code} ${t(key, ...args)}`);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

function dockerCompose(args, context, stdio = 'inherit', execute = dockerComposeExec) {
  const result = execute(args, {
    cwd: context.infraDir,
    env: context.env,
    stdio,
    timeout: TIMEOUTS.dockerComposeMutationMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw simulationError('SIMULATION_DOCKER_FAILED', 'simulate.error.docker', args.join(' '), result.status);
  }
  return result;
}

async function buildContext(opts = {}) {
  const projectDir = path.resolve(opts.dir || process.cwd());
  if (!await fs.pathExists(manifestPath(projectDir, INSTALL_MODES.SIMULATION))) {
    throw simulationError('SIMULATION_NOT_INITIALIZED', 'simulate.error.notInitialized', projectDir);
  }
  const manifest = await loadManifest(projectDir, INSTALL_MODES.SIMULATION);
  const metadata = manifest.metadata || {};
  const simulation = metadata.simulation || {};
  if (!metadata.installationId || metadata.projectName !== SIMULATION_PROJECT
      || simulation.projectName !== SIMULATION_PROJECT || simulation.profile !== SIMULATION_PROFILE) {
    throw simulationError('SIMULATION_IDENTITY_CONFLICT', 'simulate.error.identity');
  }
  if (JSON.stringify(simulation.ports || {}) !== JSON.stringify(SIMULATION_PORTS)) {
    throw simulationError('SIMULATION_PORT_CONFLICT', 'simulate.error.ports');
  }
  const infraDir = metadata.infraDir && path.resolve(metadata.infraDir);
  if (!infraDir || (opts.infraDir && path.resolve(opts.infraDir) !== infraDir)) {
    throw simulationError('SIMULATION_INFRA_CONFLICT', 'simulate.error.infra');
  }
  const composePath = path.join(infraDir, 'docker-compose.yml');
  if (!await fs.pathExists(composePath)) {
    throw simulationError('SIMULATION_COMPOSE_MISSING', 'simulate.error.composeMissing', composePath);
  }
  if (!metadata.composeChecksum || sha256FileSync(composePath) !== metadata.composeChecksum) {
    throw simulationError('SIMULATION_COMPOSE_CHANGED', 'simulate.error.composeChanged');
  }
  const containers = metadata.dockerResources && Array.isArray(metadata.dockerResources.containers)
    ? metadata.dockerResources.containers : [];
  const expectedContainers = ['postgres', 'redis', 'zookeeper', 'kafka', 'ollama']
    .map(service => `${SIMULATION_PROJECT}-${service}`).sort();
  if (JSON.stringify([...containers].sort()) !== JSON.stringify(expectedContainers)) {
    throw simulationError('SIMULATION_RESOURCE_CONFLICT', 'simulate.error.resources');
  }
  const ownedPath = relativePath => {
    if (typeof relativePath !== 'string' || !relativePath) {
      throw simulationError('SIMULATION_PATH_MISSING', 'simulate.error.pathMissing');
    }
    const candidate = path.resolve(projectDir, relativePath);
    if (candidate !== projectDir && !candidate.startsWith(projectDir + path.sep)) {
      throw simulationError('SIMULATION_PATH_ESCAPE', 'simulate.error.pathEscape', relativePath);
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

function buildLaunchSpec(project) {
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
    throw simulationError('SIMULATION_BUILD_UNSUPPORTED', 'simulate.error.build');
  }
  return { command, args, cwd };
}

function probeApplication(port = 9080, timeoutMs = TIMEOUTS.httpHealthProbeMs) {
  return new Promise(resolve => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/',
      timeout: timeoutMs,
    }, response => {
      response.resume();
      resolve(true);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
  });
}

function stopOwnedChild(child, signal = 'SIGTERM', platform = process.platform) {
  if (!child || !child.pid || child.exitCode !== null || child.killed) return false;
  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      if (child.exitCode === null) child.kill(signal);
    }
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (child.exitCode === null) child.kill(signal);
    }
  }
  return true;
}

async function executeBuild(project, env, options = {}) {
  const spec = buildLaunchSpec(project);
  const launch = options.spawn || spawn;
  const probe = options.probe || probeApplication;
  const delay = options.delay || (milliseconds =>
    new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const readyTimeoutMs = options.readyTimeoutMs === undefined
    ? TIMEOUTS.simulationApplicationReadyMs : Number(options.readyTimeoutMs);
  const pollMs = options.pollMs === undefined
    ? TIMEOUTS.simulationApplicationPollMs : Number(options.pollMs);
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0
      || !Number.isFinite(pollMs) || pollMs < 0) {
    throw new Error('Simulation application readiness timeout and poll interval must be bounded.');
  }

  const child = launch(spec.command, spec.args, {
    cwd: spec.cwd,
    env,
    stdio: 'inherit',
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  let interruptedSignal = null;
  const terminate = signal => {
    interruptedSignal = signal;
    (options.stopChild || stopOwnedChild)(child, 'SIGTERM');
  };
  const onSigint = () => terminate('SIGINT');
  const onSigterm = () => terminate('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = now() + readyTimeoutMs;
  let ready = false;
  try {
    while (!ready && now() < deadline) {
      const outcome = await Promise.race([
        exited.then(exit => ({ exit })),
        Promise.resolve(probe(9080, TIMEOUTS.httpHealthProbeMs))
          .then(value => ({ ready: value === true })),
      ]);
      if (outcome.exit) {
        throw simulationError('SIMULATION_APPLICATION_FAILED',
          'simulate.error.application', outcome.exit.code ?? outcome.exit.signal ?? 'unknown');
      }
      ready = outcome.ready;
      if (!ready && now() < deadline) {
        await delay(Math.min(pollMs, Math.max(0, deadline - now())));
      }
    }
    if (!ready) {
      (options.stopChild || stopOwnedChild)(child, 'SIGTERM');
      throw simulationError('SIMULATION_APPLICATION_READY_TIMEOUT',
        'simulate.error.applicationReady', readyTimeoutMs);
    }
    console.log(chalk.green(`  v ${t('simulate.run.ready', 9080)}`));
    const result = await exited;
    if (interruptedSignal) {
      throw simulationError('SIMULATION_APPLICATION_INTERRUPTED',
        'simulate.error.applicationInterrupted', interruptedSignal);
    }
    if (result.code !== 0) {
      throw simulationError('SIMULATION_APPLICATION_FAILED',
        'simulate.error.application', result.code ?? result.signal ?? 'unknown');
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

function addContextOptions(command) {
  return command
    .option('--dir <path>', t('simulate.option.dir'), process.cwd())
    .option('--infra-dir <path>', t('simulate.option.infraDir'));
}

async function withSimulationMutation(opts, mutation) {
  const projectDir = path.resolve(opts.dir || process.cwd());
  const lock = await acquireInstallLock(projectDir, INSTALL_MODES.SIMULATION);
  try {
    const context = await buildContext({ ...opts, dir: projectDir });
    return await mutation(context);
  } finally {
    await releaseInstallLock(lock);
  }
}

async function markDockerLifecycleManaged(context) {
  await recordInstallMetadata(context.projectDir, {
    dockerLifecycleManaged: true,
  }, INSTALL_MODES.SIMULATION);
}

module.exports = function registerSimulationCommands(program) {
  const sim = program.command('simulate')
    .description(t('simulate.description'));

  addContextOptions(sim.command('up').description(t('simulate.up.description')))
    .action(async opts => {
      await withSimulationMutation(opts, async context => {
        await markDockerLifecycleManaged(context);
        dockerCompose(['-p', SIMULATION_PROJECT, 'up', '-d'], context);
        await waitForSimulationInfrastructure(context.installationId, context.includeOllama);
        console.log(chalk.green(`  v ${t('simulate.up.success')}`));
      });
    });

  addContextOptions(sim.command('down').description(t('simulate.down.description')))
    .action(async opts => {
      await withSimulationMutation(opts, async context => {
        dockerCompose(['-p', SIMULATION_PROJECT, 'down', '--timeout', '0'], context);
      });
    });

  addContextOptions(sim.command('reset').description(t('simulate.reset.description')))
    .action(async opts => {
      await withSimulationMutation(opts, async context => {
        await markDockerLifecycleManaged(context);
        dockerCompose(['-p', SIMULATION_PROJECT, 'down', '-v', '--timeout', '0'], context);
        dockerCompose(['-p', SIMULATION_PROJECT, 'up', '-d'], context);
        await waitForSimulationInfrastructure(context.installationId, context.includeOllama);
      });
    });

  addContextOptions(sim.command('ps').description(t('simulate.ps.description')))
    .action(async opts => dockerCompose(['-p', SIMULATION_PROJECT, 'ps'], await buildContext(opts)));

  addContextOptions(sim.command('logs [service]').description(t('simulate.logs.description')))
    .action(async (service, opts) => {
      const context = await buildContext(opts);
      const args = ['-p', SIMULATION_PROJECT, 'logs', '-f'];
      if (service) args.push(service);
      dockerCompose(args, context);
    });

  addContextOptions(sim.command('run').description(t('simulate.run.description')))
    .action(async opts => {
      const context = await buildContext(opts);
      if (!await fs.pathExists(context.overlayPath)) {
        throw simulationError('SIMULATION_OVERLAY_MISSING', 'simulate.error.overlay', context.overlayPath);
      }
      if (!await fs.pathExists(context.configurationPath)) {
        throw simulationError('SIMULATION_CONFIGURATION_MISSING', 'simulate.error.configuration', context.configurationPath);
      }
      const project = await detectSpringProject(context.projectDir);
      if (!project.isSpring || !project.hasContexta) {
        throw simulationError('SIMULATION_PROJECT_INVALID', 'simulate.error.project');
      }
      verifySimulationInfrastructure(context.installationId, context.includeOllama);
      await executeBuild(project,
        simulationEnvironment(context.env, context.installationId, true));
    });
};

module.exports.buildContext = buildContext;
module.exports.executeCompose = dockerCompose;
module.exports.buildLaunchSpec = buildLaunchSpec;
module.exports.executeBuild = executeBuild;
module.exports.stopOwnedChild = stopOwnedChild;
module.exports.markDockerLifecycleManaged = markDockerLifecycleManaged;
