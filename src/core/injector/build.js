'use strict';

// Build-file injection: pom.xml / build.gradle / build.gradle.kts.
//
// Three responsibilities:
//   1. Add the contexa starter (spring-boot-starter-contexa) to the project's
//      dependency block. Idempotent.
//   2. Add the distributed-mode dependencies (spring-kafka, redisson) when
//      --distributed is selected. Idempotent.
//   3. Locate the *top-level* dependencies block in Gradle, never the one
//      inside buildscript / subprojects / pluginManagement.
//
// Spring AI provider starters (spring-ai-starter-model-*) and the pgvector
// vector-store starter are intentionally NOT injected. They are only needed
// when the customer declares @EnableAISecurity, and adding them blindly
// breaks customers who use spring-boot-starter-contexa without the annotation
// (PgVector / ChatModel beans get instantiated against missing infrastructure
// at startup).

const fs = require('fs-extra');
const path = require('path');
const { CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID, CONTEXA_VERSION, backupFile } = require('./common');

async function injectMavenDep(pomPath, options = {}) {
  if (!await fs.pathExists(pomPath)) return false;
  const pom = await fs.readFile(pomPath, 'utf8');
  if (hasMavenDependency(pom, CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await backupFile(pomPath, options);

  const dep =
    `        <dependency>\n` +
    `            <groupId>${CONTEXA_GROUP_ID}</groupId>\n` +
    `            <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>\n` +
    `            <version>${CONTEXA_VERSION}</version>\n` +
    `        </dependency>\n    `;
  const target = findProjectDependenciesClose(pom);
  let updated;
  if (target !== -1) {
    updated = pom.slice(0, target) + dep + pom.slice(target);
  } else {
    const projectClose = pom.lastIndexOf('</project>');
    if (projectClose === -1) {
      throw new Error('Maven injection impossible: pom.xml has no project closing tag.');
    }
    const dependencies = `    <dependencies>\n${dep}</dependencies>\n`;
    updated = pom.slice(0, projectClose) + dependencies + pom.slice(projectClose);
  }
  await fs.writeFile(pomPath, updated);
  return true;
}

function hasMavenDependency(pom, groupId, artifactId) {
  const clean = pom.replace(/<!--[\s\S]*?-->/g, '');
  const management = [];
  const managementRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  let match;
  while ((match = managementRegex.exec(clean)) !== null) management.push([match.index, match.index + match[0].length]);
  const dependencyRegex = /<dependency>[\s\S]*?<\/dependency>/g;
  while ((match = dependencyRegex.exec(clean)) !== null) {
    if (management.some(([start, end]) => match.index >= start && match.index < end)) continue;
    if (new RegExp(`<groupId>\\s*${escapeForRegex(groupId)}\\s*<\\/groupId>`).test(match[0])
        && new RegExp(`<artifactId>\\s*${escapeForRegex(artifactId)}\\s*<\\/artifactId>`).test(match[0])) {
      return true;
    }
  }
  return false;
}

function findProjectDependenciesClose(pom) {
  const management = [];
  const managementRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  let match;
  while ((match = managementRegex.exec(pom)) !== null) management.push([match.index, match.index + match[0].length]);
  let cursor = 0;
  while (true) {
    const found = pom.indexOf('</dependencies>', cursor);
    if (found === -1) return -1;
    if (!management.some(([start, end]) => found >= start && found < end)) return found;
    cursor = found + 1;
  }
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
  const masked = maskGradleNonCode(content);
  const re = /\bdependencies\s*\{/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const before = masked.slice(0, m.index);
    let depth = 0;
    for (let i = 0; i < before.length; i++) {
      const ch = before.charAt(i);
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) {
      // Position right after the matched "dependencies {".
      return m.index + m[0].length;
    }
  }
  return -1;
}

function findTopLevelDependenciesRange(content) {
  const insertIndex = findTopLevelDependenciesInsertIndex(content);
  if (insertIndex === -1) return null;
  const masked = maskGradleNonCode(content);
  const openingBrace = masked.lastIndexOf('{', insertIndex);
  let depth = 1;
  for (let i = openingBrace + 1; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return { insertIndex, closeIndex: i };
    }
  }
  throw new Error('Gradle injection impossible: top-level dependencies block is not closed.');
}

function maskGradleNonCode(content) {
  let output = '', state = 'code', quote = '';
  for (let i = 0; i < content.length; i++) {
    const ch = content[i], next = content[i + 1];
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

function hasGradleDependency(content, groupId, artifactId) {
  const range = findTopLevelDependenciesRange(content);
  if (!range) return false;
  const block = content.slice(range.insertIndex, range.closeIndex);
  return new RegExp(`['"]${escapeForRegex(groupId)}:${escapeForRegex(artifactId)}(?::[^'"]+)?['"]`).test(block);
}

// Insert one or more dependency lines at the start of the top-level
// `dependencies { }` block. If no top-level block exists, append a new
// block at the end of the file. Caller passes already-formatted line
// strings (one per element). Idempotent if the caller filters out lines
// that are already present.
function insertIntoTopLevelDependencies(content, lines) {
  const insertPos = findTopLevelDependenciesInsertIndex(content);
  const block = '\n' + lines.join('\n');
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
  if (hasGradleDependency(gradle, CONTEXA_GROUP_ID, CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await backupFile(gradlePath, options);

  // Kotlin DSL uses double-quoted, parenthesized form: implementation("group:artifact:version")
  // Groovy DSL uses single-quoted form: implementation 'group:artifact:version'
  const isKotlinDsl = gradlePath.endsWith('.kts');
  const depLine = isKotlinDsl
    ? `    implementation("${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}")`
    : `    implementation '${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}'`;

  gradle = insertIntoTopLevelDependencies(gradle, [depLine]);
  await fs.writeFile(gradlePath, gradle);
  return true;
}

// Inject Redis/Kafka client dependencies for the distributed PoC profile.
// Idempotent ??silently does nothing if any of the markers already exist.
//
// spring-kafka version is omitted: Spring Boot's BOM manages it. redisson's
// version can be overridden via CONTEXA_REDISSON_VERSION env var so that
// customers whose own BOM pins a different redisson can avoid a clash.
async function injectDistributedDeps(buildPath, options = {}) {
  if (!buildPath || !await fs.pathExists(buildPath)) return false;
  const content = await fs.readFile(buildPath, 'utf8');
  const redissonVersion = process.env.CONTEXA_REDISSON_VERSION || '3.48.0';

  if (buildPath.endsWith('.xml')) {
    if (content.includes('spring-kafka') && content.includes('redisson') && content.includes('spring-boot-starter-data-redis') && content.includes('spring-statemachine-data-redis')) return false;
    const additions = [];
    if (!content.includes('spring-kafka')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.kafka</groupId>\n` +
        `            <artifactId>spring-kafka</artifactId>\n` +
        `        </dependency>`);
    }
    if (!content.includes('redisson')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.redisson</groupId>\n` +
        `            <artifactId>redisson</artifactId>\n` +
        `            <version>${redissonVersion}</version>\n` +
        `        </dependency>`);
    }
    if (!content.includes('spring-boot-starter-data-redis')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.boot</groupId>\n` +
        `            <artifactId>spring-boot-starter-data-redis</artifactId>\n` +
        `        </dependency>`);
    }
    if (!content.includes('spring-statemachine-data-redis')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.statemachine</groupId>\n` +
        `            <artifactId>spring-statemachine-data-redis</artifactId>\n` +
        `            <version>4.0.0</version>\n` +
        `        </dependency>`);
    }
    if (additions.length === 0) return false;

    await backupFile(buildPath, options);
    // Reuse the same project-level <dependencies> location logic.
    const mgmtRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
    const mgmtRanges = [];
    let m;
    while ((m = mgmtRegex.exec(content)) !== null) mgmtRanges.push([m.index, m.index + m[0].length]);
    const isInsideMgmt = (idx) => mgmtRanges.some(([a, b]) => idx >= a && idx < b);
    let target = -1, cursor = 0;
    while (true) {
      const found = content.indexOf('</dependencies>', cursor);
      if (found === -1) break;
      if (!isInsideMgmt(found)) { target = found; break; }
      cursor = found + 1;
    }
    if (target === -1) return false;

    const block = additions.join('\n') + '\n    ';
    const updated = content.slice(0, target) + block + content.slice(target);
    await fs.writeFile(buildPath, updated);
    return true;
  }

  // Gradle (Groovy or Kotlin DSL)
  const isKts = buildPath.endsWith('.kts');
  const lines = [];
  if (!content.includes('spring-kafka')) {
    lines.push(isKts
      ? `    implementation("org.springframework.kafka:spring-kafka")`
      : `    implementation 'org.springframework.kafka:spring-kafka'`);
  }
  if (!content.includes('redisson')) {
    lines.push(isKts
      ? `    implementation("org.redisson:redisson:${redissonVersion}")`
      : `    implementation 'org.redisson:redisson:${redissonVersion}'`);
  }
  if (!content.includes('spring-boot-starter-data-redis')) {
    lines.push(isKts
      ? `    implementation("org.springframework.boot:spring-boot-starter-data-redis")`
      : `    implementation 'org.springframework.boot:spring-boot-starter-data-redis'`);
  }
  if (!content.includes('spring-statemachine-data-redis')) {
    lines.push(isKts
      ? `    implementation("org.springframework.statemachine:spring-statemachine-data-redis:4.0.0")`
      : `    implementation 'org.springframework.statemachine:spring-statemachine-data-redis:4.0.0'`);
  }
  if (lines.length === 0) return false;
  await backupFile(buildPath, options);
  const updated = insertIntoTopLevelDependencies(content, lines);
  await fs.writeFile(buildPath, updated);
  return true;
}

async function injectSpringAiDeps(buildPath, llmProviders = ['openai', 'anthropic'], options = {}) {
  if (!buildPath || !await fs.pathExists(buildPath)) return false;
  const content = await fs.readFile(buildPath, 'utf8');

  if (buildPath.endsWith('.xml')) {
    // Maven pom.xml
    let changed = false;
    let updated = content;

    // 1. Add spring-ai-bom to dependencyManagement when needed.
    if (!content.includes('spring-ai-bom')) {
      const mgmtTag = '</dependencyManagement>';
      const mgmtIndex = content.indexOf(mgmtTag);
      if (mgmtIndex !== -1) {
        const bomDep = 
          `            <dependency>\n` +
          `                <groupId>org.springframework.ai</groupId>\n` +
          `                <artifactId>spring-ai-bom</artifactId>\n` +
          `                <version>1.1.2</version>\n` +
          `                <type>pom</type>\n` +
          `                <scope>import</scope>\n` +
          `            </dependency>\n        `;
        const innerDepsTag = content.slice(0, mgmtIndex).lastIndexOf('<dependencies>');
        if (innerDepsTag !== -1) {
          updated = updated.slice(0, mgmtIndex) + bomDep + updated.slice(mgmtIndex);
          changed = true;
        }
      } else {
        const projectEndTag = '</project>';
        const endIdx = content.indexOf(projectEndTag);
        if (endIdx !== -1) {
          const bomBlock = 
            `    <dependencyManagement>\n` +
            `        <dependencies>\n` +
            `            <dependency>\n` +
            `                <groupId>org.springframework.ai</groupId>\n` +
            `                <artifactId>spring-ai-bom</artifactId>\n` +
            `                <version>1.1.2</version>\n` +
            `                <type>pom</type>\n` +
            `                <scope>import</scope>\n` +
            `            </dependency>\n` +
            `        </dependencies>\n` +
            `    </dependencyManagement>\n\n`;
          updated = updated.slice(0, endIdx) + bomBlock + updated.slice(endIdx);
          changed = true;
        }
      }
    }

    // Add selected model starters. Dependencies that predate Contexa are
    // customer-owned and are never removed when provider selection changes.
    const additions = [];
    if (llmProviders.includes('openai') && !updated.includes('spring-ai-starter-model-openai')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>spring-ai-starter-model-openai</artifactId>\n` +
        `        </dependency>`);
    }
    if (llmProviders.includes('anthropic') && !updated.includes('spring-ai-starter-model-anthropic')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>spring-ai-starter-model-anthropic</artifactId>\n` +
        `        </dependency>`);
    }
    if (llmProviders.includes('ollama') && !updated.includes('spring-ai-starter-model-ollama')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>spring-ai-starter-model-ollama</artifactId>\n` +
        `        </dependency>`);
    }
    if (!updated.includes('spring-ai-starter-vector-store-pgvector')) {
      additions.push(
        `        <dependency>\n` +
        `            <groupId>org.springframework.ai</groupId>\n` +
        `            <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>\n` +
        `        </dependency>`);
    }

    if (additions.length > 0) {
      const mgmtRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
      const mgmtRanges = [];
      let m;
      while ((m = mgmtRegex.exec(updated)) !== null) mgmtRanges.push([m.index, m.index + m[0].length]);
      const isInsideMgmt = (idx) => mgmtRanges.some(([a, b]) => idx >= a && idx < b);
      let target = -1, cursor = 0;
      while (true) {
        const found = updated.indexOf('</dependencies>', cursor);
        if (found === -1) break;
        if (!isInsideMgmt(found)) { target = found; break; }
        cursor = found + 1;
      }
      if (target !== -1) {
        const block = additions.join('\n') + '\n    ';
        updated = updated.slice(0, target) + block + updated.slice(target);
        changed = true;
      }
    }

    if (changed) {
      await backupFile(buildPath, options);
      await fs.writeFile(buildPath, updated);
      return true;
    }
    return false;
  } else {
    // Gradle (Groovy or Kotlin DSL)
    const isKts = buildPath.endsWith('.kts');
    let updated = content;

    const lines = [];

    if (!updated.includes('spring-ai-bom')) {
      lines.push(isKts
        ? `    implementation(platform("org.springframework.ai:spring-ai-bom:1.1.2"))`
        : `    implementation platform('org.springframework.ai:spring-ai-bom:1.1.2')`);
    }
    if (llmProviders.includes('openai') && !updated.includes('spring-ai-starter-model-openai')) {
      lines.push(isKts
        ? `    implementation("org.springframework.ai:spring-ai-starter-model-openai")`
        : `    implementation 'org.springframework.ai:spring-ai-starter-model-openai'`);
    }
    if (llmProviders.includes('anthropic') && !updated.includes('spring-ai-starter-model-anthropic')) {
      lines.push(isKts
        ? `    implementation("org.springframework.ai:spring-ai-starter-model-anthropic")`
        : `    implementation 'org.springframework.ai:spring-ai-starter-model-anthropic'`);
    }
    if (llmProviders.includes('ollama') && !updated.includes('spring-ai-starter-model-ollama')) {
      lines.push(isKts
        ? `    implementation("org.springframework.ai:spring-ai-starter-model-ollama")`
        : `    implementation 'org.springframework.ai:spring-ai-starter-model-ollama'`);
    }
    if (!updated.includes('spring-ai-starter-vector-store-pgvector')) {
      lines.push(isKts
        ? `    implementation("org.springframework.ai:spring-ai-starter-vector-store-pgvector")`
        : `    implementation 'org.springframework.ai:spring-ai-starter-vector-store-pgvector'`);
    }

    if (lines.length === 0 && updated === content) return false;
    await backupFile(buildPath, options);
    const finalContent = lines.length > 0 ? insertIntoTopLevelDependencies(updated, lines) : updated;
    await fs.writeFile(buildPath, finalContent);
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

  await backupFile(filePath, options);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const imports = [
    'io.contexa.contexacommon.annotation.EnableAISecurity',
    'io.contexa.contexacommon.security.bridge.SecurityMode',
  ];
  for (const importedType of imports) {
    const importPattern = new RegExp(`^\\s*import\\s+${escapeForRegex(importedType)}(?:;)?\\s*$`, 'm');
    if (importPattern.test(source)) continue;
    source = insertImport(source, importedType, extension, newline);
  }

  code = maskSourceNonCode(source);
  const refreshedSpringAnnotation = code.match(/@(?:org\.springframework\.boot\.autoconfigure\.)?SpringBootApplication\b/);
  const annotation = `@EnableAISecurity(mode = SecurityMode.${securityMode.toUpperCase()})${newline}`;
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
  injectDistributedDeps,
  injectSpringAiDeps,
  injectEnableAiSecurity,
  findTopLevelDependenciesInsertIndex,
  insertIntoTopLevelDependencies,
};
