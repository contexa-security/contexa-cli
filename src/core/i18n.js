'use strict';

const SUPPORTED = ['en', 'ko'];
const DEFAULT_LOCALE = 'en';

let currentLocale = DEFAULT_LOCALE;

// Use require() so that esbuild inlines JSON bundles into the SEA binary.
// fs.readFileSync against a relative path would break once packaged.
const bundles = {
  en: require('../i18n/en.json'),
  ko: require('../i18n/ko.json'),
};

// Resolve the locale code from an arbitrary tag like "ko-KR.UTF-8" or "en_US".
// Returns null if the input is empty or does not match a supported language.
function resolveTag(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const m = tag.toLowerCase().match(/^([a-z]{2})/);
  if (!m) return null;
  return SUPPORTED.includes(m[1]) ? m[1] : null;
}

// Auto-detect from CLI arg, then env vars, then OS default. CLI arg wins.
function detectLocale(explicit) {
  return resolveTag(explicit)
      || resolveTag(process.env.CONTEXA_LANG)
      || resolveTag(process.env.LC_ALL)
      || resolveTag(process.env.LANG)
      || DEFAULT_LOCALE;
}

function setLocale(code) {
  currentLocale = SUPPORTED.includes(code) ? code : DEFAULT_LOCALE;
  return currentLocale;
}

function getLocale() {
  return currentLocale;
}

// Translate a key with optional positional arguments.
// Falls back to English bundle, then to the key itself - never throws.
function t(key, ...args) {
  const bundle = bundles[currentLocale] || bundles[DEFAULT_LOCALE];
  let value = bundle[key];
  if (value === undefined) value = bundles[DEFAULT_LOCALE][key];
  if (value === undefined) return key;
  return args.reduce((acc, arg, i) => acc.split(`{${i}}`).join(String(arg)), value);
}

module.exports = { detectLocale, setLocale, getLocale, t, SUPPORTED, DEFAULT_LOCALE };
