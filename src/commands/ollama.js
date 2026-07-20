'use strict';

const chalk = require('chalk');
const ora = require('ora');
const { t, formatError } = require('../core/i18n');
const {
  detectOllamaSource,
  pullOllamaModelWithProgress,
  waitForDockerOllama,
  waitForNativeOllama,
} = require('../core/ollama');
const {
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  isValidOllamaModel,
} = require('../core/provider');
const { TIMEOUTS } = require('../core/timeouts');

function commandFailure(code, key, ...args) {
  const error = new Error(code);
  error.code = code;
  error.messageKey = key;
  error.messageArgs = args;
  return error;
}

async function pullModel(source, model, spinner, label) {
  try {
    await pullOllamaModelWithProgress(source.port, model, spinner, label);
  } catch (error) {
    spinner.fail(t('ollama.pull.failed', model));
    console.log(chalk.gray(`    ${t('common.error')}: ${formatError(error, 'OLLAMA_RUNTIME_FAILED')}`));
    throw commandFailure('OLLAMA_PULL_FAILED', 'ollama.pull.failed', model);
  }
}

module.exports = function registerOllamaCommands(program) {
  const ollama = program.command('ollama').description(t('ollama.command.description'));

  ollama.command('pull')
    .description(t('ollama.pull.description'))
    .option('--chat-model <model>', t('ollama.option.chatModel', DEFAULT_OLLAMA_CHAT_MODEL))
    .option('--embed-model <model>', t('ollama.option.embedModel', DEFAULT_OLLAMA_EMBEDDING_MODEL))
    .option('--container <name>', t('ollama.option.container'))
    .option('--yes', t('ollama.option.yes'))
    .action(async opts => {
      console.log('');
      const chatModel = process.env.OLLAMA_CHAT_MODEL || opts.chatModel || DEFAULT_OLLAMA_CHAT_MODEL;
      const embedModel = process.env.OLLAMA_EMBEDDING_MODEL
        || opts.embedModel || DEFAULT_OLLAMA_EMBEDDING_MODEL;

      if (!isValidOllamaModel(chatModel)) {
        throw commandFailure('INVALID_OLLAMA_MODEL', t('ollama.model.invalid.chat', chatModel));
      }
      if (!isValidOllamaModel(embedModel)) {
        throw commandFailure('INVALID_OLLAMA_MODEL', t('ollama.model.invalid.embedding', embedModel));
      }

      const detecting = ora(t('ollama.detecting')).start();
      const source = await detectOllamaSource(opts.container);
      if (!source.type) {
        detecting.fail(t('ollama.notFound'));
        console.log(chalk.yellow(`  ! ${t('ollama.prepare.title')}`));
        console.log(chalk.cyan(`  ${t('ollama.prepare.docker')}`));
        console.log(chalk.gray('    contexa init --simulate'));
        console.log(chalk.gray('    contexa init --distributed'));
        console.log(chalk.cyan(`  ${t('ollama.prepare.native')}`));
        console.log(chalk.gray('    https://ollama.com/download'));
        throw commandFailure('OLLAMA_NOT_FOUND', t('ollama.notFound'));
      }

      detecting.succeed(source.type === 'docker'
        ? t('ollama.detected.docker', source.container, source.port)
        : t('ollama.detected.native', source.port));

      console.log(chalk.cyan(`  ${t('ollama.models.title')}`));
      console.log(chalk.gray(`    - ${t('ollama.models.chat', chatModel)}`));
      console.log(chalk.gray(`    - ${t('ollama.models.embedding', embedModel)}`));
      console.log(chalk.yellow(`    ${t('ollama.models.duration')}`));
      console.log('');

      const waiting = ora(t('ollama.waiting')).start();
      const deadline = Date.now() + TIMEOUTS.ollamaReadyMs;
      const ready = source.type === 'docker'
        ? await waitForDockerOllama(source.container, deadline)
        : await waitForNativeOllama(source.port, deadline);
      if (!ready) {
        waiting.fail(t('ollama.wait.timeout'));
        throw commandFailure('OLLAMA_READY_TIMEOUT', t('ollama.wait.timeout'));
      }
      waiting.succeed(t('ollama.ready'));

      const chatSpinner = ora(t('ollama.pull.progress.chat', chatModel)).start();
      await pullModel(source, chatModel, chatSpinner, t('ollama.pull.label.chat', chatModel));
      chatSpinner.succeed(t('ollama.pull.complete.chat', chatModel));

      const embeddingSpinner = ora(t('ollama.pull.progress.embedding', embedModel)).start();
      await pullModel(source, embedModel, embeddingSpinner, t('ollama.pull.label.embedding', embedModel));
      embeddingSpinner.succeed(t('ollama.pull.complete.embedding', embedModel));

      console.log('');
      console.log(chalk.green(`  v ${t('ollama.complete')}`));
      console.log(chalk.gray(source.type === 'docker'
        ? `    ${t('ollama.source.docker', source.container, source.port)}`
        : `    ${t('ollama.source.native', source.port)}`));
      console.log(chalk.gray(`    ${t('ollama.complete.next')}`));
      console.log('');
    });
};
