'use strict';

// Stress / matrix tests over customer project shapes: build-file injection on Maven and Gradle
// (dependencyManagement, idempotency) and detection across multi-module layouts. Each test builds
// an isolated temp directory representing a realistic customer project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { detectSpringProject } = require('../src/core/detector');
const { injectMavenDep, injectGradleDep } = require('../src/core/injector/build');

async function makeProject(layout) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-stress-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

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
// K. @EnableAISecurity detection
// ============================================================

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
