'use strict';

const fs = require('fs-extra');
const path = require('path');
const {
  parseMavenModel,
  parseGradleModel,
  gradleProjectName: readGradleProjectName,
  gradleModuleDirectories,
  hasCoordinate,
} = require('./build-model');

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';

async function detectSpringProject(dir = process.cwd(), opts = {}) {
  const rootDir = path.resolve(dir);
  const result = {
    isSpring: false, buildTool: null, buildFilePath: null, hasSpringBoot: false,
    hasSpringSecurityCore: false, hasContexta: false, contextaVersion: null, projectName: null,
    projectDir: rootDir, appYmlPath: null, appPropertiesPath: null,
    applicationConfigPaths: [], mainApplicationCandidates: [], hasDocker: false,
    gradleRootDir: null, hasEnableAiSecurity: false, hasHostSecurityFilterChain: false,
    ambiguousModules: [],
  };

  const localCandidate = await readBuildCandidate(rootDir);
  const moduleCandidates = await discoverModuleCandidates(rootDir);
  const allCandidates = [localCandidate, ...moduleCandidates].filter(Boolean);
  const distinctCandidates = [...new Map(allCandidates.map(item => [path.resolve(item.dir), item])).values()];
  const springModules = distinctCandidates.filter(item => item.hasSpringBoot);
  let candidate = null;
  if (springModules.length === 1) candidate = springModules[0];
  else if (springModules.length > 1) {
    result.ambiguousModules = springModules.map(item => item.dir).sort();
    return finishDetection(result, rootDir, opts);
  } else if (localCandidate) candidate = localCandidate;

  if (candidate) {
    const inheritedGradle = candidate.buildTool === 'gradle'
      ? await inheritedGradleMetadata(candidate.dir)
      : null;
    Object.assign(result, {
      buildTool: candidate.buildTool,
      buildFilePath: candidate.buildFilePath,
      hasSpringBoot: candidate.hasSpringBoot,
      isSpring: candidate.hasSpringBoot,
      hasSpringSecurityCore: candidate.hasSpringSecurityCore || !!inheritedGradle?.hasSpringSecurityCore,
      hasContexta: candidate.hasContexta || !!inheritedGradle?.hasContexta,
      contextaVersion: candidate.contextaVersion || inheritedGradle?.contextaVersion || null,
      projectName: candidate.projectName,
      projectDir: candidate.dir,
    });
    if (inheritedGradle) result.gradleRootDir = inheritedGradle.rootDir;
    else if (candidate.buildTool === 'gradle' && candidate.dir !== rootDir) result.gradleRootDir = rootDir;
  }

  await inventoryConfiguration(result, result.projectDir);
  await inventoryApplicationSources(result, result.projectDir);
  return finishDetection(result, rootDir, opts);
}

async function inheritedGradleMetadata(moduleDir) {
  let parentDir = path.dirname(moduleDir);
  while (parentDir !== moduleDir) {
    const settingsPath = await firstExisting([
      path.join(parentDir, 'settings.gradle'),
      path.join(parentDir, 'settings.gradle.kts'),
    ]);
    if (settingsPath) {
      const settings = await fs.readFile(settingsPath, 'utf8');
      const includedDirs = gradleIncludedModuleDirs(parentDir, settings);
      const normalizedModuleDir = path.resolve(moduleDir);
      if (includedDirs.some(dir => path.resolve(dir) === normalizedModuleDir)) {
        const buildPath = await firstExisting([
          path.join(parentDir, 'build.gradle'),
          path.join(parentDir, 'build.gradle.kts'),
        ]);
        if (!buildPath) return { rootDir: parentDir, hasContexta: false, contextaVersion: null, hasSpringSecurityCore: false };
        const build = await fs.readFile(buildPath, 'utf8');
        const model = parseGradleModel(build);
        const inheritedCoordinates = model.dependencyBlocks
          .filter(item => item.coordinates.some(coordinate =>
            coordinate.scope.includes('allprojects') || coordinate.scope.includes('subprojects')))
          .flatMap(item => item.coordinates);
        const contextaDependency = inheritedCoordinates.find(coordinate =>
          coordinate.group === CONTEXA_GROUP_ID && coordinate.artifact === CONTEXA_ARTIFACT_ID);
        return {
          rootDir: parentDir,
          hasContexta: !!contextaDependency,
          contextaVersion: contextaDependency?.version || null,
          hasSpringSecurityCore: inheritedCoordinates.some(coordinate =>
            (coordinate.group === 'org.springframework.boot'
              && coordinate.artifact === 'spring-boot-starter-security')
            || (coordinate.group === 'org.springframework.security'
              && /^spring-security-(?:core|web|config)$/.test(coordinate.artifact))),
        };
      }
    }
    moduleDir = parentDir;
    parentDir = path.dirname(parentDir);
  }
  return null;
}

function gradleIncludedModuleDirs(rootDir, settings) {
  return gradleModuleDirectories(rootDir, settings);
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
    const source = await fs.readFile(pomPath, 'utf8');
    const model = parseMavenModel(source);
    const bootParent = model.parent
      && model.parent.group === 'org.springframework.boot'
      && model.parent.artifact === 'spring-boot-starter-parent';
    const bootPlugin = hasCoordinate(model.plugins,
      'org.springframework.boot', 'spring-boot-maven-plugin');
    const bootDependency = model.dependencies.some(coordinate =>
      coordinate.group === 'org.springframework.boot'
      && /^spring-boot-starter(?:-.+)?$/.test(coordinate.artifact));
    const hasSpringBoot = !!(bootDependency || bootPlugin
      || (model.packaging !== 'pom' && bootParent));
    const contextaDependency = model.dependencies.find(coordinate =>
      coordinate.group === CONTEXA_GROUP_ID && coordinate.artifact === CONTEXA_ARTIFACT_ID);
    return {
      dir, buildTool: 'maven', buildFilePath: pomPath, hasSpringBoot,
      hasSpringSecurityCore: model.dependencies.some(coordinate =>
        (coordinate.group === 'org.springframework.boot'
          && coordinate.artifact === 'spring-boot-starter-security')
        || (coordinate.group === 'org.springframework.security'
          && /^spring-security-(?:core|web|config)$/.test(coordinate.artifact))),
      hasContexta: !!contextaDependency,
      contextaVersion: contextaDependency?.version || null,
      projectName: model.projectName,
      moduleDirs: model.modules.map(moduleName => path.resolve(dir, moduleName)),
    };
  }

  const gradlePath = await firstExisting([path.join(dir, 'build.gradle'), path.join(dir, 'build.gradle.kts')]);
  if (!gradlePath) return null;
  const source = await fs.readFile(gradlePath, 'utf8');
  const model = parseGradleModel(source);
  const hasSpringBoot = model.pluginIds.includes('org.springframework.boot')
    || model.dependencies.some(coordinate => coordinate.group === 'org.springframework.boot'
      && /^spring-boot-starter(?:-.+)?$/.test(coordinate.artifact));
  const contextaDependency = model.dependencies.find(coordinate =>
    coordinate.group === CONTEXA_GROUP_ID && coordinate.artifact === CONTEXA_ARTIFACT_ID);
  return {
    dir, buildTool: 'gradle', buildFilePath: gradlePath, hasSpringBoot,
    hasSpringSecurityCore: model.dependencies.some(coordinate =>
      (coordinate.group === 'org.springframework.boot'
        && coordinate.artifact === 'spring-boot-starter-security')
      || (coordinate.group === 'org.springframework.security'
        && /^spring-security-(?:core|web|config)$/.test(coordinate.artifact))),
    hasContexta: !!contextaDependency,
    contextaVersion: contextaDependency?.version || null,
    projectName: await gradleProjectName(dir),
    moduleDirs: await gradleChildModuleDirs(dir),
  };
}

async function discoverModuleCandidates(rootDir) {
  const moduleDirs = new Set();
  const visited = new Set([path.resolve(rootDir)]);
  const rootCandidate = await readBuildCandidate(rootDir);
  for (const moduleDir of (rootCandidate && rootCandidate.moduleDirs) || []) moduleDirs.add(moduleDir);
  const settingsPath = await firstExisting([path.join(rootDir, 'settings.gradle'), path.join(rootDir, 'settings.gradle.kts')]);
  if (settingsPath) {
    const settings = await fs.readFile(settingsPath, 'utf8');
    for (const moduleDir of gradleIncludedModuleDirs(rootDir, settings)) moduleDirs.add(moduleDir);
  }
  const candidates = [];
  const queue = [...moduleDirs];
  while (queue.length > 0) {
    const moduleDir = path.resolve(queue.shift());
    if (visited.has(moduleDir)) continue;
    if (moduleDir !== rootDir && !moduleDir.startsWith(rootDir + path.sep)) {
      throw new Error(`Build module escapes the selected project root: ${moduleDir}`);
    }
    visited.add(moduleDir);
    const candidate = await readBuildCandidate(moduleDir);
    if (!candidate) continue;
    candidates.push(candidate);
    for (const childDir of candidate.moduleDirs || []) queue.push(childDir);
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

async function gradleProjectName(dir) {
  const settingsPath = await firstExisting([path.join(dir, 'settings.gradle'), path.join(dir, 'settings.gradle.kts')]);
  if (!settingsPath) return path.basename(dir);
  const name = readGradleProjectName(await fs.readFile(settingsPath, 'utf8'));
  return name || path.basename(dir);
}
async function gradleChildModuleDirs(dir) {
  const settingsPath = await firstExisting([
    path.join(dir, 'settings.gradle'),
    path.join(dir, 'settings.gradle.kts'),
  ]);
  if (!settingsPath) return [];
  return gradleIncludedModuleDirs(dir, await fs.readFile(settingsPath, 'utf8'));
}
async function firstExisting(paths) {
  for (const file of paths) if (await fs.pathExists(file)) return file;
  return null;
}
module.exports = { detectSpringProject };
