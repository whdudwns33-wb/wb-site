/**
 * WB 업무지시서 — 구글 스프레드시트 동기화 백엔드
 *
 * 이 코드는 "여러 기기에서 같은 지시서를 보고, 직원이 체크하면 원장 화면에서 바로 확인"
 * 하기 위한 아주 작은 저장소입니다. 설치 방법은 task/README.md 를 보세요.
 *
 * ─ 시트 구성 (자동 생성)
 *   _data   : 앱 데이터 원본(JSON). 직접 수정하지 마세요.
 *   체크현황 : 사람이 읽는 표. 원장님이 시트에서 바로 확인할 수 있습니다.
 */

// ⚠️ 아래 비밀키를 바꾸고, 앱 [설정] 화면에도 같은 값을 넣으세요.
var SECRET = 'wb-2026';

// 스프레드시트 ID. 비워두면 이 스크립트가 붙어 있는 시트를 씁니다.
// 시트 주소 .../spreadsheets/d/★여기★/edit 의 가운데 부분을 넣으면
// 독립 실행 스크립트로 만들었을 때도 정상 동작합니다.
var SHEET_ID = '';

var DATA_SHEET = '_data';
var VIEW_SHEET = '체크현황';
var CHUNK = 40000;          // 셀 하나에 넣을 최대 글자 수 (시트 한도 50,000)
var VIEW_LIMIT = 3000;      // 체크현황 시트에 표시할 최대 줄 수

/* ───────────────────────── 진입점 ───────────────────────── */

/** 살아있는지 확인용. 데이터는 내주지 않는다.
 *  웹앱 주소는 직원 링크에 담겨 나가므로, 주소만 알면 열람되는 통로를 두지 않는다.
 *  실제 읽기·쓰기는 전부 비밀키를 확인하는 doPost로만 이뤄진다. */
function doGet() {
  return json({ ok: true, service: 'wb-taskboard' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (String(body.secret || '') !== SECRET) {
      return json({ ok: false, error: 'secret mismatch' });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      // mode:'add' — 지시서만 밀어 넣기 (n8n·Make·시간 트리거용)
      if (body.mode === 'add') {
        var res = addAssignments(body.assignments || []);
        return json({ ok: true, added: res.added, createdStaff: res.createdStaff });
      }
      // 기본 — 앱과 전체 상태를 주고받는다
      var merged = mergeState(readState(), body.state || {});
      writeState(merged);
      writeView(merged);
      return json({ ok: true, state: merged });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* ───────────────────────── 지시서 투입 ─────────────────────────
 * 앱을 거치지 않고 업무를 등록한다. 직원은 '이름'으로 찾고, 없으면 새로 만든다.
 * 시간 트리거에 걸어 두면 정해진 주기로 자동 발행된다 (아래 publishWeekly 참고).
 */
function addAssignments(list) {
  var st = readState();
  var createdStaff = [];

  function findStaff(name) {
    name = String(name || '').trim();
    if (!name) return null;
    for (var i = 0; i < st.staff.length; i++) {
      if (!st.staff[i].deleted && st.staff[i].name === name) return st.staff[i];
    }
    var s = { id: Utilities.getUuid(), name: name, createdAt: nowMs(), updatedAt: nowMs(), deleted: false };
    st.staff.push(s);
    createdStaff.push(name);
    return s;
  }

  var added = 0;
  (list || []).forEach(function (a) {
    var s = findStaff(a.staff);
    if (!s) return;
    var steps = (a.steps || []).map(function (x) {
      return { id: Utilities.getUuid(), label: typeof x === 'string' ? x : String(x.label || '') };
    }).filter(function (x) { return x.label; });

    st.tasks.push({
      id: Utilities.getUuid(),
      groupId: 'api-' + nowMs(),
      staffId: s.id,
      title: String(a.title || '').trim() || '(제목 없음)',
      detail: String(a.detail || ''),
      guide: String(a.guide || ''),
      steps: steps,
      target: Number(a.target) || 0,
      unit: String(a.unit || '건'),
      time: String(a.time || ''),
      priority: a.priority === 'high' ? 'high' : 'normal',
      repeat: ['once', 'daily', 'weekday', 'days'].indexOf(a.repeat) >= 0 ? a.repeat : 'once',
      days: (a.days || []).map(Number).filter(function (n) { return n >= 0 && n <= 6; }),
      start: /^\d{4}-\d{2}-\d{2}$/.test(a.start || '') ? a.start : todayStr(),
      end: /^\d{4}-\d{2}-\d{2}$/.test(a.end || '') ? a.end : '',
      carry: a.carry !== false,
      createdAt: nowMs(), updatedAt: nowMs(), deleted: false
    });
    added++;
  });

  writeState(st);
  writeView(st);
  return { added: added, createdStaff: createdStaff };
}

function nowMs() { return new Date().getTime(); }
function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ───────────────── 드라이브 경유 자동 등록 ─────────────────
 * 구글 드라이브에 아래 이름으로 시작하는 .json 파일이 놓이면 자동으로 지시서를 등록한다.
 * Claude가 파일만 놓아두면 원장이 아무것도 붙여넣지 않아도 반영된다.
 *
 * 설치: 시계 아이콘(트리거) → 함수 importFromDrive → 분 단위 → 10분 간격
 *       처음 실행할 때 드라이브 접근 권한을 한 번 승인해야 한다.
 *
 * 처리한 파일은 이름 끝에 __처리완료 가 붙어 다시 등록되지 않는다.
 */
var IMPORT_PREFIX = 'WB_지시서입력_';
var DONE_MARK = '__처리완료';
var LOG_SHEET = '_import로그';

function importFromDrive() {
  var files = DriveApp.searchFiles(
    'title contains "' + IMPORT_PREFIX + '" and trashed = false');
  var handled = 0;

  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (name.indexOf(DONE_MARK) >= 0) continue;          // 이미 처리한 파일
    if (name.slice(-5).toLowerCase() !== '.json') continue;

    var added = 0, created = [], err = '';
    try {
      var raw = f.getBlob().getDataAsString('UTF-8');
      var data = JSON.parse(raw);
      var list = Array.isArray(data) ? data : (data.assignments || []);
      if (!list.length) throw new Error('assignments 가 비어 있습니다');
      var res = addAssignments(list);
      added = res.added;
      created = res.createdStaff;
      f.setName(name.replace(/\.json$/i, '') + DONE_MARK + '.json');
    } catch (e) {
      err = String(e);
      f.setName(name.replace(/\.json$/i, '') + DONE_MARK + '_오류.json');
    }
    logImport(name, added, created, err);
    handled++;
  }
  return handled;
}

function logImport(fileName, added, createdStaff, err) {
  var sh = sheet(LOG_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['시각', '파일명', '등록건수', '새로 만든 직원', '오류']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.appendRow([new Date(), fileName, added, (createdStaff || []).join(', '), err || '']);
}

/* ───────────────── 막힘 알림 (선택) ─────────────────
 * 직원이 [막힘]을 누르면 원장에게 알린다.
 * 설치: 트리거 → 함수 notifyBlocked → 분 단위 → 10분 간격
 *
 * 채널 우선순위:
 *  1) SOLAPI_KEY 가 있으면 문자(SMS) — SMS_TO_LIST의 전원에게 발송.
 *     카카오 채널 템플릿(pfId·templateId)까지 넣으면 알림톡으로 나간다
 *  2) KAKAO_REST_KEY 연결 시 원장 카카오톡(나와의 채팅)
 *  3) 둘 다 없으면 NOTIFY_EMAIL 로 이메일
 * 같은 건은 한 번만 알린다 (_알림로그 시트로 중복 방지)
 */
var NOTIFY_EMAIL   = '';   // 알림 받을 이메일 (비우면 이메일 알림 없음)
var KAKAO_REST_KEY = '';   // 카카오 디벨로퍼스 앱의 REST API 키 — 넣으면 카톡(나와의 채팅)으로 발송
var KAKAO_AUTH_CODE = '';  // 최초 연결 1회용 인가 코드 (README의 카카오 연결 절차 참고)
var SOLAPI_KEY     = '';   // 솔라피 API Key (비우면 문자 대신 이메일)
var SOLAPI_SECRET  = '';   // 솔라피 API Secret
var SMS_FROM       = '';   // 솔라피에 등록된 발신번호 (숫자만)
var SMS_TO_LIST    = [     // 알림 받을 번호들 (숫자만) — 비어 있는 항목은 무시된다
  '',   // 김혜지
  ''    // 공현정
];
var KAKAO_PF_ID    = '';   // (선택) 카카오 채널 pfId — 알림톡용
var KAKAO_TEMPLATE = '';   // (선택) 승인된 알림톡 템플릿 ID
var ALERT_SHEET    = '_알림로그';

function notifyBlocked() {
  var st = readState();
  var sh = sheet(ALERT_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['시각', '건', '내용', '채널', '결과']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var seen = {};
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { seen[String(r[0])] = true; });
  }
  var names = {}; (st.staff || []).forEach(function (s) { names[s.id] = s.name; });
  var tasks = {}; (st.tasks || []).forEach(function (t) { tasks[t.id] = t; });
  // 오래된 건으로 첫 실행 때 알림이 쏟아지지 않게 최근 3일만 본다
  var cutoff = Utilities.formatDate(new Date(Date.now() - 3 * 86400000),
    Session.getScriptTimeZone(), 'yyyy-MM-dd');

  Object.keys(st.checks || {}).forEach(function (k) {
    var c = st.checks[k];
    if (!c || !c.blocked) return;
    if (String(c.date || '') < cutoff) return;
    if (seen[k]) return;
    var t = tasks[c.taskId];
    if (!t) return;
    var who = names[t.staffId] || '?';
    var text = '[WB업무 막힘] ' + who + ' · ' + (t.title || '') +
      (c.note ? '\n메모: ' + c.note : '');
    var res = sendAlert(text);
    sh.appendRow([new Date(), k, text, res.channel, res.ok ? 'OK' : res.error]);
  });
}

/* ── 카카오 '나에게 보내기' ──
 * 알림톡 템플릿·비용 없이, 대표 본인의 카카오톡 '나와의 채팅'으로 보낸다.
 * 최초 1회 연결: ① developers.kakao.com 앱 생성 → REST API 키를 KAKAO_REST_KEY에
 * ② 카카오 로그인 활성화 + Redirect URI에 https://localhost 등록
 * ③ 동의항목에서 '카카오톡 메시지 전송(talk_message)' 활성화
 * ④ 브라우저에서 아래 주소를 열어 동의 (REST키 부분만 바꿔서):
 *    https://kauth.kakao.com/oauth/authorize?client_id=REST키&redirect_uri=https://localhost&response_type=code&scope=talk_message
 * ⑤ 이동된 주소창의 code= 뒷부분을 KAKAO_AUTH_CODE에 넣고 kakaoInit() 실행 1회
 */
function kakaoInit() {
  var resp = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', {
    method: 'post',
    payload: { grant_type: 'authorization_code', client_id: KAKAO_REST_KEY,
               redirect_uri: 'https://localhost', code: KAKAO_AUTH_CODE },
    muteHttpExceptions: true
  });
  var d = JSON.parse(resp.getContentText());
  if (d.refresh_token) {
    PropertiesService.getScriptProperties().setProperty('KAKAO_REFRESH', d.refresh_token);
    Logger.log('카카오 연결 성공 — 이제 막힘 알림이 카카오톡으로 갑니다');
    return;
  }
  throw new Error('카카오 연결 실패: ' + resp.getContentText());
}

function kakaoAccessToken() {
  if (!KAKAO_REST_KEY) return null;
  var props = PropertiesService.getScriptProperties();
  var refresh = props.getProperty('KAKAO_REFRESH');
  if (!refresh) return null;
  var resp = UrlFetchApp.fetch('https://kauth.kakao.com/oauth/token', {
    method: 'post',
    payload: { grant_type: 'refresh_token', client_id: KAKAO_REST_KEY, refresh_token: refresh },
    muteHttpExceptions: true
  });
  var d = JSON.parse(resp.getContentText());
  if (d.refresh_token) props.setProperty('KAKAO_REFRESH', d.refresh_token);   // 갱신되면 저장
  return d.access_token || null;
}

function sendKakaoMemo(text) {
  var token = kakaoAccessToken();
  if (!token) return { ok: false, error: '카카오 미연결' };
  var resp = UrlFetchApp.fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + token },
    payload: { template_object: JSON.stringify({
      object_type: 'text',
      text: text,
      link: { web_url: 'https://whdudwns33-wb.github.io/wb-site/task/',
              mobile_web_url: 'https://whdudwns33-wb.github.io/wb-site/task/' },
      button_title: '앱에서 확인'
    }) },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() < 300) return { ok: true };
  return { ok: false, error: resp.getContentText().slice(0, 150) };
}

function sendAlert(text) {
  // 1순위: 문자 — 수신 목록 전원에게 (김혜지·공현정 등 처리 담당자)
  var targets = SMS_TO_LIST.filter(function (x) { return String(x || '').trim(); });
  if (SOLAPI_KEY && targets.length) {
    var sent = 0, err = '';
    targets.forEach(function (to) {
      try {
        var msg = { to: String(to).trim(), from: SMS_FROM, text: text };
        if (KAKAO_PF_ID && KAKAO_TEMPLATE) {
          msg.kakaoOptions = { pfId: KAKAO_PF_ID, templateId: KAKAO_TEMPLATE };
        }
        var resp = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
          method: 'post',
          headers: solapiAuth(),
          contentType: 'application/json',
          payload: JSON.stringify({ message: msg }),
          muteHttpExceptions: true
        });
        if (resp.getResponseCode() < 300) sent++;
        else err = resp.getContentText().slice(0, 120);
      } catch (e) { err = String(e); }
    });
    if (sent > 0) return { channel: '문자 ' + sent + '/' + targets.length + '명', ok: true };
    return { channel: '문자', ok: false, error: err || '전송 실패' };
  }
  // 2순위: 원장 카카오톡 나와의 채팅
  if (KAKAO_REST_KEY) {
    var k = sendKakaoMemo(text);
    if (k.ok) return { channel: '카카오톡', ok: true };
  }
  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail(NOTIFY_EMAIL, text.split('\n')[0], text +
        '\n\n관리자 화면에서 확인하세요.');
      return { channel: '이메일', ok: true };
    } catch (e) { return { channel: '이메일', ok: false, error: String(e) }; }
  }
  return { channel: '없음', ok: false, error: 'NOTIFY_EMAIL 또는 SOLAPI_KEY를 설정하세요' };
}

function solapiAuth() {
  var date = new Date().toISOString();
  var salt = Utilities.getUuid().replace(/-/g, '');
  var sig = Utilities.computeHmacSha256Signature(date + salt, SOLAPI_SECRET)
    .map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; })
    .join('');
  return {
    'Authorization': 'HMAC-SHA256 apiKey=' + SOLAPI_KEY +
      ', date=' + date + ', salt=' + salt + ', signature=' + sig
  };
}

/* ───────────────── 정기 자동 발행 (선택) ─────────────────
 * 매주 같은 업무를 반복해서 내보내야 한다면 여기에 적어두고
 * 시계 아이콘(트리거) → 함수: publishWeekly → 주 단위 → 월요일 오전 8~9시 로 걸어두세요.
 * 반복 설정(weekday/days)으로 해결되는 업무는 여기에 넣을 필요가 없습니다.
 * 매주 내용이 바뀌는 업무(그 주 대상자·수량이 다른 것)에 쓰세요.
 */
var WEEKLY_SET = [
  // {
  //   staff: '김혜지',
  //   title: '이번 주 신규 구독 CS 전화',
  //   guide: '구독 명단에서 이번 주 신규만 추립니다\n미접속 7일 이상이면 사용법 재안내',
  //   steps: ['명단 뽑기', '전화 돌리기', '결과 기록'],
  //   target: 10, unit: '명', time: '15:00', repeat: 'days', days: [2, 5]
  // }
];

function publishWeekly() {
  if (!WEEKLY_SET.length) return;
  addAssignments(WEEKLY_SET);
}

/* ───────────────────────── 병합 ───────────────────────── */
/** 같은 id면 updatedAt 이 더 최신인 쪽이 이깁니다. */
function mergeState(a, b) {
  return {
    staff:  mergeById(a.staff,  b.staff),
    tasks:  mergeById(a.tasks,  b.tasks),
    checks: mergeChecks(a.checks, b.checks)
  };
}

function mergeById(x, y) {
  var out = {};
  (x || []).forEach(function (r) { if (r && r.id) out[r.id] = r; });
  (y || []).forEach(function (r) {
    if (!r || !r.id) return;
    var cur = out[r.id];
    if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) out[r.id] = r;
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function mergeChecks(x, y) {
  var out = {};
  Object.keys(x || {}).forEach(function (k) { out[k] = x[k]; });
  Object.keys(y || {}).forEach(function (k) {
    var cur = out[k], nxt = y[k];
    if (!cur || (nxt.updatedAt || 0) > (cur.updatedAt || 0)) out[k] = nxt;
  });
  return out;
}

/* ───────────────────────── 저장/읽기 ───────────────────────── */

function book() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('시트를 찾을 수 없습니다. 맨 위 SHEET_ID 에 스프레드시트 ID를 넣어주세요.');
  return ss;
}

function sheet(name) {
  var ss = book();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function readState() {
  var sh = sheet(DATA_SHEET);
  var last = sh.getLastRow();
  if (last < 1) return { staff: [], tasks: [], checks: {} };
  var vals = sh.getRange(1, 1, last, 1).getValues();
  var raw = vals.map(function (r) { return r[0] || ''; }).join('');
  if (!raw) return { staff: [], tasks: [], checks: {} };
  try {
    var p = JSON.parse(raw);
    return { staff: p.staff || [], tasks: p.tasks || [], checks: p.checks || {} };
  } catch (e) {
    return { staff: [], tasks: [], checks: {} };
  }
}

function writeState(st) {
  var sh = sheet(DATA_SHEET);
  var raw = JSON.stringify(st);
  var rows = [];
  for (var i = 0; i < raw.length; i += CHUNK) rows.push([raw.substr(i, CHUNK)]);
  if (!rows.length) rows.push(['']);
  sh.clear();
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
}

/* ───────────────────────── 사람이 읽는 표 ───────────────────────── */

function writeView(st) {
  var staffName = {};
  (st.staff || []).forEach(function (s) { staffName[s.id] = s.name; });
  var task = {};
  (st.tasks || []).forEach(function (t) { task[t.id] = t; });

  var rows = [['날짜', '직원', '업무', '상태', '진행', '완료시각', '메모']];
  var keys = Object.keys(st.checks || {}).sort().reverse();

  for (var i = 0; i < keys.length && rows.length <= VIEW_LIMIT; i++) {
    var c = st.checks[keys[i]];
    var t = task[c.taskId];
    if (!t) continue;
    var p = progressOf(t, c);
    rows.push([
      c.date,
      staffName[t.staffId] || '',
      t.title || '',
      statusOf(c, p),
      p.total > 1 ? p.done + ' / ' + p.total + (p.unit || '') : '',
      c.at ? new Date(c.at) : '',
      c.note || ''
    ]);
  }

  var sh = sheet(VIEW_SHEET);
  sh.clear();
  sh.getRange(1, 1, rows.length, 7).setValues(rows);
  sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length > 1) {
    sh.getRange(2, 6, rows.length - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/** 단계·수량을 반영한 진행률 */
function progressOf(t, c) {
  var steps = t.steps || [];
  if (steps.length) {
    var n = 0;
    steps.forEach(function (s) { if (c.steps && c.steps[s.id]) n++; });
    return { done: n, total: steps.length, unit: '단계' };
  }
  if (t.target) return { done: (c.count || 0), total: t.target, unit: t.unit || '건' };
  return { done: c.done ? 1 : 0, total: 1, unit: '' };
}

/** 미착수 / 진행중 / 완료 / 막힘 */
function statusOf(c, p) {
  if (c.blocked) return '막힘';
  if (c.done) return '완료';
  return p.done > 0 ? '진행중' : '미착수';
}

/* ───────────────────────── 공통 ───────────────────────── */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
