'use strict';

// Regression lock for the "user claim 0" guarantees:
//   1. contexa-cli must not touch any customer file beyond build.gradle/pom.xml
//      and application.yml (and even those are skipped in standalone mode).
//   2. Container/compose-project naming must be dynamic so simulate runs do
//      not collide with a production stack on the same host.
//   3. detector.hasContexta must not flip true on commented-out include lines.
//
// Each test below pins one of those guarantees in place. Breaking any of them
// is what produced the side-effects the user explicitly forbids.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  generateDockerCompose,
  injectGradleDep, injectStandalone, injectYml, normalOverlayPath,
  findTopLevelDependenciesInsertIndex, insertIntoTopLevelDependencies,
} = require('../src/core/injector');
const { containerName, resolveProjectName } = require('../src/core/project');
const {
  normalizePath,
  activationResult,
  HOST_IAM_CONTRACT,
  BRIDGE_CONTRACT,
  FULL_MODE_CONTRACT,
} = require('../src/core/init-plan');
const { collectInitAnswers } = require('../src/core/init-input');
const { detectSpringProject } = require('../src/core/detector');
const { SIMULATION_PROJECT, simulationEnvironment } = require('../src/core/simulation');

async function tempDir(prefix = 'ctxa-claim0-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('explicit AI activation without a provider fails before any mutation plan is created', async () => {
  const project = {
    hasEnableAiSecurity: false,
    hasHostSecurityFilterChain: true,
    hasDocker: false,
  };
  await assert.rejects(
    collectInitAnswers({
      yes: true,
      enableAiSecurity: true,
      autoAnnotate: false,
      includeOllama: false,
      simulate: false,
      distributed: false,
      docker: false,
      dir: process.cwd(),
    }, project, 'fail-closed'),
    error => error && error.code === 'AI_SECURITY_PROVIDER_REQUIRED'
  );
});

test('explicit AI activation records the selected provider and requested security mode', async () => {
  const answers = await collectInitAnswers({
    yes: true,
    enableAiSecurity: true,
    provider: 'ollama',
    securityMode: 'full',
    autoAnnotate: false,
    includeOllama: false,
    simulate: false,
    distributed: false,
    docker: false,
    dir: process.cwd(),
  }, {
    hasEnableAiSecurity: false,
    hasHostSecurityFilterChain: true,
    hasDocker: false,
  }, 'explicit-activation');
  assert.equal(answers.enableAiSecurity, true);
  assert.deepEqual(answers.llmProviders, ['ollama']);
  assert.equal(answers.securityMode, 'full');
  assert.equal(answers.hostSecurityFilterChain, true);
});

test('activation result keeps FULL scoped to Contexa policy and host IAM unchanged', () => {
  const active = activationResult({
    enableAiSecurity: true,
    llmProviders: ['ollama'],
    securityMode: 'full',
    mode: 'enforce',
    simulate: false,
  }, {
    hasEnableAiSecurity: true,
  }, {
    aiAnnotationApplied: true,
    aiDependenciesProcessed: true,
  });
  assert.equal(active.enabled, true);
  assert.equal(active.status, 'ACTIVE');
  assert.equal(active.securityMode, 'FULL');
  assert.equal(active.hostIamContract, HOST_IAM_CONTRACT);
  assert.equal(active.bridgeContract, BRIDGE_CONTRACT);
  assert.equal(active.fullModeContract, FULL_MODE_CONTRACT);

  const pending = activationResult({
    enableAiSecurity: true,
    llmProviders: ['ollama'],
    securityMode: 'sandbox',
    mode: 'shadow',
    simulate: false,
  }, {
    hasEnableAiSecurity: false,
  }, {
    aiAnnotationApplied: false,
    aiDependenciesProcessed: true,
  });
  assert.equal(pending.enabled, false);
  assert.equal(pending.status, 'PENDING_ANNOTATION');
});

test('normal explicit activation writes only the Contexa-owned overlay', async () => {
  const root = await tempDir('ctxa-normal-overlay-');
  const resources = path.join(root, 'src/main/resources');
  const hostFiles = new Map([
    [path.join(resources, 'application.yml'), '# host yaml\nshared: &base\n  value: "keep"\n---\nserver:\n  port: 8080\n'],
    [path.join(resources, 'application.yaml'), 'host:\n  yaml: unchanged\n'],
    [path.join(resources, 'application.properties'), 'host.property=unchanged\\:value\n'],
    [path.join(resources, 'application-prod.yml'), 'host:\n  profile: prod\n'],
  ]);
  try {
    for (const [file, content] of hostFiles) await fs.outputFile(file, content, 'utf8');
    const before = new Map();
    for (const [file] of hostFiles) before.set(file, await fs.readFile(file));

    const overlay = normalOverlayPath(root);
    await injectYml(overlay, {
      enableAiSecurity: true,
      llmProviders: ['ollama'],
      securityMode: 'sandbox',
      mode: 'enforce',
      infra: 'standalone',
    });

    assert.equal(path.basename(overlay), 'application-contexa.yml');
    assert.equal(await fs.pathExists(overlay), true);
    for (const [file] of hostFiles) assert.deepEqual(await fs.readFile(file), before.get(file));
    const parsed = yaml.load(await fs.readFile(overlay, 'utf8'));
    assert.equal(parsed.server, undefined);
    assert.equal(parsed.contexa.security.zerotrust.mode, 'ENFORCE');
    assert.equal(parsed.contexa.llm.selection.chat.priority, 'ollama');
  } finally {
    await fs.remove(root);
  }
});

// =====================================================================
// S1 + S2 - generateDockerCompose must operate only on the contexa-owned infra
// dir argument it receives. Schema/seed SQL is not generated by contexa-cli;
// it is installed by contexa-iam when the application starts.
// =====================================================================

test('S1: generateDockerCompose writes ONLY to the infra dir, never to the customer dir', async () => {
  const root = await tempDir();
  try {
    const customerDir = path.join(root, 'customer');
    const infraDir    = path.join(root, 'infra');
    await fs.ensureDir(customerDir);
    const customerCompose = path.join(customerDir, 'docker-compose.yml');
    const customerContent = 'services:\n  myapp:\n    image: my/app:1.0\n';
    await fs.writeFile(customerCompose, customerContent);

    await generateDockerCompose(infraDir, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });

    assert.equal(await fs.readFile(customerCompose, 'utf8'), customerContent,
      'customer docker-compose.yml must not be modified');
    assert.equal(await fs.pathExists(path.join(infraDir, 'docker-compose.yml')), true,
      'infra docker-compose.yml must be created');
  } finally { await fs.remove(root); }
});

test('S2: contexa-cli does not generate initdb SQL in customer or infra dirs', async () => {
  const root = await tempDir();
  try {
    const customerDir = path.join(root, 'customer');
    const infraDir    = path.join(root, 'infra');
    await fs.ensureDir(path.join(customerDir, 'initdb'));
    const customerSql = path.join(customerDir, 'initdb', '01-customer.sql');
    const customerContent = '-- customer-owned schema\nCREATE TABLE users(id INT);\n';
    await fs.writeFile(customerSql, customerContent);

    await generateDockerCompose(infraDir, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'distributed',
    });

    assert.equal(await fs.readFile(customerSql, 'utf8'), customerContent,
      'customer initdb file must not be modified');
    assert.equal(await fs.pathExists(path.join(infraDir, 'initdb', '01-core-ddl.sql')), false,
      'CLI must not write 01-core-ddl.sql under infraDir');
    assert.equal(await fs.pathExists(path.join(infraDir, 'initdb', '02-dml.sql')), false,
      'CLI must not write 02-dml.sql under infraDir');
    assert.equal(await fs.pathExists(path.join(customerDir, 'initdb', '02-dml.sql')), false,
      'CLI must not write 02-dml.sql under the customer directory');
  } finally { await fs.remove(root); }
});

// =====================================================================
// S3 - containerName must be dynamic per CONTEXA_PROJECT so production and
// simulate runs do not collide on the same Docker host. Hard-coding
// "contexa-ollama" was the bug.
// =====================================================================

test('S3: containerName respects CONTEXA_PROJECT env (production vs simulate)', () => {
  const original = process.env.CONTEXA_PROJECT;
  try {
    delete process.env.CONTEXA_PROJECT;
    assert.equal(containerName('ollama'), 'contexa-ollama');
    assert.equal(resolveProjectName(), 'contexa');

    process.env.CONTEXA_PROJECT = 'ctxa-sim';
    assert.equal(containerName('ollama'), 'ctxa-sim-ollama');
    assert.equal(resolveProjectName(), 'ctxa-sim');
    assert.equal(resolveProjectName('detected-project'), 'ctxa-sim',
      'CONTEXA_PROJECT must override an auto-detected fallback name');
    assert.equal(containerName('postgres', 'manifest-project'), 'manifest-project-postgres',
      'ownership checks must be able to target the manifest project explicitly');

    process.env.CONTEXA_PROJECT = 'acme-prod';
    assert.equal(containerName('postgres'), 'acme-prod-postgres');
  } finally {
    if (original === undefined) delete process.env.CONTEXA_PROJECT;
    else process.env.CONTEXA_PROJECT = original;
  }
});

// =====================================================================
// S4 - top-level Gradle dependencies block detection. The previous
// `dependencies\s*\{` regex matched the first occurrence in the file,
// which in legacy `buildscript { dependencies { classpath ... } }` builds
// is the buildscript scope, not the top-level dependencies block. Inserting
// `implementation 'foo'` there breaks the build.
// =====================================================================

test('S4: findTopLevelDependenciesInsertIndex skips buildscript { dependencies { } }', () => {
  const gradle = `buildscript {
    repositories { mavenCentral() }
    dependencies {
        classpath 'org.springframework.boot:spring-boot-gradle-plugin:3.5.0'
    }
}

apply plugin: 'java'

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
}
`;
  const idx = findTopLevelDependenciesInsertIndex(gradle);
  assert.notEqual(idx, -1);
  // The matched insertion point must be AFTER the buildscript block ends.
  const buildscriptEnd = gradle.indexOf('}\n\napply');
  assert.ok(idx > buildscriptEnd,
    `insertion index ${idx} must be after the buildscript closing brace at ${buildscriptEnd}`);
});

test('S4: insertIntoTopLevelDependencies puts impl line in top-level, not buildscript', () => {
  const gradle = `buildscript {
    dependencies {
        classpath 'p:q:1'
    }
}

dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
}
`;
  const updated = insertIntoTopLevelDependencies(gradle, ["    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'"]);
  // The new line must NOT be inside the buildscript block.
  const buildscriptBlock = updated.match(/buildscript\s*\{[\s\S]*?\n\}/m)[0];
  assert.equal(buildscriptBlock.includes('spring-boot-starter-contexa'), false,
    'starter line must not appear inside buildscript');
  // The new line MUST appear inside the top-level block.
  const topLevelBlock = updated.split('buildscript')[0]
    + updated.slice(buildscriptBlock.length + updated.indexOf(buildscriptBlock));
  assert.ok(updated.includes("implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'"),
    'starter line must be inserted somewhere');
  assert.ok(topLevelBlock.includes('spring-boot-starter-contexa'),
    'starter line must be inside the top-level dependencies block');
});

test('S4: injectGradleDep into a buildscript-only build appends a new top-level block', async () => {
  const root = await tempDir();
  try {
    const buildPath = path.join(root, 'build.gradle');
    const original = `buildscript {
    dependencies {
        classpath 'p:q:1'
    }
}

apply plugin: 'java'
`;
    await fs.writeFile(buildPath, original);
    const ok = await injectGradleDep(buildPath);
    assert.equal(ok, true);
    const updated = await fs.readFile(buildPath, 'utf8');
    // buildscript block remains untouched
    assert.ok(updated.includes("classpath 'p:q:1'"));
    assert.equal(updated.match(/buildscript\s*\{[\s\S]*?dependencies\s*\{[\s\S]*?\n\s*\}/m)[0]
      .includes('spring-boot-starter-contexa'), false,
      'starter must not be injected inside buildscript');
    // a new top-level dependencies block exists
    assert.ok(updated.match(/(^|\n)dependencies\s*\{[\s\S]*?spring-boot-starter-contexa[\s\S]*?\}/m),
      'new top-level dependencies block with starter must exist');
  } finally { await fs.remove(root); }
});

// =====================================================================
// Mode 2 (Standalone) - the customer's build.gradle / pom.xml /
// application.yml MUST be byte-identical before and after init in
// standalone mode. All artifacts go to a separate folder.
// =====================================================================

test('Mode 2: injectStandalone leaves customer build.gradle and application.yml byte-identical', async () => {
  const root = await tempDir();
  try {
    const customerDir   = path.join(root, 'customer');
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(path.join(customerDir, 'src/main/resources'));
    const buildPath = path.join(customerDir, 'build.gradle');
    const ymlPath   = path.join(customerDir, 'src/main/resources/application.yml');
    const buildContent = `plugins { id 'java' }
dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web'
}
`;
    const ymlContent = "spring:\n  application:\n    name: my-app\n";
    await fs.writeFile(buildPath, buildContent);
    await fs.writeFile(ymlPath, ymlContent);

    const project = {
      buildTool: 'gradle',
      buildFilePath: buildPath,
      hasEnableAiSecurity: false,
    };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });

    // Customer files: byte-identical.
    assert.equal(await fs.readFile(buildPath, 'utf8'), buildContent,
      'customer build.gradle must be byte-identical');
    assert.equal(await fs.readFile(ymlPath, 'utf8'), ymlContent,
      'customer application.yml must be byte-identical');

    // Standalone artifacts must exist with the expected names.
    assert.equal(result.ymlPath, path.join(standaloneDir, 'application.yml'));
    assert.equal(result.buildFragmentPath, path.join(standaloneDir, 'contexa.gradle'));
    assert.equal(await fs.pathExists(result.ymlPath), true);
    assert.equal(await fs.pathExists(result.buildFragmentPath), true);

    // The standalone yml must contain the contexa.* tree.
    const out = await fs.readFile(result.ymlPath, 'utf8');
    const parsed = yaml.load(out.replace(/^#.*$/gm, ''));
    assert.ok(parsed.contexa, 'standalone application.yml must have contexa: tree');
    assert.equal(parsed.contexa.security.zerotrust.mode, 'SHADOW');

    // The standalone gradle fragment must contain the starter line.
    const buildFrag = await fs.readFile(result.buildFragmentPath, 'utf8');
    assert.ok(buildFrag.includes('ai.ctxa:spring-boot-starter-contexa'),
      'standalone contexa.gradle must contain the starter implementation line');
  } finally { await fs.remove(root); }
});

test('Mode 2: Maven projects get pom-fragment.xml, not contexa.gradle', async () => {
  const root = await tempDir();
  try {
    const customerDir   = path.join(root, 'customer');
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(customerDir);
    const pomPath = path.join(customerDir, 'pom.xml');
    const pomContent = '<project><artifactId>x</artifactId><dependencies></dependencies></project>';
    await fs.writeFile(pomPath, pomContent);

    const project = {
      buildTool: 'maven',
      buildFilePath: pomPath,
      hasEnableAiSecurity: false,
    };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });

    // Customer pom.xml: byte-identical.
    assert.equal(await fs.readFile(pomPath, 'utf8'), pomContent);

    // Maven produces a pom-fragment.xml.
    assert.equal(result.buildFragmentPath, path.join(standaloneDir, 'pom-fragment.xml'));
    assert.equal(result.importHints.isMaven, true);

    const fragment = await fs.readFile(result.buildFragmentPath, 'utf8');
    assert.ok(fragment.includes('<groupId>ai.ctxa</groupId>'));
    assert.ok(fragment.includes('<artifactId>spring-boot-starter-contexa</artifactId>'));
  } finally { await fs.remove(root); }
});

test('Mode 2: distributed infra adds spring-kafka and redisson to the gradle fragment', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    const project = {
      buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'),
      hasEnableAiSecurity: false,
    };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'distributed',
    });
    const frag = await fs.readFile(result.buildFragmentPath, 'utf8');
    assert.ok(frag.includes('spring-kafka'), 'distributed must add spring-kafka');
    assert.ok(frag.includes('redisson'), 'distributed must add redisson');
  } finally { await fs.remove(root); }
});

// =====================================================================
// C1 - contexa-cli must add EXACTLY ONE dependency line:
// `ai.ctxa:spring-boot-starter-contexa`. Spring AI provider starters and
// the pgvector vector-store starter are the customer's responsibility,
// not ours. Adding them automatically breaks customers who depend on
// spring-boot-starter-contexa without declaring @EnableAISecurity (the
// PgVector/ChatModel beans try to instantiate against missing
// infrastructure and the application fails to start).
// =====================================================================

test('C1: injectStandalone NEVER adds Spring AI provider starters even when hasEnableAiSecurity=true', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    const project = {
      buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'),
      hasEnableAiSecurity: true,
    };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama', 'openai'], infra: 'standalone',
    });
    const frag = await fs.readFile(result.buildFragmentPath, 'utf8');
    assert.equal(frag.includes('spring-ai-starter-model-ollama'), false,
      'spring-ai-starter-model-ollama must NOT appear in the fragment');
    assert.equal(frag.includes('spring-ai-starter-model-openai'), false,
      'spring-ai-starter-model-openai must NOT appear in the fragment');
    assert.equal(frag.includes('spring-ai-starter-model-anthropic'), false);
    assert.equal(frag.includes('spring-ai-starter-vector-store-pgvector'), false,
      'spring-ai-starter-vector-store-pgvector must NOT appear in the fragment');
    // The starter line is the only mandatory contexa dependency.
    assert.ok(frag.includes('ai.ctxa:spring-boot-starter-contexa'));
  } finally { await fs.remove(root); }
});

test('C1: injector.js no longer exports injectAiStarterDeps', () => {
  const exported = require('../src/core/injector');
  assert.equal('injectAiStarterDeps' in exported, false,
    'injectAiStarterDeps must not be re-exported. Customer dep surface stays opt-in.');
});

// =====================================================================
// F3 - detector must not flip hasContexta=true on commented-out include
// lines in a parent settings.gradle.
// =====================================================================

test('F3: detector ignores commented-out include lines in parent settings.gradle', async () => {
  const root = await tempDir();
  try {
    const moduleDir = path.join(root, 'web');
    await fs.ensureDir(moduleDir);
    // parent settings.gradle: include 'web' is commented out
    await fs.writeFile(path.join(root, 'settings.gradle'),
      "rootProject.name = 'parent'\n// include 'web'\ninclude 'api'\n");
    // parent build.gradle has the contexa starter (would falsely trigger
    // hasContexta if detector failed to skip the commented include).
    await fs.writeFile(path.join(root, 'build.gradle'),
      "subprojects { dependencies { implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0' } }\n");
    // module's own build.gradle is minimal and does NOT contain the starter
    await fs.writeFile(path.join(moduleDir, 'build.gradle'),
      "plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");

    const result = await detectSpringProject(moduleDir);
    assert.equal(result.isSpring, true);
    assert.equal(result.hasContexta, false,
      'hasContexta must remain false when the parent settings include line is commented out');
  } finally { await fs.remove(root); }
});

// =====================================================================
// A1 - simulate command must work with NO flags and NO env vars right
// after `contexa init --simulate`. The previous bug was that simulate
// derived its project name from CONTEXA_PROJECT, which is only set by
// init in-process; running `contexa simulate up` in a fresh shell would
// resolve to "contexa", not "ctxa-sim", and miss the directory init
// just created.
//
// This regression test pins the hard-wiring: the simulate command always
// targets the ctxa-sim project regardless of CONTEXA_PROJECT.
// =====================================================================

test('A1: simulate.js targets ctxa-sim regardless of CONTEXA_PROJECT', () => {
  const simSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'simulate.js'), 'utf8');
  const env = simulationEnvironment({
    CONTEXA_PROJECT: 'production-project',
    CONTEXA_POSTGRES_PORT: '5432',
    CONTEXA_DB_URL: 'jdbc:postgresql://production/db',
    REDIS_HOST: 'production-redis',
    KAFKA_BOOTSTRAP_SERVERS: 'production-kafka:9092',
    OLLAMA_BASE_URL: 'http://production-ollama:11434',
    CONTEXA_OLLAMA_IMAGE_TAG: 'latest',
    CONTEXA_REDIS_IMAGE_TAG: 'foreign',
  }, 'test-installation');
  assert.equal(SIMULATION_PROJECT, 'ctxa-sim');
  assert.equal(env.CONTEXA_PROJECT, 'ctxa-sim');
  assert.equal(env.CONTEXA_POSTGRES_PORT, '25432');
  assert.equal(env.CONTEXA_DB_URL, 'jdbc:postgresql://127.0.0.1:25432/contexa_sim');
  assert.equal(env.REDIS_HOST, '127.0.0.1');
  assert.equal(env.KAFKA_BOOTSTRAP_SERVERS, '127.0.0.1:29092');
  assert.equal(env.OLLAMA_BASE_URL, 'http://127.0.0.1:31434');
  assert.equal(env.CONTEXA_OLLAMA_IMAGE_TAG, '0.18.2');
  assert.equal(env.CONTEXA_REDIS_IMAGE_TAG, '7.2-alpine');
  assert.equal(env.CONTEXA_KAFKA_PLATFORM_VERSION, '7.4.0');
  assert.equal(env.CONTEXA_PGVECTOR_IMAGE_TAG, 'pg16');
  assert.equal(simSrc.includes('resolveProjectName'), false,
    'simulate.js must not depend on CONTEXA_PROJECT via resolveProjectName()');
  assert.match(simSrc, /loadManifest\(projectDir, INSTALL_MODES\.SIMULATION\)/,
    'fresh-shell simulation commands must load their exact ownership manifest');
});

test('A2: simulate reset does not regenerate initdb SQL copies', () => {
  const simSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'simulate.js'), 'utf8');
  assert.equal(simSrc.includes('emptyDirSync'), false,
    'simulate reset must not manipulate initdb scripts before docker compose up');
  assert.equal(simSrc.includes('generateInitDbScripts'), false,
    'simulate reset must leave schema/seed installation to contexa-iam runtime startup');
});

test('A2b: reset flows restore project files and keep infra cleanup scoped', () => {
  const resetSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'reset.js'), 'utf8');
  const resetServiceSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'reset-service.js'), 'utf8');

  assert.equal(resetSrc.includes('forceCleanupByPattern'), false,
    'reset must not delete Docker resources by broad substring matching');
  assert.equal(resetServiceSrc.includes('forceCleanupByPattern'), false,
    'reset service must not delete Docker resources by broad substring matching');
  assert.equal(resetSrc.includes("dockerCompose(['down', '-v']"), false,
    'reset must not run docker compose down -v from an implicit project directory');
  assert.equal(resetSrc.includes('yaml.load'), false,
    'reset must not inspect application.yml to guess production vs simulation target');
  assert.match(resetSrc, /\? simulateComposeEnv\(resetManifest\.metadata\.installationId\)/,
    'simulate reset must pass the ctxa-sim compose environment explicitly');
  assert.match(resetServiceSrc, /validateDockerContract\(contract, expected\)/,
    'cleanup must validate the exact manifest-owned Docker resource contract');
  assert.match(resetServiceSrc, /adapter\.inspectLabels\(resource\.type, resource\.name\)/,
    'cleanup must verify ownership labels for every exact resource');
  assert.match(resetSrc, /if \(opts\.simulate\) \{\s*targets\.code = true;\s*\}/,
    'reset --simulate must restore project files as part of the simulation reset flow');
  assert.match(resetSrc, /targets\.infra\s*=\s*hasOwnedManifest[\s\S]{0,120}resetManifest\.metadata\.infra/,
    'plain reset must target infrastructure only when the normal ownership manifest records it');
  assert.match(resetSrc, /if \(targets\.code\)/,
    'project file restore must still be guarded by the resolved code target');
  assert.match(resetSrc, /function printResetPlan\(/,
    'reset must print the resolved reset scope before taking action');
  assert.match(resetSrc, /t\('reset\.plan\.productionPreserved'\)/,
    'reset --simulate must explicitly state that the production/project stack is not targeted');
});

// =====================================================================
// A3 + A4 - normalizePath helper in init.js must:
//   - expand "~" / "~/x" to the OS home directory
//   - resolve relative paths against opts.dir (the customer project),
//     not process.cwd()
//   - leave absolute paths untouched
// The earlier code used path.resolve() alone, which silently used
// process.cwd() and produced "<cwd>/~/.contexa/x" for a "~/.contexa/x"
// prompt input.
// =====================================================================

test('A3+A4: normalizePath expands ~ and resolves relative paths against baseDir', () => {
  const baseDir = path.join(os.tmpdir(), 'contexa-path-base');
  assert.equal(normalizePath('relative/path', baseDir), path.resolve(baseDir, 'relative/path'));
  assert.equal(normalizePath('~', baseDir), path.resolve(os.homedir()));
  assert.equal(normalizePath('~/ctxa', baseDir), path.resolve(os.homedir(), 'ctxa'));
  assert.equal(normalizePath('', baseDir), null);
});

// =====================================================================
// A5 + A6 - injectStandalone must:
//   - back up existing standalone application.yml / contexa.gradle /
//     pom-fragment.xml as .bak before overwriting (A5)
//   - refuse to write into a non-empty folder that does not look like
//     a contexa-cli output, unless --force is passed (A6)
//   - throw a clear error when the target path exists as a file (A6)
// =====================================================================

test('A5: injectStandalone backs up existing application.yml as .bak', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(standaloneDir);
    const ymlPath = path.join(standaloneDir, 'application.yml');
    const previous = '# user-edited contexa standalone yml\ncontexa:\n  custom: true\n';
    await fs.writeFile(ymlPath, previous);

    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });

    assert.equal(await fs.pathExists(ymlPath + '.bak'), true,
      'pre-existing application.yml must be backed up to application.yml.bak');
    assert.equal(await fs.readFile(ymlPath + '.bak', 'utf8'), previous,
      '.bak must hold the previous content byte-identical');
  } finally { await fs.remove(root); }
});

test('A5: injectStandalone backs up existing contexa.gradle as .bak', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(standaloneDir);
    const fragPath = path.join(standaloneDir, 'contexa.gradle');
    const previous = '// user-customized\ndependencies { implementation "x:y:1" }\n';
    await fs.writeFile(fragPath, previous);

    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });

    assert.equal(await fs.pathExists(fragPath + '.bak'), true);
    assert.equal(await fs.readFile(fragPath + '.bak', 'utf8'), previous);
  } finally { await fs.remove(root); }
});

test('A6: injectStandalone throws a clear error when the target path is a FILE', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    // Customer has a top-level executable file named "contexa" - we must
    // never overwrite it.
    await fs.writeFile(standaloneDir, '#!/bin/sh\necho user-tool\n');
    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    await assert.rejects(
      injectStandalone(standaloneDir, project, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone' }),
      /already exists and is not a directory/);
    // The original file must be preserved byte-identical.
    assert.equal(await fs.readFile(standaloneDir, 'utf8'), '#!/bin/sh\necho user-tool\n');
  } finally { await fs.remove(root); }
});

test('A6: injectStandalone refuses to write into a non-empty unrelated directory without --force', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(standaloneDir);
    // Pre-existing unrelated content (no contexa-cli marker files).
    await fs.writeFile(path.join(standaloneDir, 'README.md'), '# customer notes\n');
    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    await assert.rejects(
      injectStandalone(standaloneDir, project, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone' }),
      /does not look like a contexa-cli output folder/);
    // The unrelated file must remain.
    assert.equal(await fs.readFile(path.join(standaloneDir, 'README.md'), 'utf8'), '# customer notes\n');
  } finally { await fs.remove(root); }
});

test('A6: injectStandalone proceeds when --force is passed even if folder is non-empty', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(standaloneDir);
    await fs.writeFile(path.join(standaloneDir, 'README.md'), '# customer notes\n');
    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone', force: true,
    });
    assert.equal(await fs.pathExists(result.ymlPath), true);
    // Customer file still present.
    assert.equal(await fs.readFile(path.join(standaloneDir, 'README.md'), 'utf8'), '# customer notes\n');
  } finally { await fs.remove(root); }
});

test('A6: injectStandalone proceeds without --force when folder already looks like ours', async () => {
  const root = await tempDir();
  try {
    const standaloneDir = path.join(root, 'contexa');
    await fs.ensureDir(standaloneDir);
    // Marker file from a previous contexa-cli run.
    await fs.writeFile(path.join(standaloneDir, 'application.yml'), '# previous\n');
    const project = { buildTool: 'gradle', buildFilePath: path.join(root, 'build.gradle'), hasEnableAiSecurity: false };
    const result = await injectStandalone(standaloneDir, project, {
      mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'standalone',
    });
    assert.equal(await fs.pathExists(result.ymlPath), true);
    assert.equal(await fs.pathExists(result.ymlPath + '.bak'), true,
      'previous application.yml must be backed up');
  } finally { await fs.remove(root); }
});

test('F3: detector still flips hasContexta=true when the include line is real', async () => {
  const root = await tempDir();
  try {
    const moduleDir = path.join(root, 'web');
    await fs.ensureDir(moduleDir);
    await fs.writeFile(path.join(root, 'settings.gradle'),
      "rootProject.name = 'parent'\ninclude 'web'\n");
    await fs.writeFile(path.join(root, 'build.gradle'),
      "subprojects { dependencies { implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0' } }\n");
    await fs.writeFile(path.join(moduleDir, 'build.gradle'),
      "plugins { id 'java' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");

    const result = await detectSpringProject(moduleDir);
    assert.equal(result.hasContexta, true,
      'hasContexta must be true when parent really includes this module and parent build adds the starter');
  } finally { await fs.remove(root); }
});
