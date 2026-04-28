'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const { detectSpringProject } = require('../src/core/detector');

// Build a fresh temp project root for each scenario so cases don't bleed.
async function makeTempProject(layout) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-detector-'));
  for (const [rel, content] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

test('detector: returns isSpring=false when neither pom.xml nor build.gradle exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-detector-'));
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.isSpring, false);
    assert.equal(r.buildTool, null);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Maven project with spring-boot dep is detected', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project>
  <artifactId>my-app</artifactId>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
  </dependencies>
</project>`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.isSpring, true);
    assert.equal(r.buildTool, 'maven');
    assert.equal(r.hasSpringBoot, true);
    assert.equal(r.projectName, 'my-app');
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Maven projectName ignores parent artifactId', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project>
  <parent><artifactId>parent-pom</artifactId></parent>
  <artifactId>child-app</artifactId>
  <dependencies></dependencies>
</project>`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.projectName, 'child-app');
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Maven detects Spring Security and Contexa starter', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project>
  <artifactId>x</artifactId>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
    <dependency><groupId>io.contexa</groupId><artifactId>spring-boot-starter-contexa</artifactId></dependency>
  </dependencies>
</project>`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.hasSpringSecurityCore, true);
    assert.equal(r.hasContexta, true);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Gradle Groovy DSL is detected', async () => {
  const dir = await makeTempProject({
    'build.gradle': `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
}`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.isSpring, true);
    assert.equal(r.buildTool, 'gradle');
    assert.equal(r.buildFilePath.endsWith('build.gradle'), true);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Gradle Kotlin DSL is detected', async () => {
  const dir = await makeTempProject({
    'build.gradle.kts': `dependencies {
  implementation("org.springframework.boot:spring-boot-starter")
}`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.isSpring, true);
    assert.equal(r.buildTool, 'gradle');
    assert.equal(r.buildFilePath.endsWith('build.gradle.kts'), true);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: appYmlPath and appPropertiesPath are independent', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project><artifactId>x</artifactId><dependencies></dependencies></project>`,
    'src/main/resources/application.yml': 'server:\n  port: 8080\n',
    'src/main/resources/application.properties': 'server.port=8080\n',
  });
  try {
    const r = await detectSpringProject(dir);
    assert.ok(r.appYmlPath, 'appYmlPath should be set');
    assert.ok(r.appPropertiesPath, 'appPropertiesPath should be set');
    assert.notEqual(r.appYmlPath, r.appPropertiesPath);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: only application.yml present leaves properties path null', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project><artifactId>x</artifactId><dependencies></dependencies></project>`,
    'src/main/resources/application.yml': '',
  });
  try {
    const r = await detectSpringProject(dir);
    assert.ok(r.appYmlPath);
    assert.equal(r.appPropertiesPath, null);
  } finally {
    await fs.remove(dir);
  }
});
