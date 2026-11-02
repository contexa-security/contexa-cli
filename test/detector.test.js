'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  detectSpringProject,
  detectSpringBootVersion,
  detectHostDatabase,
  collectHostConfigKeys,
  catalogBootVersion,
} = require('../src/core/detector');

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
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0</version></dependency>
  </dependencies>
</project>`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.hasSpringSecurityCore, true);
    assert.equal(r.hasContexta, true);
    assert.equal(r.contextaVersion, '0.1.0');
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Gradle Groovy DSL is detected', async () => {
  const dir = await makeTempProject({
    'build.gradle': `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'
}`,
  });
  try {
    const r = await detectSpringProject(dir);
    assert.equal(r.isSpring, true);
    assert.equal(r.buildTool, 'gradle');
    assert.equal(r.buildFilePath.endsWith('build.gradle'), true);
    assert.equal(r.contextaVersion, '0.1.0');
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

test('detector: Maven dependencyManagement and pluginManagement are not installed application features', async () => {
  const dir = await makeTempProject({
    'pom.xml': `<project>
  <modelVersion>4.0.0</modelVersion>
  <artifactId>managed-only</artifactId>
  <packaging>pom</packaging>
  <dependencyManagement><dependencies>
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId></dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
  </dependencies></dependencyManagement>
  <build><pluginManagement><plugins>
    <plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin>
  </plugins></pluginManagement></build>
</project>`,
  });
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, false);
    assert.equal(result.hasContexta, false);
    assert.equal(result.hasSpringSecurityCore, false);
  } finally {
    await fs.remove(dir);
  }
});

test('detector: nested Maven modules select the only Spring application owner', async () => {
  const dir = await makeTempProject({
    'pom.xml': '<project><artifactId>root</artifactId><packaging>pom</packaging><modules><module>services</module></modules></project>',
    'services/pom.xml': '<project><artifactId>services</artifactId><packaging>pom</packaging><modules><module>api</module></modules></project>',
    'services/api/pom.xml': '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent><artifactId>api</artifactId></project>',
  });
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.projectDir, path.join(dir, 'services', 'api'));
  } finally {
    await fs.remove(dir);
  }
});

test('detector: Gradle strings, buildscript and pluginManagement are not application ownership', async () => {
  const dir = await makeTempProject({
    'settings.gradle.kts': 'pluginManagement { plugins { id("org.springframework.boot") version "3.5.4" } }\nrootProject.name = "decoy"\n',
    'build.gradle.kts': `buildscript {
  dependencies { classpath("org.springframework.boot:spring-boot-gradle-plugin:3.5.4") }
}
val documentation = "ai.ctxa:spring-boot-starter-contexa:0.1.0"
dependencies { implementation("org.slf4j:slf4j-api:2.0.0") }
`,
  });
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, false);
    assert.equal(result.hasContexta, false);
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

test('detector: Gradle custom projectDir mapping selects the mapped Spring module only', async () => {
  const dir = await makeTempProject({
    'settings.gradle.kts': `rootProject.name = "mapped-root"
include(":api")
project(":api").projectDir = file("services/http-api")
`,
    'build.gradle.kts': 'plugins { base }\n',
    'services/http-api/build.gradle.kts': 'plugins { id("org.springframework.boot") version "3.5.4" }\n',
  });
  try {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.projectDir, path.join(dir, 'services', 'http-api'));
  } finally {
    await fs.remove(dir);
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

// --- multi-module roots, Spring Boot version, host database, host config keys ----------------

async function withProject(layout, action) {
  const dir = await makeTempProject(layout);
  try {
    return await action(dir);
  } finally {
    await fs.remove(dir);
  }
}

const WEB_STARTER_GROOVY = "dependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n";
const WEB_STARTER_KTS = 'dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }\n';
const WEB_STARTER_MAVEN = '<dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies>';

test('detector: a multi-module root with the Boot plugin "apply false" is not a Spring application', async () => {
  await withProject({
    'settings.gradle': "rootProject.name = 'shop'\ninclude 'app'\n",
    'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.5.4' apply false\n  id 'io.spring.dependency-management' version '1.1.7' apply false\n}\n",
    'app/build.gradle': "plugins {\n  id 'java'\n  id 'org.springframework.boot'\n}\n" + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.deepEqual(result.ambiguousModules, []);
    assert.equal(result.projectDir, path.join(dir, 'app'));
    assert.equal(result.gradleRootDir, dir);
    // The version comes from the root declaration even though it is not applied there.
    assert.equal(result.springBootVersion, '3.5.4');
    assert.equal(result.springBootVersionSource, path.join(dir, 'build.gradle'));
  });

  await withProject({
    'build.gradle.kts': 'plugins {\n  id("org.springframework.boot") version "3.5.4" apply false\n}\n',
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, false);
    assert.equal(result.buildTool, 'gradle');
  });
});

test('detector: Spring Boot version from Groovy and Kotlin DSL plugins blocks', async () => {
  await withProject({
    'build.gradle': "plugins {\n  id 'java'\n  id 'org.springframework.boot' version '3.5.4'\n}\n" + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.springBootVersion, '3.5.4');
    assert.equal(result.springBootVersionSource, path.join(dir, 'build.gradle'));
  });
  await withProject({
    'build.gradle.kts': 'plugins {\n  java\n  id("org.springframework.boot") version "3.4.1"\n}\n' + WEB_STARTER_KTS,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.springBootVersion, '3.4.1');
    assert.equal(result.springBootVersionSource, path.join(dir, 'build.gradle.kts'));
  });
});

test('detector: Spring Boot version through a gradle.properties placeholder', async () => {
  await withProject({
    'gradle.properties': 'org.gradle.jvmargs=-Xmx1g\nspringBootVersion=3.3.5\n',
    'settings.gradle': "pluginManagement {\n  plugins {\n    id 'org.springframework.boot' version \"${springBootVersion}\"\n  }\n}\nrootProject.name = 'props'\n",
    'build.gradle': "plugins {\n  id 'org.springframework.boot'\n}\n" + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, '3.3.5');
    assert.equal(result.springBootVersionSource, path.join(dir, 'settings.gradle'));
  });
  // A placeholder that gradle.properties does not define stays unknown.
  await withProject({
    'build.gradle': "plugins {\n  id 'org.springframework.boot' version \"${bootVersion}\"\n}\n" + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, null);
    assert.equal(result.springBootVersionSource, null);
  });
});

test('detector: Spring Boot version from a libs.versions.toml plugin alias', async () => {
  const catalog = [
    '[versions]',
    'spring-boot = "3.5.3"',
    '',
    '[plugins]',
    'spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }',
    '',
  ].join('\n');
  await withProject({
    'gradle/libs.versions.toml': catalog,
    'build.gradle.kts': 'plugins {\n  alias(libs.plugins.spring.boot)\n}\n' + WEB_STARTER_KTS,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, '3.5.3');
    assert.equal(result.springBootVersionSource, path.join(dir, 'gradle', 'libs.versions.toml'));
  });
  assert.equal(catalogBootVersion(catalog), '3.5.3');
  assert.equal(catalogBootVersion('[plugins]\nboot = { id = "org.springframework.boot", version = "3.5.2" }\n'), '3.5.2');
  assert.equal(catalogBootVersion('[plugins]\nother = { id = "com.example", version = "1.0" }\n'), null);
  assert.equal(catalogBootVersion(null), null);
});

test('detector: Spring Boot version from a buildscript classpath with apply plugin', async () => {
  await withProject({
    'build.gradle': [
      'buildscript {',
      '  repositories { mavenCentral() }',
      "  dependencies { classpath 'org.springframework.boot:spring-boot-gradle-plugin:3.2.12' }",
      '}',
      "apply plugin: 'java'",
      "apply plugin: 'org.springframework.boot'",
      '',
    ].join('\n') + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, '3.2.12');
  });
});

test('detector: Spring Boot version from a Maven parent and from a spring-boot-dependencies import', async () => {
  await withProject({
    'pom.xml': `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.5.16</version>
    <relativePath/>
  </parent>
  <artifactId>parented</artifactId>
  ${WEB_STARTER_MAVEN}
</project>`,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.springBootVersion, '3.5.16');
    assert.equal(result.springBootVersionSource, path.join(dir, 'pom.xml'));
  });
  await withProject({
    'pom.xml': `<project>
  <artifactId>imported</artifactId>
  <properties>
    <java.version>17</java.version>
    <spring-boot.version>3.4.5</spring-boot.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>\${spring-boot.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  ${WEB_STARTER_MAVEN}
</project>`,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, '3.4.5');
  });
  await withProject({
    'pom.xml': `<project><artifactId>unversioned</artifactId>${WEB_STARTER_MAVEN}</project>`,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.isSpring, true);
    assert.equal(result.springBootVersion, null);
  });
});

test('detector: detectSpringBootVersion reports Spring Boot 4 as it is', async () => {
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '4.0.0' }\n" + WEB_STARTER_GROOVY,
  }, async (dir) => {
    const version = await detectSpringBootVersion({ buildTool: 'gradle', projectDir: dir, gradleRootDir: null }, dir);
    assert.deepEqual(version, { version: '4.0.0', source: path.join(dir, 'build.gradle') });
  });
});

test('detector: hostOwnsDatabase from data-jpa, h2, spring.datasource.url, or nothing', async () => {
  await withProject({
    'pom.xml': `<project><artifactId>jpa</artifactId><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
</dependencies></project>`,
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hostOwnsDatabase, true);
    assert.equal(result.hostDatabaseReason, 'org.springframework.boot:spring-boot-starter-data-jpa');
  });
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n  runtimeOnly 'com.h2database:h2'\n}\n",
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hostOwnsDatabase, true);
    assert.equal(result.hostDatabaseReason, 'com.h2database:h2');
  });
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n" + WEB_STARTER_GROOVY,
    'src/main/resources/application.properties': 'spring.datasource.url=jdbc:postgresql://db:5432/shop\n',
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hostOwnsDatabase, true);
    assert.equal(result.hostDatabaseReason, 'spring.datasource.url');
  });
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n" + WEB_STARTER_GROOVY,
    'src/main/resources/application.yml': 'server:\n  port: 8081\n',
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hostOwnsDatabase, false);
    assert.equal(result.hostDatabaseReason, null);
    const direct = await detectHostDatabase(result);
    assert.deepEqual(direct, { owns: false, reason: null });
  });
});

test('detector: collectHostConfigKeys reads properties and multi-document YAML, skipping profile documents', async () => {
  await withProject({
    'src/main/resources/application.properties': [
      '# a comment = ignored',
      '! another comment',
      'server.port=8081',
      'spring.application.name: shop',
      'spring.datasource.driverClassName=org.postgresql.Driver',
      '',
    ].join('\n'),
    'src/main/resources/application.yml': [
      'spring:',
      '  ai:',
      '    openai:',
      '      api-key: sk-test',
      '  mail:',
      '    host: smtp.example.com',
      '---',
      'contexa:',
      '  llm:',
      '    selection:',
      '      chat:',
      '        priority: openai',
      '---',
      'spring:',
      '  config:',
      '    activate:',
      '      on-profile: prod',
      '  datasource:',
      '    url: jdbc:postgresql://prod/db',
      '',
    ].join('\n'),
    'src/main/resources/application-dev.yml': 'spring:\n  datasource:\n    url: jdbc:h2:mem:dev\n',
  }, async (dir) => {
    const resources = path.join(dir, 'src', 'main', 'resources');
    const keys = await collectHostConfigKeys([
      path.join(resources, 'application.properties'),
      path.join(resources, 'application.yml'),
      path.join(resources, 'application-dev.yml'),
    ]);
    assert.deepEqual([...keys].sort(), [
      'contexa.llm.selection.chat.priority',
      'server.port',
      'spring.ai.openai.api-key',
      'spring.application.name',
      'spring.datasource.driver-class-name',
      'spring.mail.host',
    ]);
    assert.equal(keys.has('spring.datasource.url'), false, 'profile documents and profile files are not host defaults');
  });
  assert.equal((await collectHostConfigKeys([])).size, 0);
});

test('detector: keys in the application\'s own config/application.* count, the file Contexa wrote there does not', async () => {
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n" + WEB_STARTER_GROOVY,
    'src/main/resources/application.yml': 'server:\n  port: 8081\n',
    'src/main/resources/config/application.properties': 'spring.datasource.url=jdbc:postgresql://db/shop\napp.feature=on\n',
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.deepEqual(result.configDirPaths, [path.join(dir, 'src', 'main', 'resources', 'config', 'application.properties')]);
    assert.equal(result.hostConfigKeys.has('app.feature'), true);
    assert.equal(result.hostConfigKeys.has('server.port'), true);
    assert.equal(result.hostOwnsDatabase, true);
    assert.equal(result.hostDatabaseReason, 'spring.datasource.url');
    assert.equal(result.appPropertiesPath, null, 'the config/ file is not taken for the root application.properties');
  });
  await withProject({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.5.4' }\n" + WEB_STARTER_GROOVY,
    'src/main/resources/config/application.yml':
      '# Contexa settings, written by `contexa init`.\ncontexa:\n  security:\n    zerotrust:\n      mode: SHADOW\n',
  }, async (dir) => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.deepEqual(result.configDirPaths, []);
    assert.equal(result.hostConfigKeys.has('contexa.security.zerotrust.mode'), false);
  });
});

test('detector: users or OAuth2 of the application\'s own (F-50)', async () => {
  const security = "plugins { id 'org.springframework.boot' version '3.5.4' }\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n  implementation 'org.springframework.boot:spring-boot-starter-security'\n";
  const chain = 'package a;\n@Configuration class S {\n  @Bean SecurityFilterChain c(HttpSecurity http) throws Exception { return http.httpBasic(Customizer.withDefaults()).build(); }\n}\n';
  await withProject({ 'build.gradle': `${security}}\n`, 'src/main/java/a/S.java': chain }, async dir => {
    const result = await detectSpringProject(dir, { probeDocker: false });
    assert.equal(result.hasHostSecurityFilterChain, true);
    assert.equal(result.hostDefinesUsers, false);
    assert.equal(result.hostSecurityAlternative, null);
  });
  await withProject({
    'build.gradle': `${security}}\n`,
    'src/main/java/a/S.java': chain.replace('class S {', 'class S {\n  @Bean UserDetailsService users() { return null; }'),
  }, async dir => {
    assert.equal((await detectSpringProject(dir, { probeDocker: false })).hostDefinesUsers, true);
  });
  await withProject({
    'build.gradle': `${security}  implementation 'org.springframework.boot:spring-boot-starter-oauth2-resource-server'\n}\n`,
    'src/main/java/a/S.java': chain,
  }, async dir => {
    assert.equal((await detectSpringProject(dir, { probeDocker: false })).hostSecurityAlternative,
      'org.springframework.boot:spring-boot-starter-oauth2-resource-server');
  });
});
