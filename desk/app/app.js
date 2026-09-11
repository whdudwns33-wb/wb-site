/* WB 프로그램데스크 — 런타임 (계약 §1·§3·§4·§5)
 *
 * 이 파일이 하는 일 셋:
 *   1) 패널 3개(runbook-ui·ledger-ui·perf-panel)가 이름으로 참조하는 전역(state·session·setCheck·tasksFor…)을 제공한다.
 *      패널은 호출 시점에만 전역을 보므로, 여기서는 최상위 선언(let/const/function)으로 두면 된다.
 *   2) API 클라이언트(Bearer 토큰)·변경 큐(300ms 디바운스 POST /api/docs)·60초 폴링.
 *   3) 화면 8개(로그인·오늘·요청함·학생·자산·수행·연락·관리)와 dk- 접두 클릭 처리.
 *
 * 왜 서버가 없어도 열리게 하나: 직원은 폰에서 연다. fetch 실패는 로그인 화면·배너의 힌트로 보이고,
 * 이미 받은 데이터로 화면은 계속 그려진다. 개인정보(학생·연락처)는 서버(D1)에만 있고 여기엔 토큰만 남는다.
 */
'use strict';

/* ── 상수 ─────────────────────────────────────────── */

const DC = WBDeskCore;
const TOKEN_KEY = 'desk.token';
const SYNC_APP = 'desk';                 // runbook-ui가 sync.post body에 붙이는 앱 이름(런타임이 떼어낸다)
const POLL_MS = 60000;
const FLUSH_MS = 300;
/* 기획서 v1.1 — 1차 메뉴는 프로그램 방 6개(원장 표현: 세션). 두 번째 줄이 명단·요청·자산·수행·연락·매뉴얼·현황·관리. */
const TABS_ROOMS = [['today', '오늘']].concat(DC.ROOMS.map(k => ['p/' + k, DC.ROOM_LABEL[k]]));
const TABS_MORE = [['students', '학생'], ['requests', '요청함'], ['assets', '자산'], ['perf', '수행'], ['contacts', '연락'], ['manuals', '매뉴얼'], ['matrix', '현황'], ['admin', '관리']];
const OWNER_ROUTES = ['matrix', 'admin'];
const MANUAL_TASKS = [['assign', '배정'], ['check', '확인'], ['download', '다운로드'], ['upload', '앱 업로드'], ['account', '계정'], ['followup', '후속 연락'], ['other', '기타']];

/* ── 계약 전역(§4) ────────────────────────────────── */

let state = emptyState();
let session = null;                      // {role, isAdmin, isStaffLink, staffId, name, canApprove}
let rosterDb = null;                     // {students:[{id,name,grade,start,end}]} — 수행 패널이 본다
let rosterErr = '';
let rosterLoading = false;
let route = 'login';
let room = '';                           // route === 'room' 일 때의 프로그램 키
let cursor = DC.ymdOf(new Date());
let derivedFor = '';                     // 오늘 카드를 템플릿에서 마지막으로 만든 날짜

/* 화면 상태 — 재렌더(폴링 도착 포함)에도 살아남아야 하므로 DOM이 아니라 여기 둔다. */
const ui = {
  staffPick: '', panels: {}, stuQ: '', stuStatus: 'all', stuOpen: '', phoneShown: {},
  reqFilter: 'open', reqErr: '', ctQ: '', linkBusy: false,
  doneOpen: {}, matrixView: 'students', manualScope: '', manualPhotos: []
};
const boot = { health: null, err: '', busy: false };

/* 동기화 상태 */
const outbox = DC.createOutbox();
let syncErr = '';
let lastSync = 0;
let flushTimer = null;
let flushing = false;
let pollTimer = null;
let modalReturnFocus = null;

function emptyState() { return { staff: [], tasks: [], checks: {}, students: [], contacts: [], cards: [], plans: [], apps: [], manuals: [], settings: {}, meta: {}, base: {} }; }

/* ── 기본 헬퍼(§4) ────────────────────────────────── */

const $ = sel => document.querySelector(sel);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function today() { return DC.ymdOf(new Date()); }
function now() { return Date.now(); }
function nowHM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
function addDays(s, n) { return DC.addDays(s, n); }
function mondayOf(s) { return DC.mondayOf(s); }
function label(s) { return DC.label(s); }
function val(id) { const el = $('#' + id); return el ? String(el.value || '').trim() : ''; }
function checked(id) { const el = $('#' + id); return !!(el && el.checked); }

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = String(msg == null ? '' : msg);
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), 2600);
}

function setInert(on) {
  ['.topbar', '.tabs', '#view'].forEach(sel => { const el = $(sel); if (el) el.inert = on; });
}
/** 패널이 전제하는 모달 — #modalHost 안에 .modal-box, 닫기 버튼은 data-act="closemodal". */
function modal(title, bodyHtml, footHtml) {
  const host = $('#modalHost');
  if (!host) return;
  if (host.hidden) modalReturnFocus = document.activeElement;
  host.innerHTML = '<div class="modal-box"><div class="between mb14"><div class="card-title" id="modalTitle">' + esc(title) + '</div>' +
    '<button class="btn btn-sm btn-ghost" data-act="closemodal" aria-label="닫기">닫기</button></div>' + bodyHtml + (footHtml || '') + '</div>';
  host.hidden = false;
  setInert(true);
  requestAnimationFrame(() => { const first = host.querySelector('input, select, textarea'); (first || host.querySelector('[data-act="closemodal"]') || host).focus(); });
}
function closeModal() {
  const host = $('#modalHost');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
  setInert(false);
  const target = modalReturnFocus;
  modalReturnFocus = null;
  if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
}

/* ── 직원·task·체크(§4) ───────────────────────────── */

function liveStaff() { return state.staff.filter(s => s && !s.deleted && s.active !== false && s.active !== 0); }
function staffById(id) { return state.staff.find(s => s && String(s.id) === String(id)) || null; }
function staffName(id) {
  if (!id || id === 'admin') return '원장';
  const s = staffById(id);
  return s ? String(s.name) : '직원';
}
function tasksFor(staffId, ymd) { return DC.tasksFor(state.tasks, staffId, ymd); }
function getCheck(taskId, date) { return state.checks[DC.checkKey(taskId, date)] || null; }
function isDone(taskId, ymd) { return DC.isDone(null, getCheck(taskId, ymd)); }
/** 즉시 메모리 반영 + 변경 큐. 패널(자산·수행)은 이 함수 하나로만 저장한다. */
function setCheck(taskId, date, patch) {
  const k = DC.checkKey(taskId, date);
  const cur = state.checks[k] || { taskId: String(taskId), date: String(date), done: false, note: '', steps: {}, count: 0, blocked: false };
  const next = Object.assign({}, cur, patch, { updatedAt: now() });
  state.checks[k] = next;
  queueChange('checks', k, next);
  return next;
}
function taskById(id) { return state.tasks.find(t => t && String(t.id) === String(id)) || null; }
function saveTask(t) {
  t.updatedAt = now();
  queueChange('tasks', t.id, t);
}

/** 지시서 JSON → task. 없는 직원은 만들지 않는다(직원 등록은 원장 화면) — 토스트로 거절. */
function applyAssignments(input, preConfirmed) {
  void preConfirmed;
  const p = DC.parseAssignments(input);
  if (p.error) return toast(p.error);
  if (!p.list.length) return toast('등록할 업무가 없습니다');
  const r = DC.applyAssignmentsPure(p.list, liveStaff(), { uid: uid, now: now, today: today, linkFor: WBExternalLinks.linkFor });
  if (r.skipped.length) {
    const names = [...new Set(r.skipped.map(s => s.staff))];
    toast('등록되지 않은 직원: ' + names.join(', ') + ' — 관리 탭에서 먼저 등록하세요');
    if (!r.tasks.length) return;
  }
  r.tasks.forEach(t => { state.tasks.push(t); queueChange('tasks', t.id, t); });
  closeModal();
  render();
  toast(r.tasks.length + '건 등록' + (r.skipped.length ? ' · ' + r.skipped.length + '건 건너뜀' : ''));
}

/** 마감 브리핑 문자열 — desk-core 요약 + 런북 절. */
function briefText(date) {
  const d = date || cursor;
  return DC.briefText({ date: d, staff: liveStaff(), tasks: state.tasks, checks: state.checks, nowHM: nowHM(), dueLimitFn: WBRunbookCore.dueLimit }) +
    (WBRunbookUI.briefSection(d) || '');
}

function refreshRoster() {
  rosterDb = { students: DC.studentsToRoster(state.students, today().slice(0, 7)) };
  // 구독 프로그램이 켜진 학생은 수행 설정 없이도 신호판에 오른다(학생 문서에서 파생, 서버에 쓰지 않음)
  state.checks = DC.seedPerfsets(state.students, state.checks, { perfsetKey: WBPerfCore.perfsetKey, dueDays: WBPerfCore.DEFAULT_DUE_DAYS }).checks;
  rosterErr = '';
  rosterLoading = false;
}
/** 수행 패널이 roster가 없을 때 부른다 — 여기서는 students 문서에서 바로 만든다. */
function loadRoster() { refreshRoster(); }

/* ── API 클라이언트(§1·§3) ────────────────────────── */

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, String(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 사설 모드 등 — 세션은 메모리로만 */ } }

/** fetch 한 번. 실패는 Error(code·current·status)로 던진다. 401/AUTH면 로그인 화면으로 돌아간다. */
async function api(path, body, opts) {
  const o = opts || {};
  const headers = { Accept: 'application/json' };
  const tok = getToken();
  if (tok && !o.noAuth) headers.Authorization = 'Bearer ' + tok;
  const init = { method: body ? 'POST' : 'GET', headers: headers, cache: 'no-store' };
  if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); }
  catch (e) { throw Object.assign(new Error('서버에 연결할 수 없습니다'), { code: 'NETWORK' }); }
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (res.status === 401 || (json && json.code === 'AUTH')) {
    if (!o.noAuth) onAuthLost();
    throw Object.assign(new Error((json && json.error) || '인증이 필요합니다'), { code: 'AUTH', status: 401 });
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && (json.error || json.code)) || ('HTTP ' + res.status));
    err.code = (json && json.code) || 'HTTP';
    err.status = res.status;
    if (json && json.current) err.current = json.current;
    if (json) err.body = json;             // POST /api/docs는 4xx여도 results 전체를 싣는다
    throw err;
  }
  return json;
}

function onAuthLost() {
  if (!session && !getToken()) return;
  setToken('');
  session = null;
  stopPolling();
  outbox.clear();
  state = emptyState();
  rosterDb = null;
  route = 'login';
  render();
  toast('다시 로그인해 주세요');
}

/* runbook-ui의 sync.post('/ops-request', {app, auth, action…}) → /api/requests. app·auth는 버리고 Bearer로 인증한다. */
const sync = {
  recovering: false,
  auth: () => (session ? { mode: 'desk', role: session.role } : null),
  post: (path, body) => {
    if (path !== '/ops-request') return Promise.reject(Object.assign(new Error('지원하지 않는 경로: ' + path), { code: 'BAD_PATH' }));
    const b = Object.assign({}, body || {});
    delete b.app; delete b.auth;
    /* via·assigneeId는 서버가 원장에게만 받는다. 직원 세션은 runbook-ui가 붙여도 떼어내 403을 막는다. */
    if (session && !session.canApprove && b.action === 'create') { delete b.via; delete b.assigneeId; }
    return api('/api/requests', b).then(res => {
      if (b.action === 'list') { ui.reqErr = ''; updateTabs(); }
      return res;
    }, err => {
      if (b.action === 'list' && err.code !== 'AUTH') ui.reqErr = err.message;
      throw err;
    });
  }
};

/* ── 변경 큐·동기화(§4) ───────────────────────────── */

function queueChange(c, id, data, deleted) {
  outbox.put(c, id, data, deleted);
  scheduleFlush(FLUSH_MS);
  patchSyncBar();
}
function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms == null ? FLUSH_MS : ms); }

/* 서버가 되돌리라고 알려 주는 거절 — 권한·append-only. 형식 오류(PII·INVALID·TOO_LARGE)는 값을 고칠 수 있게 남겨 두고 토스트만. */
const REVERT_CODES = ['FORBIDDEN', 'APPROVAL_ADMIN_ONLY', 'APPEND_ONLY'];

/** 큐를 한 번 보낸다. 네트워크 실패는 배너 + [다시 시도]. 서버는 한 건이라도 거절하면 4xx로 답하되 results 전체를 싣는다 —
 *  성공 건의 updatedAt은 그대로 반영하고, STALE은 current로 갈아끼우고, 권한 거절은 로컬 변경을 되돌린다. */
async function flush() {
  if (flushing || !session || !outbox.size()) return;
  flushing = true;
  const sent = outbox.snapshot(200);
  const changes = sent.map(e => {
    const ch = { c: e.c, id: e.id, data: e.data };
    const at = state.meta[DC.docKey(e.c, e.id)];
    if (at) ch.expectedUpdatedAt = at;
    if (e.deleted) ch.deleted = true;
    return ch;
  });
  try {
    let res;
    try { res = await api('/api/docs', { changes: changes }); }
    catch (e) {
      if (e.code === 'AUTH' || !e.body || !Array.isArray(e.body.results)) throw e;
      res = e.body;
    }
    const r = outbox.ack(sent, res.results || []);
    r.ok.forEach(o => { if (o.updatedAt) state.meta[o.key] = o.updatedAt; });
    let dirty = false;
    if (r.stale.length) {
      r.stale.forEach(s => {
        if (s.current) { forceDoc(currentToDoc(s)); return; }
        /* 서버에 그 문서가 없는데 내가 updatedAt을 기억하고 있었다 — 기억을 지우고 한 번 더 보낸다(LWW). */
        delete state.meta[s.key];
        const e = sent.find(x => DC.docKey(x.c, x.id) === s.key);
        if (e && !outbox.has(s.key)) outbox.put(e.c, e.id, e.data, e.deleted);
      });
      const n = r.stale.filter(s => s.current).length;
      if (n) toast('다른 기기에서 먼저 바뀐 항목 ' + n + '건 — 최신 값으로 갱신했습니다');
      dirty = true;
    }
    if (r.failed.length) {
      const reverted = r.failed.filter(f => REVERT_CODES.includes(f.code));
      reverted.forEach(f => { const doc = DC.revertDoc(state, f.key); if (doc) forceDoc(doc); });
      const first = r.failed[0];
      toast((reverted.length ? '되돌림 ' + reverted.length + '건 — ' : '저장 거절 — ') + first.error);
      dirty = true;
    }
    if (dirty && !typingInView()) render();
    syncErr = '';
    if (outbox.size()) scheduleFlush(50);
  } catch (e) {
    if (e.code !== 'AUTH') syncErr = e.message;
  } finally {
    flushing = false;
    patchSyncBar();
  }
}
function currentToDoc(s) {
  const cur = s.current;
  const hasData = cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, 'data');
  return { c: s.c, id: s.id, data: hasData ? cur.data : cur, updatedAt: hasData ? cur.updatedAt : 0, deleted: hasData ? !!cur.deleted : false };
}
/** 병합 규칙(오래된 문서 무시·미전송 키 보존)을 건너뛰고 서버 값으로 강제한다 — STALE·거절 되돌리기 전용. */
function forceDoc(doc) {
  delete state.meta[DC.docKey(doc.c, doc.id)];
  applyDocs([doc], 0, true);
}

function applyDocs(docs, serverNow, force) {
  const r = DC.mergeDocs(state, docs, force ? [] : outbox.keys());
  state = r.local;
  if (serverNow) lastSync = Math.max(lastSync, Number(serverNow) || 0);
  refreshRoster();
  return r.changed;
}
async function loadAll() {
  const res = await api('/api/docs');
  applyDocs(res.docs, res.now);
  ensureTodayCards();
}
async function reloadAll() {
  await loadAll();
  if (!typingInView()) render();
}
async function poll() {
  if (!session || document.hidden) return;
  try {
    const res = await api('/api/docs?since=' + Math.max(0, lastSync - 1));
    const n = applyDocs(res.docs, res.now);
    const made = ensureTodayCards();
    syncErr = '';
    if ((n || made) && !typingInView()) render(); else patchSyncBar();
    if (outbox.size()) scheduleFlush(0);
  } catch (e) {
    if (e.code !== 'AUTH') { syncErr = e.message; patchSyncBar(); }
  }
}
function startPolling() { stopPolling(); pollTimer = setInterval(poll, POLL_MS); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function typingInView() {
  const a = document.activeElement;
  const view = $('#view');
  return !!(a && view && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

/* ── 세션·부팅(§1) ────────────────────────────────── */

function makeSession(me) {
  const role = me.role === 'admin' ? 'admin' : 'staff';
  return {
    role: role,
    isAdmin: true,                      // 직원도 운영자 — 자산·수행 쓰기 가능(§4)
    isStaffLink: role === 'staff',
    staffId: role === 'admin' ? 'admin' : String(me.staffId || ''),
    name: String(me.name || (role === 'admin' ? '원장' : '직원')),
    canApprove: role === 'admin'
  };
}

async function afterAuth() {
  const me = await api('/api/me');
  session = makeSession(me);
  boot.err = '';
  await loadAll();
  startPolling();
  applyRoute(DC.routeOf(location.hash));
  render();
}
/** 라우트 반영 — 방(#/p/<k>)은 route='room'+room, 원장 전용 화면은 직원이면 오늘로. */
function applyRoute(r) {
  route = r.route === 'login' ? 'today' : r.route;
  room = r.route === 'room' ? String(r.room || '') : '';
  if (OWNER_ROUTES.includes(route) && !session.canApprove) route = 'today';
  const h = hashOf(route, room);
  if (location.hash !== h) history.replaceState(null, '', h);
}
function hashOf(r, k) { return r === 'room' ? '#/p/' + k : '#/' + r; }

async function linkExchange(code) {
  if (ui.linkBusy) return;
  ui.linkBusy = true;
  try {
    const r = await api('/api/link-exchange', { code: code }, { noAuth: true });
    if (!r.token) throw new Error('토큰이 없습니다');
    setToken(r.token);
    history.replaceState(null, '', '#/today');
    await afterAuth();
    toast('이 기기를 연결했습니다');
  } catch (e) {
    /* 서버 코드: CODE_INVALID(401 — 만료·사용됨·형식) · STAFF_INACTIVE(403). 401이라도 이 기기의 기존 토큰은 건드리지 않았다(noAuth). */
    boot.err = '링크 연결 실패 — ' + e.message + (e.code === 'NETWORK' || e.code === 'STAFF_INACTIVE' ? '' : ' (링크는 7일 안에 한 번만 쓸 수 있습니다 — 원장께 새 링크를 받으세요)');
    history.replaceState(null, '', '#/login');
    route = 'login';
    render();
  } finally { ui.linkBusy = false; }
}

async function startApp() {
  render();   // 서버 응답 전에도 껍데기를 그린다
  const r = DC.routeOf(location.hash);
  if (r.code) return linkExchange(r.code);
  if (getToken()) {
    try { await afterAuth(); return; }
    catch (e) { if (e.code !== 'AUTH') boot.err = e.message; }
  }
  await loadHealth();
  route = 'login';
  render();
}
async function loadHealth() {
  try { boot.health = await api('/api/health', null, { noAuth: true }); boot.err = ''; }
  catch (e) { boot.health = null; if (e.code !== 'AUTH') boot.err = e.message; }
}

async function doLogin(btn) {
  const pw = val('dk-pw');
  if (!pw) return toast('비밀번호를 입력하세요');
  if (boot.busy) return;
  boot.busy = true; if (btn) btn.disabled = true;
  try {
    const r = await api('/api/login', { password: pw }, { noAuth: true });
    if (!r.token) throw new Error('토큰이 없습니다');
    setToken(r.token);
    await afterAuth();
    toast('환영합니다');
  } catch (e) {
    /* 서버 코드: LOGIN_FAILED(401) · LOGIN_LOCKED(429) · NOT_SETUP(409 — 아직 비밀번호가 없다 → 만들기 화면으로) */
    if (e.code === 'NOT_SETUP') { boot.health = Object.assign({}, boot.health, { setup: false }); render(); }
    toast(e.code === 'AUTH' ? '로그인 실패 — 비밀번호가 맞지 않습니다' : '로그인 실패 — ' + e.message);
  } finally { boot.busy = false; if (btn) btn.disabled = false; }
}
async function doSetup(btn) {
  const pw = val('dk-pw'), pw2 = val('dk-pw2');
  if (pw.length < 8 || pw.length > 72) return toast('비밀번호는 8~72자');
  if (pw !== pw2) return toast('두 비밀번호가 다릅니다');
  if (boot.busy) return;
  boot.busy = true; if (btn) btn.disabled = true;
  try {
    /* POST /api/setup은 바로 {ok, role:'admin', token, expiresAt}를 준다 — login을 다시 부르지 않는다 */
    const r = await api('/api/setup', { password: pw }, { noAuth: true });
    if (!r.token) throw new Error('토큰이 없습니다');
    setToken(r.token);
    await afterAuth();
    toast('관리자 비밀번호를 만들었습니다');
  } catch (e) {
    toast('설정 실패 — ' + e.message);
    if (e.code === 'ALREADY_SETUP') { boot.health = Object.assign({}, boot.health, { setup: true }); render(); }
  } finally { boot.busy = false; if (btn) btn.disabled = false; }
}
async function changePassword(btn) {
  const cur = val('dk-pw-cur'), next = val('dk-pw-new'), next2 = val('dk-pw-new2');
  if (!cur) return toast('현재 비밀번호를 입력하세요');
  if (next.length < 8 || next.length > 72) return toast('새 비밀번호는 8~72자');
  if (next !== next2) return toast('새 비밀번호 두 칸이 다릅니다');
  if (btn) btn.disabled = true;
  try {
    await api('/api/password', { password: cur, newPassword: next });
    closeModal();
    toast('비밀번호를 바꿨습니다 — 다른 원장 기기는 다시 로그인해야 합니다');
  } catch (e) {
    toast(e.code === 'LOGIN_FAILED' ? '현재 비밀번호가 맞지 않습니다' : '변경 실패 — ' + e.message);
  } finally { if (btn) btn.disabled = false; }
}
function openPasswordForm() {
  modal('비밀번호 변경',
    '<div class="field"><label class="fl" for="dk-pw-cur">현재 비밀번호</label><input class="in" id="dk-pw-cur" type="password" autocomplete="current-password"></div>' +
    '<div class="field"><label class="fl" for="dk-pw-new">새 비밀번호 (8~72자)</label><input class="in" id="dk-pw-new" type="password" autocomplete="new-password"></div>' +
    '<div class="field"><label class="fl" for="dk-pw-new2">새 비밀번호 확인</label><input class="in" id="dk-pw-new2" type="password" autocomplete="new-password" data-enter="dk-pw-save"></div>' +
    '<div class="hint">바꾸면 이 기기만 남고 다른 원장 기기의 로그인은 풀립니다. 직원 링크는 그대로입니다.</div>',
    '<button class="btn btn-primary btn-block mt14" data-act="dk-pw-save">변경</button>');
}
async function doLogout() {
  if (outbox.size() && !confirm('저장되지 않은 변경 ' + outbox.size() + '건이 있습니다. 그래도 로그아웃할까요?')) return;
  try { await api('/api/logout', {}); } catch (e) { /* 토큰은 어차피 버린다 */ }
  setToken('');
  session = null;
  stopPolling();
  outbox.clear();
  state = emptyState();
  rosterDb = null;
  ui.staffPick = ''; ui.stuOpen = ''; ui.phoneShown = {};
  await loadHealth();
  route = 'login';
  history.replaceState(null, '', '#/login');
  render();
}

/* ── 라우터·렌더 ──────────────────────────────────── */

function go(r) {
  const key = String(r || '');
  const target = key.startsWith('p/') && DC.ROOMS.includes(key.slice(2)) ? '#/' + key
    : '#/' + (DC.ROUTES.includes(key) && key !== 'room' ? key : 'today');
  if (location.hash === target) { onHash(); return; }
  location.hash = target;
}
function onHash() {
  const r = DC.routeOf(location.hash);
  if (r.code) { linkExchange(r.code); return; }
  if (!session) { route = 'login'; render(); return; }
  applyRoute(r);
  render();
}
function renderAfterSync() { render(); }

function render() {
  const who = $('#who'), org = $('#orgName'), tabs = $('#tabs'), view = $('#view');
  if (!view) return;
  if (org) org.textContent = session ? String(state.settings.orgName || '') : '';
  if (who) {
    who.innerHTML = session
      ? '<span class="whoami' + (session.canApprove ? ' owner' : '') + '">' + esc(session.canApprove ? '원장' : session.name) + '</span>' +
        '<button class="btn-bar" data-act="dk-logout">로그아웃</button>'
      : '';
  }
  if (tabs) { tabs.hidden = !session; if (session) updateTabs(); }
  let h = '';
  try {
    if (!session) h = viewLogin();
    else {
      h = syncBanner();
      switch (route) {
        case 'today': h += viewToday(); break;
        case 'room': h += viewRoom(room); break;
        case 'manuals': h += viewManuals(); break;
        case 'matrix': h += session.canApprove ? viewMatrix() : viewToday(); break;
        case 'requests': h += viewRequests(); break;
        case 'students': h += viewStudents(); break;
        case 'assets': h += WBLedgerUI.view(); break;
        case 'perf': h += WBPerfPanel.view(); break;
        case 'contacts': h += viewContacts(); break;
        case 'admin': h += session.canApprove ? viewAdmin() : viewToday(); break;
        default: h += viewToday();
      }
    }
  } catch (e) {
    console.error('render', e);
    h = '<div class="card alert"><div class="card-title">화면을 그리지 못했습니다</div><div class="card-sub">' + esc(e && e.message || e) + '</div>' +
      '<button class="btn btn-sm btn-ghost mt8" data-act="dk-reload">다시 불러오기</button></div>';
  }
  view.innerHTML = h;
}

function updateTabs() {
  const wrap = $('#tabsWrap');
  if (!wrap || !session) return;
  const me = session.staffId;
  const openReq = WBRunbookUI.requests().filter(r => WBRunbookCore.isOpenRequest(r) && (r.assigneeId === me || (session.canApprove && !r.assigneeId))).length;
  const open = DC.cardsOn(state.cards, today()).open;
  const byRoom = DC.groupByRoom(open);
  const badges = {
    today: open.length,
    requests: openReq,
    assets: session.canApprove ? WBLedgerUI.alertCount() : 0,
    perf: WBPerfPanel.alertCount()
  };
  const hot = {};   // 막힘·지연이 있는 방은 빨간 배지
  DC.ROOMS.forEach(k => { badges['p/' + k] = byRoom[k].length; hot['p/' + k] = byRoom[k].some(c => c.status === 'blocked' || DC.cardLate(c, today())); });
  const isOn = t => route === 'room' ? t[0] === 'p/' + room : t[0] === route;
  const tab = t => '<a class="tab' + (isOn(t) ? ' on' : '') + '" href="#/' + t[0] + '" data-go="' + t[0] + '">' + esc(t[1]) +
    (badges[t[0]] ? '<span class="badge' + ((t[0] === 'today' || t[0].startsWith('p/')) && !hot[t[0]] ? ' soft' : '') + '">' + badges[t[0]] + '</span>' : '') + '</a>';
  wrap.innerHTML = '<div class="tabrow">' + TABS_ROOMS.map(tab).join('') + '</div>' +
    '<div class="tabrow sub">' + TABS_MORE.filter(t => !OWNER_ROUTES.includes(t[0]) || session.canApprove).map(tab).join('') + '</div>';
}

function syncBannerInner() {
  if (!syncErr) return '';
  return '<div class="banner bad">저장 대기 ' + outbox.size() + '건 · ' + esc(syncErr) +
    ' <button class="btn btn-sm btn-ghost" data-act="dk-retry">다시 시도</button></div>';
}
function syncBanner() { return '<div id="dk-sync">' + syncBannerInner() + '</div>'; }
/* 전체를 다시 그리지 않고 배너만 바꾼다 — 입력 중인 폼을 잃지 않게 */
function patchSyncBar() {
  const el = $('#dk-sync');
  if (el) el.innerHTML = syncBannerInner();
}

/* ── 화면: 로그인 ─────────────────────────────────── */

function viewLogin() {
  const setupNeeded = !!(boot.health && boot.health.setup === false);
  let h = '<div class="login"><div class="logo" aria-hidden="true">D</div><h1 class="page">WB 프로그램데스크</h1>' +
    '<div class="card-sub mb14">학생·구독 명단 · 직원 런북과 요청함 · 자료 원장 · 수행 확인 — 원내 직원 전용</div>';
  if (boot.err) {
    h += '<div class="banner bad">' + esc(boot.err) + ' <button class="btn btn-sm btn-ghost" data-act="dk-boot-retry">다시 시도</button></div>';
  }
  h += '<div class="card">';
  if (setupNeeded) {
    h += '<div class="card-title">관리자 비밀번호 만들기</div><div class="card-sub mb8">처음 접속입니다. 원장 계정 하나를 만듭니다(8~72자).</div>' +
      '<div class="field"><label class="fl" for="dk-pw">비밀번호</label><input class="in" id="dk-pw" type="password" autocomplete="new-password" data-enter="dk-setup"></div>' +
      '<div class="field"><label class="fl" for="dk-pw2">비밀번호 확인</label><input class="in" id="dk-pw2" type="password" autocomplete="new-password" data-enter="dk-setup"></div>' +
      '<button class="btn btn-primary btn-block" data-act="dk-setup">만들고 시작</button>';
  } else {
    h += '<div class="card-title">원장 로그인</div>' +
      '<div class="field mt8"><label class="fl" for="dk-pw">관리자 비밀번호</label><input class="in" id="dk-pw" type="password" autocomplete="current-password" data-enter="dk-login"></div>' +
      '<button class="btn btn-primary btn-block" data-act="dk-login">로그인</button>' +
      (boot.health ? '' : '<div class="hint mt8">서버 상태를 아직 확인하지 못했습니다 — 연결되면 자동으로 이어집니다.</div>');
  }
  h += '</div><div class="hint">직원은 원장이 보낸 개인 링크(<code>#c=…</code>)로 접속합니다 — 링크를 열면 이 기기가 자동으로 연결됩니다. 링크는 7일 안에 한 번만 쓸 수 있습니다.</div></div>';
  return h;
}

/* ── 화면: 오늘 ───────────────────────────────────── */

function datebar() {
  const isToday = cursor === today();
  return '<div class="datebar">' +
    '<button class="btn btn-ghost btn-sm" data-act="dk-date" data-n="-1" aria-label="전날">‹</button>' +
    '<div class="cur">' + esc(label(cursor)) + '<small>' + (isToday ? '오늘' : '<button class="btn btn-sm btn-ghost" data-act="dk-date" data-n="0">오늘로</button>') + '</small></div>' +
    '<button class="btn btn-ghost btn-sm" data-act="dk-date" data-n="1" aria-label="다음날">›</button></div>';
}
function currentStaff() {
  if (session.isStaffLink) return staffById(session.staffId) || { id: session.staffId, name: session.name };
  const list = liveStaff();
  if (!list.length) return null;
  return staffById(ui.staffPick) || list[0];
}
function staffChips(me) {
  const list = liveStaff();
  return '<div class="chips mb14">' + list.map(s =>
    '<button class="chip' + (me && s.id === me.id ? ' on' : '') + '" data-act="dk-staff-pick" data-id="' + esc(s.id) + '">' + esc(s.name) +
    ' <span class="muted">' + tasksFor(s.id, cursor).length + '</span></button>').join('') + '</div>';
}

function viewToday() {
  const me = currentStaff();
  let h = datebar();
  h += cardsBlock('', cursor);      // 기획서 v1.1 — 배정 카드가 먼저, 런북(정기 점검)은 그 아래
  if (session.canApprove) h += staffChips(me);
  if (!me) {
    return h + '<div class="empty"><b>직원이 없습니다</b>관리 탭에서 직원을 등록하고 개인 링크를 보내세요.</div>';
  }
  const isToday = cursor === today();
  if (session.isStaffLink && isToday) {
    const att = getCheck('__att__' + me.id, cursor);
    h += att && att.done
      ? '<div class="banner"><span class="pill ok">출근 ' + esc(DC.hmOf(att.at)) + '</span><span class="muted small">오늘도 수고하세요, ' + esc(me.name) + '님.</span></div>'
      : '<div class="banner warn"><span>출근하셨나요?</span><button class="btn btn-sm btn-primary" data-act="dk-att">출근했습니다</button></div>';
  }
  h += WBRunbookUI.todayBlocks(me, cursor);
  const list = tasksFor(me.id, cursor);
  const carried = isToday ? DC.carriedTasks(state.tasks, state.checks, me.id, cursor, 7) : [];
  const a = DC.alertsToday(state.tasks, state.checks, [me.id], cursor, isToday ? nowHM() : '23:59', WBRunbookCore.dueLimit);
  h += '<div class="card"><div class="between mb8"><div class="card-title">할 일 ' + list.length + '</div><div class="row wraprow" style="gap:4px">' +
    '<span class="pill' + (a.done === a.total && a.total ? ' ok' : '') + '">완료 ' + a.done + '/' + a.total + '</span>' +
    (a.late.length ? '<span class="pill warn">지연 ' + a.late.length + '</span>' : '') +
    (a.blocked.length ? '<span class="pill bad">막힘 ' + a.blocked.length + '</span>' : '') + '</div></div>';
  if (carried.length) {
    h += '<div class="sect">지난 미완료 — 오늘로 넘어왔습니다</div>' + carried.map(x => taskCard(x.task, x.date, true, { carry: true })).join('') + '<div class="sect">오늘</div>';
  }
  h += list.length ? list.map(t => taskCard(t, cursor, true, {})).join('')
    : '<div class="empty"><b>비어 있음</b>이 날 지시된 업무가 없습니다.' + (session.canApprove ? '<br>관리 탭 [런북 발행]으로 슬롯을 내려보내세요.' : '') + '</div>';
  h += '</div>';
  if (session.canApprove) h += '<button class="btn btn-ghost btn-block" data-act="dk-brief">마감 브리핑 복사</button>';
  return h;
}

function taskCard(t, date, editable, opts) {
  const o = opts || {};
  const c = getCheck(t.id, date);
  const st = DC.statusOf(t, c);
  const pr = DC.taskProgress(t, c);
  const steps = DC.taskSteps(t);
  const key = t.id + '|' + date;
  const open = ui.panels[key] != null ? ui.panels[key] : st !== 'done';
  const slot = WBRunbookCore.slotIdOf(t);
  const title = slot ? WBRunbookCore.stripSlotPrefix(t.title) : String(t.title || '');
  const limit = WBRunbookCore.dueLimit(t);
  const late = st !== 'done' && st !== 'blocked' && !!limit && date === today() && nowHM() > limit;
  const ids = ' data-id="' + esc(t.id) + '" data-date="' + esc(date) + '"';
  let h = '<div class="task ' + st + (st === 'blocked' ? ' isblocked' : '') + '" data-task="' + esc(t.id) + '">' +
    '<button class="box"' + (editable ? ' data-act="dk-toggle"' + ids : ' disabled') + ' aria-label="완료 표시" aria-pressed="' + (st === 'done') + '">✓</button>' +
    '<div class="task-body"><div class="task-t" data-act="dk-open" data-key="' + esc(key) + '">' + esc(title) + '</div>' +
    (t.detail ? '<div class="task-d">' + esc(t.detail) + '</div>' : '') +
    '<div class="meta">' +
      (o.carry ? '<span class="tag carry">⚠ ' + esc(DC.shortDate(date)) + ' 미완료</span>' : '') +
      (slot ? '<span class="tag cls">' + esc(slot) + '</span>' : '') +
      (t.time ? '<span class="tag time">' + esc(t.time) + (limit ? ' · 마감 ' + esc(limit) : '') + '</span>' : '') +
      (!o.carry && t.repeat ? '<span class="tag">' + esc(DC.repeatLabel(t)) + '</span>' : '') +
      (t.priority === 'high' ? '<span class="tag high">중요</span>' : '') +
      (st === 'blocked' ? '<span class="tag blk">막힘</span>' : '') +
      (st === 'doing' ? '<span class="tag doing">진행중 ' + pr.done + '/' + pr.total + esc(pr.unit) + '</span>' : '') +
      (late ? '<span class="tag blk">지연</span>' : '') +
      (st === 'done' && c && c.at ? '<span class="tag ok">✓ ' + esc(DC.hmOf(c.at)) + ' 완료</span>' : '') +
    '</div>';
  if (open) {
    const blocked = !!(c && c.blocked);
    const showCount = (Number(t.target) || 0) > 0 || (Number(c && c.count) || 0) > 0;
    h += '<div class="panel">' +
      (t.guide ? '<div class="guide"><b>이렇게 하세요</b>' + esc(t.guide) + '</div>' : '') +
      (steps.length ? '<div class="mt8">' + steps.map((s, i) => {
        const on = !!(c && c.steps && c.steps[s.id]);
        return '<div class="step' + (on ? ' on' : '') + '"><button class="sbox"' + (editable ? ' data-act="dk-step"' + ids + ' data-step="' + esc(s.id) + '"' : ' disabled') +
          ' aria-pressed="' + on + '" aria-label="단계 ' + (i + 1) + '">✓</button><span>' + (i + 1) + '. ' + esc(s.label) + '</span>' + WBRunbookUI.stepExt(s) + '</div>';
      }).join('') + '</div>' : '') +
      (showCount ? '<div class="counter"><span>수량</span>' +
        '<button class="btn btn-sm btn-ghost"' + (editable ? ' data-act="dk-cnt"' + ids + ' data-n="-1"' : ' disabled') + ' aria-label="빼기">−</button>' +
        '<b>' + (Number(c && c.count) || 0) + '</b>' +
        '<button class="btn btn-sm btn-ghost"' + (editable ? ' data-act="dk-cnt"' + ids + ' data-n="1"' : ' disabled') + ' aria-label="더하기">＋</button>' +
        '<span class="muted">' + (t.target ? '/ ' + t.target : '') + esc(t.unit || '건') + '</span></div>' : '') +
      '<div class="field mt8"><label class="fl" for="dk-note-' + esc(key) + '">메모 — 막힘·이월·수량이 있을 때만 한 줄 (학생 이름·연락처 금지)</label>' +
        '<textarea class="in" id="dk-note-' + esc(key) + '" rows="2" maxlength="' + DC.NOTE_MAX + '"' + (editable ? ' data-act="dk-note"' + ids : ' readonly') + '>' + esc(c && c.note || '') + '</textarea></div>';
    if (editable) {
      h += '<div class="row wraprow" style="gap:6px">' +
        (st === 'done'
          ? '<button class="btn btn-sm btn-ghost" data-act="dk-toggle"' + ids + '>완료 취소</button>'
          : '<button class="btn btn-sm btn-primary" data-act="dk-toggle"' + ids + '>✓ 완료</button>') +
        '<button class="btn btn-sm ' + (blocked ? 'btn-danger' : 'btn-warn') + '" data-act="dk-block"' + ids + '>' + (blocked ? '✓ 막힘 해제' : '🚧 막혔어요') + '</button>' +
        (session.canApprove ? '<button class="btn btn-sm btn-ghost" data-act="dk-task-stop"' + ids + '>지시 중단</button>' : '') +
        '</div>';
    }
    h += '</div>';
  }
  return h + '</div></div>';
}

/** 단계·수량이 다 차면 자동 완료, 되돌리면 자동 해제. */
function syncAuto(t, date) {
  const c = getCheck(t.id, date);
  if (!c) return;
  const full = DC.autoDone(t, c);
  if (full === null) return;
  if (full && !c.done) setCheck(t.id, date, { done: true, at: now() });
  else if (!full && c.done) setCheck(t.id, date, { done: false, at: null });
}

/* ── 화면: 요청함 ─────────────────────────────────── */

const REQ_FILTERS = [['open', '미처리'], ['mine', '내 담당'], ['requested', '접수 대기'], ['doing', '진행'], ['blocked', '막힘'], ['done', '완료·취소'], ['all', '전체']];

function reqMatches(r, f) {
  const C = WBRunbookCore;
  switch (f) {
    case 'open': return C.isOpenRequest(r);
    case 'mine': return C.isOpenRequest(r) && r.assigneeId === session.staffId;
    case 'requested': return r.status === 'requested';
    case 'doing': return r.status === 'accepted' || r.status === 'in_progress';
    case 'blocked': return r.status === 'blocked';
    case 'done': return r.status === 'done' || r.status === 'cancelled';
    default: return true;
  }
}

function viewRequests() {
  const C = WBRunbookCore;
  WBRunbookUI.ensureRequestsLoaded();
  const all = WBRunbookUI.requests();
  const list = C.sortRequests(all.filter(r => reqMatches(r, ui.reqFilter)));
  const open = all.filter(C.isOpenRequest).length;
  const overdue = all.filter(r => C.isOpenRequest(r) && r.neededBy && r.neededBy < today()).length;
  let h = '<div class="card"><div class="between mb8"><div class="card-title">요청함</div><div class="row" style="gap:4px">' +
    '<span class="pill' + (open ? ' warn' : '') + '">미처리 ' + open + '</span>' + (overdue ? '<span class="pill bad">기한 지남 ' + overdue + '</span>' : '') + '</div></div>' +
    '<div class="card-sub mb8">계정 발급·세트 배정·문제지·후속 연락은 카톡 대신 여기로 올립니다. 대상은 SF 코드·학생 ID로만 적습니다.</div>' +
    (ui.reqErr ? '<div class="banner bad">' + esc(ui.reqErr) + ' <button class="btn btn-sm btn-ghost" data-act="rb-req-refresh">다시 시도</button></div>' : '') +
    '<div class="chips">' + REQ_FILTERS.map(f => '<button class="chip' + (ui.reqFilter === f[0] ? ' on' : '') + '" data-act="dk-req-filter" data-v="' + f[0] + '">' + f[1] +
      ' <span class="muted">' + all.filter(r => reqMatches(r, f[0])).length + '</span></button>').join('') + '</div></div>';
  h += '<div class="card">' + (list.length ? list.map(requestCard).join('')
    : '<div class="empty"><b>비어 있음</b>' + (ui.reqErr ? '요청함을 불러오지 못했습니다.' : '이 조건의 요청이 없습니다.') + '</div>') + '</div>';
  h += '<div class="row wraprow mb14" style="gap:6px">' +
    '<button class="btn btn-primary" data-act="rb-req-new">＋ 운영 요청</button>' +
    (session.canApprove ? '<button class="btn btn-ghost" data-act="rb-req-new" data-via="kakao">＋ 카톡 요청 대신 등록</button>' : '') +
    '<button class="btn btn-ghost" data-act="rb-req-refresh">새로고침</button></div>';
  return h;
}

function requestCard(r) {
  const C = WBRunbookCore, L = WBExternalLinks;
  const me = session.staffId;
  const ctx = { role: session.canApprove ? 'admin' : 'staff', isOwner: r.ownerId === me, isAssignee: r.assigneeId === me };
  const actions = C.allowedActions(r.status, ctx);
  const overdue = C.isOpenRequest(r) && r.neededBy && r.neededBy < today();
  const stCls = r.status === 'done' ? 'ok' : r.status === 'blocked' ? 'blk' : (r.status === 'accepted' || r.status === 'in_progress') ? 'doing' : '';
  const cardCls = (r.status === 'done' || r.status === 'cancelled') ? 'done' : r.status === 'blocked' ? 'blocked isblocked' : (r.status === 'requested' ? 'todo' : 'doing');
  const progKey = L.keys().find(k => L.programOf(k) === r.program && /_(admin|teacher|center|org)$|^(exam4you|jokbo)$/.test(k));
  const link = progKey && C.isOpenRequest(r) ? L.linkFor(progKey) : null;
  return '<div class="task ' + cardCls + '" data-rb-req="' + esc(r.id) + '"><div class="task-body">' +
    '<div class="task-t">' + esc(C.REQ_TYPE_LABEL[r.reqType] || r.reqType) + ' · ' + esc(C.PROGRAM_LABEL[r.program] || r.program) +
      (r.targetRef ? ' · <span class="muted">' + esc(r.targetRef) + '</span>' : '') + '</div>' +
    '<div class="meta"><span class="tag ' + stCls + '">' + esc(C.REQ_STATUS_LABEL[r.status] || r.status) + '</span>' +
      (r.neededBy ? '<span class="tag time">필요 ' + esc(r.neededBy) + '</span>' : '') +
      (overdue ? '<span class="tag blk">기한 지남</span>' : '') +
      (r.via === 'kakao' ? '<span class="tag">카톡 경유</span>' : r.via === 'auto' ? '<span class="tag">자동</span>' : '') +
      '<span class="tag">담당 ' + esc(r.assigneeId ? staffName(r.assigneeId) : '미지정') + '</span>' +
      '<span class="tag">요청 ' + esc(staffName(r.ownerId)) + '</span>' +
      (r.createdAt ? '<span class="tag">' + esc(fmtAt(r.createdAt)) + '</span>' : '') + '</div>' +
    (r.detail ? '<div class="task-d">' + esc(r.detail) + '</div>' : '') +
    (r.resultNote ? '<div class="small muted mt8">' + (r.status === 'blocked' ? '사유: ' : '결과: ') + esc(r.resultNote) + '</div>' : '') +
    (r.resultUrl && L.isApprovedLink(r.resultUrl) ? '<a class="btn btn-sm btn-ghost mt8" href="' + esc(r.resultUrl) + '" target="_blank" rel="noopener noreferrer">↗ 결과 링크</a>' : '') +
    ((actions.length || link || requestCardable(r)) ? '<div class="row wraprow mt8" style="gap:6px">' + actions.map(a =>
      '<button class="btn btn-sm ' + (a === 'done' ? 'btn-primary' : a === 'block' ? 'btn-danger' : a === 'cancel' ? 'btn-ghost' : 'btn-navy') +
      '" data-act="rb-req-act" data-id="' + esc(r.id) + '" data-action="' + esc(a) + '">' + esc(C.REQ_ACTION_LABEL[a] || a) + '</button>').join('') +
      (link ? '<a class="btn btn-sm btn-ghost" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(link.label) + '</a>' : '') +
      requestCardButton(r) + '</div>' : '') +
    '</div></div>';
}

/* 요청 → 배정 카드 (기획서 v1.1 §1.4 — 요청함이 카드의 씨앗). 카드 id 가 요청 id 로 정해져 두 번 만들 수 없다. */
const REQ_TO_TASK = { assignment: 'assign', worksheet: 'assign', account: 'account', followup: 'followup' };
function requestCardable(r) { return WBRunbookCore.isOpenRequest(r) && DC.ROOMS.includes(r.program) && !!REQ_TO_TASK[r.reqType]; }
function requestCardButton(r) {
  if (!requestCardable(r)) return '';
  const existing = cardById('q:' + r.id);
  return existing
    ? '<a class="btn btn-sm btn-ghost" href="#/p/' + esc(r.program) + '" data-go="p/' + esc(r.program) + '">카드 보기 · ' + esc(DC.CARD_STATUS_LABEL[existing.status] || existing.status) + '</a>'
    : '<button class="btn btn-sm btn-navy" data-act="dk-req-card" data-id="' + esc(r.id) + '">카드로</button>';
}
function requestToCard(id) {
  const r = WBRunbookUI.requests().find(x => String(x.id) === String(id));
  if (!r || !requestCardable(r)) return toast('카드로 만들 수 없는 요청입니다');
  if (cardById('q:' + r.id)) return toast('이미 카드가 있습니다');
  const C = WBRunbookCore;
  const ref = String(r.targetRef || '');
  const target = studentById(ref) ? { type: 'student', id: ref } : { type: 'text', label: ref || '(대상 없음)' };
  const manual = DC.manualsFor(state.manuals, r.program).find(m => m.task === REQ_TO_TASK[r.reqType]);
  const what = (String(C.REQ_TYPE_LABEL[r.reqType] || r.reqType) + (r.detail ? ' — ' + String(r.detail) : '')).slice(0, 120);
  const v = DC.validateCard({ program: r.program, targetType: target.type, targetId: target.id || '', targetLabel: target.label || '', what: what, due: r.neededBy || '', manualId: manual ? manual.id : '', source: 'request:' + r.id });
  if (v.error) return toast(v.error);
  addDoc('cards', 'q:' + r.id, Object.assign({}, v.value, { createdAt: now() }));
  render(); toast('카드를 만들었습니다 — ' + roomLabel(r.program) + ' 방에서 처리합니다');
}

function fmtAt(ms) {
  const n = Number(ms);
  if (!(n > 0)) return '';
  const d = new Date(n);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + DC.hmOf(n);
}

/* ── 화면: 학생·구독 명단 ─────────────────────────── */

function students() { return state.students.filter(s => s && !s.deleted); }
function studentById(id) { return state.students.find(s => s && String(s.id) === String(id)) || null; }
function studentName(id) { const s = studentById(id); return s ? String(s.name) : '(삭제된 학생)'; }
function statusPill(s) {
  const st = String(s.status || 'active');
  return '<span class="pill' + (st === 'active' ? ' ok' : st === 'paused' ? ' warn' : '') + '">' + esc(DC.STUDENT_STATUS_LABEL[st] || st) + '</span>';
}

function viewStudents() {
  const all = students();
  const counts = { all: all.length };
  DC.STUDENT_STATUS.forEach(k => { counts[k] = all.filter(s => String(s.status || 'active') === k).length; });
  return '<div class="card"><div class="between mb8"><div class="card-title">학생·구독 명단 <span class="muted small">' + all.length + '명</span></div>' +
    '<button class="btn btn-sm btn-primary" data-act="dk-stu-new">＋ 학생</button></div>' +
    '<input class="in" id="dk-stu-q" type="search" placeholder="이름·코드·학년 검색" value="' + esc(ui.stuQ) + '" data-act="dk-stu-q" autocomplete="off" aria-label="학생 검색">' +
    '<div class="chips mt8">' + [['all', '전체']].concat(DC.STUDENT_STATUS.map(k => [k, DC.STUDENT_STATUS_LABEL[k]])).map(f =>
      '<button class="chip' + (ui.stuStatus === f[0] ? ' on' : '') + '" data-act="dk-stu-status" data-v="' + f[0] + '">' + f[1] + ' <span class="muted">' + counts[f[0]] + '</span></button>').join('') + '</div>' +
    '<div class="hint mt8">보호자 전화는 가려서 보이고, 누르면 전체 번호와 전화 걸기 링크가 나옵니다. 화면에 학생 정보를 캡처해 밖으로 보내지 않습니다.</div></div>' +
    '<div class="card" id="dk-stu-list">' + studentList() + '</div>';
}
function studentList() {
  const rows = DC.searchStudents(state.students, ui.stuQ, ui.stuStatus);
  if (!rows.length) return '<div class="empty"><b>비어 있음</b>' + (students().length ? '조건에 맞는 학생이 없습니다.' : '[＋ 학생]으로 첫 학생을 등록하세요.') + '</div>';
  return rows.map(studentRow).join('');
}
function studentRow(s) {
  const open = ui.stuOpen === s.id;
  const progs = s.programs && typeof s.programs === 'object' ? s.programs : {};
  const active = DC.PROGRAMS.filter(k => progs[k] && progs[k].active);
  let h = '<div class="stu"><div class="stu-head" data-act="dk-stu-open" data-id="' + esc(s.id) + '" role="button" tabindex="0" aria-expanded="' + open + '">' +
    '<span class="stu-name">' + esc(s.name) + '</span>' +
    (s.grade ? '<span class="tag">' + esc(s.grade) + '</span>' : '') +
    (s.code ? '<span class="tag cls">' + esc(s.code) + '</span>' : '') + statusPill(s) +
    '<span class="row wraprow" style="margin-left:auto;gap:4px;justify-content:flex-end">' + active.map(k => {
      const acc = String(progs[k].account || 'none');
      return '<span class="tag' + (acc === 'issued' ? ' ok' : acc === 'requested' ? ' doing' : '') + '" title="' + esc(DC.ACCOUNT_LABEL[acc]) + '">' + esc(DC.PROGRAM_LABEL[k]) + '</span>';
    }).join('') + '</span></div>';
  if (open) h += studentDetail(s, progs);
  return h + '</div>';
}
function studentDetail(s, progs) {
  const g = s.guardian && typeof s.guardian === 'object' ? s.guardian : {};
  const phone = String(g.phone || '');
  const shown = !!ui.phoneShown[s.id];
  const recent = state.contacts.filter(c => c && String(c.studentId) === String(s.id)).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 3);
  let h = '<div class="stu-detail">';
  if (s.school) h += '<div class="small muted">학교: ' + esc(s.school) + '</div>';
  h += '<div class="sect" style="margin-top:4px">프로그램</div>' + DC.PROGRAMS.map(k => {
    const p = progs[k] && typeof progs[k] === 'object' ? progs[k] : {};
    return '<div class="prog-row"><span><b>' + esc(DC.PROGRAM_LABEL[k]) + '</b>' + (p.plan ? ' <span class="muted">' + esc(p.plan) + '</span>' : '') +
      (p.since || p.until ? '<div class="small muted">' + esc(p.since || '') + (p.until ? ' ~ ' + esc(p.until) : '') + '</div>' : '') + '</span>' +
      '<span class="row" style="gap:4px">' + (p.active ? '<span class="pill ok">이용</span>' : '<span class="pill null">미이용</span>') +
      '<span class="pill' + (p.account === 'issued' ? ' ok' : p.account === 'requested' ? ' warn' : '') + '">' + esc(DC.ACCOUNT_LABEL[p.account] || DC.ACCOUNT_LABEL.none) + '</span></span></div>';
  }).join('');
  h += '<dl class="kv mt8">' +
    '<dt>보호자</dt><dd>' + (g.relation ? esc(g.relation) + ' · ' : '') +
      (phone ? (shown ? '<a class="tel" href="tel:' + esc(phone.replace(/\D/g, '')) + '">' + esc(DC.normalizePhone(phone)) + '</a> <button class="btn btn-sm btn-ghost" data-act="dk-phone" data-id="' + esc(s.id) + '">가리기</button>'
        : '<button class="tel" data-act="dk-phone" data-id="' + esc(s.id) + '" aria-label="전화번호 보기">' + esc(DC.maskPhone(phone)) + '</button>') : '<span class="muted">번호 없음</span>') +
      ' ' + (g.consent ? '<span class="pill ok">연락 동의</span>' : '<span class="pill warn">동의 없음</span>') + '</dd>' +
    '<dt>시작</dt><dd>' + esc(s.since || '—') + '</dd>' +
    '<dt>메모</dt><dd>' + (s.memo ? esc(s.memo) : '<span class="muted">—</span>') + '</dd>' +
    '<dt>주간 수행</dt><dd>' + weekPerfHtml(s.id) + '</dd>' +
    '<dt>최근 연락</dt><dd>' + (recent.length ? recent.map(c => '<div class="small">' + esc(fmtAt(c.at)) + ' · ' + esc(DC.CONTACT_TYPE_LABEL[c.type] || c.type) + ' · ' +
      esc(DC.CONTACT_RESULT_LABEL[c.result] || c.result) + (c.note ? ' — ' + esc(c.note) : '') + ' <span class="muted">(' + esc(staffName(c.by)) + ')</span></div>').join('') : '<span class="muted">없음</span>') + '</dd></dl>';
  h += '<div class="row wraprow mt8" style="gap:6px">' +
    '<button class="btn btn-sm btn-navy" data-act="dk-contact-new" data-sid="' + esc(s.id) + '">＋ 연락 기록</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-stu-edit" data-id="' + esc(s.id) + '">수정</button>' +
    (session.canApprove ? '<button class="btn btn-sm btn-danger" data-act="dk-stu-del" data-id="' + esc(s.id) + '">삭제</button>' : '') + '</div>';
  return h + '</div>';
}
function perfCtx() {
  const P = WBPerfCore;
  const ch = state.checks;
  return {
    checks: ch, today: today(), now: now(),
    students: ((rosterDb && rosterDb.students) || []).map(s => ({ id: String(s.id), name: String(s.name) })),
    perfsetOf: id => ch[P.perfsetKey(id)] || null,
    absentOn: () => false,
    onboardingAccountDate: () => null,
    mondayOf: mondayOf
  };
}
function weekPerfHtml(id) {
  const P = WBPerfCore;
  const ps = state.checks[P.perfsetKey(id)];
  if (!ps || !P.normalizePerfset(ps).progs.length) return '<span class="muted small">수행 설정 없음 — 수행 탭 › 설정에서 프로그램을 지정합니다</span>';
  const ws = P.weekSummary(perfCtx(), id, mondayOf(today()));
  return Object.keys(ws.progs).map(p => {
    const r = ws.progs[p];
    const cls = r.ratio == null ? '' : r.ratio >= 0.8 ? ' ok' : r.ratio >= 0.5 ? ' warn' : ' bad';
    return '<span class="pill' + cls + '">' + esc(P.PROG_LABEL[p] || p) + ' ' + r.daysDone + '/' + r.target + (r.unknown ? ' · ?' + r.unknown : '') + '</span>';
  }).join(' ');
}

function studentForm(s) {
  const v = s || { programs: {}, guardian: {} };
  const progs = v.programs || {};
  const g = v.guardian || {};
  const opt = (list, labels, cur) => list.map(k => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(labels[k]) + '</option>').join('');
  return '<div class="grid2">' +
    '<div class="field"><label class="fl" for="dk-f-name">이름 *</label><input class="in" id="dk-f-name" maxlength="40" value="' + esc(v.name || '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-f-grade">학년</label><input class="in" id="dk-f-grade" maxlength="10" placeholder="중2" value="' + esc(v.grade || '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-f-school">학교 (시험 템플릿이 학교·학년으로 대상을 고릅니다)</label><input class="in" id="dk-f-school" maxlength="40" list="dk-schools" placeholder="OO중" value="' + esc(v.school || '') + '">' + schoolDatalist() + '</div>' +
    '<div class="field"><label class="fl" for="dk-f-code">외부 코드</label><input class="in" id="dk-f-code" maxlength="20" placeholder="SF-012" value="' + esc(v.code || '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-f-status">상태</label><select class="in" id="dk-f-status">' + opt(DC.STUDENT_STATUS, DC.STUDENT_STATUS_LABEL, v.status || 'active') + '</select></div>' +
    '<div class="field"><label class="fl" for="dk-f-since">시작 월</label><input class="in" id="dk-f-since" type="month" value="' + esc(v.since || '') + '"></div></div>' +
    '<div class="sect">프로그램 4종</div>' + DC.PROGRAMS.map(k => {
      const p = progs[k] || {};
      return '<div class="card" style="padding:10px;margin-bottom:8px"><label class="check"><input type="checkbox" id="dk-f-' + k + '-active"' + (p.active ? ' checked' : '') + '> <b>' + esc(DC.PROGRAM_LABEL[k]) + '</b> 이용</label>' +
        '<div class="grid2 mt8"><div class="field"><label class="fl" for="dk-f-' + k + '-plan">상품·단계</label><input class="in" id="dk-f-' + k + '-plan" maxlength="40" value="' + esc(p.plan || '') + '"></div>' +
        '<div class="field"><label class="fl" for="dk-f-' + k + '-account">계정</label><select class="in" id="dk-f-' + k + '-account">' + opt(DC.ACCOUNT_STATES, DC.ACCOUNT_LABEL, p.account || 'none') + '</select></div>' +
        '<div class="field"><label class="fl" for="dk-f-' + k + '-since">시작일</label><input class="in" id="dk-f-' + k + '-since" type="date" value="' + esc(p.since || '') + '"></div>' +
        '<div class="field"><label class="fl" for="dk-f-' + k + '-until">종료일</label><input class="in" id="dk-f-' + k + '-until" type="date" value="' + esc(p.until || '') + '"></div></div></div>';
    }).join('') +
    '<div class="sect">보호자</div><div class="grid2">' +
    '<div class="field"><label class="fl" for="dk-f-g-rel">관계</label><input class="in" id="dk-f-g-rel" maxlength="10" placeholder="모" value="' + esc(g.relation || '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-f-g-phone">전화 (숫자·하이픈)</label><input class="in" id="dk-f-g-phone" type="tel" inputmode="numeric" maxlength="14" value="' + esc(g.phone || '') + '"></div></div>' +
    '<label class="check"><input type="checkbox" id="dk-f-g-consent"' + (g.consent ? ' checked' : '') + '> 연락 동의(안내·수행 확인 연락)</label>' +
    '<div class="field mt8"><label class="fl" for="dk-f-memo">메모 (300자 · 전화번호·이메일 금지)</label><textarea class="in" id="dk-f-memo" rows="2" maxlength="300">' + esc(v.memo || '') + '</textarea></div>' +
    '<div class="hint">전화번호는 보호자 전화 칸에만 적습니다. 다른 칸에 전화·이메일·주민번호가 있으면 서버가 거절합니다.</div>';
}
function openStudentForm(id) {
  const s = id ? studentById(id) : null;
  if (id && !s) return toast('학생을 찾을 수 없습니다');
  modal(s ? '학생 수정' : '학생 등록', studentForm(s),
    '<button class="btn btn-primary btn-block mt14" data-act="dk-stu-save" data-id="' + esc(s ? s.id : '') + '">' + (s ? '저장' : '등록') + '</button>');
}
function readStudentForm() {
  const programs = {};
  DC.PROGRAMS.forEach(k => {
    programs[k] = { active: checked('dk-f-' + k + '-active'), plan: val('dk-f-' + k + '-plan'), account: val('dk-f-' + k + '-account'), since: val('dk-f-' + k + '-since'), until: val('dk-f-' + k + '-until') };
  });
  return {
    name: val('dk-f-name'), grade: val('dk-f-grade'), school: val('dk-f-school'), code: val('dk-f-code'), status: val('dk-f-status'), since: val('dk-f-since'), memo: val('dk-f-memo'),
    programs: programs, guardian: { relation: val('dk-f-g-rel'), phone: val('dk-f-g-phone'), consent: checked('dk-f-g-consent') }
  };
}
function saveStudent(id) {
  const v = DC.validateStudent(readStudentForm());
  if (!v.ok) return toast(v.errors[0].reason);
  const existing = id ? studentById(id) : null;
  /* 학생 id는 요청함 targetRef 규칙(^[A-Za-z0-9_-]{1,64}$)에 맞춘 'stu_' + 12자 */
  const doc = Object.assign({}, existing || { createdAt: now(), createdBy: session.staffId }, v.value, { id: existing ? existing.id : 'stu_' + DC.slug(12), updatedAt: now() });
  /* 폼에서 비운 선택 필드는 문서에서도 지운다(Object.assign은 없는 키를 지우지 않는다) */
  ['code', 'since'].forEach(k => { if (!v.value[k]) delete doc[k]; });
  const i = state.students.findIndex(s => s && s.id === doc.id);
  if (i >= 0) state.students[i] = doc; else state.students.push(doc);
  queueChange('students', doc.id, doc);
  refreshRoster();
  ui.stuOpen = doc.id;
  closeModal();
  render();
  toast(existing ? '저장했습니다' : '학생을 등록했습니다');
}
function deleteStudent(id) {
  const s = studentById(id);
  if (!s) return;
  if (!confirm('"' + s.name + '" 학생을 삭제할까요? 연락 기록은 남습니다.')) return;
  state.students = state.students.filter(x => x.id !== id);
  queueChange('students', id, Object.assign({}, s, { deleted: true }), true);
  refreshRoster();
  ui.stuOpen = '';
  render();
  toast('삭제했습니다');
}

/* ── 화면: 연락 기록 ──────────────────────────────── */

function viewContacts() {
  const q = ui.ctQ.trim();
  const list = state.contacts.filter(c => c && !c.deleted).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .filter(c => !q || studentName(c.studentId).includes(q)).slice(0, 200);
  return '<div class="card"><div class="between mb8"><div class="card-title">연락 기록</div>' +
    '<button class="btn btn-sm btn-primary" data-act="dk-contact-new">＋ 연락 기록</button></div>' +
    '<input class="in" id="dk-ct-q" type="search" placeholder="학생 이름으로 찾기" value="' + esc(ui.ctQ) + '" data-act="dk-ct-q" autocomplete="off" aria-label="학생 이름 검색">' +
    '<div class="hint mt8">누가·언제·어떻게 연락했고 결과가 무엇인지만 남깁니다. 통화 내용의 개인정보는 적지 않습니다.</div></div>' +
    '<div class="card" id="dk-ct-list">' + contactList(list) + '</div>';
}
function contactList(list) {
  if (!list.length) return '<div class="empty"><b>비어 있음</b>연락 기록이 없습니다.</div>';
  return list.map(c => '<div class="task"><div class="task-body"><div class="task-t">' + esc(studentName(c.studentId)) +
    ' <span class="tag">' + esc(DC.CONTACT_TYPE_LABEL[c.type] || c.type) + '</span> ' +
    '<span class="pill' + (c.result === 'reached' ? ' ok' : c.result === 'no_answer' ? ' warn' : '') + '">' + esc(DC.CONTACT_RESULT_LABEL[c.result] || c.result) + '</span></div>' +
    (c.note ? '<div class="task-d">' + esc(c.note) + '</div>' : '') +
    '<div class="meta"><span class="tag">' + esc(fmtAt(c.at)) + '</span><span class="tag">' + esc(staffName(c.by)) + '</span></div></div></div>').join('');
}
function openContactForm(studentId) {
  const list = students().slice().sort((a, b) => (String(a.status || 'active') === 'active' ? 0 : 1) - (String(b.status || 'active') === 'active' ? 0 : 1) || String(a.name).localeCompare(String(b.name), 'ko'));
  if (!list.length) return toast('먼저 학생을 등록하세요');
  const opt = (list2, labels, cur) => list2.map(k => '<option value="' + k + '"' + (k === cur ? ' selected' : '') + '>' + esc(labels[k]) + '</option>').join('');
  modal('연락 기록',
    '<div class="field"><label class="fl" for="dk-c-sid">학생</label><select class="in" id="dk-c-sid">' + list.map(s =>
      '<option value="' + esc(s.id) + '"' + (s.id === studentId ? ' selected' : '') + '>' + esc(s.name) + (s.grade ? ' · ' + esc(s.grade) : '') + (s.status && s.status !== 'active' ? ' (' + esc(DC.STUDENT_STATUS_LABEL[s.status]) + ')' : '') + '</option>').join('') + '</select></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-c-type">유형</label><select class="in" id="dk-c-type">' + opt(DC.CONTACT_TYPES, DC.CONTACT_TYPE_LABEL, 'call') + '</select></div>' +
    '<div class="field"><label class="fl" for="dk-c-result">결과</label><select class="in" id="dk-c-result">' + opt(DC.CONTACT_RESULTS, DC.CONTACT_RESULT_LABEL, 'reached') + '</select></div></div>' +
    '<div class="field"><label class="fl" for="dk-c-note">한 줄 (200자 · 선택)</label><textarea class="in" id="dk-c-note" rows="2" maxlength="' + DC.CONTACT_NOTE_MAX + '" placeholder="예) 과제 배정 안내, 다음 주 재확인"></textarea></div>' +
    '<div class="hint">전화번호·이메일은 적지 않습니다.</div>',
    '<button class="btn btn-primary btn-block mt14" data-act="dk-contact-save">기록</button>');
}
function saveContact() {
  const v = DC.validateContact({ studentId: val('dk-c-sid'), type: val('dk-c-type'), result: val('dk-c-result'), note: val('dk-c-note') });
  if (!v.ok) return toast(v.errors[0].reason);
  const doc = Object.assign({}, v.value, { id: 'ct_' + uid(), at: now(), by: session.staffId });
  state.contacts.push(doc);
  queueChange('contacts', doc.id, doc);
  closeModal();
  render();
  toast('연락 기록을 남겼습니다');
}

/* ── 화면: 관리(원장) ─────────────────────────────── */

function viewAdmin() {
  const list = state.staff.filter(s => s && !s.deleted);
  let h = '<div class="card"><div class="between mb8"><div class="card-title">직원</div><button class="btn btn-sm btn-primary" data-act="dk-staff-new">＋ 직원</button></div>' +
    '<div class="card-sub mb8">직원은 비밀번호가 없습니다. [링크 발급]으로 받은 개인 링크를 카톡으로 보내면, 그 폰이 7일 안에 한 번 열어 연결됩니다. 기기를 바꾸면 다시 발급합니다.</div>';
  h += list.length ? list.map(s => {
    const on = s.active !== false && s.active !== 0;
    return '<div class="task"><div class="task-body"><div class="between"><div><span class="task-t">' + esc(s.name) + '</span> ' +
      (on ? '<span class="pill ok">활성</span>' : '<span class="pill">비활성</span>') + ' <span class="muted small">' + esc(s.id) + '</span></div></div>' +
      '<div class="row wraprow mt8" style="gap:6px">' +
      (on ? '<button class="btn btn-sm btn-navy" data-act="dk-staff-link" data-id="' + esc(s.id) + '">링크 발급</button>' : '') +
      '<button class="btn btn-sm btn-ghost" data-act="dk-staff-rename" data-id="' + esc(s.id) + '">이름 변경</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="dk-staff-toggle" data-id="' + esc(s.id) + '" data-on="' + (on ? 1 : 0) + '">' + (on ? '비활성' : '활성') + '</button>' +
      '<button class="btn btn-sm btn-danger" data-act="dk-staff-revoke" data-id="' + esc(s.id) + '">기기 연결 해제</button></div></div></div>';
  }).join('') : '<div class="empty"><b>직원이 없습니다</b>[＋ 직원]으로 등록하세요.</div>';
  h += '</div>';
  h += appsSection() + examsSection('') + templatesSection();
  h += datebar() + WBRunbookUI.boardCard(cursor);
  h += '<div class="card"><div class="card-title">설정</div>' +
    '<dl class="kv mt8"><dt>조직 이름</dt><dd>' + esc(state.settings.orgName || '—') + '</dd>' +
    '<dt>요청 접수 암호</dt><dd>' + (state.settings.requestPasscode ? '설정됨' : '—') + '</dd></dl>' +
    '<div class="row wraprow mt8" style="gap:6px">' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-settings">설정 변경</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-pw-change">비밀번호 변경</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-export">JSON 내보내기</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-brief">마감 브리핑 복사</button></div>' +
    '<div class="hint mt8">내보내기는 <code>/api/export</code>(원장 토큰 필요)의 백업 JSON입니다 — 학생 개인정보가 들어 있으니 원내 저장소에만 둡니다.</div></div>';
  return h;
}

async function staffOp(body, btn) {
  if (btn) btn.disabled = true;
  try { return await api('/api/staff', body); }
  catch (e) { toast('직원 관리 실패 — ' + e.message); return null; }
  finally { if (btn) btn.disabled = false; }
}
function openStaffForm() {
  modal('직원 등록', '<div class="field"><label class="fl" for="dk-s-name">이름 (1~40자)</label><input class="in" id="dk-s-name" maxlength="40" data-enter="dk-staff-save"></div>' +
    '<div class="hint">등록 뒤 [링크 발급]으로 개인 링크를 만들어 보냅니다. 지시서의 직원 이름과 같아야 합니다.</div>',
    '<button class="btn btn-primary btn-block mt14" data-act="dk-staff-save">등록</button>');
}
async function saveStaff(btn) {
  const name = val('dk-s-name');
  if (!name) return toast('이름을 입력하세요');
  const r = await staffOp({ op: 'create', name: name }, btn);
  if (!r) return;
  const s = r.staff || {};
  if (s.id) {
    const i = state.staff.findIndex(x => x.id === s.id);
    if (i >= 0) state.staff[i] = s; else state.staff.push(s);
  }
  closeModal(); render(); toast('직원을 등록했습니다');
}
async function issueLink(id, btn) {
  const s = staffById(id);
  if (!s) return;
  const r = await staffOp({ op: 'link', staffId: id }, btn);
  if (!r || !r.code) return;
  const link = DC.inviteLink(location.origin, location.pathname, r.code);
  modal(s.name + ' 개인 링크',
    '<textarea class="in" id="dk-link-text" rows="3" readonly>' + esc(link) + '</textarea>' +
    '<div class="hint mt8">' + (r.expiresAt ? '만료 ' + esc(fmtAt(r.expiresAt)) + ' · ' : '') + '한 번 열면 그 기기에 연결되고 링크는 소진됩니다. 카톡 등으로 본인에게만 보내세요.</div>',
    '<button class="btn btn-navy btn-block mt14" data-act="dk-copy" data-target="dk-link-text">복사</button>');
}
function openRenameForm(id) {
  const s = staffById(id);
  if (!s) return;
  modal('직원 이름 변경', '<div class="field"><label class="fl" for="dk-s-name">이름 (1~40자)</label><input class="in" id="dk-s-name" maxlength="40" value="' + esc(s.name) + '" data-enter="dk-staff-rename-save"></div>' +
    '<div class="hint">런북 발행·지시서는 직원 이름으로 사람을 찾습니다 — 이미 발행된 지시서는 그대로 이 직원(id)에 남습니다.</div>',
    '<button class="btn btn-primary btn-block mt14" data-act="dk-staff-rename-save" data-id="' + esc(id) + '">변경</button>');
}
async function renameStaff(id, btn) {
  const name = val('dk-s-name');
  if (!name) return toast('이름을 입력하세요');
  const r = await staffOp({ op: 'rename', staffId: id, name: name }, btn);
  if (!r) return;
  const s = staffById(id);
  if (s && r.staff) s.name = r.staff.name;
  closeModal(); render(); toast('이름을 바꿨습니다');
}
async function toggleStaff(id, on, btn) {
  const r = await staffOp({ op: on ? 'deactivate' : 'activate', staffId: id }, btn);
  if (!r) return;
  const s = staffById(id);
  if (s) s.active = !on;
  render(); toast(on ? '비활성으로 바꿨습니다' : '활성으로 바꿨습니다');
}
async function revokeStaff(id, btn) {
  const s = staffById(id);
  if (!s || !confirm('"' + s.name + '"의 연결된 기기를 모두 해제할까요? 다시 쓰려면 링크를 새로 발급합니다.')) return;
  const r = await staffOp({ op: 'revoke', staffId: id }, btn);
  if (r) toast('기기 연결을 해제했습니다');
}
function openSettings() {
  modal('설정',
    '<div class="field"><label class="fl" for="dk-set-org">조직 이름 (앱바에 표시 · 40자)</label><input class="in" id="dk-set-org" maxlength="40" value="' + esc(state.settings.orgName || '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-set-pass">요청 접수 암호 (40자 · 선택)</label><input class="in" id="dk-set-pass" maxlength="40" value="' + esc(state.settings.requestPasscode || '') + '"></div>',
    '<button class="btn btn-primary btn-block mt14" data-act="dk-settings-save">저장</button>');
}
function saveSettings() {
  const next = Object.assign({}, state.settings, { orgName: val('dk-set-org'), requestPasscode: val('dk-set-pass') });
  if (DC.hasPII(next.orgName)) return toast('조직 이름에 전화번호를 넣을 수 없습니다');
  state.settings = next;
  queueChange('settings', 'main', next);
  closeModal(); render(); toast('설정을 저장했습니다');
}
async function exportJson(btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + getToken() }, cache: 'no-store' });
    if (res.status === 401) { onAuthLost(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'wb-desk-' + today() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('백업 JSON을 내려받습니다');
  } catch (e) { toast('내보내기 실패 — ' + e.message); }
  finally { if (btn) btn.disabled = false; }
}
function openBrief() {
  modal('마감 브리핑 — ' + label(cursor),
    '<textarea class="in" id="dk-brief-text" rows="14" readonly>' + esc(briefText(cursor)) + '</textarea>' +
    '<div class="hint mt8">학생 이름·연락처는 들어가지 않습니다. 원장 카톡방에 붙여 넣는 용도입니다.</div>',
    '<button class="btn btn-navy btn-block mt14" data-act="dk-copy" data-target="dk-brief-text">복사</button>');
}

async function copyText(text) {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch (e) { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    try { ta.focus(); ta.select(); ok = document.execCommand('copy') === true; } catch (e) { ok = false; }
    ta.remove();
  }
  toast(ok ? '복사했습니다' : '복사되지 않았습니다 — 길게 눌러 직접 복사하세요');
}

/* ── 기획서 v1.1: 프로그램 방·배정 카드·템플릿·앱 목적지·매뉴얼·현황 ──────────
 * 카드의 정본은 서버 cards 컬렉션. 반복 템플릿(plans.recurring)은 이 기기가 보는 오늘의 카드를 만든다(id 가 결정적이라 멱등).
 * 직원은 카드 상태·증빙·메모와 앱 자료 범위의 진행만 바꾸고, 템플릿·앱·매뉴얼은 원장이 만든다 — 서버가 같은 규칙으로 거절한다. */

function liveCards() { return state.cards.filter(c => c && !c.deleted); }
function cardById(id) { return state.cards.find(c => c && String(c.id) === String(id)) || null; }
function liveApps() { return state.apps.filter(a => a && !a.deleted); }
function appById(id) { return state.apps.find(a => a && String(a.id) === String(id)) || null; }
function livePlans() { return state.plans.filter(p => p && !p.deleted); }
function planById(id) { return state.plans.find(p => p && String(p.id) === String(id)) || null; }
function manualById(id) { return state.manuals.find(m => m && String(m.id) === String(id)) || null; }
function roomLabel(k) { return DC.ROOM_LABEL[k] || String(k || ''); }
function roomLinks(k) { const L = WBExternalLinks; return L.keys().filter(key => L.programOf(key) === k).map(key => L.linkFor(key)).filter(Boolean); }
function taskLabel(t) { const hit = MANUAL_TASKS.find(x => x[0] === t); return hit ? hit[1] : String(t || ''); }
function activeStudents() { return students().filter(s => String(s.status || 'active') !== 'ended').sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')); }

/** 새 문서 또는 전체 덮어쓰기 — 메모리 즉시 반영 + 변경 큐. */
function addDoc(collection, id, data) {
  const row = Object.assign({}, data, { id: String(id) });
  const list = state[collection];
  const i = list.findIndex(x => x && String(x.id) === String(id));
  if (i >= 0) list[i] = row; else list.push(row);
  queueChange(collection, String(id), row);
  return row;
}
function removeDoc(collection, id) {
  const list = state[collection];
  const i = list.findIndex(x => x && String(x.id) === String(id));
  if (i >= 0) list.splice(i, 1);
  queueChange(collection, String(id), {}, true);
}
/** 카드 상태 전이는 여기 한 곳. 완료면 증빙(체크)·완료 시각을 채우고, 되돌리면 지운다. */
function saveCard(id, patch) {
  const cur = cardById(id);
  if (!cur) return null;
  const next = Object.assign({}, cur, patch);
  if (next.status !== 'blocked') delete next.blockedReason;
  if (next.status === 'done') {
    if (!next.doneAt) next.doneAt = now();
    if (!next.evidence) next.evidence = { kind: 'check', at: now() };
  } else {
    delete next.doneAt; delete next.doneBy;
    if (next.evidence && next.evidence.kind === 'check') delete next.evidence;
  }
  return addDoc('cards', id, next);
}
function knownCardIds() { return Object.keys(state.meta).filter(k => k.startsWith('cards|')).map(k => k.slice(6)); }
/** 오늘 카드를 템플릿에서 만든다. 어느 기기가 먼저 열어도 같은 id 라 서버엔 하나만 남는다. 만든 수를 돌려준다. */
function ensureTodayCards() {
  if (!session) return 0;
  const day = today();
  const r = DC.deriveCards(state.plans, state.students, state.apps, state.cards, day, now(), knownCardIds());
  r.cards.forEach(c => addDoc('cards', c.id, c));
  derivedFor = day;
  return r.cards.length;
}

function targetText(t) {
  if (!t) return '';
  if (t.type === 'student') { const s = studentById(t.id); return s ? String(s.name) + (s.grade ? ' · ' + String(s.grade) : '') : '(삭제된 학생)'; }
  if (t.type === 'app') { const a = appById(t.id); return a ? '앱 · ' + String(a.name) : '(삭제된 앱)'; }
  return String(t.label || '');
}
function planTargetText(t) {
  if (!t) return '';
  if (t.type === 'each') return '구독 학생 각각';
  if (t.type === 'student') return studentName(t.id);
  if (t.type === 'app') { const a = appById(t.id); return a ? '앱 ' + String(a.name) : '(삭제된 앱)'; }
  return String(t.label || '');
}
function sourceText(s) { const v = String(s || ''); return v.startsWith('plan:') ? '템플릿' : v.startsWith('request:') ? '요청함' : '지시'; }
function daysText(days) {
  const d = (Array.isArray(days) ? days : []).map(Number).sort((a, b) => a - b);
  if (d.length === 7) return '매일';
  if (d.join(',') === '1,2,3,4,5') return '월~금';
  return d.map(n => DC.DOW[n]).join('');
}
function roomHint(k) {
  return {
    studyforce: '과제 배정 · 매일 수행 확인 · 미수행 후속', classcard: '반별 세트 배정 · 학습 결과 확인', metamath: '교실홈 문제지 제작·배정',
    nelt: '응시 등록·안내 · 결과 단계 입력', exam4you: '자료 검색·구매·다운로드 → 학생 전달 · 학습 앱 자료 충당', jokbo: '자료 검색·구매·다운로드 → 학생 전달 · 학습 앱 자료 충당'
  }[k] || '';
}

/* ── 카드 ── */

function cardItem(c, date) {
  const late = DC.cardLate(c, date);
  const dLeft = DC.daysUntil(c, date);
  const st = String(c.status || 'todo');
  const m = DC.manualFor(state.manuals, c);
  const app = c.target && c.target.type === 'app' ? appById(c.target.id) : null;
  const link = roomLinks(c.program)[0];
  const ids = ' data-id="' + esc(c.id) + '"';
  let h = '<div class="acard ' + st + (late ? ' late' : '') + '" data-card="' + esc(c.id) + '">' +
    '<div class="acard-what">' + esc(c.what) + '</div>' +
    '<div class="acard-to">→ ' + esc(targetText(c.target)) + '</div>' +
    (c.where ? '<div class="acard-where">어디에: ' + esc(c.where) + '</div>' : '') +
    '<div class="meta">' +
      (route !== 'room' ? '<span class="tag cls">' + esc(roomLabel(c.program)) + '</span>' : '') +
      (c.due ? '<span class="tag' + (late ? ' blk' : ' time') + '">' + (late ? '지연 · ' : '') + esc(DC.shortDate(c.due)) + (dLeft ? ' · D-' + dLeft : '') + '</span>' : '') +
      '<span class="tag ' + (st === 'done' ? 'ok' : st === 'blocked' ? 'blk' : st === 'doing' ? 'doing' : '') + '">' + esc(DC.CARD_STATUS_LABEL[st] || st) + '</span>' +
      '<span class="tag">' + esc(sourceText(c.source)) + (c.byOwner ? ' · 원장' : '') + '</span>' +
      (st === 'done' && c.doneAt ? '<span class="tag ok">✓ ' + esc(fmtAt(c.doneAt)) + (c.doneBy ? ' ' + esc(staffName(c.doneBy)) : '') + '</span>' : '') +
    '</div>' +
    (st === 'blocked' && c.blockedReason ? '<div class="small mt8" style="color:var(--bad)">막힘: ' + esc(c.blockedReason) + '</div>' : '') +
    (c.note ? '<div class="small muted mt8">' + esc(c.note) + '</div>' : '') +
    '<div class="acts">';
  if (st === 'done') h += '<button class="btn btn-sm btn-ghost" data-act="dk-card-status" data-v="todo"' + ids + '>완료 취소</button>';
  else {
    if (st !== 'doing') h += '<button class="btn btn-sm btn-navy" data-act="dk-card-status" data-v="doing"' + ids + '>시작</button>';
    h += '<button class="btn btn-sm btn-primary" data-act="dk-card-status" data-v="done"' + ids + '>✓ 완료</button>';
    h += st === 'blocked'
      ? '<button class="btn btn-sm btn-danger" data-act="dk-card-status" data-v="todo"' + ids + '>막힘 해제</button>'
      : '<button class="btn btn-sm btn-warn" data-act="dk-card-block"' + ids + '>🚧 막힘</button>';
  }
  if (m) h += '<button class="btn btn-sm btn-ghost" data-act="dk-manual-open" data-id="' + esc(m.id) + '">📖 방법</button>';
  if (link) h += '<a class="btn btn-sm btn-ghost" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(link.label) + '</a>';
  if (app && app.adminUrl) h += '<a class="btn btn-sm btn-ghost" href="' + esc(app.adminUrl) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(app.name) + ' 관리</a>';
  h += '<button class="btn btn-sm btn-ghost" data-act="dk-card-note"' + ids + '>메모</button>';
  if (session.canApprove) h += '<button class="btn btn-sm btn-ghost" data-act="dk-card-del"' + ids + '>삭제</button>';
  return h + '</div></div>';
}

/** 카드 묶음 — roomKey 가 비면 전체(방별 소제목), 있으면 그 방만. */
function cardsBlock(roomKey, date) {
  const on = DC.cardsOn(state.cards, date);
  const open = roomKey ? on.open.filter(c => c.program === roomKey) : on.open;
  const done = roomKey ? on.done.filter(c => c.program === roomKey) : on.done;
  const upcoming = roomKey ? on.upcoming.filter(c => c.program === roomKey) : on.upcoming;
  const late = open.filter(c => DC.cardLate(c, date)).length;
  const blocked = open.filter(c => c.status === 'blocked').length;
  let h = '<div class="card"><div class="between mb8"><div class="card-title">' + (roomKey ? '이 방의 카드' : '오늘 카드') + ' <span class="muted small">' + open.length + '</span></div>' +
    '<div class="row wraprow" style="gap:4px">' + (late ? '<span class="pill bad">지연 ' + late + '</span>' : '') + (blocked ? '<span class="pill bad">막힘 ' + blocked + '</span>' : '') +
    (done.length ? '<span class="pill ok">완료 ' + done.length + '</span>' : '') + '</div></div>';
  if (session.canApprove) h += '<div class="row wraprow mb8" style="gap:6px"><button class="btn btn-sm btn-primary" data-act="dk-card-new" data-room="' + esc(roomKey || '') + '">＋ 지시(카드)</button></div>';
  if (!open.length) {
    h += '<div class="empty"><b>비어 있음</b>' + (roomKey ? '이 방에 열린 카드가 없습니다.' : '열린 카드가 없습니다.') +
      (session.canApprove ? '<br>[＋ 지시]로 한 장 만들거나, 반복 템플릿을 만들면 매일 아침 카드가 생깁니다.' : '') + '</div>';
  } else if (roomKey) {
    h += open.map(c => cardItem(c, date)).join('');
  } else {
    const g = DC.groupByRoom(open);
    DC.ROOMS.forEach(k => { if (g[k].length) h += '<div class="sect">' + esc(roomLabel(k)) + ' ' + g[k].length + '</div>' + g[k].map(c => cardItem(c, date)).join(''); });
  }
  if (upcoming.length) h += '<details' + (roomKey ? ' open' : '') + '><summary class="sect">예정 ' + upcoming.length + ' <span class="muted" style="text-transform:none;letter-spacing:0">기한이 뒤인 카드 — 미리 해도 됩니다</span></summary>' + upcoming.map(c => cardItem(c, date)).join('') + '</details>';
  if (done.length) h += '<details><summary class="sect">완료 ' + done.length + '</summary>' + done.map(c => cardItem(c, date)).join('') + '</details>';
  return h + '</div>';
}

function openCardNote(id) {
  const c = cardById(id); if (!c) return;
  modal('카드 메모', '<div class="field"><label class="fl" for="dk-cn-note">메모 (학생 이름·연락처 금지, 300자)</label><textarea class="in" id="dk-cn-note" rows="3" maxlength="300">' + esc(c.note || '') + '</textarea></div>',
    '<button class="btn btn-primary btn-block mt8" data-act="dk-card-note-save" data-id="' + esc(id) + '">저장</button>');
}
function saveCardNote(id) {
  const note = val('dk-cn-note');
  if (DC.hasPII(note)) return toast('메모에 전화번호·이메일을 넣을 수 없습니다');
  saveCard(id, { note: note });
  closeModal(); render();
}
function openCardBlock(id) {
  const c = cardById(id); if (!c) return;
  modal('막힘 — 이유 한 줄', '<div class="card-sub mb8">' + esc(c.what) + '</div><div class="field"><label class="fl" for="dk-cb-reason">사유 (200자)</label><textarea class="in" id="dk-cb-reason" rows="2" maxlength="200">' + esc(c.blockedReason || '') + '</textarea></div>',
    '<button class="btn btn-danger btn-block mt8" data-act="dk-card-block-save" data-id="' + esc(id) + '">막힘으로 표시</button>');
}
function saveCardBlock(id) {
  const reason = val('dk-cb-reason');
  if (!reason) return toast('사유를 한 줄 적어 주세요');
  if (DC.hasPII(reason)) return toast('사유에 전화번호·이메일을 넣을 수 없습니다');
  saveCard(id, { status: 'blocked', blockedReason: reason });
  closeModal(); render(); toast('막힘으로 표시했습니다 — 원장 화면에 바로 뜹니다');
}

/* 공용 선택 상자 */
function optionsHtml(pairs, selected) { return pairs.map(p => '<option value="' + esc(p[0]) + '"' + (String(p[0]) === String(selected) ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join(''); }
function roomOptions(selected) { return optionsHtml(DC.ROOMS.map(k => [k, roomLabel(k)]), selected); }
function studentOptions(selected) { return optionsHtml([['', '— 학생 —']].concat(activeStudents().map(s => [s.id, String(s.name) + (s.grade ? ' (' + s.grade + ')' : '')])), selected); }
function appOptions(selected) { return optionsHtml([['', '— 앱 —']].concat(liveApps().filter(a => a.active !== false).map(a => [a.id, a.name])), selected); }
function manualOptions(scope, selected) {
  const list = DC.manualsFor(state.manuals, scope).concat(scope === 'exam4you' || scope === 'jokbo' ? DC.manualsFor(state.manuals, 'app') : []);
  return optionsHtml([['', '자동(방의 기본 매뉴얼)']].concat(list.map(m => [m.id, taskLabel(m.task) + ' · ' + m.title])), selected);
}
function targetFields(prefix, kinds, t) {
  const type = t && t.type ? t.type : kinds[0][0];
  return '<div class="field"><label class="fl" for="' + prefix + '-ttype">대상</label><select class="in" id="' + prefix + '-ttype" data-act="' + prefix + '-ttype">' + optionsHtml(kinds, type) + '</select></div>' +
    '<div class="field" id="' + prefix + '-w-student"' + (type === 'student' ? '' : ' hidden') + '><label class="fl" for="' + prefix + '-student">학생</label><select class="in" id="' + prefix + '-student">' + studentOptions(t && t.id) + '</select></div>' +
    '<div class="field" id="' + prefix + '-w-app"' + (type === 'app' ? '' : ' hidden') + '><label class="fl" for="' + prefix + '-app">학원 학습 앱</label><select class="in" id="' + prefix + '-app">' + appOptions(t && t.id) + '</select>' +
      (liveApps().length ? '' : '<div class="hint">관리 탭에서 앱을 먼저 등록하세요.</div>') + '</div>' +
    '<div class="field" id="' + prefix + '-w-text"' + (type === 'text' ? '' : ' hidden') + '><label class="fl" for="' + prefix + '-label">반·기타 (글로)</label><input class="in" id="' + prefix + '-label" maxlength="60" placeholder="예: 중2A반" value="' + esc(t && t.label || '') + '"></div>';
}
function readTarget(prefix) {
  const type = val(prefix + '-ttype');
  return { targetType: type, targetId: type === 'student' ? val(prefix + '-student') : type === 'app' ? val(prefix + '-app') : '', targetLabel: val(prefix + '-label') };
}
function toggleTargetFields(prefix) {
  const type = val(prefix + '-ttype');
  ['student', 'app', 'text'].forEach(k => { const el = $('#' + prefix + '-w-' + k); if (el) el.hidden = type !== k; });
}

function openCardForm(roomKey) {
  const k = DC.ROOMS.includes(roomKey) ? roomKey : (DC.ROOMS.includes(room) ? room : 'studyforce');
  modal('지시 — 카드 한 장',
    '<div class="field"><label class="fl" for="dk-cf-program">프로그램(방)</label><select class="in" id="dk-cf-program" data-act="dk-cf-program">' + roomOptions(k) + '</select></div>' +
    targetFields('dk-cf', [['student', '학생 한 명'], ['app', '학원 학습 앱'], ['text', '반·기타(글로)']], null) +
    '<div class="field"><label class="fl" for="dk-cf-what">무엇을</label><input class="in" id="dk-cf-what" maxlength="120" placeholder="예: 2학기 중간 교과서 변형 3~4과"></div>' +
    '<div class="field"><label class="fl" for="dk-cf-where">어디에</label><input class="in" id="dk-cf-where" maxlength="120" placeholder="예: 클래스카드 → 중2A반 / 학생 폴더"></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-cf-due">기한</label><input class="in" id="dk-cf-due" type="date" value="' + esc(today()) + '"></div>' +
    '<div class="field"><label class="fl" for="dk-cf-manual">방법(매뉴얼)</label><select class="in" id="dk-cf-manual">' + manualOptions(k, '') + '</select></div></div>' +
    '<div class="field"><label class="fl" for="dk-cf-note">메모 (학생 이름·연락처 금지)</label><textarea class="in" id="dk-cf-note" rows="2" maxlength="300"></textarea></div>',
    '<button class="btn btn-primary btn-block mt8" data-act="dk-card-save">카드 만들기</button>');
}
function saveCardForm() {
  const t = readTarget('dk-cf');
  const v = DC.validateCard(Object.assign({ program: val('dk-cf-program'), what: val('dk-cf-what'), where: val('dk-cf-where'), due: val('dk-cf-due'), note: val('dk-cf-note'), manualId: val('dk-cf-manual'), source: 'order' }, t));
  if (v.error) return toast(v.error);
  addDoc('cards', 'o:' + uid(), Object.assign({}, v.value, { createdAt: now() }));
  closeModal(); render(); toast('카드를 만들었습니다');
}

/* ── 방 ── */

function viewRoom(k) {
  if (!DC.ROOMS.includes(k)) return viewToday();
  const links = roomLinks(k);
  let h = '<div class="room-head"><div class="room-title">' + esc(roomLabel(k)) + '<small>' + esc(roomHint(k)) + '</small></div>' +
    '<div class="row wraprow" style="gap:6px">' + links.map(l => '<a class="btn btn-sm btn-navy" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(l.label) + '</a>').join('') + '</div></div>';
  h += cardsBlock(k, today());
  if (k === 'exam4you' || k === 'jokbo') h += rangesBlock(k);
  h += manualsBlock(k);
  h += roomStatusBlock(k);
  if (session.canApprove) {
    if (k === 'exam4you' || k === 'jokbo') h += examsSection(k);
    h += templatesSection(k);
  }
  return h;
}

/* ── 시험 템플릿(원장) — 학교·학년·시험일·자료 목록 → 시험 leadDays 전에 학생별 자료 카드 ── */

function schoolDatalist() {
  const names = Array.from(new Set(students().map(s => String(s.school || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko'));
  return '<datalist id="dk-schools">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>';
}
function examsSection(k) {
  const list = livePlans().filter(p => p.kind === 'exam' && (!k || (p.materials || []).some(m => m.source === k)))
    .sort((a, b) => String(a.examDate).localeCompare(String(b.examDate)));
  let h = '<div class="card"><div class="between mb8"><div class="card-title">시험 템플릿 <span class="muted small">' + list.length + '</span></div>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-exam-new">＋ 시험</button></div>' +
    '<div class="card-sub mb8">학교·학년·시험일과 자료 목록을 적어 두면, 시험 ' + DC.EXAM_LEAD_DEFAULT + '일 전부터 그 학교·학년 학생마다 자료 카드가 자동으로 생깁니다(기한은 시험 ' + DC.EXAM_DUE_BEFORE_DEFAULT + '일 전).</div>';
  h += list.length ? list.map(p => {
    const d = DC.daysUntil({ due: p.examDate }, today());
    return '<div class="rowline"><div class="grow"><b>' + esc([p.school, p.grade, p.subject, p.examName].filter(Boolean).join(' · ')) + '</b> <span class="muted small">' + esc(DC.shortDate(p.examDate)) +
      (d != null ? ' · D-' + d : (p.examDate < today() ? ' · 지남' : ' · 오늘')) + ' · 자료 ' + (p.materials || []).length + '</span>' +
      (p.scope ? '<div class="small muted">범위: ' + esc(p.scope) + '</div>' : '') + '</div>' +
      '<span class="pill' + (p.active !== false ? ' ok' : '') + '">' + (p.active !== false ? '켜짐' : '꺼짐') + '</span>' +
      '<button class="btn btn-sm btn-ghost" data-act="dk-exam-edit" data-id="' + esc(p.id) + '">편집</button></div>';
  }).join('') : '<div class="hint">시험 템플릿이 없습니다.</div>';
  return h + '</div>';
}
function openExamForm(id) {
  const p = id ? planById(id) : null;
  const srcLabel = s => (s === 'jokbo' ? '족보닷컴' : '이그잼포유');
  const materials = p ? (p.materials || []).map(m => [srcLabel(m.source), m.what, m.where || ''].join(' | ')).join('\n') : '';
  modal(p ? '시험 템플릿 편집' : '시험 템플릿',
    '<div class="grid2"><div class="field"><label class="fl" for="dk-ef-school">학교 *</label><input class="in" id="dk-ef-school" maxlength="40" list="dk-schools" value="' + esc(p ? p.school : '') + '" placeholder="OO중">' + schoolDatalist() + '</div>' +
    '<div class="field"><label class="fl" for="dk-ef-grade">학년 (비우면 그 학교 전체)</label><input class="in" id="dk-ef-grade" maxlength="10" value="' + esc(p ? p.grade || '' : '') + '" placeholder="중2"></div>' +
    '<div class="field"><label class="fl" for="dk-ef-subject">과목</label><input class="in" id="dk-ef-subject" maxlength="40" value="' + esc(p ? p.subject || '' : '') + '" placeholder="영어"></div>' +
    '<div class="field"><label class="fl" for="dk-ef-textbook">교과서</label><input class="in" id="dk-ef-textbook" maxlength="40" value="' + esc(p ? p.textbook || '' : '') + '" placeholder="천재(이)"></div>' +
    '<div class="field"><label class="fl" for="dk-ef-exam">시험 이름</label><input class="in" id="dk-ef-exam" maxlength="40" value="' + esc(p ? p.examName || '' : '') + '" placeholder="2학기 중간"></div>' +
    '<div class="field"><label class="fl" for="dk-ef-date">시험일 *</label><input class="in" id="dk-ef-date" type="date" value="' + esc(p ? p.examDate : '') + '"></div></div>' +
    '<div class="field"><label class="fl" for="dk-ef-scope">시험 범위</label><input class="in" id="dk-ef-scope" maxlength="120" value="' + esc(p ? p.scope || '' : '') + '" placeholder="3~4과"></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-ef-lead">며칠 전부터 카드 (1~90)</label><input class="in" id="dk-ef-lead" type="number" min="1" max="90" value="' + esc(p ? p.leadDays : DC.EXAM_LEAD_DEFAULT) + '"></div>' +
    '<div class="field"><label class="fl" for="dk-ef-before">전달 기한 = 시험 며칠 전</label><input class="in" id="dk-ef-before" type="number" min="0" max="60" value="' + esc(p ? p.dueDaysBefore : DC.EXAM_DUE_BEFORE_DEFAULT) + '"></div></div>' +
    '<div class="field"><label class="fl" for="dk-ef-materials">자료 — 한 줄에 하나: 출처 | 무엇을 | 어디에</label><textarea class="in" id="dk-ef-materials" rows="5" placeholder="이그잼포유 | 교과서 변형 3~4과 | 학생 폴더\n족보닷컴 | 기출 3개년 | 출력해 전달">' + esc(materials) + '</textarea></div>' +
    '<div class="field"><label class="fl" for="dk-ef-note">메모</label><input class="in" id="dk-ef-note" maxlength="300" value="' + esc(p ? p.note || '' : '') + '"></div>' +
    '<label class="check"><input type="checkbox" id="dk-ef-active"' + (!p || p.active !== false ? ' checked' : '') + '> 켜짐</label>',
    '<div class="row wraprow mt8" style="gap:6px"><button class="btn btn-primary" data-act="dk-exam-save" data-id="' + esc(id || '') + '">저장</button>' +
    (p ? '<button class="btn btn-danger" data-act="dk-plan-del" data-id="' + esc(id) + '">삭제</button>' : '') + '</div>');
}
function saveExamForm(id) {
  const v = DC.validateExam({ school: val('dk-ef-school'), grade: val('dk-ef-grade'), subject: val('dk-ef-subject'), textbook: val('dk-ef-textbook'), examName: val('dk-ef-exam'), examDate: val('dk-ef-date'),
    scope: val('dk-ef-scope'), leadDays: val('dk-ef-lead'), dueDaysBefore: val('dk-ef-before'), materialsText: val('dk-ef-materials'), note: val('dk-ef-note'), active: checked('dk-ef-active') });
  if (v.error) return toast(v.error);
  addDoc('plans', id || 'ex:' + uid(), v.value);
  closeModal();
  const made = ensureTodayCards();
  render(); toast(made ? '시험 템플릿 저장 — 자료 카드 ' + made + '장을 만들었습니다' : '시험 템플릿을 저장했습니다' + (DC.daysUntil({ due: v.value.examDate }, today()) > v.value.leadDays ? ' — 시험 ' + v.value.leadDays + '일 전에 카드가 생깁니다' : ''));
}

function rangesBlock(k) {
  const cov = DC.coverageOf(state.apps, state.plans);
  let h = '<div class="card"><div class="between mb8"><div class="card-title">앱 자료 범위 <span class="muted small">이 출처에서 채울 것</span></div>' +
    (session.canApprove ? '<button class="btn btn-sm btn-ghost" data-act="dk-range-new" data-room="' + esc(k) + '">＋ 범위</button>' : '') + '</div>';
  let any = false;
  cov.forEach(c => {
    const rows = c.rows.filter(r => r.source === k);
    if (!rows.length) return;
    any = true;
    h += '<div class="sect">' + esc(c.app.name) + ' ' + rows.length + '</div>' + rows.map(rangeRow).join('');
  });
  if (!any) {
    h += '<div class="hint">' + (liveApps().length ? '이 출처로 채울 범위가 없습니다.' : '관리 탭에서 학원 학습 앱을 먼저 등록하세요.') +
      (session.canApprove ? ' [＋ 범위]로 과목·학년·단원·자료 종류를 한 줄씩 넣으면 직원이 진행 상태를 옮깁니다.' : '') + '</div>';
  }
  return h + '</div>';
}
function rangeRow(r) {
  return '<div class="rowline"><div class="grow"><span class="dot ' + esc(r.status) + '"></span> <b>' + esc([r.subject, r.grade, r.unit].filter(Boolean).join(' · ')) + '</b>' +
    (r.material ? ' <span class="muted small">' + esc(r.material) + '</span>' : '') + (r.note ? '<div class="small muted">' + esc(r.note) + '</div>' : '') + '</div>' +
    '<select class="in" data-act="dk-range-status" data-id="' + esc(r.id) + '" aria-label="진행 상태">' + optionsHtml(DC.RANGE_STATUS.map(s => [s, DC.RANGE_STATUS_LABEL[s]]), r.status) + '</select>' +
    (session.canApprove ? '<button class="btn btn-sm btn-ghost" data-act="dk-range-edit" data-id="' + esc(r.id) + '">편집</button>' : '') + '</div>';
}
function setRangeStatus(id, status) {
  const p = planById(id);
  if (!p || !DC.RANGE_STATUS.includes(status)) return;
  addDoc('plans', id, Object.assign({}, p, { status: status }));
  toast('진행 상태: ' + DC.RANGE_STATUS_LABEL[status]);
}

function manualsBlock(k) {
  const list = DC.manualsFor(state.manuals, k).concat(k === 'exam4you' || k === 'jokbo' ? DC.manualsFor(state.manuals, 'app') : []);
  let h = '<div class="card"><div class="between mb8"><div class="card-title">매뉴얼</div>' +
    (session.canApprove ? '<button class="btn btn-sm btn-ghost" data-act="dk-manual-new" data-scope="' + esc(k) + '">＋ 매뉴얼</button>' : '') + '</div>';
  h += list.length ? list.map(manualRow).join('')
    : '<div class="hint">아직 매뉴얼이 없습니다.' + (session.canApprove ? ' 매뉴얼 탭의 [기본 매뉴얼 불러오기]로 초안을 넣고 고치세요.' : '') + '</div>';
  return h + '</div>';
}
function manualRow(m) {
  return '<div class="rowline"><div class="grow"><span class="tag">' + esc(taskLabel(m.task)) + '</span> <b>' + esc(m.title) + '</b>' +
    (m.scope === 'app' && m.appId ? ' <span class="muted small">' + esc((appById(m.appId) || {}).name || '') + '</span>' : '') +
    (m.purpose ? '<div class="small muted">' + esc(m.purpose) + '</div>' : '') + '</div>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-manual-open" data-id="' + esc(m.id) + '">보기</button></div>';
}

function roomStatusBlock(k) {
  const mx = DC.matrixOf(state.students, state.cards, today());
  const isSub = DC.PROGRAMS.includes(k);
  const rows = isSub ? mx.filter(r => r.cells[k].sub) : mx.filter(r => r.cells[k].status);
  let h = '<div class="card"><div class="card-title">현황 <span class="muted small">' + (isSub ? '구독 학생 ' : '카드가 있는 학생 ') + rows.length + '</span></div>';
  if (!rows.length) {
    return h + '<div class="hint mt8">' + (isSub ? '이 프로그램을 구독 중인 학생이 없습니다. 학생 탭에서 구독을 켜세요.' : '아직 이 방에서 학생 카드가 없습니다.') + '</div></div>';
  }
  h += '<div class="mxwrap mt8"><table class="mx"><thead><tr><th>학생</th><th>마지막 카드</th><th>상태</th><th>기한</th></tr></thead><tbody>' + rows.map(r => {
    const c = r.cells[k];
    return '<tr><td>' + esc(r.name) + (r.grade ? ' <span class="muted">' + esc(r.grade) + '</span>' : '') + '</td><td>' + esc(c.what || '—') + '</td><td>' +
      (c.status ? '<span class="dot ' + (c.late ? 'late' : esc(c.status)) + '"></span> ' + esc(DC.CARD_STATUS_LABEL[c.status] || c.status) + (c.late ? ' (지연)' : '') : '<span class="muted">—</span>') +
      '</td><td>' + esc(c.due ? DC.shortDate(c.due) : '') + '</td></tr>';
  }).join('') + '</tbody></table></div>';
  return h + '</div>';
}

/* ── 템플릿(원장) ── */

function templatesSection(k) {
  const list = livePlans().filter(p => p.kind === 'recurring' && (!k || p.program === k));
  let h = '<div class="card"><div class="between mb8"><div class="card-title">반복 템플릿 <span class="muted small">' + list.length + '</span></div>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-plan-new" data-room="' + esc(k || '') + '">＋ 템플릿</button></div>' +
    '<div class="card-sub mb8">요일마다 대상별 카드를 자동으로 만듭니다. 예: 스터디포스 · 월~금 · 구독 학생 각각 · "오늘 수행 확인".</div>';
  h += list.length ? list.map(p => '<div class="rowline"><div class="grow"><b>' + esc(p.what) + '</b> <span class="muted small">' + esc(roomLabel(p.program)) + ' · ' + esc(daysText(p.days)) + ' · ' + esc(planTargetText(p.target)) + '</span>' +
    (p.where ? '<div class="small muted">어디에: ' + esc(p.where) + '</div>' : '') + '</div>' +
    '<span class="pill' + (p.active !== false ? ' ok' : '') + '">' + (p.active !== false ? '켜짐' : '꺼짐') + '</span>' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-plan-edit" data-id="' + esc(p.id) + '">편집</button></div>').join('')
    : '<div class="hint">템플릿이 없습니다.</div>';
  return h + '</div>';
}
function openPlanForm(id, roomKey) {
  const p = id ? planById(id) : null;
  const k = p ? p.program : (DC.ROOMS.includes(roomKey) ? roomKey : (DC.ROOMS.includes(room) ? room : 'studyforce'));
  const days = p && Array.isArray(p.days) ? p.days.map(Number) : [1, 2, 3, 4, 5];
  modal(p ? '템플릿 편집' : '반복 템플릿',
    '<div class="field"><label class="fl" for="dk-pf-program">프로그램(방)</label><select class="in" id="dk-pf-program">' + roomOptions(k) + '</select></div>' +
    '<div class="field"><div class="fl">요일</div><div class="days">' + DC.DOW.map((d, i) => '<label><input type="checkbox" name="dk-pf-day" value="' + i + '"' + (days.includes(i) ? ' checked' : '') + '>' + esc(d) + '</label>').join('') + '</div></div>' +
    targetFields('dk-pf', DC.PLAN_TARGETS.map(t => [t, DC.PLAN_TARGET_LABEL[t]]), p ? p.target : { type: 'each' }) +
    '<div class="field"><label class="fl" for="dk-pf-what">무엇을</label><input class="in" id="dk-pf-what" maxlength="120" value="' + esc(p ? p.what : '') + '" placeholder="예: 오늘 수행 확인"></div>' +
    '<div class="field"><label class="fl" for="dk-pf-where">어디에</label><input class="in" id="dk-pf-where" maxlength="120" value="' + esc(p ? p.where || '' : '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-pf-manual">방법(매뉴얼)</label><select class="in" id="dk-pf-manual">' + manualOptions(k, p ? p.manualId : '') + '</select></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-pf-start">시작(선택)</label><input class="in" id="dk-pf-start" type="date" value="' + esc(p ? p.start || '' : '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-pf-end">끝(선택)</label><input class="in" id="dk-pf-end" type="date" value="' + esc(p ? p.end || '' : '') + '"></div></div>' +
    '<label class="check"><input type="checkbox" id="dk-pf-active"' + (!p || p.active !== false ? ' checked' : '') + '> 켜짐 (끄면 카드를 만들지 않습니다)</label>',
    '<div class="row wraprow mt8" style="gap:6px"><button class="btn btn-primary" data-act="dk-plan-save" data-id="' + esc(id || '') + '">저장</button>' +
    (p ? '<button class="btn btn-danger" data-act="dk-plan-del" data-id="' + esc(id) + '">삭제</button>' : '') + '</div>');
}
function savePlanForm(id) {
  const days = Array.from(document.querySelectorAll('input[name="dk-pf-day"]:checked')).map(el => Number(el.value));
  const v = DC.validateRecurring(Object.assign({ program: val('dk-pf-program'), days: days, what: val('dk-pf-what'), where: val('dk-pf-where'), manualId: val('dk-pf-manual'),
    start: val('dk-pf-start'), end: val('dk-pf-end'), active: checked('dk-pf-active') }, readTarget('dk-pf')));
  if (v.error) return toast(v.error);
  addDoc('plans', id || 'pl:' + uid(), v.value);
  closeModal();
  const made = ensureTodayCards();
  render(); toast(made ? '템플릿 저장 — 오늘 카드 ' + made + '장을 만들었습니다' : '템플릿을 저장했습니다');
}

function openRangeForm(id, roomKey) {
  const r = id ? planById(id) : null;
  if (!liveApps().length) return toast('관리 탭에서 학원 학습 앱을 먼저 등록하세요');
  const source = r ? r.source : (roomKey === 'jokbo' ? 'jokbo' : 'exam4you');
  modal(r ? '앱 자료 범위 편집' : '앱 자료 범위',
    '<div class="field"><label class="fl" for="dk-rf-app">앱</label><select class="in" id="dk-rf-app">' + appOptions(r ? r.appId : '') + '</select></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-rf-subject">과목</label><input class="in" id="dk-rf-subject" maxlength="40" value="' + esc(r ? r.subject || '' : '') + '" placeholder="국어"></div>' +
    '<div class="field"><label class="fl" for="dk-rf-grade">학년</label><input class="in" id="dk-rf-grade" maxlength="10" value="' + esc(r ? r.grade || '' : '') + '" placeholder="중2"></div></div>' +
    '<div class="field"><label class="fl" for="dk-rf-unit">범위(단원·영역)</label><input class="in" id="dk-rf-unit" maxlength="80" value="' + esc(r ? r.unit : '') + '" placeholder="3단원 / 비문학 독해"></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-rf-material">자료 종류</label><input class="in" id="dk-rf-material" maxlength="40" value="' + esc(r ? r.material || '' : '') + '" placeholder="기출 3개년"></div>' +
    '<div class="field"><label class="fl" for="dk-rf-source">출처</label><select class="in" id="dk-rf-source">' + optionsHtml([['exam4you', '이그잼포유'], ['jokbo', '족보닷컴'], ['other', '기타']], source) + '</select></div></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="dk-rf-status">상태</label><select class="in" id="dk-rf-status">' + optionsHtml(DC.RANGE_STATUS.map(s => [s, DC.RANGE_STATUS_LABEL[s]]), r ? r.status : 'need') + '</select></div></div>' +
    '<div class="field"><label class="fl" for="dk-rf-note">메모</label><textarea class="in" id="dk-rf-note" rows="2" maxlength="300">' + esc(r ? r.note || '' : '') + '</textarea></div>',
    '<div class="row wraprow mt8" style="gap:6px"><button class="btn btn-primary" data-act="dk-range-save" data-id="' + esc(id || '') + '">저장</button>' +
    (r ? '<button class="btn btn-danger" data-act="dk-plan-del" data-id="' + esc(id) + '">삭제</button>' : '') + '</div>');
}
function saveRangeForm(id) {
  const v = DC.validateRange({ appId: val('dk-rf-app'), subject: val('dk-rf-subject'), grade: val('dk-rf-grade'), unit: val('dk-rf-unit'), material: val('dk-rf-material'), source: val('dk-rf-source'), status: val('dk-rf-status'), note: val('dk-rf-note') });
  if (v.error) return toast(v.error);
  addDoc('plans', id || 'r:' + uid(), v.value);
  closeModal(); render(); toast('범위를 저장했습니다');
}
function deletePlan(id) {
  const p = planById(id); if (!p) return;
  if (!confirm((p.kind === 'apprange' ? '이 범위' : p.kind === 'exam' ? '이 시험 템플릿' : '이 템플릿') + '을 지울까요? 이미 만들어진 카드는 남습니다.')) return;
  removeDoc('plans', id);
  closeModal(); render(); toast('지웠습니다');
}

/* ── 앱 목적지(원장) ── */

function appsSection() {
  const list = liveApps();
  const cov = DC.coverageOf(list, state.plans);
  let h = '<div class="card"><div class="between mb8"><div class="card-title">학원 학습 앱 (자료 목적지) <span class="muted small">' + list.length + '</span></div>' +
    '<button class="btn btn-sm btn-primary" data-act="dk-app-new">＋ 앱</button></div>' +
    '<div class="card-sub mb8">삼육중 입시 준비 앱·국어 내신 앱처럼 이그잼포유·족보닷컴 자료를 채워 넣을 앱입니다. 등록하면 방에서 "앱 자료 범위"와 앱 대상 카드를 쓸 수 있습니다.</div>';
  h += list.length ? cov.map(c => '<div class="rowline"><div class="grow"><b>' + esc(c.app.name) + '</b>' + (c.app.active === false ? ' <span class="pill">비활성</span>' : '') +
    (c.app.format ? ' <span class="muted small">' + esc(c.app.format) + '</span>' : '') +
    '<div class="small muted">범위 ' + c.total + ' · 있음 ' + c.counts.have + ' · 구매 대기 ' + c.counts.buying + ' · 업로드 대기 ' + c.counts.uploading + ' · 없음 ' + c.counts.need + '</div></div>' +
    (c.app.adminUrl ? '<a class="btn btn-sm btn-ghost" href="' + esc(c.app.adminUrl) + '" target="_blank" rel="noopener noreferrer">↗ 관리</a>' : '') +
    '<button class="btn btn-sm btn-ghost" data-act="dk-app-edit" data-id="' + esc(c.app.id) + '">편집</button></div>').join('')
    : '<div class="hint">등록된 앱이 없습니다.</div>';
  return h + '</div>';
}
function openAppForm(id) {
  const a = id ? appById(id) : null;
  modal(a ? '앱 편집' : '학원 학습 앱 등록',
    '<div class="field"><label class="fl" for="dk-af-name">앱 이름</label><input class="in" id="dk-af-name" maxlength="40" value="' + esc(a ? a.name : '') + '" placeholder="국어 내신 앱"></div>' +
    '<div class="field"><label class="fl" for="dk-af-url">관리 웹 주소 (https, 원내 전용)</label><input class="in" id="dk-af-url" maxlength="200" value="' + esc(a ? a.adminUrl || '' : '') + '" placeholder="https://"></div>' +
    '<div class="field"><label class="fl" for="dk-af-format">자료 형식·업로드 절차 한 줄</label><input class="in" id="dk-af-format" maxlength="80" value="' + esc(a ? a.format || '' : '') + '" placeholder="예: PDF → 팩 JSON → 관리 웹 업로드"></div>' +
    '<div class="field"><label class="fl" for="dk-af-note">메모</label><textarea class="in" id="dk-af-note" rows="2" maxlength="300">' + esc(a ? a.note || '' : '') + '</textarea></div>' +
    '<label class="check"><input type="checkbox" id="dk-af-active"' + (!a || a.active !== false ? ' checked' : '') + '> 사용 중</label>',
    '<div class="row wraprow mt8" style="gap:6px"><button class="btn btn-primary" data-act="dk-app-save" data-id="' + esc(id || '') + '">저장</button>' +
    (a ? '<button class="btn btn-danger" data-act="dk-app-del" data-id="' + esc(id) + '">삭제</button>' : '') + '</div>');
}
function saveAppForm(id) {
  const v = DC.validateApp({ name: val('dk-af-name'), adminUrl: val('dk-af-url'), format: val('dk-af-format'), note: val('dk-af-note'), active: checked('dk-af-active') });
  if (v.error) return toast(v.error);
  addDoc('apps', id || 'app:' + uid(), v.value);
  closeModal(); render(); toast('앱을 저장했습니다');
}
function deleteApp(id) {
  const a = appById(id); if (!a) return;
  if (!confirm('"' + a.name + '" 앱을 지울까요? 그 앱의 자료 범위·카드는 남습니다.')) return;
  removeDoc('apps', id);
  closeModal(); render(); toast('지웠습니다');
}

/* ── 매뉴얼 ── */

function viewManuals() {
  const scopes = DC.ROOMS.map(k => [k, roomLabel(k)]).concat([['app', '학습 앱 업로드']]);
  const sel = ui.manualScope;
  const seedMissing = typeof WBManualSeed !== 'undefined' ? WBManualSeed.SEED.filter(s => !manualById(s.id)).length : 0;
  let h = '<div class="card"><div class="between mb8"><div class="card-title">매뉴얼 <span class="muted small">' + liveManualsCount() + '</span></div>' +
    (session.canApprove ? '<div class="row" style="gap:6px"><button class="btn btn-sm btn-primary" data-act="dk-manual-new" data-scope="' + esc(sel || 'studyforce') + '">＋ 매뉴얼</button>' +
      (seedMissing ? '<button class="btn btn-sm btn-ghost" data-act="dk-manual-seed">기본 매뉴얼 불러오기 ' + seedMissing + '</button>' : '') + '</div>' : '') + '</div>' +
    '<div class="card-sub mb8">카드의 [📖 방법]이 여는 내용입니다. ' + (session.canApprove ? '원장이 여기서 고칩니다 — 실제 화면의 버튼 위치·주의점을 채워 넣으세요.' : '다른 점이 있으면 요청함(기타)으로 올려 주세요.') + '</div>' +
    '<div class="chips">' + [['', '전체']].concat(scopes).map(s => '<button class="chip' + (sel === s[0] ? ' on' : '') + '" data-act="dk-manual-scope" data-v="' + esc(s[0]) + '">' + esc(s[1]) +
      ' <span class="muted">' + (s[0] ? DC.manualsFor(state.manuals, s[0]).length : liveManualsCount()) + '</span></button>').join('') + '</div></div>';
  const groups = sel ? [sel] : scopes.map(s => s[0]);
  let any = false;
  groups.forEach(k => {
    const list = DC.manualsFor(state.manuals, k);
    if (!list.length) return;
    any = true;
    h += '<div class="card"><div class="sect" style="margin-top:0">' + esc(k === 'app' ? '학습 앱 업로드' : roomLabel(k)) + '</div>' + list.map(manualRow).join('') + '</div>';
  });
  if (!any) h += '<div class="card"><div class="empty"><b>비어 있음</b>' + (session.canApprove ? '[기본 매뉴얼 불러오기]로 초안 ' + seedMissing + '개를 넣고 시작하세요.' : '아직 매뉴얼이 없습니다.') + '</div></div>';
  return h;
}
function liveManualsCount() { return state.manuals.filter(m => m && !m.deleted).length; }
function minutesText(m) {
  if (m == null) return '—';
  const n = Number(m);
  if (n < 60) return n + '분';
  if (n < 60 * 24) return Math.floor(n / 60) + '시간 ' + (n % 60) + '분';
  return Math.floor(n / 1440) + '일 ' + Math.floor((n % 1440) / 60) + '시간';
}
function seedManuals() {
  if (typeof WBManualSeed === 'undefined') return toast('씨앗 파일이 없습니다');
  const L = WBExternalLinks;
  let n = 0;
  WBManualSeed.SEED.forEach(s => {
    if (manualById(s.id)) return;
    const links = (s.linkKeys || []).map(k => L.linkFor(k)).filter(Boolean).map(l => ({ label: l.label, url: l.url }));
    const doc = { scope: s.scope, task: s.task, title: s.title, purpose: s.purpose, steps: s.steps.map(t => ({ text: t })), cautions: s.cautions.slice(), links: links, version: 1, lastCheckedAt: today() };
    addDoc('manuals', s.id, doc);
    n++;
  });
  render(); toast(n ? '기본 매뉴얼 ' + n + '개를 넣었습니다 — 실제 화면에 맞게 고쳐 주세요' : '이미 전부 있습니다');
}
/* 매뉴얼 사진 — 서버(D1)에만 있고 <img src> 로 바로 못 받는다(Bearer). fetch 로 받아 blob URL 로 그린다. */
const photoUrls = {};
async function photoSrc(id) {
  if (photoUrls[id]) return photoUrls[id];
  const res = await fetch('/api/files/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + getToken() }, cache: 'no-store' });
  if (!res.ok) throw new Error('사진 없음');
  const url = URL.createObjectURL(await res.blob());
  photoUrls[id] = url;
  return url;
}
function hydratePhotos(root) {
  (root || document).querySelectorAll('img[data-photo]:not([src])').forEach(img => {
    photoSrc(String(img.dataset.photo)).then(src => { img.src = src; }).catch(() => { img.alt = '사진을 불러오지 못했습니다'; img.classList.add('missing'); });
  });
}
/** 폰 사진은 3~6MB 라 그대로 못 올린다 — 긴 변 maxSide 로 줄여 JPEG 로. 400KB 를 넘으면 품질을 낮춰 한 번 더. */
function resizeImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale)), h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ mime: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽지 못했습니다')); };
    img.src = url;
  });
}
async function uploadPhotoFile(file) {
  let out = await resizeImage(file, 1000, 0.82);
  if (out.data.length > 400 * 1024 * 4 / 3) out = await resizeImage(file, 800, 0.6);
  const r = await api('/api/files', { kind: 'manual', mime: out.mime, data: out.data });
  return String(r.id);
}
async function addManualPhotos(input) {
  const files = Array.from(input && input.files ? input.files : []);
  if (!files.length) return;
  if (ui.manualPhotos.length + files.length > 12) return toast('사진은 12장까지입니다');
  toast('사진 올리는 중…');
  for (const f of files) {
    try { const id = await uploadPhotoFile(f); ui.manualPhotos.push({ id: id, caption: '' }); }
    catch (e) { toast('사진 실패 — ' + e.message); }
  }
  input.value = '';
  const host = $('#dk-mf-photos');
  if (host) { host.innerHTML = manualPhotosHtml(); hydratePhotos(host); }
  toast('사진 ' + ui.manualPhotos.length + '장');
}
async function removeManualPhoto(idx) {
  const p = ui.manualPhotos[idx];
  if (!p) return;
  ui.manualPhotos.splice(idx, 1);
  try { await fetch('/api/files/' + encodeURIComponent(p.id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + getToken() } }); } catch (e) { /* 남아도 무해 */ }
  const host = $('#dk-mf-photos');
  if (host) { host.innerHTML = manualPhotosHtml(); hydratePhotos(host); }
}
function manualPhotosHtml() {
  if (!ui.manualPhotos.length) return '<div class="hint">사진이 없습니다. 실제 화면을 찍거나 캡처해 올리면 직원이 [📖 방법]에서 봅니다.</div>';
  return '<div class="mphotos">' + ui.manualPhotos.map((p, i) => '<div class="mphoto"><img data-photo="' + esc(p.id) + '" alt="매뉴얼 사진 ' + (i + 1) + '">' +
    '<input class="in" data-photo-cap="' + i + '" maxlength="80" placeholder="설명 또는 단계 번호" value="' + esc(p.caption || '') + '" aria-label="사진 설명">' +
    '<button class="btn btn-sm btn-ghost" data-act="dk-mf-photo-del" data-idx="' + i + '">지우기</button></div>').join('') + '</div>';
}
function readManualPhotos() {
  return ui.manualPhotos.map((p, i) => {
    const el = document.querySelector('[data-photo-cap="' + i + '"]');
    const caption = el ? String(el.value || '').trim().slice(0, 80) : String(p.caption || '');
    return caption ? { id: p.id, caption: caption } : { id: p.id };
  });
}

function openManual(id) {
  const m = manualById(id); if (!m) return;
  const scopeName = m.scope === 'app' ? '학습 앱 업로드' + (m.appId && appById(m.appId) ? ' · ' + appById(m.appId).name : '') : roomLabel(m.scope);
  let body = '<div class="card-sub mb8">' + esc(scopeName) + ' · ' + esc(taskLabel(m.task)) + (m.lastCheckedAt ? ' · 마지막 확인 ' + esc(m.lastCheckedAt) : '') + ' · v' + esc(m.version || 1) + '</div>' +
    (m.purpose ? '<div class="guide mb8"><b>목적</b>' + esc(m.purpose) + '</div>' : '');
  /* 설명이 숫자면 그 단계 바로 아래에, 아니면 맨 끝 사진 모음에 */
  const photos = Array.isArray(m.photos) ? m.photos : [];
  const byStep = {}, rest = [];
  photos.forEach(p => { const n = Number(p.caption); if (Number.isInteger(n) && n > 0) (byStep[n] = byStep[n] || []).push(p); else rest.push(p); });
  const photoHtml = (p, big) => '<div class="mphoto' + (big ? ' big' : '') + '"><img data-photo="' + esc(p.id) + '" alt="' + esc(p.caption || '매뉴얼 사진') + '">' + (p.caption && !Number.isInteger(Number(p.caption)) ? '<small>' + esc(p.caption) + '</small>' : '') + '</div>';
  body += (m.steps || []).length ? (m.steps || []).map((s, i) => '<div class="mstep"><b>' + (i + 1) + '.</b><span>' + esc(s.text) + (s.note ? '<small>' + esc(s.note) + '</small>' : '') +
    (byStep[i + 1] ? byStep[i + 1].map(p => photoHtml(p, true)).join('') : '') + '</span></div>').join('') : '<div class="hint">단계가 없습니다.</div>';
  if (rest.length) body += '<div class="sect">사진</div><div class="mphotos">' + rest.map(p => photoHtml(p, false)).join('') + '</div>';
  if ((m.cautions || []).length) body += '<div class="sect">주의</div>' + m.cautions.map(c => '<div class="small" style="color:var(--bad)">⚠ ' + esc(c) + '</div>').join('');
  if ((m.links || []).length) body += '<div class="row wraprow mt8" style="gap:6px">' + m.links.map(l => '<a class="btn btn-sm btn-navy" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(l.label) + '</a>').join('') + '</div>';
  const foot = session.canApprove
    ? '<div class="row wraprow mt14" style="gap:6px"><button class="btn btn-ghost" data-act="dk-manual-edit" data-id="' + esc(id) + '">편집</button></div>'
    : '<div class="hint mt14">이 매뉴얼이 실제 화면과 다르면 요청함(기타)에 "매뉴얼 다름: ' + esc(m.title) + '"으로 올려 주세요.</div>';
  modal(m.title, body, foot);
  hydratePhotos($('#modalHost'));
}
function openManualForm(id, scope) {
  const m = id ? manualById(id) : null;
  const sc = m ? m.scope : (DC.MANUAL_SCOPES.includes(scope) ? scope : 'studyforce');
  ui.manualPhotos = (m && Array.isArray(m.photos) ? m.photos : []).map(p => ({ id: String(p.id), caption: String(p.caption || '') }));
  const lines = arr => (arr || []).map(x => typeof x === 'string' ? x : (x.text || '') + (x.note ? ' — ' + x.note : '')).join('\n');
  modal(m ? '매뉴얼 편집' : '매뉴얼',
    '<div class="grid2"><div class="field"><label class="fl" for="dk-mf-scope">어느 방</label><select class="in" id="dk-mf-scope" data-act="dk-mf-scope">' + optionsHtml(DC.ROOMS.map(k => [k, roomLabel(k)]).concat([['app', '학습 앱 업로드']]), sc) + '</select></div>' +
    '<div class="field"><label class="fl" for="dk-mf-task">작업 종류</label><select class="in" id="dk-mf-task">' + optionsHtml(MANUAL_TASKS, m ? m.task : 'assign') + '</select></div></div>' +
    '<div class="field" id="dk-mf-w-app"' + (sc === 'app' ? '' : ' hidden') + '><label class="fl" for="dk-mf-app">앱(비우면 모든 앱 공통)</label><select class="in" id="dk-mf-app">' + appOptions(m ? m.appId : '') + '</select></div>' +
    '<div class="field"><label class="fl" for="dk-mf-title">제목</label><input class="in" id="dk-mf-title" maxlength="80" value="' + esc(m ? m.title : '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-mf-purpose">목적 한 줄</label><input class="in" id="dk-mf-purpose" maxlength="300" value="' + esc(m ? m.purpose || '' : '') + '"></div>' +
    '<div class="field"><label class="fl" for="dk-mf-steps">단계 — 한 줄에 하나 (어느 화면에서 무엇을 누르나)</label><textarea class="in" id="dk-mf-steps" rows="7">' + esc(lines(m ? m.steps : [])) + '</textarea></div>' +
    '<div class="field"><label class="fl" for="dk-mf-cautions">주의점 — 한 줄에 하나</label><textarea class="in" id="dk-mf-cautions" rows="3">' + esc(((m ? m.cautions : []) || []).join('\n')) + '</textarea></div>' +
    '<div class="field"><label class="fl" for="dk-mf-links">링크 — "이름 | https://주소" 한 줄에 하나</label><textarea class="in" id="dk-mf-links" rows="2">' + esc(((m ? m.links : []) || []).map(l => l.label + ' | ' + l.url).join('\n')) + '</textarea></div>' +
    '<div class="field"><div class="fl">사진 (실제 화면 — 폰으로 찍거나 캡처, 12장까지, 앱이 줄여서 올립니다)</div><div id="dk-mf-photos">' + manualPhotosHtml() + '</div>' +
      '<label class="btn btn-sm btn-ghost mt8" for="dk-mf-photo-add">＋ 사진 추가</label><input type="file" id="dk-mf-photo-add" accept="image/*" multiple data-act="dk-mf-photo-add" class="sr-only"></div>' +
    '<div class="field"><label class="fl" for="dk-mf-checked">마지막 확인일</label><input class="in" id="dk-mf-checked" type="date" value="' + esc(m ? m.lastCheckedAt || today() : today()) + '"></div>',
    '<div class="row wraprow mt8" style="gap:6px"><button class="btn btn-primary" data-act="dk-manual-save" data-id="' + esc(id || '') + '">저장</button>' +
    (m ? '<button class="btn btn-danger" data-act="dk-manual-del" data-id="' + esc(id) + '">삭제</button>' : '') + '</div>');
}
function saveManualForm(id) {
  const prev = id ? manualById(id) : null;
  const v = DC.validateManual({ scope: val('dk-mf-scope'), appId: val('dk-mf-app'), task: val('dk-mf-task'), title: val('dk-mf-title'), purpose: val('dk-mf-purpose'),
    stepsText: val('dk-mf-steps'), cautionsText: val('dk-mf-cautions'), linksText: val('dk-mf-links'), lastCheckedAt: val('dk-mf-checked'), version: prev ? (Number(prev.version) || 1) + 1 : 1 });
  if (v.error) return toast(v.error);
  v.value.photos = readManualPhotos();
  addDoc('manuals', id || 'm:' + uid(), v.value);
  closeModal(); render(); toast('매뉴얼을 저장했습니다');
}
function deleteManual(id) {
  const m = manualById(id); if (!m) return;
  if (!confirm('"' + m.title + '" 매뉴얼을 지울까요?')) return;
  removeDoc('manuals', id);
  closeModal(); render(); toast('지웠습니다');
}

/* ── 현황(원장) ── */

function viewMatrix() {
  const v = ui.matrixView;
  let h = '<div class="card"><div class="between mb8"><div class="card-title">현황</div></div><div class="chips">' +
    [['students', '학생 × 프로그램'], ['apps', '앱 × 자료 범위'], ['staff', '직원 처리']].map(x => '<button class="chip' + (v === x[0] ? ' on' : '') + '" data-act="dk-matrix-view" data-v="' + x[0] + '">' + x[1] + '</button>').join('') + '</div></div>';
  if (v === 'staff') {
    const on = DC.cardsOn(state.cards, today());
    const late = on.open.filter(c => DC.cardLate(c, today())).length;
    const blocked = on.open.filter(c => c.status === 'blocked').length;
    h += '<div class="card"><div class="row wraprow mb8" style="gap:4px"><span class="pill">열림 ' + on.open.length + '</span><span class="pill">예정 ' + on.upcoming.length + '</span>' +
      (late ? '<span class="pill bad">지연 ' + late + '</span>' : '') + (blocked ? '<span class="pill bad">막힘 ' + blocked + '</span>' : '') + '<span class="pill ok">오늘 완료 ' + on.done.length + '</span></div>';
    [[7, '최근 7일'], [30, '최근 30일']].forEach(w => {
      const rows = DC.staffStats(state.cards, today(), w[0]);
      h += '<div class="sect">' + w[1] + '</div>';
      h += rows.length ? '<div class="mxwrap"><table class="mx"><thead><tr><th>직원</th><th>완료</th><th>기한 넘김</th><th>처리 시간(중앙값)</th><th>평균</th></tr></thead><tbody>' + rows.map(r =>
        '<tr><td>' + esc(staffName(r.staffId)) + '</td><td>' + r.done + '</td><td>' + (r.lateDone ? '<span style="color:var(--bad)">' + r.lateDone + '</span>' : '0') + '</td><td>' + minutesText(r.medianMinutes) + '</td><td>' + minutesText(r.avgMinutes) + '</td></tr>').join('') +
        '</tbody></table></div>' : '<div class="hint">완료한 카드가 없습니다.</div>';
    });
    h += '<div class="hint mt8">처리 시간 = 카드가 만들어진 뒤 완료까지. 템플릿 카드는 그날 앱을 처음 연 시각부터 잽니다.</div></div>';
    return h;
  }
  if (v === 'apps') {
    const cov = DC.coverageOf(state.apps, state.plans);
    if (!cov.length) return h + '<div class="card"><div class="empty"><b>앱이 없습니다</b>관리 탭에서 학원 학습 앱을 등록하세요.</div></div>';
    cov.forEach(c => {
      h += '<div class="card"><div class="between mb8"><div class="card-title">' + esc(c.app.name) + ' <span class="muted small">' + c.total + '</span></div><div class="row wraprow" style="gap:4px">' +
        '<span class="pill ok">있음 ' + c.counts.have + '</span><span class="pill">업로드 대기 ' + c.counts.uploading + '</span><span class="pill warn">구매 대기 ' + c.counts.buying + '</span><span class="pill bad">없음 ' + c.counts.need + '</span></div></div>';
      h += c.rows.length ? c.rows.map(rangeRow).join('') : '<div class="hint">범위가 없습니다. 이그잼포유·족보닷컴 방의 [＋ 범위]로 넣으세요.</div>';
      h += '</div>';
    });
    return h;
  }
  const mx = DC.matrixOf(state.students, state.cards, today());
  if (!mx.length) return h + '<div class="card"><div class="empty"><b>학생이 없습니다</b>학생 탭에서 등록하세요.</div></div>';
  h += '<div class="card"><div class="card-sub mb8">칸 = 마지막 카드. ● 대기 · 진행 · 완료 · 막힘/지연. — 는 구독 안 함.</div><div class="mxwrap"><table class="mx"><thead><tr><th>학생</th>' +
    DC.ROOMS.map(k => '<th>' + esc(roomLabel(k)) + '</th>').join('') + '</tr></thead><tbody>' + mx.map(r => '<tr><td>' + esc(r.name) + (r.grade ? ' <span class="muted">' + esc(r.grade) + '</span>' : '') + '</td>' +
    DC.ROOMS.map(k => {
      const c = r.cells[k];
      if (c.sub === false) return '<td class="off">—</td>';
      if (!c.status) return '<td><span class="muted">·</span></td>';
      return '<td title="' + esc(c.what) + '"><span class="dot ' + (c.late ? 'late' : esc(c.status)) + '"></span> ' + esc(c.late ? '지연' : DC.CARD_STATUS_LABEL[c.status] || c.status) + '</td>';
    }).join('') + '</tr>').join('') + '</tbody></table></div></div>';
  return h;
}

/* ── 이벤트 ───────────────────────────────────────── */

function onClick(ev) {
  const host = $('#modalHost');
  if (host && ev.target === host) { closeModal(); return; }
  const goEl = ev.target.closest('[data-go]');
  if (goEl) { ev.preventDefault(); go(goEl.dataset.go); return; }
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = String(el.dataset.act || '');
  if (act === 'closemodal') { closeModal(); return; }
  if (!act.startsWith('dk-')) return;               // rb-·lg-·pf- 는 패널의 리스너가 받는다
  const id = String(el.dataset.id || '');
  const date = String(el.dataset.date || cursor);
  const task = () => taskById(id);
  switch (act) {
    case 'dk-login': doLogin(el); return;
    case 'dk-setup': doSetup(el); return;
    case 'dk-boot-retry': startApp(); return;
    case 'dk-logout': doLogout(); return;
    case 'dk-reload': reloadAll().catch(e => toast(e.message)); return;
    case 'dk-retry': syncErr = ''; patchSyncBar(); flush(); if (!session) startApp(); return;
    case 'dk-date': {
      cursor = Number(el.dataset.n) === 0 ? today() : addDays(cursor, Number(el.dataset.n) || 0);
      render(); return;
    }
    case 'dk-staff-pick': ui.staffPick = id; render(); return;
    case 'dk-open': { const k = String(el.dataset.key || ''); const t = taskById(k.split('|')[0]); const c = t ? getCheck(t.id, k.split('|')[1]) : null;
      const cur = ui.panels[k] != null ? ui.panels[k] : (t ? DC.statusOf(t, c) !== 'done' : true); ui.panels[k] = !cur; render(); return; }
    case 'dk-att': setCheck('__att__' + session.staffId, today(), { done: true, at: now() }); render(); toast('출근을 기록했습니다'); return;
    case 'dk-toggle': {
      const t = task(); if (!t) return;
      const c = getCheck(t.id, date);
      const done = !!(c && c.done);
      setCheck(t.id, date, { done: !done, at: done ? null : now() });
      render(); return;
    }
    case 'dk-step': {
      const t = task(); if (!t) return;
      const c = getCheck(t.id, date) || {};
      const steps = Object.assign({}, c.steps || {});
      const sid = String(el.dataset.step || '');
      steps[sid] = !steps[sid];
      setCheck(t.id, date, { steps: steps });
      syncAuto(t, date);
      render(); return;
    }
    case 'dk-cnt': {
      const t = task(); if (!t) return;
      const c = getCheck(t.id, date);
      setCheck(t.id, date, { count: Math.max(0, (Number(c && c.count) || 0) + (Number(el.dataset.n) || 0)) });
      syncAuto(t, date);
      render(); return;
    }
    case 'dk-block': {
      const t = task(); if (!t) return;
      const c = getCheck(t.id, date);
      const blocked = !(c && c.blocked);
      setCheck(t.id, date, { blocked: blocked, done: blocked ? false : !!(c && c.done) });
      render(); toast(blocked ? '막힘으로 표시했습니다 — 메모에 이유를 한 줄 남기세요' : '막힘을 해제했습니다'); return;
    }
    case 'dk-task-stop': {
      const t = task(); if (!t || !session.canApprove) return;
      if (!confirm('"' + t.title + '" 지시를 중단할까요? 지난 기록은 남고 오늘부터 보이지 않습니다.')) return;
      if (t.start && t.start >= cursor) t.deleted = true; else t.end = addDays(cursor, -1);
      saveTask(t); render(); toast('지시를 중단했습니다'); return;
    }
    case 'dk-brief': openBrief(); return;
    case 'dk-copy': {
      const target = el.dataset.target ? $('#' + el.dataset.target) : null;
      copyText(target ? String(target.value || target.textContent || '') : String(el.dataset.text || '')); return;
    }
    case 'dk-req-filter': ui.reqFilter = String(el.dataset.v || 'open'); render(); return;
    case 'dk-stu-status': ui.stuStatus = String(el.dataset.v || 'all'); render(); return;
    case 'dk-stu-open': ui.stuOpen = ui.stuOpen === id ? '' : id; render(); return;
    case 'dk-phone': ui.phoneShown[id] = !ui.phoneShown[id]; render(); return;
    case 'dk-stu-new': openStudentForm(''); return;
    case 'dk-stu-edit': openStudentForm(id); return;
    case 'dk-stu-save': saveStudent(id); return;
    case 'dk-stu-del': if (session.canApprove) deleteStudent(id); return;
    case 'dk-contact-new': openContactForm(String(el.dataset.sid || '')); return;
    case 'dk-contact-save': saveContact(); return;
    case 'dk-staff-new': openStaffForm(); return;
    case 'dk-staff-save': saveStaff(el); return;
    case 'dk-staff-link': issueLink(id, el); return;
    case 'dk-staff-rename': openRenameForm(id); return;
    case 'dk-staff-rename-save': renameStaff(id, el); return;
    case 'dk-staff-toggle': toggleStaff(id, el.dataset.on === '1', el); return;
    case 'dk-staff-revoke': revokeStaff(id, el); return;
    case 'dk-settings': openSettings(); return;
    case 'dk-settings-save': saveSettings(); return;
    case 'dk-pw-change': openPasswordForm(); return;
    case 'dk-pw-save': changePassword(el); return;
    case 'dk-export': exportJson(el); return;
    /* 기획서 v1.1 — 카드·템플릿·앱·매뉴얼·현황 */
    case 'dk-card-new': if (session.canApprove) openCardForm(String(el.dataset.room || '')); return;
    case 'dk-card-save': saveCardForm(); return;
    case 'dk-card-status': {
      const v = String(el.dataset.v || 'todo');
      if (!DC.CARD_STATUS.includes(v) || !cardById(id)) return;
      saveCard(id, { status: v });
      render(); if (v === 'done') toast('완료 — 원장 화면에 반영됩니다'); return;
    }
    case 'dk-card-block': openCardBlock(id); return;
    case 'dk-card-block-save': saveCardBlock(id); return;
    case 'dk-card-note': openCardNote(id); return;
    case 'dk-card-note-save': saveCardNote(id); return;
    case 'dk-card-del': {
      const c = cardById(id); if (!c || !session.canApprove) return;
      if (!confirm('"' + c.what + '" 카드를 지울까요?')) return;
      removeDoc('cards', id); render(); return;
    }
    case 'dk-manual-open': openManual(id); return;
    case 'dk-manual-new': if (session.canApprove) openManualForm('', String(el.dataset.scope || '')); return;
    case 'dk-manual-edit': if (session.canApprove) openManualForm(id, ''); return;
    case 'dk-manual-save': saveManualForm(id); return;
    case 'dk-manual-del': deleteManual(id); return;
    case 'dk-manual-seed': if (session.canApprove) seedManuals(); return;
    case 'dk-mf-photo-del': if (session.canApprove) removeManualPhoto(Number(el.dataset.idx)); return;
    case 'dk-manual-scope': ui.manualScope = String(el.dataset.v || ''); render(); return;
    case 'dk-plan-new': if (session.canApprove) openPlanForm('', String(el.dataset.room || '')); return;
    case 'dk-plan-edit': if (session.canApprove) openPlanForm(id, ''); return;
    case 'dk-plan-save': savePlanForm(id); return;
    case 'dk-plan-del': deletePlan(id); return;
    case 'dk-range-new': if (session.canApprove) openRangeForm('', String(el.dataset.room || '')); return;
    case 'dk-range-edit': if (session.canApprove) openRangeForm(id, ''); return;
    case 'dk-range-save': saveRangeForm(id); return;
    case 'dk-app-new': if (session.canApprove) openAppForm(''); return;
    case 'dk-app-edit': if (session.canApprove) openAppForm(id); return;
    case 'dk-app-save': saveAppForm(id); return;
    case 'dk-app-del': deleteApp(id); return;
    case 'dk-matrix-view': ui.matrixView = String(el.dataset.v || 'students'); render(); return;
    case 'dk-req-card': requestToCard(id); return;
    case 'dk-exam-new': if (session.canApprove) openExamForm(''); return;
    case 'dk-exam-edit': if (session.canApprove) openExamForm(id); return;
    case 'dk-exam-save': saveExamForm(id); return;
    default: return;
  }
}

function onChange(ev) {
  const el = ev.target.closest ? ev.target.closest('[data-act^="dk-"]') : null;
  if (!el) return;
  const act = String(el.dataset.act || '');
  if (act === 'dk-range-status') { setRangeStatus(String(el.dataset.id || ''), String(el.value || '')); render(); return; }
  if (act === 'dk-cf-ttype' || act === 'dk-pf-ttype') { toggleTargetFields(act.slice(0, 5)); return; }
  if (act === 'dk-cf-program') { const sel = $('#dk-cf-manual'); if (sel) sel.innerHTML = manualOptions(String(el.value || ''), ''); return; }
  if (act === 'dk-mf-scope') { const w = $('#dk-mf-w-app'); if (w) w.hidden = String(el.value || '') !== 'app'; return; }
  if (act === 'dk-mf-photo-add') { addManualPhotos(el); return; }
  if (el.dataset.act === 'dk-note') {
    const t = taskById(el.dataset.id);
    if (!t) return;
    const note = String(el.value || '').slice(0, DC.NOTE_MAX);
    if (DC.hasPII(note)) { toast('메모에 전화번호·이메일을 넣을 수 없습니다'); el.value = (getCheck(t.id, el.dataset.date) || {}).note || ''; return; }
    setCheck(t.id, String(el.dataset.date || cursor), { note: note });
  }
}

function onInput(ev) {
  const el = ev.target;
  if (!el || !el.dataset) return;
  if (el.dataset.act === 'dk-stu-q') {
    ui.stuQ = String(el.value || '');
    const list = $('#dk-stu-list');
    if (list) list.innerHTML = studentList();
  } else if (el.dataset.act === 'dk-ct-q') {
    ui.ctQ = String(el.value || '');
    const list = $('#dk-ct-list');
    if (list) {
      const q = ui.ctQ.trim();
      list.innerHTML = contactList(state.contacts.filter(c => c && !c.deleted).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).filter(c => !q || studentName(c.studentId).includes(q)).slice(0, 200));
    }
  }
}

function onKey(ev) {
  if (ev.key === 'Escape') { const host = $('#modalHost'); if (host && !host.hidden) { closeModal(); return; } }
  if (ev.key === 'Enter' && ev.target && ev.target.dataset && ev.target.dataset.enter && ev.target.tagName !== 'TEXTAREA') {
    ev.preventDefault();
    const btn = document.querySelector('[data-act="' + ev.target.dataset.enter + '"]');
    if (btn) btn.click();
    return;
  }
  /* 학생 행 머리는 button이 아니라 div — 키보드로도 펼치게 */
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.dataset && ev.target.dataset.act === 'dk-stu-open') {
    ev.preventDefault(); ev.target.click();
  }
}

document.addEventListener('click', onClick);
document.addEventListener('change', onChange);
document.addEventListener('input', onInput);
document.addEventListener('keydown', onKey);
window.addEventListener('hashchange', onHash);
document.addEventListener('visibilitychange', () => { if (!document.hidden && session) { poll(); if (outbox.size()) scheduleFlush(0); } });
window.addEventListener('online', () => { if (session) { syncErr = ''; poll(); if (outbox.size()) scheduleFlush(0); } });
window.addEventListener('beforeunload', ev => { if (outbox.size()) { ev.preventDefault(); ev.returnValue = ''; } });

startApp();
