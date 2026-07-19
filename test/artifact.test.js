'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const { ensureVerifiedArtifact, verifyArtifact } = require('../src/core/artifact');

const MARKER = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')]);

function mmdbBody(label = 'fixture') {
  return Buffer.concat([Buffer.from(`${label}-payload-`), MARKER, Buffer.from('-metadata')]);
}

function artifactContract(url, body, overrides = {}) {
  return {
    version: 'test-v1',
    url,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length,
    format: 'maxmind-mmdb',
    ...overrides,
  };
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'contexa-artifact-'));
}

async function assertNoPartialFiles(directory) {
  const entries = await fs.readdir(directory);
  assert.deepEqual(entries.filter(name => name.includes('.part-')), []);
}

async function withServer(handler, body) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    return await body(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('verified local artifact is installed atomically and a valid destination performs zero I/O', async () => {
  const directory = await temporaryDirectory();
  try {
    const source = path.join(directory, 'source.mmdb');
    const destination = path.join(directory, 'data', 'GeoLite2-City.mmdb');
    const body = mmdbBody('local');
    await fs.writeFile(source, body);
    const contract = artifactContract('https://example.invalid/GeoLite2-City.mmdb', body);

    const installed = await ensureVerifiedArtifact(contract, { destination, sourcePath: source });
    assert.equal(installed.changed, true);
    assert.equal(await verifyArtifact(destination, contract), true);

    const retained = await ensureVerifiedArtifact(contract, {
      destination,
      sourcePath: path.join(directory, 'missing-source.mmdb'),
    });
    assert.equal(retained.changed, false);
    assert.deepEqual(await fs.readFile(destination), body);
    await assertNoPartialFiles(path.dirname(destination));
  } finally {
    await fs.remove(directory);
  }
});

test('HTTP artifact path accepts a bounded redirect and installs verified bytes', async () => {
  const directory = await temporaryDirectory();
  const body = mmdbBody('http');
  let requests = 0;
  try {
    await withServer((request, response) => {
      requests += 1;
      if (request.url === '/redirect') {
        response.writeHead(307, { location: '/artifact' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    }, async baseUrl => {
      const destination = path.join(directory, 'GeoLite2-City.mmdb');
      const result = await ensureVerifiedArtifact(artifactContract(`${baseUrl}/redirect`, body), {
        destination,
        timeoutMs: 1000,
      });
      assert.equal(result.changed, true);
      assert.equal(requests, 2);
      assert.deepEqual(await fs.readFile(destination), body);
    });
  } finally {
    await fs.remove(directory);
  }
});

test('HTTP failures never publish or retain a partial artifact', async t => {
  const body = mmdbBody('failure');
  await withServer((request, response) => {
    if (request.url === '/404') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.url === '/partial') {
      response.writeHead(200, { 'content-length': body.length });
      response.end(body.subarray(0, body.length - 2));
      return;
    }
    if (request.url === '/oversize') {
      response.writeHead(200);
      response.end(Buffer.concat([body, Buffer.from('x')]));
      return;
    }
    if (request.url === '/slow') {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-length': body.length });
          response.end(body);
        }
      }, 300);
      return;
    }
    if (request.url === '/bad-format') {
      const invalid = Buffer.alloc(body.length, 0x31);
      response.writeHead(200, { 'content-length': invalid.length });
      response.end(invalid);
      return;
    }
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  }, async baseUrl => {
    const cases = [
      { name: '404', path: '/404', timeoutMs: 1000 },
      { name: 'partial response', path: '/partial', timeoutMs: 1000 },
      { name: 'oversize response', path: '/oversize', timeoutMs: 1000 },
      { name: 'socket timeout', path: '/slow', timeoutMs: 50 },
      { name: 'checksum mismatch', path: '/valid', timeoutMs: 1000, overrides: { sha256: '0'.repeat(64) } },
      {
        name: 'format mismatch',
        path: '/bad-format',
        timeoutMs: 1000,
        contractBody: Buffer.alloc(body.length, 0x31),
      },
    ];

    for (const failure of cases) {
      await t.test(failure.name, async () => {
        const directory = await temporaryDirectory();
        try {
          const destination = path.join(directory, 'GeoLite2-City.mmdb');
          const contractBody = failure.contractBody || body;
          const contract = artifactContract(`${baseUrl}${failure.path}`, contractBody, failure.overrides);
          await assert.rejects(() => ensureVerifiedArtifact(contract, {
            destination,
            timeoutMs: failure.timeoutMs,
          }));
          assert.equal(await fs.pathExists(destination), false);
          await assertNoPartialFiles(directory);
        } finally {
          await fs.remove(directory);
        }
      });
    }
  });
});

test('invalid local source checksum and format leave no destination', async () => {
  const directory = await temporaryDirectory();
  try {
    const source = path.join(directory, 'invalid.mmdb');
    const destination = path.join(directory, 'GeoLite2-City.mmdb');
    const valid = mmdbBody('expected');
    await fs.writeFile(source, Buffer.alloc(valid.length, 0x32));
    await assert.rejects(() => ensureVerifiedArtifact(
      artifactContract('https://example.invalid/GeoLite2-City.mmdb', valid),
      { destination, sourcePath: source },
    ));
    assert.equal(await fs.pathExists(destination), false);
    await assertNoPartialFiles(directory);
  } finally {
    await fs.remove(directory);
  }
});
