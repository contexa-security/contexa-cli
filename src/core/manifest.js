'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const releaseManifest = require('../../release-manifest.json');

const MANIFEST_VERSION = 3;
const INSTALL_MODES = Object.freeze({ NORMAL: 'normal', SIMULATION: 'simulation' });

function normalizeMode(mode) {
  return mode === INSTALL_MODES.SIMULATION ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL;
}

function stateRoot(projectDir, mode = INSTALL_MODES.NORMAL) {
  const normalized = normalizeMode(mode);
  return normalized === INSTALL_MODES.SIMULATION
    ? path.join(projectDir, 'contexa', 'simulation')
    : path.join(projectDir, 'contexa');
}

function manifestPath(projectDir, mode = INSTALL_MODES.NORMAL) {
  return path.join(stateRoot(projectDir, mode), 'manifest.json');
}

function backupRoot(projectDir, mode = INSTALL_MODES.NORMAL) {
  return path.join(stateRoot(projectDir, mode), 'bak');
}

function toRelative(projectDir, filePath) {
  return path.relative(projectDir, filePath).split(path.sep).join('/');
}

async function sha256File(filePath) {
  if (!filePath || !await fs.pathExists(filePath)) return null;
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return null;
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex');
}

function sha256FileSync(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  if (!fs.statSync(filePath).isFile()) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function loadManifest(projectDir, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const p = manifestPath(projectDir, normalizedMode);
  if (!await fs.pathExists(p)) {
    return { version: MANIFEST_VERSION, metadata: { mode: normalizedMode }, files: [] };
  }
  const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
  return {
    version: parsed.version || 1,
    metadata: {
      mode: normalizedMode,
      ...(parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {}),
    },
    files: Array.isArray(parsed.files) ? parsed.files : [],
    transaction: parsed.transaction && typeof parsed.transaction === 'object' ? parsed.transaction : null,
  };
}

async function saveManifest(projectDir, manifest, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const p = manifestPath(projectDir, normalizedMode);
  await fs.ensureDir(path.dirname(p));
  const content = JSON.stringify({
    version: MANIFEST_VERSION,
    metadata: { mode: normalizedMode, ...(manifest.metadata || {}) },
    files: manifest.files || [],
    transaction: manifest.transaction || null,
  }, null, 2) + '\n';
  const temporaryPath = p + `.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, content, 'utf8');
    await fs.rename(temporaryPath, p);
  } catch (error) {
    if (await fs.pathExists(temporaryPath)) await fs.remove(temporaryPath);
    throw error;
  }
}

async function recordInstallMetadata(projectDir, metadata = {}, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  const now = new Date().toISOString();
  manifest.metadata = {
    ...(manifest.metadata || {}),
    mode: normalizedMode,
    installationId: manifest.metadata && manifest.metadata.installationId
      ? manifest.metadata.installationId
      : crypto.randomUUID(),
    canonicalProjectPath: path.resolve(projectDir),
    cliVersion: releaseManifest.cliVersion,
    starterVersion: releaseManifest.starter.version,
    createdAt: manifest.metadata && manifest.metadata.createdAt
      ? manifest.metadata.createdAt
      : now,
    ...metadata,
    updatedAt: now,
  };
  await saveManifest(projectDir, manifest, normalizedMode);
  return manifest;
}

async function recordChange(projectDir, filePath, meta = {}, mode = INSTALL_MODES.NORMAL) {
  if (!filePath) return;
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  const relativePath = toRelative(projectDir, filePath);
  const previous = manifest.files.find(f => f.relativePath === relativePath);
  const backupPath = path.join(backupRoot(projectDir, normalizedMode), relativePath);
  const backupChecksum = await sha256File(backupPath);
  const entry = {
    relativePath,
    mode: normalizedMode,
    installationId: manifest.metadata.installationId,
    kind: meta.kind || 'modified',
    generated: !!meta.generated,
    reason: meta.reason || 'contexa init',
    originalChecksum: backupChecksum,
    backupChecksum,
    currentChecksum: await sha256File(filePath),
    updatedAt: new Date().toISOString(),
  };
  if (previous) {
    Object.assign(previous, entry);
  } else {
    manifest.files.push(entry);
  }
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function beginInstallTransaction(projectDir, metadata = {}, mode = INSTALL_MODES.NORMAL, plannedFiles = []) {
  const normalizedMode = normalizeMode(mode);
  let manifest = await loadManifest(projectDir, normalizedMode);
  if (manifest.transaction && manifest.transaction.status === 'IN_PROGRESS') {
    const recovery = await rollbackInstallTransaction(projectDir, manifest.transaction.id, normalizedMode);
    if (!recovery.rolledBack) {
      throw new Error(`The unfinished ${normalizedMode} install transaction could not be recovered: ${recovery.failures.join('; ')}`);
    }
    manifest = await loadManifest(projectDir, normalizedMode);
  }
  const now = new Date().toISOString();
  const updated = await recordInstallMetadata(projectDir, metadata, normalizedMode);
  for (const planned of plannedFiles) {
    if (!planned || !planned.filePath) continue;
    const relativePath = toRelative(projectDir, planned.filePath);
    projectOwnedPath(projectDir, relativePath);
    const existing = updated.files.find(entry => entry.relativePath === relativePath);
    if (existing) continue;
    const exists = await fs.pathExists(planned.filePath);
    const backupPath = path.join(backupRoot(projectDir, normalizedMode), relativePath);
    if (exists) {
      const stat = await fs.stat(planned.filePath);
      if (stat.isFile() && !await fs.pathExists(backupPath)) {
        await fs.ensureDir(path.dirname(backupPath));
        await fs.copy(planned.filePath, backupPath, { overwrite: false });
      }
    }
    const originalChecksum = exists ? await sha256File(planned.filePath) : null;
    updated.files.push({
      relativePath,
      mode: normalizedMode,
      installationId: updated.metadata.installationId,
      kind: planned.kind || 'modified',
      generated: planned.generated !== undefined ? !!planned.generated : !exists,
      reason: planned.reason || 'planned contexa init change',
      originalChecksum,
      backupChecksum: await sha256File(backupPath),
      currentChecksum: originalChecksum,
      planned: true,
      updatedAt: now,
    });
  }
  updated.transaction = {
    id: crypto.randomUUID(),
    status: 'IN_PROGRESS',
    startedAt: now,
    committedAt: null,
    rolledBackAt: null,
    rollbackErrors: [],
    externalFiles: [],
  };
  await saveManifest(projectDir, updated, normalizedMode);
  return updated.transaction.id;
}

async function commitInstallTransaction(projectDir, transactionId, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId || manifest.transaction.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot commit unknown or inactive ${normalizedMode} install transaction`);
  }
  manifest.transaction.status = 'COMMITTED';
  manifest.transaction.committedAt = new Date().toISOString();
  await saveManifest(projectDir, manifest, normalizedMode);
}

function projectOwnedPath(projectDir, relativePath) {
  const root = path.resolve(projectDir);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`Manifest path escapes project root: ${relativePath}`);
  }
  return candidate;
}

async function collectBackupFiles(root, current = root, files = []) {
  if (!await fs.pathExists(current)) return files;
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Backup tree contains a symbolic link: ${toRelative(root, candidate)}`);
    }
    if (entry.isDirectory()) {
      await collectBackupFiles(root, candidate, files);
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

function pathWithinRoot(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function prepareExternalFileChange(
  projectDir,
  transactionId,
  filePath,
  externalRoot,
  mode = INSTALL_MODES.NORMAL
) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId || manifest.transaction.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot prepare an external file for an inactive ${normalizedMode} install transaction`);
  }
  const canonicalRoot = path.resolve(externalRoot);
  const canonicalFile = path.resolve(filePath);
  if (!pathWithinRoot(canonicalRoot, canonicalFile)) {
    throw new Error(`External transaction path escapes its owned root: ${canonicalFile}`);
  }
  const expectedRoot = manifest.metadata.infraDir && path.resolve(manifest.metadata.infraDir);
  if (!expectedRoot || expectedRoot !== canonicalRoot) {
    throw new Error(`External transaction root is not the manifest-owned infrastructure root: ${canonicalRoot}`);
  }
  const existed = await fs.pathExists(canonicalFile);
  const backupName = crypto.createHash('sha256').update(canonicalFile).digest('hex') + '.bak';
  const relativeBackupPath = path.join('__external__', backupName);
  const externalBackupPath = path.join(backupRoot(projectDir, normalizedMode), relativeBackupPath);
  if (existed) {
    const stat = await fs.stat(canonicalFile);
    if (!stat.isFile()) throw new Error(`External transaction target is not a file: ${canonicalFile}`);
    await fs.ensureDir(path.dirname(externalBackupPath));
    await fs.copy(canonicalFile, externalBackupPath, { overwrite: false });
  }
  manifest.transaction.externalFiles = Array.isArray(manifest.transaction.externalFiles)
    ? manifest.transaction.externalFiles
    : [];
  const record = {
    filePath: canonicalFile,
    rootPath: canonicalRoot,
    rootExisted: await fs.pathExists(canonicalRoot),
    existed,
    backupRelativePath: relativeBackupPath.split(path.sep).join('/'),
    originalChecksum: existed ? await sha256File(canonicalFile) : null,
    currentChecksum: existed ? await sha256File(canonicalFile) : null,
  };
  const previous = manifest.transaction.externalFiles.find(entry => entry.filePath === canonicalFile);
  if (previous) Object.assign(previous, record);
  else manifest.transaction.externalFiles.push(record);
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function recordExternalFileChange(projectDir, transactionId, filePath, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId || manifest.transaction.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot record an external file for an inactive ${normalizedMode} install transaction`);
  }
  const canonicalFile = path.resolve(filePath);
  const record = (manifest.transaction.externalFiles || []).find(entry => entry.filePath === canonicalFile);
  if (!record) throw new Error(`External transaction file was not prepared: ${canonicalFile}`);
  record.currentChecksum = await sha256File(canonicalFile);
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function rollbackInstallTransaction(projectDir, transactionId, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId) {
    throw new Error(`Cannot roll back unknown ${normalizedMode} install transaction`);
  }
  const failures = [];
  const restoredRelativePaths = new Set();
  for (const entry of [...manifest.files].reverse()) {
    try {
      const originalPath = projectOwnedPath(projectDir, entry.relativePath);
      const backupPath = path.join(backupRoot(projectDir, normalizedMode), entry.relativePath);
      if (await fs.pathExists(backupPath)) {
        await fs.ensureDir(path.dirname(originalPath));
        await fs.copy(backupPath, originalPath, { overwrite: true });
        restoredRelativePaths.add(entry.relativePath.split('/').join(path.sep));
      } else if (entry.generated && await fs.pathExists(originalPath)) {
        await fs.remove(originalPath);
      } else if (!entry.generated) {
        throw new Error('required backup is missing');
      }
    } catch (error) {
      failures.push(`${entry.relativePath}: ${error.message}`);
    }
  }
  for (const entry of [...(manifest.transaction.externalFiles || [])].reverse()) {
    try {
      if (!pathWithinRoot(entry.rootPath, entry.filePath)) {
        throw new Error('external file escapes its recorded root');
      }
      const backupPath = path.join(backupRoot(projectDir, normalizedMode), entry.backupRelativePath);
      if (entry.existed) {
        if (!await fs.pathExists(backupPath)) throw new Error('required external backup is missing');
        await fs.ensureDir(path.dirname(entry.filePath));
        await fs.copy(backupPath, entry.filePath, { overwrite: true });
      } else if (await fs.pathExists(entry.filePath)) {
        await fs.remove(entry.filePath);
      }
      if (!entry.rootExisted && await fs.pathExists(entry.rootPath)) {
        const remaining = await fs.readdir(entry.rootPath);
        if (remaining.length === 0) await fs.remove(entry.rootPath);
      }
    } catch (error) {
      failures.push(`${entry.filePath}: ${error.message}`);
    }
  }
  try {
    const backups = backupRoot(projectDir, normalizedMode);
    for (const backupPath of await collectBackupFiles(backups)) {
      const relativePath = path.relative(backups, backupPath);
      if (relativePath === '__external__' || relativePath.startsWith('__external__' + path.sep)) continue;
      if (restoredRelativePaths.has(relativePath)) continue;
      const originalPath = projectOwnedPath(projectDir, relativePath);
      await fs.ensureDir(path.dirname(originalPath));
      await fs.copy(backupPath, originalPath, { overwrite: true });
    }
  } catch (error) {
    failures.push(`backup tree: ${error.message}`);
  }
  manifest.transaction.status = failures.length === 0 ? 'ROLLED_BACK' : 'ROLLBACK_FAILED';
  manifest.transaction.rolledBackAt = new Date().toISOString();
  manifest.transaction.rollbackErrors = failures;
  if (failures.length === 0) {
    manifest.files = [];
    const backups = backupRoot(projectDir, normalizedMode);
    if (await fs.pathExists(backups)) await fs.remove(backups);
  }
  await saveManifest(projectDir, manifest, normalizedMode);
  return { rolledBack: failures.length === 0, failures };
}

module.exports = {
  MANIFEST_VERSION,
  INSTALL_MODES,
  normalizeMode,
  stateRoot,
  manifestPath,
  backupRoot,
  loadManifest,
  saveManifest,
  beginInstallTransaction,
  commitInstallTransaction,
  rollbackInstallTransaction,
  prepareExternalFileChange,
  recordExternalFileChange,
  recordChange,
  recordInstallMetadata,
  sha256FileSync,
};
