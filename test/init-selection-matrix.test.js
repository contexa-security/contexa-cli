'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const inquirer = require('inquirer');
const { buildInitDefaults, collectInitAnswers } = require('../src/core/init-input');

const originalPrompt = inquirer.prompt;

async function collect(selection, options = {}) {
  let questions;
  inquirer.prompt = async value => {
    questions = value;
    return { ...selection };
  };
  try {
    const answers = await collectInitAnswers({
      dir: process.cwd(),
      docker: true,
      ...options,
    }, {
      hasDocker: true,
      hasEnableAiSecurity: false,
      hasHostSecurityFilterChain: false,
    }, 'matrix-project');
    return { answers, questions };
  } finally {
    inquirer.prompt = originalPrompt;
  }
}

function activeQuestionNames(questions, selection) {
  return questions
    .filter(question => question.when === undefined
      || (typeof question.when === 'function' ? question.when(selection) : question.when))
    .map(question => question.name);
}

test('quick defaults restore ready-to-run Contexa installation', () => {
  const { defaults } = buildInitDefaults({});
  assert.deepEqual(defaults, {
    setupMode: 'quick',
    integrationMode: 'merge',
    securityMode: 'full',
    mode: 'shadow',
    enableAiSecurity: true,
    autoAnnotate: true,
    llmProviders: ['ollama'],
    infra: 'standalone',
    injectDep: true,
    startDocker: true,
  });
});

test('quick selection applies provider, annotation and infrastructure choices', async () => {
  for (const providerQuick of ['openai', 'anthropic', 'ollama']) {
    for (const autoAnnotate of [true, false]) {
      const selection = { setupMode: 'quick', providerQuick, autoAnnotate };
      const { answers, questions } = await collect(selection);
      assert.equal(answers.setupMode, 'quick');
      assert.equal(answers.integrationMode, 'merge');
      assert.equal(answers.securityMode, 'full');
      assert.equal(answers.mode, 'shadow');
      assert.equal(answers.enableAiSecurity, true);
      assert.equal(answers.autoAnnotate, autoAnnotate);
      assert.deepEqual(answers.llmProviders, [providerQuick]);
      assert.equal(answers.infra, 'standalone');
      assert.equal(answers.startDocker, true);
      const active = activeQuestionNames(questions, selection);
      assert.deepEqual(active, ['setupMode', 'providerQuick', 'autoAnnotate']);
    }
  }
});

test('custom selection applies every selected mode, provider and infrastructure combination', async () => {
  const cases = [
    {
      integrationMode: 'merge', securityMode: 'sandbox', mode: 'shadow',
      llmProviders: ['openai'], infra: 'standalone', startDocker: true,
      autoAnnotate: true,
    },
    {
      integrationMode: 'merge', securityMode: 'full', mode: 'enforce',
      llmProviders: ['anthropic'], infra: 'distributed', startDocker: false,
      autoAnnotate: false,
    },
    {
      integrationMode: 'standalone', securityMode: 'sandbox', mode: 'enforce',
      llmProviders: ['ollama'], infra: 'skip', startDocker: false,
      autoAnnotate: true, standaloneDir: 'D:/tmp/contexa-standalone',
    },
    {
      integrationMode: 'merge', securityMode: 'full', mode: 'shadow',
      llmProviders: ['openai', 'anthropic', 'ollama'], infra: 'distributed',
      startDocker: true, autoAnnotate: true,
    },
  ];
  for (const value of cases) {
    const selection = { setupMode: 'advanced', ...value };
    const { answers, questions } = await collect(selection);
    assert.equal(answers.setupMode, 'advanced');
    assert.equal(answers.integrationMode, value.integrationMode);
    assert.equal(answers.securityMode, value.securityMode);
    assert.equal(answers.mode, value.mode);
    assert.equal(answers.enableAiSecurity, true);
    assert.equal(answers.autoAnnotate, value.autoAnnotate);
    assert.deepEqual(answers.llmProviders, value.llmProviders);
    assert.equal(answers.infra, value.infra);
    assert.equal(answers.startDocker, value.startDocker);
    const active = activeQuestionNames(questions, selection);
    for (const required of ['setupMode', 'autoAnnotate', 'integrationMode',
      'securityMode', 'mode', 'llmProviders', 'infra']) {
      assert.ok(active.includes(required), 'missing custom question: ' + required);
    }
  }
});

test('--yes, --distributed, --no-docker and explicit provider remain deterministic', () => {
  const { defaults } = buildInitDefaults({
    yes: true,
    distributed: true,
    docker: false,
    provider: 'anthropic',
    autoAnnotate: true,
  });
  assert.equal(defaults.setupMode, 'quick');
  assert.equal(defaults.enableAiSecurity, true);
  assert.equal(defaults.autoAnnotate, true);
  assert.deepEqual(defaults.llmProviders, ['anthropic']);
  assert.equal(defaults.infra, 'distributed');
  assert.equal(defaults.startDocker, false);
});