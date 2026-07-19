'use strict';

const SUPPORTED_PROVIDERS = Object.freeze(['openai', 'anthropic', 'ollama']);
const DEFAULT_OLLAMA_CHAT_MODEL = 'qwen2.5:7b';
const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'mxbai-embed-large';
const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9._\-:/]+$/;

function normalizeProviders(providerOption, options = {}) {
  const includeOllama = !!options.includeOllama;
  const simulate = !!options.simulate;
  if (!providerOption) return includeOllama || simulate ? ['ollama'] : [];

  const values = String(providerOption)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes('none')) return [];

  const invalid = values.filter(value => !SUPPORTED_PROVIDERS.includes(value));
  if (invalid.length > 0) {
    const error = new Error(
      `INVALID_PROVIDER Unsupported provider: ${invalid.join(', ')}. `
      + `Use ${SUPPORTED_PROVIDERS.join(', ')}, or none.`
    );
    error.code = 'INVALID_PROVIDER';
    throw error;
  }
  return [...new Set(values)];
}

function isValidOllamaModel(name) {
  return typeof name === 'string' && name.length > 0
    && name.length <= 200 && OLLAMA_MODEL_PATTERN.test(name);
}

module.exports = {
  SUPPORTED_PROVIDERS,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  normalizeProviders,
  isValidOllamaModel,
};
