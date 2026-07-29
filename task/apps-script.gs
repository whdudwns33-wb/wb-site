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

function sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
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

  var rows = [['날짜', '직원', '업무', '완료', '완료시각', '메모']];
  var keys = Object.keys(st.checks || {}).sort().reverse();

  for (var i = 0; i < keys.length && rows.length <= VIEW_LIMIT; i++) {
    var c = st.checks[keys[i]];
    var t = task[c.taskId];
    if (!t) continue;
    rows.push([
      c.date,
      staffName[t.staffId] || '',
      t.title || '',
      c.done ? '완료' : '미완료',
      c.at ? new Date(c.at) : '',
      c.note || ''
    ]);
  }

  var sh = sheet(VIEW_SHEET);
  sh.clear();
  sh.getRange(1, 1, rows.length, 6).setValues(rows);
  sh.getRange(1, 1, 1, 6).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length > 1) {
    sh.getRange(2, 5, rows.length - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/* ───────────────────────── 공통 ───────────────────────── */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
