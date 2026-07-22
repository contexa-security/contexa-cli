'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps, injectEnableAiSecurity,
  generateDockerCompose,
} = require('../src/core/injector');
const { CONTEXA_VERSION } = require('../src/core/injector/common');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-injector-'));
}

function loadYml(p) {
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

// ============================================================
// injectYml - merged contexa.* tree (no marker block)
// ============================================================

test('injectYml: normal host overlay never claims datasource ownership', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.datasource, undefined);
    assert.ok(root.contexa.security);
    assert.equal(root.contexa.llm, undefined);
    assert.equal(root.contexa.hcad, undefined);
    assert.equal(root.spring && root.spring.ai, undefined);
  } finally { await fs.remove(dir); }
});

test('injectYml: produces a parseable yaml with a single contexa: tree', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    const root = yaml.load(text);
    assert.ok(root && root.contexa, 'contexa: must exist as a top-level key');
    const contexaOccurrences = (text.match(/^contexa\s*:/gm) || []).length;
    assert.equal(contexaOccurrences, 1, 'contexa: must appear exactly once at top level');
  } finally { await fs.remove(dir); }
});

test('injectYml: normal explicit activation leaves datasource defaults to platform Properties', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.datasource, undefined);
    assert.doesNotMatch(await fs.readFile(ymlPath, 'utf8'), /contexa1234|contexa-owned-application/);
  } finally { await fs.remove(dir); }
});

test('injectYml: ENFORCE mode writes contexa.security.zerotrust.mode = ENFORCE', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'enforce', enableAiSecurity: true, llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
  } finally { await fs.remove(dir); }
});

test('injectYml: distributed sets contexa.infrastructure.mode and never spring.data.redis/kafka', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'distributed' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'DISTRIBUTED');
    assert.equal(root.spring, undefined, 'spring.* must not be written by CLI');
  } finally { await fs.remove(dir); }
});

test('injectYml: simulate writes only isolated profile and Ollama selection under spring.*', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, {
      mode: 'shadow',
      enableAiSecurity: true,
      llmProviders: ['ollama'],
      infra: 'distributed',
      simulate: true,
    });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.datasource.url, '${CONTEXA_DB_URL}');
    assert.equal(root.contexa.datasource.username, '${CONTEXA_DB_USERNAME}');
    assert.equal(root.contexa.datasource.password, '${CONTEXA_DB_PASSWORD}');
    assert.equal(root.contexa.iam.websocket.enabled, false);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
    assert.equal(root.contexa.infrastructure.mode, 'DISTRIBUTED');
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama');
    assert.equal(root.contexa.llm.selection.embedding.mode, 'fixed');
    assert.equal(root.contexa.llm.selection.embedding.priority, 'ollama');
    assert.equal(root.spring.config.activate['on-profile'], 'contexa-sim');
    assert.equal(root.spring.ai.model.chat, 'ollama');
    assert.equal(root.spring.ai.model.embedding, 'ollama');
    assert.equal(root.spring.ai.model.image, 'none');
    assert.equal(root.spring.ai.model.moderation, 'none');
    assert.equal(root.spring.ai.model.audio.speech, 'none');
    assert.equal(root.spring.ai.model.audio.transcription, 'none');
    assert.equal(root.spring.ai.ollama['base-url'], '${OLLAMA_BASE_URL}');
    assert.equal(root.spring.ai.ollama.chat.options.model,
      '${CONTEXA_CHAT_OLLAMA_MODEL:qwen2.5:7b}');
    assert.equal(root.spring.ai.ollama.embedding.options.model,
      '${CONTEXA_EMBEDDING_OLLAMA_MODEL:mxbai-embed-large}');
    assert.equal(root.server.port, '${CONTEXA_SIMULATION_SERVER_PORT:9080}');
    assert.equal(root.spring.datasource, undefined);
    assert.equal(root.spring.data.redis.host, '${REDIS_HOST}');
    assert.equal(root.spring.data.redis.port, '${REDIS_PORT}');
    assert.equal(root.spring.kafka['bootstrap-servers'], '${KAFKA_BOOTSTRAP_SERVERS}');
  } finally { await fs.remove(dir); }
});

test('injectYml: FULL preserves an existing host SecurityFilterChain ownership boundary', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, {
      enableAiSecurity: true,
      securityMode: 'full',
      hostSecurityFilterChain: true,
      llmProviders: ['openai'],
    });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.bridge.ownership, 'HOST_OWNED');
    assert.equal(root.contexa.datasource.isolation['contexa-owned-application'], false);
    assert.equal(root.contexa.datasource.url, undefined);
    assert.equal(root.contexa.datasource.username, undefined);
    assert.equal(root.contexa.datasource.password, undefined);
  } finally { await fs.remove(dir); }
});

test('injectYml: FULL without a host chain leaves Contexa ownership to annotation defaults', async () => {
  const tree = require('../src/core/injector/yml').buildCliContexaTree({
    enableAiSecurity: true,
    securityMode: 'full',
    hostSecurityFilterChain: false,
    llmProviders: ['openai'],
  });
  assert.equal(tree.bridge, undefined);
  assert.equal(tree.datasource, undefined);
});
test('injectYml: never writes any spring.* key across all provider/infra combinations', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    for (const infra of ['standalone', 'distributed']) {
      for (const providers of [['ollama'], ['openai'], ['anthropic'], ['ollama', 'openai', 'anthropic']]) {
        await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: providers, infra });
        const root = loadYml(ymlPath);
        assert.equal(root.spring, undefined,
          `spring.* leaked with infra=${infra} providers=${providers}`);
      }
    }
  } finally { await fs.remove(dir); }
});

test('injectYml: idempotent - second call updates only the CLI-managed keys', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    const first = await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    await injectYml(ymlPath, {
      mode: 'enforce',
      enableAiSecurity: true,
      llmProviders: ['ollama'],
      managedPaths: first.managedPaths,
    });
    const text = await fs.readFile(ymlPath, 'utf8');
    const root = yaml.load(text);
    assert.equal((text.match(/^contexa\s*:/gm) || []).length, 1);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
  } finally { await fs.remove(dir); }
});

test('injectYml: backs up existing file before modifying', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, 'server:\n  port: 8080\n');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const backupDest = path.join(dir, 'contexa', '.cli', 'bak', 'application.yml');
    assert.ok(await fs.pathExists(backupDest));
  } finally { await fs.remove(dir); }
});

test('injectYml: merges into existing contexa: block instead of duplicating top-level key', async () => {
  // Real-world scenario: application.yml already has contexa.infrastructure.mode
  // and contexa.vectorstore set by the developer. CLI must merge into the same
  // top-level contexa: tree, not produce a second one (which Spring Boot 3.x
  // SnakeYAML rejects with DuplicateKeyException).
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, [
      'server:',
      '  port: 8081',
      '',
      'contexa:',
      '  infrastructure:',
      '    mode: standalone',
      '  vectorstore:',
      '    pgvector:',
      '      table-name: vector_store',
      '      dimensions: 1024',
      '',
      'spring:',
      '  datasource:',
      '    url: jdbc:postgresql://localhost:5432/host_app',
      '',
    ].join('\n'));
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    const root = yaml.load(text); // must not throw
    assert.equal((text.match(/^contexa\s*:/gm) || []).length, 1,
      'single top-level contexa: required to avoid duplicate-key errors');
    assert.equal(root.contexa.infrastructure.mode, 'standalone',
      'user infrastructure.mode must be preserved (CLI does not overwrite without --distributed)');
    assert.equal(root.contexa.vectorstore.pgvector['table-name'], 'vector_store',
      'user vectorstore must be preserved');
    assert.ok(root.contexa.security.zerotrust.mode, 'CLI-managed key must still be added');
    assert.equal(root.spring.datasource.url, 'jdbc:postgresql://localhost:5432/host_app',
      'host spring.datasource must be untouched');
  } finally { await fs.remove(dir); }
});

test('injectYml: --distributed preserves a user-owned contexa.infrastructure.mode', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, 'contexa:\n  infrastructure:\n    mode: standalone\n');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'], infra: 'distributed' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'standalone');
  } finally { await fs.remove(dir); }
});

test('injectYml: strips a legacy marker block from a previous CLI version', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, [
      'server:',
      '  port: 8080',
      '',
      '# --- Contexa AI Security ---',
      'contexa:',
      '  llm:',
      '    chatModelPriority: ollama',
      '# --- End Contexa ---',
      '',
    ].join('\n'));
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    assert.equal(text.includes('# --- Contexa AI Security ---'), false,
      'legacy marker block must be stripped');
    const root = yaml.load(text);
    assert.equal((text.match(/^contexa\s*:/gm) || []).length, 1);
    assert.ok(root.contexa.llm.selection.chat.priority,
      'CLI must write the new selection-API priority');
  } finally { await fs.remove(dir); }
});

test('injectYml: never emits dead key contexa.jpa.hibernate.ddl-auto', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.jpa, undefined,
      'contexa.jpa is not bound by any @ConfigurationProperties; CLI must not write it');
  } finally { await fs.remove(dir); }
});

test('injectYml: emits contexa.hcad.geoip.enabled = true alongside dbPath', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.hcad.geoip.enabled, true,
      'enabled must be true so the dbPath actually takes effect (default in core is false)');
    assert.equal(root.contexa.hcad.geoip.dbPath, 'contexa/data/GeoLite2-City.mmdb');
  } finally { await fs.remove(dir); }
});

test('injectYml: emits contexa.llm.selection.* (new API) instead of deprecated chatModelPriority', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama', 'openai'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama,openai');
    assert.equal(root.contexa.llm.selection.embedding.priority, 'ollama');
    assert.equal(root.contexa.llm.chatModelPriority, undefined,
      'deprecated key must not be re-introduced');
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectMavenDep
// ============================================================

test('injectMavenDep: inserts dependency at project-level dependencies tag', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
</dependencies></project>`);
    const ok = await injectMavenDep(pomPath);
    assert.equal(ok, true);
    const pom = await fs.readFile(pomPath, 'utf8');
    assert.ok(pom.includes('spring-boot-starter-contexa'));
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: skips closing tag inside dependencyManagement', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId></dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
  </dependencies>
</project>`);
    await injectMavenDep(pomPath);
    const pom = await fs.readFile(pomPath, 'utf8');
    // Contexa dep must land in the project-level <dependencies>, not inside <dependencyManagement>.
    const mgmtBlock = pom.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)[0];
    assert.equal(mgmtBlock.includes('spring-boot-starter-contexa'), false,
      'contexa dep must NOT be injected inside dependencyManagement');
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: idempotent when artifact already present', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project><dependencies>
  <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0</version></dependency>
</dependencies></project>`);
    const ok = await injectMavenDep(pomPath);
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: creates project dependencies when only dependencyManagement exists', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement><dependencies>
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>old</version></dependency>
  </dependencies></dependencyManagement>
</project>`);
    assert.equal(await injectMavenDep(pomPath), true);
    const pom = await fs.readFile(pomPath, 'utf8');
    const outsideManagement = pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '');
    assert.match(outsideManagement, /<dependencies>[\s\S]*<groupId>ai\.ctxa<\/groupId>[\s\S]*<artifactId>spring-boot-starter-contexa<\/artifactId>/);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: comment text is not treated as an installed dependency', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <!-- ai.ctxa:spring-boot-starter-contexa is documentation only -->
  <dependencies></dependencies>
</project>`);
    assert.equal(await injectMavenDep(pomPath), true);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: captures only the CLI-added canonical coordinate', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    const addedDependencies = [];
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement><dependencies>
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId></dependency>
  </dependencies></dependencyManagement>
  <dependencies></dependencies>
</project>`);
    assert.equal(await injectMavenDep(pomPath, {
      targetModule: 'apps/api',
      addedDependencies,
    }), true);
    assert.deepEqual(addedDependencies, [{
      group: 'ai.ctxa',
      artifact: 'spring-boot-starter-contexa',
      configuration: 'compile',
      version: CONTEXA_VERSION,
      versionSource: 'literal',
      targetModule: 'apps/api',
    }]);
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectGradleDep
// ============================================================

test('injectGradleDep: Groovy DSL uses single-quoted notation', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
}`);
    await injectGradleDep(gPath);
    const out = await fs.readFile(gPath, 'utf8');
    assert.match(out, /implementation '[^']*spring-boot-starter-contexa[^']*'/);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: Kotlin DSL uses parenthesized double-quoted notation', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle.kts');
    await fs.writeFile(gPath, `dependencies {
    implementation("org.springframework.boot:spring-boot-starter")
}`);
    await injectGradleDep(gPath);
    const out = await fs.readFile(gPath, 'utf8');
    assert.match(out, /implementation\("[^"]*spring-boot-starter-contexa[^"]*"\)/);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: idempotent when artifact already present', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {
  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'
}`);
    const ok = await injectGradleDep(gPath);
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: ignores buildscript dependency blocks and braces in comments and strings', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `buildscript {
  dependencies { classpath 'ai.ctxa:spring-boot-starter-contexa:documentation-only' }
}
def sample = "dependencies { not real }"
// unmatched documentation brace {
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
}
`);
    assert.equal(await injectGradleDep(gPath), true);
    const out = await fs.readFile(gPath, 'utf8');
    const topLevel = out.slice(out.lastIndexOf('dependencies {'));
    assert.match(topLevel, /implementation 'ai\.ctxa:spring-boot-starter-contexa:/);
    assert.equal((out.match(/implementation 'ai\.ctxa:spring-boot-starter-contexa:/g) || []).length, 1);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: nested subprojects coordinate is not a top-level installed dependency', async () => {
  const dir = await tempDir();
  try {
    const gradlePath = path.join(dir, 'build.gradle.kts');
    const addedDependencies = [];
    await fs.writeFile(gradlePath, `subprojects {
  dependencies { implementation("ai.ctxa:spring-boot-starter-contexa:decoy") }
}
dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }
`);
    assert.equal(await injectGradleDep(gradlePath, {
      targetModule: '.',
      addedDependencies,
    }), true);
    const output = await fs.readFile(gradlePath, 'utf8');
    assert.equal((output.match(/ai\.ctxa:spring-boot-starter-contexa/g) || []).length, 2);
    assert.equal(addedDependencies.length, 1);
    assert.equal(addedDependencies[0].configuration, 'implementation');
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: writes exact SANDBOX mode to one Java main class', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/java/example/Application.java');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example;\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {}\n');
    const result = await injectEnableAiSecurity(dir, { securityMode: 'sandbox', mainApplicationCandidates: [source] });
    assert.equal(result.changed, true);
    const updated = await fs.readFile(source, 'utf8');
    assert.match(updated, /import io\.contexa\.contexacommon\.annotation\.EnableAISecurity;/);
    assert.match(updated, /import io\.contexa\.contexacommon\.security\.bridge\.SecurityMode;/);
    assert.match(updated, /@EnableAISecurity\(mode = SecurityMode\.SANDBOX\)\n@SpringBootApplication/);
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: writes exact FULL mode to one Kotlin main class', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/kotlin/example/Application.kt');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication\n\n@SpringBootApplication\nclass Application\n');
    await injectEnableAiSecurity(dir, { securityMode: 'full', mainApplicationCandidates: [source] });
    const updated = await fs.readFile(source, 'utf8');
    assert.match(updated, /import io\.contexa\.contexacommon\.annotation\.EnableAISecurity\n/);
    assert.match(updated, /@EnableAISecurity\(mode = SecurityMode\.FULL\)\n@SpringBootApplication/);
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: multiple main candidates fail without changing either source', async () => {
  const dir = await tempDir();
  try {
    const first = path.join(dir, 'First.java');
    const second = path.join(dir, 'Second.java');
    const original = '@SpringBootApplication\nclass App {}\n';
    await fs.writeFile(first, original);
    await fs.writeFile(second, original);
    await assert.rejects(
      injectEnableAiSecurity(dir, { securityMode: 'sandbox', mainApplicationCandidates: [first, second] }),
      /stopped safely: 2 main application classes/
    );
    assert.equal(await fs.readFile(first, 'utf8'), original);
    assert.equal(await fs.readFile(second, 'utf8'), original);
  } finally { await fs.remove(dir); }
});

test('injector.js does not export database initdb generation', () => {
  const exported = require('../src/core/injector');
  assert.equal('generateInitDbScripts' in exported, false,
    'CLI must not own schema/seed SQL copies; contexa-iam installs them at application startup');
});

// ============================================================
// generateDockerCompose
// ============================================================

test('generateDockerCompose: binds ports to 127.0.0.1 by default', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'standalone', includeOllama: true });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_POSTGRES_PORT:-5432}:5432'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_OLLAMA_PORT:-11434}:11434'));
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: container names and project name use CONTEXA_PROJECT prefix', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'distributed', includeOllama: true });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('name: ${CONTEXA_PROJECT:-contexa}'));
    assert.ok(yml.includes('container_name: ${CONTEXA_PROJECT:-contexa}-postgres'));
    assert.ok(yml.includes('container_name: ${CONTEXA_PROJECT:-contexa}-ollama'));
    assert.ok(yml.includes('container_name: ${CONTEXA_PROJECT:-contexa}-redis'));
    assert.ok(yml.includes('container_name: ${CONTEXA_PROJECT:-contexa}-zookeeper'));
    assert.ok(yml.includes('container_name: ${CONTEXA_PROJECT:-contexa}-kafka'));
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: POSTGRES_PASSWORD uses env fallback, not plaintext literal', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'standalone' });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('POSTGRES_PASSWORD: ${CONTEXA_DB_PASSWORD:-contexa1234!@#}'));
    // Plain "POSTGRES_PASSWORD: contexa1234" without env wrapper must not appear.
    assert.equal(/POSTGRES_PASSWORD:\s*contexa1234/.test(yml), false);
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: does not mount docker-entrypoint initdb SQL', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'distributed', includeOllama: true });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.equal(yml.includes('docker-entrypoint-initdb.d'), false,
      'schema/seed data must be installed by contexa-iam at application startup');
    assert.equal(yml.includes('./initdb'), false,
      'CLI must not rely on generated initdb SQL copies');
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: distributed mode adds redis/zookeeper/kafka with loopback binding', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'distributed' });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_REDIS_PORT:-6379}:6379'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_ZOOKEEPER_PORT:-2181}:2181'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_KAFKA_PORT:-9092}:9092'));
    assert.ok(yml.includes('zookeeper-log:/var/lib/zookeeper/log'));
    assert.ok(yml.includes('zookeeper-log:\n    labels: *contexa-ownership'));
    assert.ok(yml.includes('kafka-broker-api-versions", "--bootstrap-server", "kafka:9093"'));
    assert.ok(!yml.includes('kafka-broker-api-versions", "--bootstrap-server", "localhost:9092"'));
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: backs up existing compose file before overwrite', async () => {
  const dir = await tempDir();
  try {
    const composePath = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(composePath, 'services: {}\n');
    await generateDockerCompose(dir, { infra: 'standalone' });
    assert.ok(await fs.pathExists(composePath + '.bak'));
    await fs.remove(composePath + '.bak');
    await generateDockerCompose(dir, { infra: 'standalone', backupExisting: false });
    assert.equal(await fs.pathExists(composePath + '.bak'), false);
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectDistributedDeps (integration with build files)
// ============================================================

test('injectDistributedDeps: adds redisson + spring-kafka to Maven pom', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
</dependencies></project>`);
    const added = await injectDistributedDeps(pomPath);
    assert.equal(added, true);
    const pom = await fs.readFile(pomPath, 'utf8');
    assert.ok(pom.includes('spring-kafka'));
    assert.ok(pom.includes('redisson'));
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectSpringAiDeps (LLM selective dependencies & cleanups)
// ============================================================
const { injectSpringAiDeps } = require('../src/core/injector/build');

test('injectSpringAiDeps: filters model starters based on llmProviders', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {\n}`);
    
    // Select only openai and ollama, exclude anthropic
    await injectSpringAiDeps(gPath, ['openai', 'ollama']);
    const out = await fs.readFile(gPath, 'utf8');
    
    assert.ok(out.includes('spring-ai-starter-model-openai'));
    assert.ok(out.includes('spring-ai-starter-model-ollama'));
    assert.ok(!out.includes('spring-ai-starter-model-anthropic'));
    assert.ok(out.includes('spring-ai-starter-vector-store-pgvector'));
  } finally { await fs.remove(dir); }
});

test('injectSpringAiDeps: preserves customer-owned unselected model starters', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-openai'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-anthropic'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-ollama'\n` +
      `}`);
    
    // Selecting openai must not delete dependencies that existed beforehand.
    await injectSpringAiDeps(gPath, ['openai']);
    const out = await fs.readFile(gPath, 'utf8');
    
    assert.ok(out.includes('spring-ai-starter-model-openai'));
    assert.ok(out.includes('spring-ai-starter-model-anthropic'));
    assert.ok(out.includes('spring-ai-starter-model-ollama'));
  } finally { await fs.remove(dir); }
});

test('injectDistributedDeps: comments and same artifact under another group are decoys', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    const addedDependencies = [];
    await fs.writeFile(pomPath, `<project>
  <!-- org.redisson:redisson and org.springframework.kafka:spring-kafka are documentation -->
  <dependencies>
    <dependency><groupId>example.decoy</groupId><artifactId>spring-kafka</artifactId></dependency>
    <dependency><groupId>example.decoy</groupId><artifactId>redisson</artifactId></dependency>
  </dependencies>
</project>`);
    assert.equal(await injectDistributedDeps(pomPath, {
      targetModule: '.',
      addedDependencies,
    }), true);
    const coordinates = new Set(addedDependencies.map(item => `${item.group}:${item.artifact}`));
    assert.equal(coordinates.has('org.springframework.kafka:spring-kafka'), true);
    assert.equal(coordinates.has('org.redisson:redisson'), true);
    assert.equal(coordinates.has('example.decoy:spring-kafka'), false);
  } finally { await fs.remove(dir); }
});

test('explicit init injectors preserve every supported customer dependency and AI setting', async () => {
  const dir = await tempDir();
  try {
    const buildPath = path.join(dir, 'build.gradle');
    const dependencies = [
      'org.springframework.ai:spring-ai-starter-model-openai',
      'org.springframework.ai:spring-ai-starter-model-anthropic',
      'org.springframework.ai:spring-ai-starter-model-ollama',
      'org.springframework.ai:spring-ai-starter-vector-store-pgvector',
      'org.springframework.kafka:spring-kafka',
      'org.springframework.boot:spring-boot-starter-data-redis',
    ];
    await fs.writeFile(buildPath, `dependencies {\n${dependencies.map(value => `    implementation '${value}'`).join('\n')}\n}`);
    await injectSpringAiDeps(buildPath, ['openai']);
    await injectDistributedDeps(buildPath);
    const build = await fs.readFile(buildPath, 'utf8');
    dependencies.forEach(value => {
      assert.equal(build.split(value).length - 1, 1, `${value} must remain exactly once`);
    });

    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, [
      'spring:',
      '  ai:',
      '    openai:',
      '      api-key: host-openai',
      '    anthropic:',
      '      api-key: host-anthropic',
      '    ollama:',
      '      base-url: http://host-ollama:11434',
      'contexa:',
      '  llm:',
      '    chat:',
      '      ollama:',
      '        model: host-model',
    ].join('\n'));
    const result = await injectYml(ymlPath, {
      mode: 'shadow',
      enableAiSecurity: true,
      llmProviders: ['openai'],
    });
    const root = loadYml(ymlPath);
    assert.equal(root.spring.ai.openai['api-key'], 'host-openai');
    assert.equal(root.spring.ai.anthropic['api-key'], 'host-anthropic');
    assert.equal(root.spring.ai.ollama['base-url'], 'http://host-ollama:11434');
    assert.equal(root.contexa.llm.chat.ollama.model, 'host-model');
    assert.ok(!result.managedPaths.includes('llm.chat.ollama.model'));
  } finally { await fs.remove(dir); }
});

test('injectYml: configures fixed mode and ollama priority when ollama is selected', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama');
    assert.equal(root.contexa.llm.selection.embedding.mode, 'fixed');
    assert.equal(root.contexa.llm.selection.embedding.priority, 'ollama');
  } finally { await fs.remove(dir); }
});

test('injectYml: preserves host spring.ai and user-owned contexa LLM blocks', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, [
      'spring:',
      '  ai:',
      '    openai:',
      '      api-key: somekey',
      '    anthropic:',
      '      api-key: otherkey',
      'contexa:',
      '  llm:',
      '    chat:',
      '      ollama:',
      '        model: qwen2.5:7b',
    ].join('\n'));
    
    // Select only anthropic. Both spring.ai and pre-existing contexa.llm belong to the host app.
    await injectYml(ymlPath, { mode: 'shadow', enableAiSecurity: true, llmProviders: ['anthropic'] });
    const root = loadYml(ymlPath);
    
    assert.ok(root.spring.ai.anthropic);
    assert.ok(root.spring.ai.openai);
    assert.equal(root.contexa.llm.chat.ollama.model, 'qwen2.5:7b');
  } finally { await fs.remove(dir); }
});
