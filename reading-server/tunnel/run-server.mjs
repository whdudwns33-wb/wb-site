#!/usr/bin/env node
/* 관리 서버 실행기 — 원장 PC 에서 작업 스케줄러가 부팅 때 이것을 띄운다.
     node reading-server/tunnel/run-server.mjs [--env <설정 파일>] [--check]

   하는 일:
   1. 저장소 밖 설정 파일(기본 C:\ProgramData\WB\server.env)을 읽어 검사한다 — 틀리면 띄우지 않는다.
   2. 관리 전용(WB_ADMIN_ONLY=1)·루프백(HOST=127.0.0.1)을 강제해 server.mjs 를 자식으로 띄운다.
      학생 기록의 정본은 운영 워커 KV 다. 이 서버가 학생 로그인을 내주면 진도가 두 곳에 갈라진다(결정 A).
   3. 화면이 없으니 출력을 <DATA_DIR>\logs\server-날짜.log 에 남기고 14일치만 둔다.
   4. 서버가 죽으면 간격을 늘려 가며 다시 띄운다(kit.mjs nextRestart).
   5. 띄우기 전마다 <DATA_DIR>\db.json 이 읽히는지 본다. store.mjs 는 db.json 을 못 읽으면 빈 DB 로 시작하고
      첫 저장 때 그 빈 DB 로 원본을 덮어쓴다 — 화면 없는 PC 에서 그대로 두면 학생 기록·팩이 조용히 사라진다.
      그래서 깨져 있으면 서버를 띄우지 않고 로그에 남긴다(원본은 손대지 않는다 — NAS 백업으로 되살린다).
      사본을 따로 만들지는 않는다: db.json 에는 라이선스 팩 본문이 들어 있고, store.mjs 도 같은 이유로
      백업 스냅샷에서 팩을 뺀다.
   6. 서버 로그를 쓰기 전에 실패하면(설정 오류·드라이브가 안 보임·Node 가 낡음) 설정 파일 옆
      run-server-error.log 에 이유를 남긴다 — 작업 스케줄러로 뜬 프로세스는 화면이 없어 그대로 두면 아무도 모른다.

   --check 는 1번만 하고 끝낸다(설정 파일을 고친 뒤 확인용). 비밀 값은 어디에도 찍지 않는다. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseEnvFile, validateServerEnv, buildChildEnv, nextRestart, logFileName, logsToPrune, MIN_NODE_MAJOR, nodeMajor,
} from './kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SERVER = path.join(HERE, '..', 'server.mjs');
const EXIT_WITH_PARENT = path.join(HERE, 'exit-with-parent.mjs');
export const ERROR_LOG = 'run-server-error.log';

export function defaultEnvFile(env = process.env, platform = process.platform) {
  if (env.WB_SERVER_ENV) return env.WB_SERVER_ENV;
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'WB', 'server.env');
  return '';
}

/* 상대 경로는 지금 폴더 기준으로 한 번만 풀어 둔다 — 작업 스케줄러는 다른 폴더에서 이 경로를 다시 읽는다 */
export const isWinAbs = (p) => /^[a-z]:[\\/]|^\\\\/i.test(String(p || ''));
export const resolveEnvArg = (raw) => (!raw ? '' : isWinAbs(raw) ? path.win32.normalize(raw) : path.resolve(raw));

/* db.json 이 없으면(처음) 괜찮다. 있는데 JSON 으로 안 읽히면 이유를 돌려준다. */
export function dbProblem(dataDir) {
  const file = path.join(dataDir, 'db.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e && e.code === 'ENOENT' ? null : `db.json 을 읽지 못했습니다(${e && e.code})`; }
  try { JSON.parse(text); return null; }
  catch { return `db.json 이 JSON 으로 읽히지 않습니다(${text.length}바이트) — 이대로 띄우면 빈 DB 가 원본을 덮어씁니다`; }
}

export function loadConfig(envFile, repoRoot = REPO) {
  if (!envFile) return { errors: ['설정 파일 경로가 없습니다 — --env <경로> 를 주세요(Windows 기본값: C:\\ProgramData\\WB\\server.env)'] };
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); }
  catch (e) {
    /* 설정 폴더는 관리자·SYSTEM 만 읽게 잠근다(setup.mjs env) — 일반 터미널에서 열면 "없다"가 아니라 "권한"이다 */
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return { errors: [`설정 파일을 읽을 권한이 없습니다: ${envFile} — 관리자 권한 터미널에서 실행하세요`] };
    return { errors: [`설정 파일이 없습니다: ${envFile} — node reading-server/tunnel/setup.mjs env 로 견본을 만드세요`] };
  }
  const parsed = parseEnvFile(text);
  const checked = validateServerEnv({ vars: parsed.vars, envFile, repoRoot, lineOf: parsed.lineOf });
  return { vars: parsed.vars, ...checked, errors: [...parsed.errors, ...checked.errors] };
}

/* 서버 로그가 생기기 전의 실패를 남길 자리 — 설정 파일 옆(관리자·SYSTEM 만 읽는 폴더). 비밀은 싣지 않는다. */
function fallbackLog(envFile, lines) {
  if (!envFile) return;
  try {
    fs.appendFileSync(path.join(path.dirname(envFile), ERROR_LOG),
      lines.map((l) => `[${new Date().toISOString()}] ${l}`).join('\n') + '\n');
  } catch { /* 여기마저 못 쓰면 남길 곳이 없다 */ }
}

function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

async function main() {
  const args = process.argv.slice(2);
  const envFile = resolveEnvArg(argValue(args, '--env') || defaultEnvFile());
  const fail = (code, lines) => {
    for (const l of lines) console.error(l);
    if (!args.includes('--check')) fallbackLog(envFile, lines);
    process.exit(code);
  };

  /* server.mjs 는 22 의 기능(전역 crypto.subtle, import … with { type: 'json' }, --import)을 쓴다 */
  if (nodeMajor(process.versions.node) < MIN_NODE_MAJOR) {
    fail(1, [`✗ Node ${process.versions.node} 로는 서버를 띄우지 않습니다 — ${MIN_NODE_MAJOR} 이상이 필요합니다(${process.execPath}). LTS 설치 파일로 올린 뒤 setup.mjs install-server 를 다시 하세요`]);
  }

  const cfg = loadConfig(envFile);
  for (const w of cfg.warnings || []) console.log('[참고] ' + w);
  if (cfg.errors.length) fail(1, ['설정 파일에 고칠 곳이 있어 서버를 띄우지 않습니다:', ...cfg.errors.map((e) => '  - ' + e)]);
  if (args.includes('--check')) {
    console.log(`설정 확인 ✓ — ${envFile} · 포트 ${cfg.port} · 자료 ${cfg.dataDir} · 로그 ${cfg.logDir}`);
    return;
  }

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.mkdirSync(cfg.logDir, { recursive: true });
  } catch (e) {
    const root = path.parse(path.resolve(cfg.dataDir)).root;
    const hint = root && !fs.existsSync(root)
      ? `드라이브 ${root} 가 서버 계정(SYSTEM)에게 보이지 않습니다 — 매핑된 네트워크 드라이브(NAS)·빠진 외장 디스크는 쓸 수 없습니다. 이 PC 디스크(예: C:\\WB_server_data)로`
      : `자료·로그 폴더를 만들지 못했습니다(${e && e.code})`;
    fail(2, [`✗ ${hint}`]);
  }
  const childEnv = buildChildEnv(process.env, cfg.vars, cfg.port);

  /* 날짜가 바뀌면 다음 줄부터 새 파일에 쓰고, 그때 오래된 로그를 지운다(오래 켜 둔 PC 에서도 14일만 남게).
     파일을 열어 둔 채로 두지 않는다(appendFileSync) — Windows 에서 열린 파일은 지우지 못한다. */
  let curLog = '';
  const prune = () => {
    try {
      for (const n of logsToPrune(fs.readdirSync(cfg.logDir), new Date())) fs.rmSync(path.join(cfg.logDir, n), { force: true });
    } catch { /* 정리 실패는 다음 기회에 */ }
  };
  const write = (chunk) => {
    const name = logFileName(new Date());
    if (name !== curLog) { curLog = name; prune(); }
    try { fs.appendFileSync(path.join(cfg.logDir, name), chunk); } catch { /* 로그 실패로 서버를 죽이지 않는다 */ }
  };
  const stamp = (msg) => write(`[${new Date().toISOString()}] [실행기] ${msg}\n`);
  setInterval(prune, 6 * 60 * 60 * 1000).unref();

  let child = null;
  let stopping = false;
  let history = [];
  const start = () => {
    const bad = dbProblem(cfg.dataDir);
    if (bad) {
      /* 원본을 지키는 쪽을 고른다 — 띄우지 않고 끝낸다. 작업 스케줄러가 5분마다 다시 불러도 같은 이유로 멈춘다. */
      stamp(`서버를 띄우지 않습니다: ${bad}. ${path.join(cfg.dataDir, 'db.json')} 을 NAS 백업으로 되살린 뒤 restart-server`);
      console.error(`✗ ${bad}`);
      process.exit(2);
    }
    const startedAt = Date.now();
    /* 'ipc' 통로 + exit-with-parent.mjs — 실행기가 어떻게 끝나든 서버가 고아로 남지 않게 */
    child = spawn(process.execPath, ['--import', pathToFileURL(EXIT_WITH_PARENT).href, SERVER],
      /* 작업 폴더는 자료 폴더 — 코드 사본을 작업 폴더로 잡고 있으면 restart-server 가 사본을 지우고 다시 복사할 때
         Windows 가 "사용 중" 으로 막는다. 서버 코드는 자기 위치에서 경로를 풀므로 동작은 같다. */
      { env: childEnv, cwd: cfg.dataDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    stamp(`서버 시작 — 포트 ${cfg.port}, 관리 전용, 127.0.0.1, pid ${child.pid}, node ${process.versions.node}, 코드 ${REPO}`);
    child.stdout.on('data', (b) => { write(b); if (process.stdout.isTTY) process.stdout.write(b); });
    child.stderr.on('data', (b) => { write(b); if (process.stderr.isTTY) process.stderr.write(b); });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      const r = nextRestart(history, Date.now(), startedAt);
      history = r.history;
      stamp(`서버가 멈췄습니다(코드 ${code}${signal ? ', 신호 ' + signal : ''}) — ${Math.round(r.delayMs / 1000)}초 뒤 다시 띄웁니다`);
      setTimeout(start, r.delayMs);
    });
  };
  const stop = () => {
    stopping = true;
    stamp('실행기 종료 요청 — 서버를 멈춥니다');
    if (child) child.kill();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
  start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    /* 예상하지 못한 실패도 화면 없는 자리에서 사라지지 않게 */
    const envFile = resolveEnvArg(argValue(process.argv.slice(2), '--env') || defaultEnvFile());
    fallbackLog(envFile, [`✗ 실행기 오류: ${e && (e.code || e.name) || 'unknown'}`]);
    console.error(e);
    process.exit(1);
  });
}
