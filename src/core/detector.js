'use strict';

const fs = require('fs-extra');
const path = require('path');

async function detectSpringProject(dir = process.cwd()) {
  const result = {
    isSpring: false,
    buildTool: null,
    buildFilePath: null,
    hasSpringBoot: false,
    hasSpringSecurityCore: false,
    hasContexta: false,
    projectName: null,
    appYmlPath: null,
    hasDocker: false,
  };

  // Maven detection
  const pomPath = path.join(dir, 'pom.xml');
  if (await fs.pathExists(pomPath)) {
    result.buildTool = 'maven';
    result.buildFilePath = pomPath;
    result.isSpring = true;
    const pom = await fs.readFile(pomPath, 'utf8');
    result.hasSpringBoot = pom.includes('spring-boot');
    result.hasSpringSecurityCore = pom.includes('spring-security')
        || pom.includes('spring-boot-starter-security')
        || pom.includes('spring-security-web');
    result.hasContexta = pom.includes('spring-boot-starter-contexa');
    // Strip <parent>...</parent> first so we don't accidentally match the parent's artifactId.
    const projectPom = pom.replace(/<parent>[\s\S]*?<\/parent>/, '');
    const m = projectPom.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (m) result.projectName = m[1];
  }

  // Gradle detection (build.gradle and build.gradle.kts)
  const gradlePath = path.join(dir, 'build.gradle');
  const gradleKtsPath = path.join(dir, 'build.gradle.kts');
  const actualGradlePath = await fs.pathExists(gradlePath) ? gradlePath
      : await fs.pathExists(gradleKtsPath) ? gradleKtsPath : null;

  if (!result.isSpring && actualGradlePath) {
    result.buildTool = 'gradle';
    result.buildFilePath = actualGradlePath;
    result.isSpring = true;
    const gradle = await fs.readFile(actualGradlePath, 'utf8');
    result.hasSpringBoot = gradle.includes('spring-boot');
    result.hasSpringSecurityCore = gradle.includes('spring-security')
        || gradle.includes('spring-boot-starter-security');
    result.hasContexta = gradle.includes('spring-boot-starter-contexa');
  }

  // application.yml or application.properties
  const ymlPath = path.join(dir, 'src/main/resources/application.yml');
  const propsPath = path.join(dir, 'src/main/resources/application.properties');
  if (await fs.pathExists(ymlPath)) {
    result.appYmlPath = ymlPath;
  } else if (await fs.pathExists(propsPath)) {
    result.appYmlPath = propsPath;
  }

  // Docker detection
  try {
    const { execSync } = require('child_process');
    execSync('docker --version', { stdio: 'ignore' });
    result.hasDocker = true;
  } catch {
    result.hasDocker = false;
  }

  return result;
}

module.exports = { detectSpringProject };
