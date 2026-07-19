'use strict';

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const {
  INSTALL_MODES,
  appliedRoot,
  backupRoot,
  loadManifest,
  saveManifest,
  sha256FileSync,
  validatedRelativePath,
} = require('./manifest');

const MAX_MERGE_BYTES = 2 * 1024 * 1024;

function emptyAudit() {
  return { removed: [], restored: [], preserved: [], conflict: [], failed: [] };
}

function buildDockerResourceContract(projectName, options = {}) {
  const services = ['postgres'];
  const volumes = ['pgdata'];
  if (options.includeOllama) {
    services.push('ollama');
    volumes.push('ollama-data');
  }
  if (options.infra === 'distributed') {
    services.push('redis', 'zookeeper', 'kafka');
    volumes.push('redis-data', 'zookeeper-data', 'kafka-data');
  }
  return {
    owner: 'contexa-cli',
    mode: options.mode === INSTALL_MODES.SIMULATION ? INSTALL_MODES.SIMULATION : INSTALL_MODES.NORMAL,
    installationId: options.installationId,
    projectName,
    containers: services.map(service => `${projectName}-${service}`),
    volumes: volumes.map(volume => `${projectName}_${volume}`),
    networks: [`${projectName}_default`],
  };
}

function dockerContractResources(contract) {
  return [
    ...(contract.containers || []).map(name => ({ type: 'container', name })),
    ...(contract.volumes || []).map(name => ({ type: 'volume', name })),
    ...(contract.networks || []).map(name => ({ type: 'network', name })),
  ];
}

function validateDockerContract(contract, expected) {
  if (!contract || contract.owner !== 'contexa-cli'
      || contract.mode !== expected.mode
      || contract.installationId !== expected.installationId
      || contract.projectName !== expected.projectName) {
    throw new Error('Docker resource contract is missing or does not match the ownership manifest.');
  }
  const resources = dockerContractResources(contract);
  if (resources.length === 0) throw new Error('Docker resource contract has no exact resource IDs.');
  const names = new Set();
  for (const resource of resources) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(resource.name) || names.has(`${resource.type}:${resource.name}`)) {
      throw new Error(`Docker resource ID is invalid or duplicated: ${resource.name}`);
    }
    names.add(`${resource.type}:${resource.name}`);
  }
  return resources;
}

async function performOwnedDockerCleanup(context, adapter) {
  if (!adapter.isCliInstalled()) throw new Error('Docker CLI is unavailable; owned resources were not changed.');
  if (!adapter.isDaemonRunning()) throw new Error('Docker daemon is unavailable; owned resources were not changed.');
  const resources = validateDockerContract(context.contract, context);
  const present = [];
  for (const resource of resources) {
    const labels = adapter.inspectLabels(resource.type, resource.name);
    if (!labels) continue;
    if (labels['io.ctxa.owner'] !== 'contexa-cli'
        || labels['io.ctxa.mode'] !== context.mode
        || labels['io.ctxa.installation-id'] !== context.installationId
        || labels['com.docker.compose.project'] !== context.projectName) {
      throw new Error(`Docker ${resource.type} ownership mismatch; preserved: ${resource.name}`);
    }
    present.push(resource);
  }
  const composePath = path.join(context.infraDir, 'docker-compose.yml');
  if (await fs.pathExists(composePath)) {
    if (!context.composeChecksum || sha256FileSync(composePath) !== context.composeChecksum) {
      throw new Error(`Owned compose checksum mismatch; preserved: ${composePath}`);
    }
    await adapter.composeDown(context.projectName, context.infraDir, context.env);
  } else if (present.length > 0) {
    throw new Error(`compose file is missing while owned Docker resources still exist: ${composePath}`);
  }
  const remaining = resources.filter(resource => adapter.inspectLabels(resource.type, resource.name));
  if (remaining.length > 0) {
    throw new Error(`Docker cleanup left owned resources: ${remaining.map(resource => resource.name).join(', ')}`);
  }
  const audit = emptyAudit();
  for (const resource of resources) {
    record(audit, 'removed', `docker:${resource.type}:${resource.name}`,
      present.some(item => item.type === resource.type && item.name === resource.name)
        ? 'verified owner labels and removed' : 'already absent');
  }
  if (await fs.pathExists(composePath)) {
    await fs.remove(composePath);
    record(audit, 'removed', composePath, 'verified compose file removed');
  }
  if (await fs.pathExists(context.infraDir) && (await fs.readdir(context.infraDir)).length === 0) {
    await fs.remove(context.infraDir);
  }
  return audit;
}

function record(audit, status, resource, detail) {
  audit[status].push({ resource, ...(detail ? { detail } : {}) });
}

function fileChecksum(filePath) {
  return fs.existsSync(filePath) ? sha256FileSync(filePath) : null;
}

function isMergeableText(buffer) {
  return buffer.length <= MAX_MERGE_BYTES && !buffer.includes(0);
}

function splitText(value) {
  const normalized = value.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinText(lines, trailingNewline, newline) {
  return lines.join(newline) + (trailingNewline ? newline : '');
}

function diffHunks(baseLines, appliedLines) {
  const rowCount = baseLines.length + 1;
  const columnCount = appliedLines.length + 1;
  if (rowCount * columnCount > 4_000_000) return null;
  const matrix = Array.from({ length: rowCount }, () => new Uint32Array(columnCount));
  for (let i = baseLines.length - 1; i >= 0; i--) {
    for (let j = appliedLines.length - 1; j >= 0; j--) {
      matrix[i][j] = baseLines[i] === appliedLines[j]
        ? matrix[i + 1][j + 1] + 1
        : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }
  const operations = [];
  let i = 0, j = 0;
  while (i < baseLines.length || j < appliedLines.length) {
    if (i < baseLines.length && j < appliedLines.length && baseLines[i] === appliedLines[j]) {
      operations.push({ type: 'equal', line: baseLines[i] });
      i++; j++;
    } else if (j < appliedLines.length
        && (i === baseLines.length || matrix[i][j + 1] > matrix[i + 1][j])) {
      operations.push({ type: 'add', line: appliedLines[j++] });
    } else {
      operations.push({ type: 'remove', line: baseLines[i++] });
    }
  }
  const hunks = [];
  for (let index = 0; index < operations.length;) {
    if (operations[index].type === 'equal') { index++; continue; }
    const previous = index > 0 && operations[index - 1].type === 'equal'
      ? operations[index - 1].line : null;
    const removed = [], added = [];
    while (index < operations.length && operations[index].type !== 'equal') {
      if (operations[index].type === 'remove') removed.push(operations[index].line);
      else added.push(operations[index].line);
      index++;
    }
    const next = index < operations.length ? operations[index].line : null;
    hunks.push({ previous, next, removed, added });
  }
  return hunks;
}

function matchesAt(lines, start, expected) {
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((line, offset) => lines[start + offset] === line);
}

function inverseTextMerge(baseText, appliedText, currentText) {
  const base = splitText(baseText);
  const applied = splitText(appliedText);
  const current = splitText(currentText);
  const hunks = diffHunks(base.lines, applied.lines);
  if (!hunks) return null;
  const result = [...current.lines];
  for (const hunk of [...hunks].reverse()) {
    const candidates = [];
    if (hunk.added.length > 0) {
      for (let index = 0; index <= result.length - hunk.added.length; index++) {
        if (!matchesAt(result, index, hunk.added)) continue;
        if (hunk.previous !== null && result[index - 1] !== hunk.previous) continue;
        if (hunk.next !== null && result[index + hunk.added.length] !== hunk.next) continue;
        candidates.push(index);
      }
    } else {
      for (let index = 0; index <= result.length; index++) {
        if (hunk.previous !== null && result[index - 1] !== hunk.previous) continue;
        if (hunk.next !== null && result[index] !== hunk.next) continue;
        candidates.push(index);
      }
    }
    if (candidates.length !== 1) return null;
    result.splice(candidates[0], hunk.added.length, ...hunk.removed);
  }
  const newline = currentText.includes('\r\n') ? '\r\n' : '\n';
  return joinText(result, current.trailingNewline, newline);
}

function readPath(root, parts) {
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { exists: false, value: undefined };
    }
    current = current[part];
  }
  return { exists: true, value: current };
}

function setPath(root, parts, value) {
  let current = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function deletePath(root, parts) {
  const parents = [];
  let current = root;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return;
    parents.push([current, part]);
    current = current[part];
  }
  if (current && typeof current === 'object') delete current[parts[parts.length - 1]];
  for (const [parent, key] of parents.reverse()) {
    const child = parent[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function yamlManagedPathMerge(baseText, appliedText, currentText, managedPaths, generated) {
  let base, applied, current;
  try {
    base = yaml.load(baseText) || {};
    applied = yaml.load(appliedText) || {};
    current = yaml.load(currentText) || {};
  } catch {
    return null;
  }
  if ([base, applied, current].some(value => !value || typeof value !== 'object' || Array.isArray(value))) return null;
  for (const managedPath of managedPaths) {
    const parts = ['contexa', ...managedPath.split('.')];
    const baseValue = readPath(base, parts);
    const appliedValue = readPath(applied, parts);
    const currentValue = readPath(current, parts);
    if (currentValue.exists === appliedValue.exists && equalValue(currentValue.value, appliedValue.value)) {
      if (baseValue.exists) setPath(current, parts, baseValue.value);
      else deletePath(current, parts);
    } else if (!(currentValue.exists === baseValue.exists && equalValue(currentValue.value, baseValue.value))) {
      return null;
    }
  }
  if (generated && Object.keys(current).length === 0) return '';
  return yaml.dump(current, { lineWidth: 200, noRefs: true, sortKeys: false, quotingType: '"' });
}

async function removeTrackedSnapshots(projectDir, mode, entry) {
  const originalBackup = path.join(backupRoot(projectDir, mode), entry.relativePath);
  const appliedSnapshot = path.join(appliedRoot(projectDir, mode), entry.relativePath);
  if (await fs.pathExists(originalBackup)) await fs.remove(originalBackup);
  if (await fs.pathExists(appliedSnapshot)) await fs.remove(appliedSnapshot);
}

async function restoreEntry(projectDir, mode, entry) {
  const target = validatedRelativePath(projectDir, entry.relativePath);
  const currentChecksum = fileChecksum(target);
  const originalChecksum = entry.originalChecksum || null;
  const appliedChecksum = entry.appliedChecksum || entry.lastCliChecksum || entry.currentChecksum || null;
  if (currentChecksum === originalChecksum) return { status: 'restored', detail: 'already at original state' };
  if (currentChecksum === null) {
    return entry.generated
      ? { status: 'removed', detail: 'already absent' }
      : { status: 'preserved', detail: 'user deletion preserved' };
  }
  const originalBackup = path.join(backupRoot(projectDir, mode), entry.relativePath);
  if (currentChecksum === appliedChecksum) {
    if (entry.generated) {
      await fs.remove(target);
      return { status: 'removed' };
    }
    await fs.copy(originalBackup, target, { overwrite: true });
    return { status: 'restored' };
  }
  const appliedSnapshot = entry.appliedRelativePath
    ? path.join(backupRoot(projectDir, mode), entry.appliedRelativePath)
    : path.join(appliedRoot(projectDir, mode), entry.relativePath);
  if (!await fs.pathExists(appliedSnapshot)) return { status: 'conflict', detail: 'CLI-applied snapshot is unavailable' };
  const currentBuffer = await fs.readFile(target);
  const appliedBuffer = await fs.readFile(appliedSnapshot);
  const baseBuffer = await fs.pathExists(originalBackup) ? await fs.readFile(originalBackup) : Buffer.alloc(0);
  if (![currentBuffer, appliedBuffer, baseBuffer].every(isMergeableText)) {
    return { status: 'conflict', detail: 'binary or oversized user-modified file' };
  }
  const currentText = currentBuffer.toString('utf8');
  const appliedText = appliedBuffer.toString('utf8');
  const baseText = baseBuffer.toString('utf8');
  let merged = inverseTextMerge(baseText, appliedText, currentText);
  if (merged === null && /\.ya?ml$/i.test(target) && Array.isArray(entry.managedPaths) && entry.managedPaths.length > 0) {
    merged = yamlManagedPathMerge(baseText, appliedText, currentText, entry.managedPaths, entry.generated);
  }
  if (merged === null) return { status: 'conflict', detail: 'automatic 3-way merge is unsafe' };
  if (entry.generated && merged.length === 0) await fs.remove(target);
  else await fs.writeFile(target, merged, 'utf8');
  return { status: 'preserved', detail: 'user changes preserved; CLI changes removed' };
}

async function restoreProjectFiles(projectDir, mode = INSTALL_MODES.NORMAL) {
  const manifest = await loadManifest(projectDir, mode);
  const audit = emptyAudit();
  const remaining = [];
  const entries = [...manifest.files].sort((left, right) => right.relativePath.length - left.relativePath.length);
  for (const entry of entries) {
    try {
      const outcome = await restoreEntry(projectDir, mode, entry);
      record(audit, outcome.status, entry.relativePath, outcome.detail);
      if (outcome.status === 'conflict') remaining.push(entry);
      else await removeTrackedSnapshots(projectDir, mode, entry);
    } catch (error) {
      record(audit, 'failed', entry.relativePath, error.message);
      remaining.push(entry);
    }
  }
  manifest.files = remaining;
  await saveManifest(projectDir, manifest, mode);
  return { audit, manifest };
}

function auditIssueCount(audit) {
  return audit.conflict.length + audit.failed.length;
}

module.exports = {
  buildDockerResourceContract,
  validateDockerContract,
  performOwnedDockerCleanup,
  emptyAudit,
  inverseTextMerge,
  yamlManagedPathMerge,
  restoreProjectFiles,
  auditIssueCount,
};
