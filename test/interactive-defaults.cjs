'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const cliPath = path.join(root, 'src', 'index.js');
const cliExecutable = process.env.CONTEXA_CLI_EXECUTABLE
  ? path.resolve(process.env.CONTEXA_CLI_EXECUTABLE)
  : null;

function commandArgument(value) {
  return JSON.stringify(String(value));
}

function cleanTranscript(value) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '');
}

function runPseudoTerminal(args, input, rawTranscript, timeout = 20000, extraEnvironment = {}) {
  const invocation = cliExecutable
    ? [cliExecutable, ...args]
    : [process.execPath, cliPath, ...args];
  const command = invocation.map(commandArgument).join(' ');
  return spawnSync('script', [
    '--quiet', '--return', '--flush', '--command', command, rawTranscript,
  ], {
    input,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...extraEnvironment, TERM: 'xterm-256color' },
  });
}

function runPromptedPseudoTerminal(
    args, answers, rawTranscript, timeout = 20000, extraEnvironment = {}) {
  const invocation = cliExecutable
    ? [cliExecutable, ...args]
    : [process.execPath, cliPath, ...args];
  const command = invocation.map(commandArgument).join(' ');
  return new Promise(resolve => {
    const child = spawn('script', [
      '--quiet', '--return', '--flush', '--command', command, rawTranscript,
    ], {
      env: { ...process.env, ...extraEnvironment, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sentAnswers = 0;
    let settled = false;
    const timeoutHandle = setTimeout(() => child.kill('SIGTERM'), timeout);

    function sendPendingAnswer() {
      const transcript = cleanTranscript(stdout);
      const visiblePrompts = (transcript.match(/Answer:|\([Yy]\/n\)|\(y\/[Nn]\)/g) || []).length;
      while (sentAnswers < answers.length && sentAnswers < visiblePrompts) {
        child.stdin.write(answers[sentAnswers]);
        sentAnswers += 1;
      }
      if (sentAnswers === answers.length && !child.stdin.destroyed) child.stdin.end();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      sendPendingAnswer();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ error, status: null, signal: null, stdout, stderr });
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ error: undefined, status, signal, stdout, stderr });
    });
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
  const originalBuild =
    `plugins { id 'org.springframework.boot' version '3.3.0' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n`;
  const records = [];
  async function capture(name, result) {
    const dockerState = { containers: [], volumes: [] };
    if (process.env.CONTEXA_PHASE6_ACTUAL_DOCKER === '1' && locale === 'en') {
      const containers = spawnSync('docker', [
        'ps', '-a', '--filter', 'label=io.ctxa.owner=contexa-cli', '--format',
        '{{.Names}}|{{.Label "io.ctxa.mode"}}|{{.Label "io.ctxa.project"}}|{{.Label "com.docker.compose.service"}}',
      ], { encoding: 'utf8', timeout: 10000 });
      const volumes = spawnSync('docker', [
        'volume', 'ls', '--filter', 'label=io.ctxa.owner=contexa-cli', '--format',
        '{{.Name}}|{{.Label "io.ctxa.mode"}}|{{.Label "io.ctxa.project"}}',
      ], { encoding: 'utf8', timeout: 10000 });
      assert.equal(containers.status, 0, containers.stderr);
      assert.equal(volumes.status, 0, volumes.stderr);
      dockerState.containers = containers.stdout.split(/\r?\n/).filter(Boolean).sort();
      dockerState.volumes = volumes.stdout.split(/\r?\n/).filter(Boolean).sort();
    }
    records.push({
      name,
      exitCode: result.status,
      signal: result.signal,
      stdoutTokens: cleanTranscript(result.stdout || '').split(/\s+/).filter(Boolean).slice(0, 80),
      stderrTokens: cleanTranscript(result.stderr || '').split(/\s+/).filter(Boolean).slice(0, 40),
      buildSha256: sha256(await fs.readFile(buildPath)),
      ymlSha256: sha256(await fs.readFile(ymlPath)),
      normalManifest: await fs.pathExists(path.join(project, 'contexa', 'manifest.json')),
      simulationManifest: await fs.pathExists(
        path.join(project, 'contexa', 'simulation', 'manifest.json')),
      dockerState,
    });
  }
  try {
    await fs.outputFile(buildPath, originalBuild, 'utf8');
    for (const [configPath, content] of configFiles) {
      await fs.outputFile(configPath, content, 'utf8');
    }
    await fs.outputFile(sourcePath, originalSource, 'utf8');
    const result = await runPromptedPseudoTerminal(
      ['init', '--dir', project], ['\n', '\n', '\n'], rawTranscript, 120000, {
        CONTEXA_LANG: locale,
        CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
      });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.signal, null, `${locale} pseudo-terminal timed out`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const transcript = cleanTranscript(await fs.readFile(rawTranscript, 'utf8'));
    await fs.writeFile(path.join(outputDirectory, `${locale}-대화형-기본값.txt`), transcript, 'utf8');
    assert.match(transcript, /SETUP: QUICK/);
    assert.match(transcript, /INTEGRATION: MERGE/);
    assert.match(transcript, /Apply explicit Contexa settings/);
    assert.match(transcript, /DOCKER: START/);
    assert.match(transcript, /GeoLite2-City\.mmdb/);
    assert.doesNotMatch(transcript, /INTEGRATION: STANDALONE/);
    for (const [configPath, content] of configFiles) {
      assert.deepEqual(await fs.readFile(configPath), Buffer.from(content, 'utf8'));
    }
    assert.match(await fs.readFile(sourcePath, 'utf8'), /@EnableAISecurity\(mode = SecurityMode\.FULL\)/);
    assert.match(await fs.readFile(buildPath, 'utf8'), /ai\.ctxa:spring-boot-starter-contexa/);
    await capture('normal-init', result);

    const userMarker = '// user-owned phase6 PTY marker\n';
    await fs.appendFile(buildPath, userMarker, 'utf8');
    const userModifiedBytes = await fs.readFile(buildPath);
    const rerunTranscript = path.join(outputDirectory, `${locale}-user-modified-rerun-raw.txt`);
    const rerun = runPseudoTerminal(
      ['init', '--dir', project], '\n', rerunTranscript, 20000, { CONTEXA_LANG: locale });
    assert.equal(rerun.signal, null, `${locale} user-modified rerun timed out`);
    assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.deepEqual(await fs.readFile(buildPath), userModifiedBytes);
    for (const [configPath, content] of configFiles) {
      assert.deepEqual(await fs.readFile(configPath), Buffer.from(content, 'utf8'));
    }
    await capture('user-modified-init-rerun', rerun);

    if (process.env.CONTEXA_PHASE6_ACTUAL_DOCKER === '1' && locale === 'en') {
      const failedTranscript = path.join(outputDirectory, `${locale}-failed-recovery-raw.txt`);
      const missingGeoIp = path.join(project, 'missing-phase6-geoip.mmdb');
      const failedSimulation = runPseudoTerminal(
        ['init', '--simulate', '--dir', project], '\n', failedTranscript, 120000, {
          CONTEXA_LANG: locale, CONTEXA_GEOLITE2_SOURCE_PATH: missingGeoIp,
        });
      assert.equal(failedSimulation.signal, null, `${locale} failed-recovery timed out`);
      assert.notEqual(failedSimulation.status, 0,
        `${locale} failure injection unexpectedly succeeded`);
      const rolledBackSimulationManifest = JSON.parse(await fs.readFile(
        path.join(project, 'contexa', 'simulation', 'manifest.json'), 'utf8'));
      assert.equal(rolledBackSimulationManifest.transaction.status, 'ROLLED_BACK');
      assert.deepEqual(rolledBackSimulationManifest.files, []);
      assert.equal(await fs.pathExists(path.join(project, 'contexa', 'manifest.json')), true);
      assert.deepEqual(await fs.readFile(buildPath), userModifiedBytes);
      await capture('failed-simulation-rollback', failedSimulation);

      const simulationTranscript = path.join(outputDirectory, `${locale}-simulation-raw.txt`);
      const simulation = runPseudoTerminal(
        ['init', '--simulate', '--dir', project],
        '\n', simulationTranscript, 900000, {
          CONTEXA_LANG: locale,
          CONTEXA_GEOLITE2_SOURCE_PATH: process.env.CONTEXA_TEST_GEOLITE2_SOURCE_PATH,
        });
      assert.equal(simulation.signal, null, `${locale} simulation pseudo-terminal timed out`);
      assert.equal(simulation.status, 0, `${simulation.stdout}\n${simulation.stderr}`);
      await capture('simulation-retry-success', simulation);
      assert.equal(await fs.pathExists(path.join(project, 'contexa', 'manifest.json')), true);
      assert.equal(await fs.pathExists(
        path.join(project, 'contexa', 'simulation', 'manifest.json')), true);
      const docker = spawnSync('docker', [
        'ps', '--filter', 'name=ctxa-sim-', '--format',
        '{{.Names}}|{{.Label "io.ctxa.owner"}}|{{.Label "io.ctxa.mode"}}',
      ], { encoding: 'utf8', timeout: 10000 });
      assert.equal(docker.status, 0, docker.stderr);
      const resources = docker.stdout.trim().split(/\r?\n/).filter(Boolean);
      assert.equal(resources.length, 5, docker.stdout);
      assert.ok(resources.every(line => /\|contexa-cli\|simulation$/.test(line)));

      const simulationResetTranscript =
        path.join(outputDirectory, `${locale}-simulation-reset-raw.txt`);
      const simulationReset = runPseudoTerminal(
        ['reset', '--simulate', '--dir', project],
        'y\n', simulationResetTranscript, 120000, { CONTEXA_LANG: locale });
      assert.equal(simulationReset.status, 0,
        `${simulationReset.stdout}\n${simulationReset.stderr}`);
      assert.equal(await fs.pathExists(
        path.join(project, 'contexa', 'simulation', 'manifest.json')), false);
      assert.equal(await fs.pathExists(path.join(project, 'contexa', 'manifest.json')), true);
      await capture('simulation-reset', simulationReset);
    }

    const resetTranscript = path.join(outputDirectory, `${locale}-reset-raw.txt`);
    const reset = runPseudoTerminal(
      ['reset', '--dir', project], 'y\n', resetTranscript, 120000, { CONTEXA_LANG: locale });
    assert.equal(reset.status, 0, `${reset.stdout}\n${reset.stderr}`);
    assert.deepEqual(await fs.readFile(buildPath), Buffer.from(originalBuild + userMarker, 'utf8'));
    for (const [configPath, content] of configFiles) {
      assert.deepEqual(await fs.readFile(configPath), Buffer.from(content, 'utf8'));
    }
    assert.deepEqual(await fs.readFile(sourcePath), Buffer.from(originalSource, 'utf8'));
    await capture('normal-reset', reset);
    await fs.writeJson(path.join(outputDirectory, `${locale}-단계별-상태증거.json`),
      records, { spaces: 2 });
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
