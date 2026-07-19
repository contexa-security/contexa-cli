'use strict';

const fs = require('fs-extra');
const path = require('path');

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';

async function detectSpringProject(dir = process.cwd(), opts = {}) {
  const rootDir = path.resolve(dir);
  const result = {
    isSpring: false, buildTool: null, buildFilePath: null, hasSpringBoot: false,
    hasSpringSecurityCore: false, hasContexta: false, projectName: null,
    projectDir: rootDir, appYmlPath: null, appPropertiesPath: null,
    applicationConfigPaths: [], mainApplicationCandidates: [], hasDocker: false,
    gradleRootDir: null, hasEnableAiSecurity: false, hasHostSecurityFilterChain: false,
    ambiguousModules: [],
  };

  const localCandidate = await readBuildCandidate(rootDir);
  let candidate = localCandidate && localCandidate.hasSpringBoot ? localCandidate : null;
  if (!candidate) {
    const springModules = (await discoverModuleCandidates(rootDir)).filter(item => item.hasSpringBoot);
    if (springModules.length === 1) candidate = springModules[0];
    else if (springModules.length > 1) {
      result.ambiguousModules = springModules.map(item => item.dir);
      return finishDetection(result, rootDir, opts);
    } else if (localCandidate) candidate = localCandidate;
  }

  if (candidate) {
    Object.assign(result, {
      buildTool: candidate.buildTool,
      buildFilePath: candidate.buildFilePath,
      hasSpringBoot: candidate.hasSpringBoot,
      isSpring: candidate.hasSpringBoot,
      hasSpringSecurityCore: candidate.hasSpringSecurityCore,
      hasContexta: candidate.hasContexta,
      projectName: candidate.projectName,
      projectDir: candidate.dir,
    });
    if (candidate.buildTool === 'gradle' && candidate.dir !== rootDir) result.gradleRootDir = rootDir;
  }

  await inventoryConfiguration(result, result.projectDir);
  await inventoryApplicationSources(result, result.projectDir);
  return finishDetection(result, rootDir, opts);
}

async function finishDetection(result, rootDir, opts) {
  if (!result.projectName && result.projectDir) result.projectName = path.basename(result.projectDir);
  if (opts.probeDocker === true) {
    const { isDockerCliInstalled } = require('./docker');
    result.hasDocker = isDockerCliInstalled();
  }
  result.rootDir = rootDir;
  return result;
}

async function readBuildCandidate(dir) {
  const pomPath = path.join(dir, 'pom.xml');
  if (await fs.pathExists(pomPath)) {
    const clean = (await fs.readFile(pomPath, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
    const hasSpringBoot = mavenCoordinateExists(clean, 'org.springframework.boot', 'spring-boot-starter-parent')
      || mavenCoordinateExists(clean, 'org.springframework.boot', 'spring-boot-maven-plugin')
      || /<groupId>\s*org\.springframework\.boot\s*<\/groupId>[\s\S]{0,400}<artifactId>\s*spring-boot-starter(?:-[^<]+)?\s*<\/artifactId>/.test(clean);
    return {
      dir, buildTool: 'maven', buildFilePath: pomPath, hasSpringBoot,
      hasSpringSecurityCore: mavenArtifactExists(clean, 'spring-boot-starter-security')
        || /<artifactId>\s*spring-security-(?:core|web|config)\s*<\/artifactId>/.test(clean),
      hasContexta: mavenCoordinateExists(clean, CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID),
      projectName: mavenProjectArtifactId(clean),
    };
  }

  const gradlePath = await firstExisting([path.join(dir, 'build.gradle'), path.join(dir, 'build.gradle.kts')]);
  if (!gradlePath) return null;
  const clean = stripCodeComments(await fs.readFile(gradlePath, 'utf8'));
  const hasSpringBoot = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]/.test(clean)
    || /\bapply\s+plugin\s*:\s*['"]org\.springframework\.boot['"]/.test(clean)
    || /['"]org\.springframework\.boot:spring-boot-starter(?:-[^:'"]+)?(?::[^'"]+)?['"]/.test(clean);
  return {
    dir, buildTool: 'gradle', buildFilePath: gradlePath, hasSpringBoot,
    hasSpringSecurityCore: /['"]org\.springframework\.boot:spring-boot-starter-security(?::[^'"]+)?['"]/.test(clean)
      || /['"]org\.springframework\.security:spring-security-(?:core|web|config)(?::[^'"]+)?['"]/.test(clean),
    hasContexta: new RegExp(`['"]${escapeRegex(CONTEXA_GROUP_ID)}:${escapeRegex(CONTEXA_ARTIFACT_ID)}(?::[^'"]+)?['"]`).test(clean),
    projectName: await gradleProjectName(dir),
  };
}

async function discoverModuleCandidates(rootDir) {
  const moduleDirs = new Set();
  const pomPath = path.join(rootDir, 'pom.xml');
  if (await fs.pathExists(pomPath)) {
    const pom = (await fs.readFile(pomPath, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
    for (const match of pom.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) moduleDirs.add(path.resolve(rootDir, match[1].trim()));
  }
  const settingsPath = await firstExisting([path.join(rootDir, 'settings.gradle'), path.join(rootDir, 'settings.gradle.kts')]);
  if (settingsPath) {
    const settings = stripCodeComments(await fs.readFile(settingsPath, 'utf8'));
    for (const line of settings.split(/\r?\n/).filter(value => /\binclude\b/.test(value))) {
      for (const match of line.matchAll(/['"](:?[^'"]+)['"]/g)) {
        moduleDirs.add(path.resolve(rootDir, match[1].replace(/^:/, '').replace(/:/g, path.sep)));
      }
    }
  }
  const candidates = [];
  for (const moduleDir of moduleDirs) {
    const candidate = await readBuildCandidate(moduleDir);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

async function inventoryConfiguration(result, projectDir) {
  const resourcesDir = path.join(projectDir, 'src/main/resources');
  if (!await fs.pathExists(resourcesDir)) return;
  let entries;
  try { entries = await fs.readdir(resourcesDir, { withFileTypes: true }); } catch { return; }
  result.applicationConfigPaths = entries
    .filter(entry => entry.isFile() && /^(?:application|bootstrap)(?:-[^.]+)?\.(?:yml|yaml|properties)$/.test(entry.name))
    .map(entry => path.join(resourcesDir, entry.name)).sort();
  result.appYmlPath = result.applicationConfigPaths.find(file => /application\.yml$/.test(file))
    || result.applicationConfigPaths.find(file => /application\.yaml$/.test(file)) || null;
  result.appPropertiesPath = result.applicationConfigPaths.find(file => /application\.properties$/.test(file)) || null;
}

async function inventoryApplicationSources(result, projectDir) {
  const roots = [
    { dir: path.join(projectDir, 'src/main/java'), extension: '.java' },
    { dir: path.join(projectDir, 'src/main/kotlin'), extension: '.kt' },
  ];
  for (const root of roots) {
    if (!await fs.pathExists(root.dir)) continue;
    for (const file of await listSourceFiles(root.dir, root.extension)) {
      let source;
      try { source = await fs.readFile(file, 'utf8'); } catch { continue; }
      const code = stripCommentsAndStrings(source);
      if (/@SpringBootApplication\b/.test(code)
          || /@org\.springframework\.boot\.autoconfigure\.SpringBootApplication\b/.test(code)) {
        result.mainApplicationCandidates.push(file);
      }
      if (/@EnableAISecurity\b/.test(code)
          || /@io\.contexa\.[\w.]*EnableAISecurity\b/.test(code)) {
        result.hasEnableAiSecurity = true;
      }
      const javaSecurityChain = /@Bean(?:\s*\([^)]*\))?[\s\S]{0,500}?\bSecurityFilterChain\s+\w+\s*\(/.test(code);
      const kotlinSecurityChain = /@Bean(?:\s*\([^)]*\))?[\s\S]{0,500}?\bfun\s+\w+\s*\([^)]*\)\s*:\s*SecurityFilterChain\b/.test(code);
      if (javaSecurityChain || kotlinSecurityChain) {
        result.hasHostSecurityFilterChain = true;
      }
    }
  }
}

async function listSourceFiles(rootDir, extension) {
  const files = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(full);
    }
  }
  return files;
}

function stripCodeComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

function stripCommentsAndStrings(source) {
  let output = '', state = 'code', quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (state === 'line') { if (ch === '\n') { state = 'code'; output += '\n'; } else output += ' '; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { output += '  '; i++; state = 'code'; }
      else output += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'string') {
      if (ch === '\\') { output += '  '; i++; continue; }
      if (ch === quote) { state = 'code'; output += ' '; } else output += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '/' && next === '/') { output += '  '; i++; state = 'line'; continue; }
    if (ch === '/' && next === '*') { output += '  '; i++; state = 'block'; continue; }
    if (ch === '"' || ch === "'") { quote = ch; state = 'string'; output += ' '; continue; }
    output += ch;
  }
  return output;
}

function mavenCoordinateExists(pom, groupId, artifactId) {
  const blocks = pom.match(/<(?:dependency|plugin|parent)>[\s\S]*?<\/(?:dependency|plugin|parent)>/g) || [];
  return blocks.some(block => new RegExp(`<groupId>\\s*${escapeRegex(groupId)}\\s*<\\/groupId>`).test(block)
    && new RegExp(`<artifactId>\\s*${escapeRegex(artifactId)}\\s*<\\/artifactId>`).test(block));
}
function mavenArtifactExists(pom, artifactId) {
  return new RegExp(`<artifactId>\\s*${escapeRegex(artifactId)}\\s*<\\/artifactId>`).test(pom);
}
function mavenProjectArtifactId(pom) {
  const match = pom.replace(/<parent>[\s\S]*?<\/parent>/, '').match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/);
  return match ? match[1].trim() : null;
}
async function gradleProjectName(dir) {
  const settingsPath = await firstExisting([path.join(dir, 'settings.gradle'), path.join(dir, 'settings.gradle.kts')]);
  if (!settingsPath) return path.basename(dir);
  const match = stripCodeComments(await fs.readFile(settingsPath, 'utf8')).match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : path.basename(dir);
}
async function firstExisting(paths) {
  for (const file of paths) if (await fs.pathExists(file)) return file;
  return null;
}
function escapeRegex(value) {
  return String(value).replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
}

module.exports = { detectSpringProject };
