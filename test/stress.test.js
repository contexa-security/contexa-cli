'use strict';

// Stress / matrix tests: simulate a wide range of customer environments and
// verify that contexa-cli's core functions (detector + injector) produce
// configs that Spring Boot will accept without surprises.
//
// Each test builds an isolated temp directory representing a realistic
// customer project shape (Maven, Gradle, multi-module, legacy yml, properties
// shadowing, etc.) and asserts the post-init artifacts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { detectSpringProject } = require('../src/core/detector');
const {
  injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
} = require('../src/core/injector');

async function makeProject(layout) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-stress-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

function loadYml(p) {
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

function topLevelContexaCount(text) {
  return (text.match(/^contexa\s*:/gm) || []).length;
}

// ============================================================
// A. Greenfield projects (empty yml or no yml at all)
// ============================================================

test('A1: empty Gradle Groovy project, no yml - init creates a parseable yml', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const ymlPath = path.join(dir, 'src/main/resources/application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.ok(root.contexa);
    assert.equal(root.contexa.security.zerotrust.mode, 'SHADOW');
    assert.equal(root.contexa.datasource.isolation['contexa-owned-application'], true);
  } finally { await fs.remove(dir); }
});

test('A2: Gradle Kotlin DSL project, no yml', async () => {
  const dir = await makeProject({
    'build.gradle.kts': `dependencies {\n    implementation("org.springframework.boot:spring-boot-starter")\n}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.buildTool, 'gradle');
    assert.ok(detect.projectName, 'Gradle project must have a resolved name (settings or basename fallback)');
  } finally { await fs.remove(dir); }
});

test('A3: Maven project, settings.gradle absent', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><artifactId>greenfield-app</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.buildTool, 'maven');
    assert.equal(detect.projectName, 'greenfield-app');
  } finally { await fs.remove(dir); }
});

test('A4: ENFORCE mode end-to-end on greenfield', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
  } finally { await fs.remove(dir); }
});

test('A5: distributed infra on greenfield writes infrastructure.mode=DISTRIBUTED', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'], infra: 'distributed' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'DISTRIBUTED');
  } finally { await fs.remove(dir); }
});

test('A6: triple LLM providers concatenate priorities in declared order', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama', 'openai', 'anthropic'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama,openai,anthropic');
    // anthropic has no embedding model in this CLI's curated list
    assert.equal(root.contexa.llm.selection.embedding.priority, 'ollama,openai');
  } finally { await fs.remove(dir); }
});

// ============================================================
// B. Existing contexa: tree (the most common real-world hazard)
// ============================================================

test('B1: existing contexa.infrastructure.mode is preserved without --distributed', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  infrastructure:\n    mode: standalone\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'standalone');
  } finally { await fs.remove(dir); }
});

test('B2: existing contexa.vectorstore.pgvector is preserved verbatim', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  vectorstore:\n    pgvector:\n      table-name: vector_store\n      dimensions: 1024\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.vectorstore.pgvector['table-name'], 'vector_store');
    assert.equal(root.contexa.vectorstore.pgvector.dimensions, 1024);
  } finally { await fs.remove(dir); }
});

test('B3: existing contexa.bridge.enabled is preserved across init', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  bridge:\n    enabled: true\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.bridge.enabled, true);
  } finally { await fs.remove(dir); }
});

test('B4: deprecated contexa.llm.chatModelPriority is left alone (not auto-removed)', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  llm:\n    chatModelPriority: openai\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    // Old key remains - core still binds it; CLI does not delete user data.
    assert.equal(root.contexa.llm.chatModelPriority, 'openai');
    // New key is also written.
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama');
  } finally { await fs.remove(dir); }
});

test('B5: user-provided contexa.datasource.url is preserved (custom contexa DB location)', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  datasource:\n    url: jdbc:postgresql://internal-db:15432/contexa_agent\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.datasource.url, 'jdbc:postgresql://internal-db:15432/contexa_agent');
    // Isolation flag is still force-set so platform always knows it owns this DB.
    assert.equal(root.contexa.datasource.isolation['contexa-owned-application'], true);
  } finally { await fs.remove(dir); }
});

// ============================================================
// C. Coexisting spring.* (host application config)
// ============================================================

test('C1: host spring.datasource (different DB) is left untouched', async () => {
  const dir = await makeProject({
    'app.yml': `spring:\n  datasource:\n    url: jdbc:postgresql://customer-db:5432/customer_app\n    username: app_user\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.spring.datasource.url, 'jdbc:postgresql://customer-db:5432/customer_app');
    assert.equal(root.spring.datasource.username, 'app_user');
    // contexa.datasource is added as a separate, isolated source.
    assert.ok(root.contexa.datasource.url.includes('CONTEXA_DB_URL'));
  } finally { await fs.remove(dir); }
});

test('C2: host spring.ai.ollama config is preserved', async () => {
  const dir = await makeProject({
    'app.yml': `spring:\n  ai:\n    ollama:\n      base-url: http://gpu-host:11434\n      chat:\n        options:\n          model: llama3:70b\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.spring.ai.ollama['base-url'], 'http://gpu-host:11434');
    assert.equal(root.spring.ai.ollama.chat.options.model, 'llama3:70b');
  } finally { await fs.remove(dir); }
});

test('C3: host spring.security config is preserved', async () => {
  const dir = await makeProject({
    'app.yml': `spring:\n  security:\n    user:\n      name: admin\n      password: secret\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.spring.security.user.name, 'admin');
  } finally { await fs.remove(dir); }
});

// ============================================================
// D. Real customer-shape: contexa + spring coexist
// ============================================================

test('D1: quickstart-shape yml (contexa + spring) merges into single contexa: tree', async () => {
  const initialYml = [
    'server:',
    '  port: 8081',
    '',
    'contexa:',
    '  infrastructure:',
    '    mode: standalone',
    '  vectorstore:',
    '    pgvector:',
    '      dimensions: 1024',
    '',
    'spring:',
    '  datasource:',
    '    url: jdbc:postgresql://localhost:5432/customer',
    '  ai:',
    '    chat:',
    '      model:',
    '        priority: ollama',
    '',
  ].join('\n');
  const dir = await makeProject({ 'src/main/resources/application.yml': initialYml });
  try {
    const ymlPath = path.join(dir, 'src/main/resources/application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    assert.equal(topLevelContexaCount(text), 1, 'duplicate contexa: would crash Spring Boot');
    const root = yaml.load(text);
    assert.equal(root.server.port, 8081);
    assert.equal(root.contexa.infrastructure.mode, 'standalone');
    assert.equal(root.contexa.vectorstore.pgvector.dimensions, 1024);
    assert.ok(root.contexa.security.zerotrust.mode);
    assert.ok(root.contexa.datasource.url.includes('CONTEXA_DB_URL'));
    assert.equal(root.spring.datasource.url, 'jdbc:postgresql://localhost:5432/customer');
  } finally { await fs.remove(dir); }
});

test('D2: legacy-system-shape yml (dual DB - host spring.datasource + custom contexa.datasource)', async () => {
  const initialYml = [
    'server: { port: 9090 }',
    'contexa:',
    '  datasource:',
    '    url: jdbc:postgresql://contexa-db:15432/contexa_agent',
    '    username: contexa',
    '  bridge:',
    '    enabled: true',
    'spring:',
    '  datasource:',
    '    url: jdbc:postgresql://legacy-db:5432/legacy_customer',
    '    username: legacy',
    '',
  ].join('\n');
  const dir = await makeProject({ 'app.yml': initialYml });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    // Custom contexa DB preserved
    assert.equal(root.contexa.datasource.url, 'jdbc:postgresql://contexa-db:15432/contexa_agent');
    assert.equal(root.contexa.datasource.username, 'contexa');
    // Bridge preserved
    assert.equal(root.contexa.bridge.enabled, true);
    // Host DB untouched
    assert.equal(root.spring.datasource.url, 'jdbc:postgresql://legacy-db:5432/legacy_customer');
  } finally { await fs.remove(dir); }
});

// ============================================================
// E. Idempotency, re-runs, mode flips
// ============================================================

test('E1: two consecutive shadow inits produce identical contexa: contents', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const after1 = await fs.readFile(ymlPath, 'utf8');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const after2 = await fs.readFile(ymlPath, 'utf8');
    assert.equal(after1, after2);
  } finally { await fs.remove(dir); }
});

test('E2: shadow -> enforce flips mode without losing other CLI keys', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
    assert.ok(root.contexa.datasource.url.includes('CONTEXA_DB_URL'));
  } finally { await fs.remove(dir); }
});

test('E3: user-added contexa.bridge in between two inits is preserved', async () => {
  const dir = await makeProject({});
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    let root = loadYml(ymlPath);
    root.contexa.bridge = { enabled: true, sync: { minRefreshIntervalSeconds: 120 } };
    await fs.writeFile(ymlPath, yaml.dump(root));
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    root = loadYml(ymlPath);
    assert.equal(root.contexa.bridge.enabled, true);
    assert.equal(root.contexa.bridge.sync.minRefreshIntervalSeconds, 120);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
  } finally { await fs.remove(dir); }
});

test('E4: legacy CLI marker block is stripped on first re-run', async () => {
  const initialYml = [
    'server:',
    '  port: 8080',
    '',
    '# --- Contexa AI Security ---',
    'contexa:',
    '  llm:',
    '    chatModelPriority: ollama',
    '  security:',
    '    zerotrust:',
    '      mode: SHADOW',
    '# --- End Contexa ---',
    '',
  ].join('\n');
  const dir = await makeProject({ 'app.yml': initialYml });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    assert.equal(text.includes('# --- Contexa AI Security ---'), false);
    assert.equal(topLevelContexaCount(text), 1);
    const root = yaml.load(text);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
    assert.ok(root.contexa.llm.selection.chat.priority);
  } finally { await fs.remove(dir); }
});

// ============================================================
// F. Edge cases / parser failures (must give actionable hints)
// ============================================================

test('F1: malformed yml fails with friendly multi-line guidance', async () => {
  const dir = await makeProject({
    'app.yml': `server:\n\tport: 8080\n  badIndent:\n   - x\n     y\n`, // tabs + bad indent
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    let caught = null;
    try { await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] }); }
    catch (err) { caught = err; }
    assert.ok(caught, 'must throw on malformed yml');
    assert.match(caught.message, /How to fix/);
    assert.match(caught.message, /\.bak/);
    assert.ok(await fs.pathExists(ymlPath + '.bak'), 'backup must still be created');
  } finally { await fs.remove(dir); }
});

test('F2: empty yml file (0 bytes) is treated as empty object', async () => {
  const dir = await makeProject({ 'app.yml': '' });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.ok(root.contexa);
  } finally { await fs.remove(dir); }
});

test('F3: yml that parses to a bare scalar (string/number) is replaced safely', async () => {
  const dir = await makeProject({ 'app.yml': '42\n' });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.ok(root.contexa, 'CLI must recover by treating non-object root as empty');
  } finally { await fs.remove(dir); }
});

test('F4: yml that parses to an array is replaced safely', async () => {
  const dir = await makeProject({ 'app.yml': '- a\n- b\n' });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.ok(root.contexa);
  } finally { await fs.remove(dir); }
});

test('F5: detector reports both yml and properties when they coexist', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><artifactId>app</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
    'src/main/resources/application.yml': `server:\n  port: 8080\n`,
    'src/main/resources/application.properties': `server.port=8080\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.ok(detect.appYmlPath);
    assert.ok(detect.appPropertiesPath);
  } finally { await fs.remove(dir); }
});

// ============================================================
// G. Build tool variety (Maven / Gradle / multi-module)
// ============================================================

test('G1: Maven dependencyManagement does NOT receive the contexa starter', async () => {
  const dir = await makeProject({
    'pom.xml': `<project>\n  <dependencyManagement>\n    <dependencies>\n      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.5.4</version><type>pom</type><scope>import</scope></dependency>\n    </dependencies>\n  </dependencyManagement>\n  <dependencies>\n    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>\n  </dependencies>\n</project>`,
  });
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await injectMavenDep(pomPath);
    const pom = await fs.readFile(pomPath, 'utf8');
    const mgmt = pom.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)[0];
    assert.equal(mgmt.includes('spring-boot-starter-contexa'), false);
  } finally { await fs.remove(dir); }
});

test('G2: Maven idempotency - re-injection is a no-op', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><dependencies><dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0</version></dependency></dependencies></project>`,
  });
  try {
    const ok = await injectMavenDep(path.join(dir, 'pom.xml'));
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('G3: Gradle Groovy idempotency - re-injection is a no-op', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'\n}\n`,
  });
  try {
    const ok = await injectGradleDep(path.join(dir, 'build.gradle'));
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('G4: Gradle multi-module - sub-module init detects starter from parent build.gradle', async () => {
  const dir = await makeProject({
    'settings.gradle': `rootProject.name = 'monorepo'\ninclude 'svc-a'\n`,
    'build.gradle': `subprojects {\n  dependencies {\n    implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'\n  }\n}\n`,
    'svc-a/build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const detect = await detectSpringProject(path.join(dir, 'svc-a'));
    assert.equal(detect.hasContexta, true,
      'multi-module detector must walk up to parent and recognize starter from subprojects { } block');
    assert.equal(detect.gradleRootDir, dir);
  } finally { await fs.remove(dir); }
});

test('G5: Gradle multi-module - parent has no starter, sub-module is correctly seen as missing', async () => {
  const dir = await makeProject({
    'settings.gradle': `rootProject.name = 'monorepo'\ninclude 'svc-a'\n`,
    'build.gradle': `subprojects { repositories { mavenCentral() } }\n`,
    'svc-a/build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const detect = await detectSpringProject(path.join(dir, 'svc-a'));
    assert.equal(detect.hasContexta, false);
  } finally { await fs.remove(dir); }
});

test('G6: Gradle settings.gradle rootProject.name becomes projectName', async () => {
  const dir = await makeProject({
    'settings.gradle': `rootProject.name = 'my-pretty-app'\n`,
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.projectName, 'my-pretty-app');
  } finally { await fs.remove(dir); }
});

test('G7: Gradle settings.gradle.kts (Kotlin) rootProject name extraction', async () => {
  const dir = await makeProject({
    'settings.gradle.kts': `rootProject.name = "kotlin-app"\n`,
    'build.gradle.kts': `dependencies {\n    implementation("org.springframework.boot:spring-boot-starter")\n}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.projectName, 'kotlin-app');
  } finally { await fs.remove(dir); }
});

test('G8: directory basename fallback when no settings.gradle exists', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.ok(detect.projectName, 'must fall back to directory basename');
    assert.equal(detect.projectName, path.basename(dir));
  } finally { await fs.remove(dir); }
});

// ============================================================
// H. Distributed dep injection across multiple build shapes
// ============================================================

test('H1: distributed deps add redisson + spring-kafka to Maven', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
  });
  try {
    const added = await injectDistributedDeps(path.join(dir, 'pom.xml'));
    assert.equal(added, true);
    const pom = await fs.readFile(path.join(dir, 'pom.xml'), 'utf8');
    assert.ok(pom.includes('spring-kafka'));
    assert.ok(pom.includes('redisson'));
  } finally { await fs.remove(dir); }
});

test('H2: distributed deps idempotent on Maven (already present)', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><dependencies>\n<dependency><groupId>org.springframework.kafka</groupId><artifactId>spring-kafka</artifactId></dependency>\n<dependency><groupId>org.redisson</groupId><artifactId>redisson</artifactId><version>3.48.0</version></dependency>\n</dependencies></project>`,
  });
  try {
    const added = await injectDistributedDeps(path.join(dir, 'pom.xml'));
    assert.equal(added, false);
  } finally { await fs.remove(dir); }
});

test('H3: distributed deps add to Gradle Groovy', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const added = await injectDistributedDeps(path.join(dir, 'build.gradle'));
    assert.equal(added, true);
    const txt = await fs.readFile(path.join(dir, 'build.gradle'), 'utf8');
    assert.match(txt, /spring-kafka/);
    assert.match(txt, /redisson/);
  } finally { await fs.remove(dir); }
});

test('H4: distributed deps add to Gradle Kotlin DSL', async () => {
  const dir = await makeProject({
    'build.gradle.kts': `dependencies {\n    implementation("org.springframework.boot:spring-boot-starter")\n}\n`,
  });
  try {
    const added = await injectDistributedDeps(path.join(dir, 'build.gradle.kts'));
    assert.equal(added, true);
    const txt = await fs.readFile(path.join(dir, 'build.gradle.kts'), 'utf8');
    assert.match(txt, /implementation\("org\.springframework\.kafka:spring-kafka"\)/);
    assert.match(txt, /implementation\("org\.redisson:redisson:3\.48\.0"\)/);
  } finally { await fs.remove(dir); }
});

test('H5: CONTEXA_REDISSON_VERSION env var overrides redisson version (Maven)', async () => {
  const dir = await makeProject({
    'pom.xml': `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency></dependencies></project>`,
  });
  const prev = process.env.CONTEXA_REDISSON_VERSION;
  process.env.CONTEXA_REDISSON_VERSION = '3.50.0';
  try {
    await injectDistributedDeps(path.join(dir, 'pom.xml'));
    const pom = await fs.readFile(path.join(dir, 'pom.xml'), 'utf8');
    assert.match(pom, /<version>3\.50\.0<\/version>/);
    assert.equal(pom.includes('3.48.0'), false);
  } finally {
    if (prev === undefined) delete process.env.CONTEXA_REDISSON_VERSION;
    else process.env.CONTEXA_REDISSON_VERSION = prev;
    await fs.remove(dir);
  }
});

test('K1: detector recognizes @EnableAISecurity in src/main/java', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
    'src/main/java/com/example/App.java':
      `package com.example;\nimport io.contexa.contexacore.annotation.EnableAISecurity;\n` +
      `import org.springframework.boot.autoconfigure.SpringBootApplication;\n` +
      `@EnableAISecurity\n@SpringBootApplication\npublic class App {}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.hasEnableAiSecurity, true);
  } finally { await fs.remove(dir); }
});

test('K2: detector reports hasEnableAiSecurity=false when no Java sources', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.hasEnableAiSecurity, false);
  } finally { await fs.remove(dir); }
});

// K4 + K5 were previously regression locks for the (now removed)
// injectAiStarterDeps function. contexa-cli no longer auto-adds Spring AI
// provider starters or the pgvector vector-store starter to the customer
// build, because:
//   - those dependencies belong to the customer's surface
//   - they are only needed when @EnableAISecurity is declared
//   - blanket-injecting them onto every customer that depends on
//     spring-boot-starter-contexa breaks the customers who do NOT declare
//     the annotation (PgVector / ChatModel beans get instantiated against
//     missing infrastructure and the application fails to start).
//
// The replacement guarantee - "the only dependency contexa-cli adds is
// spring-boot-starter-contexa" - is locked in `test/sideeffect-zero.test.js`
// (search for "C1:").

test('K3: detector reports hasEnableAiSecurity=false when annotation is absent', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
    'src/main/java/com/example/App.java':
      `package com.example;\n@org.springframework.boot.autoconfigure.SpringBootApplication\npublic class App {}\n`,
  });
  try {
    const detect = await detectSpringProject(dir);
    assert.equal(detect.hasEnableAiSecurity, false);
  } finally { await fs.remove(dir); }
});

test('H6: CONTEXA_REDISSON_VERSION env var overrides redisson version (Gradle)', async () => {
  const dir = await makeProject({
    'build.gradle': `dependencies {\n  implementation 'org.springframework.boot:spring-boot-starter'\n}\n`,
  });
  const prev = process.env.CONTEXA_REDISSON_VERSION;
  process.env.CONTEXA_REDISSON_VERSION = '3.49.1';
  try {
    await injectDistributedDeps(path.join(dir, 'build.gradle'));
    const txt = await fs.readFile(path.join(dir, 'build.gradle'), 'utf8');
    assert.match(txt, /redisson:3\.49\.1/);
  } finally {
    if (prev === undefined) delete process.env.CONTEXA_REDISSON_VERSION;
    else process.env.CONTEXA_REDISSON_VERSION = prev;
    await fs.remove(dir);
  }
});

// ============================================================
// I. Boundary stress (large yml, deep nesting, mixed encoding)
// ============================================================

test('I1: large yml (~1000 lines of unrelated config) merges cleanly', async () => {
  const lines = ['app:'];
  for (let i = 0; i < 500; i++) {
    lines.push(`  key${i}: value${i}`);
    lines.push(`  group${i}:`);
    lines.push(`    nested${i}: ${i}`);
  }
  const dir = await makeProject({ 'app.yml': lines.join('\n') + '\n' });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.ok(root.contexa);
    assert.equal(root.app.key0, 'value0');
    assert.equal(root.app.group499.nested499, 499);
  } finally { await fs.remove(dir); }
});

test('I2: deeply nested existing contexa: tree (5 levels) is preserved exactly', async () => {
  const dir = await makeProject({
    'app.yml': `contexa:\n  hcad:\n    preTrigger:\n      sensitivePathIndicators:\n        - admin\n        - secret\n      cooldownSeconds: 30\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.deepEqual(root.contexa.hcad.preTrigger.sensitivePathIndicators, ['admin', 'secret']);
    assert.equal(root.contexa.hcad.preTrigger.cooldownSeconds, 30);
    // Force-set keys still present
    assert.equal(root.contexa.hcad.geoip.enabled, true);
  } finally { await fs.remove(dir); }
});

test('I3: yml with special characters (UTF-8 Korean comments + values)', async () => {
  const dir = await makeProject({
    'app.yml': `# 한국어 주석\napp:\n  greeting: 안녕하세요\n  message: "Contexa 보안 플랫폼"\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.app.greeting, '안녕하세요');
    assert.equal(root.app.message, 'Contexa 보안 플랫폼');
  } finally { await fs.remove(dir); }
});

test('I4: yml with anchors and aliases is preserved (refs resolved post-load)', async () => {
  const dir = await makeProject({
    'app.yml': `defaults: &defaults\n  retries: 3\nservice-a:\n  <<: *defaults\nservice-b:\n  <<: *defaults\n`,
  });
  try {
    const ymlPath = path.join(dir, 'app.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root['service-a'].retries, 3);
    assert.equal(root['service-b'].retries, 3);
  } finally { await fs.remove(dir); }
});

// ============================================================
// J. Spring Boot 3.x SnakeYAML strict-duplicate-key safety
// ============================================================

test('J1: post-init yml never contains a duplicate top-level contexa: key', async () => {
  const variants = [
    `contexa:\n  bridge:\n    enabled: true\n`,
    `contexa:\n  vectorstore:\n    pgvector:\n      dimensions: 1024\n`,
    `# --- Contexa AI Security ---\ncontexa:\n  llm:\n    chatModelPriority: ollama\n# --- End Contexa ---\n`,
    `server: {port: 8080}\ncontexa:\n  infrastructure:\n    mode: standalone\nspring:\n  datasource:\n    url: jdbc:h2:mem:test\n`,
  ];
  for (const v of variants) {
    const dir = await makeProject({ 'app.yml': v });
    try {
      const ymlPath = path.join(dir, 'app.yml');
      await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
      const text = await fs.readFile(ymlPath, 'utf8');
      assert.equal(topLevelContexaCount(text), 1, `duplicate contexa: in variant: ${v.slice(0, 30)}`);
      // SnakeYAML strict mode equivalent: load with duplicate-key detection
      const strictLoad = () => yaml.load(text); // js-yaml 4.x throws on duplicates by default
      assert.doesNotThrow(strictLoad);
    } finally { await fs.remove(dir); }
  }
});

test('J2: contexa.security.zerotrust.mode is always force-set after init', async () => {
  const variants = [
    `contexa:\n  security:\n    zerotrust:\n      mode: ENFORCE\n`,
    `contexa:\n  security:\n    zerotrust:\n      mode: shadow\n`,
    `contexa: {}\n`,
  ];
  for (const v of variants) {
    const dir = await makeProject({ 'app.yml': v });
    try {
      const ymlPath = path.join(dir, 'app.yml');
      await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
      const root = loadYml(ymlPath);
      assert.equal(root.contexa.security.zerotrust.mode, 'SHADOW');
    } finally { await fs.remove(dir); }
  }
});

test('J3: contexa.datasource.isolation.contexa-owned-application is always true', async () => {
  const variants = [
    `contexa:\n  datasource:\n    isolation:\n      contexa-owned-application: false\n`,
    `contexa:\n  datasource: {}\n`,
    `contexa: {}\n`,
  ];
  for (const v of variants) {
    const dir = await makeProject({ 'app.yml': v });
    try {
      const ymlPath = path.join(dir, 'app.yml');
      await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
      const root = loadYml(ymlPath);
      assert.equal(root.contexa.datasource.isolation['contexa-owned-application'], true);
    } finally { await fs.remove(dir); }
  }
});

test('J4: contexa.hcad.geoip.enabled is always true after init', async () => {
  const variants = [
    `contexa:\n  hcad:\n    geoip:\n      enabled: false\n      dbPath: /custom/path\n`,
    `contexa: {}\n`,
  ];
  for (const v of variants) {
    const dir = await makeProject({ 'app.yml': v });
    try {
      const ymlPath = path.join(dir, 'app.yml');
      await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
      const root = loadYml(ymlPath);
      assert.equal(root.contexa.hcad.geoip.enabled, true);
    } finally { await fs.remove(dir); }
  }
});
