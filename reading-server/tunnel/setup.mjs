#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.mjs <명령> [옵션]
   결정·이유: docs/로컬-서버-외부공개-터널.md   ·   순서대로 따라 하는 안내: reading-server/tunnel/README.md

   명령 (★ = 관리자 권한 터미널에서)
     env                설정 폴더를 잠그고 설정 파일 견본을 만든다(이미 있으면 내용은 건드리지 않는다) ★
     install-server     서버 코드·node.exe 를 관리자 전용 자리에 복사·잠그고, 작업 스케줄러에 등록하고, 띄운다 ★
     restart-server     같은 검사를 거쳐 지금 저장소의 코드·node.exe 를 다시 복사해 다시 띄운다(git pull 뒤) ★
     uninstall-server   작업 스케줄러와 코드 사본을 지운다(자료·설정 파일은 그대로)                  ★
     tunnel             cloudflared 를 Windows 서비스로 설치 — --token-file <파일>(끝나면 지운다)     ★
     doctor             전부 점검한다(로컬 서버·관리 전용·LAN 차단·폴더 권한·서비스·바깥 주소의 Access)

   공통 옵션: --env <설정 파일>(기본 C:\ProgramData\WB\server.env) · --dry-run(실행하지 않고 할 일만 보여 준다)
   doctor 옵션: --host <바깥 주소>(설정 파일의 PUBLIC_HOST 대신)

   비밀(관리 비밀번호·터널 토큰)은 화면·로그에 찍지 않는다. 할 일은 plan* 함수가 목록으로 만들고(테스트가 본다)
   실행은 execute 하나가 한다 — Windows 에서만 도는 부분을 얇게 두려는 것이다. */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_NAME, LOOPBACK, envTemplate, taskXml, utf16leWithBom, classifyProbe, isHostname, isInside,
  cloudflaredOk, MIN_CLOUDFLARED, METRICS_PORTS, inOneDrive, nodeMajor, MIN_NODE_MAJOR, APP_NODE,
  sharedFolderReason, folderState, ENV_DIR_OWN, DATA_DIR_OWN, APP_DIRS, APP_MARKER, APP_PKG, APP_PKG_BODY, appCopyKeep,
  ACL_SCRIPT, aclProblems, driveLetter,
} from './kit.mjs';
import { defaultEnvFile, loadConfig, resolveEnvArg, isWinAbs } from './run-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 저장소 자리는 실제 경로(8.3 짧은 이름·링크를 푼 것)로 — 안/밖 비교가 짧은 이름으로 비켜 가지 않게 */
const REPO = (() => { const r = path.resolve(HERE, '..', '..'); try { return fs.realpathSync.native(r); } catch { return r; } })();

/* SID 로 적는다 — 한국어 Windows 에서 그룹 이름은 "Administrators" 가 아니라 번역된 이름일 수 있다.
   S-1-5-32-544 = Administrators, S-1-5-18 = SYSTEM. 순서:
   ① 폴더 안팎에 링크(심볼릭 링크·정션)가 없는지 — 있으면 잠금·확인이 링크 너머의 다른 폴더에 걸린다
   ② 주인을 관리자로(일반 사용자가 폴더를 미리 만들어 두면 그 사람이 주인으로 남아 권한을 되돌릴 수 있다)
   ③ 상속을 끊고 관리자·SYSTEM 만  ④ 안에 이미 있던 파일·폴더의 따로 붙은 권한을 지워 위 권한을 물려받게
   ⑤ 다시 읽어 확인(verifyAcl) — 남의 허용 항목이 남으면 멈춘다. */
export const lockSteps = (dir, why) => [
  { noLinks: dir, why: `${why} — 링크가 없는지` },
  { run: ['icacls', dir, '/setowner', '*S-1-5-32-544', '/T', '/C'], why: `${why} — 주인을 관리자로` },
  { run: ['icacls', dir, '/inheritance:r', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/grant:r', '*S-1-5-18:(OI)(CI)F'], why: `${why} — 관리자·SYSTEM 만` },
  { resetChildren: dir, why: `${why} — 안의 파일도 같은 권한으로` },
  { verifyAcl: dir, why: `${why} — 확인` },
];

/* cloudflared 는 설치 프로그램(MSI)이 까는 Program Files 아래만 믿는다(관리자만 쓸 수 있는 자리).
   C:\ 바로 아래 폴더·사용자 PATH 에 놓인 cloudflared.exe 는 일반 사용자가 바꿔 끼울 수 있고, 그 파일이
   토큰을 받고 SYSTEM 서비스로 등록된다. */
export const cloudflaredCandidates = (env = process.env) => [
  path.win32.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
  path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
];

/* 코드 사본 자리 — 설정 파일 옆 app 폴더(기본 C:\ProgramData\WB\app). 설정 폴더와 같이 잠긴다. */
export const defaultAppDir = (envFile) => {
  const f = envFile || 'C:\\ProgramData\\WB\\server.env';
  const p = isWinAbs(f) ? path.win32 : path.posix;
  return p.join(p.dirname(f), 'app');
};
const dirOf = (f) => (isWinAbs(f) ? path.win32 : path.posix).dirname(f);
const pathFor = (f) => (isWinAbs(f) ? path.win32 : path.posix);

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
  if (platform === 'win32') steps.push({ verifyAcl: dir, why: '설정 폴더가 관리자·SYSTEM 만인지 다시 확인' });
  steps.push({ note: `이제 이 관리자 터미널에서 메모장으로 채우세요: notepad "${envFile}"` });
  return steps;
}

/* 코드 사본 — 저장소의 서버 폴더와 지금 쓰는 node.exe 를 관리자 전용 자리로 복사하고 잠근다.
   저장소 안에서(또는 사본 안에서) 이 도구를 돌리면 원본과 사본이 겹친다 — 사본을 지우는 순간 원본이 사라진다. */
export function planDeployApp({ repo = REPO, appDir, nodeSrc }) {
  const plat = isWinAbs(appDir) ? 'win32' : process.platform;
  if (isInside(appDir, repo, plat) || isInside(repo, appDir, plat)) {
    throw new Error(`코드 사본(${appDir})과 저장소(${repo})가 겹칩니다 — 저장소 폴더(예: C:\\WB\\wb-site)에서 node reading-server\\tunnel\\setup.mjs 로 다시 실행하세요`);
  }
  return [
    { deployApp: { from: repo, to: appDir }, why: `서버 코드를 관리자 전용 자리로 복사(${APP_DIRS.length}개 폴더)` },
    ...(nodeSrc ? [{ copyNode: { from: nodeSrc, to: APP_NODE(appDir) }, why: 'node.exe 도 사본 안으로(작업이 일반 사용자가 바꿀 수 있는 node 를 돌리지 않게)' }] : []),
    ...lockSteps(appDir, '코드 사본 잠그기(SYSTEM 이 실행하는 코드를 일반 사용자가 못 고치게)'),
  ];
}

/* 자료 폴더 — 만들고, 잠그고, 확인 */
const dataSteps = (dataDir) => [{ mkdir: dataDir, why: '자료 폴더' }, ...lockSteps(dataDir, '자료 폴더 잠그기(학생 기록·라이선스 팩)')];
/* 설정 폴더가 잠겨 있는지 — SYSTEM 이 부팅마다 읽는 비밀번호 파일이고, 코드 사본도 그 안에 있다 */
const envGuard = (envFile) => [{ noLinks: dirOf(envFile), why: '설정 폴더에 링크가 없는지' }, { verifyAcl: dirOf(envFile), why: '설정 폴더가 잠겨 있는지(아니면 먼저 setup.mjs env)' }];
/* 바꾸는 동안 5분 감시가 사본을 띄우지 않게 작업을 잠시 끈다(없으면 1 — 괜찮다). 이 뒤에 실패하면 작업이 꺼진 채
   남으므로(execute 가 그렇게 알린다), 거절할 수 있는 검사는 모두 이 앞에 둔다. */
const pauseTask = [
  { run: ['schtasks', '/Change', '/TN', TASK_NAME, '/DISABLE'], why: '작업 잠시 끄기(바꾸는 동안 5분 감시가 띄우지 않게)', okCodes: [0, 1], pause: true },
  { run: ['schtasks', '/End', '/TN', TASK_NAME], why: '돌고 있으면 멈추기(서버도 같이 끝난다)', okCodes: [0, 1] },
];
/* 서버를 멈추기 전에 하는 검사 — 원본 폴더·링크, 사본 자리가 비었거나 우리 것인지 */
const preDeployChecks = (repo, appDir) => [
  { checkSource: repo, why: '저장소의 서버 폴더가 다 있고 링크가 없는지' },
  { checkAppDir: appDir, why: '사본 자리가 비었거나 이 도구가 만든 자리인지' },
];

export function planInstallServer({ envFile, dataDir, appDir, nodeSrc, tmpDir = os.tmpdir(), repo = REPO, platform = process.platform }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const xmlFile = p.join(tmpDir, 'wb-admin-server-task.xml');
  /* 작업 폴더는 설정 폴더 — 코드 사본을 작업 폴더로 잡으면 다음 restart-server 가 사본을 못 지운다 */
  const xml = taskXml({ nodeExe: APP_NODE(appDir), runScript: p.join(appDir, 'reading-server', 'tunnel', 'run-server.mjs'), envFile, workDir: dirOf(envFile) });
  const deploy = planDeployApp({ repo, appDir, nodeSrc });
  return [
    ...envGuard(envFile),
    ...dataSteps(dataDir),
    ...preDeployChecks(repo, appDir),
    ...pauseTask,
    ...deploy,
    { write: xmlFile, data: utf16leWithBom(xml), why: '작업 정의(UTF-16)' },
    /* /RU SYSTEM 을 같이 준다 — /XML 과 함께 쓸 수 있고(문서), XML 의 주체가 무시되더라도 SYSTEM 으로 못 박는다 */
    { run: ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlFile, '/RU', 'SYSTEM', '/F'], why: `작업 스케줄러에 ${TASK_NAME} 등록(부팅 + 5분마다 살아 있는지)` },
    { remove: xmlFile, why: '작업 정의 임시 파일 지우기' },
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '지금 바로 띄우기' },
    { note: `확인: schtasks /Query /TN ${TASK_NAME} /V /FO LIST — 실행 사용자 SYSTEM, 중지 시간 제한 없음` },
  ];
}

/* 다시 띄우기 — install-server 와 같은 검사(설정·자료 폴더 잠금)를 거쳐 새 코드를 복사한다 */
export function planRestartServer({ envFile, dataDir, appDir, nodeSrc, repo = REPO }) {
  const deploy = planDeployApp({ repo, appDir, nodeSrc });
  return [
    ...envGuard(envFile),
    ...dataSteps(dataDir),
    ...preDeployChecks(repo, appDir),
    ...pauseTask,
    ...deploy,
    { run: ['schtasks', '/Change', '/TN', TASK_NAME, '/ENABLE'], why: '작업 다시 켜기' },
    { run: ['schtasks', '/Run', '/TN', TASK_NAME], why: '다시 띄우기' },
  ];
}

/* 지우기 — 여러 번 돌려도 끝까지 간다(작업이 이미 없으면 1 — 괜찮다) */
export function planUninstallServer({ appDir }) {
  return [
    ...pauseTask,
    { run: ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'], why: '작업 지우기', okCodes: [0, 1] },
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
  if (step.copyNode) return `> 복사 ${step.copyNode.from} → ${step.copyNode.to}`;
  if (step.removeApp) return `> 코드 사본 지우기 ${step.removeApp}`;
  if (step.verifyAcl) return `> 권한 확인 ${step.verifyAcl}`;
  if (step.noLinks) return `> 링크 확인 ${step.noLinks}`;
  if (step.resetChildren) return `> icacls "${step.resetChildren}\\<안의 항목>" /reset /T /C /Q`;
  if (step.checkSource) return `> 원본 확인 ${step.checkSource}`;
  if (step.checkAppDir) return `> 사본 자리 확인 ${step.checkAppDir}`;
  return '';
};

export function execute(steps, { dryRun = false, runner = defaultRunner, out = console.log, ops = defaultOps } = {}) {
  let paused = false;
  try {
    runSteps(steps, { dryRun, runner, out, ops, onPause: () => { paused = true; } });
  } catch (e) {
    /* 작업을 끈 뒤에 멈췄으면 그렇다고 말한다 — 서버는 꺼져 있고 부팅·5분 자동 시작도 안 한다 */
    if (paused) e.message += `\n  ⚠ 작업 ${TASK_NAME} 을 꺼 둔 채 멈췄습니다(서버 꺼짐 · 부팅/5분 자동 시작 안 함) — 원인을 고친 뒤 setup.mjs restart-server`;
    throw e;
  }
}
function runSteps(steps, { dryRun, runner, out, ops, onPause }) {
  for (const step of steps) {
    if (step.note) { out('  · ' + step.note); continue; }
    out(`${dryRun ? '[할 일] ' : ''}${step.why ? step.why + '\n  ' : ''}${show(step)}`);
    if (dryRun) continue;
    if (step.mkdir) { fs.mkdirSync(step.mkdir, { recursive: true }); continue; }
    if (step.write) { fs.writeFileSync(step.write, step.data); continue; }
    if (step.remove) { fs.rmSync(step.remove, { force: true }); continue; }
    if (step.deployApp) { ops.deployApp(step.deployApp.from, step.deployApp.to); continue; }
    if (step.copyNode) { ops.copyNode(step.copyNode.from, step.copyNode.to); continue; }
    if (step.removeApp) { ops.removeApp(step.removeApp); continue; }
    if (step.verifyAcl) { ops.verifyAcl(step.verifyAcl, runner); continue; }
    if (step.noLinks) { ops.noLinks(step.noLinks); continue; }
    if (step.resetChildren) { ops.resetChildren(step.resetChildren, runner); continue; }
    if (step.checkSource) { ops.checkSource(step.checkSource); continue; }
    if (step.checkAppDir) { ops.checkAppDir(step.checkAppDir); continue; }
    if (step.run) {
      if (step.pause) onPause();
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
const quiet = (argv, opts = {}) => {
  const a = resolveArgv(argv);
  return spawnSync(a[0], a.slice(1), { encoding: 'utf8', windowsHide: true, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) });
};

/* 폴더 권한을 PowerShell 로 읽는다 — 이름이 아니라 SID 로(언어와 무관), 경로는 환경 변수로 넘긴다.
   남의 허용 항목이 남아 있으면 하나씩 지우고 다시 읽는다. 그래도 남으면 멈춘다. */
export function readAcl(target, run = quiet) {
  const r = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], { env: { WB_ACL_TARGET: target } });
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

/* 안에 이미 있던 항목의 따로 붙은 권한을 지운다 — 폴더 꼭대기만 잠그면, 누가 미리 넣어 둔 server.env·backups 에
   붙은 "Everyone 허용" 같은 권한이 그대로 남는다. 꼭대기를 먼저 잠근 뒤라 지운 항목은 관리자·SYSTEM 만 물려받는다. */
export function resetChildren(dir, runner = defaultRunner, { fsx = fs } = {}) {
  let entries = [];
  try { entries = fsx.readdirSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  for (const e of entries) {
    const code = runner(['icacls', path.join(dir, e), '/reset', '/T', '/C', '/Q']);
    if (code !== 0) throw new Error(`안의 항목 권한을 되돌리지 못했습니다(종료 코드 ${code}): ${path.join(dir, e)}`);
  }
}

/* 링크(심볼릭 링크·정션) 찾기 — Windows 의 정션은 권한 없이 만들 수 있고, Node 는 그것도 링크로 본다.
   target 자신과 그 위 폴더들(드라이브 뿌리 아래부터)도 본다: C:\ProgramData\WB 가 정션이면 잠금·확인이 그 너머에 걸린다. */
export function findLinks(target, { fsx = fs, ancestors = true, keep = () => true } = {}) {
  const found = [];
  const p = pathFor(target);
  const abs = p.resolve(target);
  if (ancestors) {
    const root = p.parse(abs).root;
    const parts = abs.slice(root.length).split(/[\\/]/).filter(Boolean);
    let cur = root;
    for (const part of parts) {
      cur = p.join(cur, part);
      try { if (fsx.lstatSync(cur).isSymbolicLink()) found.push(cur); } catch (e) { if (e && e.code === 'ENOENT') break; throw e; }
    }
  }
  const walk = (dir) => {
    let entries;
    try { entries = fsx.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    for (const ent of entries) {
      const full = p.join(dir, ent.name);
      if (!keep(full)) continue;
      const st = fsx.lstatSync(full);
      if (st.isSymbolicLink()) found.push(full);
      else if (st.isDirectory()) walk(full);
    }
  };
  try { if (!fsx.lstatSync(abs).isSymbolicLink()) walk(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
  return found;
}
export function noLinks(target, opts) {
  const links = findLinks(target, opts);
  if (links.length) throw new Error(`링크(심볼릭 링크·정션)가 있습니다 — 잠금·복사가 다른 폴더에 걸립니다. 지우고 다시 하세요: ${links.slice(0, 3).join(', ')}${links.length > 3 ? ' 외 ' + (links.length - 3) + '개' : ''}`);
}

/* 서버 코드의 지문 — 복사한 파일들의 경로·내용으로 만든 SHA-256. doctor 가 저장소와 사본이 같은지 본다
   (커밋 번호만 보면 커밋하지 않은 수정·되돌린 수정이 같다고 나온다). */
export function treeHash(root, { fsx = fs } = {}) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    const entries = fsx.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!appCopyKeep(rel)) continue;
      const st = fsx.lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else { h.update(rel + '\0'); h.update(fsx.readFileSync(full)); h.update('\0'); }
    }
  };
  for (const d of APP_DIRS) if (fsx.existsSync(path.join(root, d))) walk(path.join(root, d));
  return h.digest('hex');
}

/* 저장소의 서버 코드를 사본 자리로.
   - 원본 폴더가 다 있는지, 원본에 링크가 없는지 먼저 본다(지우기 전에 — 실패하면 기존 사본이 그대로 남는다)
   - 사본 표식(.wb-app-copy.json)을 맨 먼저 쓰고 맨 나중에 지운다 — 복사가 도중에 끊겨도 다음 실행이 우리 폴더로 알아본다
   - 표식 없는 폴더에 무언가 들어 있으면 지우지 않는다(잘못 적은 경로가 원장의 폴더를 지우지 않게) */
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
function clearApp(to, fsx) {
  for (const e of fsx.readdirSync(to)) if (e !== APP_MARKER) fsx.rmSync(path.join(to, e), RM);
}
export function checkSource(from, { fsx = fs } = {}) {
  for (const d of APP_DIRS) if (!fsx.existsSync(path.join(from, d))) throw new Error(`저장소에 ${d} 폴더가 없습니다 — 저장소 전체를 받았는지 확인하세요`);
  const links = APP_DIRS.flatMap((d) => findLinks(path.join(from, d), { fsx, ancestors: false, keep: (f) => appCopyKeep(path.relative(from, f)) })
    .concat(fsx.lstatSync(path.join(from, d)).isSymbolicLink() ? [path.join(from, d)] : []));
  if (links.length) throw new Error(`저장소에 링크(심볼릭 링크·정션)가 있어 복사하지 않습니다 — 사본이 저장소 밖을 가리키게 됩니다: ${links.slice(0, 3).join(', ')}`);
}
export function checkAppDir(to, { fsx = fs } = {}) {
  if (!fsx.existsSync(to)) return;
  const entries = fsx.readdirSync(to);
  if (entries.length && !entries.includes(APP_MARKER)) throw new Error(`코드 사본 자리에 다른 파일이 있습니다: ${to} — 빈 폴더이거나 이 도구가 만든 자리여야 합니다`);
}
export function deployApp(from, to, { fsx = fs } = {}) {
  /* 계획에서는 서버를 멈추기 전에 이미 봤지만(checkSource·checkAppDir), 그사이 바뀌었을 수 있어 한 번 더 */
  checkSource(from, { fsx });
  checkAppDir(to, { fsx });
  fsx.mkdirSync(to, { recursive: true });
  const marker = path.join(to, APP_MARKER);
  fsx.writeFileSync(marker, JSON.stringify({ from, complete: false, at: new Date().toISOString() }, null, 2));
  clearApp(to, fsx);
  for (const d of APP_DIRS) {
    fsx.cpSync(path.join(from, d), path.join(to, d), { recursive: true, filter: (s) => appCopyKeep(path.relative(from, s)) });
  }
  fsx.writeFileSync(path.join(to, APP_PKG), APP_PKG_BODY);
  fsx.writeFileSync(marker, JSON.stringify({ from, complete: true, commit: gitHead(from), hash: treeHash(to, { fsx }), at: new Date().toISOString() }, null, 2));
}
/* node.exe 를 사본 안으로 — 버전은 main 에서 확인했다 */
export function copyNode(from, to, { fsx = fs } = {}) {
  fsx.mkdirSync(path.dirname(to), { recursive: true });
  fsx.copyFileSync(from, to);
}
export function removeApp(to, { fsx = fs } = {}) {
  if (!fsx.existsSync(to)) return;
  /* 앞선 실행이 안을 다 지우고 마지막 폴더 지우기에서 멈춘 경우 — 빈 폴더는 잃을 것이 없다(비재귀로만 지운다) */
  if (fsx.readdirSync(to).length === 0) { fsx.rmdirSync(to); return; }
  if (!fsx.existsSync(path.join(to, APP_MARKER))) throw new Error(`이 도구가 만든 코드 사본이 아닙니다: ${to} — 지우지 않습니다`);
  clearApp(to, fsx);
  fsx.rmSync(path.join(to, APP_MARKER), RM);
  fsx.rmSync(to, RM);
}
/* 저장소의 지금 커밋 — git 이 없어도 읽히게 .git 을 직접 본다(못 읽으면 빈 값). 표시용일 뿐 판정은 treeHash 로 한다 */
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
const defaultOps = {
  deployApp: (f, t) => deployApp(f, t), copyNode: (f, t) => copyNode(f, t), removeApp: (t) => removeApp(t),
  verifyAcl: (d, r) => verifyAcl(d, r), noLinks: (d) => noLinks(d), resetChildren: (d, r) => resetChildren(d, r),
  checkSource: (d) => checkSource(d), checkAppDir: (d) => checkAppDir(d),
};

/* 관리자 권한인지 — 무결성 수준 SID 로 본다(언어와 무관): 높음 S-1-16-12288, 시스템 S-1-16-16384.
   UAC 아래 관리자 계정이라도 "관리자 권한으로 실행" 하지 않은 터미널은 중간(S-1-16-8192)이다.
   whoami 를 못 쓰는 경우에만 예전 방법(net session — 서버 서비스가 꺼져 있으면 틀릴 수 있다)으로 본다. */
export function isElevated(run = quiet) {
  const w = run(['whoami', '/groups', '/fo', 'csv', '/nh']);
  if (!w.error && w.status === 0 && w.stdout) return /S-1-16-(12288|16384)\b/.test(String(w.stdout));
  const r = run(['net', 'session']);
  return !r.error && r.status === 0;
}

export function findCloudflared({ exists = fs.existsSync, env = process.env } = {}) {
  return cloudflaredCandidates(env).find((c) => exists(c)) || '';
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
    repoHash = () => treeHash(REPO), exists = fs.existsSync, env = process.env,
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
    if (open.length) add('fail', 'LAN 차단', `${open.join(', ')}:${port} 로 열려 있습니다 — 터널을 거치지 않는 입구입니다. server.mjs 를 실행기 없이 직접 띄운 창이 있으면 닫고 restart-server`);
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
    /* 코드 사본 — 표식을 읽고, 저장소의 서버 코드 지문과 사본의 지문을 비교한다(커밋하지 않은 수정까지) */
    let marker = null;
    try { marker = readMarker(app); }
    catch (e) {
      const code = e && e.code;
      if (code === 'EACCES' || code === 'EPERM' || (!admin && code !== 'ENOENT')) add('warn', '코드 사본', `${app} 의 사본 표식을 읽지 못했습니다(관리자 터미널에서 다시)`);
      else if (e instanceof SyntaxError) add('fail', '코드 사본', `${app} 의 사본 표식이 깨졌습니다 — restart-server`);
      else add('fail', '코드 사본', `${app} 에 코드 사본이 없습니다 — install-server`);
    }
    if (marker) {
      if (!marker.complete) add('fail', '코드 사본', `${app} 의 복사가 끝나지 않았습니다(도중에 멈춤) — restart-server`);
      else {
        /* 비교를 실제로 마쳤을 때만 ✓ — 못 읽었거나 지문이 없으면 · (README: 이 줄이 경고하면 restart 전에 확인) */
        let rh = '';
        let herr = null;
        try { rh = repoHash(); } catch (e) { herr = e; }
        if (herr) add('warn', '코드 사본', `저장소의 서버 코드를 읽지 못해 사본과 비교하지 못했습니다(${(herr && herr.code) || 'error'}) — git pull·편집이 끝난 뒤 doctor 를 다시`);
        else if (!marker.hash) add('warn', '코드 사본', `${app} 의 사본 표식에 지문이 없습니다 — 바뀐 내용을 확인한 뒤 restart-server`);
        else if (rh !== marker.hash) add('warn', '코드 사본', `저장소의 서버 코드가 돌고 있는 사본과 다릅니다 — 바뀐 내용을 확인(git status·git log)한 뒤 restart-server`);
        else add('ok', '코드 사본', `${app}${marker.commit ? ' · ' + marker.commit.slice(0, 7) : ''}`);
      }
      if (marker.complete && !exists(pathFor(app).join(app, APP_PKG))) {
        add('fail', '코드 사본', `${app}\\package.json 이 없습니다 — 위쪽 폴더의 package.json 이 서버 모듈 형식을 바꿀 수 있습니다. restart-server`);
      }
      /* 작업이 실제로 돌리는 node(사본 안의 node.exe)의 버전 */
      const nodeExe = APP_NODE(app);
      const nv = run([nodeExe, '-p', 'process.versions.node']);
      const v = String((nv && nv.stdout) || '').trim();
      if (nv && !nv.error && nodeMajor(v) >= MIN_NODE_MAJOR) add('ok', 'Node.js (작업)', `${nodeExe} v${v}`);
      else add('fail', 'Node.js (작업)', `${nodeExe} ${v ? 'v' + v + ' — ' + MIN_NODE_MAJOR + ' 이상이 필요합니다' : '를 실행하지 못했습니다'} — Node 22 LTS 로 restart-server`);
    }

    /* 작업 상태 — 영어 열거값(Ready·Running·Disabled)이라 Windows 표시 언어와 무관하다 */
    const t = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State`]);
    const tstate = String((t && t.stdout) || '').trim();
    if (!tstate) add('fail', '작업 스케줄러', `${TASK_NAME} 이 없습니다 — install-server`);
    else if (tstate === 'Disabled') add('fail', '작업 스케줄러', `${TASK_NAME} 이 꺼져 있습니다(부팅·5분 자동 시작 안 함) — restart-server`);
    else add('ok', '작업 스케줄러', `${TASK_NAME} ${tstate}`);
    const s = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', '(Get-Service -Name cloudflared -ErrorAction SilentlyContinue).Status']);
    const status = String((s && s.stdout) || '').trim();
    if (status === 'Running') add('ok', 'cloudflared 서비스', '실행 중');
    else add('fail', 'cloudflared 서비스', status ? `상태 ${status} — 서비스 앱에서 Cloudflared 를 시작하세요` : '설치되지 않았습니다 — README 3단계(tunnel)');
    /* 서비스가 실제로 돌리는 파일 — Program Files 밖이면 일반 사용자가 바꿔 끼울 수 있고, 실행 줄에 토큰이 보이면
       옛 방식(레지스트리 평문)이다. 실행 줄은 토큰을 품을 수 있어 화면에 찍지 않는다. */
    if (status) {
      const pn = run(['powershell', '-NoProfile', '-NonInteractive', '-Command', "(Get-CimInstance Win32_Service -Filter \"Name='cloudflared'\").PathName"]);
      const line = String((pn && pn.stdout) || '').trim();
      const bin = ((/^"([^"]+)"/.exec(line) || /^(\S+?\.exe)\b/i.exec(line) || [])[1] || '').toLowerCase();
      const okBin = cloudflaredCandidates(env).some((c) => path.win32.normalize(c).toLowerCase() === path.win32.normalize(bin || ' ').toLowerCase());
      if (line && /--token(\s|=)/.test(line)) add('fail', 'cloudflared 서비스', '서비스 실행 줄에 토큰이 평문으로 있습니다(옛 설치) — cloudflared service uninstall 뒤 setup.mjs tunnel 로 다시, 그리고 대시보드에서 토큰 교체');
      else if (line && !okBin) add('fail', 'cloudflared 서비스', `서비스가 Program Files 밖의 cloudflared 를 돌립니다(${path.win32.dirname(bin)}) — cloudflared service uninstall 뒤 MSI 설치본으로 setup.mjs tunnel`);
    }
    const exe = findCloudflared({ exists, env });
    if (!exe) add('fail', 'cloudflared 설치', 'Program Files 아래에 cloudflared 가 없습니다 — README 2단계의 공식 설치 파일(MSI)로');
    else {
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
  if (/^\\\\|^\/\//.test(dir)) return '설정 폴더에 네트워크 경로(\\\\NAS\\…)를 쓰지 않습니다 — SYSTEM 이 못 읽습니다';
  if (inOneDrive(dir)) return '설정 폴더가 OneDrive 안입니다 — 비밀번호가 클라우드로 올라갑니다';
  if (isInside(envFile, repo, platform)) return '설정 파일이 저장소 안입니다 — 비밀번호가 커밋될 수 있습니다';
  if (isInside(repo, dir, platform)) return '설정 폴더가 저장소를 품고 있습니다 — 잠그면 저장소까지 잠깁니다';
  const shared = sharedFolderReason(dir, platform);
  if (shared) return `설정 폴더로 ${shared} 는 쓰지 않습니다`;
  const own = p.basename(envFile).toLowerCase();
  if (folderState(entries, (n) => ENV_DIR_OWN(n) || n.toLowerCase() === own) === 'foreign') return `${dir} 에 다른 파일이 있습니다 — 설정 전용 폴더(기본 C:\\ProgramData\\WB)를 쓰세요`;
  return '';
}
export function dataDirProblem({ dataDir, entries }) {
  if (folderState(entries, DATA_DIR_OWN) === 'foreign') return `${dataDir} 에 서버 것이 아닌 파일이 있습니다 — 관리자만 열리게 잠그는 폴더라 서버 전용 새 폴더여야 합니다(예: C:\\WB_server_data)`;
  return '';
}
/* 없으면 null. 읽지 못하면(권한 등) "비었다"로 치지 않고 멈춘다 — 무엇이 들었는지 모르는 폴더를 잠그지 않는다 */
const listDir = (d) => {
  try { return fs.readdirSync(d); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error(`${d} 를 읽지 못했습니다(${e && e.code}) — 관리자 터미널에서 다시 하세요`);
  }
};

/* install-server·restart-server 가 같이 쓰는 사전 점검 — 하나라도 틀리면 서버를 멈추기 전에 끝낸다 */
function preflight(envFile, { dryRun }) {
  const cfg = loadConfig(envFile);
  if (cfg.errors.length) throw new Error('설정 파일을 먼저 고치세요:\n  - ' + cfg.errors.join('\n  - '));
  const ep = envDirProblem({ envFile, entries: listDir(dirOf(envFile)), platform: isWinAbs(envFile) ? 'win32' : process.platform });
  if (ep) throw new Error(ep);
  const dp = dataDirProblem({ dataDir: cfg.dataDir, entries: listDir(cfg.dataDir) });
  if (dp) throw new Error(dp);
  if (!dryRun) {
    for (const [name, d] of [['설정 폴더', dirOf(envFile)], ['DATA_DIR', cfg.dataDir]]) {
      const dt = driveType(d);
      if (dt && dt !== 'Fixed') throw new Error(`${name}(${driveLetter(d)}:)는 ${dt} 드라이브입니다 — 서버(SYSTEM)에게 안 보이거나 빠질 수 있습니다. 이 PC 디스크로`);
    }
  }
  /* 작업은 사본 안의 node.exe 를 돌린다 — 지금 이 명령을 돌리는 node 를 실제 파일 경로로 풀어 복사한다
     (nvm 처럼 링크로 걸린 자리를 그대로 적으면 링크 너머가 바뀔 때 SYSTEM 이 그것을 돌린다) */
  if (nodeMajor(process.versions.node) < MIN_NODE_MAJOR) throw new Error(`Node ${process.versions.node} — ${MIN_NODE_MAJOR} 이상으로 이 명령을 실행하세요(그 node 가 사본에 들어간다)`);
  let nodeSrc = process.execPath;
  try { nodeSrc = fs.realpathSync.native(process.execPath); } catch { /* 그대로 */ }
  return { cfg, nodeSrc };
}

async function waitHealthy(cfg, envFile) {
  for (let i = 0; i < 45; i++) {
    try { if ((await fetch(`http://${LOOPBACK}:${cfg.port}/api/health`)).ok) { console.log(`\n서버가 떴습니다 ✓ http://${LOOPBACK}:${cfg.port}`); return 0; } } catch { /* 아직 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`\n45초 안에 서버가 응답하지 않았습니다 — 로그를 보세요(관리자 터미널에서 notepad): ${cfg.logDir} · ${path.join(dirOf(envFile), 'run-server-error.log')}`);
  return 1;
}

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
  if (inOneDrive(REPO) && /server$/.test(cmd || '')) console.log(`[주의] 저장소가 OneDrive 폴더 안입니다(${REPO}) — C:\\WB\\wb-site 처럼 밖에 두길 권합니다`);

  switch (cmd) {
    case 'env': {
      needWindowsAdmin();
      if (!envFile) throw new Error('--env <경로> 를 주세요');
      const problem = envDirProblem({ envFile, entries: listDir(dirOf(envFile)), platform: isWinAbs(envFile) ? 'win32' : process.platform });
      if (problem) throw new Error(problem);
      if (!dryRun) {
        const dt = driveType(dirOf(envFile));
        if (dt && dt !== 'Fixed') throw new Error(`설정 폴더(${driveLetter(envFile)}:)는 ${dt} 드라이브입니다 — 이 PC 디스크로`);
      }
      execute(planEnv({ envFile, fileExists: fs.existsSync(envFile), platform: isWinAbs(envFile) ? 'win32' : planPlatform }), { dryRun });
      return 0;
    }
    case 'install-server': {
      needWindowsAdmin();
      const { cfg, nodeSrc } = preflight(envFile, { dryRun });
      execute(planInstallServer({ envFile, dataDir: cfg.dataDir, appDir, nodeSrc, platform: planPlatform }), { dryRun });
      return dryRun ? 0 : waitHealthy(cfg, envFile);
    }
    case 'restart-server': {
      needWindowsAdmin();
      const { cfg, nodeSrc } = preflight(envFile, { dryRun });
      if (!dryRun && quiet(['schtasks', '/Query', '/TN', TASK_NAME]).status !== 0) throw new Error(`${TASK_NAME} 이 없습니다 — 처음이면 install-server`);
      execute(planRestartServer({ envFile, dataDir: cfg.dataDir, appDir, nodeSrc }), { dryRun });
      return dryRun ? 0 : waitHealthy(cfg, envFile);
    }
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
      const cloudflared = findCloudflared() || (dryRun ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' : '');
      if (!cloudflared) throw new Error('Program Files 아래에서 cloudflared 를 찾지 못했습니다 — README 2단계의 공식 설치 파일(cloudflared-windows-amd64.msi)로 먼저 설치하세요');
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
