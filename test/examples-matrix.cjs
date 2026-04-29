'use strict';

// End-to-end matrix runner against contexa-examples.
//
// For each contexa-example-* module:
//   1. Snapshot (yml + build.gradle)
//   2. Run `contexa init --yes` (no flags, infra=skip per new policy)
//   3. Inspect post-init artifacts:
//        - yml parses cleanly (js-yaml strict-duplicate-key on by default)
//        - top-level "contexa:" appears exactly once
//        - CLI-managed keys exist with expected values
//        - user keys present in the snapshot are still present
//        - spring.* sub-tree preserved verbatim
//        - build file has the contexa starter (or already had it)
//   4. Try `gradle :module:compileJava` to confirm dependency resolution
//      and yml binding compatibility (only if --compile is requested)
//   5. Restore snapshot and clean up .bak files
//
// Then a separate phase runs the same sequence with --distributed --no-docker
// on a single representative module to confirm the distributed path works
// without actually starting compose (we already have ctxa-test-* infra up).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');                       // contexa-cli
const CLI = path.join(ROOT, 'src', 'index.js');
const EXAMPLES = path.resolve(ROOT, '..', 'contexa-examples');

const MODE_DISTRIBUTED = process.argv.includes('--distributed');
const RUN_COMPILE = process.argv.includes('--compile');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();

function listModules() {
  return fs.readdirSync(EXAMPLES, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('contexa-example-'))
    .map(d => path.join(EXAMPLES, d.name))
    .filter(p => ONLY ? path.basename(p) === ONLY : true);
}

function ymlPathOf(moduleDir)   { return path.join(moduleDir, 'src/main/resources/application.yml'); }
function propsPathOf(moduleDir) { return path.join(moduleDir, 'src/main/resources/application.properties'); }
function buildPathOf(moduleDir) {
  for (const f of ['build.gradle', 'build.gradle.kts', 'pom.xml']) {
    const p = path.join(moduleDir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function snapshot(moduleDir) {
  const snap = {};
  for (const p of [ymlPathOf(moduleDir), propsPathOf(moduleDir), buildPathOf(moduleDir)].filter(Boolean)) {
    if (fs.existsSync(p)) snap[p] = fs.readFileSync(p, 'utf8');
  }
  return snap;
}

function restore(moduleDir, snap) {
  // Remove anything contexa-cli created that was not in the snapshot.
  const newFiles = [
    'docker-compose.yml', 'docker-compose.yml.bak',
    path.join('initdb', '01-core-ddl.sql'),
    path.join('initdb', '02-dml.sql'),
  ];
  for (const rel of newFiles) {
    const f = path.join(moduleDir, rel);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  // Remove the initdb directory if now empty.
  const initdb = path.join(moduleDir, 'initdb');
  if (fs.existsSync(initdb)) {
    try {
      const left = fs.readdirSync(initdb);
      if (left.length === 0) fs.rmdirSync(initdb);
    } catch {}
  }
  // Remove .bak files contexa-cli created.
  for (const baseDir of [moduleDir, path.join(moduleDir, 'src/main/resources')]) {
    if (!fs.existsSync(baseDir)) continue;
    for (const f of fs.readdirSync(baseDir)) {
      if (f.endsWith('.bak')) fs.rmSync(path.join(baseDir, f), { force: true });
    }
  }
  // Restore tracked files from the snapshot.
  for (const [p, content] of Object.entries(snap)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function runInit(moduleDir, extraArgs = []) {
  const args = [CLI, 'init', '--yes', '--dir', moduleDir, ...extraArgs];
  const res = spawnSync('node', args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env,
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error ? String(res.error) : null,
  };
}

function loadYml(p) {
  if (!fs.existsSync(p)) return { ok: false, reason: 'application.yml not found' };
  const text = fs.readFileSync(p, 'utf8');
  try {
    const root = yaml.load(text); // js-yaml 4 throws on duplicate top-level keys
    return { ok: true, text, root: root || {} };
  } catch (err) {
    return { ok: false, reason: `parse error: ${err.message}`, text };
  }
}

function getPath(obj, parts) {
  let cur = obj;
  for (const k of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function flatten(obj, prefix, out) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const k of Object.keys(obj)) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = obj;
  }
}

function inspectModule(moduleDir, snap, init, distributed) {
  const issues = [];   // { severity, message }
  const facts = {};

  // Init exit code
  facts.initExit = init.code;
  if (init.code !== 0) {
    issues.push({ severity: 'error', message: `init exit code ${init.code}: ${init.stderr.trim() || init.stdout.trim().slice(-200)}` });
  }

  // application.yml inspection
  const ymlPath = ymlPathOf(moduleDir);
  const after = loadYml(ymlPath);
  facts.ymlExists = fs.existsSync(ymlPath);
  if (!after.ok) {
    issues.push({ severity: 'error', message: `yml after init: ${after.reason}` });
    return { facts, issues };
  }

  // Top-level contexa: occurrence count (must be exactly 1)
  const occ = (after.text.match(/^contexa\s*:/gm) || []).length;
  facts.contexaOccurrences = occ;
  if (occ !== 1) {
    issues.push({ severity: 'error', message: `top-level contexa: appears ${occ} times (Spring Boot 3.x will reject duplicates)` });
  }

  // CLI-managed keys
  const must = {
    'contexa.security.zerotrust.mode':              v => v === 'SHADOW' || v === 'ENFORCE',
    'contexa.hcad.geoip.enabled':                   v => v === true,
    'contexa.datasource.isolation.contexa-owned-application': v => v === true,
    'contexa.llm.selection.chat.priority':          v => typeof v === 'string' && v.length > 0,
    'contexa.llm.selection.embedding.priority':     v => typeof v === 'string' && v.length > 0,
    'contexa.datasource.url':                       v => typeof v === 'string' && v.includes('CONTEXA_DB_URL') || (typeof v === 'string' && v.length > 0),
    'contexa.datasource.username':                  v => typeof v === 'string' && v.length > 0,
    'contexa.datasource.password':                  v => typeof v === 'string' && v.length > 0,
  };
  facts.managedKeys = {};
  for (const [k, validate] of Object.entries(must)) {
    const v = getPath(after.root, k.split('.'));
    facts.managedKeys[k] = v;
    if (v === undefined) {
      issues.push({ severity: 'error', message: `missing CLI-managed key ${k}` });
    } else if (!validate(v)) {
      issues.push({ severity: 'error', message: `CLI-managed key ${k} has unexpected value: ${JSON.stringify(v)}` });
    }
  }

  // Distributed mode key
  if (distributed) {
    const im = getPath(after.root, ['contexa', 'infrastructure', 'mode']);
    facts.infrastructureMode = im;
    if (im !== 'DISTRIBUTED') {
      issues.push({ severity: 'error', message: `--distributed expected contexa.infrastructure.mode=DISTRIBUTED, got ${JSON.stringify(im)}` });
    }
  }

  // Preservation of user-set contexa.* and spring.* keys.
  // Compare snapshot before vs after.
  const beforeText = snap[ymlPath] || '';
  let beforeRoot = {};
  if (beforeText) {
    try { beforeRoot = yaml.load(beforeText) || {}; } catch { beforeRoot = {}; }
  }
  const beforeFlat = {}, afterFlat = {};
  flatten(beforeRoot, '', beforeFlat);
  flatten(after.root, '', afterFlat);

  // Force-overwritten keys should NOT trigger preservation failures even if
  // their values changed.
  const forceOverwriteKeys = new Set([
    'contexa.security.zerotrust.mode',
    'contexa.hcad.geoip.enabled',
    'contexa.hcad.geoip.dbPath',
    'contexa.datasource.isolation.contexa-owned-application',
    'contexa.llm.selection.chat.priority',
    'contexa.llm.selection.embedding.priority',
    'contexa.infrastructure.mode',
  ]);

  facts.userKeyDrift = [];
  for (const [k, v] of Object.entries(beforeFlat)) {
    if (forceOverwriteKeys.has(k)) continue;
    const after = afterFlat[k];
    if (after === undefined) {
      issues.push({ severity: 'error', message: `user key dropped: ${k} (was ${JSON.stringify(v)})` });
      facts.userKeyDrift.push({ key: k, before: v, after: undefined });
    } else if (JSON.stringify(after) !== JSON.stringify(v)) {
      issues.push({ severity: 'warning', message: `user key changed: ${k} (was ${JSON.stringify(v)} -> ${JSON.stringify(after)})` });
      facts.userKeyDrift.push({ key: k, before: v, after });
    }
  }

  // Build file inspection
  const buildPath = buildPathOf(moduleDir);
  facts.buildPath = buildPath ? path.basename(buildPath) : null;
  if (buildPath && fs.existsSync(buildPath)) {
    const buildText = fs.readFileSync(buildPath, 'utf8');
    facts.buildHasContexta = buildText.includes('spring-boot-starter-contexa');
    if (!facts.buildHasContexta) {
      issues.push({ severity: 'warning', message: 'build file does not contain spring-boot-starter-contexa (multi-module parent may inject it)' });
    }
    const occCount = (buildText.match(/spring-boot-starter-contexa/g) || []).length;
    if (occCount > 1) {
      issues.push({ severity: 'error', message: `spring-boot-starter-contexa appears ${occCount} times in build file (duplicate dependency line)` });
    }
    facts.buildContexaOccurrences = occCount;

    if (distributed) {
      facts.buildHasRedisson = buildText.includes('redisson');
      facts.buildHasKafka = buildText.includes('spring-kafka');
      if (!facts.buildHasRedisson) {
        issues.push({ severity: 'error', message: '--distributed expected redisson dependency in build file' });
      }
      if (!facts.buildHasKafka) {
        issues.push({ severity: 'error', message: '--distributed expected spring-kafka dependency in build file' });
      }
    }
  } else {
    issues.push({ severity: 'warning', message: 'build file (build.gradle / pom.xml) not found in module directory' });
  }

  // Infra side-effects: --distributed leaves docker-compose.yml + initdb/.
  // Without --distributed the new policy is "do not touch infra".
  facts.composeWritten = fs.existsSync(path.join(moduleDir, 'docker-compose.yml'));
  facts.initdbWritten  = fs.existsSync(path.join(moduleDir, 'initdb'));
  if (!distributed) {
    if (facts.composeWritten) {
      issues.push({ severity: 'error', message: 'docker-compose.yml was created without --distributed (policy: opt-in only)' });
    }
    if (facts.initdbWritten) {
      issues.push({ severity: 'error', message: 'initdb/ was created without --distributed (policy: opt-in only)' });
    }
  } else {
    if (!facts.composeWritten) {
      issues.push({ severity: 'error', message: '--distributed: docker-compose.yml was not generated' });
    }
    if (!facts.initdbWritten) {
      issues.push({ severity: 'error', message: '--distributed: initdb/ was not generated' });
    }
  }

  return { facts, issues };
}

function compileModule(moduleDir) {
  const moduleName = path.basename(moduleDir);
  const wrapperBat = path.join(EXAMPLES, 'gradlew.bat');
  const wrapperSh = path.join(EXAMPLES, 'gradlew');
  const isWin = process.platform === 'win32';
  const wrapper = isWin && fs.existsSync(wrapperBat) ? wrapperBat
                : fs.existsSync(wrapperSh) ? wrapperSh
                : null;
  if (!wrapper) return { code: -1, stdout: '', stderr: 'gradlew not found at examples root', error: 'no-wrapper' };
  // .bat needs the cmd.exe shell on Windows; spawnSync without shell:true cannot
  // execute it directly. Use shell:true and quote paths to be safe.
  const cmd = isWin ? `"${wrapper}" :${moduleName}:compileJava --no-daemon -x test`
                    : `"${wrapper}" :${moduleName}:compileJava --no-daemon -x test`;
  const res = spawnSync(cmd, {
    cwd: EXAMPLES, encoding: 'utf8', timeout: 600000, env: process.env, shell: true,
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error ? String(res.error) : null,
  };
}

async function main() {
  const modules = listModules();
  console.log(`Found ${modules.length} contexa-example-* modules`);
  console.log(`Mode: ${MODE_DISTRIBUTED ? '--distributed --no-docker' : 'default (no infra)'}${RUN_COMPILE ? ' + compile' : ''}`);
  console.log('');

  const results = [];
  for (const dir of modules) {
    const name = path.basename(dir);
    process.stdout.write(`[${name}] init... `);
    const snap = snapshot(dir);
    const init = runInit(dir, MODE_DISTRIBUTED ? ['--distributed', '--no-docker'] : []);
    const inspection = inspectModule(dir, snap, init, MODE_DISTRIBUTED);
    let compile = null;
    if (RUN_COMPILE && inspection.issues.filter(i => i.severity === 'error').length === 0) {
      process.stdout.write('compile... ');
      compile = compileModule(dir);
    }
    restore(dir, snap);

    const errors = inspection.issues.filter(i => i.severity === 'error').length;
    const warnings = inspection.issues.filter(i => i.severity === 'warning').length;
    const tag = errors > 0 ? 'FAIL' : warnings > 0 ? 'WARN' : 'PASS';
    process.stdout.write(`${tag} (${errors}E ${warnings}W)`);
    if (compile) process.stdout.write(compile.code === 0 ? ' compile=ok' : ` compile=FAIL(${compile.code})`);
    process.stdout.write('\n');

    results.push({ name, init, inspection, compile });
  }

  // Aggregate report
  console.log('\n========== SUMMARY ==========');
  const passed  = results.filter(r => r.inspection.issues.filter(i => i.severity === 'error').length === 0).length;
  const compileOk = results.filter(r => r.compile && r.compile.code === 0).length;
  const compileBad = results.filter(r => r.compile && r.compile.code !== 0).length;
  console.log(`Init  : ${passed}/${results.length} passed`);
  if (RUN_COMPILE) console.log(`Compile: ${compileOk}/${results.length} passed (${compileBad} failed)`);

  console.log('\n========== ALL ISSUES ==========');
  for (const r of results) {
    const all = r.inspection.issues.slice();
    if (r.compile && r.compile.code !== 0) {
      const tail = (r.compile.stderr || r.compile.stdout || '').trim().split(/\r?\n/).slice(-15).join('\n');
      all.push({ severity: 'error', message: `gradle compileJava exit ${r.compile.code}\n${tail}` });
    }
    if (all.length === 0) continue;
    console.log(`\n--- ${r.name} ---`);
    for (const i of all) {
      const sym = i.severity === 'error' ? 'E' : i.severity === 'warning' ? 'W' : 'I';
      console.log(`  [${sym}] ${i.message}`);
    }
  }

  console.log('');
  process.exit(passed === results.length && compileBad === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(2); });
