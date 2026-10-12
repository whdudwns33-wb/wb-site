/* 원장 PC 를 관리 서버로 — 터널 키트의 순수 로직.
   결정과 이유: docs/로컬-서버-외부공개-터널.md (결정 A — 터널은 원장·강사 전용, 학생은 운영 워커)
   쓰는 법:     reading-server/tunnel/README.md

   여기에는 부작용이 없다(파일·프로세스·망을 만지지 않는다). 실행기(run-server.mjs)와 설치 도구
   (setup.mjs)가 이 함수들을 불러 쓰고, 테스트(kit.test.mjs)가 Linux CI 에서 Windows 경로까지 확인한다.
   Windows 에서만 도는 명령(schtasks·sc·icacls)은 "무엇을 실행할지"만 여기서 만들고 실행은 setup.mjs 가 한다
   — 실행 부분을 얇게 두어야 CI 가 못 도는 Windows 쪽에서 틀릴 자리가 줄어든다. */
import path from 'node:path';

export const DEFAULT_PORT = 8890;
export const LOOPBACK = '127.0.0.1';
/* 작업 스케줄러 이름은 ASCII 로 둔다 — schtasks 출력·로그를 코드 페이지가 다른 콘솔에서 읽어도 깨지지 않게 */
export const TASK_NAME = 'WB-Admin-Server';
/* 외부에 열리는 서버다(Access 뒤라도). 관리 비밀 하나가 학생 기록 전체를 연다 — 짧으면 받지 않는다. */
export const MIN_PIN = 16;
export const MIN_PASSWORD = 12;
export const LOG_KEEP_DAYS = 14;

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const isHostname = (h) => HOST_RE.test(String(h || '').trim().toLowerCase());
const TRUE_RE = /^(1|true|yes|on)$/i;

/* ── 설정 파일(server.env) ─────────────────────────────────────────────
   KEY=VALUE 한 줄에 하나. # 으로 시작하는 줄은 주석. 값은 따옴표로 감쌀 수 있다(감싸면 앞뒤 공백 보존).
   변수 치환·여러 줄 값은 없다 — 비밀번호에 $ 나 # 이 들어가도 그대로 읽혀야 해서 일부러 단순하게 둔다.
   같은 키가 두 번 나오면 오류다: 어느 쪽이 쓰였는지 사람이 알 수 없으면 비밀번호를 바꿔도 안 바뀐 줄 모른다. */
export function parseEnvFile(text) {
  const vars = {};
  const errors = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq <= 0) { errors.push(`${i + 1}번째 줄: KEY=값 모양이 아닙니다`); return; }
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!KEY_RE.test(key)) { errors.push(`${i + 1}번째 줄: 키 이름 "${key}" 은 영문 대문자·숫자·밑줄만 씁니다`); return; }
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(vars, key)) { errors.push(`${i + 1}번째 줄: ${key} 가 두 번 적혀 있습니다 — 하나만 남기세요`); return; }
    vars[key] = val;
  });
  return { vars, errors };
}

/* 경로 비교는 운영체제 규칙을 따른다 — Windows 는 대소문자를 가리지 않고 구분자가 \ 다.
   CI(Linux)에서도 Windows 경로를 검사할 수 있게 platform 을 받는다. */
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
export function isInside(child, parent, platform = process.platform) {
  const p = pathFor(platform);
  let a = p.resolve(child);
  let b = p.resolve(parent);
  if (platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  const rel = p.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/* 실행기가 서버를 띄우기 전에 보는 것. 값(비밀)은 메시지에 절대 싣지 않는다 — 로그·화면에 남는다.
   돌려주는 errors 가 하나라도 있으면 띄우지 않는다. */
export function validateServerEnv({ vars, envFile, repoRoot, platform = process.platform }) {
  const p = pathFor(platform);
  const v = vars || {};
  const errors = [];
  const warnings = [];

  if (envFile && repoRoot && isInside(envFile, repoRoot, platform)) {
    errors.push('설정 파일이 저장소 폴더 안에 있습니다 — 비밀번호가 커밋될 수 있습니다. 저장소 밖(예: C:\\ProgramData\\WB\\server.env)으로 옮기세요');
  }

  const dataDir = (v.DATA_DIR || '').trim();
  if (!dataDir) errors.push('DATA_DIR 이 비어 있습니다 — 학생 기록·팩이 저장될 폴더(저장소 밖)를 적으세요');
  else if (!p.isAbsolute(dataDir)) errors.push('DATA_DIR 은 전체 경로로 적습니다(예: C:\\WB_server_data)');
  else if (repoRoot && isInside(dataDir, repoRoot, platform)) errors.push('DATA_DIR 이 저장소 폴더 안입니다 — git 정리 한 번에 지워질 수 있고 커밋될 수 있습니다. 저장소 밖으로 옮기세요');
  else if (/^\\\\|^\/\//.test(dataDir)) errors.push('DATA_DIR 에 네트워크 경로(\\\\NAS\\…)를 쓰지 않습니다 — SYSTEM 으로 도는 서버는 NAS 에 붙지 못하고, 끊기면 저장이 실패합니다. 이 PC 디스크에 두고 NAS 는 백업 대상으로만');
  else if (/[\\/]onedrive[^\\/]*([\\/]|$)/i.test(dataDir)) errors.push('DATA_DIR 이 OneDrive 폴더 안입니다 — 학생 기록·라이선스 팩이 클라우드로 동기화됩니다(원장 결정: 클라우드 동기화 폴더 금지). C:\\WB_server_data 처럼 밖으로');

  const pin = v.ADMIN_PIN || '';
  const id = v.ADMIN_ID || '';
  const pw = v.ADMIN_PASSWORD || '';
  if (!pin && !id && !pw) errors.push('관리 로그인이 없습니다 — ADMIN_PIN 또는 ADMIN_ID·ADMIN_PASSWORD 를 적으세요');
  if (pin && pin.length < MIN_PIN) errors.push(`ADMIN_PIN 이 ${MIN_PIN}자보다 짧습니다 — 외부에 열리는 서버라 짧은 PIN 은 받지 않습니다`);
  if ((id && !pw) || (!id && pw)) errors.push('ADMIN_ID 와 ADMIN_PASSWORD 는 둘 다 적거나 둘 다 비웁니다');
  if (id && pw && pw.length < MIN_PASSWORD) errors.push(`ADMIN_PASSWORD 가 ${MIN_PASSWORD}자보다 짧습니다`);

  /* 이 실행기는 관리 전용·루프백으로만 띄운다. 파일에 다르게 적혀 있으면 조용히 덮지 않고 멈춘다 —
     덮어 버리면 "파일에는 0 이라고 적었는데 왜 막히지" 가 되고, 반대로 지우는 사람도 생긴다. */
  if (v.WB_ADMIN_ONLY != null && !TRUE_RE.test(v.WB_ADMIN_ONLY)) errors.push('WB_ADMIN_ONLY 를 끌 수 없습니다 — 이 실행기는 관리 전용으로만 띄웁니다(학생은 운영 워커). 줄을 지우세요');
  if (v.HOST != null && v.HOST.trim() !== LOOPBACK) errors.push(`HOST 는 ${LOOPBACK} 만 됩니다 — 다른 주소에 묶으면 터널·Access 를 거치지 않는 입구가 생깁니다. 줄을 지우세요`);

  let port = DEFAULT_PORT;
  if (v.PORT != null && v.PORT !== '') {
    port = Number(v.PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('PORT 는 1024~65535 사이 정수입니다');
  }

  /* 바깥 주소 — 비밀이 아니다. setup.mjs doctor 가 이 주소로 Access 가 걸렸는지 확인한다. */
  const publicHost = (v.PUBLIC_HOST || '').trim().toLowerCase();
  if (publicHost && !HOST_RE.test(publicHost)) errors.push('PUBLIC_HOST 는 주소 이름만 적습니다(예: wb.내도메인.com — https:// 나 / 없이)');

  let logDir = (v.LOG_DIR || '').trim();
  if (logDir && !p.isAbsolute(logDir)) errors.push('LOG_DIR 은 전체 경로로 적습니다');
  if (!logDir && dataDir && p.isAbsolute(dataDir)) logDir = p.join(dataDir, 'logs');

  if (v.ANTHROPIC_API_KEY || v.GEMINI_API_KEY) warnings.push('AI 키가 들어 있습니다 — 관리 웹의 AI 초안 기능이 이 PC 에서 그 키로 호출합니다(국어 교재 원문은 외부 AI 로 보내지 않는 규칙은 그대로)');

  return { errors, warnings, port, dataDir, logDir, publicHost };
}

/* 서버 자식 프로세스에 줄 환경. 실행기를 띄운 셸에 남아 있던 관리 비밀·HOST 는 버리고 파일 값만 쓴다
   — 셸에 예전 PIN 이 남아 있으면 파일을 고쳐도 옛 값으로 뜨는 사고가 난다. */
export function buildChildEnv(baseEnv, vars, port) {
  const env = {};
  for (const [k, val] of Object.entries(baseEnv || {})) {
    if (/^ADMIN_/.test(k) || k === 'HOST' || k === 'WB_ADMIN_ONLY' || k === 'PORT' || k === 'DATA_DIR') continue;
    env[k] = val;
  }
  for (const [k, val] of Object.entries(vars || {})) if (k !== 'LOG_DIR' && k !== 'PUBLIC_HOST') env[k] = val;
  env.WB_ADMIN_ONLY = '1';
  env.HOST = LOOPBACK;
  env.PORT = String(port || DEFAULT_PORT);
  return env;
}

/* ── 재시작 간격 ──────────────────────────────────────────────────────
   서버가 죽으면 실행기가 다시 띄운다. 5분 넘게 잘 돌다 죽었으면 일시적 문제로 보고 처음부터(2초),
   연달아 죽으면 2·4·8·…·60초로 늘린다. 10분 안에 10번 죽으면 설정·디스크 문제일 가능성이 커서
   10분을 쉰다 — 같은 오류로 로그를 초당 수십 줄씩 채우지 않게. */
export function nextRestart(history, now, startedAt) {
  const ranMs = now - startedAt;
  const recent = (history || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  if (recent.length >= 10) return { delayMs: 10 * 60 * 1000, history: [] };
  if (ranMs >= 5 * 60 * 1000) return { delayMs: 2000, history: [now] };
  const n = recent.length; // 1, 2, 3 …
  return { delayMs: Math.min(60000, 2000 * 2 ** (n - 1)), history: recent };
}

/* ── 로그 파일 ─────────────────────────────────────────────────────────
   작업 스케줄러로 뜬 프로세스는 화면이 없다. 서버 출력을 날짜별 파일로 남기고 14일치만 둔다. */
const pad = (n) => String(n).padStart(2, '0');
export const dayStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const logFileName = (d) => `server-${dayStamp(d)}.log`;
export function logsToPrune(names, today, keepDays = LOG_KEEP_DAYS) {
  const cut = new Date(today.getFullYear(), today.getMonth(), today.getDate() - keepDays + 1);
  const cutStamp = dayStamp(cut);
  return (names || []).filter((n) => {
    const m = /^server-(\d{4}-\d{2}-\d{2})\.log$/.exec(n);
    return m && m[1] < cutStamp;
  });
}

/* ── 설정 파일 견본 ────────────────────────────────────────────────────
   값은 비워 둔다. 원장이 메모장으로 채운다(에이전트·채팅에 비밀을 적지 않게). */
export function envTemplate({ dataDir }) {
  return [
    '# WB 관리 서버 설정 — 이 파일은 저장소 밖에 둡니다(비밀번호가 들어 있어 커밋하면 안 됩니다).',
    '# 쓰는 법: reading-server/tunnel/README.md',
    '#',
    '# 관리 로그인 — 둘 중 하나. 외부에 열리는 서버라 PIN 은 16자 이상, 비밀번호는 12자 이상만 받습니다.',
    '# 운영 워커(wb-reading)와 같은 값을 쓰지 마세요 — 한쪽이 새도 다른 쪽은 지킵니다.',
    'ADMIN_ID=',
    'ADMIN_PASSWORD=',
    '# ADMIN_PIN=',
    '',
    '# 자료 폴더 — 저장소 밖, 백업은 NAS 로(클라우드 동기화 폴더는 쓰지 않습니다).',
    `DATA_DIR=${dataDir || ''}`,
    '',
    '# 포트 — 바꾸면 Cloudflare 터널의 서비스 주소(http://127.0.0.1:포트)도 같이 바꿉니다.',
    `PORT=${DEFAULT_PORT}`,
    '',
    '# 바깥 주소(비밀 아님) — 점검 도구가 Access 가 걸렸는지 확인할 때 씁니다. 예: wb.내도메인.com',
    'PUBLIC_HOST=',
    '',
    '# 관리 전용(WB_ADMIN_ONLY)과 묶을 주소(HOST=127.0.0.1)는 실행기가 강제합니다 — 적지 않습니다.',
    '',
  ].join('\r\n');
}

/* ── 바깥 주소 점검 ────────────────────────────────────────────────────
   쿠키 없이 https://<호스트>/ 를 한 번 불러 본 결과를 판정한다(리디렉트는 따라가지 않는다).
   가장 위험한 상태는 "200 이 온다" — 터널은 붙었는데 Access 가 안 걸려 관리 로그인 화면이 인터넷에
   그대로 열린 것이다. 이 서버는 모든 응답에 noindex 헤더를 붙이므로 200 + noindex 면 우리 서버다. */
export function classifyProbe({ status, location, robots, errorCode, body, wwwAuthenticate } = {}) {
  if (errorCode === 'ENOTFOUND' || errorCode === 'EAI_AGAIN') {
    return { state: 'dns-missing', ok: false, message: '호스트 이름이 DNS 에 없습니다 — Cloudflare 터널의 공개 호스트 이름(Public Hostname)을 확인하세요' };
  }
  if (errorCode) return { state: 'unreachable', ok: false, message: `바깥 주소에 닿지 못했습니다(${errorCode}) — 이 PC 의 인터넷 또는 주소를 확인하세요` };
  const loc = String(location || '');
  /* 주소 문자열에 cloudflareaccess.com 이 "들어 있는지"가 아니라 호스트가 그 도메인이고 로그인 경로인지 본다.
     cloudflared 자신도 "302 + Location 경로가 /cdn-cgi/access/login 으로 시작"으로 Access 를 알아본다. */
  let locHost = '';
  let locPath = '';
  try { const u = new URL(loc); locHost = u.hostname.toLowerCase(); locPath = u.pathname; } catch { /* 상대 주소·빈 값 */ }
  if ([301, 302, 303, 307, 308].includes(status) && locHost.endsWith('.cloudflareaccess.com') && locPath.startsWith('/cdn-cgi/access/login')) {
    return { state: 'access-ok', ok: true, message: 'Cloudflare Access 가 로그인을 요구합니다 — 정상' };
  }
  /* Access 응용에 Managed OAuth 를 켜면 브라우저가 아닌 요청에는 302 대신 401 + WWW-Authenticate 를 준다 */
  if (status === 401 && /cloudflare-access-protected-resource/i.test(String(wwwAuthenticate || ''))) {
    return { state: 'access-ok', ok: true, message: 'Cloudflare Access 가 로그인을 요구합니다(401 — Managed OAuth) — 정상' };
  }
  if (status === 530 || /error code:?\s*1033/i.test(String(body || ''))) {
    return { state: 'tunnel-down', ok: false, message: '터널이 연결되어 있지 않습니다(530/1033) — 이 PC 의 cloudflared 서비스를 확인하세요' };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { state: 'origin-down', ok: false, message: `터널은 붙었지만 서버가 응답하지 않습니다(${status}) — 작업 스케줄러의 ${TASK_NAME} 와 서비스 주소(http://127.0.0.1:포트)를 확인하세요` };
  }
  /* 빈 본문 403 + 리디렉트 없음 — cloudflared 의 Access 토큰 검사(Protect with Access)가 막고 있는데
     앞에 Access 응용이 없거나 잘못 걸린 모양이다. 닫혀 있긴 하지만 직원도 못 들어간다. */
  if (status === 403 && !loc && !String(body || '').trim()) {
    return { state: 'guard-only', ok: false, message: '403 — 터널의 Access 토큰 검사가 막고 있지만 Access 로그인 화면이 안 뜹니다. Access 응용(호스트 전체·Path 비움)과 로그인 방법(One-time PIN)을 확인하세요' };
  }
  if (status === 200 && /noindex/i.test(String(robots || ''))) {
    return { state: 'exposed', ok: false, danger: true, message: '위험: Access 없이 서버가 그대로 열려 있습니다 — 지금 바로 터널의 경로(Route)를 지우거나 서비스를 멈추고, Access 응용을 이 호스트 전체에 건 뒤 다시 여세요(README 3단계)' };
  }
  return { state: 'unknown', ok: false, message: `예상하지 못한 응답(${status}${loc ? ' → ' + loc : ''}) — README 의 문제 해결을 보세요` };
}

/* ── Windows 작업 스케줄러 ────────────────────────────────────────────
   부팅 때 실행기를 SYSTEM 으로 띄운다(로그인하지 않아도 뜨게). 트리거를 둘 둔다:
   ① 부팅 ② 5분마다 — 실행기가 이미 돌고 있으면 새로 띄우지 않으므로(IgnoreNew) ②는 "죽어 있으면 살린다"
   감시 역할만 한다. 작업 스케줄러의 '실패 시 다시 시작'은 프로그램이 오류 코드로 끝난 경우를 늘 잡아 주지
   않아서 그것 하나에 기대지 않는다. 실행 시간 제한은 없앤다(PT0S) — 기본값 72시간이면 사흘째에 끊긴다.
   SYSTEM 계정은 PATH 가 달라서 node.exe 를 전체 경로로 적는다. */
export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const quoteArg = (s) => `"${String(s).replace(/"/g, '')}"`;
export function taskXml({ nodeExe, runScript, envFile, workDir }) {
  for (const [k, val] of Object.entries({ nodeExe, runScript, envFile, workDir })) {
    if (!val || /["\r\n]/.test(val)) throw new Error(`작업 스케줄러 경로가 비었거나 따옴표·줄바꿈이 들어 있습니다: ${k}`);
  }
  const args = `${quoteArg(runScript)} --env ${quoteArg(envFile)}`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>WB 관리 서버 — reading-server/tunnel/run-server.mjs (관리 전용, 127.0.0.1). 설치·제거: node reading-server/tunnel/setup.mjs</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    /* 트리거 안의 순서는 스키마가 정한 순서(Enabled → StartBoundary → Repetition)대로 — 부팅 직후 30초는
       네트워크가 올라오기를 기다린다 */
    '    <BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>',
    '    <TimeTrigger>',
    '      <Enabled>true</Enabled>',
    '      <StartBoundary>2026-01-01T00:00:00</StartBoundary>',
    '      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    /* 기본값 7 은 '보통 아래' 우선순위라 실행기와 그 자식(서버)이 느려진다 — 5 가 보통 */
    '    <Priority>5</Priority>',
    /* Count 는 스키마상 1~255(unsignedByte) */
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(nodeExe)}</Command>`,
    `      <Arguments>${xmlEscape(args)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/* schtasks /XML 은 UTF-16 파일을 기대한다(작업 스케줄러가 내보내는 형식도 UTF-16 LE + BOM).
   UTF-8 로 쓰면 한글 설명 때문에 "XML 형식이 잘못됐다"로 거절될 수 있다. */
export const utf16leWithBom = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/* ── cloudflared 버전 ─────────────────────────────────────────────────
   2026.7.3 부터 Windows 서비스 설치가 토큰을 레지스트리(ImagePath)에 평문으로 넣지 않고
   C:\ProgramData\cloudflared\token(관리자·SYSTEM 만)에 둔다(cloudflared RELEASE_NOTES 'VULN-143514').
   그보다 옛 버전으로 service install 을 하면 토큰이 레지스트리에 남는다 — 설치를 거절한다. */
export const MIN_CLOUDFLARED = '2026.7.3';
export function parseCloudflaredVersion(text) {
  const m = /(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function cloudflaredOk(text, min = MIN_CLOUDFLARED) {
  const v = parseCloudflaredVersion(text);
  const w = parseCloudflaredVersion(min);
  if (!v) return false;
  for (let i = 0; i < 3; i++) { if (v[i] !== w[i]) return v[i] > w[i]; }
  return true;
}

/* cloudflared 의 metrics 서버는 127.0.0.1:20241~20245 중 빈 첫 포트에 뜨고, /ready 는 Cloudflare 와
   연결이 하나라도 있으면 200, 없으면 503 이다. 대시보드의 Healthy 는 "서버가 응답하는지"는 말해 주지 않으므로
   로컬 서버 점검과 따로 본다. */
export const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];

/* ── 작업에 적을 node.exe ─────────────────────────────────────────────
   작업 스케줄러는 SYSTEM 으로 돌아 사용자 PATH 를 모른다 — node.exe 를 전체 경로로 적는다.
   그런데 지금 이 명령을 돌린 node 가 winget 휴대용(zip)·nvm 처럼 버전 붙은 폴더에 있으면
   Node 를 올리는 순간 그 경로가 사라져 부팅 작업이 조용히 깨진다. 설치 프로그램(MSI)의 자리
   C:\Program Files\nodejs\node.exe 가 있으면 그것을 쓰고, 없으면 지금 것을 쓰되 경고한다. */
export const STABLE_NODE = 'C:\\Program Files\\nodejs\\node.exe';
export function pickNodeExe(execPath, exists) {
  const p = String(execPath || '');
  const unstable = /\\users\\|\\winget\\packages\\|\\nvm\\|node-v\d+/i.test(p);
  if (/^c:\\program files\\nodejs\\node\.exe$/i.test(p)) return { nodeExe: p, warning: '' };
  if (exists(STABLE_NODE)) return { nodeExe: STABLE_NODE, warning: unstable ? `지금 쓰는 node(${p}) 대신 설치 프로그램 자리(${STABLE_NODE})를 작업에 적습니다` : '' };
  return {
    nodeExe: p,
    warning: unstable ? `node 가 버전이 바뀌면 사라지는 자리에 있습니다(${p}) — nodejs.org 의 LTS 설치 파일(MSI)로 깔면 ${STABLE_NODE} 에 고정됩니다. 업그레이드 뒤 install-server 를 다시 하세요` : '',
  };
}

/* 저장소가 OneDrive 안이면(바탕 화면·문서 폴더가 OneDrive 로 옮겨진 PC) 파일이 클라우드 전용 자리표시로
   바뀌거나 SYSTEM 이 못 읽을 수 있다 — 설치 때 경고한다. */
export const inOneDrive = (p) => /[\\/]onedrive[^\\/]*([\\/]|$)/i.test(String(p || ''));
