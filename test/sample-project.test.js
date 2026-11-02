'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const {
  SAMPLE_SPRING_BOOT_VERSION,
  applicationName,
  sampleTarget,
  createSampleProject,
} = require('../src/core/sample-project');
const { MVNW, MVNW_CMD, WRAPPER_PROPERTIES } = require('../src/templates/maven-wrapper');
const { detectSpringProject } = require('../src/core/detector');
const releaseManifest = require('../release-manifest.json');
const en = require('../src/i18n/en.json');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-sample-'));
}

test('applicationName: lower-case kebab name, never one starting with contexa', () => {
  assert.equal(applicationName('shop'), 'shop');
  assert.equal(applicationName('My Shop!'), 'my-shop');
  assert.equal(applicationName('Order_Service'), 'order-service');
  assert.equal(applicationName('contexa'), 'demo');
  assert.equal(applicationName('contexa-demo'), 'demo');
  assert.equal(applicationName('Contexa-Playground'), 'demo');
  assert.equal(applicationName('123shop'), 'app-123shop');
  assert.equal(applicationName('한글폴더'), 'demo');
  assert.equal(applicationName(''), 'demo');
  assert.equal(applicationName(undefined), 'demo');
});

test('sampleTarget: an empty (or hidden-only, or missing) folder is used as is, otherwise contexa-demo inside it', async () => {
  const dir = await tempDir();
  try {
    assert.equal(await sampleTarget(dir), path.resolve(dir));
    await fs.ensureDir(path.join(dir, '.git'));
    await fs.writeFile(path.join(dir, '.DS_Store'), '');
    assert.equal(await sampleTarget(dir), path.resolve(dir), 'hidden entries do not count');
    const missing = path.join(dir, 'not-yet');
    assert.equal(await sampleTarget(missing), path.resolve(missing));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'mine');
    assert.equal(await sampleTarget(dir), path.join(path.resolve(dir), 'contexa-demo'));
  } finally { await fs.remove(dir); }
});

test('createSampleProject writes a Spring Boot 3.5 Maven application with the script-only wrapper', async () => {
  const dir = await tempDir();
  try {
    const target = path.join(dir, 'Shop');
    const result = await createSampleProject(target);
    assert.deepEqual(result, { projectDir: target, name: 'shop' });

    assert.equal(SAMPLE_SPRING_BOOT_VERSION, releaseManifest.dependencyVersions.sampleSpringBoot);
    assert.equal(SAMPLE_SPRING_BOOT_VERSION, '3.5.16');
    const pom = await fs.readFile(path.join(target, 'pom.xml'), 'utf8');
    assert.match(pom, /<parent>\s*<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>3\.5\.16<\/version>/);
    assert.match(pom, /<artifactId>shop<\/artifactId>/);
    assert.match(pom, /<java\.version>17<\/java\.version>/);
    assert.match(pom, /<artifactId>spring-boot-starter-web<\/artifactId>/);
    assert.match(pom, /<artifactId>spring-boot-maven-plugin<\/artifactId>/);

    const properties = await fs.readFile(path.join(target, 'src/main/resources/application.properties'), 'utf8');
    assert.match(properties, /^spring\.application\.name=shop$/m);
    assert.match(properties, /^contexa\.iam\.seed\.accounts\.enabled=true$/m);

    const mvnw = await fs.readFile(path.join(target, 'mvnw'), 'utf8');
    assert.equal(mvnw, MVNW);
    assert.ok(mvnw.startsWith('#!/bin/sh\n'));
    assert.match(mvnw, /Apache Maven Wrapper startup batch script, version 3\.3\.4/);
    assert.equal(await fs.readFile(path.join(target, 'mvnw.cmd'), 'utf8'), MVNW_CMD);
    assert.equal(await fs.readFile(path.join(target, '.mvn/wrapper/maven-wrapper.properties'), 'utf8'), WRAPPER_PROPERTIES);
    assert.match(WRAPPER_PROPERTIES, /distributionUrl=/);
    if (process.platform !== 'win32') {
      assert.ok(((await fs.stat(path.join(target, 'mvnw'))).mode & 0o111) !== 0, 'mvnw is executable');
    }
    assert.match(await fs.readFile(path.join(target, '.gitignore'), 'utf8'), /^target\/$/m);

    const main = await fs.readFile(path.join(target, 'src/main/java/com/example/shop/ShopApplication.java'), 'utf8');
    assert.match(main, /^package com\.example\.shop;$/m);
    assert.match(main, /@SpringBootApplication\npublic class ShopApplication \{/);
    assert.match(main, /SpringApplication\.run\(ShopApplication\.class, args\)/);
    assert.match(await fs.readFile(path.join(target, 'src/main/java/com/example/shop/OrderController.java'), 'utf8'),
      /@GetMapping\("\/api\/orders"\)/);
  } finally { await fs.remove(dir); }
});

test('the sample is what init expects: Spring Boot 3.5, one main class, no database of its own', async () => {
  const dir = await tempDir();
  try {
    const target = path.join(dir, 'contexa-demo');
    const { name } = await createSampleProject(target);
    assert.equal(name, 'demo');
    const project = await detectSpringProject(target, { probeDocker: false });
    assert.equal(project.isSpring, true);
    assert.equal(project.buildTool, 'maven');
    assert.equal(project.projectName, 'demo');
    assert.equal(project.springBootVersion, SAMPLE_SPRING_BOOT_VERSION);
    assert.deepEqual(project.mainApplicationCandidates.map(file => path.relative(target, file).split(path.sep).join('/')),
      ['src/main/java/com/example/demo/DemoApplication.java']);
    assert.equal(project.hasHostSecurityFilterChain, false);
    assert.equal(project.hostOwnsDatabase, false);
    assert.ok(project.hostConfigKeys.has('contexa.iam.seed.accounts.enabled'));
  } finally { await fs.remove(dir); }
});

test('createSampleProject refuses a folder that already has files and writes nothing', async () => {
  const dir = await tempDir();
  try {
    await fs.writeFile(path.join(dir, 'README.md'), '# mine\n');
    await assert.rejects(createSampleProject(dir), error => {
      assert.equal(error.code, 'SAMPLE_TARGET_NOT_EMPTY');
      assert.equal(error.messageKey, 'sample.error.notEmpty');
      assert.deepEqual(error.messageArgs, [dir]);
      assert.equal(typeof en[error.messageKey], 'string');
      return true;
    });
    assert.deepEqual(await fs.readdir(dir), ['README.md']);

    // Hidden entries alone do not make it non-empty.
    const hiddenOnly = path.join(dir, 'hidden-only');
    await fs.ensureDir(path.join(hiddenOnly, '.git'));
    await createSampleProject(hiddenOnly);
    assert.ok(await fs.pathExists(path.join(hiddenOnly, 'pom.xml')));
  } finally { await fs.remove(dir); }
});
