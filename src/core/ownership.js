'use strict';

// Who owns sign-in in the application Contexa is installed into, and how that is explained before anything changes.
//
//   host    (SANDBOX, HOST_OWNED)     the application keeps its sign-in, session, cookies and URL rules; Contexa reads
//                                     who signed in, decides, and enforces the decision (block screen, step-up,
//                                     agent gate, its own console) without touching them.
//   contexa (FULL, CONTEXA_OWNED)     Contexa provides sign-in (form, passkey, one-time code), sessions and URL rules.
//
// By default an application that declares its own Spring Security chain keeps its sign-in; one that declares none gets
// Contexa's. --ownership decides instead (an application with a sign-in of its own outside Spring Security, say).

const { t } = require('./i18n');

const OWNERS = ['host', 'contexa'];

function resolveOwnership(project, option) {
  const hasChain = Boolean(project && project.hasHostSecurityFilterChain);
  if (option !== undefined && option !== null && !OWNERS.includes(option)) {
    throw new Error(`--ownership must be one of ${OWNERS.join(', ')} (got ${option})`);
  }
  const ownership = option || (hasChain ? 'host' : 'contexa');
  const warnings = [];
  if (option === 'contexa' && hasChain) warnings.push('ownership.warn.contexaOverChain');
  if (option === 'host' && !hasChain) warnings.push('ownership.warn.hostWithoutChain');
  if (!option && !hasChain) warnings.push('ownership.note.noChain');
  return {
    ownership,
    securityMode: ownership === 'host' ? 'sandbox' : 'full',
    reason: option ? 'option' : hasChain ? 'chain' : 'noChain',
    warnings,
  };
}

// The lines shown in the plan: the chosen ownership, why, who does what, and how to choose the other one.
function ownershipLines(resolved) {
  const host = resolved.ownership === 'host';
  return [
    t(host ? 'ownership.chosen.host' : 'ownership.chosen.contexa'),
    t(`ownership.reason.${resolved.reason}`),
    t('ownership.row.signIn', t(host ? 'ownership.owner.app' : 'ownership.owner.contexa')),
    t('ownership.row.decisions'),
    t('ownership.row.console', t(host ? 'ownership.console.host' : 'ownership.console.contexa')),
    t(host ? 'ownership.switch.toContexa' : 'ownership.switch.toHost'),
  ];
}

module.exports = { OWNERS, resolveOwnership, ownershipLines };
