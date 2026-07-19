'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');

const MAXMIND_MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')]);

async function ensureVerifiedArtifact(contract, options) {
  validateContract(contract);
  const destination = path.resolve(options.destination);
  const existing = await verifyArtifact(destination, contract, { allowMissing: true });
  if (existing) return { changed: false, destination };

  await fs.ensureDir(path.dirname(destination));
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.part-${process.pid}-${Date.now()}`);
  try {
    if (options.sourcePath) {
      await fs.copy(path.resolve(options.sourcePath), temporary, { overwrite: false });
    } else {
      await downloadToFile(contract.url, temporary, contract.size, options.timeoutMs || 120000);
    }
    await verifyArtifact(temporary, contract);
    if (await fs.pathExists(destination)) {
      throw new Error(`Artifact destination appeared during installation: ${destination}`);
    }
    await fs.move(temporary, destination, { overwrite: false });
    return { changed: true, destination };
  } finally {
    if (await fs.pathExists(temporary)) await fs.remove(temporary);
  }
}

function validateContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('Artifact contract is required.');
  if (!/^[0-9a-f]{64}$/.test(String(contract.sha256 || ''))) throw new Error('Artifact SHA-256 contract is invalid.');
  if (!Number.isSafeInteger(contract.size) || contract.size < MAXMIND_MARKER.length) throw new Error('Artifact size contract is invalid.');
  if (contract.format !== 'maxmind-mmdb') throw new Error(`Unsupported artifact format: ${contract.format}`);
  const uri = new URL(contract.url);
  const loopback = uri.hostname === '127.0.0.1' || uri.hostname === 'localhost' || uri.hostname === '::1';
  if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && loopback)) {
    throw new Error('Artifact URL must use HTTPS or a loopback test server.');
  }
}

async function verifyArtifact(filePath, contract, options = {}) {
  if (!await fs.pathExists(filePath)) {
    if (options.allowMissing) return false;
    throw new Error(`Artifact file is missing: ${filePath}`);
  }
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size !== contract.size) {
    throw new Error(`Artifact size mismatch: expected=${contract.size} actual=${stat.size}`);
  }
  const digest = await sha256File(filePath);
  if (digest !== contract.sha256) throw new Error(`Artifact checksum mismatch: expected=${contract.sha256} actual=${digest}`);
  const markerLength = Math.min(stat.size, 131072);
  const handle = await nativeFs.promises.open(filePath, 'r');
  try {
    const tail = Buffer.alloc(markerLength);
    await handle.read(tail, 0, markerLength, stat.size - markerLength);
    if (!tail.includes(MAXMIND_MARKER)) throw new Error('Artifact format mismatch: MaxMind metadata marker is missing.');
  } finally {
    await handle.close();
  }
  return true;
}

function downloadToFile(url, destination, expectedSize, timeoutMs, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) { reject(new Error('Artifact download exceeded the redirect limit.')); return; }
    const uri = new URL(url);
    const client = uri.protocol === 'https:' ? https : http;
    let settled = false;
    let responseStarted = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    };
    const request = client.get(uri, { headers: { 'User-Agent': 'contexa-cli/artifact' } }, async response => {
      responseStarted = true;
      if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        settled = true;
        clearTimeout(deadline);
        downloadToFile(new URL(response.headers.location, uri).toString(), destination, expectedSize, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`Artifact download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const declaredSize = Number(response.headers['content-length']);
      if (Number.isFinite(declaredSize) && declaredSize !== expectedSize) {
        response.resume();
        finish(new Error(`Artifact Content-Length mismatch: expected=${expectedSize} actual=${declaredSize}`));
        return;
      }
      let received = 0;
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.on('data', chunk => {
        received += chunk.length;
        if (received > expectedSize) response.destroy(new Error('Artifact response exceeded the expected size.'));
      });
      try {
        await pipeline(response, output);
        finish(received === expectedSize ? null : new Error(`Artifact body size mismatch: expected=${expectedSize} actual=${received}`));
      } catch (error) {
        finish(error);
      }
    });
    request.setTimeout(Math.min(timeoutMs, 30000), () => request.destroy(new Error('Artifact socket timeout exceeded.')));
    request.on('error', error => {
      if (!responseStarted) finish(error);
    });
    const deadline = setTimeout(() => request.destroy(new Error('Artifact total timeout exceeded.')), timeoutMs);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { ensureVerifiedArtifact, verifyArtifact };
