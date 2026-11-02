'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('../src/core/i18n');
const en = require('../src/i18n/en.json');
const ko = require('../src/i18n/ko.json');

const SRC_DIR = path.join(__dirname, '..', 'src');

function sourceFiles(dir = SRC_DIR, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, files);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function withLocale(code, action) {
  const previous = i18n.getLocale();
  i18n.setLocale(code);
  try {
    return action();
  } finally {
    i18n.setLocale(previous);
  }
}

test('detectLocale: explicit arg wins over env', () => {
  const prev = process.env.CONTEXA_LANG;
  process.env.CONTEXA_LANG = 'ko';
  try {
    assert.equal(i18n.detectLocale('en'), 'en');
  } finally {
    if (prev === undefined) delete process.env.CONTEXA_LANG; else process.env.CONTEXA_LANG = prev;
  }
});

test('detectLocale: CONTEXA_LANG env wins over LANG', () => {
  const prevC = process.env.CONTEXA_LANG;
  const prevA = process.env.LC_ALL;
  const prevL = process.env.LANG;
  process.env.CONTEXA_LANG = 'ko';
  delete process.env.LC_ALL;
  process.env.LANG = 'en_US.UTF-8';
  try {
    assert.equal(i18n.detectLocale(null), 'ko');
  } finally {
    if (prevC === undefined) delete process.env.CONTEXA_LANG; else process.env.CONTEXA_LANG = prevC;
    if (prevA === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = prevA;
    if (prevL === undefined) delete process.env.LANG; else process.env.LANG = prevL;
  }
});

test('detectLocale: parses ko_KR.UTF-8 style tags', () => {
  assert.equal(i18n.detectLocale('ko_KR.UTF-8'), 'ko');
  assert.equal(i18n.detectLocale('en-US'), 'en');
});

test('detectLocale: unsupported tag falls back to default', () => {
  assert.equal(i18n.detectLocale('fr'), 'en');
});

test('setLocale: rejects unsupported codes', () => {
  withLocale('en', () => {
    i18n.setLocale('ko');
    assert.equal(i18n.getLocale(), 'ko');
    i18n.setLocale('xx');
    assert.equal(i18n.getLocale(), 'en');
  });
});

test('t: returns key when missing in both bundles', () => {
  withLocale('ko', () => {
    assert.equal(i18n.t('this.key.does.not.exist'), 'this.key.does.not.exist');
  });
});

test('t: resolves the same key per locale', () => {
  withLocale('ko', () => assert.equal(i18n.t('init.title'), ko['init.title']));
  withLocale('en', () => assert.equal(i18n.t('init.title'), 'set up'));
  assert.notEqual(en['init.title'], ko['init.title']);
});

test('t: substitutes positional placeholders', () => {
  withLocale('en', () => {
    assert.equal(i18n.t('init.found', 'shop', 'Gradle', '3.5.16'), 'Found shop (Gradle, Spring Boot 3.5.16)');
  });
  withLocale('ko', () => {
    assert.equal(i18n.t('init.found', 'shop', 'Gradle', '3.5.16'), 'shop 프로젝트를 찾았습니다 (Gradle, Spring Boot 3.5.16)');
  });
});

test('t: handles single placeholder for spinner messages', () => {
  withLocale('en', () => {
    assert.equal(i18n.t('init.step.modelReady', 'qwen3:8b'), 'Model qwen3:8b is ready');
  });
});

test('formatError: uses the message key when present and keeps the cause otherwise', () => {
  withLocale('en', () => {
    const keyed = Object.assign(new Error('x'), {
      code: 'INVALID_PROVIDER', messageKey: 'common.invalidProvider', messageArgs: ['foo', 'ollama, openai'],
    });
    assert.equal(i18n.formatError(keyed), `INVALID_PROVIDER ${i18n.t('common.invalidProvider', 'foo', 'ollama, openai')}`);
    const plain = Object.assign(new Error('disk full'), { code: 'EIO' });
    assert.match(i18n.formatError(plain), /^EIO .*\n {4}disk full$/);
  });
});

test('en and ko bundles have the same keys', () => {
  const enKeys = Object.keys(en).sort();
  const koKeys = Object.keys(ko).sort();
  assert.deepEqual(enKeys.filter(key => !(key in ko)), [], 'keys only in en.json');
  assert.deepEqual(koKeys.filter(key => !(key in en)), [], 'keys only in ko.json');
  assert.equal(enKeys.length, koKeys.length);
});

test('en and ko messages use the same positional placeholders', () => {
  const placeholders = text => [...new Set(String(text).match(/\{\d+\}/g) || [])].sort().join(',');
  const mismatched = Object.keys(en).filter(key => placeholders(en[key]) !== placeholders(ko[key]));
  assert.deepEqual(mismatched, []);
});

test('every key passed to t() in src exists in en.json', () => {
  const namespaces = [...new Set(Object.keys(en).map(key => key.split('.')[0]))];
  const direct = /\bt\(\s*'([^']+)'/g;
  // Keys also travel as values: ternaries inside t(...), messageKey / hintKey, initError(code, key)
  // and run.hint.* returned by failureHint. Every quoted literal in an i18n namespace counts.
  const literal = new RegExp(`['"\`]((?:${namespaces.join('|')})\\.[A-Za-z0-9_.-]+)['"\`]`, 'g');
  const used = new Map();
  let directCount = 0;
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(direct)) {
      directCount++;
      used.set(match[1], path.relative(SRC_DIR, file));
    }
    for (const match of source.matchAll(literal)) used.set(match[1], path.relative(SRC_DIR, file));
  }
  assert.ok(directCount > 50, `expected many t('...') calls, found ${directCount}`);
  const missing = [...used.entries()].filter(([key]) => !(key in en)).map(([key, file]) => `${key} (${file})`);
  assert.deepEqual(missing, []);
});

test('dynamic init.problem.<code> messages and hints exist for every local-service problem', () => {
  const expected = [
    'DOCKER_MISSING', 'DOCKER_STOPPED', 'DOCKER_COMPOSE_MISSING', 'OLLAMA_MISSING', 'POSTGRES_CONTAINER_FOREIGN', 'NO_FREE_PORT',
  ];
  const localInfra = fs.readFileSync(path.join(SRC_DIR, 'core', 'local-infra.js'), 'utf8');
  const produced = [...new Set([...localInfra.matchAll(/problems\.push\(\{\s*code:\s*'([A-Z_]+)'/g)].map(match => match[1]))];
  assert.deepEqual([...produced].sort(), [...expected].sort(), 'problem codes produced by planLocalServices');
  for (const code of expected) {
    for (const bundle of [en, ko]) {
      assert.equal(typeof bundle[`init.problem.${code}`], 'string', `init.problem.${code}`);
      assert.equal(typeof bundle[`init.problem.${code}.hint`], 'string', `init.problem.${code}.hint`);
    }
  }
});
