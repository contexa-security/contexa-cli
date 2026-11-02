'use strict';

// Runs the application the way the user would (bootRun / spring-boot:run), shows its log as
// usual, and tells in one place whether it came up: the address once Spring reports
// "Started ...", or a short reason when it stops before that. The application keeps running
// until the user presses Ctrl+C.

const { spawn } = require('child_process');
const { buildInvocation, runArgs, runCollect, runSteps, spawnArgs } = require('./build-tool');

const STARTED = /Started \S+ in [0-9.]+ seconds/;
const PORT = /(?:Tomcat|Netty|Jetty|Undertow) started on port(?:\(s\))?:? (\d+)/;

// The part of a failed start log that says why, in a few lines.
function failureSummary(output) {
  const lines = output.split(/\r?\n/);
  const failedAt = lines.findIndex(line => line.includes('APPLICATION FAILED TO START'));
  if (failedAt !== -1) {
    const block = lines.slice(failedAt + 1)
      .filter(line => line.trim() && !/^\*+$/.test(line.trim()))
      .slice(0, 12);
    return block.join('\n');
  }
  const causes = lines.filter(line => line.startsWith('Caused by:'));
  if (causes.length > 0) return causes[causes.length - 1].slice(0, 600);
  const errors = lines.filter(line => /\bERROR\b/.test(line));
  if (errors.length > 0) return errors[errors.length - 1].slice(0, 600);
  return lines.filter(line => line.trim()).slice(-8).join('\n');
}

// Known causes with the fix to suggest (message keys, resolved by the caller).
function failureHint(output) {
  if (/Port \d+ was already in use|Address already in use/.test(output)) return 'run.hint.port';
  if (/contexa\.datasource\.url must be configured/.test(output)) return 'run.hint.datasource';
  if (/Connection to 127\.0\.0\.1:\d+ refused|Connection refused/.test(output)) return 'run.hint.database';
  if (/Spring Boot 4\.x is not supported/.test(output)) return 'run.hint.boot4';
  if (/API key must be set|api-key/i.test(output) && /openai|anthropic/i.test(output)) return 'run.hint.apiKey';
  if (/Could not (?:find|resolve) ai\.ctxa/.test(output)) return 'run.hint.starter';
  return 'run.hint.doctor';
}

async function runApplication(project, callbacks = {}) {
  const invocation = buildInvocation(project);
  if (!invocation) return { outcome: 'no-build-tool' };
  // Preparation steps (a multi-module Maven build installs the modules the application uses).
  const steps = runSteps(invocation);
  for (const step of steps.slice(0, -1)) {
    const prepared = await runCollect(invocation, step);
    if (prepared.status !== 0) {
      return { outcome: 'failed', status: prepared.status, summary: failureSummary(prepared.output), hint: failureHint(prepared.output) };
    }
  }
  return runLastStep(invocation, runArgs(invocation), callbacks);
}

function runLastStep(invocation, runArguments, callbacks) {
  const [command, args] = spawnArgs(invocation, runArguments);
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsVerbatimArguments: process.platform === 'win32',
    });
    if (callbacks.onSpawn) callbacks.onSpawn(child);
    let output = '';
    let started = false;
    let port = null;
    const onData = (stream) => (chunk) => {
      stream.write(chunk);
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
      if (!port) {
        const match = output.match(PORT);
        if (match) port = Number(match[1]);
      }
      if (!started && STARTED.test(output)) {
        started = true;
        if (callbacks.onStarted) callbacks.onStarted({ port: port || 8080 });
      }
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    // Ctrl+C reaches the application too; wait for it to stop instead of exiting first.
    const ignoreInterrupt = () => {};
    process.on('SIGINT', ignoreInterrupt);
    child.on('error', error => {
      process.removeListener('SIGINT', ignoreInterrupt);
      resolve({ outcome: 'failed', summary: error.message, hint: 'run.hint.doctor' });
    });
    child.on('close', status => {
      process.removeListener('SIGINT', ignoreInterrupt);
      if (started) {
        resolve({ outcome: 'stopped', port: port || 8080, status });
      } else {
        resolve({ outcome: 'failed', status, summary: failureSummary(output), hint: failureHint(output) });
      }
    });
  });
}

module.exports = { runApplication, failureSummary, failureHint };
