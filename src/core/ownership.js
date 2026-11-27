'use strict';

// The security mode Contexa is installed with, and how it is explained before anything changes. (The file keeps its
// former name; it no longer decides an ownership.)
//
//   sandbox (default)  Contexa is kept apart from the application: its sign-in, authorization and security settings
//                      (CSRF, CORS, headers) stay as they are. Contexa reads who signed in, decides, and enforces the
//                      decision behind the application's chain (block screen, step-up, agent gate, its own console).
//   full               Contexa is the application's main security: it provides the sign-in (form, passkey, one-time
//                      code), the authorization and the security settings.
//
// Both modes run every feature of Contexa. Without --mode the CLI installs SANDBOX in an existing application; FULL only
// when it is asked for. The sample application the CLI makes in an empty folder is Contexa's own trial application with
// no sign-in of its own, so without --mode it gets FULL: only Contexa's sign-in gives it users to decide on. The CLI
// writes no authentication ownership (contexa.bridge.ownership): left out, it follows the mode (SANDBOX ->
// HOST_OWNED, FULL -> CONTEXA_OWNED), and it only settles which of two components of the same kind the application
// gets. --ownership host|contexa is the former name of --mode sandbox|full and is still accepted.
// An @EnableAISecurity already in the application is never changed, so its mode is the one in effect.

const { t } = require('./i18n');

const MODES = ['sandbox', 'full'];
const OWNERSHIP_ALIASES = { host: 'sandbox', contexa: 'full' };

function keyedError(code, key, ...args) {
  const error = new Error(`${code} ${t(key, ...args)}`);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

function given(value) {
  return value !== undefined && value !== null;
}

// What the options ask for, checked before anything is looked at or changed.
function chooseSecurityMode(options = {}) {
  const { mode, ownership } = options;
  if (given(mode) && !MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MODES.join(', ')} (got ${mode})`);
  }
  if (given(ownership) && !Object.keys(OWNERSHIP_ALIASES).includes(ownership)) {
    throw new Error(`--ownership must be one of ${Object.keys(OWNERSHIP_ALIASES).join(', ')} (got ${ownership})`);
  }
  const aliased = given(ownership) ? OWNERSHIP_ALIASES[ownership] : null;
  if (given(mode) && aliased && mode !== aliased) {
    throw keyedError('MODE_CONFLICT', 'ownership.error.conflict', mode, ownership, aliased);
  }
  const chosen = given(mode) ? mode : aliased;
  return {
    securityMode: chosen || 'sandbox',
    chosen: chosen || null,
    reason: chosen ? 'option' : 'default',
    alias: aliased ? { from: ownership, to: aliased } : null,
  };
}

// The mode in effect for this application, and what its user should know about it.
function resolveSecurityMode(project, choice = chooseSecurityMode()) {
  const hasChain = Boolean(project && project.hasHostSecurityFilterChain);
  const annotated = project && project.hasEnableAiSecurity ? project.enableAiSecurityMode || 'sandbox' : null;
  const sample = !annotated && !choice.chosen && Boolean(project && project.createdSample);
  const securityMode = annotated || (sample ? 'full' : choice.securityMode);
  const warnings = [];
  if (annotated && choice.chosen && choice.chosen !== annotated) warnings.push('ownership.warn.annotationKept');
  if (securityMode === 'full' && hasChain) warnings.push('ownership.warn.contexaOverChain');
  if (securityMode === 'sandbox' && !hasChain) {
    warnings.push(project && project.hostDefinesUsers ? 'ownership.warn.hostWithoutChain' : 'ownership.note.noChain');
  }
  return {
    securityMode,
    chosen: choice.chosen,
    reason: annotated ? 'annotation' : sample ? 'sample' : choice.reason,
    alias: choice.alias,
    warnings,
  };
}

// The arguments of a warning: the mode asked for and the one the annotation keeps, by their names in the annotation.
function warningArgs(resolved, key) {
  return key === 'ownership.warn.annotationKept'
    ? [resolved.chosen, resolved.securityMode.toUpperCase()]
    : [];
}

// The lines shown in the plan: the mode, why, who does what, and how to choose the other one.
function securityModeLines(resolved) {
  const sandbox = resolved.securityMode === 'sandbox';
  const lines = [
    t(sandbox ? 'ownership.chosen.host' : 'ownership.chosen.contexa'),
    t(`ownership.reason.${resolved.reason}`),
    t('ownership.row.signIn', t(sandbox ? 'ownership.owner.app' : 'ownership.owner.contexa')),
    t('ownership.row.decisions'),
    t('ownership.row.console', t(sandbox ? 'ownership.console.host' : 'ownership.console.contexa')),
  ];
  if (resolved.reason !== 'annotation') lines.push(t(sandbox ? 'ownership.switch.toContexa' : 'ownership.switch.toHost'));
  return lines;
}

module.exports = {
  MODES,
  OWNERSHIP_ALIASES,
  chooseSecurityMode,
  resolveSecurityMode,
  securityModeLines,
  warningArgs,
};
