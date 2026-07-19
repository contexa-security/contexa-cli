'use strict';

const chalk = require('chalk');
const ora   = require('ora');
const path  = require('path');
const fs    = require('fs-extra');
const { Option } = require('commander');
const { dockerCompose } = require('../core/docker');
const releaseManifest = require('../../release-manifest.json');
const { pullOllamaModelWithProgress, waitForDockerOllama } = require('../core/ollama');
const {
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  isValidOllamaModel,
} = require('../core/provider');
const { DEFAULT_INFRASTRUCTURE_PORTS, configuredPort } = require('../core/infrastructure');
const { TIMEOUTS } = require('../core/timeouts');
const {
  aiProviderSelected,
  normalizePath,
  printPlannedChanges,
  trackedFileState,
} = require('../core/init-plan');
const { collectInitAnswers } = require('../core/init-input');
const { printInitCompletion } = require('../core/init-report');
const { runPreinstallationChecks } = require('../core/init-diagnostics');
const { detectSpringProject } = require('../core/detector');
const { ensureVerifiedArtifact } = require('../core/artifact');
const { injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
        injectSpringAiDeps, injectEnableAiSecurity, injectStandalone,
        generateDockerCompose } = require('../core/injector');
const { inspectInfra } = require('../core/preflight');
const { resolveProjectName, containerName, resolveInfraDir } = require('../core/project');
const { t } = require('../core/i18n');
const {
  INSTALL_MODES,
  beginInstallTransaction,
  commitInstallTransaction,
  loadManifest,
  manifestPath,
  prepareExternalFileChange,
  recordExternalFileChange,
  recordChange,
  recordInstallMetadata,
  rollbackInstallTransaction,
  sha256FileSync,
} = require('../core/manifest');
const { buildDockerResourceContract } = require('../core/reset-service');
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
} = require('../core/simulation');

function initError(code, key, ...args) {
  const error = new Error(`${code} ${t(key, ...args)}`);
  error.code = code;
  return error;
}

module.exports = function (program) {
  program
    .command('init')
    .description(t('init.description'))
    .option('--yes', t('init.option.yes'))
    .option('--force', t('init.option.force'))
    .option('--dir <path>', t('init.option.dir'), process.cwd())
    // Infrastructure provisioning is OPT-IN. Without --distributed, contexa init
    // only updates application.yml and adds the starter dependency - it does NOT
    // generate docker-compose.yml, does NOT generate initdb scripts, and does NOT
    // start any containers. Customers who already run their own Postgres/Ollama
    // (and Redis/Kafka) infrastructure are unaffected by re-running init.
    //
    // --distributed installs the full PoC/demo stack:
    //   PostgreSQL + Redis + Zookeeper + Kafka  (+ Ollama if --include-ollama)
    // --no-docker (only meaningful with --distributed) generates compose files
    // but does not run "docker compose up -d". Database schema/seed data is
    // installed by the contexa-iam runtime initializer when the application
    // starts, not by contexa-cli.
    //
    // AI security is opt-in. Basic init installs only the starter dependency and
    // leaves host configuration byte-identical. --enable-ai-security / wizard consent controls provider
    // dependencies, LLM settings, and optional @EnableAISecurity insertion.
    // --include-ollama only opts in to the local Ollama runtime when AI security
    // is explicitly enabled or simulation is requested.
    .option('--distributed', t('init.option.distributed'))
    .option('--include-ollama', t('init.option.includeOllama'))
    .option('--no-docker', t('init.option.noDocker'))
    .option('--simulate', t('init.option.simulate'))
    .option('--quick', t('init.option.quick'))
    .option('--enable-ai-security', t('init.option.enableAiSecurity'))
    .option('--provider <name>', t('init.option.provider'))
    .option('--auto-annotate', t('init.option.autoAnnotate'))
    .addOption(new Option('--security-mode <mode>', t('init.option.securityMode')).choices(['sandbox', 'full']))
    // The two integration modes. By default the prompt asks the user; these
    // flags exist for prompt-bypass automation.
    .option('--merge', t('init.option.merge'))
    .option('--standalone', t('init.option.standalone'))
    .option('--standalone-dir <path>', t('init.option.standaloneDir'))
    // Infrastructure files (docker-compose.yml) are ALWAYS written
    // outside the customer project directory. Default: contexa-owned home
    // (Linux/macOS: $XDG_CONFIG_HOME/contexa/<projectName> or $HOME/.contexa/<name>;
    // Windows: %LOCALAPPDATA%\Contexa\<projectName>). Override with --infra-dir.
    .option('--infra-dir <path>', t('init.option.infraDir'))
    .option('--check', t('init.option.check'))
    .action(async (opts) => {
      const installMode = opts.simulate ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
      let installTransactionId = null;
      let transactionProjectName = null;
      let transactionInfraDir = null;
      let transactionInfraExisted = false;
      let transactionComposeExisted = false;
      let transactionDockerStarted = false;
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
      const project = await detectSpringProject(opts.dir, {
        probeDocker: !!(opts.distributed || opts.simulate),
      });
      spinner.stop();

      if (!project.isSpring) {
        console.log(chalk.red('  x ' + t('init.notSpring')));
        console.log(chalk.gray('    ' + t('init.notSpring.hint') + '\n'));
        throw initError('SPRING_PROJECT_REQUIRED', 'init.notSpring');
      }
      if (opts.simulate && !await fs.pathExists(manifestPath(opts.dir, INSTALL_MODES.NORMAL))) {
        throw initError('SIMULATION_NORMAL_INSTALL_REQUIRED', 'init.error.simulationNormalRequired');
      }
      if (opts.simulate && !project.hasContexta) {
        throw initError('SIMULATION_STARTER_REQUIRED', 'init.error.simulationStarterRequired');
      }

      console.log(chalk.green('  v ' + t('init.detected')));
      console.log(chalk.gray(`    ${t('init.detected.project')} : ${project.projectName || t('common.unknown')}`));
      console.log(chalk.gray(`    ${t('init.detected.build')}   : ${project.buildTool}`));
      console.log(chalk.gray(`    ${t('init.detected.security')}: ${project.hasSpringSecurityCore ? t('init.security.springSecurity') : chalk.yellow(t('init.security.legacy'))}`));
      console.log(chalk.gray(`    ${t('init.detected.docker')}  : ${(opts.distributed || opts.simulate)
        ? (project.hasDocker ? chalk.green(t('init.docker.installed')) : chalk.yellow(t('init.docker.missing')))
        : t('common.notRequested')}`));

      const cliProjectName = opts.simulate
        ? SIMULATION_PROJECT
        : resolveProjectName(project.projectName || path.basename(path.resolve(opts.dir)));
      transactionProjectName = cliProjectName;
      if (!process.env.CONTEXA_PROJECT) {
        process.env.CONTEXA_PROJECT = cliProjectName;
      }

      // Docker is only consulted when the user explicitly opted into infra
      // provisioning via --distributed. Without --distributed, init does not
      // touch infrastructure regardless of whether Docker is installed.
      const wantsContainers = opts.distributed && opts.docker !== false;
      if (!project.hasDocker && wantsContainers) {
        console.log('');
        console.log(chalk.yellow(`  ! ${t('init.docker.required')}`));
        console.log(chalk.gray(`    ${t('init.docker.composeOnly')}`));
        console.log(chalk.gray(`    ${t('init.docker.install')}`));
        console.log(chalk.gray('      Windows / macOS : https://www.docker.com/products/docker-desktop'));
        console.log(chalk.gray('      Linux           : https://docs.docker.com/engine/install/'));
        console.log(chalk.gray(`    ${t('init.docker.skipHint')}`));
        console.log('');
        // Auto-flip to "files only" mode so we never try to call docker compose.
        opts.docker = false;
      }

      // Warn when both application.properties and application.yml exist - one shadows the other.
      if (project.appPropertiesPath && project.appYmlPath) {
        console.log(chalk.yellow('  ! ' + t('scan.propertiesAndYml')));
      }

      if (project.hasContexta) {
        if (!opts.force && !opts.yes) {
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



      // Resolve standalone dir
      const standaloneDir = answers.integrationMode === 'standalone'
        ? (normalizePath(opts.standaloneDir, opts.dir)
            || normalizePath(answers.standaloneDir, opts.dir)
            || path.resolve(opts.dir, 'contexa'))
        : null;

      // Resolve infra dir
      const infraDirOverride = normalizePath(opts.infraDir, opts.dir)
        || normalizePath(answers.infraDir, opts.dir)
        || null;

      const projectOwnerDir = project.projectDir || opts.dir;
      const plannedYmlPath = opts.simulate
        ? simulationOverlayPath(projectOwnerDir)
        : (project.appYmlPath || path.join(projectOwnerDir, 'src/main/resources/application.yml'));
      const plannedSimulationConfigPath = opts.simulate ? simulationConfigurationPath(project) : null;
      const shouldWriteHostConfig = answers.integrationMode === 'merge'
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
            ...(shouldWriteHostConfig ? [{ filePath: plannedYmlPath, kind: 'application-yml' }] : []),
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
            writeHostConfig: shouldWriteHostConfig,
            buildExists: plannedBuildExists,
            composePath: plannedComposePath,
            composeExists: plannedComposeExists,
            geoIpPath: plannedGeoIpPath,
            geoIpExists: plannedGeoIpExists,
            geoIpLocalSource: process.env.CONTEXA_GEOLITE2_SOURCE_PATH,
          });

      let plannedInfraIssues = [];
      if (answers.infra !== 'skip') {
        plannedInfraIssues = await inspectInfra({
          infra: answers.infra,
          startDocker: answers.startDocker,
          includeOllama: !!(answers.llmProviders && answers.llmProviders.includes('ollama')),
          strictIsolation: !!opts.simulate,
          projectName: cliProjectName,
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

      transactionManifestExisted = await fs.pathExists(manifestPath(opts.dir, installMode));
      installTransactionId = await beginInstallTransaction(opts.dir, {
        projectName: cliProjectName,
        integrationMode: answers.integrationMode,
        infra: answers.infra,
        infraDir: plannedInfraDir,
        simInfraDir: opts.simulate ? resolveInfraDir('ctxa-sim', { infraDir: infraDirOverride }) : null,
        aiSecurityEnabled: !!answers.enableAiSecurity,
      }, installMode, plannedFiles);
      const installManifest = await loadManifest(opts.dir, installMode);
      const installationId = installManifest.metadata.installationId;
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
            ...answers, force: !!opts.force,
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
          console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
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

        if (shouldWriteHostConfig) {
          // Explicit activation/infrastructure keeps the existing merge path.
          // Starter-only init never parses or rewrites host configuration.
          const startYml = process.hrtime.bigint();
          const s1 = ora(t('step.updatingYml')).start();
          try {
            const ymlState = trackedFileState(installManifest, opts.dir, ymlPath);
            if (ymlState.userModified) {
              s1.warn('Skipped user-modified application.yml; CLI-owned values were not absorbed or overwritten.');
            } else {
              const applied = await injectYml(ymlPath, {
                ...answers,
                managedPaths: ymlState.entry && ymlState.entry.managedPaths,
              });
              await recordChange(opts.dir, ymlPath, {
                kind: 'application-yml',
                generated: !ymlExistedBefore,
                reason: 'Explicit Contexa configuration',
                managedPaths: applied.managedPaths,
              }, installMode);
              const elapsed = Number(process.hrtime.bigint() - startYml) / 1e6;
              s1.succeed(`${t('step.ymlUpdated')} (${elapsed.toFixed(0)}ms)`);
            }
          } catch (err) {
            s1.fail(t('step.ymlUpdated'));
            console.log('');
            console.log(chalk.red(`  x ${t('init.error.ymlUpdate')}`));
            console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
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
                  sAnnot.succeed('@EnableAISecurity injected into main class');
                  await recordChange(opts.dir, injected.filePath, { kind: 'java-annotation', generated: false, reason: 'Explicit --auto-annotate AI security activation' }, installMode);
                  project.hasEnableAiSecurity = true;
                  aiAnnotationApplied = true;
                } else {
                  aiAnnotationApplied = aiAnnotationApplied || !!project.hasEnableAiSecurity || !!(injected && injected.filePath);
                  sAnnot.info('@EnableAISecurity already present or main class not found');
                }
              } catch (err) {
                console.log(chalk.red(`  x ${t('init.error.annotation', err.message)}`));
                throw err;
              }
            }

            if (buildState.userModified) {
              console.log(chalk.yellow(`  ! ${t('init.build.userModified')}`));
              aiDependenciesProcessed = true;
            } else {
              const startDep = process.hrtime.bigint();
            const s2 = ora(t('step.addingDep')).start();
            const ok = project.buildTool === 'maven'
              ? await injectMavenDep(buildPath, { mode: installMode })
              : await injectGradleDep(buildPath, { mode: installMode });
            if (ok) {
              await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Contexa starter dependency' }, installMode);
            }
            const elapsed = Number(process.hrtime.bigint() - startDep) / 1e6;
            ok ? s2.succeed(`${t('step.depAdded')} (${elapsed.toFixed(0)}ms)`) : s2.info(t('step.depAlreadyPresent'));

            // Spring AI provider starters and vector-store are added only for explicit AI security setup.
            if (answers.enableAiSecurity && aiProviderSelected(answers)) {
              const startAiDep = process.hrtime.bigint();
              const sAi = ora(t('step.addingAiDependencies')).start();
              const addedAi = await injectSpringAiDeps(buildPath, answers.llmProviders, { mode: installMode });
              if (addedAi) {
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit AI provider dependencies' }, installMode);
              }
              aiDependenciesProcessed = true;
              const elapsedAi = Number(process.hrtime.bigint() - startAiDep) / 1e6;
              addedAi ? sAi.succeed(`Spring AI dependencies added (${elapsedAi.toFixed(0)}ms)`) : sAi.info('Spring AI dependencies already present');
            }

            if (answers.infra === 'distributed') {
              const startDistDep = process.hrtime.bigint();
              const s2b = ora(t('step.addingDistributedDeps')).start();
              const added = await injectDistributedDeps(buildPath, { mode: installMode });
              if (added) {
                await recordChange(opts.dir, buildPath, { kind: 'build-file', generated: false, reason: 'Explicit distributed infrastructure dependencies' }, installMode);
              }
              const elapsedDist = Number(process.hrtime.bigint() - startDistDep) / 1e6;
              added ? s2b.succeed(`${t('step.distributedDepsAdded')} (${elapsedDist.toFixed(0)}ms)`) : s2b.info(t('step.distributedDepsPresent'));
            }
            }
          } catch (err) {
            console.log('');
            console.log(chalk.red(`  x ${t('init.error.buildInjection')}`));
            console.log(chalk.gray('    ' + String(err.message).split('\n').join('\n    ')));
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
        transactionInfraDir = infraDir;
        transactionInfraExisted = await fs.pathExists(infraDir);
        transactionComposeExisted = await fs.pathExists(path.join(infraDir, 'docker-compose.yml'));
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
        await recordInstallMetadata(opts.dir, {
          dockerResources: buildDockerResourceContract(cliProjectName, {
            infra: answers.infra,
            includeOllama: includesOllama,
            mode: installMode,
            installationId,
          }),
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
          if (servicesToUp.length === 0) {
            console.log(chalk.green(`  v ${t('init.infrastructure.alreadyRunning')}`));
          } else {
            const s4 = ora(`${t('step.startingDocker')} (${servicesToUp.join(', ')})`).start();
            try {
              const upArgs = opts.simulate
                ? ['-p', SIMULATION_PROJECT, 'up', '-d', ...servicesToUp]
                : ['up', '-d', ...servicesToUp];
              if (opts.simulate) transactionDockerStarted = true;
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
              transactionDockerStarted = true;
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
              if (opts.simulate) {
                await waitForSimulationInfrastructure(installationId,
                  !!(answers.llmProviders && answers.llmProviders.includes('ollama')));
              }
            } catch (e) {
              s4.fail(t('step.dockerFailed'));
              throw e;
            }
        }
      }
    }

      await commitInstallTransaction(opts.dir, installTransactionId, installMode);
      installTransactionId = null;

      printInitCompletion({
        answers,
        project,
        standaloneDir,
        shouldWriteHostConfig,
        standaloneResult,
        simulate: !!opts.simulate,
        projectDir: opts.dir,
        aiAnnotationApplied,
        aiDependenciesProcessed,
      });

      } catch (error) {
        const infrastructureRollbackErrors = [];
        if (transactionDockerStarted && transactionInfraDir && transactionProjectName) {
          try {
            const downArgs = ['-p', transactionProjectName, 'down', '--timeout', '0'];
            if (!transactionManifestExisted) downArgs.push('-v');
            const downResult = dockerCompose(downArgs, {
              cwd: transactionInfraDir,
              stdio: 'pipe',
              env: opts.simulate
                ? simulationEnvironment(process.env,
                  (await loadManifest(opts.dir, installMode)).metadata.installationId)
                : process.env,
              timeout: TIMEOUTS.dockerComposeRollbackMs,
            });
            if (downResult.error || downResult.status !== 0) {
              throw downResult.error || new Error(`docker compose down exited with status ${downResult.status}`);
            }
          } catch (cleanupError) {
            infrastructureRollbackErrors.push(`Docker rollback: ${cleanupError.message}`);
          }
        }
        if (transactionInfraDir) {
          try {
            const composePath = path.join(transactionInfraDir, 'docker-compose.yml');
            const composeBackup = composePath + '.bak';
            if (transactionComposeExisted && await fs.pathExists(composeBackup)) {
              await fs.copy(composeBackup, composePath, { overwrite: true });
              await fs.remove(composeBackup);
            } else if (!transactionComposeExisted && await fs.pathExists(composePath)) {
              await fs.remove(composePath);
            }
            if (!transactionInfraExisted && await fs.pathExists(transactionInfraDir)) {
              await fs.remove(transactionInfraDir);
            }
          } catch (cleanupError) {
            infrastructureRollbackErrors.push(`Infrastructure file rollback: ${cleanupError.message}`);
          }
        }
        if (installTransactionId) {
          const rollback = await rollbackInstallTransaction(opts.dir, installTransactionId, installMode);
          if (!rollback.rolledBack) {
            infrastructureRollbackErrors.push(...rollback.failures);
          } else {
            console.log(chalk.yellow(`  ! ${t('init.rollback.restored')}`));
          }
        }
        if (infrastructureRollbackErrors.length > 0) {
          throw new Error(`${error.message}; automatic rollback failed: ${infrastructureRollbackErrors.join('; ')}`);
        }
        throw error;
      }
    });
};
