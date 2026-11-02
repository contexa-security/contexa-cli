'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const {
  injectMavenDep, injectGradleDep, injectSpringAiDeps, injectEnableAiSecurity,
} = require('../src/core/injector/build');
const { CONTEXA_VERSION, resolveDependencyVersions } = require('../src/core/injector/common');
const releaseManifest = require('../release-manifest.json');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-injector-'));
}

// The Spring AI BOM version can be overridden with CONTEXA_SPRING_AI_VERSION; the tests check the
// release-manifest default, so a value in the developer's environment must not leak in.
async function withoutVersionOverrides(action) {
  const saved = {};
  for (const name of ['CONTEXA_SPRING_AI_VERSION', 'CONTEXA_SAMPLE_SPRING_BOOT_VERSION']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

// ============================================================
// injectMavenDep
// ============================================================
test('injectMavenDep: inserts dependency at project-level dependencies tag', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
</dependencies></project>`);
    const ok = await injectMavenDep(pomPath);
    assert.equal(ok, true);
    const pom = await fs.readFile(pomPath, 'utf8');
    assert.ok(pom.includes('spring-boot-starter-contexa'));
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: skips closing tag inside dependencyManagement', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement>
    <dependencies>
      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId></dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter</artifactId></dependency>
  </dependencies>
</project>`);
    await injectMavenDep(pomPath);
    const pom = await fs.readFile(pomPath, 'utf8');
    // Contexa dep must land in the project-level <dependencies>, not inside <dependencyManagement>.
    const mgmtBlock = pom.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)[0];
    assert.equal(mgmtBlock.includes('spring-boot-starter-contexa'), false,
      'contexa dep must NOT be injected inside dependencyManagement');
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: idempotent when artifact already present', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project><dependencies>
  <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>0.1.0</version></dependency>
</dependencies></project>`);
    const ok = await injectMavenDep(pomPath);
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: creates project dependencies when only dependencyManagement exists', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement><dependencies>
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId><version>old</version></dependency>
  </dependencies></dependencyManagement>
</project>`);
    assert.equal(await injectMavenDep(pomPath), true);
    const pom = await fs.readFile(pomPath, 'utf8');
    const outsideManagement = pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, '');
    assert.match(outsideManagement, /<dependencies>[\s\S]*<groupId>ai\.ctxa<\/groupId>[\s\S]*<artifactId>spring-boot-starter-contexa<\/artifactId>/);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: comment text is not treated as an installed dependency', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, `<project>
  <!-- ai.ctxa:spring-boot-starter-contexa is documentation only -->
  <dependencies></dependencies>
</project>`);
    assert.equal(await injectMavenDep(pomPath), true);
  } finally { await fs.remove(dir); }
});

test('injectMavenDep: captures only the CLI-added canonical coordinate', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    const addedDependencies = [];
    await fs.writeFile(pomPath, `<project>
  <dependencyManagement><dependencies>
    <dependency><groupId>ai.ctxa</groupId><artifactId>spring-boot-starter-contexa</artifactId></dependency>
  </dependencies></dependencyManagement>
  <dependencies></dependencies>
</project>`);
    assert.equal(await injectMavenDep(pomPath, {
      targetModule: 'apps/api',
      addedDependencies,
    }), true);
    assert.deepEqual(addedDependencies, [{
      group: 'ai.ctxa',
      artifact: 'spring-boot-starter-contexa',
      configuration: 'compile',
      version: CONTEXA_VERSION,
      versionSource: 'literal',
      targetModule: 'apps/api',
    }]);
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectGradleDep
// ============================================================
test('injectGradleDep: Groovy DSL uses single-quoted notation', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
}`);
    await injectGradleDep(gPath);
    const out = await fs.readFile(gPath, 'utf8');
    assert.match(out, /implementation '[^']*spring-boot-starter-contexa[^']*'/);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: Kotlin DSL uses parenthesized double-quoted notation', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle.kts');
    await fs.writeFile(gPath, `dependencies {
    implementation("org.springframework.boot:spring-boot-starter")
}`);
    await injectGradleDep(gPath);
    const out = await fs.readFile(gPath, 'utf8');
    assert.match(out, /implementation\("[^"]*spring-boot-starter-contexa[^"]*"\)/);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: idempotent when artifact already present', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {
  implementation 'ai.ctxa:spring-boot-starter-contexa:0.1.0'
}`);
    const ok = await injectGradleDep(gPath);
    assert.equal(ok, false);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: ignores buildscript dependency blocks and braces in comments and strings', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `buildscript {
  dependencies { classpath 'ai.ctxa:spring-boot-starter-contexa:documentation-only' }
}
def sample = "dependencies { not real }"
// unmatched documentation brace {
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter'
}
`);
    assert.equal(await injectGradleDep(gPath), true);
    const out = await fs.readFile(gPath, 'utf8');
    const topLevel = out.slice(out.lastIndexOf('dependencies {'));
    assert.match(topLevel, /implementation 'ai\.ctxa:spring-boot-starter-contexa:/);
    assert.equal((out.match(/implementation 'ai\.ctxa:spring-boot-starter-contexa:/g) || []).length, 1);
  } finally { await fs.remove(dir); }
});

test('injectGradleDep: nested subprojects coordinate is not a top-level installed dependency', async () => {
  const dir = await tempDir();
  try {
    const gradlePath = path.join(dir, 'build.gradle.kts');
    const addedDependencies = [];
    await fs.writeFile(gradlePath, `subprojects {
  dependencies { implementation("ai.ctxa:spring-boot-starter-contexa:decoy") }
}
dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }
`);
    assert.equal(await injectGradleDep(gradlePath, {
      targetModule: '.',
      addedDependencies,
    }), true);
    const output = await fs.readFile(gradlePath, 'utf8');
    assert.equal((output.match(/ai\.ctxa:spring-boot-starter-contexa/g) || []).length, 2);
    assert.equal(addedDependencies.length, 1);
    assert.equal(addedDependencies[0].configuration, 'implementation');
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectEnableAiSecurity
// ============================================================

test('injectEnableAiSecurity: SANDBOX writes the bare annotation with a single import (Java)', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/java/example/Application.java');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example;\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {}\n');
    const result = await injectEnableAiSecurity(dir, { securityMode: 'sandbox', mainApplicationCandidates: [source] });
    assert.deepEqual(result, { changed: true, filePath: source });
    const updated = await fs.readFile(source, 'utf8');
    assert.equal(updated, [
      'package example;',
      '',
      'import org.springframework.boot.autoconfigure.SpringBootApplication;',
      'import io.contexa.contexacommon.annotation.EnableAISecurity;',
      '',
      '@EnableAISecurity',
      '@SpringBootApplication',
      'public class Application {}',
      '',
    ].join('\n'));
    assert.equal(updated.includes('SecurityMode'), false, 'SANDBOX is the annotation default: no SecurityMode import');
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: FULL writes mode = SecurityMode.FULL with both imports (Java)', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/java/example/Application.java');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class Application {}\n');
    await injectEnableAiSecurity(dir, { securityMode: 'full', mainApplicationCandidates: [source] });
    const updated = await fs.readFile(source, 'utf8');
    assert.match(updated, /^import io\.contexa\.contexacommon\.annotation\.EnableAISecurity;$/m);
    assert.match(updated, /^import io\.contexa\.contexacommon\.security\.bridge\.SecurityMode;$/m);
    assert.match(updated, /\n@EnableAISecurity\(mode = SecurityMode\.FULL\)\n@SpringBootApplication\n/);
    assert.equal((updated.match(/^import /gm) || []).length, 4);
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: FULL in a Kotlin main class uses imports without semicolons', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/kotlin/example/Application.kt');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example\n\nimport org.springframework.boot.autoconfigure.SpringBootApplication\n\n@SpringBootApplication\nclass Application\n');
    await injectEnableAiSecurity(dir, { securityMode: 'full', mainApplicationCandidates: [source] });
    const updated = await fs.readFile(source, 'utf8');
    assert.match(updated, /import io\.contexa\.contexacommon\.annotation\.EnableAISecurity\n/);
    assert.match(updated, /import io\.contexa\.contexacommon\.security\.bridge\.SecurityMode\n/);
    assert.equal(updated.includes(';'), false);
    assert.match(updated, /@EnableAISecurity\(mode = SecurityMode\.FULL\)\n@SpringBootApplication/);
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: SANDBOX in a Kotlin main class, CRLF kept, second run changes nothing', async () => {
  const dir = await tempDir();
  try {
    const source = path.join(dir, 'src/main/kotlin/example/Application.kt');
    await fs.ensureDir(path.dirname(source));
    await fs.writeFile(source, 'package example\r\n\r\nimport org.springframework.boot.autoconfigure.SpringBootApplication\r\n\r\n@SpringBootApplication\r\nclass Application\r\n');
    assert.equal((await injectEnableAiSecurity(dir, { securityMode: 'sandbox', mainApplicationCandidates: [source] })).changed, true);
    const once = await fs.readFile(source, 'utf8');
    assert.match(once, /import io\.contexa\.contexacommon\.annotation\.EnableAISecurity\r\n/);
    assert.match(once, /\r\n@EnableAISecurity\r\n@SpringBootApplication\r\n/);
    assert.equal(once.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced');
    assert.equal((await injectEnableAiSecurity(dir, { securityMode: 'full', mainApplicationCandidates: [source] })).changed, false);
    assert.equal(await fs.readFile(source, 'utf8'), once);
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: an unknown mode is rejected before the source is read', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      injectEnableAiSecurity(dir, { securityMode: 'enforce', mainApplicationCandidates: [path.join(dir, 'Missing.java')] }),
      /Unsupported AI security mode: enforce/
    );
  } finally { await fs.remove(dir); }
});

test('injectEnableAiSecurity: multiple main candidates fail without changing either source', async () => {
  const dir = await tempDir();
  try {
    const first = path.join(dir, 'First.java');
    const second = path.join(dir, 'Second.java');
    const original = '@SpringBootApplication\nclass App {}\n';
    await fs.writeFile(first, original);
    await fs.writeFile(second, original);
    await assert.rejects(
      injectEnableAiSecurity(dir, { securityMode: 'sandbox', mainApplicationCandidates: [first, second] }),
      /stopped safely: 2 main application classes/
    );
    assert.equal(await fs.readFile(first, 'utf8'), original);
    assert.equal(await fs.readFile(second, 'utf8'), original);
  } finally { await fs.remove(dir); }
});

// ============================================================
// injectSpringAiDeps (selected model starters, BOM, customer-owned starters)
// ============================================================

test('injectSpringAiDeps: filters model starters based on llmProviders', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {\n}`);
    
    // Select only openai and ollama, exclude anthropic
    await injectSpringAiDeps(gPath, ['openai', 'ollama']);
    const out = await fs.readFile(gPath, 'utf8');
    
    assert.ok(out.includes('spring-ai-starter-model-openai'));
    assert.ok(out.includes('spring-ai-starter-model-ollama'));
    assert.ok(!out.includes('spring-ai-starter-model-anthropic'));
    assert.ok(out.includes('spring-ai-starter-vector-store-pgvector'));
  } finally { await fs.remove(dir); }
});

test('injectSpringAiDeps: preserves customer-owned unselected model starters', async () => {
  const dir = await tempDir();
  try {
    const gPath = path.join(dir, 'build.gradle');
    await fs.writeFile(gPath, `dependencies {\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-openai'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-anthropic'\n` +
      `    implementation 'org.springframework.ai:spring-ai-starter-model-ollama'\n` +
      `}`);
    
    // Selecting openai must not delete dependencies that existed beforehand.
    await injectSpringAiDeps(gPath, ['openai']);
    const out = await fs.readFile(gPath, 'utf8');
    
    assert.ok(out.includes('spring-ai-starter-model-openai'));
    assert.ok(out.includes('spring-ai-starter-model-anthropic'));
    assert.ok(out.includes('spring-ai-starter-model-ollama'));
  } finally { await fs.remove(dir); }
});

test('injectSpringAiDeps: customer dependencies are kept exactly once', async () => {
  const dir = await tempDir();
  try {
    const buildPath = path.join(dir, 'build.gradle');
    const dependencies = [
      'org.springframework.ai:spring-ai-starter-model-openai',
      'org.springframework.ai:spring-ai-starter-model-anthropic',
      'org.springframework.ai:spring-ai-starter-model-ollama',
      'org.springframework.ai:spring-ai-starter-vector-store-pgvector',
      'org.springframework.kafka:spring-kafka',
      'org.springframework.boot:spring-boot-starter-data-redis',
    ];
    await fs.writeFile(buildPath, `dependencies {\n${dependencies.map(value => `    implementation '${value}'`).join('\n')}\n}`);
    await injectSpringAiDeps(buildPath, ['openai']);
    const build = await fs.readFile(buildPath, 'utf8');
    dependencies.forEach(value => {
      assert.equal(build.split(value).length - 1, 1, `${value} must remain exactly once`);
    });
  } finally { await fs.remove(dir); }
});

test('injectSpringAiDeps: the Spring AI BOM version is the release-manifest value (Gradle and Maven)', async () => {
  assert.equal(releaseManifest.dependencyVersions.springAiBom, '1.1.8');
  await withoutVersionOverrides(async () => {
    assert.equal(resolveDependencyVersions().springAiBom, '1.1.8');
    const dir = await tempDir();
    try {
      const gradlePath = path.join(dir, 'build.gradle');
      await fs.writeFile(gradlePath, 'dependencies {\n    implementation \'org.springframework.boot:spring-boot-starter-web\'\n}\n');
      assert.equal(await injectSpringAiDeps(gradlePath, ['ollama']), true);
      assert.match(await fs.readFile(gradlePath, 'utf8'),
        /implementation platform\('org\.springframework\.ai:spring-ai-bom:1\.1\.8'\)/);

      const ktsPath = path.join(dir, 'build.gradle.kts');
      await fs.writeFile(ktsPath, 'dependencies {\n    implementation("org.springframework.boot:spring-boot-starter-web")\n}\n');
      await injectSpringAiDeps(ktsPath, ['ollama']);
      assert.match(await fs.readFile(ktsPath, 'utf8'),
        /implementation\(platform\("org\.springframework\.ai:spring-ai-bom:1\.1\.8"\)\)/);

      const pomPath = path.join(dir, 'pom.xml');
      await fs.writeFile(pomPath, '<project>\n    <dependencies>\n        <dependency>\n            <groupId>org.springframework.boot</groupId>\n            <artifactId>spring-boot-starter-web</artifactId>\n        </dependency>\n    </dependencies>\n</project>\n');
      await injectSpringAiDeps(pomPath, ['ollama']);
      const pom = await fs.readFile(pomPath, 'utf8');
      const management = pom.match(/<dependencyManagement>[\s\S]*<\/dependencyManagement>/);
      assert.ok(management, 'BOM goes into dependencyManagement');
      assert.match(management[0], /<artifactId>spring-ai-bom<\/artifactId>\s*<version>1\.1\.8<\/version>\s*<type>pom<\/type>\s*<scope>import<\/scope>/);
    } finally { await fs.remove(dir); }
  });
});

test('injectSpringAiDeps: anthropic gets the anthropic and ollama starters (Ollama serves embeddings)', async () => {
  const dir = await tempDir();
  try {
    const gradlePath = path.join(dir, 'build.gradle');
    await fs.writeFile(gradlePath, 'dependencies {\n    implementation \'org.springframework.boot:spring-boot-starter-web\'\n}\n');
    // init passes ['anthropic', 'ollama'] for the anthropic provider (aiProviderArtifacts).
    await injectSpringAiDeps(gradlePath, ['anthropic', 'ollama']);
    const out = await fs.readFile(gradlePath, 'utf8');
    assert.match(out, /implementation 'org\.springframework\.ai:spring-ai-starter-model-anthropic'/);
    assert.match(out, /implementation 'org\.springframework\.ai:spring-ai-starter-model-ollama'/);
    assert.match(out, /implementation 'org\.springframework\.ai:spring-ai-starter-vector-store-pgvector'/);
    assert.equal(out.includes('spring-ai-starter-model-openai'), false);

    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, '<project>\n    <dependencies>\n    </dependencies>\n</project>\n');
    await injectSpringAiDeps(pomPath, ['anthropic', 'ollama']);
    const pom = await fs.readFile(pomPath, 'utf8');
    assert.match(pom, /<artifactId>spring-ai-starter-model-anthropic<\/artifactId>/);
    assert.match(pom, /<artifactId>spring-ai-starter-model-ollama<\/artifactId>/);
    assert.equal(pom.includes('spring-ai-starter-model-openai'), false);
    assert.equal(await injectSpringAiDeps(pomPath, ['anthropic', 'ollama']), false, 'second run changes nothing');
  } finally { await fs.remove(dir); }
});

// ============================================================
// Indentation: tab-indented build files get tabs
// ============================================================

test('tab-indented Gradle build file gets tab-indented dependency lines', async () => {
  const dir = await tempDir();
  try {
    const gradlePath = path.join(dir, 'build.gradle');
    await fs.writeFile(gradlePath, [
      'plugins {',
      "\tid 'java'",
      "\tid 'org.springframework.boot' version '3.5.4'",
      '}',
      '',
      'dependencies {',
      "\timplementation 'org.springframework.boot:spring-boot-starter-web'",
      "\ttestImplementation 'org.springframework.boot:spring-boot-starter-test'",
      '}',
      '',
    ].join('\n'));
    assert.equal(await injectGradleDep(gradlePath), true);
    assert.equal(await injectSpringAiDeps(gradlePath, ['ollama']), true);
    const out = await fs.readFile(gradlePath, 'utf8');
    const added = out.split('\n').filter(line => /ai\.ctxa|org\.springframework\.ai/.test(line));
    assert.equal(added.length, 4, out);
    for (const line of added) assert.match(line, /^\timplementation[ (]/, `tab indented: ${JSON.stringify(line)}`);
    assert.equal(/^ +\S/m.test(out), false, 'no space-indented line introduced');
  } finally { await fs.remove(dir); }
});

test('space-indented Gradle build file keeps space indentation', async () => {
  const dir = await tempDir();
  try {
    const gradlePath = path.join(dir, 'build.gradle.kts');
    await fs.writeFile(gradlePath, 'dependencies {\n    implementation("org.springframework.boot:spring-boot-starter-web")\n}\n');
    await injectGradleDep(gradlePath);
    const out = await fs.readFile(gradlePath, 'utf8');
    assert.match(out, /^ {4}implementation\("ai\.ctxa:spring-boot-starter-contexa:/m);
    assert.equal(out.includes('\t'), false);
  } finally { await fs.remove(dir); }
});

test('tab-indented Maven pom gets tab-indented dependencies and BOM', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project>',
      '\t<modelVersion>4.0.0</modelVersion>',
      '\t<artifactId>tabs</artifactId>',
      '\t<dependencies>',
      '\t\t<dependency>',
      '\t\t\t<groupId>org.springframework.boot</groupId>',
      '\t\t\t<artifactId>spring-boot-starter-web</artifactId>',
      '\t\t</dependency>',
      '\t</dependencies>',
      '</project>',
      '',
    ].join('\n'));
    assert.equal(await injectMavenDep(pomPath), true);
    assert.equal(await injectSpringAiDeps(pomPath, ['openai']), true);
    const out = await fs.readFile(pomPath, 'utf8');
    assert.match(out, /\n\t\t<\/dependency>\n\t\t<dependency>\n\t\t\t<groupId>ai\.ctxa<\/groupId>\n\t\t\t<artifactId>spring-boot-starter-contexa<\/artifactId>\n\t\t\t<version>[^<]+<\/version>\n\t\t<\/dependency>\n/);
    assert.match(out, /\n\t\t<dependency>\n\t\t\t<groupId>org\.springframework\.ai<\/groupId>\n\t\t\t<artifactId>spring-ai-starter-model-openai<\/artifactId>\n\t\t<\/dependency>\n/);
    assert.match(out, /\n\t<dependencyManagement>\n\t\t<dependencies>\n\t\t\t<dependency>\n\t\t\t\t<groupId>org\.springframework\.ai<\/groupId>/);
    assert.equal(/^ {2,}</m.test(out), false, `no space-indented element introduced:\n${out}`);
    assert.match(out, /\n\t<\/dependencies>\n/, 'closing tag keeps its own indentation');
  } finally { await fs.remove(dir); }
});

test('Maven: every inserted element is indented like its neighbours, also in new dependency blocks', async () => {
  const dir = await tempDir();
  try {
    const pomPath = path.join(dir, 'pom.xml');
    await fs.writeFile(pomPath, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project>',
      '    <modelVersion>4.0.0</modelVersion>',
      '    <artifactId>spaces</artifactId>',
      '    <dependencyManagement>',
      '    </dependencyManagement>',
      '</project>',
      '',
    ].join('\n'));
    assert.equal(await injectMavenDep(pomPath), true);
    assert.equal(await injectSpringAiDeps(pomPath, ['ollama']), true);
    const lines = (await fs.readFile(pomPath, 'utf8')).split('\n');
    const indentOf = tag => lines.filter(line => line.trim() === tag).map(line => line.length - line.trimStart().length);
    assert.deepEqual([...new Set(indentOf('<dependencyManagement>'))], [4]);
    assert.deepEqual([...new Set(indentOf('</dependencyManagement>'))], [4]);
    assert.deepEqual(indentOf('<dependencies>'), [8, 4], 'managed dependencies, then the project dependencies');
    assert.deepEqual(indentOf('</dependencies>'), [8, 4]);
    assert.deepEqual(indentOf('<dependency>'), [12, 8, 8, 8], 'the BOM, then the starter and the two Spring AI starters');
    assert.deepEqual(indentOf('</dependency>'), [12, 8, 8, 8]);
  } finally { await fs.remove(dir); }
});
