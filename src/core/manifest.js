'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const fsPromises = require('node:fs/promises');
const path = require('path');
const releaseManifest = require('../../release-manifest.json');
const { canonicalBoundaryPath, pathsEqual } = require('./project');

const LEGACY_MANIFEST_VERSION = 3;
const MANIFEST_VERSION = 4;
const RESOURCE_DIGEST_VERSION = 1;
const TRANSACTION_JOURNAL_DIGEST_VERSION = 1;
const INSTALL_MODES = Object.freeze({ NORMAL: 'normal', SIMULATION: 'simulation' });
const JOURNAL_STATES = Object.freeze({
  PLANNED: 'PLANNED',
  PREPARED: 'PREPARED',
  APPLIED: 'APPLIED',
  COMMITTED: 'COMMITTED',
  ROLLED_BACK: 'ROLLED_BACK',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
});

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

function installLockPath(projectDir, mode = INSTALL_MODES.NORMAL) {
  return path.join(stateRoot(projectDir, mode), '.init.lock');
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function acquireInstallLock(projectDir, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const filePath = installLockPath(projectDir, normalizedMode);
  const token = crypto.randomUUID();
  const state = {
    pid: process.pid,
    token,
    mode: normalizedMode,
    startedAt: new Date().toISOString(),
  };
  await fs.ensureDir(path.dirname(filePath));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await fsPromises.open(filePath, 'wx');
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.close();
      return { filePath, token };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (!error || error.code !== 'EEXIST') throw error;

      let owner = null;
      try {
        owner = await fs.readJson(filePath);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
      }
      if (owner && processIsRunning(Number(owner.pid))) {
        const active = new Error(`Another ${normalizedMode} contexa init is already running for this project (PID ${owner.pid})`);
        active.code = 'INIT_ALREADY_RUNNING';
        active.messageKey = 'init.error.alreadyRunning';
        active.messageArgs = [normalizedMode, owner.pid];
        throw active;
      }

      const stalePath = `${filePath}.stale-${token}`;
      try {
        await fs.rename(filePath, stalePath);
        await fs.remove(stalePath);
      } catch (replaceError) {
        if (replaceError.code !== 'ENOENT') throw replaceError;
      }
    }
  }
  const unavailable = new Error(`Unable to acquire the ${normalizedMode} contexa init lock for this project`);
  unavailable.code = 'INIT_LOCK_UNAVAILABLE';
  unavailable.messageKey = 'init.error.lockUnavailable';
  unavailable.messageArgs = [normalizedMode];
  throw unavailable;
}

async function releaseInstallLock(lock) {
  if (!lock || !lock.filePath || !lock.token) return;
  let owner;
  try {
    owner = await fs.readJson(lock.filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (owner && owner.token === lock.token) await fs.remove(lock.filePath);
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

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function resourceDigestPayload(manifest) {
  const metadata = manifest && manifest.metadata ? manifest.metadata : {};
  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  return {
    digestVersion: RESOURCE_DIGEST_VERSION,
    mode: metadata.mode || null,
    installationId: metadata.installationId || null,
    canonicalProjectPath: metadata.canonicalProjectPath
      ? path.resolve(metadata.canonicalProjectPath) : null,
    cliVersion: metadata.cliVersion || null,
    starterVersion: metadata.starterVersion || null,
    infraRoots: [metadata.infraDir, metadata.simInfraDir]
      .filter(Boolean)
      .map(value => path.resolve(value))
      .sort(),
    composeChecksum: metadata.composeChecksum || null,
    dockerResources: metadata.dockerResources || null,
    ...(Array.isArray(metadata.dependencyProvenance)
      ? {
          dependencyProvenance: metadata.dependencyProvenance
            .map(entry => ({ ...entry }))
            .sort((left, right) =>
              [left.targetModule, left.group, left.artifact, left.configuration]
                .join(':').localeCompare(
                  [right.targetModule, right.group, right.artifact, right.configuration]
                    .join(':'))),
        }
      : {}),
    ...(metadata.activationResult && typeof metadata.activationResult === 'object'
      ? {
          aiSecurityRequested: !!metadata.aiSecurityRequested,
          aiSecurityEnabled: !!metadata.aiSecurityEnabled,
          activationResult: { ...metadata.activationResult },
        }
      : {}),
    externalResources: (Array.isArray(metadata.externalResources) ? metadata.externalResources : [])
      .map(entry => ({ ...entry }))
      .sort((left, right) => String(left.filePath || '').localeCompare(String(right.filePath || ''))),
    files: files
      .map(entry => Object.fromEntries(Object.entries(entry)
        .filter(([key]) => key !== 'updatedAt')))
      .sort((left, right) => String(left.relativePath || '').localeCompare(String(right.relativePath || ''))),
  };
}

function validateDependencyProvenance(projectDir, provenance) {
  if (provenance === undefined) return;
  if (!Array.isArray(provenance)) {
    throw new Error('dependency provenance must be an array');
  }
  const keys = new Set();
  for (const coordinate of provenance) {
    if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)) {
      throw new Error('dependency provenance coordinate must be an object');
    }
    for (const field of ['group', 'artifact', 'configuration', 'versionSource', 'targetModule']) {
      if (typeof coordinate[field] !== 'string' || !coordinate[field].trim()) {
        throw new Error(`dependency provenance ${field} is required`);
      }
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(coordinate.group)
        || !/^[A-Za-z0-9_.-]+$/.test(coordinate.artifact)
        || !/^[A-Za-z0-9_.-]+$/.test(coordinate.configuration)) {
      throw new Error('dependency provenance contains an invalid canonical coordinate');
    }
    if (!['literal', 'managed', 'property', 'expression'].includes(coordinate.versionSource)) {
      throw new Error('dependency provenance version source is invalid');
    }
    if (coordinate.version !== null && coordinate.version !== undefined
        && typeof coordinate.version !== 'string') {
      throw new Error('dependency provenance version must be a string or null');
    }
    const modulePath = coordinate.targetModule.replace(/\\/g, '/');
    if (path.isAbsolute(coordinate.targetModule)
        || (modulePath !== '.' && (modulePath.startsWith('../')
          || modulePath.includes('/../') || path.posix.normalize(modulePath) !== modulePath))) {
      throw new Error('dependency provenance target module is not canonical');
    }
    projectOwnedPath(projectDir, modulePath === '.' ? '' : modulePath);
    const key = [coordinate.group, coordinate.artifact, coordinate.configuration,
      coordinate.version || '', modulePath].join(':');
    if (keys.has(key)) throw new Error(`duplicate dependency provenance coordinate: ${key}`);
    keys.add(key);
  }
}

function calculateResourceDigest(manifest) {
  const canonical = JSON.stringify(stableValue(resourceDigestPayload(manifest)));
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function calculateTransactionJournalDigest(transaction) {
  const payload = Object.fromEntries(Object.entries(transaction || {})
    .filter(([key]) => key !== 'journalDigest' && key !== 'journalDigestVersion'));
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(payload)), 'utf8')
    .digest('hex');
}

function createJournalEntry(sequence, category, action, resource, details = {}) {
  const now = new Date().toISOString();
  return {
    id: `${sequence}:${category}:${action}:${resource}`,
    sequence,
    category,
    action,
    resource,
    state: JOURNAL_STATES.PLANNED,
    cleanupAction: details.cleanupAction || null,
    details: details.details || null,
    history: [{ state: JOURNAL_STATES.PLANNED, at: now }],
  };
}

function transitionJournalEntry(entry, state, detail = null) {
  if (!entry || entry.state === state) return;
  entry.state = state;
  entry.history = Array.isArray(entry.history) ? entry.history : [];
  entry.history.push({ state, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
}

function transitionJournal(transaction, predicate, state, detail = null) {
  for (const entry of (transaction && Array.isArray(transaction.journal) ? transaction.journal : [])) {
    if (predicate(entry)) transitionJournalEntry(entry, state, detail);
  }
}

function createPlanAction(sequence, category, action, resource, phase = 'FORWARD') {
  return { sequence, category, action, resource, phase };
}

function appendPlanAction(transaction, category, action, resource, phase = 'FORWARD') {
  transaction.plan = transaction.plan && Array.isArray(transaction.plan.actions)
    ? transaction.plan : { version: 1, actions: [] };
  const duplicate = transaction.plan.actions.some(entry =>
    entry.category === category && entry.action === action
    && entry.resource === resource && entry.phase === phase);
  if (!duplicate) {
    transaction.plan.actions.push(createPlanAction(
      transaction.plan.actions.length + 1, category, action, resource, phase));
  }
}

function installMetadata(projectDir, currentMetadata, metadata, mode) {
  const now = new Date().toISOString();
  const current = currentMetadata || {};
  return {
    ...current,
    ...(metadata || {}),
    mode,
    installationId: current.installationId || crypto.randomUUID(),
    canonicalProjectPath: canonicalProjectPathSync(projectDir),
    cliVersion: releaseManifest.cliVersion,
    starterVersion: releaseManifest.starter.version,
    createdAt: current.createdAt || now,
    updatedAt: now,
  };
}

function canonicalProjectPathSync(projectDir) {
  const resolved = path.resolve(projectDir);
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync;
    return path.resolve(realpath(resolved));
  } catch {
    return resolved;
  }
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
  const error = new Error([
    `Contexa ownership manifest is unsafe: ${reason}`,
    `Manifest was kept unchanged: ${manifestPath(projectDir, mode)}`,
    `Safe backups, if present, remain under: ${backupRoot(projectDir, mode)}`,
    'Do not delete project files manually. Correct or restore the manifest, then run the same reset command again.',
  ].join('\n'));
  error.code = /resource digest/i.test(reason)
    ? 'MANIFEST_DIGEST_CONFLICT'
    : /mode mismatch/i.test(reason)
      ? 'MANIFEST_MODE_CONFLICT'
      : 'MANIFEST_OWNERSHIP_CONFLICT';
  return error;
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
  if (parsed.version !== MANIFEST_VERSION && parsed.version !== LEGACY_MANIFEST_VERSION) {
    throw manifestRecoveryError(projectDir, mode,
      `unsupported version ${String(parsed.version)}; expected ${LEGACY_MANIFEST_VERSION} or ${MANIFEST_VERSION}`);
  }
  if (!parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)) {
    throw manifestRecoveryError(projectDir, mode, 'metadata must be an object');
  }
  if (parsed.metadata.mode !== mode) {
    throw manifestRecoveryError(projectDir, mode,
      `mode mismatch ${parsed.metadata.mode}; expected ${mode}`);
  }
  const manifestProjectPath = parsed.metadata.canonicalProjectPath;
  const requestedProjectPath = await canonicalBoundaryPath(projectDir);
  const canonicalManifestProjectPath = manifestProjectPath
    ? await canonicalBoundaryPath(manifestProjectPath) : null;
  if (!canonicalManifestProjectPath
      || !pathsEqual(canonicalManifestProjectPath, requestedProjectPath)) {
    throw manifestRecoveryError(projectDir, mode, 'canonical project path does not match the requested project');
  }
  if (!Array.isArray(parsed.files)) {
    throw manifestRecoveryError(projectDir, mode, 'files must be an array');
  }
  const installationId = parsed.metadata.installationId;
  if (!installationId || !/^[a-zA-Z0-9_-]{1,64}$/.test(installationId)) {
    throw manifestRecoveryError(projectDir, mode, 'installation ID contains unsupported characters');
  }
  if (typeof parsed.metadata.cliVersion !== 'string' || !parsed.metadata.cliVersion.trim()) {
    throw manifestRecoveryError(projectDir, mode, 'CLI version is required');
  }
  if (typeof parsed.metadata.createdAt !== 'string' || !parsed.metadata.createdAt.trim()) {
    throw manifestRecoveryError(projectDir, mode, 'createdAt is required');
  }
  try {
    validateDependencyProvenance(projectDir, parsed.metadata.dependencyProvenance);
  } catch (error) {
    throw manifestRecoveryError(projectDir, mode, error.message);
  }
  if (parsed.version === LEGACY_MANIFEST_VERSION) {
    const ownershipValues = new Set(['CLI_OWNED', 'CLI_PENDING', 'USER_OWNED']);
    const ownershipProven = parsed.files.every(entry => entry
      && entry.mode === mode
      && entry.installationId === installationId
      && ownershipValues.has(entry.ownership));
    if (!ownershipProven) {
      throw manifestRecoveryError(projectDir, mode,
        'legacy manifest ownership cannot be proven; automatic migration is forbidden');
    }
  } else {
    if (parsed.metadata.resourceDigestVersion !== RESOURCE_DIGEST_VERSION) {
      throw manifestRecoveryError(projectDir, mode,
        `resource digest version mismatch; expected ${RESOURCE_DIGEST_VERSION}`);
    }
    if (!/^[a-f0-9]{64}$/.test(parsed.metadata.resourceDigest || '')) {
      throw manifestRecoveryError(projectDir, mode, 'resource digest is missing or malformed');
    }
    const expectedDigest = calculateResourceDigest(parsed);
    if (parsed.metadata.resourceDigest !== expectedDigest) {
      throw manifestRecoveryError(projectDir, mode, 'resource digest mismatch');
    }
    if (parsed.transaction) {
      if (parsed.transaction.journalDigestVersion !== TRANSACTION_JOURNAL_DIGEST_VERSION
          || !/^[a-f0-9]{64}$/.test(parsed.transaction.journalDigest || '')) {
        throw manifestRecoveryError(projectDir, mode, 'transaction journal digest is missing or malformed');
      }
      if (parsed.transaction.journalDigest !== calculateTransactionJournalDigest(parsed.transaction)) {
        throw manifestRecoveryError(projectDir, mode, 'transaction journal digest mismatch');
      }
    }
  }
  const seen = new Set();
  try {
    for (const entry of parsed.files) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('file entry must be an object');
      const target = validatedRelativePath(projectDir, entry.relativePath);
      if (seen.has(entry.relativePath)) throw new Error(`duplicate file entry: ${entry.relativePath}`);
      seen.add(entry.relativePath);
      if (entry.mode !== mode) throw new Error(`file entry mode mismatch: ${entry.relativePath}`);
      if (entry.installationId !== installationId) {
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
    for (const retained of (Array.isArray(parsed.metadata.externalResources)
      ? parsed.metadata.externalResources : [])) {
      const expectedInfraRoot = parsed.metadata.infraDir && path.resolve(parsed.metadata.infraDir);
      const recordedRoot = retained.rootPath && path.resolve(retained.rootPath);
      const recordedFile = retained.filePath && path.resolve(retained.filePath);
      if (!expectedInfraRoot || recordedRoot !== expectedInfraRoot
          || !pathWithinRoot(recordedRoot, recordedFile)) {
        throw new Error('retained external resource escapes the manifest-owned infrastructure root');
      }
      if (retained.originalExisted) {
        const relativeBackup = retained.originalBackupRelativePath;
        if (typeof relativeBackup !== 'string'
            || !relativeBackup.startsWith('__external__/')
            || path.posix.normalize(relativeBackup) !== relativeBackup) {
          throw new Error('retained external backup path is not canonical');
        }
        const retainedBackup = path.join(backupRoot(projectDir, mode), relativeBackup);
        await assertNoSymlinkComponents(backupRoot(projectDir, mode), retainedBackup);
        if (!await fs.pathExists(retainedBackup) || !(await fs.lstat(retainedBackup)).isFile()) {
          throw new Error('retained external backup is missing');
        }
        if (retained.originalChecksum && await sha256File(retainedBackup) !== retained.originalChecksum) {
          throw new Error('retained external backup checksum mismatch');
        }
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
  const suppliedMetadata = manifest.metadata || {};
  const now = new Date().toISOString();
  const persisted = sanitizeManifestValue({
    version: MANIFEST_VERSION,
    metadata: {
      ...suppliedMetadata,
      mode: normalizedMode,
      installationId: suppliedMetadata.installationId || crypto.randomUUID(),
      canonicalProjectPath: canonicalProjectPathSync(projectDir),
      cliVersion: suppliedMetadata.cliVersion || releaseManifest.cliVersion,
      starterVersion: suppliedMetadata.starterVersion || releaseManifest.starter.version,
      createdAt: suppliedMetadata.createdAt || now,
      resourceDigestVersion: RESOURCE_DIGEST_VERSION,
    },
    files: manifest.files || [],
    transaction: manifest.transaction || null,
  });
  persisted.metadata.resourceDigest = calculateResourceDigest(persisted);
  if (persisted.transaction) {
    persisted.transaction.journalDigestVersion = TRANSACTION_JOURNAL_DIGEST_VERSION;
    persisted.transaction.journalDigest = calculateTransactionJournalDigest(persisted.transaction);
  }
  const content = JSON.stringify(persisted, null, 2) + '\n';
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
  manifest.metadata = installMetadata(projectDir, manifest.metadata, metadata, normalizedMode);
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
    generated: previous
      ? (previous.generated || previous.originalChecksum === null)
      : !!meta.generated,
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
    transitionJournal(
      manifest.transaction,
      journalEntry => journalEntry.resource === relativePath
        && (journalEntry.category === 'FILE' || journalEntry.category === 'ARTIFACT'),
      JOURNAL_STATES.APPLIED,
      'resource checksum recorded'
    );
  }
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function beginInstallTransaction(
  projectDir,
  metadata = {},
  mode = INSTALL_MODES.NORMAL,
  plannedFiles = [],
  options = {}
) {
  const normalizedMode = normalizeMode(mode);
  let manifest = await loadManifest(projectDir, normalizedMode);
  if (manifest.transaction
      && ['IN_PROGRESS', 'ROLLBACK_FAILED'].includes(manifest.transaction.status)) {
    const interruptedTransaction = manifest.transaction;
    const dockerMutation = interruptedTransaction.dockerMutation;
    const recoveryFailures = [];
    if (dockerMutation && [JOURNAL_STATES.PREPARED, JOURNAL_STATES.APPLIED].includes(dockerMutation.state)) {
      if (typeof options.recoverDocker !== 'function') {
        recoveryFailures.push('Docker recovery adapter is required for the unfinished transaction');
      } else {
        try {
          await options.recoverDocker(dockerMutation, manifest);
          dockerMutation.state = JOURNAL_STATES.ROLLED_BACK;
          transitionJournal(
            interruptedTransaction,
            entry => entry.category === 'DOCKER',
            JOURNAL_STATES.ROLLED_BACK,
            'verified owned Docker resources removed'
          );
          await saveManifest(projectDir, manifest, normalizedMode);
        } catch (error) {
          recoveryFailures.push(`Docker recovery: ${error.message}`);
        }
      }
    }
    const recovery = await rollbackInstallTransaction(
      projectDir,
      interruptedTransaction.id,
      normalizedMode,
      { failures: recoveryFailures }
    );
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
  const updated = manifest;
  updated.metadata = installMetadata(projectDir, updated.metadata, metadata, normalizedMode);
  const transactionFiles = [];
  const journal = [];
  const planActions = [];
  for (const planned of plannedFiles) {
    if (!planned || !planned.filePath) continue;
    const relativePath = toRelative(projectDir, planned.filePath);
    projectOwnedPath(projectDir, relativePath);
    await assertNoSymlinkComponents(projectDir, planned.filePath);
    const existing = updated.files.find(entry => entry.relativePath === relativePath);
    const exists = await fs.pathExists(planned.filePath);
    const stat = exists ? await fs.stat(planned.filePath) : null;
    if (stat && !stat.isFile()) {
      throw new Error(`Planned install resource is not a regular file: ${relativePath}`);
    }
    const startChecksum = stat && stat.isFile() ? await sha256File(planned.filePath) : null;
    const priorAppliedRelativePath = existing && existing.appliedRelativePath;
    transactionFiles.push({
      relativePath,
      existed: exists,
      file: !!(stat && stat.isFile()),
      directory: false,
      startChecksum,
      priorTracked: !!existing,
      priorAppliedRelativePath: priorAppliedRelativePath || null,
      priorAppliedSnapshot: false,
      prepared: false,
    });
    if (!existing) {
      updated.files.push({
        relativePath,
        mode: normalizedMode,
        installationId: updated.metadata.installationId,
        kind: planned.kind || 'modified',
        generated: planned.generated !== undefined ? !!planned.generated : !exists,
        reason: planned.reason || 'planned contexa init change',
        ownership: exists ? 'USER_OWNED' : 'CLI_PENDING',
        cliApplied: false,
        originalChecksum: startChecksum,
        backupChecksum: null,
        observedChecksum: startChecksum,
        lastCliChecksum: null,
        currentChecksum: startChecksum,
        planned: true,
        updatedAt: now,
      });
    }
    journal.push(createJournalEntry(
      journal.length + 1,
      planned.kind === 'geoip-data' ? 'ARTIFACT' : 'FILE',
      planned.kind === 'geoip-data' ? 'DOWNLOAD' : (exists ? 'MODIFY' : 'CREATE'),
      relativePath,
      { cleanupAction: exists ? 'RESTORE_SNAPSHOT' : 'REMOVE_CREATED_FILE' }
    ));
    planActions.push(createPlanAction(
      planActions.length + 1,
      planned.kind === 'geoip-data' ? 'ARTIFACT' : 'FILE',
      planned.kind === 'geoip-data' ? 'DOWNLOAD' : (exists ? 'MODIFY' : 'CREATE'),
      relativePath
    ));
    planActions.push(createPlanAction(
      planActions.length + 1,
      planned.kind === 'geoip-data' ? 'ARTIFACT' : 'FILE',
      exists ? 'RESTORE' : 'DELETE',
      relativePath,
      'ROLLBACK'
    ));
  }
  journal.push(createJournalEntry(
    journal.length + 1,
    'MANIFEST',
    'COMMIT',
    toRelative(projectDir, manifestPath(projectDir, normalizedMode)),
    { cleanupAction: previousState ? 'RESTORE_PREVIOUS_MANIFEST' : 'REMOVE_NEW_MANIFEST' }
  ));
  planActions.push(createPlanAction(
    planActions.length + 1,
    'MANIFEST',
    'COMMIT',
    toRelative(projectDir, manifestPath(projectDir, normalizedMode))
  ));
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
    journal,
    plan: { version: 1, actions: planActions },
    dockerMutation: null,
  };
  await saveManifest(projectDir, updated, normalizedMode);

  for (const transactionFile of transactionFiles) {
    const relativePath = transactionFile.relativePath;
    const planned = plannedFiles.find(candidate =>
      candidate && candidate.filePath && toRelative(projectDir, candidate.filePath) === relativePath);
    const snapshotPath = path.join(
      transactionBackupRoot(projectDir, transactionId, normalizedMode), relativePath);
    if (transactionFile.file && transactionFile.existed) {
      await fs.ensureDir(path.dirname(snapshotPath));
      await fs.copy(planned.filePath, snapshotPath, { overwrite: false });
    }
    const priorAppliedPath = transactionFile.priorAppliedRelativePath
      ? path.join(backupRoot(projectDir, normalizedMode), transactionFile.priorAppliedRelativePath)
      : null;
    const priorAppliedSnapshotPath = path.join(
      transactionBackupRoot(projectDir, transactionId, normalizedMode), '__applied__', relativePath);
    transactionFile.priorAppliedSnapshot = !!(priorAppliedPath && await fs.pathExists(priorAppliedPath));
    if (transactionFile.priorAppliedSnapshot) {
      await fs.ensureDir(path.dirname(priorAppliedSnapshotPath));
      await fs.copy(priorAppliedPath, priorAppliedSnapshotPath, { overwrite: false });
    }
    const manifestEntry = updated.files.find(entry => entry.relativePath === relativePath);
    if (!transactionFile.priorTracked && transactionFile.file) {
      const backupPath = path.join(backupRoot(projectDir, normalizedMode), relativePath);
      if (!await fs.pathExists(backupPath)) {
        await fs.ensureDir(path.dirname(backupPath));
        await fs.copy(planned.filePath, backupPath, { overwrite: false });
      }
      manifestEntry.backupChecksum = await sha256File(backupPath);
    }
    transactionFile.prepared = true;
    transactionFile.preparedAt = new Date().toISOString();
    transitionJournal(
      updated.transaction,
      entry => entry.resource === relativePath
        && (entry.category === 'FILE' || entry.category === 'ARTIFACT'),
      JOURNAL_STATES.PREPARED,
      'pre-mutation snapshot persisted'
    );
    await saveManifest(projectDir, updated, normalizedMode);
  }
  return updated.transaction.id;
}

async function persistExternalOriginalResources(projectDir, mode, manifest, transaction) {
  manifest.metadata.externalResources = Array.isArray(manifest.metadata.externalResources)
    ? manifest.metadata.externalResources : [];
  for (const entry of (transaction.externalFiles || [])) {
    let retained = manifest.metadata.externalResources.find(item => item.filePath === entry.filePath);
    if (!retained) {
      const backupName = crypto.createHash('sha256').update(entry.filePath).digest('hex') + '.original';
      const backupRelativePath = path.posix.join('__external__', backupName);
      if (entry.existed) {
        const transactionBackup = path.join(backupRoot(projectDir, mode), entry.backupRelativePath);
        if (!await fs.pathExists(transactionBackup)) {
          throw new Error(`Cannot commit external resource without its original snapshot: ${entry.filePath}`);
        }
        const retainedBackup = path.join(backupRoot(projectDir, mode), backupRelativePath);
        await fs.ensureDir(path.dirname(retainedBackup));
        if (!await fs.pathExists(retainedBackup)) {
          await fs.copy(transactionBackup, retainedBackup, { overwrite: false });
        }
      }
      retained = {
        filePath: entry.filePath,
        rootPath: entry.rootPath,
        rootExisted: entry.rootExisted,
        originalExisted: entry.existed,
        originalBackupRelativePath: entry.existed ? backupRelativePath : null,
        originalChecksum: entry.originalChecksum,
        appliedChecksum: entry.currentChecksum,
      };
      manifest.metadata.externalResources.push(retained);
    } else {
      retained.appliedChecksum = entry.currentChecksum;
    }
  }
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
  const changedRelativePaths = new Set(transaction.changedRelativePaths || []);
  const unverifiableUnchangedEntries = (transaction.files || []).filter(entry =>
    entry.priorTracked && !entry.priorAppliedSnapshot && !changedRelativePaths.has(entry.relativePath));
  const ownershipMigrated = unverifiableUnchangedEntries.length > 0;
  if (!changed && !ownershipMigrated && transaction.previousState) {
    for (const entry of (transaction.files || []).filter(file => !file.priorTracked)) {
      const originalBackup = path.join(backupRoot(projectDir, normalizedMode), entry.relativePath);
      if (await fs.pathExists(originalBackup)) await fs.remove(originalBackup);
    }
    manifest.metadata = transaction.previousState.metadata;
    manifest.files = transaction.previousState.files;
    manifest.transaction = transaction.previousState.transaction;
  } else {
    await persistExternalOriginalResources(projectDir, normalizedMode, manifest, transaction);
    for (const entry of unverifiableUnchangedEntries) {
      manifest.files = manifest.files.filter(file => file.relativePath !== entry.relativePath);
      const unverifiableBackup = path.join(backupRoot(projectDir, normalizedMode), entry.relativePath);
      if (await fs.pathExists(unverifiableBackup)) await fs.remove(unverifiableBackup);
    }
    transitionJournal(
      transaction,
      entry => entry.category !== 'MANIFEST' && entry.state === JOURNAL_STATES.PREPARED,
      JOURNAL_STATES.APPLIED,
      'verified no additional mutation was required'
    );
    transitionJournal(
      transaction,
      entry => entry.category === 'MANIFEST',
      JOURNAL_STATES.PREPARED,
      'atomic manifest replacement prepared'
    );
    transitionJournal(
      transaction,
      entry => entry.category === 'MANIFEST',
      JOURNAL_STATES.APPLIED,
      'atomic manifest replacement applied'
    );
    transitionJournal(
      transaction,
      () => true,
      JOURNAL_STATES.COMMITTED,
      'install transaction committed'
    );
    transaction.status = 'COMMITTED';
    transaction.committedAt = new Date().toISOString();
    if (transaction.dockerMutation) {
      transaction.dockerMutation.state = JOURNAL_STATES.COMMITTED;
    }
    delete transaction.previousState;
    delete transaction.files;
    delete transaction.externalFiles;
    delete transaction.changedRelativePaths;
  }
  await saveManifest(projectDir, manifest, normalizedMode);
  const transactionBackups = transactionBackupRoot(projectDir, transactionId, normalizedMode);
  if (await fs.pathExists(transactionBackups)) await fs.remove(transactionBackups);
  return { changed: changed || ownershipMigrated };
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
  const relativeBackupPath = path.join('__transactions__', transactionId, '__external__', backupName);
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
  let journalEntry = (manifest.transaction.journal || []).find(entry =>
    entry.category === 'EXTERNAL_FILE' && entry.resource === canonicalFile);
  if (!journalEntry) {
    manifest.transaction.journal = Array.isArray(manifest.transaction.journal)
      ? manifest.transaction.journal : [];
    journalEntry = createJournalEntry(
      manifest.transaction.journal.length + 1,
      'EXTERNAL_FILE',
      existed ? 'MODIFY' : 'CREATE',
      canonicalFile,
      { cleanupAction: existed ? 'RESTORE_EXTERNAL_SNAPSHOT' : 'REMOVE_CREATED_EXTERNAL_FILE' }
    );
    manifest.transaction.journal.push(journalEntry);
  }
  transitionJournalEntry(journalEntry, JOURNAL_STATES.PREPARED, 'external snapshot persisted');
  appendPlanAction(
    manifest.transaction,
    'EXTERNAL_FILE',
    existed ? 'MODIFY' : 'CREATE',
    canonicalFile
  );
  appendPlanAction(
    manifest.transaction,
    'EXTERNAL_FILE',
    existed ? 'RESTORE' : 'DELETE',
    canonicalFile,
    'ROLLBACK'
  );
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
  transitionJournal(
    manifest.transaction,
    entry => entry.category === 'EXTERNAL_FILE' && entry.resource === canonicalFile,
    JOURNAL_STATES.APPLIED,
    'external checksum recorded'
  );
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function prepareDockerMutation(
  projectDir,
  transactionId,
  dockerMutation,
  mode = INSTALL_MODES.NORMAL
) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId
      || manifest.transaction.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot prepare Docker for an inactive ${normalizedMode} install transaction`);
  }
  const contract = dockerMutation && dockerMutation.contract;
  const projectName = dockerMutation && dockerMutation.projectName;
  const infraDir = dockerMutation && dockerMutation.infraDir;
  if (!contract || contract.owner !== 'contexa-cli'
      || contract.mode !== normalizedMode
      || contract.installationId !== manifest.metadata.installationId
      || contract.projectName !== projectName
      || path.resolve(infraDir || '') !== path.resolve(manifest.metadata.infraDir || '')) {
    throw new Error('Docker mutation does not match the manifest ownership contract');
  }
  const action = dockerMutation.action === 'REUSE' ? 'REUSE' : 'START';
  const stored = {
    action,
    state: JOURNAL_STATES.PREPARED,
    projectName,
    infraDir: path.resolve(infraDir),
    composeChecksum: dockerMutation.composeChecksum,
    contract: JSON.parse(JSON.stringify(contract)),
    services: [...new Set(dockerMutation.services || [])].sort(),
    cleanupAction: action === 'START' ? 'VERIFY_LABELS_THEN_COMPOSE_DOWN' : 'NONE',
    removeVolumes: !!dockerMutation.removeVolumes,
    preparedAt: new Date().toISOString(),
    appliedAt: null,
  };
  manifest.transaction.dockerMutation = stored;
  appendPlanAction(manifest.transaction, 'DOCKER', action, projectName);
  if (action === 'START') {
    appendPlanAction(manifest.transaction, 'DOCKER', 'REMOVE', projectName, 'ROLLBACK');
  }
  manifest.transaction.journal = Array.isArray(manifest.transaction.journal)
    ? manifest.transaction.journal : [];
  let journalEntry = manifest.transaction.journal.find(entry => entry.category === 'DOCKER');
  if (!journalEntry) {
    journalEntry = createJournalEntry(
      manifest.transaction.journal.length + 1,
      'DOCKER',
      action,
      projectName,
      {
        cleanupAction: stored.cleanupAction,
        details: { services: stored.services, contract: stored.contract },
      }
    );
    manifest.transaction.journal.push(journalEntry);
  }
  transitionJournalEntry(journalEntry, JOURNAL_STATES.PREPARED, 'exact Docker contract persisted before mutation');
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function recordDockerMutationApplied(projectDir, transactionId, mode = INSTALL_MODES.NORMAL) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId
      || manifest.transaction.status !== 'IN_PROGRESS'
      || !manifest.transaction.dockerMutation) {
    throw new Error(`Cannot record Docker for an inactive ${normalizedMode} install transaction`);
  }
  manifest.transaction.dockerMutation.state = JOURNAL_STATES.APPLIED;
  manifest.transaction.dockerMutation.appliedAt = new Date().toISOString();
  transitionJournal(
    manifest.transaction,
    entry => entry.category === 'DOCKER',
    JOURNAL_STATES.APPLIED,
    'Docker mutation completed'
  );
  await saveManifest(projectDir, manifest, normalizedMode);
}

async function restoreExternalResources(
  projectDir,
  manifest,
  mode = INSTALL_MODES.NORMAL,
  options = {}
) {
  const normalizedMode = normalizeMode(mode);
  const resources = Array.isArray(manifest.metadata && manifest.metadata.externalResources)
    ? manifest.metadata.externalResources : [];
  const audit = { removed: [], restored: [], preserved: [], conflict: [], failed: [] };
  for (const entry of resources) {
    if (!pathWithinRoot(entry.rootPath, entry.filePath)) {
      throw new Error(`Retained external resource escapes its root: ${entry.filePath}`);
    }
    if (entry.originalExisted) {
      const backupPath = path.join(
        backupRoot(projectDir, normalizedMode), entry.originalBackupRelativePath);
      if (!await fs.pathExists(backupPath)
          || !(await fs.lstat(backupPath)).isFile()
          || (entry.originalChecksum && await sha256File(backupPath) !== entry.originalChecksum)) {
        throw new Error(`Retained external snapshot is missing or invalid: ${entry.filePath}`);
      }
    }
  }
  for (const entry of [...resources].reverse()) {
    if (entry.originalExisted) {
      const backupPath = path.join(
        backupRoot(projectDir, normalizedMode), entry.originalBackupRelativePath);
      await fs.ensureDir(path.dirname(entry.filePath));
      await fs.copy(backupPath, entry.filePath, { overwrite: true });
      audit.restored.push({ resource: entry.filePath, detail: 'original external file restored' });
    } else {
      const externalFileExists = await fs.pathExists(entry.filePath);
      if (externalFileExists) {
        const currentChecksum = await sha256File(entry.filePath);
        if (entry.appliedChecksum && currentChecksum !== entry.appliedChecksum) {
          throw new Error(`External resource changed after installation; preserved: ${entry.filePath}`);
        }
        await fs.remove(entry.filePath);
        audit.removed.push({ resource: entry.filePath, detail: 'CLI-created external file removed' });
      }
    }
    if (!entry.rootExisted && await fs.pathExists(entry.rootPath)
        && (await fs.readdir(entry.rootPath)).length === 0) {
      await fs.remove(entry.rootPath);
    }
  }
  manifest.metadata.externalResources = [];
  Object.assign(manifest.metadata, options.metadataUpdates || {});
  await saveManifest(projectDir, manifest, normalizedMode);
  for (const entry of resources.filter(item => item.originalExisted)) {
    const backupPath = path.join(
      backupRoot(projectDir, normalizedMode), entry.originalBackupRelativePath);
    if (await fs.pathExists(backupPath)) await fs.remove(backupPath);
  }
  return audit;
}

async function rollbackInstallTransaction(
  projectDir,
  transactionId,
  mode = INSTALL_MODES.NORMAL,
  options = {}
) {
  const normalizedMode = normalizeMode(mode);
  const manifest = await loadManifest(projectDir, normalizedMode);
  if (!manifest.transaction || manifest.transaction.id !== transactionId) {
    throw new Error(`Cannot roll back unknown ${normalizedMode} install transaction`);
  }
  const failures = Array.isArray(options.failures) ? [...options.failures] : [];
  const transaction = manifest.transaction;
  if (Array.isArray(transaction.files)) {
    for (const entry of [...transaction.files].reverse()) {
      if (entry.prepared === false) continue;
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
        transitionJournal(
          transaction,
          entry => entry.state !== JOURNAL_STATES.COMMITTED,
          JOURNAL_STATES.ROLLED_BACK,
          'transaction resources restored'
        );
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
      transitionJournal(
        transaction,
        entry => entry.state !== JOURNAL_STATES.COMMITTED,
        JOURNAL_STATES.ROLLBACK_FAILED,
        failures.join('; ')
      );
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
  transitionJournal(
    manifest.transaction,
    entry => entry.state !== JOURNAL_STATES.COMMITTED,
    failures.length === 0 ? JOURNAL_STATES.ROLLED_BACK : JOURNAL_STATES.ROLLBACK_FAILED,
    failures.length === 0 ? 'transaction resources restored' : failures.join('; ')
  );
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
  LEGACY_MANIFEST_VERSION,
  RESOURCE_DIGEST_VERSION,
  TRANSACTION_JOURNAL_DIGEST_VERSION,
  JOURNAL_STATES,
  INSTALL_MODES,
  normalizeMode,
  stateRoot,
  manifestPath,
  installLockPath,
  backupRoot,
  appliedRoot,
  loadManifest,
  saveManifest,
  acquireInstallLock,
  releaseInstallLock,
  beginInstallTransaction,
  commitInstallTransaction,
  rollbackInstallTransaction,
  prepareExternalFileChange,
  recordExternalFileChange,
  prepareDockerMutation,
  recordDockerMutationApplied,
  restoreExternalResources,
  recordChange,
  recordInstallMetadata,
  sha256FileSync,
  calculateResourceDigest,
  calculateTransactionJournalDigest,
  projectOwnedPath,
  validatedRelativePath,
  assertNoSymlinkComponents,
};
