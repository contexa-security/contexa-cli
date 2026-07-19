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

function appliedRoot(projectDir, mode = INSTALL_MODES.NORMAL) {
  return path.join(backupRoot(projectDir, mode), '__applied__');
}

function transactionBackupRoot(projectDir, transactionId, mode = INSTALL_MODES.NORMAL) {
  return path.join(backupRoot(projectDir, mode), '__transactions__', transactionId);
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
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (error) {
    throw manifestRecoveryError(projectDir, normalizedMode, `invalid JSON: ${error.message}`);
  }
  await validateManifest(projectDir, normalizedMode, parsed);
  return {
    version: parsed.version,
    metadata: {
      mode: normalizedMode,
      ...(parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {}),
    },
    files: Array.isArray(parsed.files) ? parsed.files : [],
    transaction: parsed.transaction && typeof parsed.transaction === 'object' ? parsed.transaction : null,
  };
}

function manifestRecoveryError(projectDir, mode, reason) {
  return new Error([
    `Contexa ownership manifest is unsafe: ${reason}`,
    `Manifest was kept unchanged: ${manifestPath(projectDir, mode)}`,
    `Safe backups, if present, remain under: ${backupRoot(projectDir, mode)}`,
    'Do not delete project files manually. Correct or restore the manifest, then run the same reset command again.',
  ].join('\n'));
}

function validatedRelativePath(projectDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('file entry relativePath is required');
  }
  const portable = relativePath.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[a-zA-Z]:\//.test(portable)
      || portable === '.' || portable === '..' || portable.startsWith('../')
      || portable.includes('/../') || path.posix.normalize(portable) !== portable) {
    throw new Error(`file entry escapes or is not canonical: ${relativePath}`);
  }
  return projectOwnedPath(projectDir, portable);
}

async function assertNoSymlinkComponents(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  if (!pathWithinRoot(root, candidate)) throw new Error(`path escapes owned root: ${candidate}`);
  const relative = path.relative(root, candidate);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!await fs.pathExists(current)) break;
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed in an owned path: ${current}`);
  }
}

async function validateManifest(projectDir, mode, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw manifestRecoveryError(projectDir, mode, 'root must be an object');
  }
  if (parsed.version !== MANIFEST_VERSION) {
    throw manifestRecoveryError(projectDir, mode,
      `unsupported version ${String(parsed.version)}; expected ${MANIFEST_VERSION}`);
  }
  if (!parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
    throw manifestRecoveryError(projectDir, mode, 'metadata must be an object');
  }
  if (parsed.metadata.mode && parsed.metadata.mode !== mode) {
    throw manifestRecoveryError(projectDir, mode,
      `mode mismatch ${parsed.metadata.mode}; expected ${mode}`);
  }
  if (parsed.metadata.canonicalProjectPath
      && path.resolve(parsed.metadata.canonicalProjectPath) !== path.resolve(projectDir)) {
    throw manifestRecoveryError(projectDir, mode, 'canonical project path does not match the requested project');
  }
  if (!Array.isArray(parsed.files)) {
    throw manifestRecoveryError(projectDir, mode, 'files must be an array');
  }
  const installationId = parsed.metadata.installationId;
  if (installationId && !/^[a-zA-Z0-9_-]{1,64}$/.test(installationId)) {
    throw manifestRecoveryError(projectDir, mode, 'installation ID contains unsupported characters');
  }
  const seen = new Set();
  try {
    for (const entry of parsed.files) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('file entry must be an object');
      const target = validatedRelativePath(projectDir, entry.relativePath);
      if (seen.has(entry.relativePath)) throw new Error(`duplicate file entry: ${entry.relativePath}`);
      seen.add(entry.relativePath);
      if (entry.mode && entry.mode !== mode) throw new Error(`file entry mode mismatch: ${entry.relativePath}`);
      if (installationId && entry.installationId && entry.installationId !== installationId) {
        throw new Error(`file entry installation ID mismatch: ${entry.relativePath}`);
      }
      await assertNoSymlinkComponents(projectDir, target);
      if (await fs.pathExists(target)) {
        const stat = await fs.lstat(target);
        if (!stat.isFile()) throw new Error(`file entry target is not a regular file: ${entry.relativePath}`);
      }
      const backupPath = path.join(backupRoot(projectDir, mode), entry.relativePath);
      await assertNoSymlinkComponents(backupRoot(projectDir, mode), backupPath);
      if (await fs.pathExists(backupPath)) {
        const stat = await fs.lstat(backupPath);
        if (!stat.isFile()) throw new Error(`backup entry is not a regular file: ${entry.relativePath}`);
        if (entry.backupChecksum && await sha256File(backupPath) !== entry.backupChecksum) {
          throw new Error(`backup checksum mismatch: ${entry.relativePath}`);
        }
      } else if (entry.cliApplied && !entry.generated && entry.originalChecksum) {
        throw new Error(`required backup is missing: ${entry.relativePath}`);
      }
      if (entry.appliedRelativePath) {
        const expectedAppliedRelativePath = path.posix.join('__applied__', entry.relativePath);
        if (entry.appliedRelativePath.replace(/\\/g, '/') !== expectedAppliedRelativePath) {
          throw new Error(`CLI-applied snapshot path is not canonical: ${entry.relativePath}`);
        }
        const appliedPath = path.join(backupRoot(projectDir, mode), entry.appliedRelativePath);
        await assertNoSymlinkComponents(backupRoot(projectDir, mode), appliedPath);
        if (!await fs.pathExists(appliedPath) || !(await fs.lstat(appliedPath)).isFile()) {
          throw new Error(`CLI-applied snapshot is missing: ${entry.relativePath}`);
        }
        if (entry.appliedChecksum && await sha256File(appliedPath) !== entry.appliedChecksum) {
          throw new Error(`CLI-applied snapshot checksum mismatch: ${entry.relativePath}`);
        }
      }
    }
    for (const transactionEntry of (parsed.transaction && Array.isArray(parsed.transaction.files)
      ? parsed.transaction.files : [])) {
      if (!transactionEntry || typeof transactionEntry !== 'object') {
        throw new Error('transaction file entry must be an object');
      }
      const transactionTarget = validatedRelativePath(projectDir, transactionEntry.relativePath);
      await assertNoSymlinkComponents(projectDir, transactionTarget);
    }
    for (const externalEntry of (parsed.transaction && Array.isArray(parsed.transaction.externalFiles)
      ? parsed.transaction.externalFiles : [])) {
      if (!externalEntry || typeof externalEntry !== 'object') throw new Error('external file entry must be an object');
      const expectedInfraRoot = parsed.metadata.infraDir && path.resolve(parsed.metadata.infraDir);
      const recordedRoot = externalEntry.rootPath && path.resolve(externalEntry.rootPath);
      const recordedFile = externalEntry.filePath && path.resolve(externalEntry.filePath);
      if (!expectedInfraRoot || recordedRoot !== expectedInfraRoot || !pathWithinRoot(recordedRoot, recordedFile)) {
        throw new Error('external transaction file escapes the manifest-owned infrastructure root');
      }
      await assertNoSymlinkComponents(recordedRoot, recordedFile);
      const backupRelativePath = externalEntry.backupRelativePath;
      if (typeof backupRelativePath !== 'string' || backupRelativePath.startsWith('../')
          || path.posix.normalize(backupRelativePath.replace(/\\/g, '/')) !== backupRelativePath.replace(/\\/g, '/')) {
        throw new Error('external backup path is not canonical');
      }
    }
  } catch (error) {
    throw manifestRecoveryError(projectDir, mode, error.message);
  }
}

function sanitizeManifestValue(value, key = '') {
  if (/(?:password|secret|credential|api.?key|access.?token|refresh.?token|session)/i.test(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map(item => sanitizeManifestValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) =>
      [childKey, sanitizeManifestValue(childValue, childKey)]));
  }
  if (typeof value === 'string') {
    return value.replace(/((?:password|secret|credential|token|api.?key)\s*[:=]\s*)[^\s",}]+/gi,
      '$1[REDACTED]');
  }
  return value;
}

async function saveManifest(projectDir, manifest, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const p = manifestPath(projectDir, normalizedMode);
  await fs.ensureDir(path.dirname(p));
  const content = JSON.stringify(sanitizeManifestValue({
    version: MANIFEST_VERSION,
    metadata: { mode: normalizedMode, ...(manifest.metadata || {}) },
    files: manifest.files || [],
    transaction: manifest.transaction || null,
  }), null, 2) + '\n';
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
  const ownedFile = validatedRelativePath(projectDir, relativePath);
  await assertNoSymlinkComponents(projectDir, ownedFile);
  if (!await fs.pathExists(ownedFile) || !(await fs.lstat(ownedFile)).isFile()) {
    throw new Error(`Cannot record a non-file manifest entry: ${relativePath}`);
  }
  const previous = manifest.files.find(f => f.relativePath === relativePath);
  const backupPath = path.join(backupRoot(projectDir, normalizedMode), relativePath);
  const backupChecksum = await sha256File(backupPath);
  const currentChecksum = await sha256File(filePath);
  const appliedRelativePath = path.join('__applied__', relativePath).split(path.sep).join('/');
  const appliedPath = path.join(backupRoot(projectDir, normalizedMode), appliedRelativePath);
  await fs.ensureDir(path.dirname(appliedPath));
  await fs.copy(filePath, appliedPath, { overwrite: true });
  const entry = {
    relativePath,
    mode: normalizedMode,
    installationId: manifest.metadata.installationId,
    kind: meta.kind || 'modified',
    generated: !!meta.generated,
    reason: meta.reason || 'contexa init',
    ownership: 'CLI_OWNED',
    cliApplied: true,
    originalChecksum: previous ? previous.originalChecksum : backupChecksum,
    backupChecksum,
    observedChecksum: previous ? previous.observedChecksum : backupChecksum,
    lastCliChecksum: currentChecksum,
    currentChecksum,
    appliedRelativePath,
    appliedChecksum: currentChecksum,
    managedPaths: Array.isArray(meta.managedPaths)
      ? [...new Set(meta.managedPaths)].sort()
      : (previous && Array.isArray(previous.managedPaths) ? previous.managedPaths : []),
    updatedAt: new Date().toISOString(),
  };
  if (previous) {
    Object.assign(previous, entry);
  } else {
    manifest.files.push(entry);
  }
  if (manifest.transaction && manifest.transaction.status === 'IN_PROGRESS') {
    const transactionFile = (manifest.transaction.files || []).find(file => file.relativePath === relativePath);
    if (!transactionFile || transactionFile.startChecksum !== currentChecksum) {
      manifest.transaction.changedRelativePaths = Array.isArray(manifest.transaction.changedRelativePaths)
        ? manifest.transaction.changedRelativePaths
        : [];
      if (!manifest.transaction.changedRelativePaths.includes(relativePath)) {
        manifest.transaction.changedRelativePaths.push(relativePath);
      }
    }
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
  const manifestAlreadyExisted = await fs.pathExists(manifestPath(projectDir, normalizedMode));
  const previousState = manifestAlreadyExisted
    ? JSON.parse(JSON.stringify({
        metadata: manifest.metadata || {},
        files: manifest.files || [],
        transaction: manifest.transaction || null,
      }))
    : null;
  const transactionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const updated = await recordInstallMetadata(projectDir, metadata, normalizedMode);
  const transactionFiles = [];
  for (const planned of plannedFiles) {
    if (!planned || !planned.filePath) continue;
    const relativePath = toRelative(projectDir, planned.filePath);
    projectOwnedPath(projectDir, relativePath);
    const existing = updated.files.find(entry => entry.relativePath === relativePath);
    const exists = await fs.pathExists(planned.filePath);
    const stat = exists ? await fs.stat(planned.filePath) : null;
    const startChecksum = stat && stat.isFile() ? await sha256File(planned.filePath) : null;
    const snapshotPath = path.join(transactionBackupRoot(projectDir, transactionId, normalizedMode), relativePath);
    if (stat && stat.isFile()) {
      await fs.ensureDir(path.dirname(snapshotPath));
      await fs.copy(planned.filePath, snapshotPath, { overwrite: false });
    }
    const priorAppliedRelativePath = existing && existing.appliedRelativePath;
    const priorAppliedPath = priorAppliedRelativePath
      ? path.join(backupRoot(projectDir, normalizedMode), priorAppliedRelativePath) : null;
    const priorAppliedSnapshotPath = path.join(
      transactionBackupRoot(projectDir, transactionId, normalizedMode), '__applied__', relativePath);
    const priorAppliedSnapshot = !!(priorAppliedPath && await fs.pathExists(priorAppliedPath));
    if (priorAppliedSnapshot) {
      await fs.ensureDir(path.dirname(priorAppliedSnapshotPath));
      await fs.copy(priorAppliedPath, priorAppliedSnapshotPath, { overwrite: false });
    }
    transactionFiles.push({
      relativePath,
      existed: exists,
      file: !!(stat && stat.isFile()),
      directory: !!(stat && stat.isDirectory()),
      startChecksum,
      priorTracked: !!existing,
      priorAppliedRelativePath: priorAppliedRelativePath || null,
      priorAppliedSnapshot,
    });
    if (existing) continue;
    const backupPath = path.join(backupRoot(projectDir, normalizedMode), relativePath);
    if (stat && stat.isFile()) {
      if (!await fs.pathExists(backupPath)) {
        await fs.ensureDir(path.dirname(backupPath));
        await fs.copy(planned.filePath, backupPath, { overwrite: false });
      }
    }
    const originalChecksum = startChecksum;
    updated.files.push({
      relativePath,
      mode: normalizedMode,
      installationId: updated.metadata.installationId,
      kind: planned.kind || 'modified',
      generated: planned.generated !== undefined ? !!planned.generated : !exists,
      reason: planned.reason || 'planned contexa init change',
      ownership: exists ? 'USER_OWNED' : 'CLI_PENDING',
      cliApplied: false,
      originalChecksum,
      backupChecksum: await sha256File(backupPath),
      observedChecksum: originalChecksum,
      lastCliChecksum: null,
      currentChecksum: originalChecksum,
      planned: true,
      updatedAt: now,
    });
  }
  updated.transaction = {
    id: transactionId,
    status: 'IN_PROGRESS',
    startedAt: now,
    committedAt: null,
    rolledBackAt: null,
    rollbackErrors: [],
    externalFiles: [],
    files: transactionFiles,
    changedRelativePaths: [],
    previousState,
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
  const transaction = manifest.transaction;
  const changed = (transaction.changedRelativePaths || []).length > 0
    || (transaction.externalFiles || []).some(file => file.currentChecksum !== file.originalChecksum);
  if (!changed && transaction.previousState) {
    for (const entry of (transaction.files || []).filter(file => !file.priorTracked)) {
      const originalBackup = path.join(backupRoot(projectDir, normalizedMode), entry.relativePath);
      if (await fs.pathExists(originalBackup)) await fs.remove(originalBackup);
    }
    manifest.metadata = transaction.previousState.metadata;
    manifest.files = transaction.previousState.files;
    manifest.transaction = transaction.previousState.transaction;
  } else {
    transaction.status = 'COMMITTED';
    transaction.committedAt = new Date().toISOString();
    delete transaction.previousState;
    delete transaction.files;
  }
  await saveManifest(projectDir, manifest, normalizedMode);
  const transactionBackups = transactionBackupRoot(projectDir, transactionId, normalizedMode);
  if (await fs.pathExists(transactionBackups)) await fs.remove(transactionBackups);
  return { changed };
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

async function removeEmptyParents(startPath, stopPath) {
  const stop = path.resolve(stopPath);
  let current = path.resolve(startPath);
  while (current !== stop && pathWithinRoot(stop, current) && await fs.pathExists(current)) {
    const entries = await fs.readdir(current);
    if (entries.length > 0) return;
    await fs.remove(current);
    current = path.dirname(current);
  }
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
  const transaction = manifest.transaction;
  if (Array.isArray(transaction.files)) {
    for (const entry of [...transaction.files].reverse()) {
      try {
        const originalPath = projectOwnedPath(projectDir, entry.relativePath);
        const snapshotPath = path.join(transactionBackupRoot(projectDir, transactionId, normalizedMode), entry.relativePath);
        if (entry.file && entry.existed) {
          if (!await fs.pathExists(snapshotPath)) throw new Error('transaction snapshot is missing');
          await fs.ensureDir(path.dirname(originalPath));
          await fs.copy(snapshotPath, originalPath, { overwrite: true });
        } else if (!entry.existed && await fs.pathExists(originalPath)) {
          await fs.remove(originalPath);
        }
        if (!entry.existed) {
          await removeEmptyParents(path.dirname(originalPath), projectDir);
        }
      } catch (error) {
        failures.push(`${entry.relativePath}: ${error.message}`);
      }
    }
    for (const entry of [...(transaction.externalFiles || [])].reverse()) {
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
    if (transaction.files.length === 0 && !transaction.previousState) {
      try {
        const backups = backupRoot(projectDir, normalizedMode);
        for (const backupPath of await collectBackupFiles(backups)) {
          const relativePath = path.relative(backups, backupPath);
          if (relativePath === '__external__'
              || relativePath.startsWith('__external__' + path.sep)
              || relativePath === '__applied__'
              || relativePath.startsWith('__applied__' + path.sep)
              || relativePath === '__transactions__'
              || relativePath.startsWith('__transactions__' + path.sep)) continue;
          const originalPath = projectOwnedPath(projectDir, relativePath);
          await fs.ensureDir(path.dirname(originalPath));
          await fs.copy(backupPath, originalPath, { overwrite: true });
        }
      } catch (error) {
        failures.push(`backup tree: ${error.message}`);
      }
    }

    if (failures.length === 0) {
      if (transaction.previousState) {
        for (const entry of transaction.files.filter(file => !file.priorTracked)) {
          const originalBackup = path.join(backupRoot(projectDir, normalizedMode), entry.relativePath);
          if (await fs.pathExists(originalBackup)) await fs.remove(originalBackup);
          const appliedSnapshot = path.join(appliedRoot(projectDir, normalizedMode), entry.relativePath);
          if (await fs.pathExists(appliedSnapshot)) await fs.remove(appliedSnapshot);
        }
        for (const entry of transaction.files.filter(file => file.priorTracked)) {
          const appliedRelativePath = entry.priorAppliedRelativePath
            || path.join('__applied__', entry.relativePath);
          const appliedSnapshot = path.join(backupRoot(projectDir, normalizedMode), appliedRelativePath);
          const transactionAppliedSnapshot = path.join(
            transactionBackupRoot(projectDir, transactionId, normalizedMode), '__applied__', entry.relativePath);
          if (entry.priorAppliedSnapshot && await fs.pathExists(transactionAppliedSnapshot)) {
            await fs.ensureDir(path.dirname(appliedSnapshot));
            await fs.copy(transactionAppliedSnapshot, appliedSnapshot, { overwrite: true });
          } else if (await fs.pathExists(appliedSnapshot)) {
            await fs.remove(appliedSnapshot);
          }
        }
        manifest.metadata = transaction.previousState.metadata;
        manifest.files = transaction.previousState.files;
        manifest.transaction = transaction.previousState.transaction;
        const transactionBackups = transactionBackupRoot(projectDir, transactionId, normalizedMode);
        if (await fs.pathExists(transactionBackups)) await fs.remove(transactionBackups);
      } else {
        transaction.status = 'ROLLED_BACK';
        transaction.rolledBackAt = new Date().toISOString();
        transaction.rollbackErrors = [];
        delete transaction.previousState;
        delete transaction.files;
        manifest.files = [];
        const backups = backupRoot(projectDir, normalizedMode);
        if (await fs.pathExists(backups)) await fs.remove(backups);
      }
    } else {
      transaction.status = 'ROLLBACK_FAILED';
      transaction.rolledBackAt = new Date().toISOString();
      transaction.rollbackErrors = failures;
    }
    await saveManifest(projectDir, manifest, normalizedMode);
    return { rolledBack: failures.length === 0, failures };
  }
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
      if (relativePath === '__applied__' || relativePath.startsWith('__applied__' + path.sep)) continue;
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
  appliedRoot,
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
  projectOwnedPath,
  validatedRelativePath,
  assertNoSymlinkComponents,
};
