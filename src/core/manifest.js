'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const MANIFEST_VERSION = 2;

function manifestPath(projectDir) {
  return path.join(projectDir, 'contexa', 'manifest.json');
}

function toRelative(projectDir, filePath) {
  return path.relative(projectDir, filePath).split(path.sep).join('/');
}

async function sha256File(filePath) {
  if (!filePath || !await fs.pathExists(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function sha256FileSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function loadManifest(projectDir) {
  const p = manifestPath(projectDir);
  if (!await fs.pathExists(p)) {
    return { version: MANIFEST_VERSION, metadata: {}, files: [] };
  }
  const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
  return {
    version: parsed.version || 1,
    metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {},
    files: Array.isArray(parsed.files) ? parsed.files : [],
  };
}

async function saveManifest(projectDir, manifest) {
  const p = manifestPath(projectDir);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify({
    version: MANIFEST_VERSION,
    metadata: manifest.metadata || {},
    files: manifest.files || [],
  }, null, 2) + '\n', 'utf8');
}

async function recordInstallMetadata(projectDir, metadata = {}) {
  const manifest = await loadManifest(projectDir);
  manifest.metadata = {
    ...(manifest.metadata || {}),
    ...metadata,
    updatedAt: new Date().toISOString(),
  };
  await saveManifest(projectDir, manifest);
}

async function recordChange(projectDir, filePath, meta = {}) {
  if (!filePath) return;
  const manifest = await loadManifest(projectDir);
  const relativePath = toRelative(projectDir, filePath);
  const previous = manifest.files.find(f => f.relativePath === relativePath);
  const backupPath = path.join(projectDir, 'contexa', 'bak', relativePath);
  const entry = {
    relativePath,
    kind: meta.kind || 'modified',
    generated: !!meta.generated,
    reason: meta.reason || 'contexa init',
    backupChecksum: await sha256File(backupPath),
    currentChecksum: await sha256File(filePath),
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
  recordInstallMetadata,
  sha256FileSync,
};