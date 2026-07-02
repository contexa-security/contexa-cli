'use strict';

const fs = require('fs-extra');
const path = require('path');

const MANIFEST_VERSION = 1;

function manifestPath(projectDir) {
  return path.join(projectDir, 'contexa', 'manifest.json');
}

function toRelative(projectDir, filePath) {
  return path.relative(projectDir, filePath).split(path.sep).join('/');
}

async function loadManifest(projectDir) {
  const p = manifestPath(projectDir);
  if (!await fs.pathExists(p)) {
    return { version: MANIFEST_VERSION, files: [] };
  }
  const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
  return {
    version: parsed.version || MANIFEST_VERSION,
    files: Array.isArray(parsed.files) ? parsed.files : [],
  };
}

async function saveManifest(projectDir, manifest) {
  const p = manifestPath(projectDir);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify({
    version: MANIFEST_VERSION,
    files: manifest.files,
  }, null, 2) + '\n', 'utf8');
}

async function recordChange(projectDir, filePath, meta = {}) {
  if (!filePath) return;
  const manifest = await loadManifest(projectDir);
  const relativePath = toRelative(projectDir, filePath);
  const previous = manifest.files.find(f => f.relativePath === relativePath);
  const entry = {
    relativePath,
    kind: meta.kind || 'modified',
    generated: !!meta.generated,
    reason: meta.reason || 'contexa init',
    updatedAt: new Date().toISOString(),
  };
  if (previous) {
    Object.assign(previous, entry);
  } else {
    manifest.files.push(entry);
  }
  await saveManifest(projectDir, manifest);
}

module.exports = {
  MANIFEST_VERSION,
  manifestPath,
  loadManifest,
  recordChange,
};
