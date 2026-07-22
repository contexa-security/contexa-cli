'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const inquirer = require('inquirer');
const { buildInitDefaults, collectInitAnswers, selectInitLocale } = require('../src/core/init-input');
const { getLocale, setLocale } = require('../src/core/i18n');
const { printInitCompletion } = require('../src/core/init-report');
const { executeInit } = require('../src/core/init-application');
const { buildCliContexaTree } = require('../src/core/injector/yml');
const {
  injectMavenDep, injectGradleDep, injectDistributedDeps, injectSpringAiDeps,
} = require('../src/core/injector/build');
const { injectStandalone } = require('../src/core/injector/standalone');
const { generateDockerCompose } = require('../src/core/injector/compose');
const { springAiProviderArtifacts } = require('../src/core/injector/common');
const { INSTALL_MODES, loadManifest, manifestPath } = require('../src/core/manifest');

const originalPrompt = inquirer.prompt;

async function collect(selection, options = {}) {
  let questions;
  inquirer.prompt = async value => {
    questions = value;
    return { ...selection };
  };
  try {
    const answers = await collectInitAnswers({
      dir: process.cwd(),
      docker: true,
      ...options,
    }, {
      hasDocker: true,
      hasEnableAiSecurity: false,
      hasHostSecurityFilterChain: false,
    }, 'matrix-project');
    return { answers, questions };
  } finally {
    inquirer.prompt = originalPrompt;
  }
}

function activeQuestionNames(questions, selection) {
  return questions
    .filter(question => question.when === undefined
      || (typeof question.when === 'function' ? question.when(selection) : question.when))
    .map(question => question.name);
}

test('interactive init asks for language first and applies the selected locale', async () => {
  const previousArgv = process.argv;
  const previousLanguage = process.env.CONTEXA_LANG;
  let questions;
  inquirer.prompt = async value => {
    questions = value;
    return { lang: 'ko' };
  };
  try {
    process.argv = ['node', 'contexa', 'init'];
    delete process.env.CONTEXA_LANG;
    setLocale('en');
    assert.equal(await selectInitLocale({}, true), 'ko');
    assert.equal(getLocale(), 'ko');
    assert.deepEqual(questions.map(question => question.name), ['lang']);
    assert.deepEqual(questions[0].choices.map(choice => choice.value), ['en', 'ko']);
  } finally {
    process.argv = previousArgv;
    if (previousLanguage === undefined) delete process.env.CONTEXA_LANG;
    else process.env.CONTEXA_LANG = previousLanguage;
    setLocale('en');
    inquirer.prompt = originalPrompt;
  }
});

test('explicit CONTEXA_LANG bypasses the interactive language question', async () => {
  const previousLanguage = process.env.CONTEXA_LANG;
  let prompted = false;
  inquirer.prompt = async () => {
    prompted = true;
    return { lang: 'en' };
  };
  try {
    process.env.CONTEXA_LANG = 'ko';
    setLocale('ko');
    assert.equal(await selectInitLocale({}, true), 'ko');
    assert.equal(prompted, false);
  } finally {
    if (previousLanguage === undefined) delete process.env.CONTEXA_LANG;
    else process.env.CONTEXA_LANG = previousLanguage;
    setLocale('en');
    inquirer.prompt = originalPrompt;
  }
});

test('non-interactive init never waits for a language answer', async () => {
  const previousLanguage = process.env.CONTEXA_LANG;
  let prompted = false;
  inquirer.prompt = async () => {
    prompted = true;
    return { lang: 'ko' };
  };
  try {
    delete process.env.CONTEXA_LANG;
    setLocale('en');
    assert.equal(await selectInitLocale({}, false), 'en');
    assert.equal(prompted, false);
  } finally {
    if (previousLanguage === undefined) delete process.env.CONTEXA_LANG;
    else process.env.CONTEXA_LANG = previousLanguage;
    setLocale('en');
    inquirer.prompt = originalPrompt;
  }
});
test('simulation completion reports simulation-owned changes without claiming host mutation', () => {
  const originalLog = console.log;
  const output = [];
  console.log = (...values) => output.push(values.join(' '));
  try {
    setLocale('en');
    printInitCompletion({
      answers: {
        integrationMode: 'merge', infra: 'distributed', enableAiSecurity: true,
        mode: 'shadow', llmProviders: ['ollama'], securityMode: 'sandbox',
      },
      project: { buildTool: 'gradle' },
      simulate: true,
      projectDir: 'C:\\tmp\\host',
      shouldWriteOverlay: true,
      aiAnnotationApplied: false,
      aiDependenciesProcessed: false,
      starterDependencyChanged: false,
    });
  } finally {
    console.log = originalLog;
    setLocale('en');
  }
  const report = output.join('\n');
  assert.match(report, /Simulation-owned overlay and profile configuration processed/);
  assert.doesNotMatch(report, /starter-contexa dependency (?:added|already present)/);
  assert.doesNotMatch(report, /owned application-contexa\.yml overlay|Host application configuration/);
});
test('quick defaults restore ready-to-run Contexa installation', () => {
  const { defaults } = buildInitDefaults({});
  assert.deepEqual(defaults, {
    setupMode: 'quick',
    integrationMode: 'merge',
    securityMode: 'full',
    mode: 'shadow',
    enableAiSecurity: true,
    autoAnnotate: true,
    llmProviders: ['ollama'],
    infra: 'standalone',
    injectDep: true,
    startDocker: true,
  });
});

test('quick selection applies provider, annotation and infrastructure choices', async () => {
  for (const providerQuick of ['openai', 'anthropic', 'ollama']) {
    for (const autoAnnotate of [true, false]) {
      const selection = { setupMode: 'quick', providerQuick, autoAnnotate };
      const { answers, questions } = await collect(selection);
      assert.equal(answers.setupMode, 'quick');
      assert.equal(answers.integrationMode, 'merge');
      assert.equal(answers.securityMode, 'full');
      assert.equal(answers.mode, 'shadow');
      assert.equal(answers.enableAiSecurity, true);
      assert.equal(answers.autoAnnotate, autoAnnotate);
      assert.deepEqual(answers.llmProviders, [providerQuick]);
      assert.equal(answers.infra, 'standalone');
      assert.equal(answers.startDocker, true);
      const active = activeQuestionNames(questions, selection);
      assert.deepEqual(active, ['setupMode', 'providerQuick', 'autoAnnotate']);
    }
  }
});

const PROVIDER_SUBSETS = [
  ['openai'], ['anthropic'], ['ollama'],
  ['openai', 'anthropic'], ['openai', 'ollama'], ['anthropic', 'ollama'],
  ['openai', 'anthropic', 'ollama'],
];

test('custom selection normalizes every integration, security, mode, provider, infrastructure and Docker combination', async () => {
  let combinations = 0;
  for (const integrationMode of ['merge', 'standalone']) {
    for (const securityMode of ['full', 'sandbox']) {
      for (const mode of ['shadow', 'enforce']) {
        for (const llmProviders of PROVIDER_SUBSETS) {
          for (const infra of ['standalone', 'distributed', 'skip']) {
            const annotationChoices = integrationMode === 'merge' ? [true, false] : [false];
            const dockerChoices = infra === 'skip' ? [false] : [true, false];
            for (const autoAnnotate of annotationChoices) {
              for (const startDocker of dockerChoices) {
                combinations += 1;
                const selection = {
                  setupMode: 'advanced', integrationMode, securityMode, mode,
                  llmProviders, infra, startDocker, autoAnnotate,
                  standaloneDir: 'D:/tmp/contexa-standalone',
                  infraDir: 'D:/tmp/contexa-infra',
                };
                const { answers, questions } = await collect(selection);
                assert.equal(answers.setupMode, 'advanced');
                assert.equal(answers.integrationMode, integrationMode);
                assert.equal(answers.securityMode, securityMode);
                assert.equal(answers.mode, mode);
                assert.equal(answers.enableAiSecurity, true);
                assert.equal(answers.autoAnnotate, integrationMode === 'merge' && autoAnnotate);
                assert.deepEqual(answers.llmProviders, llmProviders);
                assert.equal(answers.infra, infra);
                assert.equal(answers.startDocker, infra !== 'skip' && startDocker);

                const active = activeQuestionNames(questions, selection);
                for (const required of ['setupMode', 'integrationMode', 'securityMode',
                  'mode', 'llmProviders', 'infra']) {
                  assert.ok(active.includes(required), 'missing custom question: ' + required);
                }
                assert.equal(active.includes('autoAnnotate'), integrationMode === 'merge');
                assert.equal(active.includes('standaloneDir'), integrationMode === 'standalone');
                assert.equal(active.includes('infraDir'), infra !== 'skip');
                assert.equal(active.includes('startDocker'), infra !== 'skip');
              }
            }
          }
        }
      }
    }
  }
  assert.equal(combinations, 420);
});

test('--merge and --standalone fail instead of silently ignoring one selection', () => {
  assert.throws(
    () => buildInitDefaults({ merge: true, standalone: true }),
    error => error.code === 'INTEGRATION_MODE_CONFLICT'
      && error.messageKey === 'init.error.integrationModeConflict'
  );
});
test('standalone plus explicit auto annotation is rejected instead of silently mutating host code', async () => {
  await assert.rejects(
    collect({
      setupMode: 'advanced', integrationMode: 'standalone', securityMode: 'full',
      mode: 'shadow', llmProviders: ['ollama'], infra: 'skip',
      standaloneDir: 'D:/tmp/contexa-standalone',
    }, { standalone: true, autoAnnotate: true }),
    error => error.code === 'STANDALONE_AUTO_ANNOTATE_CONFLICT'
      && error.messageKey === 'init.error.standaloneAutoAnnotateConflict'
  );
});
test('--yes, --distributed, --no-docker and explicit provider remain deterministic', () => {
  const { defaults } = buildInitDefaults({
    yes: true,
    distributed: true,
    docker: false,
    provider: 'anthropic',
    autoAnnotate: true,
  });
  assert.equal(defaults.setupMode, 'quick');
  assert.equal(defaults.enableAiSecurity, true);
  assert.equal(defaults.autoAnnotate, true);
  assert.deepEqual(defaults.llmProviders, ['anthropic']);
  assert.equal(defaults.infra, 'distributed');
  assert.equal(defaults.startDocker, false);
});
test('public init selector flags normalize without contradictory prompts or hidden mutations', async () => {
  const custom = await collect({
    setupMode: 'advanced', mode: 'enforce', startDocker: true,
  }, {
    merge: true,
    securityMode: 'sandbox',
    provider: 'openai',
    distributed: true,
    infraDir: 'D:/tmp/flag-infra',
    autoAnnotate: true,
  });
  assert.equal(custom.answers.integrationMode, 'merge');
  assert.equal(custom.answers.securityMode, 'sandbox');
  assert.equal(custom.answers.mode, 'enforce');
  assert.deepEqual(custom.answers.llmProviders, ['openai']);
  assert.equal(custom.answers.infra, 'distributed');
  assert.equal(custom.answers.startDocker, true);
  assert.equal(custom.answers.autoAnnotate, true);
  const customQuestions = activeQuestionNames(custom.questions, {
    setupMode: 'advanced', mode: 'enforce', startDocker: true,
  });
  assert.deepEqual(customQuestions, ['setupMode', 'mode', 'startDocker']);

  const standaloneQuick = await collect({ setupMode: 'quick' }, {
    quick: true,
    standalone: true,
    standaloneDir: 'D:/tmp/flag-standalone',
    provider: 'anthropic',
    docker: false,
  });
  assert.equal(standaloneQuick.answers.setupMode, 'quick');
  assert.equal(standaloneQuick.answers.integrationMode, 'standalone');
  assert.equal(standaloneQuick.answers.autoAnnotate, false);
  assert.deepEqual(standaloneQuick.answers.llmProviders, ['anthropic']);
  assert.equal(standaloneQuick.answers.infra, 'standalone');
  assert.equal(standaloneQuick.answers.startDocker, false);
  assert.deepEqual(activeQuestionNames(standaloneQuick.questions, { setupMode: 'quick' }), []);

  const simulation = await collect({}, {
    simulate: true, yes: true, provider: 'openai', docker: false,
  });
  assert.equal(simulation.answers.integrationMode, 'merge');
  assert.equal(simulation.answers.autoAnnotate, false);
  assert.equal(simulation.answers.injectDep, false);
  assert.deepEqual(simulation.answers.llmProviders, ['openai']);

  const combinedProviders = await collect({}, {
    yes: true, provider: 'openai', includeOllama: true, docker: false,
  });
  assert.deepEqual(combinedProviders.answers.llmProviders, ['openai', 'ollama']);
});

function expectedProviderOrder(providers) {
  return providers.includes('ollama')
    ? ['ollama', ...providers.filter(provider => provider !== 'ollama')]
    : providers;
}

test('every selected option maps to the exact Contexa YAML tree', () => {
  let combinations = 0;
  for (const securityMode of ['full', 'sandbox']) {
    for (const mode of ['shadow', 'enforce']) {
      for (const hostSecurityFilterChain of [true, false]) {
        for (const llmProviders of PROVIDER_SUBSETS) {
          for (const infra of ['standalone', 'distributed', 'skip']) {
            combinations += 1;
            const tree = buildCliContexaTree({
              securityMode, mode, hostSecurityFilterChain, llmProviders, infra,
              enableAiSecurity: true,
            });
            const ordered = expectedProviderOrder(llmProviders);
            assert.equal(tree.security.zerotrust.mode, mode.toUpperCase());
            assert.equal(tree.llm.selection.chat.priority, ordered.join(','));
            assert.equal(tree.llm.selection.embedding.priority,
              ordered.find(provider => provider !== 'anthropic') || 'openai');
            assert.equal(Boolean(tree.llm.chat && tree.llm.chat.ollama),
              llmProviders.includes('ollama'));
            assert.equal(tree.infrastructure?.mode,
              infra === 'distributed' ? 'DISTRIBUTED' : undefined);
            const hostOwned = securityMode === 'full' && hostSecurityFilterChain;
            assert.equal(tree.bridge?.ownership, hostOwned ? 'HOST_OWNED' : undefined);
            assert.equal(tree.datasource?.isolation?.['contexa-owned-application'],
              hostOwned ? false : undefined);
          }
        }
      }
    }
  }
  assert.equal(combinations, 168);
});

test('Merge build injection contains exactly the selected providers and infrastructure dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-option-build-'));
  const allArtifacts = springAiProviderArtifacts(['openai', 'anthropic', 'ollama']);
  try {
    for (const buildTool of ['gradle', 'gradle-kts', 'maven']) {
      for (const llmProviders of PROVIDER_SUBSETS) {
        for (const infra of ['standalone', 'distributed']) {
          const caseDir = path.join(root, buildTool, llmProviders.join('-'), infra);
          await fs.ensureDir(caseDir);
          const buildPath = path.join(caseDir,
            buildTool === 'maven' ? 'pom.xml'
              : buildTool === 'gradle-kts' ? 'build.gradle.kts' : 'build.gradle');
          const initial = buildTool === 'maven'
            ? '<project><modelVersion>4.0.0</modelVersion><groupId>x</groupId><artifactId>x</artifactId><version>1</version><dependencies>\n</dependencies>\n</project>\n'
            : 'plugins { id \'java\' }\n\ndependencies {\n}\n';
          await fs.writeFile(buildPath, initial);
          if (buildTool === 'maven') await injectMavenDep(buildPath);
          else await injectGradleDep(buildPath);
          await injectSpringAiDeps(buildPath, llmProviders);
          if (infra === 'distributed') await injectDistributedDeps(buildPath);
          const output = await fs.readFile(buildPath, 'utf8');
          assert.ok(output.includes('ai.ctxa'));
          assert.ok(output.includes('spring-boot-starter-contexa'));
          const selected = new Set(springAiProviderArtifacts(llmProviders));
          for (const artifact of allArtifacts) {
            assert.equal(output.includes(artifact), selected.has(artifact),
              `${buildTool}/${llmProviders}/${infra}: ${artifact}`);
          }
          assert.ok(output.includes('spring-ai-starter-vector-store-pgvector'));
          assert.equal(output.includes('spring-kafka'), infra === 'distributed');
          assert.equal(output.includes('redisson'), infra === 'distributed');
        }
      }
    }
  } finally {
    await fs.remove(root);
  }
});

test('Compose generation contains exactly the infrastructure selected by every provider subset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-option-compose-'));
  try {
    for (const llmProviders of PROVIDER_SUBSETS) {
      for (const infra of ['standalone', 'distributed']) {
        const target = path.join(root, llmProviders.join('-'), infra);
        const composePath = await generateDockerCompose(target, {
          infra,
          includeOllama: llmProviders.includes('ollama'),
          projectName: 'matrix',
          installationId: 'matrix',
          backupExisting: false,
        });
        const output = await fs.readFile(composePath, 'utf8');
        assert.match(output, /^  postgres:/m);
        assert.equal(/^  ollama:/m.test(output), llmProviders.includes('ollama'));
        assert.equal(/^  ollama-data:/m.test(output), llmProviders.includes('ollama'));
        for (const service of ['redis', 'zookeeper', 'kafka']) {
          assert.equal(new RegExp(`^  ${service}:`, 'm').test(output), infra === 'distributed');
        }
        for (const volume of ['redis-data', 'zookeeper-data', 'zookeeper-log', 'kafka-data']) {
          assert.equal(new RegExp(`^  ${volume}:`, 'm').test(output), infra === 'distributed');
        }
      }
    }
  } finally {
    await fs.remove(root);
  }
});

test('Standalone generation reflects every provider and infrastructure choice without modifying host files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-option-standalone-'));
  const allArtifacts = springAiProviderArtifacts(['openai', 'anthropic', 'ollama']);
  try {
    for (const buildTool of ['gradle', 'maven']) {
      for (const llmProviders of PROVIDER_SUBSETS) {
        for (const infra of ['standalone', 'distributed', 'skip']) {
          const caseDir = path.join(root, buildTool, llmProviders.join('-'), infra);
          await fs.ensureDir(path.join(caseDir, 'src', 'main', 'java'));
          const buildPath = path.join(caseDir, buildTool === 'maven' ? 'pom.xml' : 'build.gradle');
          const hostBuild = buildTool === 'maven' ? '<project>host</project>\n' : '// host build\n';
          const hostYmlPath = path.join(caseDir, 'application.yml');
          const hostSourcePath = path.join(caseDir, 'src', 'main', 'java', 'App.java');
          await fs.writeFile(buildPath, hostBuild);
          await fs.writeFile(hostYmlPath, 'host: true\n');
          await fs.writeFile(hostSourcePath, 'class App {}\n');
          const standaloneDir = path.join(caseDir, 'contexa');
          const result = await injectStandalone(standaloneDir, {
            buildTool: buildTool === 'maven' ? 'maven' : 'gradle',
            buildFilePath: buildPath,
          }, {
            infra, llmProviders, enableAiSecurity: true,
            securityMode: 'full', mode: 'enforce', hostSecurityFilterChain: true,
          });
          assert.equal(await fs.readFile(buildPath, 'utf8'), hostBuild);
          assert.equal(await fs.readFile(hostYmlPath, 'utf8'), 'host: true\n');
          assert.equal(await fs.readFile(hostSourcePath, 'utf8'), 'class App {}\n');

          const generatedYml = await fs.readFile(result.ymlPath, 'utf8');
          assert.match(generatedYml, /mode: ENFORCE/);
          assert.equal(generatedYml.includes('mode: DISTRIBUTED'), infra === 'distributed');
          assert.equal(generatedYml.includes('ollama:'), llmProviders.includes('ollama'));
          const fragment = await fs.readFile(result.buildFragmentPath, 'utf8');
          const selected = new Set(springAiProviderArtifacts(llmProviders));
          for (const artifact of allArtifacts) {
            assert.equal(fragment.includes(artifact), selected.has(artifact),
              `${buildTool}/${llmProviders}/${infra}: ${artifact}`);
          }
          assert.ok(fragment.includes('spring-ai-starter-vector-store-pgvector'));
          assert.equal(fragment.includes('spring-kafka'), infra === 'distributed');
          assert.equal(fragment.includes('redisson'), infra === 'distributed');
        }
      }
    }
  } finally {
    await fs.remove(root);
  }
});
async function createExecutableFixture(prefix, buildTool = 'gradle') {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const buildPath = path.join(project, buildTool === 'maven' ? 'pom.xml' : 'build.gradle');
  const build = buildTool === 'maven'
    ? '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>host</artifactId><version>1</version><dependencies>\n<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>\n</dependencies>\n</project>\n'
    : "plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n";
  const ymlPath = path.join(project, 'src', 'main', 'resources', 'application.yml');
  const ymlText = 'server:\n  port: 9080\nhost:\n  preserved: true\n';
  const sourcePath = path.join(project, 'src', 'main', 'java', 'example', 'HostApplication.java');
  const sourceText = 'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class HostApplication {}\n';
  await fs.outputFile(buildPath, build);
  if (buildTool !== 'maven') {
    await fs.writeFile(path.join(project, 'settings.gradle'), "rootProject.name = 'host'\n");
  }
  await fs.outputFile(ymlPath, ymlText);
  await fs.outputFile(sourcePath, sourceText);
  return { project, buildPath, build, ymlPath, ymlText, sourcePath, sourceText };
}

async function executeInteractiveSelection(fixture, selection, options = {}) {
  inquirer.prompt = async () => ({ ...selection });
  try {
    await executeInit({
      dir: fixture.project,
      docker: false,
      infraDir: path.join(fixture.project, 'contexa', 'infra'),
      ...options,
    });
  } finally {
    inquirer.prompt = originalPrompt;
  }
}

function resetFixture(project, options = {}) {
  const cliPath = path.resolve(__dirname, '../src/index.js');
  const childEnv = { ...process.env, ...(options.env || {}) };
  if (!options.docker) childEnv.PATH = path.dirname(process.execPath);
  return spawnSync(process.execPath, [cliPath, 'reset', '--yes', '--dir', project], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 10000,
  });
}

test('Custom Merge and Standalone execute end to end and reset to exact host state', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const previousSource = process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
  process.env.CONTEXA_GEOLITE2_SOURCE_PATH = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
  const merge = await createExecutableFixture('ctxa-custom-merge-');
  const standalone = await createExecutableFixture('ctxa-custom-standalone-', 'maven');
  try {
    await executeInteractiveSelection(merge, {
      setupMode: 'advanced', integrationMode: 'merge', securityMode: 'full', mode: 'enforce',
      llmProviders: ['openai', 'ollama'], infra: 'distributed', startDocker: false,
      autoAnnotate: true, infraDir: path.join(merge.project, 'contexa', 'infra'),
    });
    const mergeBuild = await fs.readFile(merge.buildPath, 'utf8');
    assert.ok(mergeBuild.includes('spring-boot-starter-contexa'));
    assert.ok(mergeBuild.includes('spring-ai-starter-model-openai'));
    assert.ok(mergeBuild.includes('spring-ai-starter-model-ollama'));
    assert.equal(mergeBuild.includes('spring-ai-starter-model-anthropic'), false);
    assert.ok(mergeBuild.includes('spring-ai-starter-vector-store-pgvector'));
    assert.ok(mergeBuild.includes('spring-kafka'));
    assert.ok(mergeBuild.includes('redisson'));
    assert.match(await fs.readFile(merge.sourcePath, 'utf8'),
      /@EnableAISecurity\(mode = SecurityMode\.FULL\)/);
    assert.equal(await fs.readFile(merge.ymlPath, 'utf8'), merge.ymlText);
    const overlayPath = path.join(merge.project, 'src', 'main', 'resources', 'application-contexa.yml');
    const overlay = yaml.load(await fs.readFile(overlayPath, 'utf8'));
    assert.equal(overlay.contexa.security.zerotrust.mode, 'ENFORCE');
    assert.equal(overlay.contexa.infrastructure.mode, 'DISTRIBUTED');
    assert.equal(overlay.contexa.llm.selection.chat.priority, 'ollama,openai');
    const composePath = path.join(merge.project, 'contexa', 'infra', 'docker-compose.yml');
    const compose = await fs.readFile(composePath, 'utf8');
    for (const service of ['postgres', 'ollama', 'redis', 'zookeeper', 'kafka']) {
      assert.match(compose, new RegExp(`^  ${service}:`, 'm'));
    }
    assert.equal((await loadManifest(merge.project)).metadata.dockerLifecycleManaged, false);

    const mergeReset = resetFixture(merge.project);
    assert.equal(mergeReset.status, 0, mergeReset.stderr + mergeReset.stdout);
    assert.match(mergeReset.stdout, /"dockerCalls":0/);
    assert.equal(await fs.readFile(merge.buildPath, 'utf8'), merge.build);
    assert.equal(await fs.readFile(merge.ymlPath, 'utf8'), merge.ymlText);
    assert.equal(await fs.readFile(merge.sourcePath, 'utf8'), merge.sourceText);
    assert.equal(await fs.pathExists(overlayPath), false);
    assert.equal(await fs.pathExists(composePath), false);
    assert.equal(await fs.pathExists(manifestPath(merge.project, INSTALL_MODES.NORMAL)), false);

    await executeInteractiveSelection(standalone, {
      setupMode: 'advanced', integrationMode: 'standalone', securityMode: 'sandbox', mode: 'shadow',
      llmProviders: ['anthropic'], infra: 'skip', startDocker: false, autoAnnotate: false,
      standaloneDir: path.join(standalone.project, 'contexa'),
    });
    assert.equal(await fs.readFile(standalone.buildPath, 'utf8'), standalone.build);
    assert.equal(await fs.readFile(standalone.ymlPath, 'utf8'), standalone.ymlText);
    assert.equal(await fs.readFile(standalone.sourcePath, 'utf8'), standalone.sourceText);
    const standaloneYmlPath = path.join(standalone.project, 'contexa', 'application.yml');
    const standaloneBuildPath = path.join(standalone.project, 'contexa', 'pom-fragment.xml');
    const standaloneYml = yaml.load((await fs.readFile(standaloneYmlPath, 'utf8'))
      .replace(/^(?:#.*\n|\n)*/, ''));
    assert.equal(standaloneYml.contexa.security.zerotrust.mode, 'SHADOW');
    assert.equal(standaloneYml.contexa.llm.selection.chat.priority, 'anthropic');
    const standaloneBuild = await fs.readFile(standaloneBuildPath, 'utf8');
    assert.ok(standaloneBuild.includes('spring-ai-starter-model-anthropic'));
    assert.equal(standaloneBuild.includes('spring-ai-starter-model-openai'), false);
    assert.equal(standaloneBuild.includes('spring-ai-starter-model-ollama'), false);
    assert.equal(standaloneBuild.includes('spring-kafka'), false);
    assert.equal(await fs.pathExists(path.join(standalone.project, 'contexa', 'infra', 'docker-compose.yml')), false);

    const standaloneReset = resetFixture(standalone.project);
    assert.equal(standaloneReset.status, 0, standaloneReset.stderr + standaloneReset.stdout);
    assert.equal(await fs.readFile(standalone.buildPath, 'utf8'), standalone.build);
    assert.equal(await fs.readFile(standalone.ymlPath, 'utf8'), standalone.ymlText);
    assert.equal(await fs.readFile(standalone.sourcePath, 'utf8'), standalone.sourceText);
    assert.equal(await fs.pathExists(standaloneYmlPath), false);
    assert.equal(await fs.pathExists(standaloneBuildPath), false);
    assert.equal(await fs.pathExists(manifestPath(standalone.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    if (previousSource === undefined) delete process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
    else process.env.CONTEXA_GEOLITE2_SOURCE_PATH = previousSource;
    await fs.remove(merge.project);
    await fs.remove(standalone.project);
  }
});

test('existing Starter honors automatic annotation yes/no and reset restores the exact host state', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const previousSource = process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
  process.env.CONTEXA_GEOLITE2_SOURCE_PATH = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
  const automatic = await createExecutableFixture('ctxa-existing-starter-auto-');
  const manual = await createExecutableFixture('ctxa-existing-starter-manual-');
  const addExistingStarter = async fixture => {
    fixture.build = fixture.build.replace('dependencies {',
      "dependencies {\n  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'");
    await fs.writeFile(fixture.buildPath, fixture.build);
  };
  try {
    await addExistingStarter(automatic);
    automatic.sourceText = automatic.sourceText.replace(
      'import org.springframework.boot.autoconfigure.SpringBootApplication;',
      'import org.springframework.boot.autoconfigure.SpringBootApplication;\n'
        + 'import io.contexa.contexacommon.annotation.EnableAISecurity;');
    await fs.writeFile(automatic.sourcePath, automatic.sourceText);
    await executeInteractiveSelection(automatic, {
      setupMode: 'advanced', integrationMode: 'merge', securityMode: 'sandbox',
      mode: 'shadow', llmProviders: ['openai'], infra: 'skip', startDocker: false,
      autoAnnotate: true,
    });
    const automaticSource = await fs.readFile(automatic.sourcePath, 'utf8');
    assert.match(automaticSource,
      /@EnableAISecurity\(mode = SecurityMode\.SANDBOX\)\n@SpringBootApplication/);
    const automaticManifest = await loadManifest(automatic.project);
    assert.equal(automaticManifest.metadata.activationResult.status, 'ACTIVE');
    assert.equal(automaticManifest.metadata.activationResult.annotationActive, true);
    assert.equal(automaticManifest.metadata.activationResult.dependenciesReady, true);

    const automaticReset = resetFixture(automatic.project);
    assert.equal(automaticReset.status, 0, automaticReset.stderr + automaticReset.stdout);
    assert.equal(await fs.readFile(automatic.sourcePath, 'utf8'), automatic.sourceText);
    assert.equal(await fs.readFile(automatic.buildPath, 'utf8'), automatic.build);
    assert.equal(await fs.pathExists(manifestPath(automatic.project, INSTALL_MODES.NORMAL)), false);

    await addExistingStarter(manual);
    await executeInteractiveSelection(manual, {
      setupMode: 'advanced', integrationMode: 'merge', securityMode: 'full',
      mode: 'enforce', llmProviders: ['anthropic'], infra: 'skip', startDocker: false,
      autoAnnotate: false,
    });
    const manualSource = await fs.readFile(manual.sourcePath, 'utf8');
    assert.doesNotMatch(manualSource, /@EnableAISecurity/);
    const manualManifest = await loadManifest(manual.project);
    assert.equal(manualManifest.metadata.activationResult.status, 'PENDING_ANNOTATION');
    assert.equal(manualManifest.metadata.activationResult.annotationActive, false);
    assert.equal(manualManifest.metadata.activationResult.dependenciesReady, true);

    const manualReset = resetFixture(manual.project);
    assert.equal(manualReset.status, 0, manualReset.stderr + manualReset.stdout);
    assert.equal(await fs.readFile(manual.sourcePath, 'utf8'), manual.sourceText);
    assert.equal(await fs.readFile(manual.buildPath, 'utf8'), manual.build);
    assert.equal(await fs.pathExists(manifestPath(manual.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    if (previousSource === undefined) delete process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
    else process.env.CONTEXA_GEOLITE2_SOURCE_PATH = previousSource;
    await fs.remove(automatic.project);
    await fs.remove(manual.project);
  }
});
test('public Quick standalone flags execute end to end with exact generated artifacts', {
  skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const fixture = await createExecutableFixture('ctxa-quick-standalone-flags-');
  const standaloneDir = path.join(fixture.project, 'contexa');
  const infraDir = path.join(standaloneDir, 'infra');
  const cliPath = path.resolve(__dirname, '../src/index.js');
  const childEnv = {
    ...process.env,
    PATH: path.dirname(process.execPath),
    CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
  };
  try {
    const initialized = spawnSync(process.execPath, [
      cliPath, 'init', '--yes', '--quick', '--standalone',
      '--standalone-dir', standaloneDir, '--security-mode', 'sandbox',
      '--provider', 'openai', '--include-ollama', '--no-docker',
      '--infra-dir', infraDir, '--dir', fixture.project,
    ], { encoding: 'utf8', env: childEnv, timeout: 10000 });
    assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
    assert.match(initialized.stdout, /SecurityMode\.SANDBOX/);
    assert.equal(await fs.readFile(fixture.buildPath, 'utf8'), fixture.build);
    assert.equal(await fs.readFile(fixture.ymlPath, 'utf8'), fixture.ymlText);
    assert.equal(await fs.readFile(fixture.sourcePath, 'utf8'), fixture.sourceText);

    const fragment = await fs.readFile(path.join(standaloneDir, 'contexa.gradle'), 'utf8');
    assert.match(fragment, /spring-ai-starter-model-openai/);
    assert.match(fragment, /spring-ai-starter-model-ollama/);
    assert.doesNotMatch(fragment, /spring-ai-starter-model-anthropic/);
    assert.match(fragment, /spring-ai-starter-vector-store-pgvector/);
    assert.doesNotMatch(fragment, /spring-kafka|redisson/);
    const generated = yaml.load(await fs.readFile(
      path.join(standaloneDir, 'application.yml'), 'utf8'));
    assert.equal(generated.contexa.llm.selection.chat.priority, 'ollama,openai');
    const compose = await fs.readFile(path.join(infraDir, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /^  postgres:/m);
    assert.match(compose, /^  ollama:/m);
    assert.doesNotMatch(compose, /^  (?:redis|zookeeper|kafka):/m);
    const manifest = await loadManifest(fixture.project);
    assert.equal(manifest.metadata.integrationMode, 'standalone');
    assert.equal(manifest.metadata.infra, 'standalone');
    assert.equal(manifest.metadata.dockerLifecycleManaged, false);

    const reset = resetFixture(fixture.project, { env: childEnv });
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.match(reset.stdout, /"dockerCalls":0/);
    assert.equal(await fs.readFile(fixture.buildPath, 'utf8'), fixture.build);
    assert.equal(await fs.readFile(fixture.ymlPath, 'utf8'), fixture.ymlText);
    assert.equal(await fs.readFile(fixture.sourcePath, 'utf8'), fixture.sourceText);
    assert.equal(await fs.pathExists(path.join(standaloneDir, 'application.yml')), false);
    assert.equal(await fs.pathExists(path.join(standaloneDir, 'contexa.gradle')), false);
    assert.equal(await fs.pathExists(path.join(infraDir, 'docker-compose.yml')), false);
    assert.equal(await fs.pathExists(manifestPath(fixture.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    await fs.remove(fixture.project);
  }
});

test('Standalone prepared-directory allowance remains exact and rejects unrelated customer files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-standalone-boundary-'));
  try {
    const allowed = path.join(root, 'allowed');
    const geo = path.join(allowed, 'data', 'GeoLite2-City.mmdb');
    await fs.outputFile(geo, 'verified');
    await fs.outputFile(path.join(allowed, '.cli', 'state.json'), '{}');
    await fs.writeFile(path.join(allowed, 'manifest.json'), '{}');
    await fs.writeFile(path.join(allowed, '.init.lock'), '');
    await injectStandalone(allowed, { buildTool: 'gradle', buildFilePath: 'build.gradle' }, {
      infra: 'skip', enableAiSecurity: true, llmProviders: ['openai'], preparedPaths: [geo],
    });
    assert.equal(await fs.pathExists(path.join(allowed, 'application.yml')), true);

    const rejected = path.join(root, 'rejected');
    const rejectedGeo = path.join(rejected, 'data', 'GeoLite2-City.mmdb');
    await fs.outputFile(rejectedGeo, 'verified');
    await fs.outputFile(path.join(rejected, '.cli', 'state.json'), '{}');
    await fs.writeFile(path.join(rejected, 'manifest.json'), '{}');
    await fs.writeFile(path.join(rejected, 'customer.txt'), 'must remain untouched');
    await assert.rejects(
      injectStandalone(rejected, { buildTool: 'gradle', buildFilePath: 'build.gradle' }, {
        infra: 'skip', enableAiSecurity: true, llmProviders: ['openai'],
        preparedPaths: [rejectedGeo],
      }),
      /does not look like a contexa-cli output folder/
    );
    assert.equal(await fs.readFile(path.join(rejected, 'customer.txt'), 'utf8'),
      'must remain untouched');
  } finally {
    await fs.remove(root);
  }
});
async function verifyQuickEndToEnd(providerQuick, autoAnnotate) {
  const previousSource = process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
  process.env.CONTEXA_GEOLITE2_SOURCE_PATH = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
  const fixture = await createExecutableFixture(`ctxa-quick-${providerQuick}-`);
  try {
    await executeInteractiveSelection(fixture, {
      setupMode: 'quick', providerQuick, autoAnnotate,
    });
    const build = await fs.readFile(fixture.buildPath, 'utf8');
    assert.ok(build.includes('spring-boot-starter-contexa'));
    const selectedArtifact = springAiProviderArtifacts([providerQuick])[0];
    for (const artifact of springAiProviderArtifacts(['openai', 'anthropic', 'ollama'])) {
      assert.equal(build.includes(artifact), artifact === selectedArtifact);
    }
    assert.ok(build.includes('spring-ai-starter-vector-store-pgvector'));
    assert.equal(build.includes('spring-kafka'), false);
    assert.equal(build.includes('redisson'), false);

    const source = await fs.readFile(fixture.sourcePath, 'utf8');
    assert.equal(/@EnableAISecurity\(mode = SecurityMode\.FULL\)/.test(source), autoAnnotate);
    const overlayPath = path.join(fixture.project,
      'src', 'main', 'resources', 'application-contexa.yml');
    const overlay = yaml.load(await fs.readFile(overlayPath, 'utf8'));
    assert.equal(overlay.contexa.security.zerotrust.mode, 'SHADOW');
    assert.equal(overlay.contexa.llm.selection.chat.priority, providerQuick);
    assert.equal(overlay.contexa.infrastructure, undefined);
    const composePath = path.join(fixture.project, 'contexa', 'infra', 'docker-compose.yml');
    const compose = await fs.readFile(composePath, 'utf8');
    assert.match(compose, /^  postgres:/m);
    assert.equal(/^  ollama:/m.test(compose), providerQuick === 'ollama');
    assert.equal(/^  redis:/m.test(compose), false);
    assert.equal(/^  kafka:/m.test(compose), false);

    const reset = resetFixture(fixture.project);
    assert.equal(reset.status, 0, reset.stderr + reset.stdout);
    assert.match(reset.stdout, /"dockerCalls":0/);
    assert.equal(await fs.readFile(fixture.buildPath, 'utf8'), fixture.build);
    assert.equal(await fs.readFile(fixture.ymlPath, 'utf8'), fixture.ymlText);
    assert.equal(await fs.readFile(fixture.sourcePath, 'utf8'), fixture.sourceText);
    assert.equal(await fs.pathExists(overlayPath), false);
    assert.equal(await fs.pathExists(composePath), false);
    assert.equal(await fs.pathExists(manifestPath(fixture.project, INSTALL_MODES.NORMAL)), false);
  } finally {
    if (previousSource === undefined) delete process.env.CONTEXA_GEOLITE2_SOURCE_PATH;
    else process.env.CONTEXA_GEOLITE2_SOURCE_PATH = previousSource;
    await fs.remove(fixture.project);
  }
}

for (const providerQuick of ['openai', 'anthropic', 'ollama']) {
  for (const autoAnnotate of [true, false]) {
    test(`Quick ${providerQuick} auto-annotation=${autoAnnotate} executes init/reset end to end`, {
      skip: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
        ? false : 'requires CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
    }, () => verifyQuickEndToEnd(providerQuick, autoAnnotate));
  }
}
test('Docker applies standalone and distributed selections and reset removes only owned resources', {
  skip: process.env.CONTEXA_TEST_DOCKER === '1' && process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH
    ? false : 'requires CONTEXA_TEST_DOCKER=1 and CONTEXA_TEST_GEOLITE2_SOURCE_PATH',
}, async () => {
  const originalEnvironment = {};
  const environmentKeys = [
    'CONTEXA_GEOLITE2_SOURCE_PATH', 'CONTEXA_PROJECT', 'COMPOSE_BIND_HOST',
    'CONTEXA_POSTGRES_PORT', 'CONTEXA_OLLAMA_PORT', 'CONTEXA_REDIS_PORT',
    'CONTEXA_ZOOKEEPER_PORT', 'CONTEXA_KAFKA_PORT',
  ];
  for (const key of environmentKeys) originalEnvironment[key] = process.env[key];
  const cases = [
    {
      infra: 'standalone', projectName: `ctxa-opt-standalone-${process.pid}`,
      ports: { postgres: '45432', ollama: '45434', redis: '45479', zookeeper: '45281', kafka: '45092' },
      providers: ['openai'], services: ['postgres'],
    },
    {
      infra: 'distributed', projectName: `ctxa-opt-distributed-${process.pid}`,
      ports: { postgres: '45532', ollama: '45534', redis: '45579', zookeeper: '45381', kafka: '45192' },
      providers: ['openai'], services: ['postgres', 'redis', 'zookeeper', 'kafka'],
    },
  ];
  try {
    process.env.CONTEXA_GEOLITE2_SOURCE_PATH = process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH;
    process.env.COMPOSE_BIND_HOST = '127.0.0.1';
    for (const value of cases) {
      const fixture = await createExecutableFixture(`ctxa-docker-${value.infra}-`);
      await fs.writeFile(path.join(fixture.project, 'settings.gradle'),
        `rootProject.name = '${value.projectName}'\n`);
      process.env.CONTEXA_PROJECT = value.projectName;
      process.env.CONTEXA_POSTGRES_PORT = value.ports.postgres;
      process.env.CONTEXA_OLLAMA_PORT = value.ports.ollama;
      process.env.CONTEXA_REDIS_PORT = value.ports.redis;
      process.env.CONTEXA_ZOOKEEPER_PORT = value.ports.zookeeper;
      process.env.CONTEXA_KAFKA_PORT = value.ports.kafka;
      let resetCompleted = false;
      try {
        await executeInteractiveSelection(fixture, {
          setupMode: 'advanced', integrationMode: 'merge', securityMode: 'sandbox',
          mode: 'shadow', llmProviders: value.providers, infra: value.infra,
          startDocker: true, autoAnnotate: false,
          infraDir: path.join(fixture.project, 'contexa', 'infra'),
        }, { docker: true });
        const manifest = await loadManifest(fixture.project);
        assert.equal(manifest.metadata.dockerLifecycleManaged, true);
        assert.equal(manifest.metadata.infra, value.infra);
        const running = spawnSync('docker', [
          'ps', '--filter', `label=io.ctxa.installation-id=${manifest.metadata.installationId}`,
          '--format', '{{.Names}}',
        ], { encoding: 'utf8', timeout: 5000 });
        assert.equal(running.status, 0, running.stderr);
        const names = new Set(running.stdout.trim().split(/\r?\n/).filter(Boolean));
        for (const service of value.services) {
          assert.ok(names.has(`${value.projectName}-${service}`),
            `missing running ${value.projectName}-${service}`);
        }

        const reset = resetFixture(fixture.project, { docker: true });
        assert.equal(reset.status, 0, reset.stderr + reset.stdout);
        assert.match(reset.stdout, /"dockerCalls":1/);
        resetCompleted = true;
        const remaining = spawnSync('docker', [
          'ps', '-a', '--filter', `label=io.ctxa.installation-id=${manifest.metadata.installationId}`,
          '--format', '{{.Names}}',
        ], { encoding: 'utf8', timeout: 5000 });
        assert.equal(remaining.status, 0, remaining.stderr);
        assert.equal(remaining.stdout.trim(), '');
        assert.equal(await fs.readFile(fixture.buildPath, 'utf8'), fixture.build);
        assert.equal(await fs.readFile(fixture.ymlPath, 'utf8'), fixture.ymlText);
        assert.equal(await fs.readFile(fixture.sourcePath, 'utf8'), fixture.sourceText);
      } finally {
        if (!resetCompleted && await fs.pathExists(manifestPath(fixture.project))) {
          resetFixture(fixture.project, { docker: true });
        }
        await fs.remove(fixture.project);
      }
    }
  } finally {
    for (const key of environmentKeys) {
      if (originalEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnvironment[key];
    }
  }
});