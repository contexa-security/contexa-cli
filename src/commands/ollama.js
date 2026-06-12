'use strict';

const chalk  = require('chalk');
const ora    = require('ora');
const http   = require('http');
const { execSync } = require('child_process');
const { dockerTry } = require('../core/docker');
const { containerName, resolveProjectName } = require('../core/project');

// ─── Validation ───────────────────────────────────────────────────────────────
const VALID_MODEL_RE = /^[a-zA-Z0-9._\-:/]+$/;
function isValidOllamaModel(name) {
  return typeof name === 'string' && VALID_MODEL_RE.test(name) && name.length <= 200;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP pull with progress (works for both Docker and native Ollama) ────────
function pullOllamaModelWithProgress(port, modelName, spinnerInstance, label) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ name: modelName });
    const options = {
      hostname: '127.0.0.1', port,
      path: '/api/pull', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = http.request(options, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`Ollama API returned ${res.statusCode}`)); return; }
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.error) { reject(new Error(json.error)); return; }
            if (json.total && json.completed) {
              spinnerInstance.text = `${label} [${Math.floor((json.completed / json.total) * 100)}%]`;
            } else if (json.status) {
              spinnerInstance.text = `${label} (${json.status})`;
            }
          } catch { /* partial chunk */ }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Ollama source detection ───────────────────────────────────────────────────
//
// 우선순위:
//   1. Docker 컨테이너 (ctxa-sim-ollama, contexa-ollama, ...)
//   2. 로컬 네이티브 Ollama (localhost:11434 HTTP 응답)
//
// 반환값: { type: 'docker'|'native'|null, container?, port }

function detectOllamaSource(overrideContainer) {
  // 1. 명시적 컨테이너 지정
  if (overrideContainer) {
    const r = dockerTry(['inspect', '--format', '{{.State.Running}}', overrideContainer], { stdio: 'pipe' });
    if (!r.error && r.status === 0 && (r.stdout || '').toString().trim() === 'true') {
      return { type: 'docker', container: overrideContainer, port: detectDockerPort(overrideContainer) };
    }
    return { type: null };
  }

  // 2. Docker 컨테이너 자동 탐지
  const cur = resolveProjectName();
  const candidates = [`${cur}-ollama`];
  if (cur !== 'contexa')  candidates.push('contexa-ollama');
  if (cur !== 'ctxa-sim') candidates.push('ctxa-sim-ollama');

  for (const name of candidates) {
    const r = dockerTry(['inspect', '--format', '{{.State.Running}}', name], { stdio: 'pipe' });
    if (!r.error && r.status === 0 && (r.stdout || '').toString().trim() === 'true') {
      return { type: 'docker', container: name, port: detectDockerPort(name) };
    }
  }

  // 3. 로컬 네이티브 Ollama
  if (isNativeOllamaRunning(11434)) {
    return { type: 'native', port: 11434 };
  }

  return { type: null };
}

function detectDockerPort(cname) {
  const r = dockerTry(
    ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "11434/tcp") 0).HostPort}}', cname],
    { stdio: 'pipe' }
  );
  if (!r.error && r.status === 0) {
    const port = parseInt((r.stdout || '').toString().trim(), 10);
    if (port > 0) return port;
  }
  return cname.startsWith('ctxa-sim') ? 31434 : 11434;
}

function isNativeOllamaRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/tags', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Docker Ollama 준비 대기 (exec 기반)
async function waitForDockerOllama(container, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const probe = dockerTry(
      ['exec', container, 'ollama', 'list'],
      { stdio: 'ignore', timeout: 3000 }
    );
    if (!probe.error && probe.status === 0) return true;
    await sleep(2000);
  }
  return false;
}

// 네이티브 Ollama 준비 대기 (HTTP 기반)
async function waitForNativeOllama(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    if (await isNativeOllamaRunning(port)) return true;
    await sleep(2000);
  }
  return false;
}

// ─── Command definition ────────────────────────────────────────────────────────
module.exports = function (program) {
  const ollamaCmd = program
    .command('ollama')
    .description('Ollama LLM 관련 작업을 수행합니다');

  ollamaCmd
    .command('pull')
    .description('Ollama LLM 모델을 다운로드합니다 (채팅 모델 + 임베딩 모델)')
    .option('--chat-model <model>',  '채팅 모델 이름 (기본: qwen2.5:7b)')
    .option('--embed-model <model>', '임베딩 모델 이름 (기본: mxbai-embed-large)')
    .option('--container <name>',    'Ollama 컨테이너 이름 직접 지정 (Docker 전용)')
    .option('--yes',                 '확인 프롬프트 건너뜀 (CI/자동화)')
    .action(async (opts) => {
      console.log('');

      // 1. 모델 이름 결정
      const chatModel  = process.env.OLLAMA_CHAT_MODEL      || opts.chatModel  || 'qwen2.5:7b';
      const embedModel = process.env.OLLAMA_EMBEDDING_MODEL || opts.embedModel || 'mxbai-embed-large';

      if (!isValidOllamaModel(chatModel))  { console.log(chalk.red(`  x 올바르지 않은 채팅 모델 이름: ${chatModel}`));    process.exit(1); }
      if (!isValidOllamaModel(embedModel)) { console.log(chalk.red(`  x 올바르지 않은 임베딩 모델 이름: ${embedModel}`)); process.exit(1); }

      // 2. Ollama 소스 감지 (Docker 우선 → 네이티브)
      const sDetect = ora('Ollama 인스턴스를 탐색하는 중...').start();
      const source  = await detectOllamaSource(opts.container);

      if (!source.type) {
        sDetect.fail('실행 중인 Ollama 인스턴스를 찾을 수 없습니다.');
        console.log('');
        console.log(chalk.yellow('  ! 아래 방법 중 하나로 Ollama를 준비하세요:'));
        console.log('');
        console.log(chalk.cyan('  [방법 A] Contexa 인프라 스택 사용 (Docker)'));
        console.log(chalk.gray('    contexa init --simulate          # 격리 시뮬레이션 스택'));
        console.log(chalk.gray('    contexa init --distributed        # 운영 분산 스택'));
        console.log('');
        console.log(chalk.cyan('  [방법 B] Ollama 직접 설치 (네이티브)'));
        console.log(chalk.gray('    https://ollama.com/download'));
        console.log(chalk.gray('    설치 후: ollama serve  (또는 Ollama 앱 실행)'));
        console.log(chalk.gray('    준비되면 다시 실행: contexa ollama pull'));
        console.log('');
        process.exit(1);
      }

      if (source.type === 'docker') {
        sDetect.succeed(`Docker Ollama 감지: ${chalk.cyan(source.container)}  (포트 ${source.port})`);
      } else {
        sDetect.succeed(`로컬 네이티브 Ollama 감지: ${chalk.cyan(`localhost:${source.port}`)}`);
      }

      // 3. 모델 정보 출력 후 바로 시작
      // 명령어 실행 자체가 다운로드 의사 표현 - 추가 확인 불필요
      console.log(chalk.cyan('  다운로드할 모델:'));
      console.log(chalk.gray(`    · ${chatModel}  (채팅 모델, 약 4.7 GB)`));
      console.log(chalk.gray(`    · ${embedModel}  (임베딩 모델, 약 670 MB)`));
      console.log(chalk.yellow('    소요 시간: 네트워크 속도에 따라 수 분 ~ 수십 분'));
      console.log('');

      const sWait = ora('Ollama 준비 확인 중...').start();
      const deadline = Date.now() + 90_000;

      let ready = false;
      if (source.type === 'docker') {
        ready = await waitForDockerOllama(source.container, deadline);
      } else {
        ready = await waitForNativeOllama(source.port, deadline);
      }

      if (!ready) {
        sWait.fail('Ollama가 응답하지 않습니다 (90초 초과).');
        if (source.type === 'docker') {
          console.log(chalk.gray(`    docker logs ${source.container}  로 컨테이너 상태를 확인하세요.`));
        } else {
          console.log(chalk.gray('    ollama serve  명령어로 Ollama를 실행하세요.'));
        }
        process.exit(1);
      }
      sWait.succeed('Ollama 준비 완료');

      // 6. 채팅 모델 다운로드
      const sChat = ora(`채팅 모델 다운로드 중: ${chatModel}...`).start();
      try {
        await pullOllamaModelWithProgress(source.port, chatModel, sChat, `채팅 모델: ${chatModel}`);
        sChat.succeed(`채팅 모델 완료: ${chalk.cyan(chatModel)}`);
      } catch (e) {
        sChat.fail(`채팅 모델 다운로드 실패: ${chatModel}`);
        console.log(chalk.gray(`    오류: ${e.message}`));
        process.exit(1);
      }

      // 7. 임베딩 모델 다운로드
      const sEmbed = ora(`임베딩 모델 다운로드 중: ${embedModel}...`).start();
      try {
        await pullOllamaModelWithProgress(source.port, embedModel, sEmbed, `임베딩 모델: ${embedModel}`);
        sEmbed.succeed(`임베딩 모델 완료: ${chalk.cyan(embedModel)}`);
      } catch (e) {
        sEmbed.fail(`임베딩 모델 다운로드 실패: ${embedModel}`);
        console.log(chalk.gray(`    오류: ${e.message}`));
        process.exit(1);
      }

      // 8. 완료
      console.log('');
      console.log(chalk.green('  ✔ 모든 Ollama 모델 다운로드 완료'));
      if (source.type === 'docker') {
        console.log(chalk.gray(`    컨테이너: ${source.container} / 포트: ${source.port}`));
      } else {
        console.log(chalk.gray(`    네이티브 Ollama / 포트: ${source.port}`));
      }
      console.log(chalk.gray('    애플리케이션을 시작하면 AI 보안이 활성화됩니다.'));
      console.log('');
    });
};
