#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.test.mjs
 *
 * setup.mjs 는 Windows 에서 schtasks·icacls·PowerShell·cloudflared 를 부른다. CI(Linux)는 그것을 못 돌리므로
 * "무엇을 어떤 순서로 부르는가"(plan*)와 "점검이 무엇을 위험으로 잡는가"(doctor)를 가짜 실행기로 확인한다.
 * 특히 지키는 것:
 *  - 터널 토큰이 화면 출력·오류에 찍히지 않고, 옛 cloudflared 면 설치 전에 멈춘다
 *  - 작업은 저장소가 아니라 관리자 전용 "코드 사본"을 SYSTEM 으로, 시간 제한 없이 돌린다
 *  - 설정·자료·사본 폴더를 비밀을 쓰기 전에 관리자·SYSTEM 만으로 잠그고(주인까지), 잠겼는지 다시 읽어 본다
 *  - 남의 파일이 든 폴더·저장소를 품은 폴더·사용자 폴더는 잠그지 않는다(원장이 자기 파일을 못 연다)
 *  - 점검이 "Access 없이 열림"·"LAN 에 열림"·"학생 로그인이 열림"·"옛 cloudflared"·"권한 새는 폴더" 를 실패로 잡는다
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planEnv, planInstallServer, planRestartServer, planUninstallServer, planTunnel, readToken, execute, doctor, printDoctor,
  findCloudflared, isElevated, envDirProblem, dataDirProblem, sysTool, verifyAcl, deployApp, removeApp, lockSteps,
} from './setup.mjs';
import { APP_DIRS, APP_MARKER } from './kit.mjs';

const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const ENVF = 'C:\\ProgramData\\WB\\server.env';
const APP = 'C:\\ProgramData\\WB\\app';
const REPO_W = 'C:\\WB\\wb-site';
/* 누가 봐도 가짜인 값 — 진짜 토큰 모양(eyJ… base64 JSON)으로 두면 비밀 검사기가 진짜로 오인한다 */
const TOKEN = 'FAKE_TUNNEL_TOKEN_FOR_TESTS_ONLY_' + 'x'.repeat(80);
const isLock = (s, dir) => s.run && s.run[0] === 'icacls' && s.run[1] === dir;

/* ── 잠금 명령 모양 ── */
{
  const [own, grant] = lockSteps('C:\\X', '시험');
  eq(own.run.slice(1), ['C:\\X', '/setowner', '*S-1-5-32-544', '/T', '/C'], '주인을 관리자로 바꾸지 않는다 — 미리 폴더를 만든 일반 사용자가 주인으로 남는다');
  ok(grant.run.includes('/inheritance:r'), '상속을 끊지 않는다 — 일반 사용자(Users)가 계속 읽는다');
  ok(grant.run.some((a) => a.startsWith('*S-1-5-32-544:')) && grant.run.some((a) => a.startsWith('*S-1-5-18:')), 'SID 로 관리자·SYSTEM 을 주지 않는다(한국어 Windows 는 그룹 이름이 다를 수 있다)');
  ok(!grant.run.some((a) => /Users|Everyone|S-1-5-32-545|S-1-1-0|S-1-5-11/.test(a)), '일반 사용자·Everyone 에게 권한을 준다');
}

/* ── planEnv — 비밀을 쓰기 전에 잠근다, 있으면 내용은 두고 잠금만 다시 ── */
{
  const steps = planEnv({ envFile: ENVF, platform: 'win32' });
  const iLock = steps.findIndex((s) => isLock(s, 'C:\\ProgramData\\WB'));
  const iWrite = steps.findIndex((s) => s.write);
  const iMk = steps.findIndex((s) => s.mkdir);
  ok(iMk >= 0 && iMk < iLock && iLock < iWrite, '순서가 폴더 → 잠금 → 견본이 아니다 — 잠기기 전에 비밀 파일이 생긴다');
  ok(steps.some((s) => s.verifyAcl === 'C:\\ProgramData\\WB'), '잠근 뒤 실제 권한을 확인하지 않는다');
  const w = steps[iWrite];
  ok(/ADMIN_ID=\r\n/.test(w.data) && !/ADMIN_PASSWORD=\S/.test(w.data), '견본에 값이 채워져 있다');
  const again = planEnv({ envFile: ENVF, platform: 'win32', fileExists: true });
  ok(!again.some((s) => s.write), '이미 있는 설정 파일을 덮어쓴다 — 원장이 채운 비밀번호가 날아간다');
  ok(again.some((s) => isLock(s, 'C:\\ProgramData\\WB')) && again.some((s) => s.verifyAcl), '설정 파일이 이미 있으면 잠금을 건너뛴다 — 예전에 잠금이 실패했으면 열린 채로 남는다');
}

/* ── 설정·자료 폴더로 써도 되는가 ── */
{
  eq(envDirProblem({ envFile: ENVF, entries: null, repo: REPO_W, platform: 'win32' }), '', '기본 설정 자리를 거절했다');
  eq(envDirProblem({ envFile: ENVF, entries: ['server.env', 'app'], repo: REPO_W, platform: 'win32' }), '', '우리 것만 든 설정 폴더를 거절했다');
  ok(/저장소 안/.test(envDirProblem({ envFile: REPO_W + '\\server.env', entries: [], repo: REPO_W, platform: 'win32' })), '저장소 안 설정 파일을 받았다');
  ok(/품고/.test(envDirProblem({ envFile: 'C:\\WB\\server.env', entries: ['wb-site'], repo: REPO_W, platform: 'win32' })), '저장소를 품은 폴더를 설정 폴더로 받았다 — 잠그면 저장소가 잠긴다');
  ok(/사용자 폴더/.test(envDirProblem({ envFile: 'C:\\Users\\wb\\Desktop\\server.env', entries: [], repo: REPO_W, platform: 'win32' })), '바탕 화면을 설정 폴더로 받았다');
  ok(/다른 파일/.test(envDirProblem({ envFile: 'C:\\WBconf\\server.env', entries: ['메모.txt'], repo: REPO_W, platform: 'win32' })), '남의 파일이 든 폴더를 설정 폴더로 받았다');
  eq(dataDirProblem({ dataDir: 'C:\\WB_server_data', entries: null }), '', '새 자료 폴더를 거절했다');
  eq(dataDirProblem({ dataDir: 'C:\\WB_server_data', entries: ['db.json', 'backups', 'logs'] }), '', '서버 자료만 든 폴더(다시 설치)를 거절했다');
  ok(dataDirProblem({ dataDir: 'D:\\학원자료', entries: ['db.json', '수업.hwp'] }), '원장 파일이 든 폴더를 자료 폴더로 받았다 — 잠기면 원장이 못 연다');
}

/* ── planInstallServer — 코드 사본을 돌린다 ── */
{
  const steps = planInstallServer({
    envFile: ENVF, dataDir: 'C:\\WB_server_data', appDir: APP, nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    tmpDir: 'C:\\Windows\\Temp', repo: REPO_W, platform: 'win32',
  });
  const w = steps.find((s) => s.write);
  ok(Buffer.isBuffer(w.data) && w.data[0] === 0xff && w.data[1] === 0xfe, '작업 정의가 UTF-16 LE BOM 이 아니다 — schtasks /XML 이 거절할 수 있다');
  const xml = w.data.slice(2).toString('utf16le');
  ok(/<UserId>S-1-5-18<\/UserId>/.test(xml), 'SYSTEM 으로 띄우지 않는다 — 로그인하지 않으면 서버가 안 뜬다');
  ok(/<BootTrigger>/.test(xml), '부팅 트리거가 없다');
  ok(/<Interval>PT5M<\/Interval>/.test(xml) && /<MultipleInstancesPolicy>IgnoreNew</.test(xml), '5분 감시 + 중복 실행 방지가 없다');
  ok(/<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/.test(xml), '실행 시간 제한이 남아 있다 — 기본 72시간이면 사흘째에 끊긴다');
  ok(/<DisallowStartIfOnBatteries>false</.test(xml) && /<StopIfGoingOnBatteries>false</.test(xml), '노트북 배터리에서 멈춘다');
  ok(xml.includes('<Command>C:\\Program Files\\nodejs\\node.exe</Command>'), 'node.exe 를 전체 경로로 적지 않았다(SYSTEM 은 PATH 가 다르다)');
  ok(xml.includes('&quot;C:\\ProgramData\\WB\\app\\reading-server\\tunnel\\run-server.mjs&quot; --env &quot;C:\\ProgramData\\WB\\server.env&quot;'), '작업이 코드 사본의 실행기를 가리키지 않는다');
  ok(xml.includes('<WorkingDirectory>C:\\ProgramData\\WB\\app</WorkingDirectory>'), '작업 폴더가 코드 사본이 아니다');
  ok(!xml.includes(REPO_W), '작업이 저장소(일반 사용자가 고칠 수 있는 자리)의 코드를 SYSTEM 으로 돌린다');
  ok(/<Priority>5<\/Priority>/.test(xml), '우선순위가 보통(5)이 아니다 — 7 이면 서버가 느려진다');
  const cnt = Number((/<Count>(\d+)<\/Count>/.exec(xml) || [])[1]);
  ok(cnt >= 1 && cnt <= 255, `RestartOnFailure Count 가 스키마 범위(1~255) 밖이다: ${cnt}`);
  const tt = (/<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml) || [])[1] || '';
  ok(tt.indexOf('<Enabled>') < tt.indexOf('<StartBoundary>') && tt.indexOf('<StartBoundary>') < tt.indexOf('<Repetition>'), '트리거 안 순서가 스키마(Enabled → StartBoundary → Repetition)와 다르다');
  ok(/<BootTrigger><Enabled>true<\/Enabled><Delay>PT\d+S<\/Delay><\/BootTrigger>/.test(xml), '부팅 트리거에 지연(Delay)이 없거나 순서가 틀렸다');
  const create = steps.find((s) => s.run && s.run[0] === 'schtasks' && s.run[1] === '/Create');
  eq(create && create.run.slice(1), ['/Create', '/TN', 'WB-Admin-Server', '/XML', 'C:\\Windows\\Temp\\wb-admin-server-task.xml', '/RU', 'SYSTEM', '/F'], 'schtasks /Create 인자');
  const iDeploy = steps.findIndex((s) => s.deployApp);
  const iAppLock = steps.findIndex((s) => isLock(s, APP));
  ok(iDeploy >= 0 && iDeploy < iAppLock && iAppLock < steps.indexOf(create), '코드 사본을 복사·잠근 뒤에 작업을 등록하지 않는다');
  eq(steps[iDeploy].deployApp, { from: REPO_W, to: APP }, '복사 원본·대상');
  ok(steps.some((s) => s.verifyAcl === APP) && steps.some((s) => s.verifyAcl === 'C:\\WB_server_data'), '사본·자료 폴더의 권한을 다시 읽지 않는다');
  ok(steps[0].run && steps[0].run[1] === '/End' && steps[0].okCodes.includes(1), '돌고 있는 사본을 멈추지 않고 덮어쓴다');
  ok(steps.findIndex((s) => s.remove) > steps.indexOf(create), '등록하기 전에 작업 정의를 지운다');
  ok(steps.some((s) => isLock(s, 'C:\\WB_server_data')), '자료 폴더(학생 기록)를 잠그지 않는다');
  const runs = steps.filter((s) => s.run);
  ok(runs[runs.length - 1].run[1] === '/Run', '등록 뒤 바로 띄우지 않는다');
}

/* ── 다시 띄우기·지우기 ── */
{
  const r = planRestartServer({ repo: REPO_W, appDir: APP });
  ok(r[0].run[1] === '/End' && r[0].okCodes.includes(1), '멈춰 있는 작업을 /End 하면 실패로 끝난다');
  ok(r.some((s) => s.deployApp) && r.findIndex((s) => s.deployApp) < r.length - 1, 'restart-server 가 새 코드를 복사하지 않는다 — git pull 이 반영되지 않는다');
  ok(r[r.length - 1].run[1] === '/Run', '다시 띄우지 않는다');
  const u = planUninstallServer({ appDir: APP });
  ok(u.some((s) => s.run && s.run[1] === '/Delete' && s.run.includes('/F')), '작업을 지우지 않는다');
  ok(u.some((s) => s.removeApp === APP), '코드 사본을 남긴다');
  ok(!u.some((s) => s.remove || (s.run && /rmdir|del/i.test(s.run[0]))), '지우기가 자료·설정 파일까지 지운다');
}

/* ── 시스템 도구는 전체 경로로 ── */
{
  eq(sysTool('icacls', 'win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\icacls.exe', 'icacls 를 이름만으로 부른다 — 지금 폴더의 가짜 icacls.exe 가 먼저 잡힌다');
  eq(sysTool('powershell', 'win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell 경로');
  eq(sysTool('icacls', 'linux', {}), 'icacls', 'Windows 가 아니면 그대로');
}

/* ── 터널 토큰 ── */
{
  eq(readToken(TOKEN + '\r\n'), TOKEN, '토큰만 붙여 넣은 파일');
  eq(readToken(`cloudflared.exe service install ${TOKEN}`), TOKEN, '대시보드 명령을 통째로 붙여 넣은 파일');
  ok(throwsWith(() => readToken('여기에 토큰'), /찾지 못했습니다/), '토큰이 아닌 내용을 받았다');
  /* 옛 cloudflared 는 설치 전에 멈춘다 — 실제 설치 경로(planTunnel)에서 */
  for (const vt of ['cloudflared version 2026.7.2', '']) {
    let msg = '';
    let ran = false;
    try { execute(planTunnel({ cloudflared: 'cf.exe', token: TOKEN, versionText: vt, tokenFile: 'C:\\ProgramData\\WB\\tunnel-token.txt' }), { runner: () => { ran = true; return 0; }, out: () => {} }); } catch (e) { msg = e.message; }
    ok(/2026\.7\.3/.test(msg) && !ran, `옛(또는 알 수 없는) cloudflared(${vt || '빈 값'})로 서비스를 설치했다 — 토큰이 레지스트리에 평문으로 남는다`);
    ok(!msg.includes(TOKEN), '오류에 토큰이 실렸다');
  }
  const lines = [];
  execute(planTunnel({ cloudflared: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', token: TOKEN, dryRun: true }), { dryRun: true, out: (l) => lines.push(l) });
  ok(!lines.join('\n').includes(TOKEN), '화면 출력에 터널 토큰이 찍혔다');
  ok(/<토큰 숨김>/.test(lines.join('\n')), '토큰 자리를 숨김 표시로 바꾸지 않았다');
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
  execute([{ run: ['schtasks', '/Run'] }, { deployApp: { from: 'a', to: 'b' } }, { verifyAcl: 'x' }], {
    dryRun: true, runner: () => { called++; return 0; }, out: () => {},
    ops: { deployApp: () => { called++; }, removeApp: () => { called++; }, verifyAcl: () => { called++; } },
  });
  ok(called === 0, '--dry-run 인데 명령을 실행했다');
  ok(throwsWith(() => execute([{ run: ['schtasks', '/Create'], why: '등록' }], { runner: () => 1, out: () => {} }), /종료 코드 1/), '실패한 명령을 그냥 넘어갔다');
  let ran = 0;
  execute([{ run: ['schtasks', '/End'], okCodes: [0, 1] }, { run: ['x'] }], { runner: () => { ran++; return ran === 1 ? 1 : 0; }, out: () => {} });
  ok(ran === 2, 'okCodes 에 있는 종료 코드에서 멈췄다');
}

/* ── 잠금 확인 — 남은 남의 권한을 지우고, 그래도 남으면 멈춘다 ── */
{
  const goodAcl = 'OWNER|S-1-5-32-544\nACE|S-1-5-32-544|Allow|2032127|False\nACE|S-1-5-18|Allow|2032127|False';
  const leaky = goodAcl + '\nACE|S-1-5-21-9-9-9-1001|Allow|1245631|False';
  let reads = 0;
  const removed = [];
  verifyAcl('C:\\WB_server_data', (argv) => { removed.push(argv.join(' ')); return 0; }, () => ({ stdout: reads++ === 0 ? leaky : goodAcl }));
  ok(removed.some((c) => /\/remove:g \*S-1-5-21-9-9-9-1001/.test(c)), '남은 사용자 권한을 지우지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: leaky })), /잠그지 못했습니다/), '지워도 남는 권한이 있는데 멈추지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: 'OWNER|S-1-5-21-1-1-1-1000\nACE|S-1-5-32-544|Allow|1|False' })), /잠그지 못했습니다/), '주인이 일반 사용자인데 멈추지 않는다');
  ok(throwsWith(() => verifyAcl('C:\\X', () => 0, () => ({ stdout: '' })), /읽지 못했습니다/), '권한을 못 읽었는데 잠긴 것으로 봤다');
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
  ok(fs.existsSync(path.join(to, APP_MARKER)), '사본 표식을 남기지 않는다 — 다음 복사·지우기가 남의 폴더와 구별하지 못한다');
  fs.writeFileSync(path.join(to, 'reading', 'stale.txt'), 'old');
  deployApp(src, to);
  ok(!fs.existsSync(path.join(to, 'reading', 'stale.txt')), '다시 복사할 때 저장소에서 지운 파일이 사본에 남는다');
  const foreign = path.join(tmp, 'mine');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, '중요.hwp'), 'x');
  ok(throwsWith(() => deployApp(src, foreign), /다른 파일/), '표식 없는 남의 폴더를 지우고 덮어썼다');
  ok(fs.existsSync(path.join(foreign, '중요.hwp')), '남의 파일이 지워졌다');
  ok(throwsWith(() => removeApp(foreign), /만든 코드 사본이 아닙니다/), '표식 없는 폴더를 지웠다');
  removeApp(to);
  ok(!fs.existsSync(to), '코드 사본을 지우지 못했다');
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── 관리자 권한 판정 ── */
{
  const who = (out) => (argv) => (argv[0] === 'whoami' ? { status: 0, stdout: out } : { status: 2, stdout: '' });
  ok(isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","필수 그룹"\r\n"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""')), '높은 무결성(S-1-16-12288)을 관리자 권한으로 보지 않는다');
  ok(!isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","거부 전용 그룹"\r\n"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""')), 'UAC 로 걸러진(중간 무결성) 터미널을 관리자 권한으로 봤다');
  ok(isElevated((argv) => (argv[0] === 'whoami' ? { error: new Error('ENOENT') } : { status: 0 })), 'whoami 가 없을 때 net session 으로 넘어가지 않는다');
}

/* ── findCloudflared — 설치 자리가 먼저, 지금 폴더·저장소 안의 것은 믿지 않는다 ── */
{
  eq(findCloudflared({ run: () => ({ status: 0, stdout: 'C:\\tools\\cloudflared.exe\r\n' }), exists: (p) => p.includes('(x86)') }), 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', '설치 프로그램 자리보다 PATH 를 먼저 믿는다');
  eq(findCloudflared({ run: () => ({ status: 0, stdout: 'C:\\tools\\cloudflared.exe\r\n' }), exists: () => false, cwd: REPO_W, repo: REPO_W }), 'C:\\tools\\cloudflared.exe', 'PATH 의 것');
  eq(findCloudflared({ run: () => ({ status: 0, stdout: 'C:\\WB\\wb-site\\cloudflared.exe\r\n' }), exists: () => false, cwd: REPO_W, repo: REPO_W }), '', '저장소(지금 폴더)에 놓인 cloudflared.exe 를 골랐다 — 관리자 터미널이 그것에 토큰을 넘긴다');
  eq(findCloudflared({ run: () => ({ status: 1, stdout: '' }), exists: () => false }), '', '없을 때');
}

/* ── doctor (가짜 실행기·가짜 fetch) ── */
const res = (status, headers = {}, body = '') => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
const GOOD_ACL = 'OWNER|S-1-5-32-544\r\nACE|S-1-5-32-544|Allow|2032127|False\r\nACE|S-1-5-18|Allow|2032127|False\r\n';
function fakeDeps(over = {}) {
  const cfg = { errors: [], warnings: [], port: 8890, dataDir: 'C:\\WB_server_data', logDir: 'C:\\WB_server_data\\logs', publicHost: 'wb.example.com' };
  const routes = {
    'http://127.0.0.1:8890/api/health': res(200, { 'x-robots-tag': 'noindex, nofollow' }),
    'http://127.0.0.1:8890/api/login': res(403),
    'http://127.0.0.1:20241/ready': res(200),
    'https://wb.example.com/': res(302, { location: 'https://wbteam.cloudflareaccess.com/cdn-cgi/access/login/wb.example.com?kid=a&redirect_url=%2F' }),
    'https://wb.example.com/admin/': res(302, { location: 'https://wbteam.cloudflareaccess.com/cdn-cgi/access/login/wb.example.com?kid=a&redirect_url=%2Fadmin%2F' }),
    ...(over.routes || {}),
  };
  const ps = { acl: GOOD_ACL, drive: 'Fixed\r\n', service: 'Running\r\n', ...(over.ps || {}) };
  const runOut = {
    schtasks: { status: 0, stdout: '' },
    whoami: { status: 0, stdout: '"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""' },
    where: { status: 1, stdout: '' },
    cloudflared: { status: 0, stdout: 'cloudflared version 2026.10.0 (built 2026-10-01)' },
    ...(over.run || {}),
  };
  return {
    platform: 'win32',
    nodeVersion: over.nodeVersion || '22.11.0',
    load: () => ({ ...cfg, ...(over.cfg || {}) }),
    interfaces: { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.0.10' }] },
    connect: async (host) => (over.lanOpen ? host === '192.168.0.10' : false),
    readMarker: over.readMarker || (() => ({ commit: 'abc1234def' })),
    repoHead: over.repoHead || (() => 'abc1234def'),
    run: (argv) => {
      if (argv[0] === 'powershell') {
        const c = argv[argv.length - 1];
        if (/Get-Acl/.test(c)) return { status: 0, stdout: typeof ps.acl === 'function' ? ps.acl(c) : ps.acl };
        if (/DriveInfo/.test(c)) return { status: 0, stdout: ps.drive };
        if (/Get-Service/.test(c)) return { status: 0, stdout: ps.service };
      }
      if (argv[0] === 'where') return runOut.where;
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
{
  const good = await doctor({ envFile: ENVF, appDir: APP }, fakeDeps({ run: { where: { status: 0, stdout: 'C:\\tools\\cloudflared.exe\r\n' } } }));
  eq(fails(good), [], '정상 설치인데 실패가 나왔다');
  eq(good.filter((r) => r.level === 'warn').map((r) => r.name), [], '정상 설치인데 · 가 나왔다 — README 는 "✗ 없음 + 바깥 주소 ✓" 를 말한다');
  eq(level(good, '바깥 주소 /admin/'), 'ok', '/admin/ 의 Access 를 보지 않는다');
  eq(level(good, '터널 연결'), 'ok', '/ready 200 을 연결로 보지 않는다');
  eq(level(good, '관리자 권한'), 'ok', '관리자 권한 줄이 없다');
  eq(level(good, '권한: 자료 폴더'), 'ok', '자료 폴더 권한을 보지 않는다');
  eq(level(good, 'cloudflared 버전'), 'ok', '지원되는 cloudflared 를 ok 로 보지 않는다');

  const exposed = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'https://wb.example.com/admin/': res(200, { 'x-robots-tag': 'noindex' }) } }));
  const ex = exposed.find((r) => r.name === '바깥 주소 /admin/');
  ok(ex.level === 'fail' && /위험/.test(ex.msg), 'Access 없이 열린 /admin/ 을 위험으로 잡지 못한다');

  for (const st of [200, 401]) {
    const student = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:8890/api/login': res(st) } }));
    eq(level(student, '관리 전용'), 'fail', `학생 로그인이 ${st} 인 서버를 통과시켰다`);
  }

  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ lanOpen: true })), 'LAN 차단'), 'fail', 'LAN 에 열린 서버를 통과시켰다');
  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:8890/api/health': new TypeError('fetch failed') } })), '로컬 서버'), 'fail', '서버가 안 떠 있는데 통과시켰다');

  const oldCf = await doctor({ envFile: ENVF }, fakeDeps({ run: { where: { status: 0, stdout: 'C:\\tools\\cloudflared.exe' }, cloudflared: { status: 0, stdout: 'cloudflared version 2025.11.1' } } }));
  eq(level(oldCf, 'cloudflared 버전'), 'fail', '토큰을 레지스트리에 남기는 옛 cloudflared 를 통과시켰다');

  const noSvc = await doctor({ envFile: ENVF }, fakeDeps({ ps: { service: '' }, run: { schtasks: { status: 1, stdout: '' } } }));
  eq(level(noSvc, 'cloudflared 서비스'), 'fail', '설치되지 않은 cloudflared 서비스를 통과시켰다');
  eq(level(noSvc, '작업 스케줄러'), 'fail', '등록되지 않은 작업을 통과시켰다');

  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:20241/ready': res(503) } })), '터널 연결'), 'fail', '/ready 503 을 통과시켰다');
  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ cfg: { errors: ['DATA_DIR 이 비어 있습니다'] } })), '설정 파일'), 'fail', '틀린 설정 파일을 통과시켰다');
  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ nodeVersion: '20.11.0' })), 'Node.js'), 'fail', 'Node 20 을 통과시켰다');

  /* 바깥 주소 점검이 빠지면 "Access 없이 열림"을 아무도 안 본다 — Windows 에서는 실패로 */
  const noHost = await doctor({ envFile: ENVF }, fakeDeps({ cfg: { publicHost: '' } }));
  eq(level(noHost, '바깥 주소'), 'fail', '바깥 주소가 없는데 실패로 잡지 않는다 — "전부 통과" 로 끝난다');

  const leakAcl = await doctor({ envFile: ENVF }, fakeDeps({ ps: { acl: (c) => (/WB_server_data/.test(c) ? GOOD_ACL + 'ACE|S-1-5-32-545|Allow|1179817|True\r\n' : GOOD_ACL) } }));
  eq(level(leakAcl, '권한: 자료 폴더'), 'fail', '일반 사용자가 읽을 수 있는 자료 폴더를 통과시켰다');
  eq(level(leakAcl, '권한: 설정 폴더'), 'ok', '잠긴 설정 폴더를 실패로 봤다');

  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ ps: { drive: 'Network\r\n' } })), '자료 드라이브'), 'fail', '네트워크 드라이브의 자료 폴더를 통과시켰다');
  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ repoHead: () => 'fffffff000' })), '코드 사본'), 'warn', '저장소와 다른 코드 사본을 알려주지 않는다(restart-server 필요)');
  eq(level(await doctor({ envFile: ENVF }, fakeDeps({ readMarker: () => { throw new Error('ENOENT'); } })), '코드 사본'), 'fail', '코드 사본이 없는데 통과시켰다');

  const notAdmin = await doctor({ envFile: ENVF }, fakeDeps({ run: { whoami: { status: 0, stdout: '"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""' } } }));
  eq(level(notAdmin, '관리자 권한'), 'warn', '관리자 권한이 아닌 터미널을 알려주지 않는다');

  /* 요약 — · 가 있으면 "전부 통과" 라고 하지 않는다 */
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
console.log('OK — 설치 도구: 잠금(주인·SID·확인) · 코드 사본 실행 · 잠그면 안 되는 폴더 거절 · 작업 정의 · 토큰 비노출·옛 cloudflared 거절 · 점검이 위험 상태를 실패로 잡음');
