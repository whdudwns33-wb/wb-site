#!/usr/bin/env node
/* 원장 PC 설치·점검 도구 — node reading-server/tunnel/setup.test.mjs
 *
 * setup.mjs 는 Windows 에서 schtasks·icacls·cloudflared 를 부른다. CI(Linux)는 그것을 못 돌리므로
 * "무엇을 어떤 순서로 부르는가"(plan*)와 "점검이 무엇을 위험으로 잡는가"(doctor)를 가짜 실행기로 확인한다.
 * 특히 지키는 것:
 *  - 터널 토큰이 화면 출력에 찍히지 않는다
 *  - 작업 정의 파일이 UTF-16(BOM) 이고 관리 전용 실행기를 SYSTEM 으로, 시간 제한 없이 띄운다
 *  - 설정·자료 폴더를 관리자·SYSTEM 만 읽게 잠근다(번역된 그룹 이름이 아니라 SID 로)
 *  - 점검이 "Access 없이 열림"·"LAN 에 열림"·"학생 로그인이 열림"·"옛 cloudflared" 를 실패로 잡는다
 */
import {
  planEnv, planInstallServer, planRestartServer, planUninstallServer, planTunnel, readToken, execute, doctor, findCloudflared, isElevated,
} from './setup.mjs';

const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

const ENVF = 'C:\\ProgramData\\WB\\server.env';
/* 누가 봐도 가짜인 값 — 진짜 토큰 모양(eyJ… base64 JSON)으로 두면 비밀 검사기가 진짜로 오인한다 */
const TOKEN = 'FAKE_TUNNEL_TOKEN_FOR_TESTS_ONLY_' + 'x'.repeat(80);

/* ── planEnv ── */
{
  const steps = planEnv({ envFile: ENVF, platform: 'win32' });
  const acl = steps.find((s) => s.run && s.run[0] === 'icacls');
  ok(acl && acl.run[1] === 'C:\\ProgramData\\WB', '설정 폴더를 잠그지 않는다');
  ok(acl && acl.run.includes('/inheritance:r'), '상속을 끊지 않는다 — 일반 사용자(Users)가 계속 읽는다');
  ok(acl && acl.run.some((a) => a.startsWith('*S-1-5-32-544:')) && acl.run.some((a) => a.startsWith('*S-1-5-18:')), 'SID 로 관리자·SYSTEM 을 주지 않는다(한국어 Windows 는 그룹 이름이 다를 수 있다)');
  ok(!acl.run.some((a) => /Users|Everyone|S-1-5-32-545|S-1-1-0/.test(a)), '일반 사용자·Everyone 에게 권한을 준다');
  const w = steps.find((s) => s.write);
  ok(w && /ADMIN_ID=\r\n/.test(w.data) && !/ADMIN_PASSWORD=\S/.test(w.data), '견본에 값이 채워져 있다');
  const idxWrite = steps.indexOf(w);
  ok(steps.findIndex((s) => s.mkdir) < idxWrite, '폴더를 만들기 전에 파일을 쓴다');
  const again = planEnv({ envFile: ENVF, platform: 'win32', exists: true });
  ok(again.length === 1 && again[0].note && !again.some((s) => s.write), '이미 있는 설정 파일을 덮어쓴다 — 원장이 채운 비밀번호가 날아간다');
}

/* ── planInstallServer ── */
{
  const steps = planInstallServer({
    envFile: ENVF, dataDir: 'C:\\WB_server_data', nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    tmpDir: 'C:\\Windows\\Temp', repo: 'C:\\Users\\wb\\wb-site', runScript: 'C:\\Users\\wb\\wb-site\\reading-server\\tunnel\\run-server.mjs', platform: 'win32',
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
  ok(xml.includes('&quot;C:\\Users\\wb\\wb-site\\reading-server\\tunnel\\run-server.mjs&quot; --env &quot;C:\\ProgramData\\WB\\server.env&quot;'), '실행기·설정 파일 경로 인자가 틀렸다');
  ok(!xml.includes('reading-server\\server.mjs'), 'server.mjs 를 실행기 없이 직접 띄운다 — 관리 전용 강제가 빠진다');
  const create = steps.find((s) => s.run && s.run[0] === 'schtasks' && s.run[1] === '/Create');
  eq(create && create.run.slice(1), ['/Create', '/TN', 'WB-Admin-Server', '/XML', 'C:\\Windows\\Temp\\wb-admin-server-task.xml', '/RU', 'SYSTEM', '/F'], 'schtasks /Create 인자');
  ok(/<Priority>5<\/Priority>/.test(xml), '우선순위가 보통(5)이 아니다 — 7 이면 서버가 느려진다');
  const cnt = Number((/<Count>(\d+)<\/Count>/.exec(xml) || [])[1]);
  ok(cnt >= 1 && cnt <= 255, `RestartOnFailure Count 가 스키마 범위(1~255) 밖이다: ${cnt}`);
  const tt = (/<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml) || [])[1] || '';
  ok(tt.indexOf('<Enabled>') < tt.indexOf('<StartBoundary>') && tt.indexOf('<StartBoundary>') < tt.indexOf('<Repetition>'), '트리거 안 순서가 스키마(Enabled → StartBoundary → Repetition)와 다르다');
  ok(/<BootTrigger><Enabled>true<\/Enabled><Delay>PT\d+S<\/Delay><\/BootTrigger>/.test(xml), '부팅 트리거에 지연(Delay)이 없거나 순서가 틀렸다');
  ok(steps.findIndex((s) => s.remove) > steps.indexOf(create), '등록하기 전에 작업 정의를 지운다');
  ok(steps.some((s) => s.run && s.run[0] === 'icacls' && s.run[1] === 'C:\\WB_server_data'), '자료 폴더(학생 기록)를 잠그지 않는다');
  const runs = steps.filter((s) => s.run);
  ok(runs[runs.length - 1].run[1] === '/Run', '등록 뒤 바로 띄우지 않는다');
}

/* ── 다시 띄우기·지우기 ── */
{
  const r = planRestartServer();
  ok(r[0].run[1] === '/End' && r[0].okCodes.includes(1), '멈춰 있는 작업을 /End 하면 실패로 끝난다');
  ok(r[1].run[1] === '/Run', '다시 띄우지 않는다');
  const u = planUninstallServer();
  ok(u.some((s) => s.run && s.run[1] === '/Delete' && s.run.includes('/F')), '작업을 지우지 않는다');
  ok(!u.some((s) => s.remove || (s.run && /rmdir|del/i.test(s.run[0]))), '지우기가 자료·설정 파일까지 지운다');
}

/* ── 터널 토큰 ── */
{
  eq(readToken(TOKEN + '\r\n'), TOKEN, '토큰만 붙여 넣은 파일');
  eq(readToken(`cloudflared.exe service install ${TOKEN}`), TOKEN, '대시보드 명령을 통째로 붙여 넣은 파일');
  let threw = false;
  try { readToken('여기에 토큰'); } catch { threw = true; }
  ok(threw, '토큰이 아닌 내용을 받았다');
  const lines = [];
  execute(planTunnel({ cloudflared: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', token: TOKEN }), { dryRun: true, out: (l) => lines.push(l) });
  ok(!lines.join('\n').includes(TOKEN), '화면 출력에 터널 토큰이 찍혔다');
  ok(/<토큰 숨김>/.test(lines.join('\n')), '토큰 자리를 숨김 표시로 바꾸지 않았다');
  let argv = null;
  execute(planTunnel({ cloudflared: 'cf.exe', token: TOKEN }), { runner: (a) => { argv = a; return 0; }, out: () => {} });
  eq(argv, ['cf.exe', 'service', 'install', TOKEN], '실제 실행 인자');
}

/* ── execute ── */
{
  let called = 0;
  execute([{ run: ['schtasks', '/Run'] }], { dryRun: true, runner: () => { called++; return 0; }, out: () => {} });
  ok(called === 0, '--dry-run 인데 명령을 실행했다');
  let threw = false;
  try { execute([{ run: ['schtasks', '/Create'], why: '등록' }], { runner: () => 1, out: () => {} }); } catch (e) { threw = /종료 코드 1/.test(e.message); }
  ok(threw, '실패한 명령을 그냥 넘어갔다');
  let ran = 0;
  execute([{ run: ['schtasks', '/End'], okCodes: [0, 1] }, { run: ['x'] }], { runner: () => { ran++; return ran === 1 ? 1 : 0; }, out: () => {} });
  ok(ran === 2, 'okCodes 에 있는 종료 코드에서 멈췄다');
}

/* ── 관리자 권한 판정 ── */
{
  const who = (out) => (argv) => (argv[0] === 'whoami' ? { status: 0, stdout: out } : { status: 2, stdout: '' });
  ok(isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","필수 그룹"\r\n"Mandatory Label\\High Mandatory Level","레이블","S-1-16-12288",""')), '높은 무결성(S-1-16-12288)을 관리자 권한으로 보지 않는다');
  ok(!isElevated(who('"BUILTIN\\Administrators","별칭","S-1-5-32-544","거부 전용 그룹"\r\n"Mandatory Label\\Medium Mandatory Level","레이블","S-1-16-8192",""')), 'UAC 로 걸러진(중간 무결성) 터미널을 관리자 권한으로 봤다');
  ok(isElevated((argv) => (argv[0] === 'whoami' ? { error: new Error('ENOENT') } : { status: 0 })), 'whoami 가 없을 때 net session 으로 넘어가지 않는다');
}

/* ── findCloudflared ── */
{
  eq(findCloudflared({ run: () => ({ status: 0, stdout: 'C:\\tools\\cloudflared.exe\r\nC:\\other\\cloudflared.exe\r\n' }), exists: () => false }), 'C:\\tools\\cloudflared.exe', 'PATH 의 첫 번째');
  eq(findCloudflared({ run: () => ({ status: 1, stdout: '' }), exists: (p) => p.includes('(x86)') }), 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', '설치 프로그램 기본 위치');
  eq(findCloudflared({ run: () => ({ status: 1, stdout: '' }), exists: () => false }), '', '없을 때');
}

/* ── doctor (가짜 실행기·가짜 fetch) ── */
const res = (status, headers = {}, body = '') => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
});
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
  const runOut = {
    schtasks: { status: 0, stdout: '' },
    powershell: { status: 0, stdout: 'Running\r\n' },
    where: { status: 0, stdout: 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe\r\n' },
    cloudflared: { status: 0, stdout: 'cloudflared version 2026.10.0 (built 2026-10-01)' },
    ...(over.run || {}),
  };
  return {
    platform: 'win32',
    nodeVersion: over.nodeVersion || '22.11.0',
    load: () => ({ ...cfg, ...(over.cfg || {}) }),
    interfaces: { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.0.10' }] },
    connect: async (host) => (over.lanOpen ? host === '192.168.0.10' : false),
    run: (argv) => {
      const key = /cloudflared/i.test(argv[0]) ? 'cloudflared' : argv[0];
      return runOut[key] || { status: 1, stdout: '' };
    },
    fetchFn: async (url) => {
      if (!(url in routes)) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; }
      const r = routes[url];
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const level = (rs, name) => (rs.find((r) => r.name === name) || {}).level;
const fails = (rs) => rs.filter((r) => r.level === 'fail').map((r) => r.name);
{
  const good = await doctor({ envFile: ENVF }, fakeDeps());
  eq(fails(good), [], '정상 설치인데 실패가 나왔다');
  eq(level(good, '바깥 주소 /admin/'), 'ok', '/admin/ 의 Access 를 보지 않는다');
  eq(level(good, '터널 연결'), 'ok', '/ready 200 을 연결로 보지 않는다');

  const exposed = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'https://wb.example.com/admin/': res(200, { 'x-robots-tag': 'noindex' }) } }));
  const ex = exposed.find((r) => r.name === '바깥 주소 /admin/');
  ok(ex.level === 'fail' && /위험/.test(ex.msg), 'Access 없이 열린 /admin/ 을 위험으로 잡지 못한다');

  const student = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:8890/api/login': res(200) } }));
  eq(level(student, '관리 전용'), 'fail', '학생 로그인이 열린 서버를 통과시켰다');

  const lan = await doctor({ envFile: ENVF }, fakeDeps({ lanOpen: true }));
  eq(level(lan, 'LAN 차단'), 'fail', 'LAN 에 열린 서버를 통과시켰다');

  const down = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:8890/api/health': new TypeError('fetch failed') } }));
  eq(level(down, '로컬 서버'), 'fail', '서버가 안 떠 있는데 통과시켰다');

  const oldCf = await doctor({ envFile: ENVF }, fakeDeps({ run: { cloudflared: { status: 0, stdout: 'cloudflared version 2025.11.1' } } }));
  eq(level(oldCf, 'cloudflared 버전'), 'fail', '토큰을 레지스트리에 남기는 옛 cloudflared 를 통과시켰다');

  const noSvc = await doctor({ envFile: ENVF }, fakeDeps({ run: { powershell: { status: 0, stdout: '' }, schtasks: { status: 1, stdout: '' } } }));
  eq(level(noSvc, 'cloudflared 서비스'), 'fail', '설치되지 않은 cloudflared 서비스를 통과시켰다');
  eq(level(noSvc, '작업 스케줄러'), 'fail', '등록되지 않은 작업을 통과시켰다');

  const notReady = await doctor({ envFile: ENVF }, fakeDeps({ routes: { 'http://127.0.0.1:20241/ready': res(503) } }));
  eq(level(notReady, '터널 연결'), 'fail', '/ready 503 을 통과시켰다');

  const badCfg = await doctor({ envFile: ENVF }, fakeDeps({ cfg: { errors: ['DATA_DIR 이 비어 있습니다'] } }));
  eq(level(badCfg, '설정 파일'), 'fail', '틀린 설정 파일을 통과시켰다');

  const oldNode = await doctor({ envFile: ENVF }, fakeDeps({ nodeVersion: '20.11.0' }));
  eq(level(oldNode, 'Node.js'), 'fail', 'Node 20 을 통과시켰다');

  const noHost = await doctor({ envFile: ENVF }, fakeDeps({ cfg: { publicHost: '' } }));
  eq(level(noHost, '바깥 주소'), 'warn', '바깥 주소가 없을 때 알려주지 않는다');
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 설치 도구: 설정·자료 폴더 잠금(SID) · 작업 정의(UTF-16·SYSTEM·무제한·5분 감시) · 토큰 비노출 · 점검이 열림·LAN·학생 로그인·옛 cloudflared 를 실패로 잡음');
