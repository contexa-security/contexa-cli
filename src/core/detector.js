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

const { isContexaSettings } = require('./injector/config');

const CONTEXA_GROUP_ID = 'ai.ctxa';
const CONTEXA_ARTIFACT_ID = 'spring-boot-starter-contexa';

async function detectSpringProject(dir = process.cwd(), opts = {}) {
  const rootDir = path.resolve(dir);
  const result = {
    isSpring: false, buildTool: null, buildFilePath: null, hasSpringBoot: false,
    hasSpringSecurityCore: false, hasContexta: false, contextaVersion: null, projectName: null,
    projectDir: rootDir, appYmlPath: null, appPropertiesPath: null,
    applicationConfigPaths: [], configDirPaths: [], mainApplicationCandidates: [], hasDocker: false,
    gradleRootDir: null, hasEnableAiSecurity: false, hasHostSecurityFilterChain: false,
    hostDefinesUsers: false, hostSecurityAlternative: null,
    ambiguousModules: [], noApplication: null, contexaSource: false, springBootVersion: null, springBootVersionSource: null,
    hostOwnsDatabase: false, hostDatabaseReason: null, hostConfigKeys: new Set(),
  };

  const localCandidate = await readBuildCandidate(rootDir);
  const moduleCandidates = await discoverModuleCandidates(rootDir);
  const allCandidates = [localCandidate, ...moduleCandidates].filter(Boolean);
  const distinctCandidates = [...new Map(allCandidates.map(item => [path.resolve(item.dir), item])).values()];
  let springModules = distinctCandidates.filter(item => item.hasSpringBoot);
  // The source of Contexa itself is a build with a module of the starter's own name. Contexa is not attached to
  // Contexa, whatever its modules look like.
  if (distinctCandidates.some(item => path.basename(item.dir) === CONTEXA_ARTIFACT_ID)) {
    result.noApplication = springModules.map(item => item.dir).sort();
    result.contexaSource = true;
    return finishDetection(result, rootDir, opts);
  }
  // Which of several modules is an application is told by a class of its own that starts one, in a module whose
  // build still makes a runnable jar. A library module applies the Spring Boot plugin (with bootJar turned off) or
  // depends on starters all the same, may keep a start class that a project generator wrote, and a multi-module root
  // often applies the plugin to every module. A build whose Spring Boot modules are all libraries has no application.
  if (springModules.length > 1) {
    const applications = [];
    for (const item of springModules) {
      if (!item.bootJarDisabled && await hasApplicationClass(item.dir)) applications.push(item);
    }
    if (applications.length === 0) {
      result.noApplication = springModules.map(item => item.dir).sort();
      return finishDetection(result, rootDir, opts);
    }
    springModules = applications;
  }
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
  if (candidate) {
    const boot = await detectSpringBootVersion(result, rootDir);
    result.springBootVersion = boot.version;
    result.springBootVersionSource = boot.source;
    const hostDatabase = await detectHostDatabase(result);
    result.hostOwnsDatabase = hostDatabase.owns;
    result.hostDatabaseReason = hostDatabase.reason;
    result.hostConfigKeys = await collectHostConfigKeys([...result.applicationConfigPaths, ...result.configDirPaths]);
    result.hostSecurityAlternative = await detectHostSecurityAlternative(result);
  }
  return finishDetection(result, rootDir, opts);
}

// --- Spring Boot version -------------------------------------------------------------------
//
// Read from the build files the way a developer would: the Boot plugin version (Gradle, also
// through gradle.properties, the version catalog, buildscript classpath or settings
// pluginManagement) or the starter parent / spring-boot-dependencies import (Maven). Unknown is
// not an error; the dependency check after the change is the final word.

const BOOT_GRADLE_PLUGIN = /id\s*\(?\s*["']org\.springframework\.boot["']\s*\)?\s*version\s*\(?\s*["']([^"']+)["']/;
const BOOT_GRADLE_CLASSPATH = /spring-boot-gradle-plugin:([^"'\s)]+)/;

async function readIfExists(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

function gradleProperty(properties, name) {
  if (!properties) return null;
  const match = properties.match(new RegExp(`^\\s*${escapeRegex(name)}\\s*[=:]\\s*(\\S+)\\s*$`, 'm'));
  return match ? match[1] : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveGradlePlaceholder(value, properties) {
  if (!value) return null;
  const placeholder = value.match(/^\$\{?([\w.-]+)\}?$/);
  if (!placeholder) return value;
  return gradleProperty(properties, placeholder[1]);
}

function catalogBootVersion(catalog) {
  if (!catalog) return null;
  const pluginLine = catalog.split(/\r?\n/).find(line => /id\s*=\s*["']org\.springframework\.boot["']/.test(line));
  if (pluginLine) {
    const literal = pluginLine.match(/version\s*=\s*["']([^"']+)["']/);
    if (literal) return literal[1];
    const ref = pluginLine.match(/version\.ref\s*=\s*["']([^"']+)["']/);
    if (ref) {
      const value = catalog.match(new RegExp(`^\\s*${escapeRegex(ref[1])}\\s*=\\s*["']([^"']+)["']`, 'm'));
      if (value) return value[1];
    }
  }
  return null;
}

function directoriesUpTo(startDir, stopDir) {
  const dirs = [];
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  for (;;) {
    dirs.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current || !(parent === stop || parent.startsWith(stop + path.sep))) break;
    current = parent;
  }
  return dirs;
}

async function detectSpringBootVersion(result, rootDir) {
  const dirs = directoriesUpTo(result.projectDir, result.gradleRootDir || rootDir);
  if (result.buildTool === 'gradle') {
    for (const dir of dirs) {
      const properties = await readIfExists(path.join(dir, 'gradle.properties'));
      const catalog = await readIfExists(path.join(dir, 'gradle', 'libs.versions.toml'));
      for (const name of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
        const source = await readIfExists(path.join(dir, name));
        if (!source) continue;
        const plugin = source.match(BOOT_GRADLE_PLUGIN);
        if (plugin) {
          const version = resolveGradlePlaceholder(plugin[1], properties);
          if (version) return { version, source: path.join(dir, name) };
        }
        const classpath = source.match(BOOT_GRADLE_CLASSPATH);
        if (classpath) {
          const version = resolveGradlePlaceholder(classpath[1], properties);
          if (version) return { version, source: path.join(dir, name) };
        }
        if (/alias\s*\(\s*libs\.plugins\.[\w.]*spring[\w.]*boot/i.test(source)) {
          const version = catalogBootVersion(catalog);
          if (version) return { version, source: path.join(dir, 'gradle', 'libs.versions.toml') };
        }
      }
    }
    return { version: null, source: null };
  }
  for (const dir of dirs) {
    const pom = await readIfExists(path.join(dir, 'pom.xml'));
    if (!pom) continue;
    const properties = {};
    const propertiesBlock = pom.match(/<properties>([\s\S]*?)<\/properties>/);
    if (propertiesBlock) {
      for (const match of propertiesBlock[1].matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) {
        properties[match[1]] = match[2].trim();
      }
    }
    const resolve = value => {
      const placeholder = value && value.match(/^\$\{([\w.-]+)\}$/);
      return placeholder ? properties[placeholder[1]] || null : value;
    };
    const parent = pom.match(/<parent>[\s\S]*?<artifactId>\s*spring-boot-starter-parent\s*<\/artifactId>[\s\S]*?<version>\s*([^<\s]+)\s*<\/version>[\s\S]*?<\/parent>/);
    if (parent && resolve(parent[1])) return { version: resolve(parent[1]), source: path.join(dir, 'pom.xml') };
    const bom = pom.match(/<artifactId>\s*spring-boot-dependencies\s*<\/artifactId>\s*<version>\s*([^<\s]+)\s*<\/version>/);
    if (bom && resolve(bom[1])) return { version: resolve(bom[1]), source: path.join(dir, 'pom.xml') };
  }
  return { version: null, source: null };
}

// --- Host database -------------------------------------------------------------------------
//
// Contexa keeps its own database. When the host application has no database of its own, the
// Contexa DataSource has to be the application DataSource as well
// (contexa.datasource.isolation.contexa-owned-application=true), otherwise Spring Boot's
// DataSource auto-configuration, pulled in through the starter, fails at startup.

const HOST_DATABASE_ARTIFACTS = [
  ['org.springframework.boot', /^spring-boot-starter-(?:data-jpa|jdbc|data-jdbc|jooq)$/],
  ['org.mybatis.spring.boot', /^mybatis-spring-boot-starter$/],
  ['com.h2database', /^h2$/],
  ['org.hsqldb', /^hsqldb$/],
  ['org.apache.derby', /^derby$/],
  ['org.flywaydb', /^flyway-core$/],
  ['org.liquibase', /^liquibase-core$/],
];

// Spring Boot does not create its default user (the password it logs at the start) when OAuth2 or
// SAML classes are on the classpath. An application whose build brings them had no default user
// before Contexa either (F-50).
const HOST_SECURITY_ALTERNATIVE_ARTIFACTS = [
  ['org.springframework.boot', /^spring-boot-starter-oauth2-(?:client|resource-server|authorization-server)$/],
  ['org.springframework.security', /^spring-security-(?:oauth2-[\w-]+|saml2-[\w-]+)$/],
];

async function detectHostSecurityAlternative(result) {
  const source = await readIfExists(result.buildFilePath);
  if (!source) return null;
  const model = result.buildTool === 'maven' ? parseMavenModel(source) : parseGradleModel(source);
  const coordinate = model.dependencies.find(item => HOST_SECURITY_ALTERNATIVE_ARTIFACTS.some(([group, artifact]) =>
    item.group === group && artifact.test(item.artifact)));
  return coordinate ? `${coordinate.group}:${coordinate.artifact}` : null;
}

async function detectHostDatabase(result) {
  const source = await readIfExists(result.buildFilePath);
  if (source) {
    const model = result.buildTool === 'maven' ? parseMavenModel(source) : parseGradleModel(source);
    const coordinate = model.dependencies.find(item => HOST_DATABASE_ARTIFACTS.some(([group, artifact]) =>
      item.group === group && artifact.test(item.artifact)));
    if (coordinate) return { owns: true, reason: `${coordinate.group}:${coordinate.artifact}` };
  }
  const keys = await collectHostConfigKeys([...result.applicationConfigPaths, ...(result.configDirPaths || [])]);
  if (keys.has('spring.datasource.url')) return { owns: true, reason: 'spring.datasource.url' };
  return { owns: false, reason: null };
}

// Leaf keys (relaxed: kebab-case, lower-case) set in the host's own application config files.
async function collectHostConfigKeys(configPaths = []) {
  const keys = new Set();
  const yaml = require('js-yaml');
  const normalize = key => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const walk = (node, prefix) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) walk(value, prefix ? `${prefix}.${key}` : key);
    } else if (prefix) {
      keys.add(normalize(prefix));
    }
  };
  for (const file of configPaths) {
    const name = path.basename(file);
    if (!/^application\.(?:yml|yaml|properties)$/.test(name)) continue;
    const text = await readIfExists(file);
    if (!text || isContexaSettings(text)) continue;
    if (name.endsWith('.properties')) {
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([^#!\s][^=:\s]*)\s*[=:]/);
        if (match) keys.add(normalize(match[1]));
      }
    } else {
      try {
        for (const document of yaml.loadAll(text)) {
          const activation = document && document.spring && document.spring.config
            && document.spring.config.activate;
          if (activation) continue;
          walk(document, '');
        }
      } catch {
        // An unreadable host file is reported by doctor; detection only needs the readable keys.
      }
    }
  }
  return keys;
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
  // `id 'org.springframework.boot' version 'x' apply false` on a multi-module root only puts the
  // plugin on the classpath; it does not make the root a Spring Boot application.
  const hasSpringBoot = model.appliedPluginIds.includes('org.springframework.boot')
    || model.dependencies.some(coordinate => coordinate.group === 'org.springframework.boot'
      && /^spring-boot-starter(?:-.+)?$/.test(coordinate.artifact));
  const contextaDependency = model.dependencies.find(coordinate =>
    coordinate.group === CONTEXA_GROUP_ID && coordinate.artifact === CONTEXA_ARTIFACT_ID);
  return {
    dir, buildTool: 'gradle', buildFilePath: gradlePath, hasSpringBoot, bootJarDisabled: bootJarDisabled(source),
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
  // The application's own files in src/main/resources/config/ (Spring Boot reads that folder too,
  // with precedence); the file Contexa writes there is not the application's.
  const configDir = path.join(resourcesDir, 'config');
  const configEntries = await fs.readdir(configDir, { withFileTypes: true }).catch(() => []);
  result.configDirPaths = [];
  for (const entry of configEntries) {
    if (!entry.isFile() || !/^application\.(?:yml|yaml|properties)$/.test(entry.name)) continue;
    const file = path.join(configDir, entry.name);
    if (!isContexaSettings(await readIfExists(file))) result.configDirPaths.push(file);
  }
  result.configDirPaths.sort();
}

// A Gradle module that turns the runnable jar off (bootJar.enabled = false, bootJar { enabled = false }, or the same
// for tasks.named('bootJar')) is a library. The last statement in the file wins, so a module that turns it off for
// everything and on for itself is an application.
function bootJarDisabled(source) {
  const code = stripCodeComments(source);
  const patterns = [
    /\bbootJar\s*\.\s*enabled\s*=\s*(true|false)\b/g,
    /\bbootJar\s*\{[^{}]*?\benabled\s*=\s*(true|false)\b/g,
    /['"]bootJar['"]\s*\)\s*\{[^{}]*?\benabled\s*=\s*(true|false)\b/g,
  ];
  const statements = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) statements.push({ at: match.index, off: match[1] === 'false' });
  }
  statements.sort((a, b) => a.at - b.at);
  return statements.length > 0 && statements[statements.length - 1].off;
}

// Whether a module has a class that starts a Spring Boot application (@SpringBootApplication in Java or Kotlin).
async function hasApplicationClass(moduleDir) {
  const roots = [
    { dir: path.join(moduleDir, 'src/main/java'), extension: '.java' },
    { dir: path.join(moduleDir, 'src/main/kotlin'), extension: '.kt' },
  ];
  for (const root of roots) {
    if (!await fs.pathExists(root.dir)) continue;
    for (const file of await listSourceFiles(root.dir, root.extension)) {
      let source;
      try { source = await fs.readFile(file, 'utf8'); } catch { continue; }
      if (!source.includes('SpringBootApplication')) continue;
      const code = stripCommentsAndStrings(source);
      if (/@SpringBootApplication\b/.test(code)
          || /@org\.springframework\.boot\.autoconfigure\.SpringBootApplication\b/.test(code)) {
        return true;
      }
    }
  }
  return false;
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
      // Users or another way to sign in of the application's own; then Spring Boot's default user
      // plays no part (F-50).
      if (/\b(?:UserDetailsService|UserDetailsManager|AuthenticationProvider|AuthenticationManager|AuthenticationManagerResolver|oauth2Login|oauth2ResourceServer|saml2Login|ldapAuthentication|jdbcAuthentication|inMemoryAuthentication)\b/.test(code)) {
        result.hostDefinesUsers = true;
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
module.exports = {
  detectSpringProject,
  detectSpringBootVersion,
  detectHostDatabase,
  collectHostConfigKeys,
  catalogBootVersion,
  bootJarDisabled,
};
