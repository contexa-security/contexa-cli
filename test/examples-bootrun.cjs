'use strict';

// Boot-run sanity check against ctxa-test-* infrastructure.
// Picks one or more example modules, runs `contexa init --yes` to populate
// the contexa.* keys on application.yml, points spring.*/contexa.* at the
// test infra via env vars, runs `gradle :module:bootRun` until /actuator/health
// (or /) responds, then kills the process and restores the snapshot.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'index.js');
const EXAMPLES = path.resolve(ROOT, '..', 'contexa-examples');

const MODULE_PORTS = {
  'contexa-example-ai-lab': 8093,
  'contexa-example-ai-llm': 8095,
  'contexa-example-ai-pipeline': 8094,
  'contexa-example-iam-dynamic-auth': 8090,
  'contexa-example-iam-permission': 8092,
  'contexa-example-iam-protectable-analysis': 8091,
  'contexa-example-identity-asep': 8088,
  'contexa-example-identity-dsl': 8083,
  'contexa-example-identity-mfa': 8087,
  'contexa-example-identity-mfa-multi': 8088,
  'contexa-example-identity-oauth2': 8089,
  'contexa-example-identity-ott': 8086,
  'contexa-example-identity-rest': 8085,
  'contexa-example-legacy-system': 9090,
  'contexa-example-protectable': 8082,
  'contexa-example-quickstart': 8081,
  'contexa-example-shadow-enforce': 8084,
};

function bootEnv() {
  return Object.assign({}, process.env, {
    // Host application DB (spring.datasource.*) - relaxed binding via env
    DB_USERNAME: 'contexa_test',
    DB_PASSWORD: 'contexa_test_pw',
    DB_URL: 'jdbc:postgresql://localhost:15432/contexa_test',
    SPRING_DATASOURCE_URL: 'jdbc:postgresql://localhost:15432/contexa_test',
    SPRING_DATASOURCE_USERNAME: 'contexa_test',
    SPRING_DATASOURCE_PASSWORD: 'contexa_test_pw',
    // Contexa-owned DB (contexa.datasource.*). The starter REQUIRES this set.
    CONTEXA_DB_URL: 'jdbc:postgresql://localhost:15432/contexa_test',
    CONTEXA_DB_USERNAME: 'contexa_test',
    CONTEXA_DB_PASSWORD: 'contexa_test_pw',
    CONTEXA_DATASOURCE_URL: 'jdbc:postgresql://localhost:15432/contexa_test',
    CONTEXA_DATASOURCE_USERNAME: 'contexa_test',
    CONTEXA_DATASOURCE_PASSWORD: 'contexa_test_pw',
    CONTEXA_DATASOURCE_DRIVER_CLASS_NAME: 'org.postgresql.Driver',
    CONTEXA_DATASOURCE_ISOLATION_CONTEXAOWNEDAPPLICATION: 'true',
    // Ollama / Redis / Kafka pointed at the test infra
    OLLAMA_BASE_URL: 'http://127.0.0.1:21434',
    SPRING_AI_OLLAMA_BASE_URL: 'http://127.0.0.1:21434',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '16379',
    SPRING_DATA_REDIS_HOST: 'localhost',
    SPRING_DATA_REDIS_PORT: '16379',
    KAFKA_BOOTSTRAP_SERVERS: 'localhost:19092',
    SPRING_KAFKA_BOOTSTRAP_SERVERS: 'localhost:19092',
  });
}

function snapshotModule(moduleDir) {
  const snap = {};
  const candidates = [
    path.join(moduleDir, 'src/main/resources/application.yml'),
    path.join(moduleDir, 'src/main/resources/application.properties'),
    path.join(moduleDir, 'build.gradle'),
    path.join(moduleDir, 'build.gradle.kts'),
    path.join(moduleDir, 'pom.xml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) snap[p] = fs.readFileSync(p, 'utf8');
  }
  return snap;
}

function restoreModule(moduleDir, snap) {
  for (const [p, content] of Object.entries(snap)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  // Drop .bak files contexa-cli created.
  for (const baseDir of [moduleDir, path.join(moduleDir, 'src/main/resources')]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const f of fs.readdirSync(baseDir)) {
      if (f.endsWith('.bak')) fs.rmSync(path.join(baseDir, f), { force: true });
    }
  }
}

function runInit(moduleDir) {
  const res = spawnSync('node', [CLI, 'init', '--yes', '--dir', moduleDir], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000, env: process.env,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function pingHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/actuator/health', timeout: 1500 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function pingRoot(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 1500 }, res => {
      resolve({ status: res.statusCode });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function bootRunModule(moduleName) {
  const port = MODULE_PORTS[moduleName];
  if (!port) return { module: moduleName, ok: false, reason: 'no port mapping' };

  const moduleDir = path.join(EXAMPLES, moduleName);
  const snap = snapshotModule(moduleDir);

  // Run contexa init first so the CLI-managed contexa.* keys are present in
  // application.yml. Without this the starter aborts with "contexa.datasource.url
  // must be configured for @EnableAISecurity" (the platform refuses to share
  // the application's own DB).
  const initRes = runInit(moduleDir);
  if (initRes.code !== 0) {
    restoreModule(moduleDir, snap);
    return { module: moduleName, ok: false, reason: `init failed (${initRes.code}): ${initRes.stderr.slice(-300)}` };
  }

  const wrapper = process.platform === 'win32'
    ? path.join(EXAMPLES, 'gradlew.bat')
    : path.join(EXAMPLES, 'gradlew');
  const cmd = `"${wrapper}" :${moduleName}:bootRun --no-daemon -x test --console=plain`;
  const child = spawn(cmd, {
    cwd: EXAMPLES, env: bootEnv(), shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutTail = '';
  let stderrTail = '';
  child.stdout.on('data', c => { stdoutTail = (stdoutTail + c).slice(-8000); });
  child.stderr.on('data', c => { stderrTail = (stderrTail + c).slice(-8000); });

  // Poll health for up to 180 seconds. Spring Boot + AI starter typically
  // takes 30-90s on cold start. Ollama health probe lives in starter.
  const deadline = Date.now() + 180000;
  let result = null;
  while (Date.now() < deadline) {
    const h = await pingHealth(port);
    if (h && (h.status === 200 || (h.body && h.body.includes('UP')))) { result = { ok: true, via: '/actuator/health', body: h.body }; break; }
    const r = await pingRoot(port);
    if (r && r.status && r.status < 500) { result = { ok: true, via: '/', status: r.status }; break; }
    if (child.exitCode !== null) { result = { ok: false, reason: `process exited ${child.exitCode}` }; break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!result) result = { ok: false, reason: 'timed out after 180s' };

  // Always try to kill the child so we don't leave bootRun running.
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else { child.kill('SIGTERM'); }
  } catch {}
  await new Promise(r => setTimeout(r, 3000));

  // Restore module to its pre-init state regardless of outcome.
  restoreModule(moduleDir, snap);

  return { module: moduleName, ...result, stdoutTail, stderrTail };
}

async function main() {
  const list = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (list.length === 0) { console.error('usage: node examples-bootrun.cjs <module> [module ...]'); process.exit(2); }

  for (const m of list) {
    process.stdout.write(`[${m}] booting... `);
    const t0 = Date.now();
    const r = await bootRunModule(m);
    const ms = Date.now() - t0;
    if (r.ok) {
      console.log(`UP in ${ms}ms (via ${r.via})`);
    } else {
      console.log(`FAIL after ${ms}ms - ${r.reason}`);
      const tail = (r.stderrTail || r.stdoutTail || '').split(/\r?\n/).slice(-20).join('\n');
      if (tail.trim()) console.log('  ---tail---\n' + tail.split('\n').map(l => '  ' + l).join('\n'));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
