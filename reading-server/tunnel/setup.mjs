#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.mjs <명령> [옵션]
   결정·이유: docs/로컬-서버-외부공개-터널.md   ·   순서대로 따라 하는 안내: reading-server/tunnel/README.md

   명령 (★ = 관리자 권한 터미널에서)
     env                설정 파일 견본을 만든다(이미 있으면 건드리지 않는다)   ★
     install-server     작업 스케줄러에 관리 서버를 등록하고 띄운다             ★
     restart-server     서버를 다시 띄운다(git pull 로 코드를 받은 뒤)           ★
     uninstall-server   작업 스케줄러에서 지운다(자료·설정 파일은 그대로)        ★
     tunnel             cloudflared 를 Windows 서비스로 설치 — --token-file <파일> ★
     doctor             전부 점검한다(로컬 서버·관리 전용·LAN 차단·서비스·바깥 주소·Access)

   공통 옵션: --env <설정 파일>(기본 C:\ProgramData\WB\server.env) · --dry-run(실행하지 않고 할 일만 보여 준다)
   doctor 옵션: --host <바깥 주소>(설정 파일의 PUBLIC_HOST 대신)

   비밀(관리 비밀번호·터널 토큰)은 화면·로그에 찍지 않는다. 할 일은 plan* 함수가 목록으로 만들고(테스트가 본다)
   실행은 execute 하나가 한다 — Windows 에서만 도는 부분을 얇게 두려는 것이다. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_NAME, LOOPBACK, envTemplate, taskXml, utf16leWithBom, classifyProbe, isHostname,
  cloudflaredOk, MIN_CLOUDFLARED, METRICS_PORTS,
} from './kit.mjs';
import { defaultEnvFile, loadConfig } from './run-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUN_SCRIPT = path.join(HERE, 'run-server.mjs');

/* SID 로 적는다 — 한국어 Windows 에서 그룹 이름은 "Administrators" 가 아니라 번역된 이름일 수 있다.
   S-1-5-32-544 = Administrators, S-1-5-18 = SYSTEM. 이 둘만 남기고 상속을 끊는다(일반 사용자는 못 읽는다). */
const ACL_ADMINS_SYSTEM = ['/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F'];

/* cloudflared 를 찾을 자리 — PATH 가 먼저, 다음은 설치 프로그램(MSI·winget)의 기본 위치와 예전 문서(§4)의 위치 */
export const CLOUDFLARED_CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'C:\\Cloudflared\\bin\\cloudflared.exe',
];

/* ── 할 일 목록 만들기 (부작용 없음) ─────────────────────────────────── */

export function planEnv({ envFile, platform = process.platform, exists = false }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(envFile);
  if (exists) return [{ note: `설정 파일이 이미 있습니다 — 건드리지 않습니다: ${envFile}` }];
  const steps = [
    { mkdir: dir, why: '설정 폴더 만들기' },
    { write: envFile, data: envTemplate({ dataDir: platform === 'win32' ? 'C:\\WB_server_data' : '' }), why: '설정 파일 견본(값은 비어 있음)' },
  ];
  if (platform === 'win32') steps.push({ run: ['icacls', dir, ...ACL_ADMINS_SYSTEM], why: '설정 폴더를 관리자·SYSTEM 만 읽게(비밀번호가 들어간다)' });
  steps.push({ note: `이제 관리자 터미널에서 메모장으로 채우세요: notepad "${envFile}"` });
  return steps;
}

export function planInstallServer({ envFile, dataDir, nodeExe = process.execPath, tmpDir = os.tmpdir(), repo = REPO, runScript = RUN_SCRIPT, platform = process.platform }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const xmlFile = p.join(tmpDir, 'wb-admin-server-task.xml');
  const xml = taskXml({ nodeExe, runScript, envFile, workDir: repo });
  return [
    { mkdir: dataDir, why: '자료 폴더' },
    { run: ['icacls', dataDir, ...ACL_ADMINS_SYSTEM], why: '자료 폴더(학생 기록·팩)를 관리자·SYSTEM 만 읽게' },
    { write: xmlFile, data: utf16leWithBom(xml), why: '작업 정의(UTF-16)' },
    { run: ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/F'], why: `작업 스케줄러에 ${TASK_NAME} 등록(부팅 + 5분마다 살아 있는지)` },
    { remove: xmlFile, why: '작업 정의 임시 파일 지우기' },
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '지금 바로 띄우기' },
  ];
}

export function planRestartServer() {
  return [
    { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '멈추기(서버도 같이 끝난다)', okCodes: [0, 1] },
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '다시 띄우기' },
  ];
}

export function planUninstallServer() {
  return [
    { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '멈추기', okCodes: [0, 1] },
    { run: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'], why: '작업 지우기(자료·설정 파일은 그대로)' },
  ];
}

/* 터널 토큰은 Cloudflare 대시보드가 보여 주는 설치 명령의 끝부분이다. 비밀이라 파일로 받아 화면에 찍지 않는다. */
export function planTunnel({ cloudflared, token }) {
  return [
    { run: [cloudflared, 'service', 'install', token], secret: token, why: 'cloudflared 를 Windows 서비스로 설치(부팅 때 자동 시작 · 토큰은 C:\\ProgramData\\cloudflared\\token 에 관리자·SYSTEM 만)' },
    { note: '토큰 파일은 이제 지우세요 — 서비스가 토큰을 따로 보관합니다. "already installed" 가 나오면 먼저 cloudflared service uninstall' },
  ];
}

export function readToken(text) {
  const t = String(text || '').trim();
  /* 대시보드의 설치 명령을 통째로 붙여 넣은 경우도 받는다: "cloudflared.exe service install eyJ..." */
  const m = t.match(/(?:service\s+install\s+)?([A-Za-z0-9_\-=+/.]{80,})\s*$/);
  if (!m || /\s/.test(m[1])) throw new Error('토큰 파일에서 터널 토큰을 찾지 못했습니다 — 대시보드의 설치 명령(service install 뒤의 긴 값)을 그대로 붙여 넣으세요');
  return m[1];
}

/* ── 실행 ─────────────────────────────────────────────────────────── */

const show = (step) => {
  if (step.run) return '> ' + step.run.map((a) => (step.secret && a === step.secret ? '<토큰 숨김>' : /\s/.test(a) ? `"${a}"` : a)).join(' ');
  if (step.mkdir) return `> 폴더 만들기 ${step.mkdir}`;
  if (step.write) return `> 파일 쓰기 ${step.write}`;
  if (step.remove) return `> 파일 지우기 ${step.remove}`;
  return '';
};

export function execute(steps, { dryRun = false, runner = defaultRunner, out = console.log } = {}) {
  for (const step of steps) {
    if (step.note) { out('  · ' + step.note); continue; }
    out(`${dryRun ? '[할 일] ' : ''}${step.why ? step.why + '\n  ' : ''}${show(step)}`);
    if (dryRun) continue;
    if (step.mkdir) { fs.mkdirSync(step.mkdir, { recursive: true }); continue; }
    if (step.write) { fs.writeFileSync(step.write, step.data); continue; }
    if (step.remove) { fs.rmSync(step.remove, { force: true }); continue; }
    if (step.run) {
      const code = runner(step.run);
      if (!(step.okCodes || [0]).includes(code)) throw new Error(`실패(종료 코드 ${code}): ${step.why || step.run[0]}`);
    }
  }
}

function defaultRunner(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', windowsHide: true });
  if (r.error) throw new Error(`${argv[0]} 을(를) 실행하지 못했습니다: ${r.error.code || r.error.message}`);
  return r.status;
}
const quiet = (argv) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true });

/* 관리자 권한인지 — "net session" 은 관리자 권한에서만 성공한다(출력은 언어마다 달라 종료 코드만 본다) */
export function isElevated(run = quiet) {
  const r = run(['net', 'session']);
  return !r.error && r.status === 0;
}

export function findCloudflared({ run = quiet, exists = fs.existsSync } = {}) {
  const w = run(['where', 'cloudflared']);
  if (!w.error && w.status === 0) {
    const first = String(w.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  return CLOUDFLARED_CANDIDATES.find((c) => exists(c)) || '';
}

/* ── 점검 ─────────────────────────────────────────────────────────── */

const canConnect = (host, port, ms = 1500) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});
const lanAddresses = (ifaces = os.networkInterfaces()) => Object.values(ifaces).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

export async function doctor({ envFile, host } = {}, deps = {}) {
  const {
    platform = process.platform, fetchFn = fetch, run = quiet, connect = canConnect, interfaces = os.networkInterfaces(),
    nodeVersion = process.versions.node, load = loadConfig,
  } = deps;
  const results = [];
  const add = (level, name, msg) => results.push({ level, name, msg });

  const major = Number(String(nodeVersion).split('.')[0]);
  if (major >= 22) add('ok', 'Node.js', `v${nodeVersion}`);
  else add('fail', 'Node.js', `v${nodeVersion} — 22 이상이 필요합니다(winget install OpenJS.NodeJS.LTS)`);

  const cfg = load(envFile);
  if (cfg.errors.length) {
    add('fail', '설정 파일', cfg.errors.join(' / '));
  } else {
    add('ok', '설정 파일', `${envFile} · 포트 ${cfg.port} · 자료 ${cfg.dataDir}`);
    for (const w of cfg.warnings || []) add('warn', '설정 파일', w);
  }

  const port = cfg.port || 8890;
  const base = `http://${LOOPBACK}:${port}`;
  let serverUp = false;
  try {
    const h = await fetchFn(base + '/api/health', { signal: AbortSignal.timeout(3000) });
    serverUp = h.status === 200;
    if (serverUp) {
      add('ok', '로컬 서버', `${base} 응답`);
      const robots = h.headers.get('x-robots-tag') || '';
      add(/noindex/.test(robots) ? 'ok' : 'fail', '보안 헤더', /noindex/.test(robots) ? 'noindex 있음' : 'noindex 가 없습니다 — 서버 코드가 오래됐는지 확인(git pull 후 restart-server)');
      const login = await fetchFn(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) });
      if (login.status === 403) add('ok', '관리 전용', '학생 로그인 403');
      else add('fail', '관리 전용', `학생 로그인이 ${login.status} — 관리 전용으로 뜨지 않았습니다. server.mjs 를 직접 띄운 창이 있으면 닫고 restart-server`);
    } else add('fail', '로컬 서버', `${base}/api/health 가 ${h.status}`);
  } catch {
    add('fail', '로컬 서버', `${base} 에 응답이 없습니다 — install-server 를 했는지, 로그(${cfg.logDir || '<DATA_DIR>\\logs'})를 보세요`);
  }

  if (serverUp) {
    const lan = lanAddresses(interfaces);
    const open = [];
    for (const a of lan) if (await connect(a, port)) open.push(a);
    if (open.length) add('fail', 'LAN 차단', `${open.join(', ')}:${port} 로 열려 있습니다 — 터널을 거치지 않는 입구입니다. 실행기로 띄웠는지 확인(HOST=127.0.0.1)`);
    else add('ok', 'LAN 차단', lan.length ? `${lan.join(', ')} 에서 닫힘` : 'LAN 주소 없음');
  }

  if (platform === 'win32') {
    const t = run(['schtasks', '/Query', '/TN', TASK_NAME]);
    add(!t.error && t.status === 0 ? 'ok' : 'fail', '작업 스케줄러', !t.error && t.status === 0 ? `${TASK_NAME} 등록됨` : `${TASK_NAME} 이 없습니다 — install-server`);
    const s = run(['powershell', '-NoProfile', '-Command', '(Get-Service -Name cloudflared -ErrorAction SilentlyContinue).Status']);
    const status = String((s && s.stdout) || '').trim();
    if (status === 'Running') add('ok', 'cloudflared 서비스', '실행 중');
    else add('fail', 'cloudflared 서비스', status ? `상태 ${status} — 서비스 앱에서 Cloudflared 를 시작하세요` : '설치되지 않았습니다 — README 3단계(tunnel)');
    const exe = findCloudflared({ run });
    if (exe) {
      const vt = String((run([exe, '--version']).stdout) || '').trim();
      if (cloudflaredOk(vt)) add('warn', 'cloudflared 버전', `${vt} — Windows 는 자동 갱신이 없습니다. 분기마다 README 의 업데이트 절차`);
      else add('fail', 'cloudflared 버전', `${vt || '알 수 없음'} — ${MIN_CLOUDFLARED} 보다 옛 버전은 서비스 설치 때 토큰을 레지스트리에 평문으로 남깁니다. 업데이트 후 서비스를 다시 설치하세요`);
    }
  }

  /* 터널이 Cloudflare 에 붙어 있는지 — cloudflared metrics 의 /ready (200 = 연결됨, 503 = 안 됨) */
  let ready = null;
  for (const mp of METRICS_PORTS) {
    try {
      const r = await fetchFn(`http://${LOOPBACK}:${mp}/ready`, { signal: AbortSignal.timeout(1500) });
      ready = { port: mp, status: r.status };
      if (r.status === 200) break;
    } catch { /* 이 포트엔 없다 */ }
  }
  if (ready && ready.status === 200) add('ok', '터널 연결', `cloudflared 가 Cloudflare 에 붙어 있습니다(127.0.0.1:${ready.port}/ready)`);
  else if (ready) add('fail', '터널 연결', `cloudflared 는 떠 있지만 Cloudflare 에 붙지 못했습니다(/ready ${ready.status}) — 인터넷·방화벽(바깥 7844 포트)을 확인하세요`);
  else if (platform === 'win32') add('warn', '터널 연결', 'cloudflared metrics(127.0.0.1:20241~20245)를 찾지 못했습니다 — 바깥 주소 점검 결과로 판단하세요');

  const target = (host || cfg.publicHost || '').trim().toLowerCase();
  if (!target) add('warn', '바깥 주소', '확인할 주소가 없습니다 — 설정 파일에 PUBLIC_HOST=wb.내도메인 을 적거나 --host 를 주세요');
  else if (!isHostname(target)) add('fail', '바깥 주소', `주소 모양이 아닙니다: ${target}`);
  else {
    for (const p of ['/', '/admin/']) {
      let probe;
      try {
        const r = await fetchFn(`https://${target}${p}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const body = r.status >= 400 ? (await r.text().catch(() => '')).slice(0, 2000) : '';
        probe = classifyProbe({ status: r.status, location: r.headers.get('location'), robots: r.headers.get('x-robots-tag'), body, wwwAuthenticate: r.headers.get('www-authenticate') });
      } catch (e) {
        probe = classifyProbe({ errorCode: (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'ETIMEDOUT' : 'EFETCH') });
      }
      add(probe.ok ? 'ok' : 'fail', `바깥 주소 ${p}`, `https://${target}${p} — ${probe.message}`);
    }
  }

  return results;
}

function printDoctor(results, out = console.log) {
  const mark = { ok: '✓', warn: '·', fail: '✗' };
  for (const r of results) out(`${mark[r.level]} ${r.name}: ${r.msg}`);
  const fails = results.filter((r) => r.level === 'fail').length;
  out(fails ? `\n고칠 곳 ${fails}건 — reading-server/tunnel/README.md 의 문제 해결을 보세요` : '\n전부 통과 ✓');
  out('잊지 말 것: 절전 끄기(전원 옵션) · 자료 폴더 백업은 NAS 로 · cloudflared 분기마다 업데이트');
  return fails;
}

/* ── 명령줄 ───────────────────────────────────────────────────────── */

function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

export async function main(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  const dryRun = argv.includes('--dry-run');
  const envFile = argValue(argv, '--env') || defaultEnvFile();
  const needWindowsAdmin = () => {
    if (dryRun) return;
    if (process.platform !== 'win32') throw new Error('이 명령은 Windows 에서만 실행합니다(--dry-run 으로 할 일만 볼 수 있습니다)');
    if (!isElevated()) throw new Error('관리자 권한 터미널에서 실행하세요(시작 메뉴 → 터미널 오른쪽 클릭 → 관리자 권한으로 실행)');
  };

  switch (cmd) {
    case 'env': {
      needWindowsAdmin();
      if (!envFile) throw new Error('--env <경로> 를 주세요');
      execute(planEnv({ envFile, exists: fs.existsSync(envFile), platform: process.platform === 'win32' || dryRun ? 'win32' : process.platform }), { dryRun });
      return 0;
    }
    case 'install-server': {
      needWindowsAdmin();
      const cfg = loadConfig(envFile);
      if (cfg.errors.length) throw new Error('설정 파일을 먼저 고치세요:\n  - ' + cfg.errors.join('\n  - '));
      execute(planInstallServer({ envFile, dataDir: cfg.dataDir }), { dryRun });
      if (!dryRun) {
        for (let i = 0; i < 30; i++) {
          try { if ((await fetch(`http://${LOOPBACK}:${cfg.port}/api/health`)).ok) { console.log(`\n서버가 떴습니다 ✓ http://${LOOPBACK}:${cfg.port}`); return 0; } } catch { /* 아직 */ }
          await new Promise((r) => setTimeout(r, 1000));
        }
        console.log(`\n30초 안에 서버가 응답하지 않았습니다 — 로그를 보세요: ${cfg.logDir}`);
        return 1;
      }
      return 0;
    }
    case 'restart-server': needWindowsAdmin(); execute(planRestartServer(), { dryRun }); return 0;
    case 'uninstall-server': needWindowsAdmin(); execute(planUninstallServer(), { dryRun }); return 0;
    case 'tunnel': {
      needWindowsAdmin();
      const tokenFile = argValue(argv, '--token-file');
      if (!tokenFile) throw new Error('--token-file <파일> 을 주세요 — 대시보드의 설치 명령을 메모장에 붙여 넣어 저장한 파일');
      const token = readToken(fs.readFileSync(tokenFile, 'utf8'));
      const cloudflared = findCloudflared() || (dryRun ? 'cloudflared.exe' : '');
      if (!cloudflared) throw new Error('cloudflared 를 찾지 못했습니다 — README 2단계의 공식 설치 파일(cloudflared-windows-amd64.msi)로 먼저 설치하세요');
      if (!dryRun) {
        const vt = String(quiet([cloudflared, '--version']).stdout || '').trim();
        if (!cloudflaredOk(vt)) throw new Error(`cloudflared ${vt || '(버전 알 수 없음)'} — ${MIN_CLOUDFLARED} 이상이 필요합니다(옛 버전은 토큰을 레지스트리에 평문으로 남깁니다). 최신 설치 파일로 업데이트하세요`);
      }
      execute(planTunnel({ cloudflared, token }), { dryRun });
      return 0;
    }
    case 'doctor': {
      const results = await doctor({ envFile, host: argValue(argv, '--host') });
      return printDoctor(results) ? 1 : 0;
    }
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, ''));
      return cmd ? 1 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code || 0), (e) => { console.error('✗ ' + (e && e.message)); process.exit(1); });
}
