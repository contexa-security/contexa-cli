'use strict';

// Shared helpers for tests that run the CLI as a child process.
//
// Every child gets an isolated environment:
//   - the PC-wide Contexa state (local services, registered projects) lives under a temporary
//     LOCALAPPDATA (Windows) / XDG_CONFIG_HOME (Linux, macOS),
//   - API keys are saved under a temporary home folder (HOME / USERPROFILE),
//   - real OPENAI_API_KEY / ANTHROPIC_API_KEY values are replaced with fake ones,
//   - CONTEXA_TEST_LOCAL_SERVICES=fake, CONTEXA_TEST_DEPENDENCY_CHECK=pass,
//     CONTEXA_TEST_JAVA_VERSION=17 keep Docker,
//     Gradle/Maven, Java and the network out of the run.

const crypto = require('node:crypto');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'src', 'index.js');

const FAKE_KEYS = Object.freeze({
  OPENAI_API_KEY: 'sk-test-fake-openai-key-0000',
  ANTHROPIC_API_KEY: 'sk-ant-test-fake-anthropic-key-0000',
});

// Values from the developer's shell that would change what the CLI writes or where it looks.
const CLEARED = [
  'CONTEXA_SPRING_AI_VERSION', 'CONTEXA_SAMPLE_SPRING_BOOT_VERSION',
  'CONTEXA_OLLAMA_CHAT_MODEL', 'CONTEXA_OLLAMA_EMBEDDING_MODEL', 'CONTEXA_OLLAMA_PULL_TIMEOUT_MS',
  'CONTEXA_DB_URL', 'CONTEXA_DB_USERNAME', 'CONTEXA_DB_PASSWORD', 'CONTEXA_OLLAMA_BASE_URL',
  'CONTEXA_MAIL_HOST', 'CONTEXA_MAIL_PORT', 'CONTEXA_PROJECT', 'CONTEXA_TEST_GRADLE_INIT_SCRIPT',
  'CONTEXA_RESET_RESULT_JSON', 'MAVEN_ARGS', 'LC_ALL', 'LANG', 'FORCE_COLOR', 'NO_COLOR',
];

// Environment variable names are case-insensitive on Windows (Path vs PATH).
function setVariable(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
  if (value !== undefined && value !== null) env[name] = String(value);
}

async function createSandbox(prefix = 'ctxa-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sandbox = {
    root,
    home: path.join(root, 'home'),
    localAppData: path.join(root, 'localappdata'),
    xdg: path.join(root, 'xdg'),
  };
  await Promise.all([sandbox.home, sandbox.localAppData, sandbox.xdg].map(dir => fs.ensureDir(dir)));
  return sandbox;
}

// The PC-wide Contexa folder (local services, state.json) inside the sandbox.
function contexaHome(sandbox) {
  return process.platform === 'win32'
    ? path.join(sandbox.localAppData, 'Contexa')
    : path.join(sandbox.xdg, 'contexa');
}

function localStatePath(sandbox) {
  return path.join(contexaHome(sandbox), 'local', 'state.json');
}

function cliEnv(sandbox, overrides = {}) {
  const env = { ...process.env };
  for (const name of CLEARED) setVariable(env, name, undefined);
  for (const [name, value] of Object.entries(FAKE_KEYS)) setVariable(env, name, value);
  setVariable(env, 'LOCALAPPDATA', sandbox.localAppData);
  setVariable(env, 'XDG_CONFIG_HOME', sandbox.xdg);
  setVariable(env, 'HOME', sandbox.home);
  setVariable(env, 'USERPROFILE', sandbox.home);
  setVariable(env, 'CONTEXA_LANG', 'en');
  setVariable(env, 'CONTEXA_TEST_LOCAL_SERVICES', 'fake');
  setVariable(env, 'CONTEXA_TEST_DEPENDENCY_CHECK', 'pass');
  setVariable(env, 'CONTEXA_TEST_JAVA_VERSION', '17');
  // With Java 17 the CLI also asks Java for native.encoding (MS949 on a Korean Windows PC) and
  // warns when it is not UTF-8; tests decide the encoding themselves.
  for (const [name, value] of Object.entries(overrides)) setVariable(env, name, value);
  return env;
}

// PATH without the folders that hold a docker executable, for commands that would otherwise
// probe the real Docker (doctor asks Docker about the database container when it is down).
function pathWithoutDocker(env) {
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
  const entries = String((key && env[key]) || '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['docker.exe', 'docker.cmd', 'docker.bat', 'docker'] : ['docker'];
  return entries.filter(dir => !names.some(name => fs.existsSync(path.join(dir, name)))).join(path.delimiter);
}

function cliCommand() {
  return { command: process.execPath, prefix: [CLI_PATH] };
}

function runCli(args, { env, cwd = ROOT, timeoutMs = 60000, input } = {}) {
  const { command, prefix } = cliCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function runCliSync(args, { env, cwd = ROOT, timeoutMs = 60000 } = {}) {
  const { command, prefix } = cliCommand();
  const result = spawnSync(command, [...prefix, ...args], {
    cwd, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, input: '',
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}\n${result.stderr || ''}`,
    error: result.error,
  };
}

// The CONTEXA_RESET_RESULT line reset prints for scripts (stdout is not a terminal here).
function resetResult(output) {
  const line = String(output).split(/\r?\n/).find(item => item.startsWith('CONTEXA_RESET_RESULT '));
  return line ? JSON.parse(line.slice('CONTEXA_RESET_RESULT '.length)) : null;
}

const SECURITY_CONFIG = [
  'package example;',
  '',
  'import org.springframework.context.annotation.Bean;',
  'import org.springframework.context.annotation.Configuration;',
  'import org.springframework.security.config.annotation.web.builders.HttpSecurity;',
  'import org.springframework.security.web.SecurityFilterChain;',
  '',
  '@Configuration',
  'public class SecurityConfig {',
  '    @Bean',
  '    SecurityFilterChain appChain(HttpSecurity http) throws Exception {',
  '        return http.build();',
  '    }',
  '}',
  '',
].join('\n');

// A Gradle Spring Boot application like the ones users run `contexa init` in.
async function createGradleProject(parent, name, options = {}) {
  const bootVersion = options.bootVersion || '3.5.4';
  const project = path.join(parent, name);
  const files = {
    'settings.gradle': `rootProject.name = '${options.projectName || name.replace(/[^a-zA-Z0-9-]/g, '-')}'\n`,
    'build.gradle': [
      'plugins {',
      "    id 'java'",
      `    id 'org.springframework.boot' version '${bootVersion}'`,
      "    id 'io.spring.dependency-management' version '1.1.7'",
      '}',
      '',
      'repositories {',
      '    mavenCentral()',
      '}',
      '',
      'dependencies {',
      "    implementation 'org.springframework.boot:spring-boot-starter-web'",
      ...(options.security ? ["    implementation 'org.springframework.boot:spring-boot-starter-security'"] : []),
      "    testImplementation 'org.springframework.boot:spring-boot-starter-test'",
      '}',
      '',
    ].join('\n'),
    'src/main/resources/application.yml': options.yml || 'server:\n  port: 9080\nhost-owned:\n  marker: keep\n',
    'src/main/java/example/SampleApplication.java': [
      'package example;',
      '',
      'import org.springframework.boot.SpringApplication;',
      'import org.springframework.boot.autoconfigure.SpringBootApplication;',
      '',
      '@SpringBootApplication',
      'public class SampleApplication {',
      '    public static void main(String[] args) {',
      '        SpringApplication.run(SampleApplication.class, args);',
      '    }',
      '}',
      '',
    ].join('\n'),
    ...(options.security ? { 'src/main/java/example/SecurityConfig.java': SECURITY_CONFIG } : {}),
    ...(options.extraFiles || {}),
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.outputFile(path.join(project, ...relative.split('/')), content);
  }
  return project;
}

async function snapshotDirectory(rootDir, { exclude = [] } = {}) {
  const snapshot = [];
  async function visit(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (exclude.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) {
        snapshot.push({ path: `${relative}/`, type: 'directory' });
        await visit(absolute);
      } else {
        snapshot.push({
          path: relative,
          type: 'file',
          sha256: crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex'),
        });
      }
    }
  }
  if (await fs.pathExists(rootDir)) await visit(rootDir);
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

function starterCount(buildText) {
  return (String(buildText).match(/ai\.ctxa:spring-boot-starter-contexa/g) || []).length;
}

module.exports = {
  ROOT,
  CLI_PATH,
  FAKE_KEYS,
  createSandbox,
  contexaHome,
  localStatePath,
  cliEnv,
  setVariable,
  pathWithoutDocker,
  runCli,
  runCliSync,
  resetResult,
  createGradleProject,
  snapshotDirectory,
  starterCount,
};
