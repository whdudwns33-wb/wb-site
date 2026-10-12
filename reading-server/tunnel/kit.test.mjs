#!/usr/bin/env node
/* 터널 키트 순수 로직 — node reading-server/tunnel/kit.test.mjs
 *
 * 원장 PC(Windows)에서만 도는 도구라 CI(Linux)는 Windows 를 못 돌린다. 그래서 판단은 전부 kit.mjs 에
 * 모아 두고 여기서 Windows 경로까지 넣어 확인한다. 특히 지키는 것:
 *  - 비밀이 든 설정 파일·자료 폴더가 저장소 안이면 거절 (대소문자만 다른 Windows 경로 포함)
 *  - 관리 전용·루프백을 파일로 끌 수 없다 — 꺼져 있으면 조용히 덮지 않고 멈춘다
 *  - 오류 문구에 비밀 값이 실리지 않는다 (로그·화면에 남는다)
 *  - 바깥 주소 판정에서 "Access 없이 200" 을 위험으로 잡는다
 */
import {
  parseEnvFile, isInside, validateServerEnv, buildChildEnv, nextRestart, logFileName, logsToPrune,
  envTemplate, classifyProbe, MIN_PIN, LOOPBACK, parseCloudflaredVersion, cloudflaredOk, pickNodeExe, inOneDrive, STABLE_NODE,
  taskXml, sharedFolderReason, folderState, ENV_DIR_OWN, DATA_DIR_OWN, appCopyKeep, aclProblems, aclScript, driveLetter,
} from './kit.mjs';

const errors = [];
const ok = (c, m) => { if (!c) errors.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

/* ── parseEnvFile ── */
{
  const r = parseEnvFile('\uFEFF# 주석\r\nADMIN_ID=wonjang\r\nADMIN_PASSWORD="  a#b$c = d  "\r\n\r\nDATA_DIR=C:\\WB data\r\n');
  eq(r.errors, [], 'BOM·CRLF·주석·빈 줄이 오류를 낸다');
  eq(r.vars.ADMIN_ID, 'wonjang', '평범한 값');
  eq(r.vars.ADMIN_PASSWORD, '  a#b$c = d  ', '따옴표 안의 공백·#·$·= 를 그대로 읽어야 한다');
  eq(r.vars.DATA_DIR, 'C:\\WB data', 'Windows 경로의 \\ 와 공백');
  const d = parseEnvFile('ADMIN_PIN=a\nADMIN_PIN=b\n');
  ok(d.errors.length === 1 && /두 번/.test(d.errors[0]), '같은 키 두 번을 오류로 잡지 않는다');
  const d2 = parseEnvFile('ADMIN_PIN=secret-value-1\nADMIN_PIN=secret-value-2\n');
  ok(!/secret-value/.test(d2.errors.join(' ')), '오류 문구에 값이 실렸다');
  ok(parseEnvFile('admin_pin=x').errors.length === 1, '소문자 키를 받았다');
  ok(/ADMIN_PIN 처럼 대문자로/.test(parseEnvFile('admin_pin=x').errors[0]), '알려진 키를 소문자로 적었을 때 바른 이름을 알려주지 않는다');
  /* '=' 를 빠뜨리거나 비밀번호만 따로 적은 줄 — 키 자리에 비밀이 들어간다. 그 글자를 되풀이하면 안 된다 */
  for (const bad of ['ADMIN_PASSWORD Tr0ub4dor&3xyzq=', 'Wb7xQ=2026!', 'Kx9#pQ2zLm7wR4v==']) {
    const r = parseEnvFile(bad);
    ok(r.errors.length === 1, `틀린 줄을 오류로 잡지 않았다: ${bad.length}자`);
    ok(!/Tr0ub4dor|Wb7xQ|Kx9#pQ2z/.test(r.errors.join(' ')), '틀린 키 이름 자리의 글자(비밀일 수 있다)를 오류에 실었다');
  }
  ok(parseEnvFile('그냥 문장').errors.length === 1, 'KEY=값 이 아닌 줄을 받았다');
  ok(parseEnvFile('=x').errors.length === 1, '빈 키를 받았다');
}

/* ── isInside (Windows 규칙) ── */
{
  ok(isInside('C:\\Users\\wb\\wb-site\\x.env', 'C:\\Users\\wb\\wb-site', 'win32'), '저장소 안 파일을 못 잡았다');
  ok(isInside('c:\\users\\WB\\WB-SITE\\data', 'C:\\Users\\wb\\wb-site', 'win32'), '대소문자만 다른 Windows 경로를 못 잡았다');
  ok(!isInside('C:\\Users\\wb\\wb-site-data', 'C:\\Users\\wb\\wb-site', 'win32'), '이름 앞부분이 같은 형제 폴더를 안으로 봤다');
  ok(!isInside('C:\\ProgramData\\WB\\server.env', 'C:\\Users\\wb\\wb-site', 'win32'), 'ProgramData 를 안으로 봤다');
  ok(!isInside('D:\\wb-site\\x', 'C:\\wb-site', 'win32'), '다른 드라이브를 안으로 봤다');
  ok(isInside('/home/a/repo/data', '/home/a/repo', 'linux'), 'posix 안쪽');
  ok(!isInside('/home/a/repo2', '/home/a/repo', 'linux'), 'posix 형제');
}

/* ── validateServerEnv ── */
const REPO = 'C:\\Users\\wb\\wb-site';
const ENVF = 'C:\\ProgramData\\WB\\server.env';
const good = { ADMIN_ID: 'wonjang', ADMIN_PASSWORD: 'correct horse battery', DATA_DIR: 'C:\\WB_server_data' };
const v = (vars, envFile = ENVF) => validateServerEnv({ vars, envFile, repoRoot: REPO, platform: 'win32' });
{
  const r = v(good);
  eq(r.errors, [], '정상 설정이 거절됐다');
  eq(r.port, 8890, '기본 포트');
  eq(r.logDir, 'C:\\WB_server_data\\logs', '기본 로그 폴더');
  ok(v(good, REPO + '\\server.env').errors.some((e) => /저장소 폴더 안/.test(e)), '저장소 안 설정 파일을 받았다');
  ok(v({ ...good, DATA_DIR: REPO + '\\reading-server\\data' }).errors.some((e) => /DATA_DIR 이 저장소/.test(e)), '저장소 안 DATA_DIR 을 받았다');
  ok(v({ ...good, DATA_DIR: 'data' }).errors.some((e) => /전체 경로/.test(e)), '상대 경로 DATA_DIR 을 받았다');
  ok(v({ ...good, DATA_DIR: '' }).errors.some((e) => /DATA_DIR 이 비어/.test(e)), '빈 DATA_DIR 을 받았다');
  ok(v({ DATA_DIR: 'C:\\d' }).errors.some((e) => /관리 로그인이 없습니다/.test(e)), '관리 로그인 없음을 받았다');
  const shortPin = 'x'.repeat(MIN_PIN - 1);
  const rp = v({ DATA_DIR: 'C:\\d', ADMIN_PIN: shortPin });
  ok(rp.errors.some((e) => /ADMIN_PIN/.test(e)), '짧은 PIN 을 받았다');
  ok(!rp.errors.join(' ').includes(shortPin), '오류 문구에 PIN 값이 실렸다');
  eq(v({ DATA_DIR: 'C:\\d', ADMIN_PIN: 'x'.repeat(MIN_PIN) }).errors, [], '16자 PIN 이 거절됐다');
  ok(v({ ...good, ADMIN_PASSWORD: 'short' }).errors.some((e) => /ADMIN_PASSWORD/.test(e)), '짧은 비밀번호를 받았다');
  ok(v({ DATA_DIR: 'C:\\d', ADMIN_ID: 'a' }).errors.some((e) => /둘 다/.test(e)), '아이디만 있는 설정을 받았다');
  ok(v({ ...good, WB_ADMIN_ONLY: '0' }).errors.some((e) => /WB_ADMIN_ONLY/.test(e)), '관리 전용을 끄는 설정을 받았다');
  eq(v({ ...good, WB_ADMIN_ONLY: '1' }).errors, [], 'WB_ADMIN_ONLY=1 을 적어 둔 것은 받아야 한다');
  ok(v({ ...good, HOST: '0.0.0.0' }).errors.some((e) => /HOST/.test(e)), '모든 주소에 묶는 설정을 받았다');
  eq(v({ ...good, HOST: LOOPBACK }).errors, [], 'HOST=127.0.0.1 을 적어 둔 것은 받아야 한다');
  ok(v({ ...good, PORT: '80' }).errors.some((e) => /PORT/.test(e)), '1024 미만 포트를 받았다');
  ok(v({ ...good, PORT: 'abc' }).errors.some((e) => /PORT/.test(e)), '숫자 아닌 포트를 받았다');
  eq(v({ ...good, PORT: '9000' }).port, 9000, '포트 지정');
  ok(v({ ...good, LOG_DIR: 'logs' }).errors.some((e) => /LOG_DIR/.test(e)), '상대 경로 LOG_DIR 을 받았다');
  ok(validateServerEnv({ vars: { ...good, NODE_OPTIONS: '--require x' }, envFile: ENVF, repoRoot: REPO, platform: 'win32', lineOf: { NODE_OPTIONS: 7 } })
    .errors.some((e) => /7번째 줄/.test(e) && /쓰지 않는 키/.test(e)), 'NODE_OPTIONS 를 받았다 — SYSTEM 으로 도는 서버에 임의 코드를 싣는 길');
  ok(v({ ...good, PATH: 'C:\\evil' }).errors.some((e) => /쓰지 않는 키/.test(e)), 'PATH 를 받았다');
  eq(v({ ...good, ANTHROPIC_API_KEY: 'k' }).errors, [], '서버가 쓰는 선택 키(AI)를 거절했다');
  ok(v({ ...good, DATA_DIR: 'C:\\Users\\wb' }).errors.some((e) => /저장소를 품고|사용자 폴더/.test(e)), '저장소를 품은 DATA_DIR 을 받았다 — 잠그면 저장소까지 잠긴다');
  ok(v({ ...good, DATA_DIR: 'D:\\' }).errors.some((e) => /드라이브 뿌리/.test(e)), '드라이브 뿌리를 DATA_DIR 로 받았다');
  ok(v({ ...good, DATA_DIR: 'C:\\Users\\other\\Desktop' }).errors.some((e) => /사용자 폴더/.test(e)), '바탕 화면을 DATA_DIR 로 받았다 — 원장 파일이 잠긴다');
  ok(v({ ...good, DATA_DIR: 'C:\\Windows\\Temp\\wb' }).errors.some((e) => /시스템 폴더/.test(e)), 'Windows 폴더를 받았다');
  eq(v({ ...good, DATA_DIR: 'C:\\Users\\wb\\WB_data\\server' }).errors, [], '사용자 폴더 아래의 전용 폴더(저장소와 별개)를 거절했다');
  ok(v({ ...good, DATA_DIR: '\\\\nas\\wb' }).errors.some((e) => /네트워크 경로/.test(e)), 'NAS(UNC) 경로를 DATA_DIR 로 받았다 — SYSTEM 은 NAS 에 못 붙는다');
  ok(v({ ...good, DATA_DIR: 'C:\\Users\\wb\\OneDrive - 학원\\data' }).errors.some((e) => /OneDrive/.test(e)), 'OneDrive 폴더를 DATA_DIR 로 받았다 — 라이선스 팩이 클라우드로 간다');
  eq(v({ ...good, DATA_DIR: 'C:\\WB_onedrive_free' }).errors, [], 'OneDrive 가 이름 일부에만 든 폴더를 막았다');
  eq(v({ ...good, PUBLIC_HOST: 'WB.Example.com' }).publicHost, 'wb.example.com', 'PUBLIC_HOST 소문자화');
  ok(v({ ...good, PUBLIC_HOST: 'https://wb.example.com/' }).errors.some((e) => /PUBLIC_HOST/.test(e)), 'https:// 가 붙은 PUBLIC_HOST 를 받았다');
  ok(v({ ...good, PUBLIC_HOST: 'localhost' }).errors.some((e) => /PUBLIC_HOST/.test(e)), '점 없는 PUBLIC_HOST 를 받았다');
}

/* ── buildChildEnv ── */
{
  /* Windows 는 환경 변수 이름의 대소문자를 가리지 않는다 — 셸의 admin_pin 이 자식에서 ADMIN_PIN 으로 읽힌다 */
  const ci = buildChildEnv({ admin_pin: '1234', Admin_Password: 'old', Host: '0.0.0.0', wb_admin_only: '0', Port: '1', data_dir: 'C:\\evil', Path: 'C:\\Windows' },
    { ADMIN_ID: 'a', ADMIN_PASSWORD: 'b', DATA_DIR: 'C:\\d' }, 8890);
  ok(!Object.keys(ci).some((k) => /^admin_/i.test(k) && ci[k] !== ({ ADMIN_ID: 'a', ADMIN_PASSWORD: 'b' })[k]), '셸에 남은 소문자 admin_* 가 서버로 넘어갔다 — Windows 에서는 ADMIN_PIN 으로 읽힌다');
  ok(!('Host' in ci) && !('wb_admin_only' in ci) && !('Port' in ci) && !('data_dir' in ci), '대소문자만 다른 HOST·WB_ADMIN_ONLY·PORT·DATA_DIR 이 넘어갔다');
  eq(ci.Path, 'C:\\Windows', 'Windows 의 Path 를 버렸다');
  const nodeOpt = buildChildEnv({}, { ADMIN_PIN: 'x'.repeat(20), DATA_DIR: 'C:\\d', NODE_OPTIONS: '--require evil' }, 8890);
  ok(!('NODE_OPTIONS' in nodeOpt), '설정 파일의 NODE_OPTIONS 가 서버로 넘어갔다');
}
{
  const env = buildChildEnv({ PATH: 'p', ADMIN_PIN: 'old-shell-pin', HOST: '0.0.0.0', WB_ADMIN_ONLY: '0', SystemRoot: 'C:\\Windows' },
    { ADMIN_ID: 'a', ADMIN_PASSWORD: 'b', DATA_DIR: 'C:\\d', LOG_DIR: 'C:\\l' }, 8890);
  eq(env.PATH, 'p', 'PATH 를 넘기지 않았다');
  eq(env.SystemRoot, 'C:\\Windows', 'Windows 가 필요한 SystemRoot 를 버렸다');
  ok(!('ADMIN_PIN' in env), '셸에 남은 옛 PIN 이 서버로 넘어갔다');
  eq(env.WB_ADMIN_ONLY, '1', '관리 전용이 강제되지 않았다');
  eq(env.HOST, LOOPBACK, '루프백이 강제되지 않았다');
  eq(env.PORT, '8890', '포트');
  ok(!('LOG_DIR' in env), '실행기 전용 LOG_DIR 이 서버로 넘어갔다');
}

/* ── nextRestart ── */
{
  const t0 = 1_000_000_000;
  let h = [];
  const delays = [];
  for (let i = 0; i < 6; i++) { const r = nextRestart(h, t0 + i * 1000, t0 + i * 1000 - 500); h = r.history; delays.push(r.delayMs); }
  eq(delays, [2000, 4000, 8000, 16000, 32000, 60000], '연달아 죽을 때 간격이 늘지 않는다');
  const long = nextRestart(h, t0 + 10_000, t0 + 10_000 - 6 * 60 * 1000);
  eq(long.delayMs, 2000, '5분 넘게 돌다 죽었으면 처음 간격으로 돌아가야 한다');
  let h2 = [];
  let last;
  for (let i = 0; i < 10; i++) { last = nextRestart(h2, t0 + i * 1000, t0 + i * 1000); h2 = last.history; }
  eq(last.delayMs, 600000, '10분 안에 10번 죽으면 10분을 쉬어야 한다');
}

/* ── 로그 이름·정리 ── */
{
  eq(logFileName(new Date(2026, 0, 5)), 'server-2026-01-05.log', '로그 파일 이름');
  const names = ['server-2026-10-01.log', 'server-2026-09-28.log', 'server-2026-09-29.log', 'notes.txt', 'server-x.log'];
  eq(logsToPrune(names, new Date(2026, 9, 12), 14), ['server-2026-09-28.log'], '14일 넘은 로그만 지워야 한다(다른 파일은 건드리지 않는다)');
}

/* ── 견본 ── */
{
  const t = envTemplate({ dataDir: 'C:\\WB_server_data' });
  const r = parseEnvFile(t);
  eq(r.errors, [], '견본이 자기 파서를 통과하지 못한다');
  ok(/\r\n/.test(t), 'Windows 메모장용 CRLF 가 아니다');
  ok(!/^WB_ADMIN_ONLY=|^HOST=/m.test(t), '견본에 관리 전용·HOST 줄이 있으면 사람이 고칠 수 있다고 오해한다');
  ok(validateServerEnv({ vars: r.vars, envFile: ENVF, repoRoot: REPO, platform: 'win32' }).errors.some((e) => /관리 로그인/.test(e)),
    '빈 견본이 그대로 통과한다 — 비밀번호를 안 채워도 뜬다');
}

/* ── classifyProbe ── */
{
  eq(classifyProbe({ status: 302, location: 'https://wb-team.cloudflareaccess.com/cdn-cgi/access/login/wb.example.com?kid=x&redirect_url=%2F' }).state, 'access-ok', 'Access 리디렉트');
  eq(classifyProbe({ status: 302, location: 'https://wb-team.cloudflareaccess.com/somewhere-else' }).state, 'unknown', '로그인 경로가 아닌 cloudflareaccess.com 리디렉트를 Access 로 봤다');
  eq(classifyProbe({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://wb.example.com/.well-known/cloudflare-access-protected-resource/"' }).state, 'access-ok', 'Managed OAuth 401');
  eq(classifyProbe({ status: 401 }).state, 'unknown', '아무 401 이나 Access 로 봤다');
  eq(classifyProbe({ status: 403, body: '' }).state, 'guard-only', '빈 본문 403(토큰 검사만 있고 Access 없음)');
  const exposed = classifyProbe({ status: 200, robots: 'noindex, nofollow, noarchive' });
  ok(exposed.state === 'exposed' && exposed.danger, 'Access 없이 열린 상태를 위험으로 잡지 못한다');
  eq(classifyProbe({ status: 530 }).state, 'tunnel-down', '530');
  eq(classifyProbe({ status: 404, body: 'error code: 1033' }).state, 'tunnel-down', '1033 본문');
  eq(classifyProbe({ status: 502 }).state, 'origin-down', '502');
  eq(classifyProbe({ errorCode: 'ENOTFOUND' }).state, 'dns-missing', 'DNS 없음');
  eq(classifyProbe({ errorCode: 'ECONNRESET' }).state, 'unreachable', '연결 실패');
  eq(classifyProbe({ status: 302, location: 'https://evil.example/x.cloudflareaccess.com/' }).state, 'unknown', 'cloudflareaccess.com 을 경로에 넣은 가짜 리디렉트를 Access 로 봤다');
  eq(classifyProbe({ status: 302, location: 'https://wb.cloudflareaccess.com.evil.example/' }).state, 'unknown', 'cloudflareaccess.com 뒤에 붙인 가짜 호스트를 Access 로 봤다');
  eq(classifyProbe({ status: 200, robots: '' }).state, 'unknown', '우리 서버가 아닌 200 을 위험으로 단정했다');
}

/* ── 작업에 적을 node.exe ── */
{
  eq(pickNodeExe('C:\\Program Files\\nodejs\\node.exe', () => true).nodeExe, 'C:\\Program Files\\nodejs\\node.exe', 'MSI 자리는 그대로');
  const z = 'C:\\Users\\wb\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenJS\\node-v24.20.0-win-x64\\node.exe';
  const a = pickNodeExe(z, (p) => p === STABLE_NODE, () => '22.11.0');
  ok(a.nodeExe === STABLE_NODE && a.warning, '버전 붙은 자리 대신 MSI 자리를 고르지 않는다');
  const old = pickNodeExe(z, (p) => p === STABLE_NODE, () => '18.20.4');
  ok(old.nodeExe === z && /v18/.test(old.warning), 'MSI 자리의 Node 18 을 골랐다 — 작업이 18 로 돌아 관리 로그인이 깨진다');
  const custom = pickNodeExe('D:\\tools\\node22\\node.exe', () => true, () => '18.0.0');
  eq(custom.nodeExe, 'D:\\tools\\node22\\node.exe', '버전 안 붙은 자리를 몰래 MSI 자리로 바꿨다');
  const b = pickNodeExe(z, () => false);
  ok(b.nodeExe === z && /MSI/.test(b.warning), 'MSI 자리가 없을 때 경고하지 않는다');
  ok(inOneDrive('C:\\Users\\wb\\OneDrive\\Desktop\\wb-site') && !inOneDrive('C:\\WB\\wb-site'), 'OneDrive 판정');
}

/* ── 작업 정의는 전체 경로만 ── */
{
  let threw = false;
  try { taskXml({ nodeExe: 'C:\\Program Files\\nodejs\\node.exe', runScript: 'C:\\a\\run-server.mjs', envFile: 'server.env', workDir: 'C:\\a' }); } catch { threw = true; }
  ok(threw, '상대 경로 설정 파일을 작업 정의에 적었다 — SYSTEM 이 엉뚱한 자리에서 찾고 로그도 없이 죽는다');
}

/* ── 잠그면 안 되는 자리·폴더 상태 ── */
{
  eq(sharedFolderReason('C:\\ProgramData\\WB', 'win32'), '', '기본 설정 폴더를 막았다');
  ok(sharedFolderReason('C:\\ProgramData', 'win32'), 'ProgramData 자체를 받았다');
  ok(sharedFolderReason('C:\\Users\\wb\\Documents', 'win32'), '문서 폴더를 받았다');
  ok(sharedFolderReason('C:\\', 'win32'), 'C:\\ 를 받았다');
  eq(folderState(null, ENV_DIR_OWN), 'absent', '없는 폴더');
  eq(folderState([], ENV_DIR_OWN), 'empty', '빈 폴더');
  eq(folderState(['server.env', 'app', 'tunnel-token.txt', 'run-server-error.log'], ENV_DIR_OWN), 'ours', '우리 것만');
  eq(folderState(['server.env', '학원자료.hwp'], ENV_DIR_OWN), 'foreign', '남의 파일이 섞인 설정 폴더');
  eq(folderState(['db.json', 'backups', 'logs', 'letter-img'], DATA_DIR_OWN), 'ours', '서버 자료만');
  eq(folderState(['db.json', '수업계획.xlsx'], DATA_DIR_OWN), 'foreign', '남의 파일이 섞인 자료 폴더');
}

/* ── 코드 사본에서 뺄 것 ── */
{
  ok(appCopyKeep('reading-server/server.mjs') && appCopyKeep('letter/img/a.svg'), '필요한 파일을 뺐다');
  ok(!appCopyKeep('reading-server/data/db.json'), '로컬 학생 기록(reading-server/data)을 사본에 넣었다');
  ok(!appCopyKeep('reading-server/dist/x.js') && !appCopyKeep('reading-server\\dist'), '빌드 산출물을 넣었다');
  ok(!appCopyKeep('reading/.git/HEAD') && !appCopyKeep('letter/node_modules/x'), '.git·node_modules 를 넣었다');
}

/* ── 폴더 권한 읽기 ── */
{
  const good2 = aclProblems('OWNER|S-1-5-32-544\r\nACE|S-1-5-32-544|Allow|2032127|False\r\nACE|S-1-5-18|Allow|2032127|False\r\n');
  ok(good2.readable && good2.ownerOk && !good2.foreign.length, '관리자·SYSTEM 만인 권한을 문제로 봤다');
  const leak = aclProblems('OWNER|S-1-5-21-1-2-3-1001\nACE|S-1-5-32-544|Allow|2032127|False\nACE|S-1-5-32-545|Allow|1179817|True\nACE|S-1-5-11|Deny|1|False');
  ok(!leak.ownerOk, '일반 사용자가 주인인 폴더를 통과시켰다 — 그 사람이 권한을 되돌릴 수 있다');
  eq(leak.foreign, ['S-1-5-32-545'], 'Users 의 허용 항목을 잡지 못했다(거부 항목은 문제가 아니다)');
  ok(!aclProblems('').readable, '빈 출력을 읽힌 것으로 봤다');
  ok(/-LiteralPath 'C:\\it''s'/.test(aclScript("C:\\it's")), 'PowerShell 경로의 작은따옴표를 이스케이프하지 않았다');
  eq(driveLetter('Z:\\WB'), 'Z', '드라이브 글자');
  eq(driveLetter('\\\\nas\\wb'), '', 'UNC 는 드라이브 글자가 없다');
}

/* ── cloudflared 버전 ── */
{
  eq(parseCloudflaredVersion('cloudflared version 2026.10.0 (built 2026-10-01-1200 UTC)'), [2026, 10, 0], '버전 읽기');
  ok(cloudflaredOk('cloudflared version 2026.10.0'), '2026.10.0 을 옛 버전으로 봤다');
  ok(cloudflaredOk('cloudflared version 2026.7.3'), '경계 2026.7.3 을 거절했다');
  ok(!cloudflaredOk('cloudflared version 2026.7.2'), '2026.7.2 를 받았다 — 토큰이 레지스트리에 남는 버전');
  ok(!cloudflaredOk('cloudflared version 2025.12.9'), '2025 버전을 받았다');
  ok(cloudflaredOk('cloudflared version 2027.1.0'), '다음 해 버전을 거절했다');
  ok(!cloudflaredOk(''), '버전을 못 읽었는데 받았다');
}

if (errors.length) {
  console.error('실패 ' + errors.length + '건');
  errors.forEach((m) => console.error('  - ' + m));
  process.exit(1);
}
console.log('OK — 터널 키트 순수 로직(설정 파일·Windows 경로·관리 전용 강제·재시작 간격·로그 정리·바깥 주소 판정)');
