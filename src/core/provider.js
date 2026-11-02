'use strict';

// AI model providers Contexa can be set up with, and the Ollama models it uses by default.
// The default chat model is the one Contexa itself falls back to (qwen3:8b), so the settings
// and the downloaded model always agree.

const SUPPORTED_PROVIDERS = Object.freeze(['ollama', 'openai', 'anthropic']);
const DEFAULT_OLLAMA_CHAT_MODEL = 'qwen3:8b';
const DEFAULT_OLLAMA_EMBEDDING_MODEL = 'mxbai-embed-large';
const APPROXIMATE_MODEL_SIZE_GB = Object.freeze({
  'qwen3:8b': 5.2,
  'mxbai-embed-large': 0.7,
});
const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9._\-:/]+$/;

function providerError(code, key, args = []) {
  const error = new Error(`${code} ${args.join(' ')}`.trim());
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

function normalizeProvider(value) {
  if (value === undefined || value === null || value === '') return null;
  const provider = String(value).trim().toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw providerError('INVALID_PROVIDER', 'common.invalidProvider',
      [String(value), SUPPORTED_PROVIDERS.join(', ')]);
  }
  return provider;
}

// Ollama serves chat for "ollama", and embeddings for both "ollama" and "anthropic" (Anthropic has
// no embedding model).
function usesOllama(provider) {
  return provider === 'ollama' || provider === 'anthropic';
}

function isValidOllamaModel(name) {
  return typeof name === 'string' && name.length > 0
    && name.length <= 200 && OLLAMA_MODEL_PATTERN.test(name);
}

function ollamaModels(environment = process.env) {
  const chat = environment.CONTEXA_OLLAMA_CHAT_MODEL || DEFAULT_OLLAMA_CHAT_MODEL;
  const embedding = environment.CONTEXA_OLLAMA_EMBEDDING_MODEL || DEFAULT_OLLAMA_EMBEDDING_MODEL;
  for (const model of [chat, embedding]) {
    if (!isValidOllamaModel(model)) {
      throw providerError('INVALID_OLLAMA_MODEL', 'common.invalidOllamaModel', [model]);
    }
  }
  return { chat, embedding };
}

module.exports = {
  SUPPORTED_PROVIDERS,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  APPROXIMATE_MODEL_SIZE_GB,
  normalizeProvider,
  usesOllama,
  isValidOllamaModel,
  ollamaModels,
};
