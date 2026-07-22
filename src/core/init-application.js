'use strict';

const chalk = require('chalk');
const crypto = require('crypto');
const ora   = require('ora');
const path  = require('path');
const fs    = require('fs-extra');
const {
  dockerCompose,
  dockerComposeDown,
  inspectDockerLabels,
  isDockerCliInstalled,
  isDockerDaemonRunning,
} = require('./docker');
const releaseManifest = require('../../release-manifest.json');
const { pullOllamaModelWithProgress, waitForDockerOllama } = require('./ollama');
const {
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  isValidOllamaModel,
} = require('./provider');
const { DEFAULT_INFRASTRUCTURE_PORTS, configuredPort } = require('./infrastructure');
const { TIMEOUTS } = require('./timeouts');
const {
  aiProviderSelected,
  normalizePath,
  printPlannedChanges,
  trackedFileState,
  activationResult,
} = require('./init-plan');
const { collectInitAnswers } = require('./init-input');
const { printInitCompletion } = require('./init-report');
const { runPreinstallationChecks } = require('./init-diagnostics');
const { detectSpringProject } = require('./detector');
const { ensureVerifiedArtifact } = require('./artifact');
const { injectYml, normalOverlayPath, injectMavenDep, injectGradleDep, injectDistributedDeps,
        injectSpringAiDeps, injectEnableAiSecurity, inspectAiDependencies, injectStandalone,
        generateDockerCompose } = require('./injector');
const { inspectInfra } = require('./preflight');
const {
  resolveProjectName,
  containerName,
  resolveInfraDir,
  assertSafeInfraDir,
} = require('./project');
const { t, formatError } = require('./i18n');
const {
  INSTALL_MODES,
  acquireInstallLock,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareDockerMutation,
  prepareExternalFileChange,
  recordDockerMutationApplied,
  recordExternalFileChange,
  recordChange,
  recordInstallMetadata,
  releaseInstallLock,
  rollbackInstallTransaction,
  sha256FileSync,
} = require('./manifest');
const { buildDockerResourceContract, performOwnedDockerCleanup } = require('./reset-service');
const {
  SIMULATION_PORTS,
  SIMULATION_PROFILE,
  SIMULATION_PROJECT,
  simulationConfigurationPath,
  simulationEnvironment,
  simulationGeoIpPath,
  simulationOverlayPath,
  waitForSimulationInfrastructure,
  writeSimulationConfiguration,
} = require('./simulation');

function initError(code, key, ...args) {
  const error = new Error(`${code} ${t(key, ...args)}`);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

function normalizeInitInputError(error) {
  const message = error && error.message ? error.message : '';
  if (/^(?:Gradle script|Maven XML) is malformed:/.test(message)) {
    return initError('INVALID_BUILD_FILE', 'init.error.malformedBuild', message);
  }
  const overlayPrefix = 'Contexa overlay path is already user-owned: ';
  if (message.startsWith(overlayPrefix)) {
    return initError('CONTEXA_OVERLAY_USER_OWNED',
      'init.error.overlayUserOwned', message.slice(overlayPrefix.length));
  }
  if (error && error.name === 'YAMLException') {
    return initError('INVALID_CONTEXA_YAML', 'init.error.malformedYaml', message);
  }
  return error;
}

async function recoverInterruptedDockerMutation(dockerMutation) {
  if (!dockerMutation || dockerMutation.action === 'REUSE') {
    return { removed: [], restored: [], preserved: [], conflict: [], failed: [] };
  }
  const installationId = dockerMutation.contract.installationId;
  const env = dockerMutation.contract.mode === INSTALL_MODES.SIMULATION
    ? simulationEnvironment(process.env, installationId)
    : { ...process.env, CONTEXA_PROJECT: dockerMutation.projectName };
  return performOwnedDockerCleanup({
    contract: dockerMutation.contract,
    mode: dockerMutation.contract.mode,
    installationId,
    projectName: dockerMutation.projectName,
    infraDir: dockerMutation.infraDir,
    composeChecksum: dockerMutation.composeChecksum,
    env,
  }, {
    isCliInstalled: isDockerCliInstalled,
    isDaemonRunning: isDockerDaemonRunning,
    inspectLabels: inspectDockerLabels,
    composeDown: (projectName, infraDir, composeEnv) => dockerComposeDown(
      projectName,
      infraDir,
      composeEnv,
      { removeVolumes: dockerMutation.removeVolumes }
    ),
  });
}

async function refreshExistingInstallationMetadata(projectDir, project) {
  if (project.contextaVersion !== releaseManifest.starter.version) return false;
  if (!await fs.pathExists(manifestPath(projectDir, INSTALL_MODES.NORMAL))) return false;

  let lock = null;
  try {
    lock = await acquireInstallLock(projectDir, INSTALL_MODES.NORMAL);
    const current = await loadManifest(projectDir, INSTALL_MODES.NORMAL);
    if (current.metadata.cliVersion === releaseManifest.cliVersion
        && current.metadata.starterVersion === releaseManifest.starter.version) {
      return false;
    }
    await recordInstallMetadata(projectDir, {}, INSTALL_MODES.NORMAL);
    return true;
  } finally {
    await releaseInstallLock(lock);
  }
}

async function executeInit(opts) {
      const installMode = opts.simulate ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
      let installLock = null;
      let installTransactionId = null;
      let transactionManifestExisted = false;
      try {
      // --simulate isolates this run from any other contexa stack on the same
      // host: separate compose project name, separate container names, and
      // separate ports. Implemented as preset env vars consumed by both the
      // generated docker-compose.yml and the runtime contexa.* / spring.*
      // env-fallback placeholders the CLI writes into application.yml.
      if (opts.simulate) {
        opts.distributed = true;
        // --simulate stack is fully isolated and meant for hands-on practice
        // without external API keys; Ollama is auto-included here so the demo
        // works end-to-end with no cloud credentials.
        opts.includeOllama = true;
        Object.assign(process.env, simulationEnvironment(process.env, 'preflight'));
        console.log(chalk.cyan(`\n  ${t('init.simulation.title')}`));
        console.log(chalk.gray(`    ${t('init.simulation.postgres', SIMULATION_PORTS.postgres, DEFAULT_INFRASTRUCTURE_PORTS.postgres)}`));
        console.log(chalk.gray(`    ${t('init.simulation.ollama', SIMULATION_PORTS.ollama, DEFAULT_INFRASTRUCTURE_PORTS.ollama)}`));
        console.log(chalk.gray(`    ${t('init.simulation.redis', SIMULATION_PORTS.redis)}`));
        console.log(chalk.gray(`    ${t('init.simulation.kafka', SIMULATION_PORTS.kafka)}`));
        console.log(chalk.gray(`    ${t('init.simulation.hostPreserved')}`));
        console.log(chalk.gray(`    ${t('init.simulation.reset')}`));
        console.log(chalk.gray(`    ${t('init.simulation.manage')}`));
      }
      if (opts.distributed) {
        console.log(chalk.yellow('\n  ! ' + t('init.distributed.warning')));
        console.log(chalk.gray('    ' + t('init.distributed.note') + '\n'));
      }
      console.log('');

      if (runPreinstallationChecks(opts)) return;

      // 1. Detect project
      const spinner = ora(t('init.detecting')).start();
      let project;
      try {
        project = await detectSpringProject(opts.dir, {
          // Quick and Custom can both provision infrastructure. Detect Docker
          // before prompting so the selected startDocker contract is honoured.
          probeDocker: true,
        });
      } catch (error) {
        spinner.stop();
        throw normalizeInitInputError(error);
      }
      spinner.stop();

      if (!project.isSpring) {
        console.log(chalk.red('  x ' + t('init.notSpring')));
        console.log(chalk.gray('    ' + t('init.notSpring.hint') + '\n'));
        throw initError('SPRING_PROJECT_REQUIRED', 'init.notSpring');
      }
      if (opts.simulate && !project.hasContexta) {
        throw initError('SIMULATION_STARTER_REQUIRED', 'init.error.simulationStarterRequired');
      }

      console.log(chalk.green('  v ' + t('init.detected')));
      console.log(chalk.gray(`    ${t('init.detected.project')} : ${project.projectName || t('common.unknown')}`));
      console.log(chalk.gray(`    ${t('init.detected.build')}   : ${project.buildTool}`));
      console.log(chalk.gray(`    ${t('init.detected.security')}: ${project.hasSpringSecurityCore ? t('init.security.springSecurity') : chalk.yellow(t('init.security.legacy'))}`));
      console.log(chalk.gray(`    ${t('init.detected.docker')}  : ${project.hasDocker
        ? chalk.green(t('init.docker.installed'))
        : chalk.yellow(t('init.docker.missing'))}`));

      const cliProjectName = opts.simulate
        ? SIMULATION_PROJECT
        : resolveProjectName(project.projectName || path.basename(path.resolve(opts.dir)));
      if (!process.env.CONTEXA_PROJECT) {
        process.env.CONTEXA_PROJECT = cliProjectName;
      }

      // Warn when both application.properties and application.yml exist - one shadows the other.
      if (project.appPropertiesPath && project.appYmlPath) {
        console.log(chalk.yellow('  ! ' + t('scan.propertiesAndYml')));
      }

      // Simulation has its own ownership state. An existing starter is its
      // prerequisite, not a reason to return from this command.
      const normalOwnershipManifestExists = !opts.simulate
        && await fs.pathExists(manifestPath(opts.dir, INSTALL_MODES.NORMAL));
      if (project.hasContexta && !opts.simulate
          && (project.hasEnableAiSecurity || normalOwnershipManifestExists)) {
        if (!opts.force && !opts.yes) {
          await refreshExistingInstallationMetadata(opts.dir, project);
          console.log(chalk.yellow('  ' + t('init.alreadyDetected')));
          console.log(chalk.gray('    ' + t('init.alreadyDetected.hint') + '\n'));
          return;
        }
        console.log(chalk.yellow('  ' + t('init.alreadyDetected.update') + '\n'));
      }

      // 2. Prompts
      //
      // Decision policy: the user is NOT expected to know any flag names. Every
      // non-trivial decision is asked by inquirer when running `contexa init`
      // without flags. Flags only exist as prompt-bypass for advanced users /
      // CI automation:
      //   --lang ko|en                  bypass the language prompt
      //   --merge / --standalone        bypass the integration-mode prompt
      //   --standalone-dir <path>       bypass the standalone-folder prompt
      //   --infra-dir <path>            bypass the infra-folder prompt
      //   --distributed                 explicit "install distributed infra" intent
      //   --simulate                    explicit "isolated simulation" intent
      //   --no-docker                   explicit "do not start containers" intent
      //   --yes                         CI automation: skip every prompt
      //
      // The detected locale remains the default. --lang is the only language
      // override, so an Enter-only install does not spend a question on locale.

      const answers = await collectInitAnswers(opts, project, cliProjectName);

      if (!project.hasDocker && answers.infra !== 'skip' && answers.startDocker) {
        console.log('');
        console.log(chalk.yellow(`  ! ${t('init.docker.required')}`));
        console.log(chalk.gray(`    ${t('init.docker.composeOnly')}`));
        console.log(chalk.gray(`    ${t('init.docker.install')}`));
        console.log(chalk.gray('      Windows / macOS : https://www.docker.com/products/docker-desktop'));
        console.log(chalk.gray('      Linux           : https://docs.docker.com/engine/install/'));
        console.log(chalk.gray(`    ${t('init.docker.skipHint')}`));
        console.log('');
        // Preserve the selected infrastructure files, but do not claim that
        // containers were started when Docker is unavailable.
        answers.startDocker = false;
      }



      // Resolve standalone dir
      const standaloneDir = answers.integrationMode === 'standalone'
        ? (normalizePath(opts.standaloneDir, opts.dir)
            || normalizePath(answers.standaloneDir, opts.dir)
            || path.resolve(opts.dir, 'contexa'))
        : null;

      // Resolve infra dir
      const requestedInfraDir = opts.infraDir || answers.infraDir || null;
      const infraDirOverride = normalizePath(opts.infraDir, opts.dir)
        || normalizePath(answers.infraDir, opts.dir)
        || null;

      const projectOwnerDir = project.projectDir || opts.dir;
      const plannedYmlPath = opts.simulate
        ? simulationOverlayPath(projectOwnerDir)
        : normalOverlayPath(projectOwnerDir);
      const plannedSimulationConfigPath = opts.simulate ? simulationConfigurationPath(project) : null;
      const shouldWriteOverlay = answers.integrationMode === 'merge'
        && (answers.enableAiSecurity || answers.infra !== 'skip' || answers.simulate);
      const plannedBuildPath = project.buildFilePath
        || (project.buildTool === 'maven' ? path.join(projectOwnerDir, 'pom.xml') : path.join(projectOwnerDir, 'build.gradle'));
      const plannedGeoIpPath = (answers.enableAiSecurity || answers.simulate)
        ? (opts.simulate
            ? simulationGeoIpPath(opts.dir)
            : path.join(opts.dir, 'contexa', 'data', 'GeoLite2-City.mmdb'))
        : null;
      const plannedInfraDir = answers.infra !== 'skip'
        ? resolveInfraDir(cliProjectName, { infraDir: infraDirOverride })
        : null;
      if (plannedInfraDir) {
        await assertSafeInfraDir(opts.dir, plannedInfraDir, requestedInfraDir);
      }
      const plannedComposePath = plannedInfraDir ? path.join(plannedInfraDir, 'docker-compose.yml') : null;
      const plannedYmlExists = await fs.pathExists(plannedYmlPath);
      const plannedBuildExists = await fs.pathExists(plannedBuildPath);
      const plannedSimulationConfigExists = plannedSimulationConfigPath
        ? await fs.pathExists(plannedSimulationConfigPath) : false;
      const plannedGeoIpExists = plannedGeoIpPath ? await fs.pathExists(plannedGeoIpPath) : false;
      const plannedComposeExists = plannedComposePath ? await fs.pathExists(plannedComposePath) : false;
      const plannedStandaloneBuildPath = answers.integrationMode === 'standalone'
        ? path.join(standaloneDir, project.buildTool === 'maven' ? 'pom-fragment.xml' : 'contexa.gradle')
        : null;
      const plannedStandaloneYmlPath = answers.integrationMode === 'standalone'
        ? path.join(standaloneDir, 'application.yml')
        : null;
      const plannedStandaloneYmlExists = plannedStandaloneYmlPath
        ? await fs.pathExists(plannedStandaloneYmlPath) : false;
      const plannedStandaloneBuildExists = plannedStandaloneBuildPath
        ? await fs.pathExists(plannedStandaloneBuildPath) : false;
      const plannedFiles = answers.integrationMode === 'standalone'
        ? [
            { filePath: plannedStandaloneYmlPath, kind: 'standalone-config', generated: !plannedStandaloneYmlExists },
            { filePath: plannedStandaloneBuildPath, kind: 'standalone-build', generated: !plannedStandaloneBuildExists },
          ]
        : [
            ...(!opts.simulate ? [{ filePath: plannedBuildPath, kind: 'build-file' }] : []),
            ...(shouldWriteOverlay ? [{
              filePath: plannedYmlPath,
              kind: opts.simulate ? 'simulation-overlay' : 'contexa-overlay',
              generated: !plannedYmlExists,
            }] : []),
            ...(plannedSimulationConfigPath ? [{
              filePath: plannedSimulationConfigPath,
              kind: 'simulation-profile-configuration',
              generated: !plannedSimulationConfigExists,
            }] : []),
          ];
      if (plannedGeoIpPath) {
        plannedFiles.push({ filePath: plannedGeoIpPath, kind: 'geoip-data', generated: true });
      }
      if (answers.enableAiSecurity && answers.autoAnnotate
          && Array.isArray(project.mainApplicationCandidates)
          && project.mainApplicationCandidates.length === 1) {
        plannedFiles.push({
          filePath: project.mainApplicationCandidates[0],
          kind: 'application-source',
          generated: false,
        });
      }

      printPlannedChanges(answers, project, answers.integrationMode === 'standalone'
        ? {
            standaloneDir,
            composePath: plannedComposePath,
            composeExists: plannedComposeExists,
            geoIpPath: plannedGeoIpPath,
            geoIpExists: plannedGeoIpExists,
            geoIpLocalSource: process.env.CONTEXA_GEOLITE2_SOURCE_PATH,
          }
        : {
            ymlPath: plannedYmlPath,
            buildPath: plannedBuildPath,
            simulationConfigPath: plannedSimulationConfigPath,
            simulationConfigExists: plannedSimulationConfigExists,
            ymlExists: plannedYmlExists,
            writeOverlay: shouldWriteOverlay,
            buildExists: plannedBuildExists,
            composePath: plannedComposePath,
            composeExists: plannedComposeExists,
            geoIpPath: plannedGeoIpPath,
            geoIpExists: plannedGeoIpExists,
            geoIpLocalSource: process.env.CONTEXA_GEOLITE2_SOURCE_PATH,
          });

      const preflightManifest = await loadManifest(opts.dir, installMode);
      let plannedInfraIssues = [];
      if (answers.infra !== 'skip') {
        plannedInfraIssues = await inspectInfra({
          infra: answers.infra,
          startDocker: answers.startDocker,
          includeOllama: !!(answers.llmProviders && answers.llmProviders.includes('ollama')),
          strictIsolation: !!opts.simulate,
          projectName: cliProjectName,
          installationId: preflightManifest.metadata && preflightManifest.metadata.installationId,
        });
        for (const issue of plannedInfraIssues) {
          const paint = issue.severity === 'error' ? chalk.red : issue.severity === 'warning' ? chalk.yellow : chalk.gray;
          console.log(paint(`  ${issue.severity === 'error' ? 'x' : issue.severity === 'warning' ? '!' : 'i'} ${issue.message}`));
          for (const hint of (issue.hint || [])) console.log(chalk.gray(`    - ${hint}`));
        }
        const preflightErrors = plannedInfraIssues.filter(issue => issue.severity === 'error');
        if (preflightErrors.length > 0) {
          throw initError('INFRASTRUCTURE_PREFLIGHT_FAILED', 'init.error.preflight');
        }
      }

      installLock = await acquireInstallLock(opts.dir, installMode, 'init');
      transactionManifestExisted = await fs.pathExists(manifestPath(opts.dir, installMode));
      installTransactionId = await beginInstallTransaction(opts.dir, {
        projectName: cliProjectName,
        integrationMode: answers.integrationMode,
        infra: answers.infra,
        infraDir: plannedInfraDir,
        simInfraDir: opts.simulate ? resolveInfraDir('ctxa-sim', { infraDir: infraDirOverride }) : null,
        dockerLifecycleManaged: answers.infra !== 'skip' && Boolean(answers.startDocker),
        aiSecurityRequested: !!answers.enableAiSecurity,
        aiSecurityEnabled: false,
      }, installMode, plannedFiles, {
        recoverDocker: recoverInterruptedDockerMutation,
      });
      const installManifest = await loadManifest(opts.dir, installMode);
      const installationId = installManifest.metadata.installationId;
      if (Object.keys(plannedInfraIssues.identityFingerprints || {}).length > 0) {
        await recordInstallMetadata(opts.dir, {
          preflightServiceIdentity: {
            verifiedAt: new Date().toISOString(),
            fingerprints: plannedInfraIssues.identityFingerprints,
          },
        }, installMode);
      }
      if (opts.simulate) {
        Object.assign(process.env, simulationEnvironment(process.env, installationId));
        await recordInstallMetadata(opts.dir, {
          simulation: {
            projectName: SIMULATION_PROJECT,
            profile: SIMULATION_PROFILE,
            ports: SIMULATION_PORTS,
            overlayPath: path.relative(opts.dir, plannedYmlPath).split(path.sep).join('/'),
            configurationPath: path.relative(opts.dir, plannedSimulationConfigPath).split(path.sep).join('/'),
          },
        }, installMode);
      }

      if (answers.enableAiSecurity || answers.simulate) {
        // Provision GeoLite2-City.mmdb only when AI security or simulation is explicitly selected.
        const startGeo = process.hrtime.bigint();
        const sGeo = ora(t('step.provisioningGeoIp')).start();
        try {
          const geoIpContract = releaseManifest.resources && releaseManifest.resources.geoIp;
          if (!geoIpContract) {
            throw initError('GEOIP_CONTRACT_MISSING', 'init.error.geoIpContractMissing');
          }
          const provisioned = await ensureVerifiedArtifact(geoIpContract, {
            destination: plannedGeoIpPath,
            sourcePath: process.env.CONTEXA_GEOLITE2_SOURCE_PATH || null,
            timeoutMs: TIMEOUTS.artifactDownloadMs,
          });
          if (provisioned.changed) {
            await recordChange(opts.dir, plannedGeoIpPath, { kind: 'geoip-data', generated: true, reason: 'Verified GeoIP context for explicit AI security setup' }, installMode);
          }
          const action = provisioned.changed
            ? (process.env.CONTEXA_GEOLITE2_SOURCE_PATH ? 'copied and verified' : 'downloaded and verified')
            : 'already present and verified';
          sGeo.succeed(`GeoLite2-City.mmdb ${action} (${(Number(process.hrtime.bigint() - startGeo) / 1e6).toFixed(0)}ms)`);
        } catch (err) {
          sGeo.fail(`Failed to provision GeoLite2-City.mmdb: ${err.message}`);
          throw err;
        }
      }

      console.log('');

      // 3 + 4. Apply contexa configuration to the customer project.
      //
      // Two integration modes:
      //   merge      - mutate the customer's application.yml and build file
      //                in-place (single transaction with .bak rollback).
      //   standalone - write contexa-only artifacts to a separate folder; the
      //                customer's project files are NEVER touched.
      let standaloneResult = null;
      let aiAnnotationApplied = !!project.hasEnableAiSecurity;
      let aiDependenciesProcessed = false;
      if (answers.integrationMode === 'standalone') {
        console.log(chalk.cyan('\n  ' + t('standalone.intro')));
        console.log(chalk.gray(`  ${t('standalone.location')} ${standaloneDir}`));
        const startStandalone = process.hrtime.bigint();
        const sStandalone = ora(t('step.writingStandalone')).start();
        try {
          // Pass --force so injectStandalone will overwrite an existing
          // non-empty folder. Without --force, a non-empty folder that does
          // not look like a previous contexa-cli output is rejected up-front.
          standaloneResult = await injectStandalone(standaloneDir, project, {
            ...answers,
            force: !!opts.force,
            preparedPaths: plannedGeoIpPath ? [plannedGeoIpPath] : [],
          });
          await recordChange(opts.dir, standaloneResult.ymlPath, {
            kind: 'standalone-config', generated: plannedFiles[0].generated,
            reason: 'Contexa standalone configuration output',
          }, installMode);
          await recordChange(opts.dir, standaloneResult.buildFragmentPath, {
            kind: 'standalone-build', generated: plannedFiles[1].generated,
            reason: 'Contexa standalone build output',
          }, installMode);
          const elapsed = Number(process.hrtime.bigint() - startStandalone) / 1e6;
          sStandalone.succeed(`${t('step.standaloneWritten')} (${elapsed.toFixed(0)}ms)`);
        } catch (err) {
          sStandalone.fail(t('step.standaloneWritten'));
          console.log('');
          console.log(chalk.red(`  x ${t('init.error.standaloneWrite')}`));
          console.log(chalk.gray('    ' + formatError(err)));
          console.log('');
          throw err;
        }
      } else {
        // Merge mode: yml + build mutation as a SINGLE transaction. If any step
        // inside fails, every change in this block is rolled back from its .bak
        // so the customer never ends up with a half-applied install (e.g. yml
        // mutated but build dep missing).
        const ymlPath = plannedYmlPath;
        const buildPath = plannedBuildPath;
        const ymlExistedBefore = await fs.pathExists(ymlPath);

        if (shouldWriteOverlay) {
          // Selected activation/infrastructure settings are written only to
          // the Contexa-owned overlay; the host application.yml stays intact.
          const startYml = process.hrtime.bigint();
          const s1 = ora(t('step.updatingYml')).start();
          try {
            const ymlState = trackedFileState(installManifest, opts.dir, ymlPath);
            if (ymlState.userModified || (ymlState.entry
                && ymlState.entry.ownership === 'USER_OWNED')) {
              throw new Error(`Contexa overlay path is already user-owned: ${ymlPath}`);
            } else {
              const applied = await injectYml(ymlPath, {
                ...answers,
                managedPaths: ymlState.entry && ymlState.entry.managedPaths,
                removeLegacyNormalServerPort: !!(ymlState.entry && ymlState.entry.generated),
              });
              await recordChange(opts.dir, ymlPath, {
                kind: opts.simulate ? 'simulation-overlay' : 'contexa-overlay',
                generated: !ymlExistedBefore,
                reason: 'Explicit Contexa configuration',
                managedPaths: applied.managedPaths,
              }, installMode);
              const elapsed = Number(process.hrtime.bigint() - startYml) / 1e6;
              s1.succeed(`${t('step.ymlUpdated')} (${elapsed.toFixed(0)}ms)`);
            }
          } catch (err) {
            err = normalizeInitInputError(err);
            s1.fail(t('step.ymlUpdated'));
            console.log('');
            console.log(chalk.red(`  x ${t('init.error.ymlUpdate')}`));
            console.log(chalk.gray('    ' + formatError(err)));
            console.log('');
            throw err;
          }
        }

        if (opts.simulate) {
          const simulationConfig = await writeSimulationConfiguration(
            project, plannedSimulationConfigPath);
          await recordChange(opts.dir, simulationConfig.filePath, {
            kind: 'simulation-profile-configuration',
            generated: !plannedSimulationConfigExists,
            reason: 'Profile-only simulation activation',
          }, installMode);
          aiAnnotationApplied = true;
        }


        // application.properties + application.yml coexistence is a load-order
        // hazard in Spring Boot. Surface a single-line resolution hint here so
        // the user does not have to dig through docs.
        if (project.appPropertiesPath && project.appYmlPath) {
          console.log(chalk.yellow(`  ! ${t('init.config.both')}`));
          console.log(chalk.gray(`    ${t('init.config.shadowRisk')}`));
          console.log(chalk.gray(`    ${t('init.config.singleSource')}`));
        }

        // 4. Inject dependency (rolls back yml on failure)
        const addedDependencies = [];
        const dependencyOptions = {
          mode: installMode,
          targetModule: path.relative(path.resolve(opts.dir), projectOwnerDir)
            .split(path.sep).join('/') || '.',
          addedDependencies,
        };
        if (answers.injectDep) {
          try {
            const buildState = trackedFileState(installManifest, opts.dir, buildPath);
            // 3.5. Inject @EnableAISecurity only when the user explicitly allowed source annotation.
            if (answers.enableAiSecurity && answers.autoAnnotate) {
              try {
                const sAnnot = ora(t('step.injectingAnnotation')).start();
                const sourceState = project.mainApplicationCandidates.length === 1
                  ? trackedFileState(installManifest, opts.dir, project.mainApplicationCandidates[0])
                  : { entry: null, userModified: false };
                if (sourceState.userModified) {
                  sAnnot.warn('Skipped user-modified main application source.');
                }
                const injected = sourceState.userModified ? null : await injectEnableAiSecurity(opts.dir, {
                    mode: installMode,
                    securityMode: answers.securityMode,
                    mainApplicationCandidates: project.mainApplicationCandidates,
                  });
                if (injected && injected.changed) {
                  sAnnot.succeed(t('step.annotationInjected'));
                  await recordChange(opts.dir, injected.filePath, { kind: 'java-annotation', generated: false, reason: 'Explicit --auto-annotate AI security activation' }, installMode);
                  project.hasEnableAiSecurity = true;
                  aiAnnotationApplied = true;
                } else {
                  aiAnnotationApplied = aiAnnotationApplied || !!project.hasEnableAiSecurity || !!(injected && injected.filePath);
                  sAnnot.info(t('step.annotationPresent'));
                }
              } catch (err) {
                console.log(chalk.red(`  x ${t('init.error.annotation', formatError(err))}`));
                throw err;
              }
            }

            if (buildState.userModified) {
              console.log(chalk.yellow(`  ! ${t('init.build.userModified')}`));
            } else {
            const startDep = process.hrtime.bigint();
            const s2 = ora(t('step.addingDep')).start();
            const ok = project.buildTool === 'maven'
              ? await injectMavenDep(buildPath, dependencyOptions)
              : await injectGradleDep(buildPath, dependencyOptions);
            if (ok) {
              await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Contexa starter dependency' }, installMode);
            }
            const elapsed = Number(process.hrtime.bigint() - startDep) / 1e6;
            ok ? s2.succeed(`${t('step.depAdded')} (${elapsed.toFixed(0)}ms)`) : s2.info(t('step.depAlreadyPresent'));

            // Spring AI provider starters and vector-store are added only for explicit AI security setup.
            if (answers.enableAiSecurity && aiProviderSelected(answers)) {
              const startAiDep = process.hrtime.bigint();
              const sAi = ora(t('step.addingAiDependencies')).start();
              const addedAi = await injectSpringAiDeps(
                buildPath, answers.llmProviders, dependencyOptions);
              if (addedAi) {
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit AI provider dependencies' }, installMode);
              }
              const elapsedAi = Number(process.hrtime.bigint() - startAiDep) / 1e6;
              addedAi ? sAi.succeed(`Spring AI dependencies added (${elapsedAi.toFixed(0)}ms)`) : sAi.info('Spring AI dependencies already present');
            }

            if (answers.infra === 'distributed') {
              const startDistDep = process.hrtime.bigint();
              const s2b = ora(t('step.addingDistributedDeps')).start();
              const added = await injectDistributedDeps(buildPath, dependencyOptions);
              if (added) {
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit distributed infrastructure dependencies' }, installMode);
              }
              const elapsedDist = Number(process.hrtime.bigint() - startDistDep) / 1e6;
              added ? s2b.succeed(`${t('step.distributedDepsAdded')} (${elapsedDist.toFixed(0)}ms)`) : s2b.info(t('step.distributedDepsPresent'));
            }
            if (answers.enableAiSecurity) {
              aiDependenciesProcessed = await inspectAiDependencies(
                buildPath, answers.llmProviders);
            }
            if (addedDependencies.length > 0) {
              const existing = Array.isArray(installManifest.metadata.dependencyProvenance)
                ? installManifest.metadata.dependencyProvenance : [];
              const byKey = new Map();
              for (const coordinate of [...existing, ...addedDependencies]) {
                const key = [coordinate.group, coordinate.artifact,
                  coordinate.configuration, coordinate.version || '',
                  coordinate.targetModule].join(':');
                byKey.set(key, coordinate);
              }
              await recordInstallMetadata(opts.dir, {
                dependencyProvenance: [...byKey.values()].sort((left, right) =>
                  [left.targetModule, left.group, left.artifact, left.configuration]
                    .join(':').localeCompare(
                      [right.targetModule, right.group, right.artifact, right.configuration]
                        .join(':'))),
              }, installMode);
            }
            }
          } catch (err) {
            console.log('');
            console.log(chalk.red(`  x ${t('init.error.buildInjection')}`));
            console.log(chalk.gray('    ' + formatError(err)));
            console.log('');
            throw err;
          }
        }
      }

      // 5. Generate docker-compose.yml
      //
      // Infrastructure files (docker-compose.yml) are written to a
      // contexa-owned directory, NEVER the customer project directory. The
      // customer project's existing docker-compose.yml (if any) is therefore
      // never touched. Default location is OS-specific contexa home; users
      // can override via --infra-dir.
      let infraDir = null;
      if (answers.infra !== 'skip') {
        const includesOllama = !!(answers.llmProviders && answers.llmProviders.includes('ollama'));
        if (answers.infra === 'distributed') {
          console.log(chalk.cyan(`\n  ${t('init.infrastructure.distributed',
            includesOllama ? ' + Ollama' : '')}`));
        } else {
          console.log(chalk.cyan(`\n  ${t('init.infrastructure.standalone',
            includesOllama ? ' + Ollama' : '')}`));
        }

        infraDir = resolveInfraDir(cliProjectName, { infraDir: infraDirOverride });
        console.log(chalk.gray(`  ${t('init.infrastructure.location', infraDir)}`));
        console.log(chalk.gray(`  ${t('init.infrastructure.schemaOwner')}`));

        const startCompose = process.hrtime.bigint();
        const s3 = ora(t('step.generatingCompose')).start();
        const composePath = path.join(infraDir, 'docker-compose.yml');
        await prepareExternalFileChange(opts.dir, installTransactionId, composePath, infraDir, installMode);
        await generateDockerCompose(infraDir, {
          ...answers,
          projectName: cliProjectName,
          mode: installMode,
          installationId,
          includeOllama: !!(answers.llmProviders && answers.llmProviders.includes('ollama')),
          // The ownership transaction already preserves the previous external
          // file. A second sibling backup would survive a successful reset.
          backupExisting: false,
        });
        await recordExternalFileChange(opts.dir, installTransactionId, composePath, installMode);
        const dockerResourceContract = buildDockerResourceContract(cliProjectName, {
          infra: answers.infra,
          includeOllama: includesOllama,
          mode: installMode,
          installationId,
        });
        await recordInstallMetadata(opts.dir, {
          dockerResources: dockerResourceContract,
          composeChecksum: sha256FileSync(composePath),
        }, installMode);
        const elapsedCompose = Number(process.hrtime.bigint() - startCompose) / 1e6;
        s3.succeed((answers.infra === 'distributed'
          ? t('step.composeGenerated.distributed')
          : t('step.composeGenerated')) + ` (${elapsedCompose.toFixed(0)}ms)`);

        // 5b. Pre-flight checks before docker compose up. We do this even when
        // --no-docker is set so the user knows what conflicts to expect when
        // they run compose manually later.
        const issues = plannedInfraIssues;

        const servicesToUp = issues.servicesToUp || [];
        const skippedServices = issues.skippedServices || [];

        // 6. Start Docker
        // cwd is the contexa-owned infraDir so the docker-compose.yml that we
        // just generated is the one compose picks up - never the customer's.
        if (skippedServices.length > 0) {
          console.log(chalk.green(`  v ${t('init.infrastructure.skipped', skippedServices.join(', '))}`));
        }

        if (answers.startDocker && project.hasDocker) {
          await prepareDockerMutation(opts.dir, installTransactionId, {
            action: servicesToUp.length === 0 ? 'REUSE' : 'START',
            projectName: cliProjectName,
            infraDir,
            composeChecksum: sha256FileSync(composePath),
            contract: dockerResourceContract,
            services: servicesToUp.length === 0 ? skippedServices : servicesToUp,
            removeVolumes: !transactionManifestExisted,
          }, installMode);
          if (servicesToUp.length === 0) {
            await recordDockerMutationApplied(opts.dir, installTransactionId, installMode);
            console.log(chalk.green(`  v ${t('init.infrastructure.alreadyRunning')}`));
          } else {
            const s4 = ora(`${t('step.startingDocker')} (${servicesToUp.join(', ')})`).start();
            try {
              const upArgs = opts.simulate
                ? ['-p', SIMULATION_PROJECT, 'up', '-d', ...servicesToUp]
                : ['up', '-d', ...servicesToUp];
              const upResult = dockerCompose(upArgs, {
                cwd: infraDir,
                env: opts.simulate ? simulationEnvironment(process.env, installationId) : process.env,
                stdio: 'inherit',
                timeout: opts.simulate ? TIMEOUTS.dockerComposeMutationMs : undefined,
              });
              if (upResult.error) throw upResult.error;
              if (upResult.status !== 0) {
                throw initError('DOCKER_COMPOSE_UP_FAILED', 'init.error.composeUp', upResult.status);
              }
              await recordDockerMutationApplied(opts.dir, installTransactionId, installMode);
              s4.succeed(t('step.dockerStarted'));

            // 7. Pull Ollama models (only if Ollama was explicitly included)
            // Container name is project-aware (production: contexa-ollama,
            // simulate: ctxa-sim-ollama, custom CONTEXA_PROJECT: <name>-ollama).
              if (answers.llmProviders && answers.llmProviders.includes('ollama')) {
              const ollamaContainer = containerName('ollama');
              const chatModel = process.env.OLLAMA_CHAT_MODEL || DEFAULT_OLLAMA_CHAT_MODEL;
              const embedModel = process.env.OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL;
              if (!isValidOllamaModel(chatModel)) {
                throw initError('INVALID_OLLAMA_MODEL', 'init.error.chatModel', chatModel);
              }
              if (!isValidOllamaModel(embedModel)) {
                throw initError('INVALID_OLLAMA_MODEL', 'init.error.embeddingModel', embedModel);
              }
              // Pull selected Ollama models when local Ollama is enabled.
              const ollamaPort = configuredPort(
                'CONTEXA_OLLAMA_PORT', DEFAULT_INFRASTRUCTURE_PORTS.ollama
              );
                const s5 = ora(t('step.pullingChat', chatModel)).start();
                try {
                  const ready = await waitForDockerOllama(
                    ollamaContainer, Date.now() + TIMEOUTS.ollamaReadyMs);

                  if (ready) {
                    await pullOllamaModelWithProgress(ollamaPort, chatModel, s5, t('step.pullingChat', chatModel).replace('...', ''));
                    s5.succeed(t('step.chatPulled', chatModel));

                    const s6 = ora(t('step.pullingEmbedding', embedModel)).start();
                    await pullOllamaModelWithProgress(ollamaPort, embedModel, s6, t('step.pullingEmbedding', embedModel).replace('...', ''));
                    s6.succeed(t('step.embeddingPulled'));
                  } else {
                    throw initError('OLLAMA_READY_TIMEOUT', 'init.error.ollamaReady', ollamaContainer);
                  }
                } catch (e) {
                  s5.fail(t('step.modelPullFailed', chatModel));
                  throw e;
                }
              }
            } catch (e) {
              s4.fail(t('step.dockerFailed'));
              throw e;
            }
          }
          if (opts.simulate && answers.startDocker) {
            const simulationEvidence = await waitForSimulationInfrastructure(installationId,
              !!(answers.llmProviders && answers.llmProviders.includes('ollama')));
            await recordInstallMetadata(opts.dir, {
              simulationInfrastructure: {
                verifiedAt: new Date().toISOString(),
                services: simulationEvidence.services,
                images: simulationEvidence.images,
                versions: simulationEvidence.versions,
                identityFingerprints: Object.fromEntries(
                  Object.entries(simulationEvidence.probes).map(([service, identity]) => [
                    service,
                    `sha256:${crypto.createHash('sha256')
                      .update(`${service}|${identity}`).digest('hex')}`,
                  ])
                ),
              },
            }, installMode);
          }
        }
      }
      const finalActivationResult = activationResult(answers, project, {
        aiAnnotationApplied,
        aiDependenciesProcessed,
      });
      await recordInstallMetadata(opts.dir, {
        aiSecurityRequested: finalActivationResult.requested,
        aiSecurityEnabled: finalActivationResult.enabled,
        activationResult: finalActivationResult,
      }, installMode);
      await commitInstallTransaction(opts.dir, installTransactionId, installMode);
      installTransactionId = null;

      printInitCompletion({
        answers,
        project,
        standaloneDir,
        shouldWriteOverlay,
        standaloneResult,
        simulate: !!opts.simulate,
        projectDir: opts.dir,
        aiAnnotationApplied,
        aiDependenciesProcessed,
      });

      } catch (error) {
        const infrastructureRollbackErrors = [];
        if (installTransactionId) {
          try {
            const activeManifest = await loadManifest(opts.dir, installMode);
            const dockerMutation = activeManifest.transaction
              && activeManifest.transaction.id === installTransactionId
              && activeManifest.transaction.dockerMutation;
            if (dockerMutation && ['PREPARED', 'APPLIED'].includes(dockerMutation.state)) {
              await recoverInterruptedDockerMutation(dockerMutation);
            }
          } catch (cleanupError) {
            infrastructureRollbackErrors.push(`Docker rollback: ${cleanupError.message}`);
          }
          const rollback = await rollbackInstallTransaction(
            opts.dir,
            installTransactionId,
            installMode,
            { failures: infrastructureRollbackErrors }
          );
          if (!rollback.rolledBack) {
            infrastructureRollbackErrors.splice(0, infrastructureRollbackErrors.length, ...rollback.failures);
          } else {
            console.log(chalk.yellow(`  ! ${t('init.rollback.restored')}`));
          }
        }
        if (infrastructureRollbackErrors.length > 0) {
          throw new Error(`${error.message}; automatic rollback failed: ${infrastructureRollbackErrors.join('; ')}`);
        }
        throw error;
      } finally {
        await releaseInstallLock(installLock);
      }
}

module.exports = {
  executeInit,
  recoverInterruptedDockerMutation,
};
