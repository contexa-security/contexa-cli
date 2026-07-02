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

async function injectMavenDep(pomPath) {
  if (!await fs.pathExists(pomPath)) return false;
  const pom = await fs.readFile(pomPath, 'utf8');
  if (pom.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Locate the project-level </dependencies>, skipping over any
  // <dependencyManagement>...</dependencyManagement> block whose inner
  // </dependencies> tag must NOT be the injection point.
  const mgmtRegex = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  const mgmtRanges = [];
  let m;
  while ((m = mgmtRegex.exec(pom)) !== null) {
    mgmtRanges.push([m.index, m.index + m[0].length]);
  }
  const isInsideMgmt = (idx) => mgmtRanges.some(([a, b]) => idx >= a && idx < b);

  let target = -1;
  let cursor = 0;
  while (true) {
    const found = pom.indexOf('</dependencies>', cursor);
    if (found === -1) break;
    if (!isInsideMgmt(found)) { target = found; break; }
    cursor = found + 1;
  }
  if (target === -1) return false;

  // Backup
  await backupFile(pomPath);

  const dep =
    `        <dependency>\n` +
    `            <groupId>${CONTEXA_GROUP_ID}</groupId>\n` +
    `            <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>\n` +
    `            <version>${CONTEXA_VERSION}</version>\n` +
    `        </dependency>\n    `;
  const updated = pom.slice(0, target) + dep + pom.slice(target);
  await fs.writeFile(pomPath, updated);
  return true;
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
  const re = /dependencies\s*\{/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(0, m.index);
    const cleaned = before
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    let depth = 0;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned.charAt(i);
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

async function injectGradleDep(gradlePath) {
  if (!await fs.pathExists(gradlePath)) return false;
  let gradle = await fs.readFile(gradlePath, 'utf8');
  if (gradle.includes(CONTEXA_ARTIFACT_ID)) return false;

  // Backup
  await backupFile(gradlePath);

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
async function injectDistributedDeps(buildPath) {
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
  const updated = insertIntoTopLevelDependencies(content, lines);
  await fs.writeFile(buildPath, updated);
  return true;
}

async function injectSpringAiDeps(buildPath, llmProviders = ['openai', 'anthropic']) {
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

    // 2. Add or remove selected model starters in the top-level dependencies block.
    const cleanMavenDep = (provName) => {
      const pat = new RegExp(`<dependency>\\s*<groupId>org\\.springframework\\.ai</groupId>\\s*<artifactId>spring-ai-starter-model-${provName}</artifactId>\\s*</dependency>\\s*`, 'g');
      updated = updated.replace(pat, '');
    };

    const beforeClean = updated;
    if (!llmProviders.includes('openai')) cleanMavenDep('openai');
    if (!llmProviders.includes('anthropic')) cleanMavenDep('anthropic');
    if (!llmProviders.includes('ollama')) cleanMavenDep('ollama');
    if (updated !== beforeClean) changed = true;

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
      await backupFile(buildPath);
      await fs.writeFile(buildPath, updated);
      return true;
    }
    return false;
  } else {
    // Gradle (Groovy or Kotlin DSL)
    const isKts = buildPath.endsWith('.kts');
    let updated = content;

    const cleanLines = (provName) => {
      const pat = isKts
        ? new RegExp(`^[ \\t]*implementation\\("org\\.springframework\\.ai:spring-ai-starter-model-${provName}"\\)[ \\t]*\\r?\\n?`, 'gm')
        : new RegExp(`^[ \\t]*implementation 'org\\.springframework\\.ai:spring-ai-starter-model-${provName}'[ \\t]*\\r?\\n?`, 'gm');
      updated = updated.replace(pat, '');
    };

    if (!llmProviders.includes('openai')) cleanLines('openai');
    if (!llmProviders.includes('anthropic')) cleanLines('anthropic');
    if (!llmProviders.includes('ollama')) cleanLines('ollama');

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
    await backupFile(buildPath);
    const finalContent = lines.length > 0 ? insertIntoTopLevelDependencies(updated, lines) : updated;
    await fs.writeFile(buildPath, finalContent);
    return true;
  }
}

async function injectEnableAiSecurity(projectDir) {
  const javaRoot = path.join(projectDir, 'src/main/java');
  if (!await fs.pathExists(javaRoot)) return { changed: false, filePath: null };

  const queue = [javaRoot];
  while (queue.length > 0) {
    const cur = queue.shift();
    let entries;
    try { entries = await fs.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        queue.push(full);
      } else if (e.isFile() && e.name.endsWith('.java')) {
        try {
          let text = await fs.readFile(full, 'utf8');
          if (text.includes('@SpringBootApplication')) {
            if (text.includes('@EnableAISecurity') || text.includes('EnableAISecurity')) {
              return { changed: false, filePath: full };
            }

            await backupFile(full);

            const importLine = "import io.contexa.contexacommon.annotation.EnableAISecurity;\n";
            const lastImportIndex = text.lastIndexOf('import ');
            if (lastImportIndex !== -1) {
              const endOfImportLine = text.indexOf(';', lastImportIndex);
              if (endOfImportLine !== -1) {
                text = text.slice(0, endOfImportLine + 1) + '\n' + importLine + text.slice(endOfImportLine + 1);
              }
            } else {
              const packageIndex = text.indexOf('package ');
              if (packageIndex !== -1) {
                const endOfPackage = text.indexOf(';', packageIndex);
                if (endOfPackage !== -1) {
                  text = text.slice(0, endOfPackage + 1) + '\n\n' + importLine + text.slice(endOfPackage + 1);
                }
              } else {
                text = importLine + '\n' + text;
              }
            }

            const annotIndex = text.indexOf('@SpringBootApplication');
            if (annotIndex !== -1) {
              text = text.slice(0, annotIndex) + "@EnableAISecurity\n" + text.slice(annotIndex);
            }

            await fs.writeFile(full, text);
            return { changed: true, filePath: full };
          }
        } catch {}
      }
    }
  }
  return { changed: false, filePath: null };
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
