'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const {
  injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
  generateDockerCompose, generateInitDbScripts,
} = require('../src/core/injector');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-injector-'));
}

function loadYml(p) {
  return yaml.load(fs.readFileSync(p, 'utf8'));
}

// ============================================================
// injectYml - merged contexa.* tree (no marker block)
// ============================================================

test('injectYml: produces a parseable yaml with a single contexa: tree', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const text = await fs.readFile(ymlPath, 'utf8');
    const root = yaml.load(text);
    assert.ok(root && root.contexa, 'contexa: must exist as a top-level key');
    const contexaOccurrences = (text.match(/^contexa\s*:/gm) || []).length;
    assert.equal(contexaOccurrences, 1, 'contexa: must appear exactly once at top level');
  } finally { await fs.remove(dir); }
});

test('injectYml: emits contexa.datasource with double env fallback (preserves customer DB isolation)', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.datasource.url,
      '${CONTEXA_DB_URL:${DB_URL:jdbc:postgresql://localhost:5432/contexa}}');
    assert.equal(root.contexa.datasource.password,
      '${CONTEXA_DB_PASSWORD:${DB_PASSWORD:contexa1234!@#}}');
    assert.equal(root.contexa.datasource.isolation['contexa-owned-application'], true);
  } finally { await fs.remove(dir); }
});

test('injectYml: ENFORCE mode writes contexa.security.zerotrust.mode = ENFORCE', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.security.zerotrust.mode, 'ENFORCE');
  } finally { await fs.remove(dir); }
});

test('injectYml: distributed sets contexa.infrastructure.mode and never spring.data.redis/kafka', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'], infra: 'distributed' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'DISTRIBUTED');
    assert.equal(root.spring, undefined, 'spring.* must not be written by CLI');
  } finally { await fs.remove(dir); }
});

test('injectYml: never writes any spring.* key across all provider/infra combinations', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    for (const infra of ['standalone', 'distributed']) {
      for (const providers of [['ollama'], ['openai'], ['anthropic'], ['ollama', 'openai', 'anthropic']]) {
        await injectYml(ymlPath, { mode: 'shadow', llmProviders: providers, infra });
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const backupDest = path.join(dir, 'contexa', 'bak', 'application.yml');
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
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

test('injectYml: --distributed overrides existing contexa.infrastructure.mode', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, 'contexa:\n  infrastructure:\n    mode: standalone\n');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'], infra: 'distributed' });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.infrastructure.mode, 'DISTRIBUTED');
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    assert.equal(root.contexa.jpa, undefined,
      'contexa.jpa is not bound by any @ConfigurationProperties; CLI must not write it');
  } finally { await fs.remove(dir); }
});

test('injectYml: emits contexa.hcad.geoip.enabled = true alongside dbPath', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
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
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama', 'openai'] });
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

// ============================================================
// generateInitDbScripts - seed password randomization
// ============================================================

test('generateInitDbScripts: writes 01-core-ddl.sql successfully', async () => {
  const dir = await tempDir();
  try {
    await generateInitDbScripts(dir);
    const ddlExists = await fs.pathExists(path.join(dir, 'initdb', '01-core-ddl.sql'));
    assert.equal(ddlExists, true, '01-core-ddl.sql should be generated');
  } finally { await fs.remove(dir); }
});

test('generateInitDbScripts: generated DDL contains the complete OSS runtime schema', async () => {
  const dir = await tempDir();
  try {
    await generateInitDbScripts(dir);
    const ddl = await fs.readFile(path.join(dir, 'initdb', '01-core-ddl.sql'), 'utf8');
    const tableNames = [...ddl.matchAll(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:"?public"?|\w+)\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gim)]
      .map(match => match[1].toLowerCase());
    const uniqueTableNames = [...new Set(tableNames)].sort();

    assert.equal(uniqueTableNames.length, 73,
      '01-core-ddl.sql must install every OSS table from contexa-iam db/schema.sql');
    const vectorExtensionIndex = ddl.search(/create\s+extension\s+if\s+not\s+exists\s+vector/i);
    const vectorStoreIndex = ddl.search(/create\s+table\s+(?:if\s+not\s+exists\s+)?vector_store/i);
    assert.notEqual(vectorExtensionIndex, -1,
      '01-core-ddl.sql must create the pgvector extension before vector_store');
    assert.notEqual(vectorStoreIndex, -1,
      '01-core-ddl.sql must include vector_store');
    assert.equal(vectorExtensionIndex < vectorStoreIndex, true,
      'pgvector extension must be created before vector_store uses vector(1024)');
    for (const required of [
      'sealed_evidence_package',
      'official_verification_oss_run',
      'official_metric_evaluation_contract',
      'official_prompt_signal_contract',
    ]) {
      assert.equal(uniqueTableNames.includes(required), true,
        `01-core-ddl.sql must include ${required}`);
    }
    for (const forbidden of [
      'pqa_resolution_work_item',
      'prompt_runtime_governance_action',
      'prompt_runtime_governance_action_policy',
      'prompt_runtime_governance_action_type_contract',
      'prompt_runtime_governance_application_ledger',
      'prompt_runtime_governance_check_action_contract',
      'prompt_runtime_governance_rule',
      'prompt_runtime_governance_scope_type_contract',
      'prompt_runtime_metric_check_slot_contract',
      'prompt_runtime_slot_contract',
      'prompt_quality_certificate_ledger',
      'prompt_quality_certificate_audit_event',
      'prompt_quality_issue_case',
      'prompt_governance_registry',
      'prompt_governance_runtime_cache_invalidation',
      'protectable_resource_registry',
      'protectable_resource_overlay',
    ]) {
      assert.equal(uniqueTableNames.includes(forbidden), false,
        `01-core-ddl.sql must not include Enterprise-only table ${forbidden}`);
    }
  } finally { await fs.remove(dir); }
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

test('generateDockerCompose: distributed mode adds redis/zookeeper/kafka with loopback binding', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'distributed' });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_REDIS_PORT:-6379}:6379'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_ZOOKEEPER_PORT:-2181}:2181'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:${CONTEXA_KAFKA_PORT:-9092}:9092'));
  } finally { await fs.remove(dir); }
});

test('generateDockerCompose: backs up existing compose file before overwrite', async () => {
  const dir = await tempDir();
  try {
    const composePath = path.join(dir, 'docker-compose.yml');
    await fs.writeFile(composePath, 'services: {}\n');
    await generateDockerCompose(dir, { infra: 'standalone' });
    assert.ok(await fs.pathExists(composePath + '.bak'));
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

test('injectSpringAiDeps: cleans up unselected model starters from build file', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-openai'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-anthropic'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-ollama'\n` +
      `}`);
    
    // Keep only openai, clean up anthropic and ollama
    await injectSpringAiDeps(gPath, ['openai']);
    const out = await fs.readFile(gPath, 'utf8');
    
    assert.ok(out.includes('spring-ai-starter-model-openai'));
    assert.ok(!out.includes('spring-ai-starter-model-anthropic'));
    assert.ok(!out.includes('spring-ai-starter-model-ollama'));
  } finally { await fs.remove(dir); }
});

test('injectYml: configures fixed mode and ollama priority when ollama is selected', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const root = loadYml(ymlPath);
    
    assert.equal(root.contexa.llm.selection.chat.priority, 'ollama');
    assert.equal(root.contexa.llm.selection.embedding.mode, 'fixed');
    assert.equal(root.contexa.llm.selection.embedding.priority, 'ollama');
  } finally { await fs.remove(dir); }
});

test('injectYml: cleans up unselected LLM configuration blocks', async () => {
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
    
    // Select only anthropic (cleans up openai and ollama)
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['anthropic'] });
    const root = loadYml(ymlPath);
    
    assert.ok(root.spring.ai.anthropic);
    assert.ok(!root.spring.ai.openai);
    assert.ok(!root.contexa.llm.chat);
  } finally { await fs.remove(dir); }
});
