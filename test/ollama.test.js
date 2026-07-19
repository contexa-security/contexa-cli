'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { detectOllamaSource, pullOllamaModelWithProgress } = require('../src/core/ollama');

async function withServer(handler, action) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await action(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Ollama pull completes and reports streamed progress', async () => {
  const spinner = { text: '' };
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.end('{"status":"downloading","total":100,"completed":40}\n{"status":"success"}\n');
  }, async (port) => {
    await pullOllamaModelWithProgress(port, 'llama3.2', spinner, 'Pulling', { timeoutMs: 1000 });
  });
  assert.equal(spinner.text, 'Pulling (success)');
});

test('Ollama pull rejects a streamed error even without a trailing newline', async () => {
  await assert.rejects(
    withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end('{"error":"model not found"}');
    }, (port) => pullOllamaModelWithProgress(port, 'missing', { text: '' }, 'Pulling', { timeoutMs: 1000 })),
    /model not found/
  );
});

test('Ollama pull rejects non-success HTTP status', async () => {
  await assert.rejects(
    withServer((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    }, (port) => pullOllamaModelWithProgress(port, 'llama3.2', { text: '' }, 'Pulling', { timeoutMs: 1000 })),
    /status 503/
  );
});

test('Ollama pull aborts a hanging request at its configured deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    withServer(() => {}, (port) => pullOllamaModelWithProgress(
      port,
      'llama3.2',
      { text: '' },
      'Pulling',
      { timeoutMs: 80 }
    )),
    /exceeded 80ms/
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test('Ollama source detection awaits native reachability instead of treating a Promise as truthy', async () => {
  const unavailable = await detectOllamaSource(null, {
    inspect: () => ({ status: 1, stdout: '' }),
    resolveProjectName: () => 'phase5',
    isNativeOllamaRunning: async () => false,
  });
  assert.deepEqual(unavailable, { type: null });

  const native = await detectOllamaSource(null, {
    inspect: () => ({ status: 1, stdout: '' }),
    resolveProjectName: () => 'phase5',
    isNativeOllamaRunning: async () => true,
  });
  assert.deepEqual(native, { type: 'native', port: 11434 });
});
