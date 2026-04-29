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
    // True iff a Java source file in src/main/java references @EnableAISecurity
    // (or its FQN). Only when this is true should the CLI add the Spring AI
    // ChatModel starter and the pgvector vector store - the contexa platform
    // creates those beans only when the annotation is present, and adding the
    // dependencies preemptively causes PgVector bean instantiation errors in
    // applications that only depend on spring-boot-starter-contexa without
    // declaring the annotation.
    hasEnableAiSecurity: false,
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
        // Match include 'module-name' (Groovy) or include("module-name") (Kotlin DSL).
        // Skip commented-out occurrences: a previous version matched
        //   // include 'this-module'
        // anywhere in the file, which led to false positives where init
        // skipped the dependency add even though the module had been
        // commented out of the parent settings.gradle. We strip block
        // comments first and then strip line comments per line before
        // applying the match so both forms are ignored.
        const cleaned = settingsContent.replace(/\/\*[\s\S]*?\*\//g, '');
        const includeRegex = new RegExp(
          `\\binclude[\\s(]*['"]:?${escapeRegex(moduleName)}['"]`
        );
        const isIncluded = cleaned.split('\n').some(line => {
          const noLineComment = line.replace(/\/\/.*$/, '');
          return includeRegex.test(noLineComment);
        });
        if (isIncluded) {
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

  // Detect @EnableAISecurity in src/main/java to decide whether vector/
  // ai-starter dependencies are required. Recursive shallow scan capped at
  // ~200 files to keep init fast on big repos.
  const javaRoot = path.join(dir, 'src/main/java');
  if (await fs.pathExists(javaRoot)) {
    result.hasEnableAiSecurity = await scanForAnnotation(javaRoot,
      /@EnableAISecurity\b|io\.contexa\.[\w.]*EnableAISecurity\b/);
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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function firstExisting(paths) {
  for (const p of paths) {
    if (await fs.pathExists(p)) return p;
  }
  return null;
}

// Walk src/main/java looking for the first Java file matching `regex`.
// Capped at MAX_FILES so init stays snappy on big monorepos. Returns true on
// the first match, false if no match within the cap.
async function scanForAnnotation(rootDir, regex) {
  const MAX_FILES = 250;
  const queue = [rootDir];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_FILES) {
    const cur = queue.shift();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        queue.push(full);
      } else if (e.isFile() && e.name.endsWith('.java')) {
        scanned++;
        try {
          const text = await fs.readFile(full, 'utf8');
          if (regex.test(text)) return true;
        } catch {}
        if (scanned >= MAX_FILES) break;
      }
    }
  }
  return false;
}

module.exports = { detectSpringProject };
