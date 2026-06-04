'use strict';

const chalk = require('chalk');
const { execSync } = require('child_process');
const net = require('net');
const http = require('http');
const { t } = require('../core/i18n');
const { isDockerCliInstalled, isDockerDaemonRunning } = require('../core/docker');

function isPortBound(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    tester.once('error', () => finish(true));
    tester.once('listening', () => tester.close(() => finish(false)));
    tester.listen(port, '127.0.0.1');
    setTimeout(() => { try { tester.close(); } catch {} finish(false); }, 1000);
  });
}

function checkOllamaModels(port) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/tags',
      method: 'GET',
      timeout: 2000
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
    .description('Diagnose local environment for Contexa deployment')
    .action(async () => {
      console.log(chalk.cyan('\n  ============================================='));
      console.log(chalk.cyan(`  ${t('doctor.title') || 'Contexa Doctor - Environment Report'}`));
      console.log(chalk.cyan('  =============================================\n'));

      let overallPass = true;

      // 1. Java 17 Check
      try {
        const javaVerOutput = execSync('java -version 2>&1').toString();
        const match = javaVerOutput.match(/version "(.*?)"/);
        const version = match ? match[1] : 'unknown';
        const isJava17 = version.startsWith('17') || parseInt(version.split('.')[0], 10) >= 17;

        if (isJava17) {
          console.log(`  [${chalk.green('OK')}] Java version: ${version}`);
        } else {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] Java version: ${version} (Java 17+ required)`);
          console.log(`    ${chalk.yellow('[FIX]')} Install OpenJDK 17 or higher. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
        }
      } catch {
        overallPass = false;
        console.log(`  [${chalk.red('FAIL')}] Java is not installed or not in PATH.`);
        console.log(`    ${chalk.yellow('[FIX]')} Install JDK 17 and configure your JAVA_HOME environment variable. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
      }

      // 2. Docker CLI and Daemon
      if (!isDockerCliInstalled()) {
        overallPass = false;
        console.log(`  [${chalk.red('FAIL')}] Docker CLI is not installed.`);
        console.log(`    ${chalk.yellow('[FIX]')} Please install Docker Desktop: https://www.docker.com/products/docker-desktop \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
      } else if (!isDockerDaemonRunning()) {
        overallPass = false;
        console.log(`  [${chalk.red('FAIL')}] Docker is installed but daemon is not running.`);
        console.log(`    ${chalk.yellow('[FIX]')} Open Docker Desktop or run 'sudo systemctl start docker'. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
      } else {
        console.log(`  [${chalk.green('OK')}] Docker Daemon is running.`);
      }

      // 3. PostgreSQL Port Collision (Default 5432 and simulation 25432)
      const isPostgresPortBound = await isPortBound(5432);
      const isSimPostgresPortBound = await isPortBound(25432);
      if (isPostgresPortBound || isSimPostgresPortBound) {
        console.log(`  [${chalk.yellow('WARN')}] PostgreSQL port conflict detected (Port 5432 or 25432 is in use).`);
        console.log(`    ${chalk.gray('Note:')} Contexa will skip starting PostgreSQL container and attempt to reuse host service.`);
      } else {
        console.log(`  [${chalk.green('OK')}] PostgreSQL ports are free.`);
      }

      // 4. Ollama and LLM Models (11434 and simulation 31434)
      const ollamaPort = process.env.CONTEXA_OLLAMA_PORT ? parseInt(process.env.CONTEXA_OLLAMA_PORT, 10) : 11434;
      const ollamaSimPort = 31434;
      
      let ollamaStatus = await checkOllamaModels(ollamaPort);
      if (!ollamaStatus.reachable) {
        ollamaStatus = await checkOllamaModels(ollamaSimPort);
      }

      if (ollamaStatus.reachable) {
        console.log(`  [${chalk.green('OK')}] Ollama is running.`);
        const requiredChatModel = process.env.OLLAMA_CHAT_MODEL || 'qwen2.5:7b';
        const hasChatModel = ollamaStatus.models.some(m => m.startsWith(requiredChatModel.split(':')[0]));
        
        if (hasChatModel) {
          console.log(`  [${chalk.green('OK')}] Ollama Model: ${requiredChatModel} is pulled.`);
        } else {
          overallPass = false;
          console.log(`  [${chalk.red('FAIL')}] Ollama Model '${requiredChatModel}' is missing.`);
          console.log(`    ${chalk.yellow('[FIX]')} Run: docker exec -it contexa-ollama ollama pull ${requiredChatModel} \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
        }
      } else {
        overallPass = false;
        console.log(`  [${chalk.red('FAIL')}] Ollama is not running on port ${ollamaPort} or ${ollamaSimPort}.`);
        console.log(`    ${chalk.yellow('[FIX]')} Start Ollama locally or run 'docker compose up -d ollama' via contexa infra. \u001b]8;;https://docs.ctxa.ai/docs/install/troubleshooting.html#error-catalog\u0007${chalk.cyan('[Troubleshooting Guide]')}\u001b]8;;\u0007`);
      }

      console.log('');
      if (overallPass) {
        console.log(chalk.green(`  v ${t('doctor.success') || 'All checks passed! Your local environment is ready for Contexa.'}\n`));
      } else {
        console.log(chalk.red(`  x ${t('doctor.fail') || 'Some diagnostic checks failed. Review [FIX] instructions above.'}\n`));
      }
    });
};
