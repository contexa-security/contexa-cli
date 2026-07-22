'use strict';

// Mode 2 - Standalone integration.
//
// Writes contexa-only artifacts to a SEPARATE directory (default: <projectDir>/contexa/).
// The customer's build.gradle / pom.xml / application.yml are NEVER touched - the
// integration becomes a single-line opt-in for the customer:
//
//   Spring Boot config import (in customer's application.yml):
//       spring:
//         config:
//           import: "optional:file:./contexa/application.yml"
//
//   Gradle Groovy DSL (in customer's build.gradle):
//       apply from: 'contexa/contexa.gradle'
//
//   Gradle Kotlin DSL (in customer's build.gradle.kts):
//       apply(from = "contexa/contexa.gradle")
//
//   Maven (in customer's pom.xml): copy the <dependency> entries from
//       contexa/pom-fragment.xml into the project's <dependencies> block.
//       Maven has no `apply from` equivalent, so this is the one limitation.

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

const {
  CONTEXA_GROUP_ID,
  CONTEXA_ARTIFACT_ID,
  CONTEXA_VERSION,
  resolveDependencyVersions,
  springAiProviderArtifacts,
} = require('./common');
const { buildCliContexaTree, applyCliContexaTree } = require('./yml');
async function containsOnlyPreparedEntries(rootDir, preparedPaths = []) {
  const root = path.resolve(rootDir);
  const allowedFiles = new Set();
  const allowedDirectories = new Set();
  for (const preparedPath of preparedPaths) {
    const target = path.resolve(preparedPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    allowedFiles.add(target);
    let parent = path.dirname(target);
    while (parent !== root) {
      allowedDirectories.add(parent);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.resolve(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) return false;
      if (relative === 'manifest.json'
          || relative === '.cli' || relative.startsWith('.cli' + path.sep)) continue;
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(absolute) || !await inspect(absolute)) return false;
      } else if (!entry.isFile() || !allowedFiles.has(absolute)) {
        return false;
      }
    }
    return true;
  }
  return inspect(root);
}

// Returns { ymlPath, buildFragmentPath, importHints }. The caller is responsible
// for surfacing importHints to the operator. This function never throws on
// pre-existing files; it overwrites them (the standalone dir is contexa-owned).
async function injectStandalone(standaloneDir, project, opts = {}) {
  const { infra = 'standalone', force = false } = opts;
  const includeDistributed = infra === 'distributed';
  const { redisson: redissonVersion, springAiBom } =
    resolveDependencyVersions(opts.dependencyVersions);
  const providerArtifacts = springAiProviderArtifacts(opts.llmProviders || []);
  const includeAi = !!opts.enableAiSecurity && providerArtifacts.length > 0;
  const isMaven = project.buildTool === 'maven';
  const isKotlinDsl = !isMaven && project.buildFilePath && project.buildFilePath.endsWith('.kts');

  // Standalone mode never edits the host build. Its fragment contains exactly
  // the dependencies selected by the operator: the Contexa starter always,
  // Spring AI/provider/vector-store dependencies only with AI security, and
  // Kafka/Redisson only for distributed infrastructure.

  // Collision check: if `standaloneDir` already exists as a FILE (not a
  // directory), abort with an actionable message instead of letting fs-extra
  // throw a raw EEXIST. Common case: the customer project has a top-level
  // executable file named "contexa" - we must not overwrite it.
  if (await fs.pathExists(standaloneDir)) {
    const stat = await fs.lstat(standaloneDir);
    if (!stat.isDirectory()) {
      throw new Error(
        `Standalone target "${standaloneDir}" already exists and is not a directory. ` +
        `Move or remove that file, or pick a different folder via the prompt.`
      );
    }
    // Existing directory: warn the operator if it is non-empty AND looks
    // like it does NOT belong to a previous contexa-cli run (no marker
    // files inside). Without --force we fail-fast so we never clobber an
    // unrelated folder. With --force we proceed and back up overwritten
    // files individually below.
    const entries = await fs.readdir(standaloneDir);
    const ours = entries.includes('application.yml')
              || entries.includes('contexa.gradle')
              || entries.includes('pom-fragment.xml')
              || await containsOnlyPreparedEntries(standaloneDir, opts.preparedPaths);
    if (entries.length > 0 && !ours && !force) {
      throw new Error(
        `Standalone target "${standaloneDir}" already exists, is non-empty, and does ` +
        `not look like a contexa-cli output folder. Refusing to write here. ` +
        `Pick an empty folder via the prompt, or pass --force to overwrite.`
      );
    }
  }

  await fs.ensureDir(standaloneDir);

  // 1. Standalone application.yml. Reuses the same contexa.* tree the merge
  // mode produces, so behavior is identical between Mode 1 and Mode 2 once the
  // operator wires up the spring.config.import line.
  const cliTree = buildCliContexaTree(opts);
  const root = { contexa: {} };
  applyCliContexaTree(root, cliTree, opts);
  const ymlPath = path.join(standaloneDir, 'application.yml');
  const ymlOut = yaml.dump(root, {
    lineWidth: 200, noRefs: true, sortKeys: false, quotingType: '"',
  });
  const ymlHeader = [
    '# Generated by contexa-cli (standalone mode).',
    '# To activate, add ONE of the following to your customer application:',
    '#',
    '# Option A - In your application.yml:',
    '#   spring:',
    '#     config:',
    '#       import: "optional:file:./contexa/application.yml"',
    '#',
    '# Option B - On the command line at runtime:',
    '#   --spring.config.additional-location=./contexa/application.yml',
    '',
    '',
  ].join('\n');
  // Per-file backup: an existing standalone application.yml is preserved
  // as application.yml.bak so the operator can recover any local edits
  // they made between init runs. Same pattern generateDockerCompose uses.
  if (await fs.pathExists(ymlPath)) {
    await fs.copy(ymlPath, ymlPath + '.bak');
  }
  await fs.writeFile(ymlPath, ymlHeader + ymlOut);

  // 2. Build fragment.
  let buildFragmentPath;
  let buildHint;
  if (isMaven) {
    buildFragmentPath = path.join(standaloneDir, 'pom-fragment.xml');
    const lines = [];
    lines.push('<!--');
    lines.push('  Generated by contexa-cli (standalone mode).');
    lines.push('  Maven does not support `apply from` like Gradle, so copy the');
    lines.push("  <dependency> entries below into your project's pom.xml");
    lines.push('  <dependencies> block. The <dependencies> wrapper here is only');
    lines.push('  for visual context - copy the inner <dependency> elements.');
    lines.push('-->');
    lines.push('<dependencies>');
    lines.push('    <dependency>');
    lines.push(`        <groupId>${CONTEXA_GROUP_ID}</groupId>`);
    lines.push(`        <artifactId>${CONTEXA_ARTIFACT_ID}</artifactId>`);
    lines.push(`        <version>${CONTEXA_VERSION}</version>`);
    lines.push('    </dependency>');
    if (includeAi) {
      for (const artifact of providerArtifacts) {
        lines.push('    <dependency>');
        lines.push('        <groupId>org.springframework.ai</groupId>');
        lines.push(`        <artifactId>${artifact}</artifactId>`);
        lines.push(`        <version>${springAiBom}</version>`);
        lines.push('    </dependency>');
      }
      lines.push('    <dependency>');
      lines.push('        <groupId>org.springframework.ai</groupId>');
      lines.push('        <artifactId>spring-ai-starter-vector-store-pgvector</artifactId>');
      lines.push(`        <version>${springAiBom}</version>`);
      lines.push('    </dependency>');
    }
    if (includeDistributed) {
      lines.push('    <dependency>');
      lines.push('        <groupId>org.springframework.kafka</groupId>');
      lines.push('        <artifactId>spring-kafka</artifactId>');
      lines.push('    </dependency>');
      lines.push('    <dependency>');
      lines.push('        <groupId>org.redisson</groupId>');
      lines.push('        <artifactId>redisson</artifactId>');
      lines.push(`        <version>${redissonVersion}</version>`);
      lines.push('    </dependency>');
    }
    lines.push('</dependencies>');
    if (await fs.pathExists(buildFragmentPath)) {
      await fs.copy(buildFragmentPath, buildFragmentPath + '.bak');
    }
    await fs.writeFile(buildFragmentPath, lines.join('\n') + '\n');
    buildHint = `Copy <dependency> entries from ${path.relative(process.cwd(), buildFragmentPath) || buildFragmentPath} into your pom.xml.`;
  } else {
    buildFragmentPath = path.join(standaloneDir, 'contexa.gradle');
    const lines = [];
    lines.push('// Generated by contexa-cli (standalone mode).');
    lines.push('// Apply this script from your customer build:');
    lines.push('//   Groovy DSL (build.gradle):       apply from: \'contexa/contexa.gradle\'');
    lines.push('//   Kotlin DSL (build.gradle.kts):   apply(from = "contexa/contexa.gradle")');
    lines.push('');
    lines.push('dependencies {');
    lines.push(`    implementation '${CONTEXA_GROUP_ID}:${CONTEXA_ARTIFACT_ID}:${CONTEXA_VERSION}'`);
    if (includeAi) {
      lines.push(`    implementation platform('org.springframework.ai:spring-ai-bom:${springAiBom}')`);
      for (const artifact of providerArtifacts) {
        lines.push(`    implementation 'org.springframework.ai:${artifact}'`);
      }
      lines.push(`    implementation 'org.springframework.ai:spring-ai-starter-vector-store-pgvector'`);
    }
    if (includeDistributed) {
      lines.push(`    implementation 'org.springframework.kafka:spring-kafka'`);
      lines.push(`    implementation 'org.redisson:redisson:${redissonVersion}'`);
    }
    lines.push('}');
    if (await fs.pathExists(buildFragmentPath)) {
      await fs.copy(buildFragmentPath, buildFragmentPath + '.bak');
    }
    await fs.writeFile(buildFragmentPath, lines.join('\n') + '\n');
    buildHint = isKotlinDsl
      ? `Add to build.gradle.kts: apply(from = "contexa/contexa.gradle")`
      : `Add to build.gradle: apply from: 'contexa/contexa.gradle'`;
  }

  return {
    ymlPath,
    buildFragmentPath,
    importHints: {
      yml: 'Add to application.yml: spring.config.import: "optional:file:./contexa/application.yml"',
      build: buildHint,
      buildTool: project.buildTool,
      isMaven,
    },
  };
}

module.exports = { injectStandalone };
