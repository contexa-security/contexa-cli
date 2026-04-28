'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  injectYml, injectMavenDep, injectGradleDep, injectDistributedDeps,
  generateDockerCompose, generateInitDbScripts,
} = require('../src/core/injector');

const MARKER_START = '# --- Contexa AI Security ---';
const MARKER_END   = '# --- End Contexa ---';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-injector-'));
}

// ============================================================
// injectYml
// ============================================================

test('injectYml: writes Contexa-managed block with markers', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const out = await fs.readFile(ymlPath, 'utf8');
    assert.ok(out.includes(MARKER_START));
    assert.ok(out.includes(MARKER_END));
  } finally { await fs.remove(dir); }
});

test('injectYml: emits contexa.datasource with double env fallback', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    const out = await fs.readFile(ymlPath, 'utf8');
    assert.ok(out.includes('contexa:'));
    assert.ok(out.includes('${CONTEXA_DB_URL:${DB_URL:jdbc:postgresql://localhost:5432/contexa}}'));
    assert.ok(out.includes('${CONTEXA_DB_PASSWORD:${DB_PASSWORD:contexa1234!@#}}'));
    assert.ok(out.includes('contexa-owned-application: true'));
    assert.ok(out.includes('${CONTEXA_JPA_DDL_AUTO:update}'));
  } finally { await fs.remove(dir); }
});

test('injectYml: ENFORCE mode writes uppercase value', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const out = await fs.readFile(ymlPath, 'utf8');
    assert.match(out, /zerotrust:\s*\n\s*mode:\s*ENFORCE/);
  } finally { await fs.remove(dir); }
});

test('injectYml: distributed mode adds redis and kafka blocks', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'], infra: 'distributed' });
    const out = await fs.readFile(ymlPath, 'utf8');
    assert.ok(out.includes('infrastructure:'));
    assert.ok(out.includes('mode: DISTRIBUTED'));
    assert.ok(out.includes('${REDIS_HOST:localhost}'));
    assert.ok(out.includes('${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}'));
  } finally { await fs.remove(dir); }
});

test('injectYml: idempotent - second call replaces the managed block, not appends', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    await injectYml(ymlPath, { mode: 'enforce', llmProviders: ['ollama'] });
    const out = await fs.readFile(ymlPath, 'utf8');
    const startCount = (out.match(new RegExp(MARKER_START.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')) || []).length;
    assert.equal(startCount, 1, 'managed block must appear exactly once');
    assert.match(out, /mode:\s*ENFORCE/);
  } finally { await fs.remove(dir); }
});

test('injectYml: backs up existing file before modifying', async () => {
  const dir = await tempDir();
  try {
    const ymlPath = path.join(dir, 'application.yml');
    await fs.writeFile(ymlPath, 'server:\n  port: 8080\n');
    await injectYml(ymlPath, { mode: 'shadow', llmProviders: ['ollama'] });
    assert.ok(await fs.pathExists(ymlPath + '.bak'));
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
  <dependency><groupId>io.contexa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0</version></dependency>
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
  implementation 'io.contexa:spring-boot-starter-contexa:0.1.0'
}`);
    const ok = await injectGradleDep(gPath);
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

// ============================================================
// generateInitDbScripts - seed password randomization
// ============================================================

test('generateInitDbScripts: returns a non-empty seed password', async () => {
  const dir = await tempDir();
  try {
    const r = await generateInitDbScripts(dir);
    assert.ok(typeof r.seedPassword === 'string');
    assert.ok(r.seedPassword.length >= 12, 'seed password should be at least 12 chars');
  } finally { await fs.remove(dir); }
});

test('generateInitDbScripts: each call produces a different seed password and different hash', async () => {
  const dir1 = await tempDir();
  const dir2 = await tempDir();
  try {
    const r1 = await generateInitDbScripts(dir1);
    const r2 = await generateInitDbScripts(dir2);
    assert.notEqual(r1.seedPassword, r2.seedPassword);
    const dml1 = await fs.readFile(path.join(dir1, 'initdb', '02-dml.sql'), 'utf8');
    const dml2 = await fs.readFile(path.join(dir2, 'initdb', '02-dml.sql'), 'utf8');
    const hash1 = dml1.match(/\{bcrypt\}([^']+)/)[1];
    const hash2 = dml2.match(/\{bcrypt\}([^']+)/)[1];
    assert.notEqual(hash1, hash2);
  } finally { await fs.remove(dir1); await fs.remove(dir2); }
});

test('generateInitDbScripts: legacy hardcoded 1234 hash is no longer present', async () => {
  const dir = await tempDir();
  try {
    await generateInitDbScripts(dir);
    const dml = await fs.readFile(path.join(dir, 'initdb', '02-dml.sql'), 'utf8');
    // The pre-randomization hash for password '1234' must not appear anywhere.
    assert.equal(dml.includes('8zyaQFyvO1gn1gbPp.bjrumKfRFif3CiDgpqK4aB4n8Gl2cbTOxJy'), false);
    // No leftover token marker either.
    assert.equal(dml.includes('__SEED_BCRYPT_HASH__'), false);
  } finally { await fs.remove(dir); }
});

// ============================================================
// generateDockerCompose
// ============================================================

test('generateDockerCompose: binds ports to 127.0.0.1 by default', async () => {
  const dir = await tempDir();
  try {
    await generateDockerCompose(dir, { infra: 'standalone' });
    const yml = await fs.readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:5432:5432'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:11434:11434'));
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
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:6379:6379'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:2181:2181'));
    assert.ok(yml.includes('${COMPOSE_BIND_HOST:-127.0.0.1}:9092:9092'));
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
