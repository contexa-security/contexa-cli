'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { dockerTry } = require('./docker');

const SIMULATION_PROJECT = 'ctxa-sim';
const SIMULATION_PROFILE = 'contexa-sim';
const SIMULATION_PORTS = Object.freeze({
  postgres: 25432,
  ollama: 31434,
  redis: 26379,
  zookeeper: 22181,
  kafka: 29092,
});

function derivedDatabasePassword(installationId) {
  if (typeof installationId !== 'string' || !installationId) {
    throw new Error('Simulation installation ID is required to derive the isolated database credential.');
  }
  return 'ctxa_' + crypto.createHash('sha256').update(installationId).digest('hex').slice(0, 24);
}

function simulationVariables(installationId) {
  return {
    CONTEXA_PROJECT: SIMULATION_PROJECT,
    COMPOSE_BIND_HOST: '127.0.0.1',
    CONTEXA_POSTGRES_PORT: String(SIMULATION_PORTS.postgres),
    CONTEXA_OLLAMA_PORT: String(SIMULATION_PORTS.ollama),
    CONTEXA_REDIS_PORT: String(SIMULATION_PORTS.redis),
    CONTEXA_ZOOKEEPER_PORT: String(SIMULATION_PORTS.zookeeper),
    CONTEXA_KAFKA_PORT: String(SIMULATION_PORTS.kafka),
    CONTEXA_DB_NAME: 'contexa_sim',
    CONTEXA_DB_USERNAME: 'contexa_sim',
    CONTEXA_DB_PASSWORD: derivedDatabasePassword(installationId),
    CONTEXA_DB_URL: `jdbc:postgresql://127.0.0.1:${SIMULATION_PORTS.postgres}/contexa_sim`,
    CONTEXA_CHAT_OLLAMA_BASE_URL: `http://127.0.0.1:${SIMULATION_PORTS.ollama}`,
    OLLAMA_BASE_URL: `http://127.0.0.1:${SIMULATION_PORTS.ollama}`,
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: String(SIMULATION_PORTS.redis),
    KAFKA_BOOTSTRAP_SERVERS: `127.0.0.1:${SIMULATION_PORTS.kafka}`,
    CONTEXA_SIMULATION_SERVER_PORT: '9080',
  };
}

function simulationEnvironment(baseEnvironment, installationId, activateProfile = false) {
  return {
    ...(baseEnvironment || {}),
    ...simulationVariables(installationId),
    ...(activateProfile ? { SPRING_PROFILES_ACTIVE: SIMULATION_PROFILE } : {}),
  };
}

function simulationOverlayPath(projectDir) {
  return path.join(projectDir, 'src', 'main', 'resources', `application-${SIMULATION_PROFILE}.yml`);
}

function simulationGeoIpPath(projectDir) {
  return path.join(projectDir, 'contexa', 'simulation', 'data', 'GeoLite2-City.mmdb');
}

function readPackageName(mainApplicationPath) {
  const source = fs.readFileSync(mainApplicationPath, 'utf8');
  const match = source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?/m);
  return match ? match[1] : '';
}

function simulationConfigurationPath(project) {
  const candidates = project && project.mainApplicationCandidates;
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    const count = Array.isArray(candidates) ? candidates.length : 0;
    throw new Error(`Simulation profile configuration requires exactly one main application class; found ${count}.`);
  }
  const packageName = readPackageName(candidates[0]);
  const sourceRoot = path.join(project.projectDir, 'src', 'main', 'java');
  return path.join(sourceRoot, ...(packageName ? packageName.split('.') : []),
    'ContexaSimulationConfiguration.java');
}

async function writeSimulationConfiguration(project, destination) {
  const packageName = readPackageName(project.mainApplicationCandidates[0]);
  const packageLine = packageName ? `package ${packageName};\n\n` : '';
  const content = packageLine
    + 'import io.contexa.contexacommon.annotation.EnableAISecurity;\n'
    + 'import io.contexa.contexacommon.security.bridge.SecurityMode;\n'
    + 'import org.springframework.context.annotation.Configuration;\n'
    + 'import org.springframework.context.annotation.Profile;\n\n'
    + '@Configuration(proxyBeanMethods = false)\n'
    + `@Profile("${SIMULATION_PROFILE}")\n`
    + '@EnableAISecurity(mode = SecurityMode.SANDBOX)\n'
    + 'public class ContexaSimulationConfiguration {\n'
    + '}\n';
  if (await fs.pathExists(destination)) {
    const existing = await fs.readFile(destination, 'utf8');
    if (existing !== content) {
      throw new Error(`Simulation configuration path is already user-owned: ${destination}`);
    }
    return { changed: false, filePath: destination };
  }
  await fs.ensureDir(path.dirname(destination));
  await fs.writeFile(destination, content, 'utf8');
  return { changed: true, filePath: destination };
}

function simulationRunCommand(projectDir) {
  return `contexa simulate run --dir "${path.resolve(projectDir)}"`;
}

function expectedSimulationServices(includeOllama = true) {
  return ['postgres', 'redis', 'zookeeper', 'kafka', ...(includeOllama ? ['ollama'] : [])];
}

function checkedDocker(args, description) {
  const result = dockerTry(args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  if (result.error || result.status !== 0) {
    const detail = result.stderr ? result.stderr.toString().trim() : '';
    throw result.error || new Error(`${description} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ? result.stdout.toString().trim() : '';
}

function verifySimulationInfrastructure(installationId, includeOllama = true) {
  const services = expectedSimulationServices(includeOllama);
  for (const service of services) {
    const container = `${SIMULATION_PROJECT}-${service}`;
    const state = checkedDocker([
      'inspect', '--format',
      '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{index .Config.Labels "io.ctxa.owner"}}|{{index .Config.Labels "io.ctxa.mode"}}|{{index .Config.Labels "io.ctxa.installation-id"}}',
      container,
    ], `${container} ownership and health inspection`).split('|');
    if (state[0] !== 'running' || state[1] !== 'healthy'
        || state[2] !== 'contexa-cli' || state[3] !== 'simulation'
        || state[4] !== installationId) {
      throw new Error(`Simulation service contract failed for ${container}: ${state.join('|')}`);
    }
  }

  const variables = simulationVariables(installationId);
  const probes = [
    ['postgres', ['exec', '-e', `PGPASSWORD=${variables.CONTEXA_DB_PASSWORD}`,
      `${SIMULATION_PROJECT}-postgres`, 'psql', '-h', '127.0.0.1',
      '-U', variables.CONTEXA_DB_USERNAME, '-d', variables.CONTEXA_DB_NAME,
      '-tAc', 'SELECT 1'], 'PostgreSQL authenticated query'],
    ['redis', ['exec', `${SIMULATION_PROJECT}-redis`, 'redis-cli', 'ping'], 'Redis PING'],
    ['zookeeper', ['exec', `${SIMULATION_PROJECT}-zookeeper`, 'nc', '-z', 'localhost', '2181'], 'Zookeeper TCP probe'],
    ['kafka', ['exec', `${SIMULATION_PROJECT}-kafka`, 'kafka-broker-api-versions',
      '--bootstrap-server', 'kafka:9093'], 'Kafka broker API probe'],
  ];
  if (includeOllama) {
    probes.push(
      ['ollama-version', ['exec', `${SIMULATION_PROJECT}-ollama`, 'ollama', '--version'], 'Ollama version probe'],
      ['ollama-list', ['exec', `${SIMULATION_PROJECT}-ollama`, 'ollama', 'list'], 'Ollama model API probe']
    );
  }
  const evidence = {};
  for (const [name, args, description] of probes) evidence[name] = checkedDocker(args, description);
  if (evidence.postgres !== '1') {
    throw new Error(`PostgreSQL authenticated query returned an unexpected value: ${evidence.postgres}`);
  }
  if (!/^PONG$/i.test(evidence.redis)) {
    throw new Error(`Redis PING returned an unexpected value: ${evidence.redis}`);
  }
  if (!evidence.kafka || !evidence.kafka.includes('kafka:9093')
      || /\bERROR\b|DisconnectException/i.test(evidence.kafka)) {
    throw new Error(`Kafka broker API probe returned an unexpected value: ${evidence.kafka}`);
  }
  return { services, probes: evidence };
}

async function waitForSimulationInfrastructure(installationId, includeOllama = true, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 120000 : Number(options.timeoutMs);
  const intervalMs = options.intervalMs === undefined ? 2000 : Number(options.intervalMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0
      || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('Simulation health timeout and interval must be valid positive bounds.');
  }
  const verify = options.verify || verifySimulationInfrastructure;
  const delay = options.delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      return verify(installationId, includeOllama);
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`Simulation infrastructure did not become healthy within ${timeoutMs}ms: ${lastError.message}`);
}

module.exports = {
  SIMULATION_PROJECT,
  SIMULATION_PROFILE,
  SIMULATION_PORTS,
  derivedDatabasePassword,
  simulationVariables,
  simulationEnvironment,
  simulationOverlayPath,
  simulationGeoIpPath,
  simulationConfigurationPath,
  writeSimulationConfiguration,
  simulationRunCommand,
  expectedSimulationServices,
  verifySimulationInfrastructure,
  waitForSimulationInfrastructure,
};
