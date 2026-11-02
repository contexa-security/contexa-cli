'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { credentialsPath, hasCredential, readCredential, saveCredential } = require('../src/core/credentials');

const OPENAI = 'spring.ai.openai.api-key';
const ANTHROPIC = 'spring.ai.anthropic.api-key';

// os.homedir() follows USERPROFILE on Windows and HOME elsewhere, so the real home folder is
// never read or written here.
async function withTemporaryHome(action) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ctxa-credentials-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal(os.homedir(), home, 'the temporary home is in effect');
    return await action(home);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.remove(home);
  }
}

test('credentialsPath is ~/.contexa/credentials.properties', async () => {
  await withTemporaryHome(async home => {
    assert.equal(credentialsPath(), path.join(home, '.contexa', 'credentials.properties'));
  });
});

test('saveCredential stores a key outside the project and hasCredential finds it', async () => {
  await withTemporaryHome(async home => {
    assert.equal(await hasCredential(OPENAI), false, 'no file yet');
    const file = await saveCredential(OPENAI, '  sk-test-first  '.trim());
    assert.equal(file, path.join(home, '.contexa', 'credentials.properties'));
    assert.equal(await fs.readFile(file, 'utf8'),
      '# Contexa credentials (API keys, local admin-console password), written by `contexa init`. Keep this file private.\n'
      + 'spring.ai.openai.api-key=sk-test-first\n');
    assert.equal(await hasCredential(OPENAI), true);
    assert.equal(await hasCredential(ANTHROPIC), false);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  });
});

test('saveCredential replaces the value of the same key and keeps the others', async () => {
  await withTemporaryHome(async () => {
    await saveCredential(OPENAI, 'sk-test-first');
    await saveCredential(ANTHROPIC, 'sk-ant-test');
    await saveCredential(OPENAI, 'sk-test-second');
    const lines = (await fs.readFile(credentialsPath(), 'utf8')).split('\n');
    assert.deepEqual(lines, [
      '# Contexa credentials (API keys, local admin-console password), written by `contexa init`. Keep this file private.',
      'spring.ai.anthropic.api-key=sk-ant-test',
      'spring.ai.openai.api-key=sk-test-second',
      '',
    ]);
    assert.equal(await hasCredential(OPENAI), true);
    assert.equal(await hasCredential(ANTHROPIC), true);
  });
});

test('hasCredential accepts spaces around = and ignores empty values', async () => {
  await withTemporaryHome(async () => {
    await fs.outputFile(credentialsPath(), `${OPENAI} = sk-spaced\n${ANTHROPIC}=\n`);
    assert.equal(await hasCredential(OPENAI), true);
    assert.equal(await hasCredential(ANTHROPIC), false, 'an empty value is not a key');
    // A key written by hand with spaces is replaced, not duplicated.
    await saveCredential(OPENAI, 'sk-new');
    const text = await fs.readFile(credentialsPath(), 'utf8');
    assert.equal((text.match(/spring\.ai\.openai\.api-key/g) || []).length, 1);
    assert.match(text, /^spring\.ai\.openai\.api-key=sk-new$/m);
  });
});

test('saveCredential keeps a value on one line and escapes backslashes', async () => {
  await withTemporaryHome(async () => {
    await saveCredential(OPENAI, 'sk-a\\b\r\nnext');
    const text = await fs.readFile(credentialsPath(), 'utf8');
    assert.match(text, /^spring\.ai\.openai\.api-key=sk-a\\\\bnext$/m);
    assert.equal(text.split('\n').filter(Boolean).length, 2);
  });
});

test('readCredential returns the kept value, null when there is none', async () => {
  await withTemporaryHome(async () => {
    assert.equal(await readCredential('contexa.iam.seed.admin.password'), null);
    await saveCredential(OPENAI, 'sk-test');
    await saveCredential('contexa.iam.seed.admin.password', 'Kp7mVx2qRt9wZb4n');
    assert.equal(await readCredential('contexa.iam.seed.admin.password'), 'Kp7mVx2qRt9wZb4n');
    assert.equal(await readCredential(OPENAI), 'sk-test');
    assert.equal(await readCredential(ANTHROPIC), null);
  });
});
