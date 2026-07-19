'use strict';

const chalk = require('chalk');
const { spawnSync } = require('child_process');
const http = require('http');
const { t } = require('../core/i18n');
const { isDockerCliInstalled, isDockerDaemonRunning } = require('../core/docker');
const { isPortBound } = require('../core/preflight');
const { DEFAULT_OLLAMA_CHAT_MODEL, normalizeProviders } = require('../core/provider');
const {
  DEFAULT_INFRASTRUCTURE_PORTS,
  SIMULATION_PORTS,
  configuredPort,
} = require('../core/infrastructure');
const { TIMEOUTS } = require('../core/timeouts');

function checkOllamaModels(port) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/tags',
      method: 'GET',
      timeout: TIMEOUTS.httpHealthProbeMs
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = (json.models || []).map(m => m.name);
          resolve({ reachable: true, models });
        } catch {
          resolve({ reachable: true, models: [] });
        }
      });
    });

    req.on('error', () => resolve({ reachable: false, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, models: [] }); });
    req.end();
  });
}

module.exports = function (program) {
  program
    .command('doctor')
    .description(t('doctor.description'))
    .option('--provider <name>', t('doctor.option.provider'))
    .option('--include-ollama', t('doctor.option.ollama'))
    .option('--infra', t('doctor.option.infra'))
    .option('--simulate', t('doctor.option.simulate'))
    .action(async (opts) => {
      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('doctor.title')}`));
      console.log(chalk.cyan('  =============================================\n'));

      let overallPass = true;
      const providersToCheck = normalizeProviders(opts.provider, {
        includeOllama: opts.includeOllama,
        simulate: opts.simulate,
      });
      const needsDocker = !!(opts.infra || opts.simulate);
      const needsOllama = providersToCheck.includes('ollama');

      // 1. Java 17 Check
      try {
        const javaResult = spawnSync('java', ['-version'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: TIMEOUTS.javaCommandProbeMs,
        });
        if (javaResult.error || javaResult.status !== 0) {
          throw javaResult.error || new Error('java -version failed');
        }
        const javaVerOutput = `${javaResult.stdout || ''}\n${javaResult.stderr || ''}`;
        const match = javaVerOutput.match(/version "(.*?)"/);
        const version = match ? match[1] : 'unknown';
        const isJava17 = version.startsWith('17') || parseInt(version.split('.')[0], 10) >= 17;

        if (isJava17) {
          console.log(`  [${chalk.green('OK')}] ${t('doctor.java.ok', version)}`);
        } else {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] ${t('doctor.java.unsupported', version)}`);
          console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.java.fix')}`);
        }
      } catch {
        overallPass = false;
        console.log(`  [${chalk.red('FAIL')}] ${t('doctor.java.missing')}`);
        console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.java.fix')}`);
      }

      // 2. Docker CLI and Daemon (only when infrastructure checks are requested)
      if (needsDocker) {
        if (!isDockerCliInstalled()) {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] ${t('doctor.docker.missing')}`);
          console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.docker.install')}`);
        } else if (!isDockerDaemonRunning()) {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] ${t('doctor.docker.stopped')}`);
          console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.docker.start')}`);
        } else {
          console.log(`  [${chalk.green('OK')}] ${t('doctor.docker.ok')}`);
        }
      } else {
        console.log(`  [${chalk.gray('SKIP')}] ${t('doctor.docker.skip')}`);
      }

      // 3. PostgreSQL Port Collision (Default 5432 and simulation 25432)
      if (needsDocker) {
        const isPostgresPortBound = await isPortBound(DEFAULT_INFRASTRUCTURE_PORTS.postgres);
        const isSimPostgresPortBound = await isPortBound(SIMULATION_PORTS.postgres);
        if (isPostgresPortBound || isSimPostgresPortBound) {
          console.log(`  [${chalk.yellow('WARN')}] ${t('doctor.postgres.busy', DEFAULT_INFRASTRUCTURE_PORTS.postgres, SIMULATION_PORTS.postgres)}`);
          console.log(`    ${chalk.gray(t('doctor.note'))} ${t('doctor.postgres.noReuse')}`);
        } else {
          console.log(`  [${chalk.green('OK')}] ${t('doctor.postgres.free')}`);
        }
      } else {
        console.log(`  [${chalk.gray('SKIP')}] ${t('doctor.postgres.skip')}`);
      }

      // 4. Ollama and LLM Models (11434 and simulation 31434)
      if (needsOllama) {
        const ollamaPort = configuredPort('CONTEXA_OLLAMA_PORT', DEFAULT_INFRASTRUCTURE_PORTS.ollama);
        const ollamaSimPort = SIMULATION_PORTS.ollama;

        let ollamaStatus = await checkOllamaModels(ollamaPort);
        if (!ollamaStatus.reachable) {
          ollamaStatus = await checkOllamaModels(ollamaSimPort);
        }

        if (ollamaStatus.reachable) {
          console.log(`  [${chalk.green('OK')}] ${t('doctor.ollama.ok')}`);
          const requiredChatModel = process.env.OLLAMA_CHAT_MODEL || DEFAULT_OLLAMA_CHAT_MODEL;
          const hasChatModel = ollamaStatus.models.some(m => m.startsWith(requiredChatModel.split(':')[0]));

          if (hasChatModel) {
            console.log(`  [${chalk.green('OK')}] ${t('doctor.ollama.model.ok', requiredChatModel)}`);
          } else {
            overallPass = false;
            console.log(`  [${chalk.red('FAIL')}] ${t('doctor.ollama.model.missing', requiredChatModel)}`);
            console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.ollama.model.fix', requiredChatModel)}`);
          }
        } else {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] ${t('doctor.ollama.missing', ollamaPort, ollamaSimPort)}`);
          console.log(`    ${chalk.yellow('[FIX]')} ${t('doctor.ollama.fix')}`);
        }
      } else {
        console.log(`  [${chalk.gray('SKIP')}] ${t('doctor.ollama.skip')}`);
      }

      console.log('');
      if (overallPass) {
        console.log(chalk.green(`  v ${t('doctor.success')}\n`));
      } else {
        console.log(chalk.red(`  x ${t('doctor.fail')}\n`));
        const error = new Error(`DOCTOR_CHECK_FAILED ${t('doctor.fail')}`);
        error.code = 'DOCTOR_CHECK_FAILED';
        throw error;
      }
    });
};
