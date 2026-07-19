'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');

function commandArgument(value) {
  return JSON.stringify(String(value));
}

function cleanTranscript(value) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '');
}

async function runLocale(locale, outputDirectory) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), `ctxa-interactive-${locale}-`));
  const rawTranscript = path.join(outputDirectory, `${locale}-raw.txt`);
  const buildPath = path.join(project, 'build.gradle');
  const ymlPath = path.join(project, 'src/main/resources/application.yml');
  const sourcePath = path.join(project, 'src/main/java/example/SampleApplication.java');
  const configFiles = new Map([
    [ymlPath, '# host comment\nshared: &host-defaults\n  quoted: "keep:exact"\nserver:\n  <<: *host-defaults\n  port: 9080\n---\nspring:\n  config:\n    activate:\n      on-profile: local\n'],
    [path.join(project, 'src/main/resources/application.yaml'), 'host:\n  yaml-value: "unchanged"\n'],
    [path.join(project, 'src/main/resources/application.properties'), 'host.property=unchanged\\:value\n'],
    [path.join(project, 'src/main/resources/application-prod.yml'), 'host:\n  profile: prod\n'],
  ]);
  const originalSource = 'package example;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class SampleApplication {}\n';
  try {
    await fs.outputFile(
      buildPath,
      `plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n`,
      'utf8'
    );
    for (const [configPath, content] of configFiles) {
      await fs.outputFile(configPath, content, 'utf8');
    }
    await fs.outputFile(sourcePath, originalSource, 'utf8');
    const command = [
      process.execPath,
      cliPath,
      'init',
      '--lang',
      locale,
      '--dir',
      project,
    ].map(commandArgument).join(' ');
    const result = spawnSync('script', [
      '--quiet', '--return', '--flush', '--command', command, rawTranscript,
    ], {
      input: '\n',
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.signal, null, `${locale} pseudo-terminal timed out`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const transcript = cleanTranscript(await fs.readFile(rawTranscript, 'utf8'));
    await fs.writeFile(path.join(outputDirectory, `${locale}-대화형-기본값.txt`), transcript, 'utf8');
    assert.match(transcript, /SETUP: QUICK/);
    assert.match(transcript, /INTEGRATION: MERGE/);
    assert.match(transcript, /HOST CONFIG: NONE/);
    assert.match(transcript, /DOCKER: NONE/);
    assert.match(transcript, /EXTERNAL DOWNLOAD: NONE/);
    assert.doesNotMatch(transcript, /INTEGRATION: STANDALONE/);
    assert.doesNotMatch(transcript, /DOCKER: START/);
    for (const [configPath, content] of configFiles) {
      assert.deepEqual(await fs.readFile(configPath), Buffer.from(content, 'utf8'));
    }
    assert.deepEqual(await fs.readFile(sourcePath), Buffer.from(originalSource, 'utf8'));
    assert.match(await fs.readFile(buildPath, 'utf8'), /ai\.ctxa:spring-boot-starter-contexa/);
  } finally {
    await fs.remove(project);
    await fs.remove(rawTranscript);
  }
}

(async () => {
  if (process.platform === 'win32') {
    throw new Error('This acceptance runner requires the util-linux script command and runs in the Linux release job.');
  }
  const outputDirectory = process.env.CONTEXA_TRANSCRIPT_DIR
    ? path.resolve(process.env.CONTEXA_TRANSCRIPT_DIR)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-interactive-transcripts-'));
  await fs.ensureDir(outputDirectory);
  await runLocale('en', outputDirectory);
  await runLocale('ko', outputDirectory);
  console.log(`Interactive defaults passed for en and ko. Transcripts: ${outputDirectory}`);
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
