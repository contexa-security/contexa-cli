'use strict';

// `contexa init` / `doctor` / `reset` end to end, as child processes, with the test hooks that
// stand in for Docker, the build tool and Java (see test/harness.js). Nothing here reaches the
// network, the real Docker or a real model, and the PC-wide Contexa state lives in a sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');
const yaml = require('js-yaml');
const { spawnSync } = require('node:child_process');

const {
  createSandbox,
  localStatePath,
  cliEnv,
  pathWithoutDocker,
  runCli,
  resetResult,
  createGradleProject,
  snapshotDirectory,
  starterCount,
} = require('./harness');
const { manifestPath, installLockPath, loadManifest } = require('../src/core/manifest');
const releaseManifest = require('../release-manifest.json');

const CONFIG_FILE = path.join('src', 'main', 'resources', 'config', 'application.yml');
const MAIN_CLASS = path.join('src', 'main', 'java', 'example', 'SampleApplication.java');

async function sandboxFor(t, prefix) {
  const sandbox = await createSandbox(prefix);
  t.after(() => fs.remove(sandbox.root));
  return sandbox;
}

function init(project, sandbox, args = [], overrides = {}) {
  return runCli(['init', '--yes', '--dir', project, ...args], { env: cliEnv(sandbox, overrides) });
}

function reset(project, sandbox, args = [], overrides = {}) {
  return runCli(['reset', '--yes', '--dir', project, ...args], { env: cliEnv(sandbox, overrides) });
}

function readConfig(project, file = CONFIG_FILE) {
  return yaml.load(fs.readFileSync(path.join(project, file), 'utf8'));
}

function gitAvailable() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !probe.error && probe.status === 0;
}

function git(project, args) {
  const result = spawnSync('git', [
    '-c', 'user.name=contexa-test', '-c', 'user.email=test@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(project, '.no-hooks')}`,
    ...args,
  ], { cwd: project, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

// --- checks before any change ----------------------------------------------------------------

test('Spring Boot 4 project: exit 1, SPRING_BOOT_UNSUPPORTED, no file changed anywhere', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-boot4-');
  const project = await createGradleProject(sandbox.root, 'boot4', { bootVersion: '4.0.0' });
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /SPRING_BOOT_UNSUPPORTED/);
  assert.match(result.stderr, /Spring Boot 4\.0\.0/);
  assert.doesNotMatch(result.output, /Contexa is set up/);
  assert.deepEqual(await snapshotDirectory(project), before);
  assert.equal(await fs.pathExists(localStatePath(sandbox)), false, 'nothing was prepared on the computer either');
});

test('Spring Boot 2 project: exit 1, SPRING_BOOT_TOO_OLD, no file changed', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-boot2-');
  const project = await createGradleProject(sandbox.root, 'boot2', { bootVersion: '2.7.18' });
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /SPRING_BOOT_TOO_OLD/);
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('Spring Boot 3.4 project: exit 1, SPRING_BOOT_TOO_OLD with the way forward, no file changed (F-52)', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-boot34-');
  const project = await createGradleProject(sandbox.root, 'boot34', { bootVersion: '3.4.13' });
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /SPRING_BOOT_TOO_OLD This project uses Spring Boot 3\.4\.13\. Contexa needs Spring Boot 3\.5\.x/);
  assert.match(result.stderr, /Change the Spring Boot version in the build file to 3\.5\.x/);
  assert.deepEqual(await snapshotDirectory(project), before);
  assert.equal(await fs.pathExists(localStatePath(sandbox)), false, 'no local services prepared');
});

test('a broken pom.xml: exit 1, INVALID_BUILD_FILE, no file changed', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-pom-');
  const project = path.join(sandbox.root, 'broken-pom');
  await fs.outputFile(path.join(project, 'pom.xml'),
    '<project>\n  <artifactId>broken</artifactId>\n  <dependencies>\n    <dependency>\n');
  await fs.outputFile(path.join(project, MAIN_CLASS), '@SpringBootApplication\nclass SampleApplication {}\n');
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /INVALID_BUILD_FILE/);
  assert.match(result.stderr, /Maven XML is malformed/);
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('a build file that is not Spring Boot, and an ambiguous multi-module build, are refused unchanged', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-refused-');
  const plain = path.join(sandbox.root, 'plain');
  await fs.outputFile(path.join(plain, 'build.gradle'), "plugins { id 'java' }\n");
  const plainBefore = await snapshotDirectory(plain);
  const notSpring = await init(plain, sandbox);
  assert.equal(notSpring.code, 1, notSpring.output);
  assert.match(notSpring.stderr, /SPRING_BOOT_REQUIRED/);
  assert.deepEqual(await snapshotDirectory(plain), plainBefore);

  const multi = path.join(sandbox.root, 'multi');
  await fs.outputFile(path.join(multi, 'settings.gradle'), "rootProject.name = 'multi'\ninclude 'a', 'b'\n");
  await fs.outputFile(path.join(multi, 'build.gradle'), "plugins { id 'org.springframework.boot' version '3.5.4' apply false }\n");
  for (const name of ['a', 'b']) {
    await fs.outputFile(path.join(multi, name, 'build.gradle'),
      "plugins { id 'org.springframework.boot' }\ndependencies { implementation 'org.springframework.boot:spring-boot-starter-web' }\n");
  }
  const multiBefore = await snapshotDirectory(multi);
  const ambiguous = await init(multi, sandbox);
  assert.equal(ambiguous.code, 1, ambiguous.output);
  assert.match(ambiguous.stderr, /MODULE_AMBIGUOUS/);
  assert.match(ambiguous.stderr, /\ba\b.*\bb\b/);
  assert.deepEqual(await snapshotDirectory(multi), multiBefore);
});

test('openai without any API key, non-interactive: API_KEY_REQUIRED before anything changes', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-nokey-');
  const project = await createGradleProject(sandbox.root, 'no-key');
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox, ['--provider', 'openai'], { OPENAI_API_KEY: '' });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /API_KEY_REQUIRED/);
  assert.match(result.stderr, /OPENAI_API_KEY/);
  assert.deepEqual(await snapshotDirectory(project), before);
});

// --- the default path --------------------------------------------------------------------------

test('init then reset: the project is byte-for-byte the original and no trace is left', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-cycle-');
  const project = await createGradleProject(sandbox.root, 'shop');
  const before = await snapshotDirectory(project);

  const installed = await init(project, sandbox);
  assert.equal(installed.code, 0, installed.output);
  assert.match(installed.stdout, /Contexa will:/);
  assert.match(installed.stdout, /- create src\/main\/resources\/config\/application\.yml with the Contexa settings/);
  assert.match(installed.stdout, /- use the local mail inbox for sign-in codes \(http:\/\/127\.0\.0\.1:58025\)/);
  assert.match(installed.stdout, /Contexa is set up\./);
  const build = await fs.readFile(path.join(project, 'build.gradle'), 'utf8');
  assert.equal(starterCount(build), 1);
  assert.ok(build.includes(`ai.ctxa:spring-boot-starter-contexa:${releaseManifest.starter.version}`));
  assert.match(build, /spring-ai-bom:1\.1\.8/);
  assert.match(build, /spring-ai-starter-model-ollama/);
  assert.match(await fs.readFile(path.join(project, MAIN_CLASS), 'utf8'),
    /@EnableAISecurity\(mode = SecurityMode\.FULL\)\n@SpringBootApplication/);
  const settings = readConfig(project);
  assert.equal(settings.contexa.datasource.url, '${CONTEXA_DB_URL:jdbc:postgresql://127.0.0.1:55432/contexa_shop}');
  assert.equal(settings.contexa.datasource.isolation['contexa-owned-application'], true);
  assert.equal(settings.contexa.llm.selection.chat.priority, 'ollama');
  assert.equal(settings.spring.mail.port, '${CONTEXA_MAIL_PORT:51025}', 'FULL mode gets the local inbox');
  assert.deepEqual(await fs.readFile(path.join(project, 'src/main/resources/application.yml'), 'utf8'),
    'server:\n  port: 9080\nhost-owned:\n  marker: keep\n');
  assert.equal(await fs.readFile(path.join(project, 'contexa', '.gitignore'), 'utf8'),
    '# Contexa installation record and backups\n*\n');
  assert.equal(await fs.pathExists(installLockPath(project)), false);
  const manifest = await loadManifest(project);
  assert.equal(manifest.transaction.status, 'COMMITTED');
  assert.equal(manifest.metadata.provider, 'ollama');
  assert.equal(manifest.metadata.securityMode, 'full');
  const state = await fs.readJson(localStatePath(sandbox));
  assert.deepEqual(Object.values(state.projects).map(item => item.database), ['contexa_shop']);

  const removed = await reset(project, sandbox);
  assert.equal(removed.code, 0, removed.output);
  const summary = resetResult(removed.stdout);
  assert.equal(summary.result, 'SUCCESS');
  assert.deepEqual(summary.counts, { removed: 1, restored: 2, preserved: 0, conflict: 0, failed: 0 });
  assert.match(removed.stdout, /Contexa was removed from this project\./);
  assert.deepEqual(await snapshotDirectory(project), before);
  assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
  assert.equal(await fs.pathExists(path.join(project, 'src', 'main', 'resources', 'config')), false);
  assert.deepEqual((await fs.readJson(localStatePath(sandbox))).projects, {}, 'the project is unregistered');

  const again = await reset(project, sandbox);
  assert.equal(again.code, 0, again.output);
  assert.equal(resetResult(again.stdout).result, 'NO_OWNED_INSTALLATION');
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('running init again is idempotent: project files stay byte-identical', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-again-');
  const project = await createGradleProject(sandbox.root, 'again');
  const first = await init(project, sandbox);
  assert.equal(first.code, 0, first.output);
  const afterFirst = await snapshotDirectory(project, { exclude: ['contexa'] });
  const trackedFirst = (await loadManifest(project)).files.map(file => file.relativePath).sort();

  for (let run = 0; run < 2; run += 1) {
    const repeated = await init(project, sandbox);
    assert.equal(repeated.code, 0, repeated.output);
    assert.match(repeated.stdout, /Contexa is already set up here/);
    assert.match(repeated.stdout, /- update the Contexa settings in src\/main\/resources\/config\/application\.yml/);
    assert.deepEqual(await snapshotDirectory(project, { exclude: ['contexa'] }), afterFirst);
  }
  const build = await fs.readFile(path.join(project, 'build.gradle'), 'utf8');
  assert.equal(starterCount(build), 1);
  assert.equal((build.match(/spring-ai-bom/g) || []).length, 1);
  assert.equal(((await fs.readFile(path.join(project, MAIN_CLASS), 'utf8')).match(/@EnableAISecurity/g) || []).length, 1);
  const manifest = await loadManifest(project);
  assert.equal(manifest.transaction.status, 'COMMITTED');
  assert.deepEqual(manifest.files.map(file => file.relativePath).sort(), trackedFirst);

  const removed = await reset(project, sandbox);
  assert.equal(removed.code, 0, removed.output);
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 0);
});

test('an empty folder gets the sample application, which is then set up', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-empty-');
  const empty = path.join(sandbox.root, 'empty');
  await fs.ensureDir(empty);
  const result = await init(empty, sandbox);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /Found empty \(Maven, Spring Boot 3\.5\.16\)/);
  const pom = await fs.readFile(path.join(empty, 'pom.xml'), 'utf8');
  assert.match(pom, /<version>3\.5\.16<\/version>/);
  assert.match(pom, /<artifactId>spring-boot-starter-contexa<\/artifactId>/);
  assert.match(pom, /<artifactId>spring-ai-bom<\/artifactId>\s*<version>1\.1\.8<\/version>/);
  const main = await fs.readFile(path.join(empty, 'src/main/java/com/example/empty/EmptyApplication.java'), 'utf8');
  assert.match(main, /@EnableAISecurity\(mode = SecurityMode\.FULL\)\n@SpringBootApplication/);
  assert.match(await fs.readFile(path.join(empty, 'src/main/resources/application.properties'), 'utf8'),
    /^contexa\.iam\.seed\.accounts\.enabled=true$/m);
  assert.ok(await fs.pathExists(path.join(empty, CONFIG_FILE)));
  assert.match(result.stdout, /\.[\\/]mvnw spring-boot:run/);
});

test('a folder with other files gets the sample in contexa-demo and keeps its own files', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-subfolder-');
  const folder = path.join(sandbox.root, 'workspace');
  await fs.outputFile(path.join(folder, 'notes.txt'), 'mine\n');
  const result = await init(folder, sandbox);
  assert.equal(result.code, 0, result.output);
  const sample = path.join(folder, 'contexa-demo');
  assert.ok(await fs.pathExists(path.join(sample, 'pom.xml')));
  assert.ok(await fs.pathExists(path.join(sample, 'contexa', 'manifest.json')));
  assert.ok(await fs.pathExists(path.join(sample, 'src/main/java/com/example/demo/DemoApplication.java')));
  assert.equal(await fs.readFile(path.join(folder, 'notes.txt'), 'utf8'), 'mine\n');
  assert.deepEqual((await fs.readdir(folder)).sort(), ['contexa-demo', 'notes.txt']);
});

// --- failures roll everything back -------------------------------------------------------------

test('starter not resolvable: rolled back, git diff is empty, no contexa/ folder, STARTER_UNAVAILABLE', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-starter-');
  const project = await createGradleProject(sandbox.root, 'starter-missing');
  const useGit = gitAvailable();
  if (useGit) {
    git(project, ['init', '-q']);
    git(project, ['add', '-A']);
    git(project, ['commit', '-q', '-m', 'fixture']);
  } else {
    t.diagnostic('git is not on PATH; comparing a directory snapshot instead');
  }
  const before = await snapshotDirectory(project, { exclude: ['.git'] });
  const result = await init(project, sandbox, [], { CONTEXA_TEST_DEPENDENCY_CHECK: 'starter-missing' });
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /STARTER_UNAVAILABLE/);
  assert.match(result.stderr, /ai\.ctxa:spring-boot-starter-contexa:0\.1\.0/);
  assert.match(result.stdout, /All project changes were undone/);
  assert.equal(await fs.pathExists(path.join(project, 'contexa')), false);
  assert.deepEqual(await snapshotDirectory(project, { exclude: ['.git'] }), before);
  if (useGit) {
    assert.equal(git(project, ['status', '--porcelain', '--untracked-files=all']), '');
    assert.equal(git(project, ['diff', '--stat']), '');
  }
  const state = await fs.readJson(localStatePath(sandbox));
  assert.deepEqual(state.projects, {}, 'a failed init is not registered');
});

test('a read-only build file: FILE_NOT_WRITABLE, rolled back, nothing changed', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0
    ? 'root can write read-only files' : false,
}, async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-readonly-');
  const project = await createGradleProject(sandbox.root, 'read-only');
  const buildPath = path.join(project, 'build.gradle');
  const before = await snapshotDirectory(project);
  await fs.chmod(buildPath, 0o444);
  t.after(() => fs.chmod(buildPath, 0o666).catch(() => {}));
  const result = await init(project, sandbox);
  await fs.chmod(buildPath, 0o666);
  assert.equal(result.code, 1, result.output);
  assert.match(result.stderr, /FILE_NOT_WRITABLE/);
  assert.match(result.stderr, /build\.gradle/);
  assert.doesNotMatch(result.stderr, /could not be undone|rollback failed/i);
  assert.deepEqual(await snapshotDirectory(project), before);
});

// --- choices that shape the settings -----------------------------------------------------------

test('an application with its own SecurityFilterChain gets SANDBOX: bare annotation, no mail inbox', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-sandbox-');
  const project = await createGradleProject(sandbox.root, 'secured', { security: true });
  const result = await init(project, sandbox);
  assert.equal(result.code, 0, result.output);
  const main = await fs.readFile(path.join(project, MAIN_CLASS), 'utf8');
  assert.match(main, /\n@EnableAISecurity\n@SpringBootApplication/);
  assert.match(main, /^import io\.contexa\.contexacommon\.annotation\.EnableAISecurity;$/m);
  assert.equal(main.includes('SecurityMode'), false);
  assert.equal(readConfig(project).spring.mail, undefined, 'no mail settings in SANDBOX mode');
  // F-50: Spring Boot's default user stays (the starter's OAuth2 classes and Contexa's password
  // encoder would leave the application without it), with a password kept outside the project.
  assert.deepEqual(readConfig(project).spring.security, { user: { name: 'user' } });
  assert.equal(readConfig(project).spring.config.import, 'optional:file:${user.home}/.contexa/credentials.properties');
  const credentials = path.join(sandbox.home, '.contexa', 'credentials.properties');
  const kept = (await fs.readFile(credentials, 'utf8')).match(/^spring\.security\.user\.password=\{noop\}([A-Za-z0-9]{16})$/m);
  assert.ok(kept, 'the password is kept with the {noop} prefix');
  assert.match(result.stdout, /keep Spring Boot's default user user, which the starter would turn off, with a password kept in /);
  assert.match(result.stdout, new RegExp(`Your sign-in stays with your application: account user, password ${kept[1]} \\(kept in `));
  const again = await init(project, sandbox);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, new RegExp(`account user, password ${kept[1]} `));
  assert.equal((await fs.readFile(credentials, 'utf8')).match(/spring\.security\.user\.password=/g).length, 1);
  assert.equal((await loadManifest(project)).metadata.securityMode, 'sandbox');
});

test('--provider openai with OPENAI_API_KEY: OpenAI starter and settings, key left to the environment', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-openai-');
  const project = await createGradleProject(sandbox.root, 'openai-app');
  const result = await init(project, sandbox, ['--provider', 'openai']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  const build = await fs.readFile(path.join(project, 'build.gradle'), 'utf8');
  assert.match(build, /spring-ai-starter-model-openai/);
  assert.doesNotMatch(build, /spring-ai-starter-model-ollama|spring-ai-starter-model-anthropic/);
  const settings = readConfig(project);
  assert.equal(settings.contexa.llm.selection.chat.priority, 'openai');
  assert.equal(settings.contexa.llm.selection.embedding.priority, 'openai');
  assert.equal(settings.spring.ai.openai['api-key'], '${OPENAI_API_KEY:}');
  assert.equal(settings.spring.config.import, 'optional:file:${user.home}/.contexa/credentials.properties');
  assert.equal(JSON.stringify(settings).includes('sk-test'), false, 'the key value is never written to the project');
  const kept = await fs.readFile(path.join(sandbox.home, '.contexa', 'credentials.properties'), 'utf8').catch(() => '');
  assert.equal(kept.includes('api-key'), false, 'the key stays in the environment, not in the credentials file');
});

test('--provider anthropic: anthropic and ollama starters, Ollama for embeddings', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-anthropic-');
  const project = await createGradleProject(sandbox.root, 'anthropic-app');
  const result = await init(project, sandbox, ['--provider', 'anthropic']);
  assert.equal(result.code, 0, result.output);
  const build = await fs.readFile(path.join(project, 'build.gradle'), 'utf8');
  assert.match(build, /implementation 'org\.springframework\.ai:spring-ai-starter-model-anthropic'/);
  assert.match(build, /implementation 'org\.springframework\.ai:spring-ai-starter-model-ollama'/);
  assert.doesNotMatch(build, /spring-ai-starter-model-openai/);
  const settings = readConfig(project);
  assert.equal(settings.contexa.llm.selection.chat.priority, 'anthropic,ollama');
  assert.equal(settings.contexa.llm.selection.embedding.priority, 'ollama');
  assert.equal(settings.spring.ai.anthropic['api-key'], '${ANTHROPIC_API_KEY:}');

  // A second run without --provider keeps the provider recorded the first time.
  const repeated = await init(project, sandbox);
  assert.equal(repeated.code, 0, repeated.output);
  assert.equal(readConfig(project).contexa.llm.selection.chat.priority, 'anthropic,ollama');
});

test('the application keeps its own config/application.yml: settings go to application-contexa.yml plus an import', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-userconfig-');
  const project = await createGradleProject(sandbox.root, 'user-config', {
    extraFiles: { 'src/main/resources/config/application.yml': 'app:\n  feature: on\n' },
  });
  const userConfig = path.join(project, CONFIG_FILE);
  const originalUserConfig = await fs.readFile(userConfig);
  const before = await snapshotDirectory(project);
  const result = await init(project, sandbox);
  assert.equal(result.code, 0, result.output);
  const fallback = path.join(project, 'src', 'main', 'resources', 'application-contexa.yml');
  assert.equal(readConfig(project, path.relative(project, fallback)).contexa.security.zerotrust.mode, 'SHADOW');
  const documents = yaml.loadAll(await fs.readFile(userConfig, 'utf8'));
  assert.equal(documents[0].app.feature, 'on');
  assert.equal(documents[1].spring.config.import, 'optional:classpath:application-contexa.yml');

  // F-51: running init again leaves the application's own file (and everything else) as it is.
  const installed = await snapshotDirectory(project, { exclude: ['contexa'] });
  const userConfigInstalled = await fs.readFile(userConfig);
  const again = await init(project, sandbox);
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(await fs.readFile(userConfig), userConfigInstalled);
  assert.deepEqual(await snapshotDirectory(project, { exclude: ['contexa'] }), installed);

  // doctor reads Contexa's settings from application-contexa.yml, not from the application's file.
  const env = cliEnv(sandbox);
  const doctor = await runCli(['doctor', '--dir', project], {
    env: cliEnv(sandbox, { PATH: pathWithoutDocker(env), CONTEXA_OLLAMA_BASE_URL: 'http://127.0.0.1:9' }),
  });
  assert.match(doctor.stdout, /v Contexa settings: src[\\/]main[\\/]resources[\\/]application-contexa\.yml/);
  assert.doesNotMatch(doctor.stdout, /contexa\.datasource\.url is not set/);

  const removed = await reset(project, sandbox);
  assert.equal(removed.code, 0, removed.output);
  assert.deepEqual(await fs.readFile(userConfig), originalUserConfig);
  assert.deepEqual(await snapshotDirectory(project), before);
});

test('an application with its own database: contexa-owned-application is false', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-hostdb-');
  const project = await createGradleProject(sandbox.root, 'host-db', {
    yml: 'spring:\n  datasource:\n    url: jdbc:postgresql://db.internal:5432/shop\n',
  });
  const result = await init(project, sandbox);
  assert.equal(result.code, 0, result.output);
  assert.equal(readConfig(project).contexa.datasource.isolation['contexa-owned-application'], false);
});

test('--db-url uses that PostgreSQL: no local database, password from CONTEXA_DB_PASSWORD, not registered', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-dburl-');
  const project = await createGradleProject(sandbox.root, 'external-db');
  const url = 'jdbc:postgresql://db.example.invalid:5432/contexa';
  const result = await init(project, sandbox, ['--db-url', url, '--db-username', 'app']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /- use your PostgreSQL jdbc:postgresql:\/\/db\.example\.invalid:5432\/contexa/);
  assert.match(result.stdout,
    /Set CONTEXA_DB_PASSWORD \(the password for jdbc:postgresql:\/\/db\.example\.invalid:5432\/contexa\) before starting the application\./);
  const settings = readConfig(project);
  assert.equal(settings.contexa.datasource.url, `\${CONTEXA_DB_URL:${url}}`);
  assert.equal(settings.contexa.datasource.username, '${CONTEXA_DB_USERNAME:app}');
  assert.equal(settings.contexa.datasource.password, '${CONTEXA_DB_PASSWORD}');
  const manifest = await loadManifest(project);
  assert.deepEqual(manifest.metadata.database, { name: null, url, external: true });
  const statePath = localStatePath(sandbox);
  const state = (await fs.pathExists(statePath)) ? await fs.readJson(statePath) : { projects: {} };
  assert.deepEqual(state.projects, {});
});

test('a settings file edited by hand after init is kept on the next run, and reset leaves it as a conflict', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-kept-');
  const project = await createGradleProject(sandbox.root, 'kept');
  const configPath = path.join(project, CONFIG_FILE);
  const first = await init(project, sandbox);
  assert.equal(first.code, 0, first.output);
  const edited = (await fs.readFile(configPath, 'utf8')).replace('mode: SHADOW', 'mode: ENFORCE') + 'custom:\n  mine: true\n';
  await fs.writeFile(configPath, edited);

  const again = await init(project, sandbox);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout,
    /- keep src\/main\/resources\/config\/application\.yml as it is \(you edited it after the last contexa init\)/);
  assert.match(again.stderr,
    /src\/main\/resources\/config\/application\.yml was edited after the last contexa init, so it was left as it is/);
  assert.equal(await fs.readFile(configPath, 'utf8'), edited);

  // Another provider changes what Contexa would write; the kept file gets the exact lines to
  // change, and the user's own edit (ENFORCE) is not among them.
  const switched = await init(project, sandbox, ['--provider', 'openai'], { OPENAI_API_KEY: 'sk-test-not-real' });
  assert.equal(switched.code, 0, switched.output);
  assert.match(switched.stderr, /You edited src\/main\/resources\/config\/application\.yml after the last contexa init, so it was left as it is\. For this setup, change these lines in it:/);
  assert.match(switched.stdout, /contexa\.llm\.selection\.chat\.priority: openai/);
  assert.match(switched.stdout, /spring\.ai\.openai\.api-key: \$\{OPENAI_API_KEY:\}/);
  assert.doesNotMatch(switched.stdout, /zerotrust\.mode/);
  assert.equal(await fs.readFile(configPath, 'utf8'), edited);

  const removed = await reset(project, sandbox);
  assert.equal(removed.code, 1, 'a file that cannot be restored safely is reported');
  const summary = resetResult(removed.stdout);
  assert.equal(summary.result, 'CONFLICT');
  assert.deepEqual(summary.audit.conflict.map(item => item.resource), ['src/main/resources/config/application.yml']);
  assert.equal(await fs.readFile(configPath, 'utf8'), edited, 'the hand-edited file is left as it is');
  assert.equal(starterCount(await fs.readFile(path.join(project, 'build.gradle'), 'utf8')), 0, 'everything else is undone');
});

test('the closing hint shows cd relative below the current folder, absolute elsewhere, and none inside', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-cd-');
  const below = await createGradleProject(sandbox.root, 'below');
  const relative = await runCli(['init', '--yes', '--dir', below], { cwd: sandbox.root, env: cliEnv(sandbox) });
  assert.equal(relative.code, 0, relative.output);
  assert.match(relative.stdout, /^ {4}cd below$/m);
  assert.match(relative.stdout, /^ {4}gradle bootRun$/m);

  const inside = await runCli(['init', '--yes'], { cwd: below, env: cliEnv(sandbox) });
  assert.equal(inside.code, 0, inside.output);
  assert.doesNotMatch(inside.stdout, /^ {4}cd /m);

  const sibling = path.join(sandbox.root, 'sibling');
  await fs.ensureDir(sibling);
  const elsewhere = await runCli(['init', '--yes', '--dir', below], { cwd: sibling, env: cliEnv(sandbox) });
  assert.equal(elsewhere.code, 0, elsewhere.output);
  assert.ok(elsewhere.stdout.split(/\r?\n/).includes(`    cd ${below}`), elsewhere.stdout);
});

// --- Java 17 on a computer whose text encoding is not UTF-8 ------------------------------------

test('bootSupport: Contexa 0.1.0 starts on Spring Boot 3.5.x only', () => {
  const { bootSupport } = require('../src/core/init-application');
  assert.deepEqual(['2.7.18', '3.3.13', '3.4.13', '3.5.0', '3.5.16', '4.0.0', null].map(bootSupport),
    ['too-old', 'too-old', 'too-old', 'supported', 'supported', 'too-new', 'unknown']);
});

// --- doctor ------------------------------------------------------------------------------------

test('doctor lists every check on an installed project (an unreachable database is expected here)', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-doctor-');
  const project = await createGradleProject(sandbox.root, 'doctor-app');
  const installed = await init(project, sandbox);
  assert.equal(installed.code, 0, installed.output);

  const env = cliEnv(sandbox);
  const result = await runCli(['doctor', '--dir', project], {
    env: cliEnv(sandbox, {
      PATH: pathWithoutDocker(env),
      CONTEXA_DB_URL: 'jdbc:postgresql://127.0.0.1:9/contexa_doctor_app',
      CONTEXA_OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    }),
  });
  assert.match(result.stdout, /Contexa doctor \(CLI 0\.2\.0\)/);
  assert.match(result.stdout, /v Project: doctor-app \(Gradle\)/);
  assert.match(result.stdout, /v Spring Boot: 3\.5\.4/);
  assert.match(result.stdout, /v Java: 17/);
  assert.match(result.stdout, /v Contexa starter: spring-boot-starter-contexa:0\.1\.0/);
  assert.match(result.stdout, /v @EnableAISecurity: present/);
  assert.match(result.stdout, /v Contexa settings: src[\\/]main[\\/]resources[\\/]config[\\/]application\.yml/);
  assert.match(result.stdout, /x Contexa database: jdbc:postgresql:\/\/127\.0\.0\.1:9\/contexa_doctor_app does not answer/);
  assert.match(result.stdout, /Start Docker, then run contexa init again/);
  assert.match(result.stdout, /x Ollama: http:\/\/127\.0\.0\.1:9 does not answer/);
  assert.equal(result.code, 1, 'failed checks give exit code 1');
  assert.equal(result.stderr.trim(), '');

  // Nothing of Contexa yet: one line instead of a failure per missing piece.
  const fresh = await createGradleProject(sandbox.root, 'not-installed');
  const notSetUp = await runCli(['doctor', '--dir', fresh], { env: cliEnv(sandbox, { PATH: pathWithoutDocker(env) }) });
  assert.equal(notSetUp.code, 1);
  assert.match(notSetUp.stdout, /v Project: not-installed \(Gradle\)/);
  assert.match(notSetUp.stdout, /x Contexa: not set up in this project yet\s+-> Run: contexa init/);
  assert.doesNotMatch(notSetUp.stdout, /Contexa starter|@EnableAISecurity|Contexa settings|Contexa database|Installation record/);

  // Part of it by hand (the starter only): each missing piece is listed.
  const partial = await createGradleProject(sandbox.root, 'starter-only');
  const partialBuild = path.join(partial, 'build.gradle');
  await fs.writeFile(partialBuild, (await fs.readFile(partialBuild, 'utf8')).replace(
    "    implementation 'org.springframework.boot:spring-boot-starter-web'",
    `    implementation 'org.springframework.boot:spring-boot-starter-web'\n    implementation 'ai.ctxa:spring-boot-starter-contexa:${releaseManifest.starter.version}'`));
  const missing = await runCli(['doctor', '--dir', partial], {
    env: cliEnv(sandbox, { PATH: pathWithoutDocker(env), CONTEXA_OLLAMA_BASE_URL: 'http://127.0.0.1:9' }),
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /v Contexa starter: spring-boot-starter-contexa:0\.1\.0/);
  assert.match(missing.stdout, /x @EnableAISecurity: not on the application class/);
  assert.match(missing.stdout, /! Contexa settings: no settings file written by contexa init/);
  assert.match(missing.stdout, /x Contexa database: contexa\.datasource\.url is not set/);
  assert.match(missing.stdout, /! Installation record: none here/);
});

test('doctor outside a Spring Boot project says so and fails', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-doctor-none-');
  const result = await runCli(['doctor', '--dir', sandbox.root], { env: cliEnv(sandbox) });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /x Project: no Spring Boot application here/);
});

test('reset --services removes the local services once no project uses them', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-services-');
  const first = await createGradleProject(sandbox.root, 'first-app');
  const second = await createGradleProject(sandbox.root, 'second-app');
  assert.equal((await init(first, sandbox)).code, 0);
  assert.equal((await init(second, sandbox)).code, 0);

  const kept = await reset(first, sandbox, ['--services']);
  assert.equal(kept.code, 0, kept.output);
  assert.match(kept.stdout, /The local services are still used by: .*second-app\. They were kept\./);
  assert.equal(await fs.pathExists(localStatePath(sandbox)), true);

  const removed = await reset(second, sandbox, ['--services']);
  assert.equal(removed.code, 0, removed.output);
  assert.match(removed.stderr, /Local Contexa services and their data removed/);
  assert.equal(await fs.pathExists(path.dirname(localStatePath(sandbox))), false, 'no empty local folder is left');
});

test('a state lock left by a contexa process that ended is taken over', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-stale-lock-');
  const project = await createGradleProject(sandbox.root, 'stale-lock');
  const lock = path.join(path.dirname(localStatePath(sandbox)), '.lock');
  const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  await fs.outputFile(lock, JSON.stringify({ pid: Number(ended.stdout), token: 'left-behind' }));
  const result = await init(project, sandbox);
  assert.equal(result.code, 0, result.output);
  assert.equal(await fs.pathExists(lock), false);
  assert.equal(Object.keys((await fs.readJson(localStatePath(sandbox))).projects).length, 1);
});

test('FULL in an existing application: an admin-console password kept outside the project, the same on every run', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-admin-');
  const credentials = path.join(sandbox.home, '.contexa', 'credentials.properties');
  const project = await createGradleProject(sandbox.root, 'admin-app');
  const first = await init(project, sandbox);
  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, /- make a password for the admin-console account admin and keep it in .*credentials\.properties \(outside the project\)/);
  const kept = (await fs.readFile(credentials, 'utf8')).match(/^contexa\.iam\.seed\.admin\.password=([A-Za-z0-9]{16})$/m);
  assert.ok(kept, 'a 16-character password is kept in the credentials file');
  const password = kept[1];
  assert.match(first.stdout, new RegExp(`Admin console: /contexa/admin on your application, account admin, password ${password} \\(kept in `));
  assert.equal(readConfig(project).spring.config.import, 'optional:file:${user.home}/.contexa/credentials.properties');
  const projectFiles = await snapshotDirectory(project);
  for (const entry of projectFiles.filter(item => item.type === 'file')) {
    assert.equal((await fs.readFile(path.join(project, entry.path), 'utf8')).includes(password), false, `${entry.path} has no password`);
  }
  if (process.platform !== 'win32') assert.equal((await fs.stat(credentials)).mode & 0o777, 0o600);

  const again = await init(project, sandbox);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /- use the admin-console password kept in /);
  assert.match(again.stdout, new RegExp(`password ${password} `));
  assert.equal((await fs.readFile(credentials, 'utf8')).match(/contexa\.iam\.seed\.admin\.password=/g).length, 1);

  // An application that configures Contexa's seed accounts itself keeps its own settings.
  const own = await createGradleProject(sandbox.root, 'own-accounts', {
    yml: 'contexa:\n  iam:\n    seed:\n      accounts:\n        enabled: false\n',
  });
  const owned = await init(own, sandbox);
  assert.equal(owned.code, 0, owned.output);
  assert.doesNotMatch(owned.stdout, /admin-console|Admin console/);
  assert.equal((readConfig(own).spring || {}).config, undefined);

  // The application keeps its own sign-in (SANDBOX): no admin-console account from Contexa.
  const secured = await createGradleProject(sandbox.root, 'secured-app', { security: true });
  const sandboxed = await init(secured, sandbox);
  assert.equal(sandboxed.code, 0, sandboxed.output);
  assert.doesNotMatch(sandboxed.stdout, /admin-console|Admin console/);
});

test('Spring Boot default user is left alone when the application has users, OAuth2 or spring.security.user.* of its own', async t => {
  const sandbox = await sandboxFor(t, 'ctxa-flow-bootuser-');
  const usersConfig = [
    'package example;',
    '',
    'import org.springframework.context.annotation.Bean;',
    'import org.springframework.context.annotation.Configuration;',
    'import org.springframework.security.core.userdetails.User;',
    'import org.springframework.security.core.userdetails.UserDetailsService;',
    'import org.springframework.security.provisioning.InMemoryUserDetailsManager;',
    '',
    '@Configuration',
    'public class Users {',
    '    @Bean',
    '    UserDetailsService users() {',
    '        return new InMemoryUserDetailsManager(User.withUsername("kim").password("{noop}pw").roles("USER").build());',
    '    }',
    '}',
    '',
  ].join('\n');
  const own = await createGradleProject(sandbox.root, 'own-users', { security: true, extraFiles: { 'src/main/java/example/Users.java': usersConfig } });
  const oauth = await createGradleProject(sandbox.root, 'own-oauth2', { security: true });
  const oauthBuild = path.join(oauth, 'build.gradle');
  await fs.writeFile(oauthBuild, (await fs.readFile(oauthBuild, 'utf8')).replace(
    "    implementation 'org.springframework.boot:spring-boot-starter-security'",
    "    implementation 'org.springframework.boot:spring-boot-starter-security'\n    implementation 'org.springframework.boot:spring-boot-starter-oauth2-client'"));
  const named = await createGradleProject(sandbox.root, 'own-name', {
    security: true, yml: 'spring:\n  security:\n    user:\n      name: operator\n',
  });
  for (const project of [own, oauth, named]) {
    const result = await init(project, sandbox);
    assert.equal(result.code, 0, result.output);
    assert.equal(((readConfig(project).spring || {}).security), undefined, `${path.basename(project)}: nothing written`);
    assert.doesNotMatch(result.stdout, /default user/, `${path.basename(project)}: no message`);
  }
});
