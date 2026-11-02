'use strict';

// A small Spring Boot 3.5 application to try Contexa with, created when `contexa init` runs in a
// folder without a Spring Boot project. start.spring.io only generates Spring Boot 4 now, which
// Contexa does not support yet, so this is the shortest way to a working first run.
//
// Maven with the script-only wrapper: nothing but Java 17+ has to be installed.

const fs = require('fs-extra');
const path = require('path');
const { MVNW, MVNW_CMD, WRAPPER_PROPERTIES } = require('../templates/maven-wrapper');
const releaseManifest = require('../../release-manifest.json');

const SAMPLE_SPRING_BOOT_VERSION = (releaseManifest.dependencyVersions
  && releaseManifest.dependencyVersions.sampleSpringBoot) || '3.5.16';
const SUBFOLDER = 'contexa-demo';

// An application name starting with "contexa-" makes Contexa treat the application as its own
// (strict capability checks), so such names are avoided.
function applicationName(folderName) {
  const cleaned = String(folderName || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned.startsWith('contexa')) return 'demo';
  return /^[a-z]/.test(cleaned) ? cleaned : `app-${cleaned}`;
}

function className(name) {
  return name.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join('') + 'Application';
}

function packageName(name) {
  return `com.example.${name.replace(/[^a-z0-9]/g, '') || 'demo'}`;
}

// Where the sample goes: the folder itself when it is empty, otherwise a new subfolder.
async function sampleTarget(dir) {
  const entries = (await fs.pathExists(dir)) ? await fs.readdir(dir) : [];
  const visible = entries.filter(entry => !entry.startsWith('.'));
  if (visible.length === 0) return path.resolve(dir);
  return path.resolve(dir, SUBFOLDER);
}

async function createSampleProject(targetDir) {
  if (await fs.pathExists(targetDir)) {
    const entries = (await fs.readdir(targetDir)).filter(entry => !entry.startsWith('.'));
    if (entries.length > 0) {
      const error = new Error(`SAMPLE_TARGET_NOT_EMPTY ${targetDir}`);
      error.code = 'SAMPLE_TARGET_NOT_EMPTY';
      error.messageKey = 'sample.error.notEmpty';
      error.messageArgs = [targetDir];
      throw error;
    }
  }
  const name = applicationName(path.basename(targetDir));
  const pkg = packageName(name);
  const main = className(name);
  const javaDir = path.join(targetDir, 'src', 'main', 'java', ...pkg.split('.'));
  const files = {
    'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>${SAMPLE_SPRING_BOOT_VERSION}</version>
        <relativePath/>
    </parent>
    <groupId>com.example</groupId>
    <artifactId>${name}</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>${name}</name>
    <properties>
        <java.version>17</java.version>
    </properties>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
    </dependencies>
    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
`,
    '.gitignore': ['target/', '.idea/', '*.iml', '.vscode/', '.DS_Store', ''].join('\n'),
    '.mvn/wrapper/maven-wrapper.properties': WRAPPER_PROPERTIES,
    'mvnw': MVNW,
    'mvnw.cmd': MVNW_CMD,
    'src/main/resources/application.properties': [
      `spring.application.name=${name}`,
      '# Sample sign-in accounts for trying Contexa on this computer (shared password 1111).',
      '# Never turn this on for a real deployment.',
      'contexa.iam.seed.accounts.enabled=true',
      '',
    ].join('\n'),
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(targetDir, ...relative.split('/'));
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, content);
  }
  await fs.chmod(path.join(targetDir, 'mvnw'), 0o755);
  await fs.ensureDir(javaDir);
  await fs.writeFile(path.join(javaDir, `${main}.java`), `package ${pkg};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ${main} {

    public static void main(String[] args) {
        SpringApplication.run(${main}.class, args);
    }
}
`);
  await fs.writeFile(path.join(javaDir, 'OrderController.java'), `package ${pkg};

import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    @GetMapping("/api/orders")
    public List<Map<String, Object>> orders() {
        return List.of(
                Map.of("id", 1, "item", "keyboard", "amount", 120),
                Map.of("id", 2, "item", "monitor", "amount", 340));
    }
}
`);
  return { projectDir: targetDir, name };
}

module.exports = {
  SAMPLE_SPRING_BOOT_VERSION,
  applicationName,
  sampleTarget,
  createSampleProject,
};
