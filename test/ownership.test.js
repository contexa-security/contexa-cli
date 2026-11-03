'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/core/i18n');
const { resolveOwnership, ownershipLines } = require('../src/core/ownership');

function inKorean(action) {
  const previous = i18n.getLocale();
  i18n.setLocale('ko');
  try {
    return action();
  } finally {
    i18n.setLocale(previous);
  }
}

test('resolveOwnership: an application with its own security chain keeps its sign-in (HOST_OWNED)', () => {
  const resolved = resolveOwnership({ hasHostSecurityFilterChain: true });
  assert.equal(resolved.securityMode, 'sandbox');
  assert.equal(resolved.ownership, 'host');
  assert.equal(resolved.reason, 'chain');
  assert.deepEqual(resolved.warnings, []);
});

test('resolveOwnership: an application without one gets Contexa sign-in, with a note for a sign-in of its own', () => {
  const resolved = resolveOwnership({ hasHostSecurityFilterChain: false });
  assert.equal(resolved.securityMode, 'full');
  assert.equal(resolved.ownership, 'contexa');
  assert.equal(resolved.reason, 'noChain');
  assert.deepEqual(resolved.warnings, ['ownership.note.noChain']);
});

test('resolveOwnership: --ownership wins, and the risk of the override is said', () => {
  const contexaOverChain = resolveOwnership({ hasHostSecurityFilterChain: true }, 'contexa');
  assert.equal(contexaOverChain.securityMode, 'full');
  assert.equal(contexaOverChain.reason, 'option');
  assert.deepEqual(contexaOverChain.warnings, ['ownership.warn.contexaOverChain']);

  const hostWithoutChain = resolveOwnership({ hasHostSecurityFilterChain: false }, 'host');
  assert.equal(hostWithoutChain.securityMode, 'sandbox');
  assert.deepEqual(hostWithoutChain.warnings, ['ownership.warn.hostWithoutChain']);
});

test('resolveOwnership: an unknown --ownership is refused', () => {
  assert.throws(() => resolveOwnership({ hasHostSecurityFilterChain: true }, 'both'), /--ownership/);
});

test('ownershipLines: who does what is shown for the chosen ownership, in the user language', () => {
  const lines = inKorean(() => ownershipLines(resolveOwnership({ hasHostSecurityFilterChain: true })));
  const text = lines.join('\n');
  assert.match(text, /HOST_OWNED/);
  assert.match(text, /로그인/);
  assert.match(text, /--ownership contexa/);

  const full = inKorean(() => ownershipLines(resolveOwnership({ hasHostSecurityFilterChain: false }))).join('\n');
  assert.match(full, /CONTEXA_OWNED/);
  assert.match(full, /--ownership host/);
});
