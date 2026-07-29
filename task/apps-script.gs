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

function doGet() {
  return json({ ok: true, state: readState() });
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
