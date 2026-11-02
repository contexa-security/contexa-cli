'use strict';

// Downloads an Ollama model through its HTTP API and shows the progress on a spinner.

const http = require('http');
const { TIMEOUTS } = require('./timeouts');

function configuredPullTimeoutMs() {
  const raw = process.env.CONTEXA_OLLAMA_PULL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return TIMEOUTS.ollamaPullMs;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > TIMEOUTS.ollamaPullMaximumMs) {
    throw new Error(
      `CONTEXA_OLLAMA_PULL_TIMEOUT_MS must be an integer between 1 and ${TIMEOUTS.ollamaPullMaximumMs}`
    );
  }
  return value;
}

function pullOllamaModelWithProgress(port, modelName, spinnerInstance, stepTextTemplate, options = {}) {
  const timeoutMs = options.timeoutMs === undefined
    ? configuredPullTimeoutMs()
    : Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Ollama pull timeout must be greater than zero'));
  }

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ name: modelName });
    let request;
    let response;
    let settled = false;
    let buffer = '';

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        if (response && !response.destroyed) response.destroy();
        if (request && !request.destroyed) request.destroy();
        reject(error);
        return;
      }
      resolve();
    };

    const processLine = (line) => {
      if (!line.trim() || settled) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (payload.error) {
        finish(new Error(payload.error));
        return;
      }
      const statusText = payload.status || 'pulling';
      if (payload.total && payload.completed) {
        const percent = Math.floor((payload.completed / payload.total) * 100);
        spinnerInstance.text = `${stepTextTemplate} [${percent}%]`;
      } else {
        spinnerInstance.text = `${stepTextTemplate} (${statusText})`;
      }
    };

    const deadline = setTimeout(() => {
      finish(new Error(`Ollama model pull exceeded ${timeoutMs}ms: ${modelName}`));
    }, timeoutMs);

    request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/pull',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      response = res;
      if (res.statusCode !== 200) {
        res.resume();
        finish(new Error(`Ollama returned status ${res.statusCode}`));
        return;
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(processLine);
      });
      res.on('aborted', () => finish(new Error(`Ollama response was aborted: ${modelName}`)));
      res.on('error', finish);
      res.on('end', () => {
        processLine(buffer);
        if (!settled) finish();
      });
    });

    request.setTimeout(Math.min(timeoutMs, TIMEOUTS.socketIdleMs), () => {
      finish(new Error(`Ollama model pull connection was idle: ${modelName}`));
    });
    request.on('error', finish);
    request.end(postData);
  });
}

module.exports = {
  pullOllamaModelWithProgress,
  configuredPullTimeoutMs,
};
