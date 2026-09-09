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
const TABS = [['today', '오늘'], ['requests', '요청함'], ['students', '학생'], ['assets', '자산'], ['perf', '수행'], ['contacts', '연락'], ['admin', '관리']];

/* ── 계약 전역(§4) ────────────────────────────────── */

let state = emptyState();
let session = null;                      // {role, isAdmin, isStaffLink, staffId, name, canApprove}
let rosterDb = null;                     // {students:[{id,name,grade,start,end}]} — 수행 패널이 본다
let rosterErr = '';
let rosterLoading = false;
let route = 'login';
let cursor = DC.ymdOf(new Date());

/* 화면 상태 — 재렌더(폴링 도착 포함)에도 살아남아야 하므로 DOM이 아니라 여기 둔다. */
const ui = {
  staffPick: '', panels: {}, stuQ: '', stuStatus: 'all', stuOpen: '', phoneShown: {},
  reqFilter: 'open', reqErr: '', ctQ: '', linkBusy: false
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

function emptyState() { return { staff: [], tasks: [], checks: {}, students: [], contacts: [], settings: {}, meta: {}, base: {} }; }

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
    syncErr = '';
    if (n && !typingInView()) render(); else patchSyncBar();
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
  const r = DC.routeOf(location.hash);
  route = r.route === 'login' ? 'today' : r.route;
  if (route === 'admin' && !session.canApprove) route = 'today';
  if (location.hash !== '#/' + route) history.replaceState(null, '', '#/' + route);
  render();
}

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
  const target = DC.ROUTES.includes(r) ? r : 'today';
  if (location.hash === '#/' + target) { onHash(); return; }
  location.hash = '#/' + target;
}
function onHash() {
  const r = DC.routeOf(location.hash);
  if (r.code) { linkExchange(r.code); return; }
  if (!session) { route = 'login'; render(); return; }
  route = r.route === 'login' ? 'today' : r.route;
  if (route === 'admin' && !session.canApprove) route = 'today';
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
  const badges = {
    requests: openReq,
    assets: session.canApprove ? WBLedgerUI.alertCount() : 0,
    perf: WBPerfPanel.alertCount()
  };
  wrap.innerHTML = TABS.filter(t => t[0] !== 'admin' || session.canApprove).map(t =>
    '<a class="tab' + (route === t[0] ? ' on' : '') + '" href="#/' + t[0] + '" data-go="' + t[0] + '">' + esc(t[1]) +
    (badges[t[0]] ? '<span class="badge">' + badges[t[0]] + '</span>' : '') + '</a>').join('');
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
    ((actions.length || link) ? '<div class="row wraprow mt8" style="gap:6px">' + actions.map(a =>
      '<button class="btn btn-sm ' + (a === 'done' ? 'btn-primary' : a === 'block' ? 'btn-danger' : a === 'cancel' ? 'btn-ghost' : 'btn-navy') +
      '" data-act="rb-req-act" data-id="' + esc(r.id) + '" data-action="' + esc(a) + '">' + esc(C.REQ_ACTION_LABEL[a] || a) + '</button>').join('') +
      (link ? '<a class="btn btn-sm btn-ghost" href="' + esc(link.url) + '" target="_blank" rel="noopener noreferrer">↗ ' + esc(link.label) + '</a>' : '') + '</div>' : '') +
    '</div></div>';
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
    name: val('dk-f-name'), grade: val('dk-f-grade'), code: val('dk-f-code'), status: val('dk-f-status'), since: val('dk-f-since'), memo: val('dk-f-memo'),
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
    default: return;
  }
}

function onChange(ev) {
  const el = ev.target.closest ? ev.target.closest('[data-act^="dk-"]') : null;
  if (!el) return;
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
