#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.mjs <명령> [옵션]
   결정·이유: docs/로컬-서버-외부공개-터널.md   ·   순서대로 따라 하는 안내: reading-server/tunnel/README.md

   명령 (★ = 관리자 권한 터미널에서)
     env                설정 폴더를 잠그고 설정 파일 견본을 만든다(이미 있으면 내용은 건드리지 않는다) ★
     install-server     서버 코드를 관리자 전용 자리에 복사하고, 작업 스케줄러에 등록하고, 띄운다     ★
     restart-server     지금 저장소의 코드를 다시 복사해 서버를 다시 띄운다(git pull 뒤)              ★
     uninstall-server   작업 스케줄러와 코드 사본을 지운다(자료·설정 파일은 그대로)                  ★
     tunnel             cloudflared 를 Windows 서비스로 설치 — --token-file <파일>(끝나면 지운다)     ★
     doctor             전부 점검한다(로컬 서버·관리 전용·LAN 차단·폴더 권한·서비스·바깥 주소의 Access)

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
  TASK_NAME, LOOPBACK, envTemplate, taskXml, utf16leWithBom, classifyProbe, isHostname, isInside,
  cloudflaredOk, MIN_CLOUDFLARED, METRICS_PORTS, pickNodeExe, inOneDrive, nodeMajor, MIN_NODE_MAJOR,
  sharedFolderReason, folderState, ENV_DIR_OWN, DATA_DIR_OWN, APP_DIRS, APP_MARKER, appCopyKeep,
  aclScript, aclProblems, driveLetter,
} from './kit.mjs';
import { defaultEnvFile, loadConfig, resolveEnvArg, isWinAbs } from './run-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

/* SID 로 적는다 — 한국어 Windows 에서 그룹 이름은 "Administrators" 가 아니라 번역된 이름일 수 있다.
   S-1-5-32-544 = Administrators, S-1-5-18 = SYSTEM. 주인을 관리자로 바꾸고, 상속을 끊고, 이 둘만 남긴다
   (일반 사용자는 읽지도 고치지도 못한다). 주인부터 바꾸는 것은 일반 사용자가 폴더를 미리 만들어 두면
   그 사람이 주인으로 남아 권한을 되돌릴 수 있어서다. */
export const lockSteps = (dir, why) => [
  { run: ['icacls', dir, '/setowner', '*S-1-5-32-544', '/T', '/C'], why: `${why} — 주인을 관리자로` },
  { run: ['icacls', dir, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F'], why: `${why} — 관리자·SYSTEM 만` },
];

/* cloudflared 를 찾을 자리 — 설치 프로그램(MSI)의 기본 위치가 먼저다. PATH(where)는 그다음이고,
   지금 폴더·저장소 안에 놓인 cloudflared.exe 는 믿지 않는다(관리자 터미널이 토큰을 넘겨 주는 프로그램이다). */
export const CLOUDFLARED_CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'C:\\Cloudflared\\bin\\cloudflared.exe',
];

/* 코드 사본 자리 — 설정 파일 옆 app 폴더(기본 C:\ProgramData\WB\app). 설정 폴더와 같이 잠긴다. */
export const defaultAppDir = (envFile) => {
  const f = envFile || 'C:\\ProgramData\\WB\\server.env';
  const p = isWinAbs(f) ? path.win32 : path.posix;
  return p.join(p.dirname(f), 'app');
};
const dirOf = (f) => (isWinAbs(f) ? path.win32 : path.posix).dirname(f);

/* ── 할 일 목록 만들기 (부작용 없음) ─────────────────────────────────── */

/* 설정 폴더 — 비밀을 쓰기 전에 먼저 잠근다. 파일이 이미 있으면 내용은 두고 잠금만 다시 한다
   (예전에 잠금이 실패한 채로 남아 있을 수 있다). */
export function planEnv({ envFile, platform = process.platform, fileExists = false }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(envFile);
  const steps = [{ mkdir: dir, why: '설정 폴더' }];
  if (platform === 'win32') steps.push(...lockSteps(dir, '설정 폴더 잠그기(비밀번호가 들어간다)'));
  if (fileExists) steps.push({ note: `설정 파일이 이미 있습니다 — 내용은 건드리지 않습니다: ${envFile}` });
  else steps.push({ write: envFile, data: envTemplate({ dataDir: platform === 'win32' ? 'C:\\WB_server_data' : '' }), why: '설정 파일 견본(값은 비어 있음)' });
  steps.push({ verifyAcl: dir, why: '설정 폴더가 관리자·SYSTEM 만인지 확인' });
  steps.push({ note: `이제 이 관리자 터미널에서 메모장으로 채우세요: notepad "${envFile}"` });
  return steps;
}

export function planDeployApp({ repo = REPO, appDir }) {
  return [
    { deployApp: { from: repo, to: appDir }, why: `서버 코드를 관리자 전용 자리로 복사(${APP_DIRS.length}개 폴더)` },
    ...lockSteps(appDir, '코드 사본 잠그기(SYSTEM 이 실행하는 코드를 일반 사용자가 못 고치게)'),
    { verifyAcl: appDir, why: '코드 사본이 관리자·SYSTEM 만인지 확인' },
  ];
}

export function planInstallServer({ envFile, dataDir, appDir, nodeExe = process.execPath, tmpDir = os.tmpdir(), repo = REPO, platform = process.platform }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const xmlFile = p.join(tmpDir, 'wb-admin-server-task.xml');
  const xml = taskXml({ nodeExe, runScript: p.join(appDir, 'reading-server', 'tunnel', 'run-server.mjs'), envFile, workDir: appDir });
  return [
    { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '이미 돌고 있으면 멈추기(처음이면 없다고 나온다 — 괜찮다)', okCodes: [0, 1] },
    { mkdir: dataDir, why: '자료 폴더' },
    ...lockSteps(dataDir, '자료 폴더 잠그기(학생 기록·라이선스 팩)'),
    { verifyAcl: dataDir, why: '자료 폴더가 관리자·SYSTEM 만인지 확인' },
    ...planDeployApp({ repo, appDir }),
    { write: xmlFile, data: utf16leWithBom(xml), why: '작업 정의(UTF-16)' },
    /* /RU SYSTEM 을 같이 준다 — /XML 과 함께 쓸 수 있고(문서), XML 의 주체가 무시되더라도 SYSTEM 으로 못 박는다 */
    { run: ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/RU', 'SYSTEM', '/F'], why: `작업 스케줄러에 ${TASK_NAME} 등록(부팅 + 5분마다 살아 있는지)` },
    { remove: xmlFile, why: '작업 정의 임시 파일 지우기' },
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '지금 바로 띄우기' },
    { note: `확인: schtasks /Query /TN ${TASK_NAME} /V /FO LIST — 실행 사용자 SYSTEM, 중지 시간 제한 없음` },
  ];
}

export function planRestartServer({ repo = REPO, appDir }) {
  return [
    { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '멈추기(서버도 같이 끝난다)', okCodes: [0, 1] },
    ...planDeployApp({ repo, appDir }),
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '다시 띄우기' },
  ];
}

export function planUninstallServer({ appDir }) {
  return [
    { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '멈추기', okCodes: [0, 1] },
    { run: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'], why: '작업 지우기' },
    { removeApp: appDir, why: '코드 사본 지우기(자료·설정 파일은 그대로)' },
  ];
}

/* 터널 토큰은 Cloudflare 대시보드가 보여 주는 설치 명령의 끝부분이다. 비밀이라 파일로 받아 화면에 찍지 않는다.
   옛 cloudflared(2026.7.3 미만)는 서비스 설치 때 토큰을 레지스트리에 평문으로 남기므로 여기서 거절한다 —
   검사를 할 일 목록 안에 두어야 테스트가 실제 설치 경로를 본다. */
export function planTunnel({ cloudflared, token, versionText, tokenFile, dryRun = false }) {
  if (!dryRun && !cloudflaredOk(versionText)) {
    throw new Error(`cloudflared ${String(versionText || '').trim() || '(버전 알 수 없음)'} — ${MIN_CLOUDFLARED} 이상이 필요합니다(옛 버전은 토큰을 레지스트리에 평문으로 남깁니다). README 2단계의 최신 설치 파일로 올리세요`);
  }
  return [
    { run: [cloudflared, 'service', 'install', token], secret: token, why: 'cloudflared 를 Windows 서비스로 설치(부팅 때 자동 시작 · 토큰은 C:\\ProgramData\\cloudflared\\token 에 관리자·SYSTEM 만)' },
    ...(tokenFile ? [{ remove: tokenFile, why: '토큰 파일 지우기(서비스가 따로 보관한다)' }] : []),
    { note: '"already installed" 가 나오면 먼저 cloudflared service uninstall 뒤 다시' },
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
  if (step.deployApp) return `> 복사 ${step.deployApp.from} → ${step.deployApp.to}`;
  if (step.removeApp) return `> 코드 사본 지우기 ${step.removeApp}`;
  if (step.verifyAcl) return `> 권한 확인 ${step.verifyAcl}`;
  return '';
};

export function execute(steps, { dryRun = false, runner = defaultRunner, out = console.log, ops = defaultOps } = {}) {
  for (const step of steps) {
    if (step.note) { out('  · ' + step.note); continue; }
    out(`${dryRun ? '[할 일] ' : ''}${step.why ? step.why + '\n  ' : ''}${show(step)}`);
    if (dryRun) continue;
    if (step.mkdir) { fs.mkdirSync(step.mkdir, { recursive: true }); continue; }
    if (step.write) { fs.writeFileSync(step.write, step.data); continue; }
    if (step.remove) { fs.rmSync(step.remove, { force: true }); continue; }
    if (step.deployApp) { ops.deployApp(step.deployApp.from, step.deployApp.to); continue; }
    if (step.removeApp) { ops.removeApp(step.removeApp); continue; }
    if (step.verifyAcl) { ops.verifyAcl(step.verifyAcl, runner); continue; }
    if (step.run) {
      const code = runner(step.run);
      if (!(step.okCodes || [0]).includes(code)) throw new Error(`실패(종료 코드 ${code}): ${step.why || step.run[0]}`);
    }
  }
}

/* Windows 기본 도구는 System32 의 전체 경로로 부른다 — 이름만 주면 지금 폴더를 PATH 보다 먼저 뒤져서,
   저장소에 누가 놓아 둔 icacls.exe·schtasks.exe 가 관리자 권한으로 실행될 수 있다. */
const SYS_TOOLS = {
  icacls: 'icacls.exe', schtasks: 'schtasks.exe', whoami: 'whoami.exe', where: 'where.exe', net: 'net.exe',
  powershell: 'WindowsPowerShell\\v1.0\\powershell.exe',
};
export function sysTool(name, platform = process.platform, env = process.env) {
  if (platform !== 'win32' || !SYS_TOOLS[name]) return name;
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', SYS_TOOLS[name]);
}
const resolveArgv = (argv) => [sysTool(argv[0]), ...argv.slice(1)];

function defaultRunner(argv) {
  const a = resolveArgv(argv);
  const r = spawnSync(a[0], a.slice(1), { stdio: 'inherit', windowsHide: true });
  if (r.error) throw new Error(`${argv[0]} 을(를) 실행하지 못했습니다: ${r.error.code || r.error.message}`);
  return r.status;
}
const quiet = (argv) => { const a = resolveArgv(argv); return spawnSync(a[0], a.slice(1), { encoding: 'utf8', windowsHide: true }); };

/* 폴더 권한을 PowerShell 로 읽는다 — 이름이 아니라 SID 로(언어와 무관). 남의 허용 항목이 남아 있으면
   하나씩 지우고 다시 읽는다. 그래도 남으면 멈춘다(잠기지 않은 채로 비밀·학생 기록을 두지 않는다). */
export function readAcl(dir, run = quiet) {
  const r = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', aclScript(dir)]);
  return aclProblems(r && r.stdout);
}
export function verifyAcl(dir, runner = defaultRunner, run = quiet) {
  let a = readAcl(dir, run);
  if (!a.readable) throw new Error(`권한을 읽지 못했습니다: ${dir} — 관리자 권한 터미널인지 확인하세요`);
  if (a.foreign.length) {
    for (const sid of a.foreign) runner(['icacls', dir, '/remove:g', `*${sid}`, '/T', '/C']);
    a = readAcl(dir, run);
  }
  if (!a.ownerOk || a.foreign.length) {
    throw new Error(`잠그지 못했습니다: ${dir} — 주인 ${a.owner}${a.foreign.length ? ', 남은 권한 ' + a.foreign.join(', ') : ''}. 이 폴더를 지우고(자료가 있으면 옮기고) 다시 하세요`);
  }
}

/* 저장소의 서버 코드를 사본 자리로. 사본 자리에 우리 표식이 없는데 무언가 들어 있으면 지우지 않는다 —
   잘못 적은 경로가 원장의 폴더를 지우는 일이 없게. */
export function deployApp(from, to, { fsx = fs } = {}) {
  if (fsx.existsSync(to)) {
    const entries = fsx.readdirSync(to);
    if (entries.length && !entries.includes(APP_MARKER)) throw new Error(`코드 사본 자리에 다른 파일이 있습니다: ${to} — 빈 폴더이거나 이 도구가 만든 자리여야 합니다`);
    fsx.rmSync(to, { recursive: true, force: true });
  }
  fsx.mkdirSync(to, { recursive: true });
  for (const d of APP_DIRS) {
    const src = path.join(from, d);
    if (!fsx.existsSync(src)) throw new Error(`저장소에 ${d} 폴더가 없습니다 — 저장소 전체를 받았는지 확인하세요`);
    fsx.cpSync(src, path.join(to, d), { recursive: true, filter: (s) => appCopyKeep(path.relative(from, s)) });
  }
  fsx.writeFileSync(path.join(to, APP_MARKER), JSON.stringify({ from, commit: gitHead(from), at: new Date().toISOString() }, null, 2));
}
export function removeApp(to, { fsx = fs } = {}) {
  if (!fsx.existsSync(to)) return;
  if (!fsx.existsSync(path.join(to, APP_MARKER))) throw new Error(`이 도구가 만든 코드 사본이 아닙니다: ${to} — 지우지 않습니다`);
  fsx.rmSync(to, { recursive: true, force: true });
}
/* 저장소의 지금 커밋 — git 이 없어도 읽히게 .git 을 직접 본다(못 읽으면 빈 값) */
export function gitHead(repo) {
  try {
    const head = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const loose = path.join(repo, '.git', ...ref.split('/'));
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
    const packed = fs.readFileSync(path.join(repo, '.git', 'packed-refs'), 'utf8');
    const m = packed.split(/\r?\n/).find((l) => l.endsWith(' ' + ref));
    return m ? m.split(' ')[0] : '';
  } catch { return ''; }
}
const defaultOps = { deployApp: (f, t) => deployApp(f, t), removeApp: (t) => removeApp(t), verifyAcl: (d, r) => verifyAcl(d, r) };

/* 관리자 권한인지 — 무결성 수준 SID 로 본다(언어와 무관): 높음 S-1-16-12288, 시스템 S-1-16-16384.
   UAC 아래 관리자 계정이라도 "관리자 권한으로 실행" 하지 않은 터미널은 중간(S-1-16-8192)이다.
   whoami 를 못 쓰는 경우에만 예전 방법(net session — 서버 서비스가 꺼져 있으면 틀릴 수 있다)으로 본다. */
export function isElevated(run = quiet) {
  const w = run(['whoami', '/groups', '/fo', 'csv', '/nh']);
  if (!w.error && w.status === 0 && w.stdout) return /S-1-16-(12288|16384)\b/.test(String(w.stdout));
  const r = run(['net', 'session']);
  return !r.error && r.status === 0;
}

export function findCloudflared({ run = quiet, exists = fs.existsSync, cwd = process.cwd(), repo = REPO } = {}) {
  const installed = CLOUDFLARED_CANDIDATES.find((c) => exists(c));
  if (installed) return installed;
  const w = run(['where', 'cloudflared']);
  if (!w.error && w.status === 0) {
    const ok = String(w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .find((p) => !isInside(p, cwd, 'win32') && !isInside(p, repo, 'win32'));
    if (ok) return ok;
  }
  return '';
}

/* 드라이브 종류 — Fixed(이 PC 디스크)만 받는다. 매핑된 네트워크 드라이브는 SYSTEM 에게 안 보인다. */
export function driveType(dir, run = quiet) {
  const L = driveLetter(dir);
  if (!L) return '';
  const r = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `([System.IO.DriveInfo]::new('${L}')).DriveType`]);
  return String((r && r.stdout) || '').trim();
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

export async function doctor({ envFile, host, appDir } = {}, deps = {}) {
  const {
    platform = process.platform, fetchFn = fetch, run = quiet, connect = canConnect, interfaces = os.networkInterfaces(),
    nodeVersion = process.versions.node, load = loadConfig, readMarker = (d) => JSON.parse(fs.readFileSync(path.join(d, APP_MARKER), 'utf8')),
    repoHead = () => gitHead(REPO),
  } = deps;
  const results = [];
  const add = (level, name, msg) => results.push({ level, name, msg });

  if (nodeMajor(nodeVersion) >= MIN_NODE_MAJOR) add('ok', 'Node.js', `v${nodeVersion}`);
  else add('fail', 'Node.js', `v${nodeVersion} — ${MIN_NODE_MAJOR} 이상이 필요합니다(nodejs.org LTS 설치 파일)`);

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
    add('fail', '로컬 서버', `${base} 에 응답이 없습니다 — install-server 를 했는지, 로그(${cfg.logDir || '<DATA_DIR>\\logs'})와 ${envFile ? path.join(dirOf(envFile), 'run-server-error.log') : 'run-server-error.log'} 를 보세요`);
  }

  if (serverUp) {
    const lan = lanAddresses(interfaces);
    const open = [];
    for (const a of lan) if (await connect(a, port)) open.push(a);
    if (open.length) add('fail', 'LAN 차단', `${open.join(', ')}:${port} 로 열려 있습니다 — 터널을 거치지 않는 입구입니다. 실행기로 띄웠는지 확인(HOST=127.0.0.1)`);
    else add('ok', 'LAN 차단', lan.length ? `${lan.join(', ')} 에서 닫힘` : 'LAN 주소 없음');
  }

  if (platform === 'win32') {
    const admin = isElevated(run);
    add(admin ? 'ok' : 'warn', '관리자 권한', admin ? '관리자 권한 터미널' : '관리자 권한이 아닙니다 — 폴더 권한 점검은 관리자 터미널에서만 됩니다');

    const app = appDir || defaultAppDir(envFile);
    const dirs = [['설정 폴더', envFile ? dirOf(envFile) : ''], ['자료 폴더', cfg.dataDir], ['코드 사본', app]];
    for (const [name, dir] of dirs) {
      if (!dir) continue;
      const a = readAcl(dir, run);
      if (!a.readable) add('warn', `권한: ${name}`, `${dir} 의 권한을 읽지 못했습니다(관리자 터미널에서 다시)`);
      else if (!a.ownerOk || a.foreign.length) add('fail', `권한: ${name}`, `${dir} — 관리자·SYSTEM 말고도 열 수 있습니다(${[!a.ownerOk ? '주인 ' + a.owner : '', ...a.foreign].filter(Boolean).join(', ')}). env/install-server 를 다시`);
      else add('ok', `권한: ${name}`, `${dir} — 관리자·SYSTEM 만`);
    }
    if (cfg.dataDir) {
      const dt = driveType(cfg.dataDir, run);
      if (dt && dt !== 'Fixed') add('fail', '자료 드라이브', `${driveLetter(cfg.dataDir)}: 는 ${dt} 드라이브입니다 — 서버(SYSTEM)에게 안 보이거나 빠질 수 있습니다. 이 PC 디스크로`);
    }
    try {
      const m = readMarker(app);
      const head = repoHead();
      if (head && m.commit && head !== m.commit) add('warn', '코드 사본', `저장소(${head.slice(0, 7)})와 서버가 돌리는 사본(${m.commit.slice(0, 7)})이 다릅니다 — restart-server 로 반영`);
      else add('ok', '코드 사본', `${app}${m.commit ? ' · ' + m.commit.slice(0, 7) : ''}`);
    } catch { add('fail', '코드 사본', `${app} 에 코드 사본이 없습니다 — install-server`); }

    const t = run(['schtasks', '/Query', '/TN', TASK_NAME]);
    add(!t.error && t.status === 0 ? 'ok' : 'fail', '작업 스케줄러', !t.error && t.status === 0 ? `${TASK_NAME} 등록됨` : `${TASK_NAME} 이 없습니다 — install-server`);
    const s = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', '(Get-Service -Name cloudflared -ErrorAction SilentlyContinue).Status']);
    const status = String((s && s.stdout) || '').trim();
    if (status === 'Running') add('ok', 'cloudflared 서비스', '실행 중');
    else add('fail', 'cloudflared 서비스', status ? `상태 ${status} — 서비스 앱에서 Cloudflared 를 시작하세요` : '설치되지 않았습니다 — README 3단계(tunnel)');
    const exe = findCloudflared({ run });
    if (exe) {
      const vt = String((run([exe, '--version']).stdout) || '').trim();
      if (cloudflaredOk(vt)) add('ok', 'cloudflared 버전', `${vt} (자동 갱신 없음 — 분기마다 README 5절)`);
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
  else if (platform === 'win32') add('warn', '터널 연결', 'cloudflared metrics(127.0.0.1:20241~20245)를 찾지 못했습니다 — 바깥 주소 두 줄이 ✓ 면 괜찮습니다');

  const target = (host || cfg.publicHost || '').trim().toLowerCase();
  /* 바깥 주소 점검은 "Access 없이 열렸는가"를 잡는 유일한 칸이다 — 원장 PC(Windows)에서는 빠지면 실패로 친다 */
  if (!target) add(platform === 'win32' ? 'fail' : 'warn', '바깥 주소', '확인할 주소가 없어 Access 가 걸렸는지 보지 못했습니다 — 설정 파일에 PUBLIC_HOST=wb.내도메인 을 적거나 --host 를 주세요');
  else if (!isHostname(target)) add('fail', '바깥 주소', `주소 모양이 아닙니다: ${target}`);
  else {
    for (const p of ['/', '/admin/']) {
      let probe;
      try {
        /* redirect: 'manual' — 따라가면 Access 로그인 화면(200)을 받아 판정이 뒤집힌다 */
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

export function printDoctor(results, out = console.log) {
  const mark = { ok: '✓', warn: '·', fail: '✗' };
  for (const r of results) out(`${mark[r.level]} ${r.name}: ${r.msg}`);
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  if (fails) out(`\n고칠 곳 ${fails}건(✗) — reading-server/tunnel/README.md 의 문제 해결을 보세요`);
  else if (warns) out(`\n실패 0건 · 확인하지 못한 항목 ${warns}건(·) — 위의 · 줄을 읽어 보세요. 바깥 주소 두 줄은 ✓ 여야 합니다`);
  else out('\n전부 통과 ✓');
  out('잊지 말 것: 절전 끄기(전원 옵션) · 자료 폴더 백업은 NAS 로 · cloudflared 분기마다 업데이트');
  return fails;
}

/* ── 명령줄 ───────────────────────────────────────────────────────── */

function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; }

/* 설정 폴더로 써도 되는가 — 저장소 안·저장소를 품은 자리·드라이브 뿌리·사용자 폴더·남의 파일이 든 폴더는 안 된다
   (그 폴더를 잠그면 원장이 자기 파일이나 저장소를 못 연다). */
export function envDirProblem({ envFile, entries, repo = REPO, platform = process.platform }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(envFile);
  if (isInside(envFile, repo, platform)) return '설정 파일이 저장소 안입니다 — 비밀번호가 커밋될 수 있습니다';
  if (isInside(repo, dir, platform)) return '설정 폴더가 저장소를 품고 있습니다 — 잠그면 저장소까지 잠깁니다';
  const shared = sharedFolderReason(dir, platform);
  if (shared) return `설정 폴더로 ${shared} 는 쓰지 않습니다`;
  if (folderState(entries, ENV_DIR_OWN) === 'foreign') return `${dir} 에 다른 파일이 있습니다 — 설정 전용 폴더(기본 C:\\ProgramData\\WB)를 쓰세요`;
  return '';
}
export function dataDirProblem({ dataDir, entries }) {
  if (folderState(entries, DATA_DIR_OWN) === 'foreign') return `${dataDir} 에 서버 것이 아닌 파일이 있습니다 — 관리자만 열리게 잠그는 폴더라 서버 전용 새 폴더여야 합니다(예: C:\\WB_server_data)`;
  return '';
}
const listDir = (d) => { try { return fs.readdirSync(d); } catch (e) { return e && e.code === 'ENOENT' ? null : []; } };

export async function main(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  const dryRun = argv.includes('--dry-run');
  const envFile = resolveEnvArg(argValue(argv, '--env') || defaultEnvFile());
  const appDir = defaultAppDir(envFile);
  const needWindowsAdmin = () => {
    if (dryRun) return;
    if (process.platform !== 'win32') throw new Error('이 명령은 Windows 에서만 실행합니다(--dry-run 으로 할 일만 볼 수 있습니다)');
    if (!isElevated()) throw new Error('관리자 권한 터미널에서 실행하세요(시작 메뉴 → 터미널 오른쪽 클릭 → 관리자 권한으로 실행)');
  };
  const planPlatform = process.platform === 'win32' || dryRun ? 'win32' : process.platform;

  switch (cmd) {
    case 'env': {
      needWindowsAdmin();
      if (!envFile) throw new Error('--env <경로> 를 주세요');
      const problem = envDirProblem({ envFile, entries: listDir(dirOf(envFile)), platform: isWinAbs(envFile) ? 'win32' : process.platform });
      if (problem) throw new Error(problem);
      execute(planEnv({ envFile, fileExists: fs.existsSync(envFile), platform: isWinAbs(envFile) ? 'win32' : planPlatform }), { dryRun });
      return 0;
    }
    case 'install-server': {
      needWindowsAdmin();
      const cfg = loadConfig(envFile);
      if (cfg.errors.length) throw new Error('설정 파일을 먼저 고치세요:\n  - ' + cfg.errors.join('\n  - '));
      const dp = dataDirProblem({ dataDir: cfg.dataDir, entries: listDir(cfg.dataDir) });
      if (dp) throw new Error(dp);
      if (!dryRun) {
        const dt = driveType(cfg.dataDir);
        if (dt && dt !== 'Fixed') throw new Error(`${driveLetter(cfg.dataDir)}: 는 ${dt} 드라이브입니다 — 서버(SYSTEM)에게 안 보이거나 빠질 수 있습니다. DATA_DIR 을 이 PC 디스크로`);
      }
      const versionOf = (exe) => String(quiet([exe, '-p', 'process.versions.node']).stdout || '').trim();
      const { nodeExe, warning } = pickNodeExe(process.execPath, fs.existsSync, versionOf);
      if (warning) console.log('[참고] ' + warning);
      if (!dryRun && nodeMajor(versionOf(nodeExe)) < MIN_NODE_MAJOR) throw new Error(`작업에 적을 node(${nodeExe})가 ${MIN_NODE_MAJOR} 보다 낮습니다 — LTS 설치 파일로 올린 뒤 다시`);
      if (inOneDrive(REPO)) console.log(`[주의] 저장소가 OneDrive 폴더 안입니다(${REPO}) — 사본은 OneDrive 밖에 만들지만, 저장소도 C:\\WB\\wb-site 처럼 밖에 두길 권합니다`);
      execute(planInstallServer({ envFile, dataDir: cfg.dataDir, appDir, nodeExe, platform: planPlatform }), { dryRun });
      if (!dryRun) {
        for (let i = 0; i < 45; i++) {
          try { if ((await fetch(`http://${LOOPBACK}:${cfg.port}/api/health`)).ok) { console.log(`\n서버가 떴습니다 ✓ http://${LOOPBACK}:${cfg.port}`); return 0; } } catch { /* 아직 */ }
          await new Promise((r) => setTimeout(r, 1000));
        }
        console.log(`\n45초 안에 서버가 응답하지 않았습니다 — 로그를 보세요: ${cfg.logDir} · ${path.join(dirOf(envFile), 'run-server-error.log')}`);
        return 1;
      }
      return 0;
    }
    case 'restart-server': needWindowsAdmin(); execute(planRestartServer({ appDir }), { dryRun }); return 0;
    case 'uninstall-server': needWindowsAdmin(); execute(planUninstallServer({ appDir }), { dryRun }); return 0;
    case 'tunnel': {
      needWindowsAdmin();
      const raw = argValue(argv, '--token-file');
      if (!raw) throw new Error('--token-file <파일> 을 주세요 — 대시보드의 설치 명령을 메모장에 붙여 넣어 저장한 파일');
      const tokenFile = path.resolve(raw);
      let text;
      try { text = fs.readFileSync(tokenFile, 'utf8'); }
      catch (e) {
        if (e && (e.code === 'EACCES' || e.code === 'EPERM')) throw new Error(`토큰 파일을 읽을 권한이 없습니다: ${tokenFile} — 관리자 터미널에서 실행하세요`);
        throw new Error(`토큰 파일이 없습니다: ${tokenFile} — 같은 관리자 터미널에서 notepad "${tokenFile}" 로 만들어 저장하세요(문서 폴더로 저장하라는 창이 뜨면 거절)`);
      }
      const token = readToken(text);
      const cloudflared = findCloudflared() || (dryRun ? 'cloudflared.exe' : '');
      if (!cloudflared) throw new Error('cloudflared 를 찾지 못했습니다 — README 2단계의 공식 설치 파일(cloudflared-windows-amd64.msi)로 먼저 설치하세요');
      const versionText = dryRun ? '' : String(quiet([cloudflared, '--version']).stdout || '').trim();
      execute(planTunnel({ cloudflared, token, versionText, tokenFile, dryRun }), { dryRun });
      return 0;
    }
    case 'doctor': {
      const results = await doctor({ envFile, host: argValue(argv, '--host'), appDir });
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
