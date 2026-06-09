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
const { escapeRegex, backupFile } = require('./common');

// Legacy marker block written by pre-1.1 versions. Kept here only so that
// re-running init on an older project strips and rewrites the block as a
// merged contexa: tree instead of producing a duplicate top-level key.
const LEGACY_MARKER_START = '# --- Contexa AI Security ---';
const LEGACY_MARKER_END   = '# --- End Contexa ---';

// Build the contexa.* sub-tree this CLI version is responsible for.
// The shape mirrors the @ConfigurationProperties surface in the platform.
// Returned tree is a fresh object the caller can mutate freely.
function buildCliContexaTree(opts = {}) {
  const { mode = 'shadow', llmProviders = ['openai', 'anthropic'], infra = 'standalone', simulate = false } = opts;
  const priority = llmProviders.join(',');
  // Embedding priority excludes both 'anthropic' (no embedding model in Spring AI)
  // and 'ollama' (default Ollama embedding models are 1024 / 768 dim and would
  // mismatch the pgvector 1536 schema). Fallback to 'openai' keeps the embedding
  // path on a single 1536-dim provider regardless of which chat providers the
  // operator selected.
  const embeddingPriority = llmProviders.filter(p => p !== 'anthropic' && p !== 'ollama').join(',') || 'openai';

  const isSimulate = !!simulate;
  const dbPort = isSimulate ? '25432' : '5432';
  const dbName = isSimulate ? 'contexa_sim' : 'contexa';
  const dbUser = isSimulate ? 'contexa_sim' : 'contexa';
  const dbPass = isSimulate ? 'contexa_sim_pw' : 'contexa1234!@#';
  const ollamaPort = isSimulate ? '31434' : '11434';

  const tree = {
    llm: {
      // Use the non-deprecated selection API. Deprecated chatModelPriority/
      // embeddingModelPriority on contexa.llm.* are intentionally NOT written.
      selection: {
        chat: { mode: 'dynamic-priority', priority },
      },
    },
    datasource: {
      url: `\${CONTEXA_DB_URL:\${DB_URL:jdbc:postgresql://localhost:${dbPort}/${dbName}}}`,
      username: `\${CONTEXA_DB_USERNAME:\${DB_USERNAME:${dbUser}}}`,
      password: `\${CONTEXA_DB_PASSWORD:\${DB_PASSWORD:${dbPass}}}`,
      'driver-class-name': '${CONTEXA_DB_DRIVER:org.postgresql.Driver}',
      isolation: { 'contexa-owned-application': true },
    },
    security: {
      zerotrust: { mode: (isSimulate || mode === 'enforce') ? 'ENFORCE' : 'SHADOW' },
    },
    hcad: {
      geoip: { enabled: true, dbPath: 'contexa/data/GeoLite2-City.mmdb' },
    },
  };

  if (!isSimulate) {
    tree.llm.selection.embedding = { mode: 'dynamic-priority', priority: embeddingPriority };
  }

  if (llmProviders.includes('ollama')) {
    tree.llm.chat = {
      ollama: {
        baseUrl: `\${CONTEXA_CHAT_OLLAMA_BASE_URL:http://127.0.0.1:${ollamaPort}}`,
        model: '${CONTEXA_CHAT_OLLAMA_MODEL:qwen2.5:7b}',
        keepAlive: '${CONTEXA_OLLAMA_CHAT_KEEP_ALIVE:30m}',
      }
    };
    tree.llm.embedding = {
      ollama: {
        dedicatedRuntimeEnabled: false,
        model: '${CONTEXA_EMBEDDING_OLLAMA_MODEL:mxbai-embed-large}',
        dimensions: '${CONTEXA_EMBEDDING_OLLAMA_DIMENSIONS:1024}',
      }
    };
  }

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
    (opts.simulate || opts.mode === 'enforce') ? 'ENFORCE' : 'SHADOW');
  setPath(rootObj.contexa, ['hcad', 'geoip', 'enabled'], true);
  setPath(rootObj.contexa, ['hcad', 'geoip', 'dbPath'], 'contexa/data/GeoLite2-City.mmdb');
  setPath(rootObj.contexa, ['datasource', 'isolation', 'contexa-owned-application'], true);
  setPath(rootObj.contexa, ['llm', 'selection', 'chat', 'mode'],
    cliTree.llm.selection.chat.mode);
  setPath(rootObj.contexa, ['llm', 'selection', 'chat', 'priority'],
    cliTree.llm.selection.chat.priority);

  if (opts.simulate) {
    if (rootObj.contexa.llm && rootObj.contexa.llm.selection) {
      delete rootObj.contexa.llm.selection.embedding;
    }
  } else {
    setPath(rootObj.contexa, ['llm', 'selection', 'embedding', 'mode'],
      cliTree.llm.selection.embedding.mode);
    setPath(rootObj.contexa, ['llm', 'selection', 'embedding', 'priority'],
      cliTree.llm.selection.embedding.priority);
  }

  if (opts.infra === 'distributed') {
    setPath(rootObj.contexa, ['infrastructure', 'mode'], 'DISTRIBUTED');
  }

  // Inject spring.ai configurations for openai/anthropic if selected and not already configured
  const { llmProviders = ['openai', 'anthropic'] } = opts;
  if (llmProviders.includes('openai') || llmProviders.includes('anthropic')) {
    if (!rootObj.spring) rootObj.spring = {};
    if (!rootObj.spring.ai) rootObj.spring.ai = {};

    if (!rootObj.spring.ai.retry) rootObj.spring.ai.retry = {};
    if (rootObj.spring.ai.retry['max-attempts'] === undefined) {
      rootObj.spring.ai.retry['max-attempts'] = 1;
    }

    if (llmProviders.includes('openai') && !rootObj.spring.ai.openai) {
      rootObj.spring.ai.openai = {
        'api-key': '${OPENAI_API_KEY:disabled}',
        'base-url': 'https://api.openai.com',
        chat: {
          options: {
            model: 'gpt-5-nano'
          }
        },
        embedding: {
          options: {
            model: 'text-embedding-3-small',
            dimensions: 1024
          }
        }
      };
    }

    if (llmProviders.includes('anthropic') && !rootObj.spring.ai.anthropic) {
      rootObj.spring.ai.anthropic = {
        'api-key': '${ANTHROPIC_API_KEY:disabled}',
        chat: {
          options: {
            model: 'claude-3-sonnet-20240229'
          }
        }
      };
    }
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
    await backupFile(ymlPath);
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
