#!/usr/bin/env node
'use strict';

// Smoke test for a built CLI: version, help, then `init --yes` and `reset --yes` on a Gradle
// fixture project, with the test hooks that keep Docker, the build tool, Java and the network out
// of the run (see test/harness.js).
//
//   CONTEXA_CLI_EXECUTABLE=dist/contexa-win-x64.exe node test/binary-smoke.cjs
//   node test/binary-smoke.cjs            (without the variable: node src/index.js)
//
// Exit code 0 when every step passes, 1 otherwise.

const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const releaseManifest = require('../release-manifest.json');
const {
  CLI_PATH,
  createSandbox,
  cliEnv,
  createGradleProject,
  snapshotDirectory,
  starterCount,
  resetResult,
} = require('./harness');

const executable = process.env.CONTEXA_CLI_EXECUTABLE
  ? path.resolve(process.env.CONTEXA_CLI_EXECUTABLE)
  : null;

function run(args, env) {
  const [command, prefix] = executable && !/\.c?js$/i.test(executable)
    ? [executable, []]
    : [process.execPath, [executable || CLI_PATH]];
  const result = spawnSync(command, [...prefix, ...args], {
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    input: '',
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function step(name, action) {
  process.stdout.write(`- ${name} ... `);
  const value = action();
  process.stdout.write('ok\n');
  return value;
}

async function main() {
  console.log(`Contexa CLI smoke test: ${executable || `node ${path.relative(process.cwd(), CLI_PATH)}`}`);
  const sandbox = await createSandbox('ctxa-binary-smoke-');
  try {
    const env = cliEnv(sandbox);

    step('--version matches release-manifest cliVersion', () => {
      const result = run(['--version'], env);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), releaseManifest.cliVersion);
    });

    step('--help lists init, doctor and reset', () => {
      const result = run(['--help'], env);
      assert.equal(result.code, 0, result.stderr);
      for (const command of ['init', 'doctor', 'reset']) {
        assert.match(result.stdout, new RegExp(`^\\s+${command}\\b`, 'm'), `--help is missing ${command}`);
      }
    });

    const project = await createGradleProject(sandbox.root, 'smoke-app', { bootVersion: '3.5.4', security: true });
    const before = await snapshotDirectory(project);
    const buildPath = path.join(project, 'build.gradle');
    const configPath = path.join(project, 'src', 'main', 'resources', 'config', 'application.yml');
    const mainPath = path.join(project, 'src', 'main', 'java', 'example', 'SampleApplication.java');

    step('init --yes changes the fixture project', () => {
      const result = run(['init', '--yes', '--dir', project], env);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const build = fs.readFileSync(buildPath, 'utf8');
      assert.equal(starterCount(build), 1, 'build.gradle has the Contexa starter');
      assert.ok(build.includes(`ai.ctxa:spring-boot-starter-contexa:${releaseManifest.starter.version}`));
      assert.ok(fs.existsSync(configPath), 'src/main/resources/config/application.yml was created');
      assert.match(fs.readFileSync(configPath, 'utf8'), /^contexa:/m);
      // The fixture declares its own SecurityFilterChain, so the annotation is the SANDBOX default.
      assert.match(fs.readFileSync(mainPath, 'utf8'), /\n@EnableAISecurity\n@SpringBootApplication/);
    });

    step('reset --yes restores every byte and leaves no trace', () => {
      const result = run(['reset', '--yes', '--dir', project], env);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const summary = resetResult(result.stdout);
      assert.ok(summary, 'reset prints its CONTEXA_RESET_RESULT line');
      assert.equal(summary.result, 'SUCCESS');
    });
    assert.deepEqual(await snapshotDirectory(project), before, 'the project is byte-for-byte the original');
    assert.equal(fs.existsSync(path.join(project, 'contexa')), false);
    console.log('All smoke checks passed.');
  } finally {
    await fs.remove(sandbox.root);
  }
}

main().catch(error => {
  console.error(`\nSmoke test failed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
