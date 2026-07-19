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
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId></dependency>
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

test('detector: non-Spring Maven and Gradle build files are not accepted', async () => {
  const maven = await makeTempProject({
    'pom.xml': '<project><artifactId>plain</artifactId><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency></dependencies></project>',
  });
  const gradle = await makeTempProject({
    'build.gradle': "plugins { id 'java' }\ndependencies { implementation 'org.slf4j:slf4j-api:2.0.0' }\n",
  });
  try {
    assert.equal((await detectSpringProject(maven, { probeDocker: false })).isSpring, false);
    assert.equal((await detectSpringProject(gradle, { probeDocker: false })).isSpring, false);
  } finally {
    await fs.remove(maven);
    await fs.remove(gradle);
  }
});

test('detector: inventories application, profile and bootstrap config variants', async () => {
  const dir = await makeTempProject({
    'build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.4" }\n',
    'src/main/resources/application.yml': '',
    'src/main/resources/application-local.yaml': '',
    'src/main/resources/application-prod.properties': '',
    'src/main/resources/bootstrap.yml': '',
    'src/main/resources/bootstrap-test.properties': '',
  });
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.deepEqual(result.applicationConfigPaths.map(file => path.basename(file)), [
      'application-local.yaml',
      'application-prod.properties',
      'application.yml',
      'bootstrap-test.properties',
      'bootstrap.yml',
    ]);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: ignores annotations in comments and strings and scans Java after 250 files plus Kotlin', async () => {
  const dir = await makeTempProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n",
    'src/main/java/example/Fake.java': 'package example; // @EnableAISecurity\nclass Fake { String value = "@SpringBootApplication"; }\n',
    'src/main/java/z/ActualApplication.java': 'package z;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class ActualApplication {}\n',
    'src/main/kotlin/example/KotlinApplication.kt': 'package example\nimport org.springframework.boot.autoconfigure.SpringBootApplication\n@SpringBootApplication\nclass KotlinApplication\n',
  });
  const generated = path.join(dir, 'src/main/java/generated');
  await fs.ensureDir(generated);
  for (let i = 0; i < 260; i++) {
    await fs.writeFile(path.join(generated, `Generated${String(i).padStart(3, '0')}.java`), `package generated; class Generated${i} {}\n`);
  }
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hasEnableAiSecurity, false);
    assert.deepEqual(result.mainApplicationCandidates.map(file => path.basename(file)).sort(), [
      'ActualApplication.java',
      'KotlinApplication.kt',
    ]);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: selects one Spring module and safely rejects ambiguous module roots', async () => {
  const single = await makeTempProject({
    'settings.gradle': "rootProject.name='root'\ninclude 'plain', 'app'\n",
    'build.gradle': "plugins { id 'base' }\n",
    'plain/build.gradle': "plugins { id 'java' }\n",
    'app/build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n",
  });
  const ambiguous = await makeTempProject({
    'settings.gradle.kts': "rootProject.name = \"root\"\ninclude(\"app-a\", \"app-b\")\n",
    'build.gradle.kts': 'plugins { base }\n',
    'app-a/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.4" }\n',
    'app-b/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.4" }\n',
  });
  try {
    const selected = await detectSpringProject(single, { probeDocker: false });
    assert.equal(selected.isSpring, true);
    assert.equal(selected.buildFilePath, path.join(single, 'app', 'build.gradle'));
    const rejected = await detectSpringProject(ambiguous, { probeDocker: false });
    assert.equal(rejected.isSpring, false);
    assert.equal(rejected.ambiguousModules.length, 2);
  } finally {
    await fs.remove(single);
    await fs.remove(ambiguous);
  }
});

test('detector: identifies host-owned Java and Kotlin SecurityFilterChain beans', async () => {
  const javaProject = await makeTempProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n",
    'src/main/java/example/SecurityConfig.java': 'package example;\n@Configuration class SecurityConfig {\n@Bean SecurityFilterChain hostChain(HttpSecurity http) throws Exception { return http.build(); }\n}\n',
  });
  const kotlinProject = await makeTempProject({
    'build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.4" }\n',
    'src/main/kotlin/example/SecurityConfig.kt': 'package example\n@Configuration class SecurityConfig {\n@Bean fun hostChain(http: HttpSecurity): SecurityFilterChain = http.build()\n}\n',
  });
  try {
    assert.equal((await detectSpringProject(javaProject)).hasHostSecurityFilterChain, true);
    assert.equal((await detectSpringProject(kotlinProject)).hasHostSecurityFilterChain, true);
  } finally {
    await fs.remove(javaProject);
    await fs.remove(kotlinProject);
  }
});
