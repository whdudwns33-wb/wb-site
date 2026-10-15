#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.test.mjs
 *
 * setup.mjs 는 Windows 에서 schtasks·icacls·PowerShell·cloudflared 를 부른다. CI(Linux)는 그것을 못 돌리므로
 * "무엇을 어떤 순서로 부르는가"(plan*)와 "점검이 무엇을 위험으로 잡는가"(doctor)를 가짜 실행기로 확인한다.
 * 특히 지키는 것:
 *  - 터널 토큰이 화면 출력·오류에 찍히지 않고, 옛 cloudflared 면 설치 전에 멈추고, Program Files 밖의 cloudflared 는 안 믿는다
 *  - 작업은 저장소가 아니라 관리자 전용 "코드 사본"(node.exe 까지 사본 안)을 SYSTEM 으로, 시간 제한 없이 돌린다
 *  - 설정·자료·사본 폴더를: 링크 확인 → 주인을 관리자로 → 관리자·SYSTEM 만 → 안의 항목 권한 초기화 → 다시 읽어 확인
 *  - 남의 파일이 든 폴더·저장소를 품은 폴더·사용자 폴더·네트워크 경로는 잠그지 않는다
 *  - 복사가 도중에 끊겨도 다음 실행이 끝까지 간다(표식을 먼저 쓰고 나중에 지운다), 지우기는 여러 번 돌려도 된다
 *  - 점검이 "Access 없이 열림"·"LAN 에 열림"·"학생 로그인이 열림"·"옛 cloudflared"·"권한 새는 폴더"·"낡은 사본" 을 잡는다
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planEnv, planInstallServer, planRestartServer, planUninstallServer, planDeployApp, planTunnel, readToken, execute, doctor, printDoctor,
  findCloudflared, cloudflaredCandidates, isElevated, envDirProblem, dataDirProblem, sysTool, verifyAcl, readAcl, deployApp, removeApp,
  lockSteps, resetChildren, findLinks, noLinks, treeHash, checkSource, checkAppDir,
} from './setup.mjs';
import { APP_DIRS, APP_MARKER } from './kit.mjs';

const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const ENVF = 'C:\\ProgramData\\WB\\server.env';
const ENVD = 'C:\\ProgramData\\WB';
const APP = 'C:\\ProgramData\\WB\\app';
const DATA = 'C:\\WB_server_data';
const REPO_W = 'C:\\WB\\wb-site';
const NODE_SRC = 'C:\\Program Files\\nodejs\\node.exe';
/* 누가 봐도 가짜인 값 — 진짜 토큰 모양(eyJ… base64 JSON)으로 두면 비밀 검사기가 진짜로 오인한다 */
const TOKEN = 'FAKE_TUNNEL_TOKEN_FOR_TESTS_ONLY_' + 'x'.repeat(80);
const isRun = (s, tool, dir) => s.run && s.run[0] === tool && (dir == null || s.run[1] === dir);
const idx = (steps, pred) => steps.findIndex(pred);

/* ── 잠금 순서 ── */
{
  const st = lockSteps('C:\\X', '시험');
  const order = st.map((s) => (s.noLinks ? 'noLinks' : s.resetChildren ? 'reset' : s.verifyAcl ? 'verify' : s.run && s.run.includes('/setowner') ? 'owner' : s.run && s.run.includes('/inheritance:r') ? 'grant' : '?'));
  eq(order, ['noLinks', 'owner', 'grant', 'reset', 'verify'], '잠금 순서가 링크 확인 → 주인 → 관리자·SYSTEM 만 → 안의 항목 초기화 → 확인 이 아니다');
  const own = st.find((s) => s.run && s.run.includes('/setowner'));
  eq(own.run.slice(1), ['C:\\X', '/setowner', '*S-1-5-32-544', '/T', '/C'], '주인을 관리자로 바꾸지 않는다 — 미리 폴더를 만든 일반 사용자가 주인으로 남는다');
  const grant = st.find((s) => s.run && s.run.includes('/inheritance:r'));
  ok(grant.run.some((a) => a.startsWith('*S-1-5-32-544:')) && grant.run.some((a) => a.startsWith('*S-1-5-18:')), 'SID 로 관리자·SYSTEM 을 주지 않는다(한국어 Windows 는 그룹 이름이 다를 수 있다)');
  ok(!grant.run.some((a) => /Users|Everyone|S-1-5-32-545|S-1-1-0|S-1-5-11/.test(a)), '일반 사용자·Everyone 에게 권한을 준다');
}

/* ── planEnv — 비밀을 쓰기 전에 잠근다, 있으면 내용은 두고 잠금만 다시 ── */
{
  const steps = planEnv({ envFile: ENVF, platform: 'win32' });
  const iGrant = idx(steps, (s) => s.run && s.run.includes('/inheritance:r'));
  const iWrite = idx(steps, (s) => s.write);
  ok(idx(steps, (s) => s.mkdir) < iGrant && iGrant < iWrite, '순서가 폴더 → 잠금 → 견본이 아니다 — 잠기기 전에 비밀 파일이 생긴다');
  ok(steps.findLastIndex((s) => s.verifyAcl === ENVD) > iWrite, '견본을 쓴 뒤 권한을 다시 확인하지 않는다');
  ok(/ADMIN_ID=\r\n/.test(steps[iWrite].data) && !/ADMIN_PASSWORD=\S/.test(steps[iWrite].data), '견본에 값이 채워져 있다');
  const again = planEnv({ envFile: ENVF, platform: 'win32', fileExists: true });
  ok(!again.some((s) => s.write), '이미 있는 설정 파일을 덮어쓴다 — 원장이 채운 비밀번호가 날아간다');
  ok(again.some((s) => s.run && s.run.includes('/inheritance:r')) && again.some((s) => s.resetChildren === ENVD), '설정 파일이 이미 있으면 잠금을 건너뛴다 — 누가 미리 넣은 server.env 의 권한이 남는다');
}

/* ── 설정·자료 폴더로 써도 되는가 ── */
{
  eq(envDirProblem({ envFile: ENVF, entries: null, repo: REPO_W, platform: 'win32' }), '', '기본 설정 자리를 거절했다');
  eq(envDirProblem({ envFile: ENVF, entries: ['server.env', 'app'], repo: REPO_W, platform: 'win32' }), '', '우리 것만 든 설정 폴더를 거절했다');
  ok(/저장소 안/.test(envDirProblem({ envFile: REPO_W + '\\server.env', entries: [], repo: REPO_W, platform: 'win32' })), '저장소 안 설정 파일을 받았다');
  ok(/품고/.test(envDirProblem({ envFile: 'C:\\WB\\server.env', entries: ['wb-site'], repo: REPO_W, platform: 'win32' })), '저장소를 품은 폴더를 설정 폴더로 받았다 — 잠그면 저장소가 잠긴다');
  ok(/사용자 폴더/.test(envDirProblem({ envFile: 'C:\\Users\\wb\\Desktop\\server.env', entries: [], repo: REPO_W, platform: 'win32' })), '바탕 화면을 설정 폴더로 받았다');
  ok(/다른 파일/.test(envDirProblem({ envFile: 'C:\\WBconf\\server.env', entries: ['메모.txt'], repo: REPO_W, platform: 'win32' })), '남의 파일이 든 폴더를 설정 폴더로 받았다');
  ok(/네트워크 경로/.test(envDirProblem({ envFile: '\\\\nas\\share\\server.env', entries: null, repo: REPO_W, platform: 'win32' })), 'NAS 를 설정 폴더로 받았다 — SYSTEM 이 못 읽는다');
  ok(/OneDrive/.test(envDirProblem({ envFile: 'C:\\Users\\wb\\OneDrive\\WB\\server.env', entries: null, repo: REPO_W, platform: 'win32' })), 'OneDrive 를 설정 폴더로 받았다');
  eq(envDirProblem({ envFile: 'C:\\ProgramData\\WB\\wb.env', entries: ['wb.env', 'app', 'run-server-error.log'], repo: REPO_W, platform: 'win32' }), '', '--env 로 준 다른 이름의 설정 파일을 "다른 파일" 로 봤다 — env 가 만든 파일을 install 이 거절한다');
  ok(envDirProblem({ envFile: 'C:\\ProgramData\\WB\\wb.env', entries: ['wb.env', '메모.txt'], repo: REPO_W, platform: 'win32' }), '다른 이름 설정 파일 옆의 남의 파일을 받았다');
  eq(dataDirProblem({ dataDir: DATA, entries: null }), '', '새 자료 폴더를 거절했다');
  eq(dataDirProblem({ dataDir: DATA, entries: ['db.json', 'backups', 'logs'] }), '', '서버 자료만 든 폴더(다시 설치)를 거절했다');
  ok(dataDirProblem({ dataDir: 'D:\\학원자료', entries: ['db.json', '수업.hwp'] }), '원장 파일이 든 폴더를 자료 폴더로 받았다 — 잠기면 원장이 못 연다');
}

/* ── planInstallServer — 사본(node 포함)을 돌린다 ── */
{
  const steps = planInstallServer({ envFile: ENVF, dataDir: DATA, appDir: APP, nodeSrc: NODE_SRC, tmpDir: 'C:\\Windows\\Temp', repo: REPO_W, platform: 'win32' });
  const w = steps.find((s) => s.write);
  ok(Buffer.isBuffer(w.data) && w.data[0] === 0xff && w.data[1] === 0xfe, '작업 정의가 UTF-16 LE BOM 이 아니다 — schtasks /XML 이 거절할 수 있다');
  const xml = w.data.slice(2).toString('utf16le');
  ok(/<UserId>S-1-5-18<\/UserId>/.test(xml), 'SYSTEM 으로 띄우지 않는다 — 로그인하지 않으면 서버가 안 뜬다');
  ok(/<BootTrigger>/.test(xml) && /<Interval>PT5M<\/Interval>/.test(xml) && /<MultipleInstancesPolicy>IgnoreNew</.test(xml), '부팅 + 5분 감시 + 중복 실행 방지가 없다');
  ok(/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/.test(xml), '실행 시간 제한이 남아 있다 — 기본 72시간이면 사흘째에 끊긴다');
  ok(/<DisallowStartIfOnBatteries>false</.test(xml) && /<StopIfGoingOnBatteries>false</.test(xml), '노트북 배터리에서 멈춘다');
  ok(xml.includes('<Command>C:\\ProgramData\\WB\\app\\node\\node.exe</Command>'), '작업이 사본 안의 node.exe 가 아닌 것을 돌린다 — 일반 사용자가 바꿀 수 있는 node 일 수 있다');
  ok(xml.includes('&quot;C:\\ProgramData\\WB\\app\\reading-server\\tunnel\\run-server.mjs&quot; --env &quot;C:\\ProgramData\\WB\\server.env&quot;'), '작업이 코드 사본의 실행기를 가리키지 않는다');
  ok(xml.includes('<WorkingDirectory>C:\\ProgramData\\WB</WorkingDirectory>'), '작업 폴더가 설정 폴더가 아니다 — 사본을 작업 폴더로 잡으면 다음 restart-server 가 사본을 못 지운다');
  ok(!xml.includes(REPO_W), '작업이 저장소(일반 사용자가 고칠 수 있는 자리)의 코드를 SYSTEM 으로 돌린다');
  ok(/<Priority>5<\/Priority>/.test(xml), '우선순위가 보통(5)이 아니다');
  const cnt = Number((/<Count>(\d+)<\/Count>/.exec(xml) || [])[1]);
  ok(cnt >= 1 && cnt <= 255, `RestartOnFailure Count 가 스키마 범위(1~255) 밖이다: ${cnt}`);
  const tt = (/<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml) || [])[1] || '';
  ok(tt.indexOf('<Enabled>') < tt.indexOf('<StartBoundary>') && tt.indexOf('<StartBoundary>') < tt.indexOf('<Repetition>'), '트리거 안 순서가 스키마와 다르다');
  const create = steps.find((s) => isRun(s, 'schtasks') && s.run[1] === '/Create');
  eq(create.run.slice(1), ['/Create', '/TN', 'WB-Admin-Server', '/XML', 'C:\\Windows\\Temp\\wb-admin-server-task.xml', '/RU', 'SYSTEM', '/F'], 'schtasks /Create 인자');
  ok(steps[0].noLinks === ENVD && steps[1].verifyAcl === ENVD, '설정 폴더가 잠겨 있는지 먼저 보지 않는다 — 손으로 만든 server.env 가 열린 채로 남는다');
  const iDisable = idx(steps, (s) => isRun(s, 'schtasks') && s.run[1] === '/Change' && s.run.includes('/DISABLE'));
  const iEnd = idx(steps, (s) => isRun(s, 'schtasks') && s.run[1] === '/End');
  const iDeploy = idx(steps, (s) => s.deployApp);
  ok(iDisable >= 0 && iDisable < iEnd && iEnd < iDeploy, '사본을 바꾸기 전에 작업을 끄고 멈추지 않는다 — 5분 감시가 복사 도중에 띄운다');
  /* 거절할 수 있는 검사는 모두 작업을 끄기 전에 — 뒤에서 실패하면 서버가 꺼진 채 남는다 */
  for (const [name, pred] of [['원본 확인', (s) => s.checkSource === REPO_W], ['사본 자리 확인', (s) => s.checkAppDir === APP], ['자료 폴더 잠금 확인', (s) => s.verifyAcl === DATA], ['자료 폴더 링크', (s) => s.noLinks === DATA]]) {
    const i = idx(steps, pred);
    ok(i >= 0 && i < iDisable, `${name}을(를) 작업을 끈 뒤에 한다 — 거기서 실패하면 서버가 꺼진 채 남는다`);
  }
  ok(idx(steps, (s) => s.copyNode) > iDeploy && steps.find((s) => s.copyNode).copyNode.to === 'C:\\ProgramData\\WB\\app\\node\\node.exe', 'node.exe 를 사본 안으로 복사하지 않는다');
  const iAppGrant = idx(steps, (s) => s.run && s.run.includes('/inheritance:r') && s.run[1] === APP);
  ok(iAppGrant > idx(steps, (s) => s.copyNode) && iAppGrant < steps.indexOf(create), '사본(node 포함)을 다 넣은 뒤 잠그고 그다음 작업을 등록해야 한다');
  ok(steps.some((s) => s.verifyAcl === APP) && steps.some((s) => s.verifyAcl === DATA) && steps.some((s) => s.resetChildren === DATA), '사본·자료 폴더의 권한을 초기화·확인하지 않는다');
  ok(idx(steps, (s) => s.remove) > steps.indexOf(create), '등록하기 전에 작업 정의를 지운다');
  const runs = steps.filter((s) => s.run);
  ok(runs[runs.length - 1].run[1] === '/Run', '등록 뒤 바로 띄우지 않는다');
}

/* ── 저장소와 사본이 겹치면 시작하지 않는다(사본 안에서 setup.mjs 를 돌린 경우) ── */
{
  ok(throwsWith(() => planDeployApp({ repo: APP, appDir: APP }), /겹칩니다/), '사본 안에서 돌린 setup 이 자기 원본을 지우게 둔다');
  ok(throwsWith(() => planDeployApp({ repo: 'C:\\WB', appDir: 'C:\\WB\\app' }), /겹칩니다/), '저장소 안에 사본을 만든다');
  ok(throwsWith(() => planInstallServer({ envFile: ENVF, dataDir: DATA, appDir: APP, nodeSrc: NODE_SRC, repo: APP, platform: 'win32' }), /겹칩니다/), '겹칠 때 install 할 일 목록을 만들어 낸다(서버를 멈춘 뒤에 실패한다)');
}

/* ── 다시 띄우기·지우기 ── */
{
  const r = planRestartServer({ envFile: ENVF, dataDir: DATA, appDir: APP, nodeSrc: NODE_SRC, repo: REPO_W });
  ok(r[0].noLinks === ENVD && r[1].verifyAcl === ENVD, 'restart-server 가 설정 폴더 잠금을 보지 않는다');
  const rDisable = idx(r, (s) => isRun(s, 'schtasks') && s.run.includes('/DISABLE'));
  ok(idx(r, (s) => s.checkSource) < rDisable && idx(r, (s) => s.checkAppDir) < rDisable && idx(r, (s) => s.verifyAcl === DATA) < rDisable, 'restart-server 가 거절할 수 있는 검사를 작업을 끈 뒤에 한다');
  ok(r.some((s) => s.resetChildren === DATA && true) && r.some((s) => s.verifyAcl === DATA), 'restart-server 가 자료 폴더를 잠그지 않는다 — DATA_DIR 을 바꾸면 새 폴더가 열린 채로 생긴다');
  ok(r.some((s) => s.deployApp) && r.some((s) => s.copyNode), 'restart-server 가 새 코드·node 를 복사하지 않는다');
  const iEnable = idx(r, (s) => isRun(s, 'schtasks') && s.run.includes('/ENABLE'));
  ok(iEnable > idx(r, (s) => s.verifyAcl === APP) && r[r.length - 1].run[1] === '/Run', '작업을 다시 켜고 띄우지 않는다(또는 사본을 잠그기 전에 켠다)');
  const u = planUninstallServer({ appDir: APP });
  const del = u.find((s) => isRun(s, 'schtasks') && s.run[1] === '/Delete');
  ok(del && del.run.includes('/F') && del.okCodes.includes(1), '이미 지운 작업에서 멈춘다 — 다시 돌린 uninstall 이 사본을 못 지운다');
  ok(u.some((s) => s.removeApp === APP), '코드 사본을 남긴다');
  ok(!u.some((s) => s.remove || (s.run && /rmdir|del/i.test(s.run[0]))), '지우기가 자료·설정 파일까지 지운다');
}

/* ── 시스템 도구는 전체 경로로, cloudflared 는 Program Files 만 ── */
{
  eq(sysTool('icacls', 'win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\icacls.exe', 'icacls 를 이름만으로 부른다 — 지금 폴더의 가짜 icacls.exe 가 먼저 잡힌다');
  eq(sysTool('powershell', 'win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell 경로');
  eq(sysTool('icacls', 'linux', {}), 'icacls', 'Windows 가 아니면 그대로');
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  eq(cloudflaredCandidates(env), ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'], 'cloudflared 후보가 Program Files 두 자리가 아니다');
  ok(!cloudflaredCandidates(env).some((c) => /^C:\\Cloudflared/i.test(c)), 'C:\\ 바로 아래(일반 사용자가 만들 수 있는 자리)의 cloudflared 를 믿는다');
  eq(findCloudflared({ env, exists: (p) => p.includes('(x86)') }), 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', '설치 자리를 못 찾는다');
  eq(findCloudflared({ env, exists: () => false }), '', 'Program Files 밖의 cloudflared 를 찾아냈다 — 토큰을 넘기고 SYSTEM 서비스로 등록된다');
}

/* ── 터널 토큰 ── */
{
  eq(readToken(TOKEN + '\r\n'), TOKEN, '토큰만 붙여 넣은 파일');
  eq(readToken(`cloudflared.exe service install ${TOKEN}`), TOKEN, '대시보드 명령을 통째로 붙여 넣은 파일');
  ok(throwsWith(() => readToken('여기에 토큰'), /찾지 못했습니다/), '토큰이 아닌 내용을 받았다');
  for (const vt of ['cloudflared version 2026.7.2', '']) {
    let msg = '';
    let ran = false;
    try { execute(planTunnel({ cloudflared: 'cf.exe', token: TOKEN, versionText: vt, tokenFile: 'C:\\ProgramData\\WB\\tunnel-token.txt' }), { runner: () => { ran = true; return 0; }, out: () => {} }); } catch (e) { msg = e.message; }
    ok(/2026\.7\.3/.test(msg) && !ran, `옛(또는 알 수 없는) cloudflared(${vt || '빈 값'})로 서비스를 설치했다 — 토큰이 레지스트리에 평문으로 남는다`);
    ok(!msg.includes(TOKEN), '오류에 토큰이 실렸다');
  }
  const lines = [];
  execute(planTunnel({ cloudflared: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', token: TOKEN, dryRun: true }), { dryRun: true, out: (l) => lines.push(l) });
  ok(!lines.join('\n').includes(TOKEN) && /<토큰 숨김>/.test(lines.join('\n')), '화면 출력에 터널 토큰이 찍혔다');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-tok-'));
  const tf = path.join(tmp, 'tunnel-token.txt');
  fs.writeFileSync(tf, TOKEN);
  let argv = null;
  execute(planTunnel({ cloudflared: 'cf.exe', token: TOKEN, versionText: 'cloudflared version 2026.10.0', tokenFile: tf }), { runner: (a) => { argv = a; return 0; }, out: () => {} });
  eq(argv, ['cf.exe', 'service', 'install', TOKEN], '실제 실행 인자');
  ok(!fs.existsSync(tf), '설치가 끝났는데 토큰 파일을 남겼다');
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── execute ── */
{
  let called = 0;
  const count = () => { called++; };
  execute([{ run: ['schtasks', '/Run'] }, { deployApp: { from: 'a', to: 'b' } }, { copyNode: { from: 'a', to: 'b' } }, { verifyAcl: 'x' }, { noLinks: 'x' }, { resetChildren: 'x' }], {
    dryRun: true, runner: () => { called++; return 0; }, out: () => {},
    ops: { deployApp: count, copyNode: count, removeApp: count, verifyAcl: count, noLinks: count, resetChildren: count },
  });
  ok(called === 0, '--dry-run 인데 무언가 실행했다');
  ok(throwsWith(() => execute([{ run: ['schtasks', '/Create'], why: '등록' }], { runner: () => 1, out: () => {} }), /종료 코드 1/), '실패한 명령을 그냥 넘어갔다');
  let ran = 0;
  execute([{ run: ['schtasks', '/End'], okCodes: [0, 1] }, { run: ['x'] }], { runner: () => { ran++; return ran === 1 ? 1 : 0; }, out: () => {} });
  ok(ran === 2, 'okCodes 에 있는 종료 코드에서 멈췄다');
}

/* ── 작업을 끈 뒤에 실패하면 그렇다고 말한다 ── */
{
  const plan = planRestartServer({ envFile: ENVF, dataDir: DATA, appDir: APP, nodeSrc: NODE_SRC, repo: REPO_W });
  const noop = () => {};
  const okOps = { mkdir: noop, write: noop, remove: noop, deployApp: noop, copyNode: noop, removeApp: noop, verifyAcl: noop, noLinks: noop, resetChildren: noop, checkSource: noop, checkAppDir: noop };
  let msg = '';
  try { execute(plan, { runner: () => 0, out: noop, ops: { ...okOps, deployApp: () => { throw new Error('EBUSY'); } } }); } catch (e) { msg = e.message; }
  ok(/꺼 둔 채/.test(msg) && /restart-server/.test(msg), '작업을 끈 뒤에 실패했는데 서버가 꺼진 채라는 것을 알리지 않는다');
  msg = '';
  try { execute(plan, { runner: () => 0, out: noop, ops: { ...okOps, checkSource: () => { throw new Error('링크'); } } }); } catch (e) { msg = e.message; }
  ok(msg && !/꺼 둔 채/.test(msg), '작업을 끄기 전의 실패인데 꺼 뒀다고 말한다');
  /* Linux 에서 'C:\\…' 는 상대 경로다 — 가짜 ops 를 줬는데도 디스크에 만들면 저장소 맨 위에 그 이름의 폴더가
     생기고 docs-sync(최상위 폴더 지도)가 병렬 순서에 따라 가끔 빨간다 */
  ok(!fs.existsSync(DATA) && !fs.existsSync(ENVF), '가짜 ops 로 돌렸는데 자료·설정 폴더를 실제 디스크(현재 폴더)에 만들었다');
}

/* ── 권한 확인 — 경로는 환경 변수로, 남은 권한은 지우고, 그래도 남으면 멈춘다 ── */
{
  const goodAcl = 'OWNER|S-1-5-32-544\nACE|S-1-5-32-544|Allow|2032127|False\nACE|S-1-5-18|Allow|2032127|False';
  const leaky = goodAcl + '\nACE|S-1-5-21-9-9-9-1001|Allow|1245631|False';
  let seen = null;
  readAcl('C:\\WB’s data', (argv, opts) => { seen = { argv, opts }; return { stdout: goodAcl }; });
  ok(seen && seen.opts && seen.opts.env && seen.opts.env.WB_ACL_TARGET === 'C:\\WB’s data', '권한 확인 대상 경로를 환경 변수로 넘기지 않는다');
  ok(seen && !seen.argv.join(' ').includes('WB’s'), '경로가 PowerShell 명령 글자에 들어갔다 — ’ 같은 문자로 명령을 끼울 수 있다');
  let reads = 0;
  const removed = [];
  verifyAcl(DATA, (argv) => { removed.push(argv.join(' ')); return 0; }, () => ({ stdout: reads++ === 0 ? leaky : goodAcl }));
  ok(removed.some((c) => /\/remove:g \*S-1-5-21-9-9-9-1001/.test(c)), '남은 사용자 권한을 지우지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: leaky })), /잠그지 못했습니다/), '지워도 남는 권한이 있는데 멈추지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: 'OWNER|S-1-5-21-1-1-1-1000\nACE|S-1-5-32-544|Allow|1|False' })), /잠그지 못했습니다/), '주인이 일반 사용자인데 멈추지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: '' })), /읽지 못했습니다/), '권한을 못 읽었는데 잠긴 것으로 봤다');
}

/* ── 안의 항목 권한 초기화·링크 (실제 파일로) ── */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-lock-'));
  fs.writeFileSync(path.join(tmp, 'server.env'), 'x');
  fs.mkdirSync(path.join(tmp, 'backups'));
  const calls = [];
  resetChildren(tmp, (argv) => { calls.push(argv); return 0; });
  eq(calls.map((a) => [path.basename(a[1]), ...a.slice(2)]).sort(), [['backups', '/reset', '/T', '/C', '/Q'], ['server.env', '/reset', '/T', '/C', '/Q']], '안에 미리 있던 항목의 따로 붙은 권한을 지우지 않는다 — 누가 넣어 둔 server.env 가 계속 열린다');
  ok(throwsWith(() => resetChildren(tmp, () => 5), /되돌리지 못했습니다/), '권한 초기화 실패를 그냥 넘어갔다');
  resetChildren(path.join(tmp, 'none'), () => { throw new Error('불렸다'); });

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-out-'));
  fs.symlinkSync(outside, path.join(tmp, 'backups', 'link'), 'dir');
  ok(findLinks(tmp, { ancestors: false }).some((l) => l.endsWith('link')), '폴더 안의 링크를 찾지 못한다');
  ok(throwsWith(() => noLinks(tmp, { ancestors: false }), /링크/), '링크가 있는데 잠금을 계속한다 — icacls 가 링크 너머 폴더에 걸린다');
  const jn = path.join(tmp, 'junction-dir');
  fs.symlinkSync(outside, jn, 'dir');
  ok(findLinks(path.join(jn, 'sub')).includes(jn), '대상 경로 위쪽의 링크(정션)를 찾지 못한다 — C:\\ProgramData\\WB 가 정션이면 잠금이 다른 곳에 걸린다');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

/* ── 코드 사본 (실제 파일로) ── */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-app-'));
  const src = path.join(tmp, 'repo');
  for (const d of APP_DIRS) { fs.mkdirSync(path.join(src, d), { recursive: true }); fs.writeFileSync(path.join(src, d, 'a.txt'), d); }
  fs.mkdirSync(path.join(src, 'reading-server', 'data'), { recursive: true });
  fs.writeFileSync(path.join(src, 'reading-server', 'data', 'db.json'), '{"students":{}}');
  fs.mkdirSync(path.join(src, 'workbench'), { recursive: true });
  fs.writeFileSync(path.join(src, 'workbench', 'secret.json'), 'x');
  const to = path.join(tmp, 'app');
  deployApp(src, to);
  ok(APP_DIRS.every((d) => fs.existsSync(path.join(to, d, 'a.txt'))), '서버에 필요한 폴더를 다 복사하지 않았다');
  ok(!fs.existsSync(path.join(to, 'reading-server', 'data')), '로컬 학생 기록(reading-server/data)까지 사본에 넣었다');
  ok(!fs.existsSync(path.join(to, 'workbench')), '서버와 무관한 폴더까지 복사했다');
  const m = JSON.parse(fs.readFileSync(path.join(to, APP_MARKER), 'utf8'));
  ok(m.complete === true && /^[0-9a-f]{64}$/.test(m.hash), '사본 표식에 완료·지문이 없다');
  eq(m.hash, treeHash(src), '사본 지문이 저장소 지문과 다르다(같은 내용인데)');
  eq(fs.readFileSync(path.join(to, 'package.json'), 'utf8').trim(), '{"type":"commonjs"}', '사본 뿌리에 package.json(commonjs)이 없다 — 위쪽 폴더의 package.json 이 모듈 형식을 바꿀 수 있다');
  fs.writeFileSync(path.join(src, 'reading', 'a.txt'), 'changed');
  ok(treeHash(src) !== m.hash, '커밋하지 않은 수정을 지문이 잡지 못한다');
  fs.writeFileSync(path.join(to, 'reading', 'stale.txt'), 'old');
  deployApp(src, to);
  ok(!fs.existsSync(path.join(to, 'reading', 'stale.txt')), '다시 복사할 때 저장소에서 지운 파일이 사본에 남는다');

  /* 저장소에 링크가 있으면 복사하지 않는다 — 사본이 일반 사용자 폴더를 가리키게 된다 */
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wbr-evil-'));
  fs.symlinkSync(outside, path.join(src, 'letter', 'img'), 'dir');
  ok(throwsWith(() => deployApp(src, to), /링크/), '저장소의 링크(정션)를 사본으로 옮겼다 — SYSTEM 이 일반 사용자 폴더의 코드를 읽는다');
  ok(fs.existsSync(path.join(to, 'reading', 'a.txt')), '링크 때문에 거절하면서 기존 사본을 지웠다 — 지우기 전에 검사해야 한다');
  fs.rmSync(path.join(src, 'letter', 'img'));

  /* 도중에 끊긴 복사 — 표식이 남아 다음 실행이 끝까지 간다 */
  let n = 0;
  const flaky = { ...fs, cpSync: (...a) => { if (++n === 3) throw new Error('EBUSY'); return fs.cpSync(...a); } };
  ok(throwsWith(() => deployApp(src, to, { fsx: flaky }), /EBUSY/), '시험용 실패가 일어나지 않았다');
  const half = JSON.parse(fs.readFileSync(path.join(to, APP_MARKER), 'utf8'));
  ok(half.complete === false, '도중에 끊긴 사본이 완료로 보인다');
  deployApp(src, to);
  ok(JSON.parse(fs.readFileSync(path.join(to, APP_MARKER), 'utf8')).complete === true, '도중에 끊긴 사본을 다음 실행이 고치지 못한다(영구히 막힘)');

  const foreign = path.join(tmp, 'mine');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, '중요.hwp'), 'x');
  ok(throwsWith(() => deployApp(src, foreign), /다른 파일/), '표식 없는 남의 폴더를 지우고 덮어썼다');
  ok(fs.existsSync(path.join(foreign, '중요.hwp')), '남의 파일이 지워졌다');
  ok(throwsWith(() => removeApp(foreign), /만든 코드 사본이 아닙니다/), '표식 없는 폴더를 지웠다');
  /* 지우기가 도중에 끊겨도 다시 돌리면 끝까지 — 표식은 맨 나중에 지운다 */
  let k = 0;
  const flakyRm = { ...fs, rmSync: (p, o) => { if (++k === 2) throw new Error('EBUSY'); return fs.rmSync(p, o); } };
  ok(throwsWith(() => removeApp(to, { fsx: flakyRm }), /EBUSY/), '시험용 실패가 일어나지 않았다(지우기)');
  ok(fs.existsSync(path.join(to, APP_MARKER)), '지우기 도중에 표식부터 지웠다 — 다시 돌린 uninstall 이 남은 사본을 못 지운다');
  removeApp(to);
  ok(!fs.existsSync(to), '코드 사본을 지우지 못했다');
  fs.mkdirSync(to);
  removeApp(to);
  ok(!fs.existsSync(to), '앞선 지우기가 남긴 빈 폴더(표식 없음)를 지우지 못한다 — uninstall 을 다시 돌려도 끝나지 않는다');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

/* ── 관리자 권한 판정 ── */
{
  const who = (out) => (argv) => (argv[0] === 'whoami' ? { status: 0, stdout: out } : { status: 2, stdout: '' });
  ok(isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","필수 그룹"\r\n"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""')), '높은 무결성(S-1-16-12288)을 관리자 권한으로 보지 않는다');
  ok(!isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","거부 전용 그룹"\r\n"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""')), 'UAC 로 걸러진(중간 무결성) 터미널을 관리자 권한으로 봤다');
  ok(isElevated((argv) => (argv[0] === 'whoami' ? { error: new Error('ENOENT') } : { status: 0 })), 'whoami 가 없을 때 net session 으로 넘어가지 않는다');
}

/* ── doctor (가짜 실행기·가짜 fetch) ── */
const res = (status, headers = {}, body = '') => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
const GOOD_ACL = 'OWNER|S-1-5-32-544\r\nACE|S-1-5-32-544|Allow|2032127|False\r\nACE|S-1-5-18|Allow|2032127|False\r\n';
const HASH = 'a'.repeat(64);
function fakeDeps(over = {}) {
  const cfg = { errors: [], warnings: [], port: 8890, dataDir: DATA, logDir: DATA + '\\logs', publicHost: 'wb.example.com' };
  const routes = {
    'http://127.0.0.1:8890/api/health': res(200, { 'x-robots-tag': 'noindex, nofollow' }),
    'http://127.0.0.1:8890/api/login': res(403),
    'http://127.0.0.1:20241/ready': res(200),
    'https://wb.example.com/': res(302, { location: 'https://wbteam.cloudflareaccess.com/cdn-cgi/access/login/wb.example.com?kid=a&redirect_url=%2F' }),
    'https://wb.example.com/admin/': res(302, { location: 'https://wbteam.cloudflareaccess.com/cdn-cgi/access/login/wb.example.com?kid=a&redirect_url=%2Fadmin%2F' }),
    ...(over.routes || {}),
  };
  const ps = { acl: GOOD_ACL, drive: 'Fixed\r\n', service: 'Running\r\n', task: 'Ready\r\n', svcPath: '"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" tunnel run --token-file C:\\ProgramData\\cloudflared\\token\r\n', ...(over.ps || {}) };
  const runOut = {
    schtasks: { status: 0, stdout: '' },
    whoami: { status: 0, stdout: '"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""' },
    cloudflared: { status: 0, stdout: 'cloudflared version 2026.10.0 (built 2026-10-01)' },
    appnode: { status: 0, stdout: '22.11.0\n' },
    ...(over.run || {}),
  };
  return {
    platform: 'win32',
    nodeVersion: over.nodeVersion || '22.11.0',
    load: () => ({ ...cfg, ...(over.cfg || {}) }),
    interfaces: { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.0.10' }] },
    connect: async (host) => (over.lanOpen ? host === '192.168.0.10' : false),
    readMarker: over.readMarker || (() => ({ complete: true, commit: 'abc1234def', hash: HASH })),
    repoHash: over.repoHash || (() => HASH),
    exists: over.exists || ((p) => p === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' || p === APP + '\\package.json'),
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    run: (argv, opts) => {
      if (argv[0] === 'powershell') {
        const c = argv[argv.length - 1];
        if (/Get-Acl/.test(c)) return { status: 0, stdout: typeof ps.acl === 'function' ? ps.acl((opts && opts.env && opts.env.WB_ACL_TARGET) || '') : ps.acl };
        if (/DriveInfo/.test(c)) return { status: 0, stdout: ps.drive };
        if (/Get-Service/.test(c)) return { status: 0, stdout: ps.service };
        if (/Get-ScheduledTask/.test(c)) return { status: 0, stdout: ps.task };
        if (/Win32_Service/.test(c)) return { status: 0, stdout: ps.svcPath };
      }
      if (/app\\node\\node\.exe$/.test(argv[0])) return runOut.appnode;
      const key = /cloudflared/i.test(argv[0]) ? 'cloudflared' : argv[0];
      return runOut[key] || { status: 1, stdout: '' };
    },
    /* 진짜 fetch 처럼 — redirect 를 'manual' 로 주지 않으면 3xx 를 따라가 Access 로그인 화면(200)을 받는다 */
    fetchFn: async (url, init = {}) => {
      if (!(url in routes)) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
      const r = routes[url];
      if (r instanceof Error) throw r;
      if (r.status >= 300 && r.status < 400 && init.redirect !== 'manual') return res(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }, '<html>login</html>');
      return r;
    },
  };
}
const level = (rs, name) => (rs.find((r) => r.name === name) || {}).level;
const fails = (rs) => rs.filter((r) => r.level === 'fail').map((r) => r.name);
/* 같은 이름의 줄이 여럿일 수 있다(예: 서비스 실행 중 ✓ + 실행 파일 자리 ✗) — 하나라도 ✗ 인가 */
const anyFail = (rs, name) => rs.some((r) => r.name === name && r.level === 'fail');
const run = (over) => doctor({ envFile: ENVF, appDir: APP }, fakeDeps(over));
{
  const good = await run();
  eq(fails(good), [], '정상 설치인데 실패가 나왔다');
  eq(good.filter((r) => r.level === 'warn').map((r) => r.name), [], '정상 설치인데 · 가 나왔다 — README 는 "✗ 없음 + 바깥 주소 ✓" 를 말한다');
  for (const n of ['바깥 주소 /admin/', '터널 연결', '관리자 권한', '권한: 자료 폴더', 'cloudflared 버전', '코드 사본', 'Node.js (작업)']) eq(level(good, n), 'ok', `정상 설치의 "${n}" 줄이 ✓ 가 아니다`);

  const exposed = await run({ routes: { 'https://wb.example.com/admin/': res(200, { 'x-robots-tag': 'noindex' }) } });
  const ex = exposed.find((r) => r.name === '바깥 주소 /admin/');
  ok(ex.level === 'fail' && /위험/.test(ex.msg), 'Access 없이 열린 /admin/ 을 위험으로 잡지 못한다');
  for (const st of [200, 401]) eq(level(await run({ routes: { 'http://127.0.0.1:8890/api/login': res(st) } }), '관리 전용'), 'fail', `학생 로그인이 ${st} 인 서버를 통과시켰다`);
  eq(level(await run({ lanOpen: true }), 'LAN 차단'), 'fail', 'LAN 에 열린 서버를 통과시켰다');
  eq(level(await run({ routes: { 'http://127.0.0.1:8890/api/health': new TypeError('fetch failed') } }), '로컬 서버'), 'fail', '서버가 안 떠 있는데 통과시켰다');
  eq(level(await run({ run: { cloudflared: { status: 0, stdout: 'cloudflared version 2025.11.1' } } }), 'cloudflared 버전'), 'fail', '토큰을 레지스트리에 남기는 옛 cloudflared 를 통과시켰다');
  eq(level(await run({ exists: () => false }), 'cloudflared 설치'), 'fail', 'Program Files 에 cloudflared 가 없는데 알려주지 않는다');
  const noSvc = await run({ ps: { service: '', task: '' } });
  eq(level(noSvc, 'cloudflared 서비스'), 'fail', '설치되지 않은 cloudflared 서비스를 통과시켰다');
  eq(level(noSvc, '작업 스케줄러'), 'fail', '등록되지 않은 작업을 통과시켰다');
  eq(level(await run({ routes: { 'http://127.0.0.1:20241/ready': res(503) } }), '터널 연결'), 'fail', '/ready 503 을 통과시켰다');
  eq(level(await run({ cfg: { errors: ['DATA_DIR 이 비어 있습니다'] } }), '설정 파일'), 'fail', '틀린 설정 파일을 통과시켰다');
  eq(level(await run({ nodeVersion: '20.11.0' }), 'Node.js'), 'fail', 'Node 20 을 통과시켰다');
  eq(level(await run({ run: { appnode: { status: 0, stdout: '18.20.4' } } }), 'Node.js (작업)'), 'fail', '작업이 돌리는 node 가 18 인데 통과시켰다');
  eq(level(await run({ run: { appnode: { error: new Error('ENOENT') } } }), 'Node.js (작업)'), 'fail', '작업이 돌리는 node 가 없는데 통과시켰다');
  eq(level(await run({ cfg: { publicHost: '' } }), '바깥 주소'), 'fail', '바깥 주소가 없는데 실패로 잡지 않는다 — "전부 통과" 로 끝난다');

  const leakAcl = await run({ ps: { acl: (t) => (t === DATA ? GOOD_ACL + 'ACE|S-1-5-32-545|Allow|1179817|True\r\n' : GOOD_ACL) } });
  eq(level(leakAcl, '권한: 자료 폴더'), 'fail', '일반 사용자가 읽을 수 있는 자료 폴더를 통과시켰다');
  eq(level(leakAcl, '권한: 설정 폴더'), 'ok', '잠긴 설정 폴더를 실패로 봤다');
  eq(level(await run({ ps: { drive: 'Network\r\n' } }), '자료 드라이브'), 'fail', '네트워크 드라이브의 자료 폴더를 통과시켰다');

  eq(level(await run({ repoHash: () => 'b'.repeat(64) }), '코드 사본'), 'warn', '저장소와 다른 코드 사본을 알려주지 않는다(커밋 안 한 수정 포함)');
  eq(level(await run({ readMarker: () => ({ complete: false }) }), '코드 사본'), 'fail', '복사가 도중에 끊긴 사본을 통과시켰다');
  eq(level(await run({ readMarker: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }), '코드 사본'), 'fail', '코드 사본이 없는데 통과시켰다');
  const eacces = await run({ readMarker: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } });
  eq(level(eacces, '코드 사본'), 'warn', '권한이 없어 못 읽은 것을 "사본이 없다"(재설치하라)로 말한다');
  eq(level(await run({ repoHash: () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } }), '코드 사본'), 'warn', '저장소를 못 읽어 비교하지 못했는데 ✓ 로 보인다');
  eq(level(await run({ readMarker: () => ({ complete: true, commit: 'x' }) }), '코드 사본'), 'warn', '지문 없는 사본 표식을 ✓ 로 본다');
  ok(anyFail(await run({ exists: (p) => p.includes('cloudflared') }), '코드 사본'), '사본에 package.json 이 없는데 통과시켰다');
  eq(level(await run({ ps: { task: 'Disabled\r\n' } }), '작업 스케줄러'), 'fail', '꺼진 작업(부팅·5분 자동 시작 안 함)을 통과시켰다');
  ok(anyFail(await run({ ps: { svcPath: '"C:\\Cloudflared\\bin\\cloudflared.exe" tunnel run --token-file x\r\n' } }), 'cloudflared 서비스'), 'Program Files 밖의 cloudflared 를 돌리는 서비스를 통과시켰다');
  const tokSvc = await run({ ps: { svcPath: `"C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" tunnel run --token ${TOKEN}\r\n` } });
  const ts = tokSvc.filter((r) => r.name === 'cloudflared 서비스');
  ok(ts.some((r) => r.level === 'fail' && /평문/.test(r.msg)), '서비스 실행 줄에 토큰이 평문으로 있는데 잡지 못한다(옛 설치)');
  ok(!JSON.stringify(tokSvc).includes(TOKEN), '점검 결과에 서비스 실행 줄의 토큰이 찍혔다');

  const notAdmin = await run({ run: { whoami: { status: 0, stdout: '"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""' } } });
  eq(level(notAdmin, '관리자 권한'), 'warn', '관리자 권한이 아닌 터미널을 알려주지 않는다');

  const sum = (rs) => { const out = []; printDoctor(rs, (l) => out.push(l)); return out.join('\n'); };
  ok(/전부 통과/.test(sum([{ level: 'ok', name: 'a', msg: '' }])), '전부 ✓ 인데 통과라고 하지 않는다');
  ok(!/전부 통과/.test(sum([{ level: 'ok', name: 'a', msg: '' }, { level: 'warn', name: 'b', msg: '' }])), '· 가 있는데 "전부 통과" 라고 한다');
  ok(/고칠 곳 1건/.test(sum([{ level: 'fail', name: 'a', msg: '' }])), '실패 건수를 말하지 않는다');
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 설치 도구: 잠금(링크·주인·SID·안의 항목·확인) · 사본 실행(node 포함·겹침 거절·끊겨도 복구) · 잠그면 안 되는 폴더 거절 · 작업 정의 · 토큰 비노출·옛/엉뚱한 cloudflared 거절 · 점검이 위험 상태를 잡음');
