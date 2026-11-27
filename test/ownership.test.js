'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/core/i18n');
const { chooseSecurityMode, resolveSecurityMode, securityModeLines, warningArgs } = require('../src/core/ownership');

function inKorean(action) {
  const previous = i18n.getLocale();
  i18n.setLocale('ko');
  try {
    return action();
  } finally {
    i18n.setLocale(previous);
  }
}

test('chooseSecurityMode: without an option the options alone choose SANDBOX', () => {
  assert.deepEqual(chooseSecurityMode({}), { securityMode: 'sandbox', chosen: null, reason: 'default', alias: null });
  assert.deepEqual(chooseSecurityMode(), { securityMode: 'sandbox', chosen: null, reason: 'default', alias: null });
});

test('resolveSecurityMode: SANDBOX by default whether or not the application declares a security chain', () => {
  const withChain = resolveSecurityMode({ hasHostSecurityFilterChain: true }, chooseSecurityMode({}));
  assert.equal(withChain.securityMode, 'sandbox');
  assert.equal(withChain.reason, 'default');
  assert.deepEqual(withChain.warnings, []);

  const withoutChain = resolveSecurityMode({ hasHostSecurityFilterChain: false }, chooseSecurityMode({}));
  assert.equal(withoutChain.securityMode, 'sandbox', 'no chain no longer means FULL');
  assert.equal(withoutChain.reason, 'default');
  assert.deepEqual(withoutChain.warnings, ['ownership.note.noChain'], 'the isolation chain is explained');

  const usersWithoutChain = resolveSecurityMode({ hasHostSecurityFilterChain: false, hostDefinesUsers: true }, chooseSecurityMode({}));
  assert.equal(usersWithoutChain.securityMode, 'sandbox');
  assert.deepEqual(usersWithoutChain.warnings, ['ownership.warn.hostWithoutChain'], 'Spring Boot default security is said');
});

test('resolveSecurityMode: FULL only with --mode full, and an application chain over every request is warned about', () => {
  const full = resolveSecurityMode({ hasHostSecurityFilterChain: false }, chooseSecurityMode({ mode: 'full' }));
  assert.equal(full.securityMode, 'full');
  assert.equal(full.reason, 'option');
  assert.deepEqual(full.warnings, []);

  const fullOverChain = resolveSecurityMode({ hasHostSecurityFilterChain: true }, chooseSecurityMode({ mode: 'full' }));
  assert.equal(fullOverChain.securityMode, 'full');
  assert.deepEqual(fullOverChain.warnings, ['ownership.warn.contexaOverChain']);

  const sandbox = resolveSecurityMode({ hasHostSecurityFilterChain: true }, chooseSecurityMode({ mode: 'sandbox' }));
  assert.equal(sandbox.securityMode, 'sandbox');
  assert.equal(sandbox.reason, 'option');
});

test('resolveSecurityMode: the sample application made in an empty folder gets FULL without an option, and follows an option', () => {
  const sample = resolveSecurityMode({ createdSample: true, hasHostSecurityFilterChain: false }, chooseSecurityMode({}));
  assert.equal(sample.securityMode, 'full');
  assert.equal(sample.reason, 'sample');
  assert.deepEqual(sample.warnings, []);

  const sandboxed = resolveSecurityMode({ createdSample: true }, chooseSecurityMode({ mode: 'sandbox' }));
  assert.equal(sandboxed.securityMode, 'sandbox');
  assert.equal(sandboxed.reason, 'option');
  assert.deepEqual(sandboxed.warnings, ['ownership.note.noChain']);

  assert.equal(resolveSecurityMode({ createdSample: true }, chooseSecurityMode({ ownership: 'host' })).securityMode, 'sandbox');
  const lines = securityModeLines(sample).join('\n');
  assert.match(lines, /--mode sandbox/);
  assert.equal(lines.includes('ownership.reason.sample'), false, 'the reason is in the dictionary');
});

test('chooseSecurityMode: --ownership is the former name of --mode (host = sandbox, contexa = full) and is said to be', () => {
  const host = chooseSecurityMode({ ownership: 'host' });
  assert.equal(host.securityMode, 'sandbox');
  assert.equal(host.reason, 'option');
  assert.deepEqual(host.alias, { from: 'host', to: 'sandbox' });

  const contexa = chooseSecurityMode({ ownership: 'contexa' });
  assert.equal(contexa.securityMode, 'full');
  assert.deepEqual(contexa.alias, { from: 'contexa', to: 'full' });

  const both = chooseSecurityMode({ mode: 'full', ownership: 'contexa' });
  assert.equal(both.securityMode, 'full', 'the two names may be given together when they agree');

  const line = i18n.t('ownership.alias', contexa.alias.from, contexa.alias.to);
  assert.match(line, /--ownership contexa/);
  assert.match(line, /--mode full/);
});

test('chooseSecurityMode: --mode and --ownership that disagree stop with MODE_CONFLICT', () => {
  for (const [mode, ownership] of [['sandbox', 'contexa'], ['full', 'host']]) {
    assert.throws(() => chooseSecurityMode({ mode, ownership }), error => {
      assert.equal(error.code, 'MODE_CONFLICT');
      assert.equal(error.messageKey, 'ownership.error.conflict');
      assert.deepEqual(error.messageArgs, [mode, ownership, ownership === 'host' ? 'sandbox' : 'full']);
      return true;
    });
  }
});

test('chooseSecurityMode: an unknown --mode or --ownership is refused', () => {
  assert.throws(() => chooseSecurityMode({ mode: 'enforce' }), /--mode/);
  assert.throws(() => chooseSecurityMode({ ownership: 'both' }), /--ownership/);
  assert.throws(() => chooseSecurityMode({ ownership: 'toString' }), /--ownership/);
});

test('resolveSecurityMode: an @EnableAISecurity already there keeps its mode, and a different --mode is warned about', () => {
  const kept = resolveSecurityMode({ hasEnableAiSecurity: true, enableAiSecurityMode: 'full' }, chooseSecurityMode({}));
  assert.equal(kept.securityMode, 'full', 'a re-run does not report SANDBOX for an application installed with FULL');
  assert.equal(kept.reason, 'annotation');
  assert.deepEqual(kept.warnings, []);

  const asked = resolveSecurityMode({ hasEnableAiSecurity: true, enableAiSecurityMode: 'sandbox', hasHostSecurityFilterChain: true },
    chooseSecurityMode({ mode: 'full' }));
  assert.equal(asked.securityMode, 'sandbox');
  assert.deepEqual(asked.warnings, ['ownership.warn.annotationKept']);
  assert.deepEqual(warningArgs(asked, 'ownership.warn.annotationKept'), ['full', 'SANDBOX']);
});

test('securityModeLines: the mode, why, who does what and how to choose the other one, in the user language', () => {
  const sandbox = inKorean(() => securityModeLines(resolveSecurityMode({ hasHostSecurityFilterChain: true }, chooseSecurityMode({})))).join('\n');
  assert.match(sandbox, /SANDBOX/);
  assert.match(sandbox, /격리/);
  assert.match(sandbox, /--mode full/);
  assert.match(sandbox, /메일 코드 또는 패스키/, 'the console asks for a second step');
  assert.doesNotMatch(sandbox, /HOST_OWNED|CONTEXA_OWNED|--ownership/);

  const full = inKorean(() => securityModeLines(resolveSecurityMode({}, chooseSecurityMode({ mode: 'full' })))).join('\n');
  assert.match(full, /FULL/);
  assert.match(full, /--mode sandbox/);
  assert.doesNotMatch(full, /HOST_OWNED|CONTEXA_OWNED|--ownership/);

  const annotated = securityModeLines(resolveSecurityMode({ hasEnableAiSecurity: true, enableAiSecurityMode: 'full' }, chooseSecurityMode({})));
  assert.equal(annotated.some(line => /contexa init/.test(line)), false, 'a re-run that cannot switch the mode does not offer to');
});
