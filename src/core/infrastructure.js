'use strict';

const DEFAULT_INFRASTRUCTURE_PORTS = Object.freeze({
  postgres: 5432,
  ollama: 11434,
  redis: 6379,
  zookeeper: 2181,
  kafka: 9092,
});

const SIMULATION_PORTS = Object.freeze({
  postgres: 25432,
  ollama: 31434,
  redis: 26379,
  zookeeper: 22181,
  kafka: 29092,
});

const INFRASTRUCTURE_IMAGE_DEFAULTS = Object.freeze({
  pgvector: 'pg16',
  ollama: '0.18.2',
  redis: '7.2-alpine',
  kafkaPlatform: '7.4.0',
});

const INFRASTRUCTURE_SERVICE_CONTRACTS = Object.freeze({
  postgres: Object.freeze({
    image: `pgvector/pgvector:${INFRASTRUCTURE_IMAGE_DEFAULTS.pgvector}`,
    version: '16',
  }),
  redis: Object.freeze({
    image: `redis:${INFRASTRUCTURE_IMAGE_DEFAULTS.redis}`,
    version: '7.2',
  }),
  zookeeper: Object.freeze({
    image: `confluentinc/cp-zookeeper:${INFRASTRUCTURE_IMAGE_DEFAULTS.kafkaPlatform}`,
    version: INFRASTRUCTURE_IMAGE_DEFAULTS.kafkaPlatform,
  }),
  kafka: Object.freeze({
    image: `confluentinc/cp-kafka:${INFRASTRUCTURE_IMAGE_DEFAULTS.kafkaPlatform}`,
    version: INFRASTRUCTURE_IMAGE_DEFAULTS.kafkaPlatform,
  }),
  ollama: Object.freeze({
    image: `ollama/ollama:${INFRASTRUCTURE_IMAGE_DEFAULTS.ollama}`,
    version: INFRASTRUCTURE_IMAGE_DEFAULTS.ollama,
  }),
});

const DEFAULT_DEVELOPMENT_DB_PASSWORD = 'contexa1234!@#';

function configuredPort(environmentName, fallback, environment = process.env) {
  const raw = environment[environmentName];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    const error = new Error(`INVALID_PORT ${environmentName} must be an integer between 1 and 65535.`);
    error.code = 'INVALID_PORT';
    error.messageKey = 'common.invalidPort';
    error.messageArgs = [environmentName];
    throw error;
  }
  return value;
}

module.exports = {
  DEFAULT_INFRASTRUCTURE_PORTS,
  SIMULATION_PORTS,
  INFRASTRUCTURE_IMAGE_DEFAULTS,
  INFRASTRUCTURE_SERVICE_CONTRACTS,
  DEFAULT_DEVELOPMENT_DB_PASSWORD,
  configuredPort,
};
