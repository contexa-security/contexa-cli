'use strict';

// YAML injection: build the contexa.* tree the CLI is responsible for, merge
// it onto the host application's parsed yml object, force-overwrite the small
// set of CLI-managed keys, and serialize back to disk with .bak rollback.
//
// Two integration modes share buildCliContexaTree / applyCliContexaTree:
// merge mode (this module's injectYml) and standalone mode (standalone.js).
// Keep the tree shape identical between modes - the platform reads the same
// @ConfigurationProperties surface either way.

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { escapeRegex } = require('./common');

// Legacy marker block written by pre-1.1 versions. Kept here only so that
// re-running init on an older project strips and rewrites the block as a
// merged contexa: tree instead of producing a duplicate top-level key.
const LEGACY_MARKER_START = '# --- Contexa AI Security ---';
const LEGACY_MARKER_END   = '# --- End Contexa ---';

// Build the contexa.* sub-tree this CLI version is responsible for.
// The shape mirrors the @ConfigurationProperties surface in the platform.
// Returned tree is a fresh object the caller can mutate freely.
function buildCliContexaTree(opts) {
  const { mode = 'shadow', llmProviders = ['openai', 'anthropic'], infra = 'standalone' } = opts;
  const priority = llmProviders.join(',');
  // Embedding priority excludes both 'anthropic' (no embedding model in Spring AI)
  // and 'ollama' (default Ollama embedding models are 1024 / 768 dim and would
  // mismatch the pgvector 1536 schema). Fallback to 'openai' keeps the embedding
  // path on a single 1536-dim provider regardless of which chat providers the
  // operator selected.
  const embeddingPriority = llmProviders.filter(p => p !== 'anthropic' && p !== 'ollama').join(',') || 'openai';

  const tree = {
    llm: {
      // Use the non-deprecated selection API. Deprecated chatModelPriority/
      // embeddingModelPriority on contexa.llm.* are intentionally NOT written.
      selection: {
        chat: { mode: 'dynamic-priority', priority },
        embedding: { mode: 'dynamic-priority', priority: embeddingPriority },
      },
    },
    datasource: {
      url: '${CONTEXA_DB_URL:${DB_URL:jdbc:postgresql://localhost:5432/contexa}}',
      username: '${CONTEXA_DB_USERNAME:${DB_USERNAME:contexa}}',
      password: '${CONTEXA_DB_PASSWORD:${DB_PASSWORD:contexa1234!@#}}',
      'driver-class-name': '${CONTEXA_DB_DRIVER:org.postgresql.Driver}',
      isolation: { 'contexa-owned-application': true },
    },
    security: {
      zerotrust: { mode: mode === 'enforce' ? 'ENFORCE' : 'SHADOW' },
    },
    hcad: {
      geoip: { enabled: true, dbPath: 'data/GeoLite2-City.mmdb' },
    },
  };
  if (infra === 'distributed') {
    tree.infrastructure = { mode: 'DISTRIBUTED' };
  }
  return tree;
}

// Recursively fill missing keys from source into target. Existing primitives
// are preserved (user wins). Objects merge; arrays/primitives never overwrite.
function fillOnly(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      fillOnly(target[key], sv);
    } else if (target[key] === undefined) {
      target[key] = sv;
    }
  }
}

function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

// Apply the CLI tree onto the host application's parsed yml object.
// Policy:
//   - User-set values are preserved by default (fill-only merge).
//   - A small set of CLI-managed keys are always force-overwritten because they
//     define platform behavior and must not silently drift between init runs:
//       * contexa.security.zerotrust.mode
//       * contexa.hcad.geoip.enabled
//       * contexa.datasource.isolation.contexa-owned-application
//       * contexa.llm.selection.{chat,embedding}.priority
//   - --distributed additionally forces contexa.infrastructure.mode = DISTRIBUTED.
function applyCliContexaTree(rootObj, cliTree, opts) {
  if (!rootObj.contexa || typeof rootObj.contexa !== 'object' || Array.isArray(rootObj.contexa)) {
    rootObj.contexa = {};
  }
  fillOnly(rootObj.contexa, cliTree);

  setPath(rootObj.contexa, ['security', 'zerotrust', 'mode'],
    opts.mode === 'enforce' ? 'ENFORCE' : 'SHADOW');
  setPath(rootObj.contexa, ['hcad', 'geoip', 'enabled'], true);
  setPath(rootObj.contexa, ['datasource', 'isolation', 'contexa-owned-application'], true);
  setPath(rootObj.contexa, ['llm', 'selection', 'chat', 'mode'],
    cliTree.llm.selection.chat.mode);
  setPath(rootObj.contexa, ['llm', 'selection', 'chat', 'priority'],
    cliTree.llm.selection.chat.priority);
  setPath(rootObj.contexa, ['llm', 'selection', 'embedding', 'mode'],
    cliTree.llm.selection.embedding.mode);
  setPath(rootObj.contexa, ['llm', 'selection', 'embedding', 'priority'],
    cliTree.llm.selection.embedding.priority);

  if (opts.infra === 'distributed') {
    setPath(rootObj.contexa, ['infrastructure', 'mode'], 'DISTRIBUTED');
  }
}

// Strip a marker block written by older CLI versions. Idempotent on input
// without a marker. Returns the cleaned yml text.
function stripLegacyMarker(content) {
  const regex = new RegExp(
    `\\n*${escapeRegex(LEGACY_MARKER_START)}[\\s\\S]*?${escapeRegex(LEGACY_MARKER_END)}\\n*`,
    'g'
  );
  return content.replace(regex, '\n');
}

async function injectYml(ymlPath, opts = {}) {
  const cliTree = buildCliContexaTree(opts);

  let rootObj = {};
  if (await fs.pathExists(ymlPath)) {
    await fs.copy(ymlPath, ymlPath + '.bak');
    const content = await fs.readFile(ymlPath, 'utf8');
    const stripped = stripLegacyMarker(content);
    try {
      const parsed = yaml.load(stripped);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rootObj = parsed;
      }
    } catch (err) {
      // Surface a friendly, actionable message instead of a raw stack trace.
      // The .bak file is already in place so the user can recover.
      const lineHint = err.mark && typeof err.mark.line === 'number'
        ? ` (around line ${err.mark.line + 1})` : '';
      const guidance = [
        `application.yml is not valid YAML${lineHint}.`,
        `Backup saved to ${ymlPath}.bak`,
        `How to fix:`,
        `  1) Open ${ymlPath} and check indentation${lineHint}.`,
        `  2) Tabs are NOT valid in YAML - replace with spaces.`,
        `  3) Run "contexa init" again once the file parses cleanly.`,
        `  4) If you cannot resolve it, restore from the .bak file.`,
        `Original parser error: ${err.message}`,
      ].join('\n  ');
      throw new Error(guidance);
    }
  }

  applyCliContexaTree(rootObj, cliTree, opts);

  await fs.ensureDir(path.dirname(ymlPath));
  const out = yaml.dump(rootObj, {
    lineWidth: 200,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
  await fs.writeFile(ymlPath, out);
}

module.exports = {
  buildCliContexaTree,
  applyCliContexaTree,
  stripLegacyMarker,
  injectYml,
  // exported for unit/whitebox testing
  fillOnly,
  setPath,
};
