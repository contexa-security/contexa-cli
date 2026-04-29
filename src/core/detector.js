'use strict';

const fs = require('fs-extra');
const path = require('path');

const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';

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
    appPropertiesPath: null,
    hasDocker: false,
    gradleRootDir: null,
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
    result.hasContexta = pom.includes(CONTEXA_ARTIFACT_ID);
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
    result.hasContexta = gradle.includes(CONTEXA_ARTIFACT_ID);
  }

  // Resolve a project name for Gradle: settings.gradle's rootProject.name takes
  // precedence; otherwise fall back to the directory basename. Maven users get
  // the artifactId already, so we only run this branch for Gradle.
  if (result.buildTool === 'gradle' && !result.projectName) {
    const settingsLocal = await firstExisting([
      path.join(dir, 'settings.gradle'),
      path.join(dir, 'settings.gradle.kts'),
    ]);
    if (settingsLocal) {
      const content = await fs.readFile(settingsLocal, 'utf8');
      const m = content.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
      if (m) result.projectName = m[1];
    }
    if (!result.projectName) result.projectName = path.basename(dir);
  }

  // Multi-module Gradle: walk up to find a parent settings.gradle that includes
  // this directory. Common in mono-repos that share a root with subprojects { }
  // dependency injection. Without this check, detector reports hasContexta=false
  // even when the parent's subprojects block already adds the starter, and init
  // would then add a redundant per-module dependency line.
  if (result.buildTool === 'gradle') {
    const moduleName = path.basename(dir);
    let cur = path.resolve(dir, '..');
    for (let depth = 0; depth < 4; depth++) {
      const parentSettings = await firstExisting([
        path.join(cur, 'settings.gradle'),
        path.join(cur, 'settings.gradle.kts'),
      ]);
      if (parentSettings) {
        const settingsContent = await fs.readFile(parentSettings, 'utf8');
        // Match include 'module-name' (Groovy) or include("module-name") (Kotlin DSL)
        const includeRegex = new RegExp(
          `include[\\s(]*['"]:?${moduleName}['"]`
        );
        if (includeRegex.test(settingsContent)) {
          result.gradleRootDir = cur;
          const rootBuild = await firstExisting([
            path.join(cur, 'build.gradle'),
            path.join(cur, 'build.gradle.kts'),
          ]);
          if (rootBuild) {
            const rb = await fs.readFile(rootBuild, 'utf8');
            if (rb.includes(CONTEXA_ARTIFACT_ID)) result.hasContexta = true;
            if (rb.includes('spring-security') ||
                rb.includes('spring-boot-starter-security')) {
              result.hasSpringSecurityCore = true;
            }
          }
          break;
        }
      }
      const next = path.resolve(cur, '..');
      if (next === cur) break;
      cur = next;
    }
  }

  // Track application.yml and application.properties independently so callers
  // can warn the operator when both exist - Spring loads one and silently
  // shadows the other depending on classpath order.
  const ymlPath = path.join(dir, 'src/main/resources/application.yml');
  const propsPath = path.join(dir, 'src/main/resources/application.properties');
  if (await fs.pathExists(ymlPath)) result.appYmlPath = ymlPath;
  if (await fs.pathExists(propsPath)) result.appPropertiesPath = propsPath;

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

async function firstExisting(paths) {
  for (const p of paths) {
    if (await fs.pathExists(p)) return p;
  }
  return null;
}

module.exports = { detectSpringProject };
