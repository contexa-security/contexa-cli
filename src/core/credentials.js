'use strict';

// API keys entered during `contexa init`, and the password of the local admin-console account, are
// kept outside the project, in ~/.contexa/credentials.properties, so they never end up in source
// control or in a deployment. The Contexa configuration imports this file with
// `optional:file:${user.home}/.contexa/credentials.properties`; for API keys an environment variable
// (OPENAI_API_KEY / ANTHROPIC_API_KEY) works as well.

const fs = require('fs-extra');
const os = require('os');
const path = require('path');

function credentialsPath() {
  return path.join(os.homedir(), '.contexa', 'credentials.properties');
}

async function readCredentials() {
  try {
    return await fs.readFile(credentialsPath(), 'utf8');
  } catch {
    return '';
  }
}

async function hasCredential(property) {
  const text = await readCredentials();
  return new RegExp(`^\\s*${property.replace(/[.-]/g, '\\$&')}\\s*=\\s*\\S`, 'm').test(text);
}

// The value kept for `property`, or null.
async function readCredential(property) {
  const text = await readCredentials();
  const match = text.match(new RegExp(`^\\s*${property.replace(/[.-]/g, '\\$&')}\\s*[=:]\\s*(.*?)\\s*$`, 'm'));
  if (!match || !match[1]) return null;
  return match[1].replace(/\\(.)/g, '$1');
}

function escapeProperty(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '');
}

async function saveCredential(property, value) {
  const file = credentialsPath();
  await fs.ensureDir(path.dirname(file));
  const lines = (await readCredentials()).split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith(`${property}=`) && !line.trim().startsWith(`${property} =`));
  if (lines.length === 0) lines.push('# Contexa credentials (API keys, local admin-console password), written by `contexa init`. Keep this file private.');
  lines.push(`${property}=${escapeProperty(value)}`);
  await fs.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  try { await fs.chmod(file, 0o600); } catch { /* not supported on this file system */ }
  return file;
}

module.exports = { credentialsPath, hasCredential, readCredential, saveCredential };
