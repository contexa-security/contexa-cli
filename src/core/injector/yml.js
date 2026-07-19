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
const { SIMULATION_PROFILE } = require('../simulation');
const { DEFAULT_INFRASTRUCTURE_PORTS } = require('../infrastructure');
const {
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
} = require('../provider');

// Legacy marker block written by pre-1.1 versions. Kept here only so that
// re-running init on an older project strips and rewrites the block as a
// merged contexa: tree instead of producing a duplicate top-level key.
const LEGACY_MARKER_START = '# --- Contexa AI Security ---';
const LEGACY_MARKER_END   = '# --- End Contexa ---';

// Build the contexa.* sub-tree this CLI version is responsible for.
// The shape mirrors the @ConfigurationProperties surface in the platform.
// Returned tree is a fresh object the caller can mutate freely.
function buildCliContexaTree(opts = {}) {
  const {
    mode = 'shadow',
    llmProviders = [],
    infra = 'standalone',
    simulate = false,
    enableAiSecurity = false,
    securityMode = 'sandbox',
    hostSecurityFilterChain = false,
  } = opts;
  
  // Sort providers so that 'ollama' comes first if it exists (for seamless offline out-of-the-box testing without API keys)
  let sortedProviders = [...llmProviders];
  if (llmProviders.includes('ollama')) {
    sortedProviders = ['ollama', ...llmProviders.filter(p => p !== 'ollama')];
  }
  const priority = sortedProviders.join(',');

  // Embedding priority: RAG requires a fixed provider and dimension.
  // Respect the order of user preference by selecting the first non-anthropic provider from sorted list.
  let embeddingPriority = 'openai';
  const embeddingPriorityList = sortedProviders.filter(p => p !== 'anthropic');
  if (embeddingPriorityList.length > 0) {
    embeddingPriority = embeddingPriorityList[0];
  } else {
    embeddingPriority = 'openai';
  }

  const isSimulate = !!simulate;
  const tree = {
    security: {
      zerotrust: { mode: (isSimulate || mode === 'enforce') ? 'ENFORCE' : 'SHADOW' },
    },
  };

  if (isSimulate) {
    tree.iam = { websocket: { enabled: false } };
    tree.datasource = {
      url: '${CONTEXA_DB_URL}',
      username: '${CONTEXA_DB_USERNAME}',
      password: '${CONTEXA_DB_PASSWORD}',
      'driver-class-name': '${CONTEXA_DB_DRIVER:org.postgresql.Driver}',
      isolation: { 'contexa-owned-application': true },
    };
  }

  if (enableAiSecurity && securityMode === 'full' && hostSecurityFilterChain) {
    tree.bridge = { ownership: 'HOST_OWNED' };
    tree.datasource = tree.datasource || {};
    tree.datasource.isolation = { 'contexa-owned-application': false };
  }

  if (enableAiSecurity || isSimulate) {
    tree.llm = {
      // Use the non-deprecated selection API. Deprecated chatModelPriority/
      // embeddingModelPriority on contexa.llm.* are intentionally NOT written.
      selection: {
        chat: { mode: 'dynamic-priority', priority: priority || 'openai' },
      },
    };
    tree.hcad = {
      geoip: {
        enabled: true,
        dbPath: isSimulate
          ? 'contexa/simulation/data/GeoLite2-City.mmdb'
          : 'contexa/data/GeoLite2-City.mmdb',
      },
    };

    tree.llm.selection.embedding = {
      mode: 'fixed',
      priority: isSimulate ? 'ollama' : embeddingPriority,
    };
  }

  if ((enableAiSecurity || isSimulate) && llmProviders.includes('ollama')) {
    tree.llm.chat = {
      ollama: {
        baseUrl: isSimulate
          ? '${CONTEXA_CHAT_OLLAMA_BASE_URL}'
          : `\${CONTEXA_CHAT_OLLAMA_BASE_URL:http://127.0.0.1:${DEFAULT_INFRASTRUCTURE_PORTS.ollama}}`,
        model: `\${CONTEXA_CHAT_OLLAMA_MODEL:${DEFAULT_OLLAMA_CHAT_MODEL}}`,
        keepAlive: '${CONTEXA_OLLAMA_CHAT_KEEP_ALIVE:30m}',
      }
    };
    if (!tree.llm.embedding) {
      tree.llm.embedding = {};
    }
    tree.llm.embedding.ollama = {
      dedicatedRuntimeEnabled: false,
      model: `\${CONTEXA_EMBEDDING_OLLAMA_MODEL:${DEFAULT_OLLAMA_EMBEDDING_MODEL}}`,
      dimensions: '${CONTEXA_EMBEDDING_OLLAMA_DIMENSIONS:1024}',
    };
  }

  if (infra === 'distributed') {
    tree.infrastructure = { mode: 'DISTRIBUTED' };
  }
  return tree;
}

// Recursively fill missing keys from source into target. Existing primitives
// are preserved (user wins). Objects merge; arrays/primitives never overwrite.
function fillOnly(target, source, prefix = [], addedPaths = []) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      fillOnly(target[key], sv, [...prefix, key], addedPaths);
    } else if (target[key] === undefined) {
      target[key] = sv;
      addedPaths.push([...prefix, key].join('.'));
    }
  }
  return addedPaths;
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
//   - User-set values are always preserved.
//   - The first init records only leaf paths that the CLI actually created.
//   - A later init may update only those recorded paths; provider changes never
//     delete or overwrite customer-owned provider configuration.
function applyCliContexaTree(rootObj, cliTree, opts) {
  if (!rootObj.contexa || typeof rootObj.contexa !== 'object' || Array.isArray(rootObj.contexa)) {
    rootObj.contexa = {};
  }
  const managedPaths = new Set(Array.isArray(opts.managedPaths) ? opts.managedPaths : []);
  const addedPaths = fillOnly(rootObj.contexa, cliTree);
  for (const [pathKey, value] of leafEntries(cliTree)) {
    if (managedPaths.has(pathKey)) setPath(rootObj.contexa, pathKey.split('.'), value);
  }
  for (const addedPath of addedPaths) managedPaths.add(addedPath);
  // Never write spring.* runtime settings from the CLI, including simulate mode.
  // Redis/Kafka provider defaults are owned by starter/autoconfigure or by the
  // user's explicit application configuration. This prevents `init --simulate`
  // from silently overriding a customer application's real Redis/Kafka setup.
  return { managedPaths: [...managedPaths].sort() };
}

function leafEntries(source, prefix = [], entries = []) {
  for (const [key, value] of Object.entries(source)) {
    const next = [...prefix, key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      leafEntries(value, next, entries);
    } else {
      entries.push([next.join('.'), value]);
    }
  }
  return entries;
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
    await backupFile(ymlPath, { mode: opts.simulate ? 'simulation' : 'normal' });
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

  if (opts.simulate) {
    rootObj.server = rootObj.server && typeof rootObj.server === 'object' ? rootObj.server : {};
    rootObj.server.port = '${CONTEXA_SIMULATION_SERVER_PORT:9080}';
    rootObj.spring = rootObj.spring && typeof rootObj.spring === 'object' ? rootObj.spring : {};
    rootObj.spring.config = rootObj.spring.config && typeof rootObj.spring.config === 'object'
      ? rootObj.spring.config : {};
    rootObj.spring.config.activate = rootObj.spring.config.activate
      && typeof rootObj.spring.config.activate === 'object' ? rootObj.spring.config.activate : {};
    const existingProfile = rootObj.spring.config.activate['on-profile'];
    if (existingProfile && existingProfile !== SIMULATION_PROFILE) {
      throw new Error(`Simulation overlay is already bound to another profile: ${existingProfile}`);
    }
    rootObj.spring.config.activate['on-profile'] = SIMULATION_PROFILE;
    rootObj.spring.ai = rootObj.spring.ai && typeof rootObj.spring.ai === 'object'
      ? rootObj.spring.ai : {};
    rootObj.spring.ai.model = rootObj.spring.ai.model && typeof rootObj.spring.ai.model === 'object'
      ? rootObj.spring.ai.model : {};
    for (const modelType of ['chat', 'embedding']) {
      const selected = rootObj.spring.ai.model[modelType];
      if (selected && selected !== 'ollama') {
        throw new Error(`Simulation overlay already selects another Spring AI ${modelType} model: ${selected}`);
      }
      rootObj.spring.ai.model[modelType] = 'ollama';
    }
    rootObj.spring.ai.model.image = 'none';
    rootObj.spring.ai.model.moderation = 'none';
    rootObj.spring.ai.model.audio = rootObj.spring.ai.model.audio
      && typeof rootObj.spring.ai.model.audio === 'object' ? rootObj.spring.ai.model.audio : {};
    rootObj.spring.ai.model.audio.speech = 'none';
    rootObj.spring.ai.model.audio.transcription = 'none';
    rootObj.spring.ai.ollama = rootObj.spring.ai.ollama
      && typeof rootObj.spring.ai.ollama === 'object' ? rootObj.spring.ai.ollama : {};
    rootObj.spring.ai.ollama['base-url'] = '${OLLAMA_BASE_URL}';
    rootObj.spring.ai.ollama.chat = rootObj.spring.ai.ollama.chat
      && typeof rootObj.spring.ai.ollama.chat === 'object' ? rootObj.spring.ai.ollama.chat : {};
    rootObj.spring.ai.ollama.chat.options = rootObj.spring.ai.ollama.chat.options
      && typeof rootObj.spring.ai.ollama.chat.options === 'object'
      ? rootObj.spring.ai.ollama.chat.options : {};
    rootObj.spring.ai.ollama.chat.options.model = `\${CONTEXA_CHAT_OLLAMA_MODEL:${DEFAULT_OLLAMA_CHAT_MODEL}}`;
    rootObj.spring.ai.ollama.embedding = rootObj.spring.ai.ollama.embedding
      && typeof rootObj.spring.ai.ollama.embedding === 'object' ? rootObj.spring.ai.ollama.embedding : {};
    rootObj.spring.ai.ollama.embedding.options = rootObj.spring.ai.ollama.embedding.options
      && typeof rootObj.spring.ai.ollama.embedding.options === 'object'
      ? rootObj.spring.ai.ollama.embedding.options : {};
    rootObj.spring.ai.ollama.embedding.options.model = `\${CONTEXA_EMBEDDING_OLLAMA_MODEL:${DEFAULT_OLLAMA_EMBEDDING_MODEL}}`;
    rootObj.spring.data = rootObj.spring.data && typeof rootObj.spring.data === 'object'
      ? rootObj.spring.data : {};
    rootObj.spring.data.redis = rootObj.spring.data.redis
      && typeof rootObj.spring.data.redis === 'object' ? rootObj.spring.data.redis : {};
    rootObj.spring.data.redis.host = '${REDIS_HOST}';
    rootObj.spring.data.redis.port = '${REDIS_PORT}';
    rootObj.spring.kafka = rootObj.spring.kafka && typeof rootObj.spring.kafka === 'object'
      ? rootObj.spring.kafka : {};
    rootObj.spring.kafka['bootstrap-servers'] = '${KAFKA_BOOTSTRAP_SERVERS}';
  }

  const application = applyCliContexaTree(rootObj, cliTree, opts);

  await fs.ensureDir(path.dirname(ymlPath));
  const out = yaml.dump(rootObj, {
    lineWidth: 200,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });
  await fs.writeFile(ymlPath, out);
  return application;
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

