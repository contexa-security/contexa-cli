'use strict';

// Build-file injection: pom.xml / build.gradle / build.gradle.kts.
//
//   1. Add the Contexa starter (spring-boot-starter-contexa). Idempotent.
//   2. Add the Spring AI BOM, the selected model starters and the PgVector store starter that
//      @EnableAISecurity needs. Dependencies the project already declares are never touched.
//   3. Add @EnableAISecurity to the single @SpringBootApplication class.
//
// Gradle insertion targets the *top-level* dependencies block, never the one inside
// buildscript / subprojects / pluginManagement. New lines follow the file's own indentation.

const fs = require('fs-extra');
const path = require('path');
const {
  CONTEXA_GROUP_ID,
  CONTEXA_ARTIFACT_ID,
  CONTEXA_VERSION,
  resolveDependencyVersions,
  springAiProviderArtifacts,
} = require('./common');
const { parseMavenModel, parseGradleModel, hasCoordinate } = require('../build-model');
const CONTEXA_SNAPSHOT_REPOSITORY =
  'https://central.sonatype.com/repository/maven-snapshots/';

// Inserted snippets are written with 4-space indentation; a file indented with tabs (the
// start.spring.io default) gets tabs instead, so the result reads like the rest of the file.
function usesTabs(content) {
  const tabbed = (content.match(/^\t+\S/gm) || []).length;
  const spaced = (content.match(/^ {2,}\S/gm) || []).length;
  return tabbed > spaced;
}

function adaptIndent(content, text) {
  if (!usesTabs(content)) return text;
  return text.replace(/^((?: {4})+)/gm, match => '\t'.repeat(match.length / 4));
}

// Inserts `block` (whole lines with their own indentation, each ending in a newline) in front of
// the closing tag at `index`. When the tag starts its own line the block goes before that line,
// so neither the block's first line nor the tag is indented twice.
function insertBeforeClosingTag(text, index, block) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  if (/^[ \t]*$/.test(before)) return text.slice(0, lineStart) + block + text.slice(lineStart);
  const indent = before.match(/^[ \t]*/)[0];
  return text.slice(0, index) + '\n' + block + indent + text.slice(index);
}

function isSnapshotVersion(version) {
  return typeof version === 'string' && version.endsWith('-SNAPSHOT');
}

function hasSnapshotRepository(content) {
  return content.includes(CONTEXA_SNAPSHOT_REPOSITORY)
    || content.includes(CONTEXA_SNAPSHOT_REPOSITORY.replace(/\/$/, ''));
}

function insertMavenSnapshotRepository(pom) {
  if (hasSnapshotRepository(pom)) return pom;
  const repository =
    '        <repository>\n'
    + '            <id>contexa-snapshots</id>\n'
    + `            <url>${CONTEXA_SNAPSHOT_REPOSITORY}</url>\n`
    + '            <releases><enabled>false</enabled></releases>\n'
    + '            <snapshots><enabled>true</enabled></snapshots>\n'
    + '        </repository>\n';
  const repositoriesClose = pom.lastIndexOf('</repositories>');
  if (repositoriesClose !== -1) {
    return pom.slice(0, repositoriesClose) + repository + pom.slice(repositoriesClose);
  }
  const projectClose = pom.lastIndexOf('</project>');
  if (projectClose === -1) {
    throw new Error('Maven injection impossible: pom.xml has no project closing tag.');
  }
  const repositories = `    <repositories>\n${repository}    </repositories>\n`;
  return pom.slice(0, projectClose) + repositories + pom.slice(projectClose);
}

function insertGradleSnapshotRepository(content, isKotlinDsl) {
  if (hasSnapshotRepository(content)) return content;
  const quote = isKotlinDsl ? '"' : "'";
  const repository = `    maven { url = uri(${quote}${CONTEXA_SNAPSHOT_REPOSITORY}${quote}) }`;
  const model = parseGradleModel(content);
  const repositories = model.blocks.find(block => block.name === 'repositories' && !block.parent);
  if (repositories) {
    return content.slice(0, repositories.contentStart)
      + `\n${repository}` + content.slice(repositories.contentStart);
  }
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\nrepositories {\n${repository}\n}\n`;
}

function canonicalDependency(group, artifact, configuration, version, targetModule) {
  return {
    group,
    artifact,
    configuration,
    version: version || null,
    versionSource: version ? 'literal' : 'managed',
    targetModule: targetModule || '.',
  };
}

function captureAddedDependencies(options, dependencies) {
  if (!Array.isArray(options.addedDependencies)) return;
  for (const dependency of dependencies) {
    const key = [dependency.group, dependency.artifact, dependency.configuration,
      dependency.version || '', dependency.targetModule].join(':');
    if (!options.addedDependencies.some(item =>
      [item.group, item.artifact, item.configuration,
        item.version || '', item.targetModule].join(':') === key)) {
      options.addedDependencies.push(dependency);
    }
  }
}

async function inspectAiDependencies(buildPath, providers = []) {
  if (!buildPath || !await fs.pathExists(buildPath)) return false;
  const content = await fs.readFile(buildPath, 'utf8');
  const isMaven = buildPath.endsWith('.xml');
  const model = isMaven ? parseMavenModel(content) : parseGradleModel(content);
  const dependencies = model.dependencies;
  const bomPresent = isMaven
    ? hasCoordinate(model.managedDependencies, 'org.springframework.ai', 'spring-ai-bom')
    : hasCoordinate(dependencies, 'org.springframework.ai', 'spring-ai-bom');
  const selectedProvidersPresent = providers.every(provider =>
    hasCoordinate(dependencies, 'org.springframework.ai',
      `spring-ai-starter-model-${provider}`));
  return bomPresent
    && selectedProvidersPresent
    && hasCoordinate(dependencies, 'org.springframework.ai',
      'spring-ai-starter-vector-store-pgvector');
}

async function injectMavenDep(pomPath, options = {}) {
  if (!await fs.pathExists(pomPath)) return false;
  const pom = await fs.readFile(pomPath, 'utf8');
  const model = parseMavenModel(pom);
  const existing = model.dependencies.find(dependency =>
    dependency.group === CONTEXA_GROUP_ID && dependency.artifact === CONTEXA_ARTIFACT_ID);
  const addDependency = !existing;
  const addRepository = isSnapshotVersion(CONTEXA_VERSION)
    && (!existing || isSnapshotVersion(existing.version))
    && !hasSnapshotRepository(pom);
  if (!addDependency && !addRepository) return false;

  let updated = pom;
  if (addDependency) {
    const dep =
      `        <dependency>\n` +
      `            <groupId>${CONTEXA_GROUP_ID}</groupId>\n` +
      `            <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>\n` +
      `            <version>${CONTEXA_VERSION}</version>\n` +
      `        </dependency>\n`;
    const target = model.dependenciesCloseIndex;
    if (target !== -1) {
      updated = insertBeforeClosingTag(updated, target, adaptIndent(pom, dep));
    } else {
      const projectClose = updated.lastIndexOf('</project>');
      if (projectClose === -1) {
        throw new Error('Maven injection impossible: pom.xml has no project closing tag.');
      }
      updated = insertBeforeClosingTag(updated, projectClose,
        adaptIndent(pom, `    <dependencies>\n${dep}    </dependencies>\n`));
    }
  }
  if (addRepository) updated = insertMavenSnapshotRepository(updated);
  await fs.writeFile(pomPath, updated);
  if (addDependency) {
    captureAddedDependencies(options, [canonicalDependency(
      CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID, 'compile', CONTEXA_VERSION, options.targetModule)]);
  }
  return true;
}
function hasMavenDependency(pom, groupId, artifactId) {
  return hasCoordinate(parseMavenModel(pom).dependencies, groupId, artifactId);
}

function findProjectDependenciesClose(pom) {
  return parseMavenModel(pom).dependenciesCloseIndex;
}

function escapeForRegex(value) {
  return String(value).replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
}

// Locate the top-level `dependencies {` block in a Gradle build script.
//
// Returns the character index immediately AFTER the opening `{` of the first
// top-level (brace-depth 0) dependencies block, or -1 if none exists.
//
// Why not a plain `gradle.replace(/dependencies\s*\{/, ...)` ?
//   That regex matches the FIRST occurrence, which in legacy buildscript-based
//   build.gradle files is the dependencies block INSIDE
//      buildscript { dependencies { classpath '...' } }
//   Inserting `implementation '...'` there breaks the build because
//   `implementation` is not a valid configuration in the buildscript scope.
//   Same issue for `subprojects { dependencies { } }`,
//   `allprojects { dependencies { } }`, `pluginManagement { ... }`.
//
// Strategy: scan all `dependencies\s*\{` candidates, count braces in the
// preceding text (after stripping // line comments and /* block comments */),
// and pick the first match whose depth is exactly 0. Strings are not parsed
// because Gradle DSL rarely embeds raw `{`/`}` inside string literals; a
// future refinement can add a real Groovy/Kotlin tokenizer if needed.
function findTopLevelDependenciesInsertIndex(content) {
  const model = parseGradleModel(content);
  return model.topLevelDependencies
    ? model.topLevelDependencies.block.contentStart : -1;
}

function findTopLevelDependenciesRange(content) {
  const model = parseGradleModel(content);
  if (!model.topLevelDependencies) return null;
  return {
    insertIndex: model.topLevelDependencies.block.contentStart,
    closeIndex: model.topLevelDependencies.block.end,
  };
}

function hasGradleDependency(content, groupId, artifactId) {
  return hasCoordinate(parseGradleModel(content).dependencies, groupId, artifactId);
}

// Insert one or more dependency lines at the start of the top-level
// `dependencies { }` block. If no top-level block exists, append a new
// block at the end of the file. Caller passes already-formatted line
// strings (one per element). Idempotent if the caller filters out lines
// that are already present.
function insertIntoTopLevelDependencies(content, lines) {
  const insertPos = findTopLevelDependenciesInsertIndex(content);
  const block = '\n' + lines.map(line => adaptIndent(content, line)).join('\n');
  if (insertPos === -1) {
    // No top-level block - append a new one. Trailing newline normalized.
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}\n\ndependencies {${block}\n}\n`;
  }
  return content.slice(0, insertPos) + block + content.slice(insertPos);
}

async function injectGradleDep(gradlePath, options = {}) {
  if (!await fs.pathExists(gradlePath)) return false;
  let gradle = await fs.readFile(gradlePath, 'utf8');
  const model = parseGradleModel(gradle);
  const existing = model.dependencies.find(dependency =>
    dependency.group === CONTEXA_GROUP_ID && dependency.artifact === CONTEXA_ARTIFACT_ID);
  const addDependency = !existing;
  const addRepository = isSnapshotVersion(CONTEXA_VERSION)
    && (!existing || isSnapshotVersion(existing.version))
    && !hasSnapshotRepository(gradle);
  if (!addDependency && !addRepository) return false;

  const isKotlinDsl = gradlePath.endsWith('.kts');
  if (addDependency) {
    const depLine = isKotlinDsl
      ? `    implementation("${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}")`
      : `    implementation '${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}'`;
    gradle = insertIntoTopLevelDependencies(gradle, [depLine]);
  }
  if (addRepository) gradle = insertGradleSnapshotRepository(gradle, isKotlinDsl);
  await fs.writeFile(gradlePath, gradle);
  if (addDependency) {
    captureAddedDependencies(options, [canonicalDependency(
      CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID, 'implementation', CONTEXA_VERSION, options.targetModule)]);
  }
  return true;
}
async function injectSpringAiDeps(buildPath, llmProviders = ['openai', 'anthropic'], options = {}) {
  if (!buildPath || !await fs.pathExists(buildPath)) return false;
  const content = await fs.readFile(buildPath, 'utf8');
  const added = [];
  const { springAiBom } = resolveDependencyVersions(options.dependencyVersions);
  const providerArtifacts = springAiProviderArtifacts(llmProviders);

  if (buildPath.endsWith('.xml')) {
    // Maven pom.xml
    let changed = false;
    let updated = content;
    const initialModel = parseMavenModel(content);

    // 1. Add spring-ai-bom to dependencyManagement when needed.
    if (!hasCoordinate(initialModel.managedDependencies,
      'org.springframework.ai', 'spring-ai-bom')) {
      const mgmtIndex = initialModel.dependencyManagementCloseIndex;
      if (mgmtIndex !== -1) {
        const bomDep =
          `            <dependency>\n` +
          `                <groupId>org.springframework.ai</groupId>\n` +
          `                <artifactId>spring-ai-bom</artifactId>\n` +
          `                <version>${springAiBom}</version>\n` +
          `                <type>pom</type>\n` +
          `                <scope>import</scope>\n` +
          `            </dependency>\n`;
        if (initialModel.managedDependenciesCloseIndex !== -1) {
          updated = insertBeforeClosingTag(updated, initialModel.managedDependenciesCloseIndex,
            adaptIndent(content, bomDep));
          changed = true;
        } else {
          updated = insertBeforeClosingTag(updated, mgmtIndex,
            adaptIndent(content, `        <dependencies>\n${bomDep}        </dependencies>\n`));
          changed = true;
        }
      } else {
        const endIdx = initialModel.projectCloseIndex;
        if (endIdx !== -1) {
          const bomBlock = adaptIndent(content,
            `    <dependencyManagement>\n` +
            `        <dependencies>\n` +
            `            <dependency>\n` +
            `                <groupId>org.springframework.ai</groupId>\n` +
            `                <artifactId>spring-ai-bom</artifactId>\n` +
            `                <version>${springAiBom}</version>\n` +
            `                <type>pom</type>\n` +
            `                <scope>import</scope>\n` +
            `            </dependency>\n` +
            `        </dependencies>\n` +
            `    </dependencyManagement>\n\n`);
          updated = insertBeforeClosingTag(updated, endIdx, bomBlock);
          changed = true;
        }
      }
      added.push(canonicalDependency('org.springframework.ai', 'spring-ai-bom',
        'dependencyManagement', springAiBom, options.targetModule));
    }

    // Add selected model starters. Dependencies that predate Contexa are
    // customer-owned and are never removed when provider selection changes.
    const applicationModel = parseMavenModel(updated);
    const additions = [];
    for (const artifact of providerArtifacts) {
      if (hasCoordinate(applicationModel.dependencies, 'org.springframework.ai', artifact)) continue;
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>${artifact}</artifactId>\n` +
        `        </dependency>`);
      added.push(canonicalDependency('org.springframework.ai', artifact,
        'compile', null, options.targetModule));
    }
    if (!hasCoordinate(applicationModel.dependencies,
      'org.springframework.ai', 'spring-ai-starter-vector-store-pgvector')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>\n` +
        `        </dependency>`);
      added.push(canonicalDependency('org.springframework.ai',
        'spring-ai-starter-vector-store-pgvector', 'compile', null, options.targetModule));
    }

    if (additions.length > 0) {
      const currentModel = parseMavenModel(updated);
      const block = additions.join('\n') + '\n';
      updated = currentModel.dependenciesCloseIndex !== -1
        ? insertBeforeClosingTag(updated, currentModel.dependenciesCloseIndex, adaptIndent(content, block))
        : insertBeforeClosingTag(updated, currentModel.projectCloseIndex,
          adaptIndent(content, `    <dependencies>\n${block}    </dependencies>\n`));
      changed = true;
    }

    if (changed) {
      await fs.writeFile(buildPath, updated);
      captureAddedDependencies(options, added);
      return true;
    }
    return false;
  } else {
    // Gradle (Groovy or Kotlin DSL)
    const isKts = buildPath.endsWith('.kts');
    let updated = content;
    const model = parseGradleModel(content);

    const lines = [];

    if (!hasCoordinate(model.dependencies, 'org.springframework.ai', 'spring-ai-bom')) {
      lines.push(isKts
        ? `    implementation(platform("org.springframework.ai:spring-ai-bom:${springAiBom}"))`
        : `    implementation platform('org.springframework.ai:spring-ai-bom:${springAiBom}')`);
      added.push(canonicalDependency('org.springframework.ai', 'spring-ai-bom',
        'implementation', springAiBom, options.targetModule));
    }
    for (const artifact of providerArtifacts) {
      if (hasCoordinate(model.dependencies, 'org.springframework.ai', artifact)) continue;
      lines.push(isKts
        ? `    implementation("org.springframework.ai:${artifact}")`
        : `    implementation 'org.springframework.ai:${artifact}'`);
      added.push(canonicalDependency('org.springframework.ai', artifact,
        'implementation', null, options.targetModule));
    }
    if (!hasCoordinate(model.dependencies,
      'org.springframework.ai', 'spring-ai-starter-vector-store-pgvector')) {
      lines.push(isKts
        ? `    implementation("org.springframework.ai:spring-ai-starter-vector-store-pgvector")`
        : `    implementation 'org.springframework.ai:spring-ai-starter-vector-store-pgvector'`);
      added.push(canonicalDependency('org.springframework.ai',
        'spring-ai-starter-vector-store-pgvector', 'implementation', null, options.targetModule));
    }

    if (lines.length === 0 && updated === content) return false;
    const finalContent = lines.length > 0 ? insertIntoTopLevelDependencies(updated, lines) : updated;
    await fs.writeFile(buildPath, finalContent);
    captureAddedDependencies(options, added);
    return true;
  }
}

async function injectEnableAiSecurity(projectDir, options = {}) {
  const securityMode = String(options.securityMode || 'sandbox').toLowerCase();
  if (!['sandbox', 'full'].includes(securityMode)) {
    throw new Error(`Unsupported AI security mode: ${securityMode}`);
  }
  let candidates = options.mainApplicationCandidates;
  if (!Array.isArray(candidates)) {
    const { detectSpringProject } = require('../detector');
    candidates = (await detectSpringProject(projectDir, { probeDocker: false })).mainApplicationCandidates;
  }
  if (candidates.length !== 1) {
    const reason = candidates.length === 0 ? 'no main application class was found' : `${candidates.length} main application classes were found`;
    throw new Error(`Automatic @EnableAISecurity injection stopped safely: ${reason}.`);
  }

  const filePath = candidates[0];
  const extension = path.extname(filePath);
  if (!['.java', '.kt'].includes(extension)) {
    throw new Error(`Automatic @EnableAISecurity injection does not support ${extension || 'this source type'}.`);
  }
  let source = await fs.readFile(filePath, 'utf8');
  let code = maskSourceNonCode(source);
  if (/@EnableAISecurity\b/.test(code)
      || /@io\.contexa\.[\w.]*EnableAISecurity\b/.test(code)) {
    return { changed: false, filePath };
  }
  const springAnnotation = code.match(/@(?:org\.springframework\.boot\.autoconfigure\.)?SpringBootApplication\b/);
  if (!springAnnotation) {
    throw new Error('Automatic @EnableAISecurity injection stopped safely: the selected source has no real @SpringBootApplication annotation.');
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  // SANDBOX is the annotation default (the application keeps owning sign-in), so it is written
  // without attributes; FULL hands sign-in to Contexa and needs the SecurityMode import.
  const imports = securityMode === 'full'
    ? [
        'io.contexa.contexacommon.annotation.EnableAISecurity',
        'io.contexa.contexacommon.security.bridge.SecurityMode',
      ]
    : ['io.contexa.contexacommon.annotation.EnableAISecurity'];
  for (const importedType of imports) {
    const importPattern = new RegExp(`^\\s*import\\s+${escapeForRegex(importedType)}(?:;)?\\s*$`, 'm');
    if (importPattern.test(source)) continue;
    source = insertImport(source, importedType, extension, newline);
  }

  code = maskSourceNonCode(source);
  const refreshedSpringAnnotation = code.match(/@(?:org\.springframework\.boot\.autoconfigure\.)?SpringBootApplication\b/);
  const annotation = securityMode === 'full'
    ? `@EnableAISecurity(mode = SecurityMode.FULL)${newline}`
    : `@EnableAISecurity${newline}`;
  source = source.slice(0, refreshedSpringAnnotation.index) + annotation + source.slice(refreshedSpringAnnotation.index);
  await fs.writeFile(filePath, source);
  return { changed: true, filePath };
}

function insertImport(source, importedType, extension, newline) {
  const suffix = extension === '.java' ? ';' : '';
  const importLine = `import ${importedType}${suffix}`;
  const importMatches = [...source.matchAll(/^\s*import\s+[^\r\n]+/gm)];
  if (importMatches.length > 0) {
    const last = importMatches[importMatches.length - 1];
    const end = last.index + last[0].length;
    return source.slice(0, end) + newline + importLine + source.slice(end);
  }
  const packageMatch = source.match(/^\s*package\s+[^;\r\n]+;?/m);
  if (packageMatch) {
    const end = packageMatch.index + packageMatch[0].length;
    return source.slice(0, end) + newline + newline + importLine + source.slice(end);
  }
  return importLine + newline + newline + source;
}

function maskSourceNonCode(source) {
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
      if (ch === quote) { output += ' '; state = 'code'; } else output += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '/' && next === '/') { output += '  '; i++; state = 'line'; continue; }
    if (ch === '/' && next === '*') { output += '  '; i++; state = 'block'; continue; }
    if (ch === '"' || ch === "'") { output += ' '; quote = ch; state = 'string'; continue; }
    output += ch;
  }
  return output;
}

module.exports = {
  injectMavenDep,
  injectGradleDep,
  injectSpringAiDeps,
  injectEnableAiSecurity,
  inspectAiDependencies,
  findTopLevelDependenciesInsertIndex,
  insertIntoTopLevelDependencies,
};
