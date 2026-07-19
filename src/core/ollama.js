'use strict';

const http = require('http');
const { dockerTry } = require('./docker');
const { resolveProjectName } = require('./project');
const { DEFAULT_INFRASTRUCTURE_PORTS, SIMULATION_PORTS } = require('./infrastructure');
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

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function detectDockerPort(container) {
  const result = dockerTry(
    ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "11434/tcp") 0).HostPort}}', container],
    { stdio: 'pipe', timeout: TIMEOUTS.dockerInspectMs }
  );
  if (!result.error && result.status === 0) {
    const port = Number.parseInt((result.stdout || '').toString().trim(), 10);
    if (port > 0) return port;
  }
  return container.startsWith('ctxa-sim') ? SIMULATION_PORTS.ollama : DEFAULT_INFRASTRUCTURE_PORTS.ollama;
}

function isNativeOllamaRunning(port, timeoutMs = TIMEOUTS.httpHealthProbeMs) {
  return new Promise(resolve => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/tags', timeout: timeoutMs }, response => {
      resolve(response.statusCode === 200);
      response.resume();
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function detectOllamaSource(overrideContainer, dependencies = {}) {
  const inspect = dependencies.inspect || dockerTry;
  const resolveName = dependencies.resolveProjectName || resolveProjectName;
  const resolvePort = dependencies.detectDockerPort || detectDockerPort;
  const nativeRunning = dependencies.isNativeOllamaRunning || isNativeOllamaRunning;
  if (overrideContainer) {
    const result = inspect(['inspect', '--format', '{{.State.Running}}', overrideContainer], {
      stdio: 'pipe', timeout: TIMEOUTS.dockerInspectMs,
    });
    if (!result.error && result.status === 0
        && (result.stdout || '').toString().trim() === 'true') {
      return { type: 'docker', container: overrideContainer, port: resolvePort(overrideContainer) };
    }
    return { type: null };
  }

  const project = resolveName();
  const candidates = [`${project}-ollama`];
  if (project !== 'contexa') candidates.push('contexa-ollama');
  if (project !== 'ctxa-sim') candidates.push('ctxa-sim-ollama');
  for (const container of candidates) {
    const result = inspect(['inspect', '--format', '{{.State.Running}}', container], {
      stdio: 'pipe', timeout: TIMEOUTS.dockerInspectMs,
    });
    if (!result.error && result.status === 0
        && (result.stdout || '').toString().trim() === 'true') {
      return { type: 'docker', container, port: resolvePort(container) };
    }
  }

  return await nativeRunning(DEFAULT_INFRASTRUCTURE_PORTS.ollama)
    ? { type: 'native', port: DEFAULT_INFRASTRUCTURE_PORTS.ollama }
    : { type: null };
}

async function waitForDockerOllama(container, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const probe = dockerTry(['exec', container, 'ollama', 'list'], {
      stdio: 'ignore', timeout: TIMEOUTS.ollamaCommandProbeMs,
    });
    if (!probe.error && probe.status === 0) return true;
    await sleep(TIMEOUTS.simulationPollMs);
  }
  return false;
}

async function waitForNativeOllama(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    if (await isNativeOllamaRunning(port)) return true;
    await sleep(TIMEOUTS.simulationPollMs);
  }
  return false;
}

module.exports = {
  pullOllamaModelWithProgress,
  configuredPullTimeoutMs,
  detectDockerPort,
  isNativeOllamaRunning,
  detectOllamaSource,
  waitForDockerOllama,
  waitForNativeOllama,
};
