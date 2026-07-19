'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { injectMavenDep, injectGradleDep } = require('../src/core/injector/build');

function run(command, args, cwd, timeout = 120000) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, shell: false });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${command} timed out in ${cwd}`);
  assert.equal(result.status, 0, `${command} failed in ${cwd}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}\n${result.stderr}`;
}

function starterCount(content) {
  return (content.match(/spring-boot-starter-contexa/g) || []).length;
}

function mavenPom(body) {
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.5.4</version><relativePath/></parent>
  <groupId>example</groupId><artifactId>fixture</artifactId><version>1.0.0</version>
${body}
</project>
`;
}

async function verifyMavenFixtures(root, evidence) {
  const fixtures = {
    dependencies: mavenPom('  <dependencies>\n  </dependencies>'),
    absent: mavenPom(''),
    dependencyManagement: mavenPom(`  <dependencyManagement><dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>3.5.4</version><type>pom</type><scope>import</scope></dependency>
  </dependencies></dependencyManagement>`),
  };
  for (const [name, pom] of Object.entries(fixtures)) {
    const directory = path.join(root, `maven-${name}`);
    const pomPath = path.join(directory, 'pom.xml');
    await fs.outputFile(pomPath, pom, 'utf8');
    assert.equal(await injectMavenDep(pomPath), true);
    assert.equal(starterCount(await fs.readFile(pomPath, 'utf8')), 1);
    const output = path.join(directory, 'effective-pom.xml');
    const log = run('mvn', ['-q', '-f', pomPath, 'help:effective-pom', `-Doutput=${output}`], directory);
    assert.ok((await fs.readFile(output, 'utf8')).includes('<artifactId>spring-boot-starter-contexa</artifactId>'));
    await fs.writeFile(path.join(evidence, `maven-${name}.log`), log, 'utf8');
  }
}

async function createDummyStarter(root) {
  const artifact = path.join(root, 'repo', 'ai', 'ctxa', 'spring-boot-starter-contexa', '0.1.0-SNAPSHOT');
  const empty = path.join(root, 'empty-jar');
  await fs.ensureDir(empty);
  await fs.ensureDir(artifact);
  run('jar', ['--create', '--file', path.join(artifact, 'spring-boot-starter-contexa-0.1.0-SNAPSHOT.jar'), '-C', empty, '.'], root);
  await fs.writeFile(path.join(artifact, 'spring-boot-starter-contexa-0.1.0-SNAPSHOT.pom'),
    '<project><modelVersion>4.0.0</modelVersion><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0-SNAPSHOT</version></project>\n', 'utf8');
  return path.join(root, 'repo').split(path.sep).join('/');
}

async function writeJavaSource(directory) {
  await fs.outputFile(path.join(directory, 'src/main/java/example/Fixture.java'),
    'package example; public class Fixture {}\n', 'utf8');
}

async function verifyGradleFixture(root, evidence, name, fileName, content) {
  const directory = path.join(root, `gradle-${name}`);
  const buildPath = path.join(directory, fileName);
  await fs.outputFile(buildPath, content, 'utf8');
  await fs.outputFile(path.join(directory, fileName.endsWith('.kts') ? 'settings.gradle.kts' : 'settings.gradle'),
    fileName.endsWith('.kts') ? 'rootProject.name = "fixture"\n' : "rootProject.name = 'fixture'\n", 'utf8');
  await writeJavaSource(directory);
  assert.equal(await injectGradleDep(buildPath), true);
  assert.equal(starterCount(await fs.readFile(buildPath, 'utf8')), 1);
  const command = process.env.GRADLE_CMD || 'gradle';
  const log = run(command, ['--no-daemon', '-p', directory, 'compileJava'], directory);
  await fs.writeFile(path.join(evidence, `gradle-${name}.log`), log, 'utf8');
}

async function verifyGradleFixtures(root, evidence) {
  const repository = await createDummyStarter(root);
  await verifyGradleFixture(root, evidence, 'groovy', 'build.gradle', `plugins { id 'java' }
repositories { maven { url = uri('${repository}') } }
dependencies { }
`);
  await verifyGradleFixture(root, evidence, 'kotlin', 'build.gradle.kts', `plugins { java }
repositories { maven { url = uri("${repository}") } }
dependencies { }
`);
  await verifyGradleFixture(root, evidence, 'buildscript', 'build.gradle', `buildscript { dependencies { classpath files('placeholder.jar') } }
plugins { id 'java' }
repositories { maven { url = uri('${repository}') } }
dependencies { }
`);
  const multi = path.join(root, 'gradle-multi-module');
  await fs.outputFile(path.join(multi, 'settings.gradle'), "rootProject.name = 'root'\ninclude 'app'\n", 'utf8');
  await fs.outputFile(path.join(multi, 'build.gradle'), "plugins { id 'base' }\n", 'utf8');
  const appBuild = path.join(multi, 'app', 'build.gradle');
  await fs.outputFile(appBuild, `plugins { id 'java' }
repositories { maven { url = uri('${repository}') } }
dependencies { }
`, 'utf8');
  await writeJavaSource(path.join(multi, 'app'));
  assert.equal(await injectGradleDep(appBuild), true);
  assert.equal(starterCount(await fs.readFile(path.join(multi, 'build.gradle'), 'utf8')), 0);
  assert.equal(starterCount(await fs.readFile(appBuild, 'utf8')), 1);
  const command = process.env.GRADLE_CMD || 'gradle';
  const log = run(command, ['--no-daemon', '-p', multi, ':app:compileJava'], multi);
  await fs.writeFile(path.join(evidence, 'gradle-multi-module.log'), log, 'utf8');
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-build-models-'));
  const evidence = process.env.CONTEXA_BUILD_MODEL_DIR
    ? path.resolve(process.env.CONTEXA_BUILD_MODEL_DIR)
    : path.join(root, 'evidence');
  await fs.ensureDir(evidence);
  try {
    await verifyMavenFixtures(root, evidence);
    await verifyGradleFixtures(root, evidence);
    console.log(`Maven and Gradle build models passed. Evidence: ${evidence}`);
  } finally {
    const evidenceRelativeToFixture = path.relative(root, evidence);
    const evidenceInsideFixture = evidenceRelativeToFixture === ''
      || (!evidenceRelativeToFixture.startsWith('..') && !path.isAbsolute(evidenceRelativeToFixture));
    if (!process.env.CONTEXA_BUILD_MODEL_DIR || !evidenceInsideFixture) await fs.remove(root);
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
