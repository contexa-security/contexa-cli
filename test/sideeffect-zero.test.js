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
  generateDockerCompose, generateInitDbScripts,
  injectGradleDep, injectStandalone,
  findTopLevelDependenciesInsertIndex, insertIntoTopLevelDependencies,
} = require('../src/core/injector');
const { containerName, resolveProjectName } = require('../src/core/project');
const { detectSpringProject } = require('../src/core/detector');

async function tempDir(prefix = 'ctxa-claim0-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// =====================================================================
// S1 + S2 - generateDockerCompose / generateInitDbScripts must operate
// only on the contexa-owned infra dir argument they receive. The signature
// itself is the guarantee; this test pins it down by passing two distinct
// directories: a "customer" dir that holds a pre-existing docker-compose.yml
// and an "infra" dir that the CLI is allowed to write to. The customer file
// must remain byte-identical after the call.
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
    });

    assert.equal(await fs.readFile(customerCompose, 'utf8'), customerContent,
      'customer docker-compose.yml must not be modified');
    assert.equal(await fs.pathExists(path.join(infraDir, 'docker-compose.yml')), true,
      'infra docker-compose.yml must be created');
  } finally { await fs.remove(root); }
});

test('S2: generateInitDbScripts writes ONLY to <infraDir>/initdb, never to the customer dir', async () => {
  const root = await tempDir();
  try {
    const customerDir = path.join(root, 'customer');
    const infraDir    = path.join(root, 'infra');
    await fs.ensureDir(path.join(customerDir, 'initdb'));
    const customerSql = path.join(customerDir, 'initdb', '01-customer.sql');
    const customerContent = '-- customer-owned schema\nCREATE TABLE users(id INT);\n';
    await fs.writeFile(customerSql, customerContent);

    await generateInitDbScripts(infraDir);

    assert.equal(await fs.readFile(customerSql, 'utf8'), customerContent,
      'customer initdb file must not be modified');
    assert.equal(await fs.pathExists(path.join(infraDir, 'initdb', '01-core-ddl.sql')), true,
      'CLI must write 01-core-ddl.sql under infraDir');
    assert.equal(await fs.pathExists(path.join(infraDir, 'initdb', '02-dml.sql')), true,
      'CLI must write 02-dml.sql under infraDir');
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'distributed',
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
      mode: 'shadow', llmProviders: ['ollama', 'openai'], infra: 'standalone',
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
  // The hard-coded SIM_PROJECT constant must exist and equal 'ctxa-sim'.
  assert.match(simSrc, /SIM_PROJECT\s*=\s*['"]ctxa-sim['"]/,
    'simulate.js must hard-wire SIM_PROJECT = "ctxa-sim"');
  // simulate.js must NOT call resolveProjectName() (which reads
  // CONTEXA_PROJECT). Doing so would make `contexa simulate up` fail in
  // a fresh shell where init's in-process env is gone.
  assert.equal(simSrc.includes('resolveProjectName'), false,
    'simulate.js must not depend on CONTEXA_PROJECT via resolveProjectName()');
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
  // Pull the helper out of init.js source via require - it's not exported,
  // so we read the source and assert the behavior contract is encoded.
  const initSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'commands', 'init.js'), 'utf8');
  assert.match(initSrc, /function normalizePath\(/, 'normalizePath helper must be defined');
  assert.match(initSrc, /os\.homedir\(\)/, 'normalizePath must reference os.homedir() to expand ~');
  assert.match(initSrc, /path\.resolve\(baseDir,/, 'normalizePath must resolve relative paths against baseDir');
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
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
      injectStandalone(standaloneDir, project, { mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone' }),
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
      injectStandalone(standaloneDir, project, { mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone' }),
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone', force: true,
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
      mode: 'shadow', llmProviders: ['ollama'], infra: 'standalone',
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
