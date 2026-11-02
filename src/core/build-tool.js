'use strict';

// Runs the project's own build tool: the wrapper when there is one (gradlew / mvnw), otherwise
// gradle / mvn from PATH. Used to check that the added dependencies resolve and to start the
// application. Arguments are fixed by this module, never taken from user input.

const fs = require('fs-extra');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const releaseManifest = require('../../release-manifest.json');

const isWindows = process.platform === 'win32';

// Test hook: an extra Gradle init script (for example a local repository standing in for Maven
// Central). Maven reads MAVEN_ARGS by itself, so it needs no hook.
function testInitScript(options) {
  return options.initScript || process.env.CONTEXA_TEST_GRADLE_INIT_SCRIPT || null;
}

function commandExists(command) {
  const probe = isWindows
    ? spawnSync('where', [command], { stdio: 'ignore', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

// The build root (where the wrapper lives) and the task prefix for the application module.
function buildInvocation(project) {
  const moduleDir = path.resolve(project.projectDir);
  if (project.buildTool === 'gradle') {
    const rootDir = path.resolve(project.gradleRootDir || moduleDir);
    const wrapper = path.join(rootDir, isWindows ? 'gradlew.bat' : 'gradlew');
    const relative = path.relative(rootDir, moduleDir);
    const taskPrefix = relative ? `:${relative.split(path.sep).join(':')}:` : '';
    if (fs.existsSync(wrapper)) return { tool: 'gradle', cwd: rootDir, command: wrapper, wrapper: true, taskPrefix };
    if (commandExists('gradle')) return { tool: 'gradle', cwd: rootDir, command: 'gradle', wrapper: false, taskPrefix };
    return null;
  }
  let rootDir = moduleDir;
  for (let dir = moduleDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, isWindows ? 'mvnw.cmd' : 'mvnw'))) { rootDir = dir; break; }
    if (path.dirname(dir) === dir || !fs.existsSync(path.join(path.dirname(dir), 'pom.xml'))) break;
  }
  const wrapper = path.join(rootDir, isWindows ? 'mvnw.cmd' : 'mvnw');
  const moduleArgs = rootDir === moduleDir ? [] : ['-pl', path.relative(rootDir, moduleDir).split(path.sep).join('/'), '-am'];
  if (fs.existsSync(wrapper)) return { tool: 'maven', cwd: rootDir, command: wrapper, wrapper: true, moduleArgs };
  if (commandExists('mvn')) return { tool: 'maven', cwd: rootDir, command: 'mvn', wrapper: false, moduleArgs };
  return null;
}

// On Windows a .bat/.cmd can only be started through cmd.exe.
function spawnArgs(invocation, args) {
  if (isWindows) {
    return ['cmd.exe', ['/d', '/s', '/c', `"${[invocation.command, ...args].map(quoteForCmd).join(' ')}"`]];
  }
  if (invocation.wrapper) {
    try { fs.chmodSync(invocation.command, 0o755); } catch { /* read-only checkout: sh still runs it */ }
  }
  return [invocation.command, args];
}

function quoteForCmd(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function runCollect(invocation, args, { timeoutMs, env } = {}) {
  return new Promise(resolve => {
    const [command, commandArgs] = spawnArgs(invocation, args);
    const child = spawn(command, commandArgs, {
      cwd: invocation.cwd,
      env: env || process.env,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
    });
    let output = '';
    const append = chunk => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill(); }, timeoutMs || 20 * 60 * 1000);
    child.on('error', error => { clearTimeout(timer); resolve({ status: -1, output: `${output}\n${error.message}` }); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
}

const MAVEN_COORDINATE = '[\\w.-]+:[\\w.-]+:[\\w.-]+(?::[\\w.-]+)?';
// Maven puts several of these on one line, after "Could not resolve dependencies for project
// <the project itself>:", so every occurrence counts and the project's own coordinate never does.
const MAVEN_MISSING = new RegExp(
  `(?:Could not find artifact|Failure to find|Could not transfer artifact|could not be resolved:)\\s+(${MAVEN_COORDINATE})`
  + `|(${MAVEN_COORDINATE}) was not found in`, 'g');

// Lines that tell why dependency resolution failed, de-duplicated and short.
function resolutionProblems(tool, output) {
  const lines = output.split(/\r?\n/);
  const problems = [];
  if (tool === 'gradle') {
    for (const line of lines) {
      const failed = line.match(/([\w.-]+:[\w.-]+(?::[\w.-]+)?)(?: -> [\w.-]+)? FAILED/);
      if (failed) problems.push(failed[1]);
      const notFound = line.match(/Could not find ([\w.-]+:[\w.-]+:[\w.-]+)/);
      if (notFound) problems.push(notFound[1]);
    }
  } else {
    for (const line of lines) {
      for (const missing of line.matchAll(MAVEN_MISSING)) problems.push(missing[1] || missing[2]);
    }
  }
  // "Could not find g:a:1.0." ends a sentence; the period is not part of the version.
  return [...new Set(problems.map(problem => problem.replace(/\.+$/, '')))];
}

function tail(output, count = 12) {
  return output.split(/\r?\n/).filter(line => line.trim()).slice(-count).join('\n');
}

// Resolves the runtime dependency graph without compiling. First runs download Gradle/Maven and
// the dependency metadata, so this can take a few minutes.
async function checkDependencies(project, options = {}) {
  // Test hook: skip the real build tool (tests without Gradle/Maven or network).
  if (process.env.CONTEXA_TEST_DEPENDENCY_CHECK === 'pass') return { skipped: false, ok: true, problems: [], tail: '' };
  if (process.env.CONTEXA_TEST_DEPENDENCY_CHECK === 'starter-missing') {
    return { skipped: false, ok: false, status: 0, problems: [`${releaseManifest.starter.groupId}:${releaseManifest.starter.artifactId}:${releaseManifest.starter.version}`], tail: '' };
  }
  const invocation = buildInvocation(project);
  if (!invocation) return { skipped: true, reason: 'NO_BUILD_TOOL' };
  const args = invocation.tool === 'gradle'
    ? ['-q', '--console=plain', `${invocation.taskPrefix}dependencies`, '--configuration', 'runtimeClasspath']
    : ['-q', '-B', ...invocation.moduleArgs, 'dependency:tree', '-Dscope=runtime'];
  if (testInitScript(options) && invocation.tool === 'gradle') args.unshift('-I', testInitScript(options));
  const result = await runCollect(invocation, args, { timeoutMs: options.timeoutMs });
  const problems = resolutionProblems(invocation.tool, result.output);
  return {
    skipped: false,
    ok: result.status === 0 && problems.length === 0,
    status: result.status,
    problems,
    tail: tail(result.output),
    invocation,
  };
}

// The command a user types to run the application, for messages.
function runCommandText(project) {
  const invocation = buildInvocation(project);
  if (!invocation) return project.buildTool === 'maven' ? 'mvn spring-boot:run' : 'gradle bootRun';
  const command = invocation.wrapper
    // `.\gradlew` works in both PowerShell and cmd; PowerShell does not run a bare `gradlew.bat`.
    ? (invocation.tool === 'gradle' ? (isWindows ? '.\\gradlew' : './gradlew') : (isWindows ? '.\\mvnw' : './mvnw'))
    : invocation.command;
  if (invocation.tool === 'gradle') return `${command} ${invocation.taskPrefix}bootRun`;
  if (!invocation.moduleArgs.length) return `${command} spring-boot:run`;
  // One command per line: Windows PowerShell 5.1 has no `&&`.
  const module = invocation.moduleArgs[1];
  return `${command} -pl ${module} -am install -DskipTests\n${command} -pl ${module} spring-boot:run`;
}

// The commands that start the application, in order. A module of a multi-module Maven build
// first installs the modules it depends on: `-am spring-boot:run` would also run the goal on the
// parent and fail there.
function runSteps(invocation, options = {}) {
  if (invocation.tool === 'gradle') {
    const args = ['--console=plain', `${invocation.taskPrefix}bootRun`];
    if (testInitScript(options)) args.unshift('-I', testInitScript(options));
    return [args];
  }
  if (!invocation.moduleArgs.length) return [['-B', 'spring-boot:run']];
  const module = invocation.moduleArgs[1];
  return [
    ['-B', '-q', '-pl', module, '-am', 'install', '-DskipTests'],
    ['-B', '-pl', module, 'spring-boot:run'],
  ];
}

// The command that runs the application itself (the last step).
function runArgs(invocation, options = {}) {
  const steps = runSteps(invocation, options);
  return steps[steps.length - 1];
}

module.exports = {
  buildInvocation,
  checkDependencies,
  resolutionProblems,
  runCommandText,
  runArgs,
  runSteps,
  spawnArgs,
  runCollect,
};
