/* WB 세일즈데스크 — 런타임(화면·API 클라이언트·변경 큐)
 *
 * 하는 일 셋:
 *   1) API 클라이언트(Bearer 토큰) · 변경 큐(300ms 디바운스 POST /api/docs) · 60초 폴링 — desk/app/app.js 와 같은 계약.
 *   2) 화면 8개: 로그인 · 오늘(팔로업·최종판정·핫·미연락·재검사) · 파이프라인(칸반) · 리드(명단) · 리드 상세 · 성과(KPI) · 허브스팟(원장) · 관리(원장).
 *   3) 상담·CS 가 끝난 뒤의 흐름 — 기록을 남기면 D+3·7·14 팔로업이 잡히고, 오늘 화면이 매일 할 일을 꺼내 준다. 판정(등록/보류/이탈+사유)까지.
 *
 * 규칙 판단(단계·채널 감지·팔로업·KPI)은 전부 WBCrmCore(crm-core.js) 가 한다 — 여기서는 그 결과를 그린다.
 * 개인정보(이름·전화)는 서버(D1)에만 있고 이 기기엔 토큰만 남는다. 전화는 가려 보이고 탭하면 통화.
 */
'use strict';

const C = WBCrmCore;
const TOKEN_KEY = 'crm.token';
const POLL_MS = 60000;
const FLUSH_MS = 300;
const TABS = [['today', '오늘'], ['pipeline', '파이프라인'], ['leads', '리드'], ['stats', '성과'], ['hubspot', '허브스팟'], ['partners', '파트너'], ['admin', '관리']];

let state = C.emptyState();
let session = null;              // {role, canApprove, staffId, name}
let route = 'login';
let leadId = '';                 // route === 'lead'
const ui = {
  pipe: 'inspection', q: '', status: 'open', channel: '', owner: '', phoneShown: {}, ym: C.ymOf(C.ymdOf(new Date())),
  hs: { status: null, pipelines: null, suggested: null, props: null, queue: [], counts: null, busy: '', err: '', filter: 'pending', map: null },
  leadQueue: {}, linkBusy: false, detect: null
};
const boot = { health: null, err: '', busy: false };
const outbox = C.createOutbox();
let syncErr = '', lastSync = 0, flushTimer = null, flushing = false, pollTimer = null, modalReturnFocus = null;

/* ── 도우미 ─────────────────────────────────────────── */
const $ = sel => document.querySelector(sel);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function today() { return C.ymdOf(new Date()); }
function now() { return Date.now(); }
function uid(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function val(id) { const el = $('#' + id); return el ? String(el.value || '').trim() : ''; }
function checked(id) { const el = $('#' + id); return !!(el && el.checked); }
function fmtDate(s) { return C.validYmd(s) ? s.slice(5).replace('-', '/') : (s || ''); }
function fmtWon(n) { return (Number(n) || 0).toLocaleString('ko-KR') + '원'; }
function pct(v) { return v === null || v === undefined ? '—' : v + '%'; }
function staffName(id) {
  if (!id || id === 'admin') return '원장';
  if (id === 'hubspot') return 'HubSpot';
  if (String(id).startsWith('partner:')) { const p = partnerById(String(id).slice(8)); return '파트너 ' + (p ? p.name : ''); }
  const s = state.staff.find(x => String(x.id) === String(id));
  return s ? String(s.name) : '직원';
}
function liveStaff() { return state.staff.filter(s => s && s.active !== false); }
function settings() { return state.settings || {}; }
function hsSettings() { return settings().hubspot || {}; }
function leadById(id) { return state.leads.find(l => l && String(l.id) === String(id)) || null; }
function partnerById(id) { return state.partners.find(p => p && String(p.id) === String(id)) || null; }
function activePartners() { return state.partners.filter(p => p && p.status === 'active').sort((a, b) => String(a.name).localeCompare(String(b.name))); }
function referralsOf(id) { return state.referrals.filter(r => r && r.leadId === id).sort((a, b) => String(b.at).localeCompare(String(a.at))); }
function initial(name) { const n = String(name || '').trim(); return n ? n.slice(0, 1) : '?'; }
function activitiesOf(id) { return state.activities.filter(a => a && a.leadId === id).sort((a, b) => String(b.at).localeCompare(String(a.at)) || (b.ts || 0) - (a.ts || 0)); }
function creditsOf(id) { return state.credits.filter(c => c && c.leadId === id).sort((a, b) => String(b.at).localeCompare(String(a.at))); }

function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = String(msg == null ? '' : msg); t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2800);
}
function setInert(on) { ['.topbar', '.tabs', '#view'].forEach(sel => { const el = $(sel); if (el) el.inert = on; }); }
function modal(title, bodyHtml, footHtml) {
  const host = $('#modalHost'); if (!host) return;
  if (host.hidden) modalReturnFocus = document.activeElement;
  host.innerHTML = '<div class="modal-box"><div class="between mb14"><div class="card-title" id="modalTitle">' + esc(title) + '</div>' +
    '<button class="btn btn-sm btn-ghost" data-act="closemodal" aria-label="닫기">닫기</button></div>' + bodyHtml + (footHtml || '') + '</div>';
  host.hidden = false; setInert(true);
  requestAnimationFrame(() => { const first = host.querySelector('input:not([type=checkbox]), select, textarea'); (first || host.querySelector('[data-act="closemodal"]') || host).focus(); });
}
function closeModal() {
  const host = $('#modalHost'); if (!host) return;
  host.hidden = true; host.innerHTML = ''; setInert(false);
  const target = modalReturnFocus; modalReturnFocus = null;
  if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
}
function copyText(text, label) {
  const done = () => toast((label || '초안') + '을 복사했습니다 — 카톡·문자에 붙여 넣으세요');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => showCopyFallback(text));
  else showCopyFallback(text);
}
function showCopyFallback(text) {
  modal('초안', '<textarea class="in" rows="9" readonly>' + esc(text) + '</textarea><div class="hint mt8">길게 눌러 전체 선택 → 복사</div>');
}
function opt(list, value, labelFn) { return list.map(v => '<option value="' + esc(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(labelFn ? labelFn(v) : v) + '</option>').join(''); }

/* ── API·세션 ─────────────────────────────────────── */
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, String(t)); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* 사설 모드 */ } }

async function api(path, body, opts) {
  const o = opts || {};
  const headers = { Accept: 'application/json' };
  const tok = getToken();
  if (tok && !o.noAuth) headers.Authorization = 'Bearer ' + tok;
  const init = { method: o.method || (body ? 'POST' : 'GET'), headers, cache: 'no-store' };
  if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); } catch (e) { throw Object.assign(new Error('서버에 연결할 수 없습니다'), { code: 'NETWORK' }); }
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (res.status === 401 || (json && json.code === 'AUTH')) {
    if (!o.noAuth) onAuthLost();
    throw Object.assign(new Error((json && json.error) || '인증이 필요합니다'), { code: 'AUTH', status: 401 });
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && (json.error || json.code)) || ('HTTP ' + res.status));
    err.code = (json && json.code) || 'HTTP'; err.status = res.status;
    if (json) err.body = json;
    throw err;
  }
  return json;
}
function onAuthLost() {
  if (!session && !getToken()) return;
  setToken(''); session = null; stopPolling(); outbox.clear(); state = C.emptyState(); route = 'login'; render(); toast('다시 로그인해 주세요');
}

/* 변경 큐 — 로컬 즉시 반영 + 300ms 뒤 서버. 서버 거절(권한·append-only)은 되돌리고, STALE 은 서버 값으로. */
function localUpsert(c, id, data) {
  const list = state[c];
  if (!Array.isArray(list)) return;
  const i = list.findIndex(x => String(x.id) === String(id));
  const item = Object.assign({}, data, { id: String(id) });
  if (i >= 0) list[i] = item; else list.push(item);
}
function queueChange(c, id, data, deleted) {
  if (deleted) { const list = state[c]; const i = Array.isArray(list) ? list.findIndex(x => String(x.id) === String(id)) : -1; if (i >= 0) list.splice(i, 1); }
  else if (c === 'settings') state.settings = Object.assign({}, data);
  else localUpsert(c, id, data);
  outbox.put(c, id, data, deleted);
  scheduleFlush(FLUSH_MS);
  patchSyncBar();
}
function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms == null ? FLUSH_MS : ms); }
const REVERT_CODES = ['FORBIDDEN', 'APPEND_ONLY', 'PII', 'INVALID', 'TOO_LARGE'];
async function flush() {
  if (flushing || !session || !outbox.size()) return;
  flushing = true;
  const sent = outbox.snapshot(200);
  const changes = sent.map(e => {
    const ch = { c: e.c, id: e.id, data: e.data };
    const at = state.meta[C.docKey(e.c, e.id)];
    if (at) ch.expectedUpdatedAt = at;
    if (e.deleted) ch.deleted = true;
    return ch;
  });
  try {
    let res;
    try { res = await api('/api/docs', { changes }); }
    catch (e) { if (e.code === 'AUTH' || !e.body || !Array.isArray(e.body.results)) throw e; res = e.body; }
    const r = outbox.ack(sent, res.results || []);
    r.ok.forEach(o => { if (o.updatedAt) state.meta[o.key] = o.updatedAt; });
    let dirty = false;
    if (r.stale.length) {
      r.stale.forEach(s => {
        if (s.current) { forceDoc(currentToDoc(s)); return; }
        delete state.meta[s.key];
        const e = sent.find(x => C.docKey(x.c, x.id) === s.key);
        if (e && !outbox.has(s.key)) outbox.put(e.c, e.id, e.data, e.deleted);
      });
      if (r.stale.some(s => s.current)) toast('다른 기기에서 먼저 바뀐 항목이 있어 최신 값으로 갱신했습니다');
      dirty = true;
    }
    if (r.failed.length) {
      const reverted = r.failed.filter(f => REVERT_CODES.includes(f.code));
      reverted.forEach(f => { const doc = C.revertDoc(state, f.key); if (doc) forceDoc(doc); });
      toast('저장 거절 — ' + r.failed[0].error);
      dirty = true;
    }
    if (res.results && res.results.some(x => x.queued)) { ui.hs.counts = null; }
    if (dirty && !typingInView()) render();
    syncErr = '';
    if (outbox.size()) scheduleFlush(50);
    else if (r.ok.length) await poll();   // 서버가 hubspot 필드·stageAt 을 고쳐 두었을 수 있다 — 바로 받아 온다
  } catch (e) { if (e.code !== 'AUTH') syncErr = e.message; }
  finally { flushing = false; patchSyncBar(); }
}
function currentToDoc(s) {
  const cur = s.current;
  const hasData = cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, 'data');
  return { c: s.c, id: s.id, data: hasData ? cur.data : cur, updatedAt: hasData ? cur.updatedAt : 0, deleted: hasData ? !!cur.deleted : false };
}
function forceDoc(doc) { delete state.meta[C.docKey(doc.c, doc.id)]; applyDocs([doc], 0, true); }
function applyDocs(docs, serverNow, force) {
  const r = C.mergeDocs(state, docs, force ? [] : outbox.keys());
  state = r.local;
  if (serverNow) lastSync = Math.max(lastSync, Number(serverNow) || 0);
  return r.changed;
}
async function loadAll() { const res = await api('/api/docs'); applyDocs(res.docs, res.now); }
async function poll() {
  if (!session || document.hidden) return;
  try {
    const res = await api('/api/docs?since=' + Math.max(0, lastSync - 1));
    const n = applyDocs(res.docs, res.now);
    syncErr = '';
    if (n && !typingInView()) render(); else patchSyncBar();
    if (outbox.size()) scheduleFlush(0);
  } catch (e) { if (e.code !== 'AUTH') { syncErr = e.message; patchSyncBar(); } }
}
function startPolling() { stopPolling(); pollTimer = setInterval(poll, POLL_MS); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
function typingInView() {
  const a = document.activeElement, view = $('#view');
  return !!(a && view && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}

function makeSession(me) {
  const role = me.role === 'admin' ? 'admin' : 'staff';
  return { role, canApprove: role === 'admin', staffId: role === 'admin' ? 'admin' : String(me.staffId || ''), name: String(me.name || (role === 'admin' ? '원장' : '직원')) };
}
async function afterAuth() {
  const me = await api('/api/me');
  session = makeSession(me); boot.err = '';
  await loadAll();
  startPolling();
  applyRoute(C.routeOf(location.hash));
  render();
}
function applyRoute(r) {
  route = r.route === 'login' ? 'today' : r.route;
  leadId = r.route === 'lead' ? String(r.id || '') : '';
  if (C.OWNER_ROUTES.includes(route) && !session.canApprove) route = 'today';
  const h = hashOf(route, leadId);
  if (location.hash !== h) history.replaceState(null, '', h);
}
function hashOf(r, id) { return r === 'lead' ? '#/lead/' + id : '#/' + r; }
function go(r, id) {
  const target = hashOf(C.ROUTES.includes(r) ? r : 'today', id || '');
  if (location.hash === target) { onHash(); return; }
  location.hash = target;
}
function onHash() {
  const r = C.routeOf(location.hash);
  if (r.code) { linkExchange(r.code); return; }
  if (!session) { route = 'login'; render(); return; }
  applyRoute(r);
  if (route === 'hubspot') loadHubspotPanel();
  if (route === 'lead' && leadId) loadLeadQueue(leadId);
  render();
}
async function linkExchange(code) {
  if (ui.linkBusy) return;
  ui.linkBusy = true;
  try {
    const r = await api('/api/link-exchange', { code }, { noAuth: true });
    if (!r.token) throw new Error('토큰이 없습니다');
    setToken(r.token); history.replaceState(null, '', '#/today');
    await afterAuth(); toast('이 기기를 연결했습니다');
  } catch (e) {
    boot.err = '링크 연결 실패 — ' + e.message + (e.code === 'NETWORK' || e.code === 'STAFF_INACTIVE' ? '' : ' (링크는 7일 안에 한 번만 쓸 수 있습니다 — 원장께 새 링크를 받으세요)');
    history.replaceState(null, '', '#/login'); route = 'login'; render();
  } finally { ui.linkBusy = false; }
}
async function startApp() {
  render();
  const r = C.routeOf(location.hash);
  if (r.code) return linkExchange(r.code);
  if (getToken()) { try { await afterAuth(); return; } catch (e) { if (e.code !== 'AUTH') boot.err = e.message; } }
  await loadHealth(); route = 'login'; render();
}
async function loadHealth() {
  try { boot.health = await api('/api/health', null, { noAuth: true }); boot.err = ''; }
  catch (e) { boot.health = null; if (e.code !== 'AUTH') boot.err = e.message; }
}
async function doLogin(btn) {
  const pw = val('f-pw');
  if (!pw) return toast('비밀번호를 입력하세요');
  if (boot.busy) return;
  boot.busy = true; if (btn) btn.disabled = true;
  try {
    const r = await api('/api/login', { password: pw }, { noAuth: true });
    setToken(r.token); await afterAuth(); toast('환영합니다');
  } catch (e) {
    if (e.code === 'NOT_SETUP') { boot.health = Object.assign({}, boot.health, { setup: false }); render(); }
    toast(e.code === 'AUTH' ? '로그인 실패 — 비밀번호가 맞지 않습니다' : '로그인 실패 — ' + e.message);
  } finally { boot.busy = false; if (btn) btn.disabled = false; }
}
async function doSetup(btn) {
  const pw = val('f-pw'), pw2 = val('f-pw2');
  if (pw.length < 8 || pw.length > 72) return toast('비밀번호는 8~72자');
  if (pw !== pw2) return toast('두 비밀번호가 다릅니다');
  if (boot.busy) return;
  boot.busy = true; if (btn) btn.disabled = true;
  try { const r = await api('/api/setup', { password: pw }, { noAuth: true }); setToken(r.token); await afterAuth(); toast('관리자 비밀번호를 만들었습니다'); }
  catch (e) { toast('설정 실패 — ' + e.message); if (e.code === 'ALREADY_SETUP') { boot.health = Object.assign({}, boot.health, { setup: true }); render(); } }
  finally { boot.busy = false; if (btn) btn.disabled = false; }
}
async function doLogout() {
  if (outbox.size() && !confirm('저장되지 않은 변경 ' + outbox.size() + '건이 있습니다. 그래도 로그아웃할까요?')) return;
  try { await api('/api/logout', {}); } catch (e) { /* 토큰은 버린다 */ }
  setToken(''); session = null; stopPolling(); outbox.clear(); state = C.emptyState();
  await loadHealth(); route = 'login'; history.replaceState(null, '', '#/login'); render();
}

/* ── 렌더 ─────────────────────────────────────────── */
function render() {
  const who = $('#who'), org = $('#orgName'), tabs = $('#tabs'), view = $('#view');
  if (!view) return;
  if (org) org.textContent = session ? String(settings().orgName || '') : '';
  if (who) who.innerHTML = session ? '<span class="whoami' + (session.canApprove ? ' owner' : '') + '">' + esc(session.canApprove ? '원장' : session.name) + '</span><button class="btn-bar" data-act="logout">로그아웃</button>' : '';
  if (tabs) { tabs.hidden = !session; if (session) updateTabs(); }
  let h = '';
  try {
    if (!session) h = viewLogin();
    else {
      h = syncBanner();
      switch (route) {
        case 'today': h += viewToday(); break;
        case 'pipeline': h += viewPipeline(); break;
        case 'leads': h += viewLeads(); break;
        case 'lead': h += viewLead(leadId); break;
        case 'stats': h += viewStats(); break;
        case 'hubspot': h += session.canApprove ? viewHubspot() : viewToday(); break;
        case 'partners': h += session.canApprove ? viewPartners() : viewToday(); break;
        case 'admin': h += session.canApprove ? viewAdmin() : viewToday(); break;
        default: h += viewToday();
      }
    }
  } catch (e) {
    console.error('render', e);
    h = '<div class="card alert"><div class="card-title">화면을 그리지 못했습니다</div><div class="card-sub">' + esc(e && e.message || e) + '</div><button class="btn btn-sm btn-ghost mt8" data-act="reload">다시 불러오기</button></div>';
  }
  view.innerHTML = h;
}
function updateTabs() {
  const wrap = $('#tabsWrap'); if (!wrap || !session) return;
  const board = C.todayBoard(state.leads, state.activities, today());
  const todayN = board.followups.length + board.decide.length + board.fresh.length;
  const hsN = ui.hs.counts ? (ui.hs.counts.pending || 0) + (ui.hs.counts.failed || 0) : 0;
  wrap.innerHTML = TABS.filter(t => session.canApprove || !C.OWNER_ROUTES.includes(t[0])).map(t => {
    const on = route === t[0] || (route === 'lead' && t[0] === 'leads');
    const badge = t[0] === 'today' && todayN ? '<span class="badge">' + todayN + '</span>' : t[0] === 'hubspot' && hsN ? '<span class="badge soft">' + hsN + '</span>' : '';
    return '<button class="tab' + (on ? ' on' : '') + '" data-act="go" data-r="' + t[0] + '">' + esc(t[1]) + badge + '</button>';
  }).join('');
}
function syncBanner() {
  const n = outbox.size();
  if (!syncErr && !n) return '<div id="syncBar"></div>';
  return '<div id="syncBar">' + (syncErr ? '<div class="banner bad">저장 보류 ' + n + '건 — ' + esc(syncErr) + ' <button class="btn btn-sm btn-ghost" data-act="retry-sync">다시 시도</button></div>' : '') + '</div>';
}
function patchSyncBar() { const bar = $('#syncBar'); if (!bar) return; const tmp = document.createElement('div'); tmp.innerHTML = syncBanner(); bar.replaceWith(tmp.firstChild); updateTabs(); }

/* ── 화면: 로그인 ───────────────────────────────────── */
function viewLogin() {
  const h = boot.health;
  const setupNeeded = h && h.setup === false;
  return '<div class="login"><div class="logo">W</div><h1 class="page">WB 세일즈데스크</h1>' +
    '<div class="card-sub mb14">상담·CS 가 끝난 뒤의 전환 관리 — 팔로업·판정·HubSpot 연동. 원내 직원 전용.</div>' +
    (boot.err ? '<div class="banner bad">' + esc(boot.err) + '</div>' : '') +
    '<div class="card">' + (setupNeeded
      ? '<div class="card-title">관리자 비밀번호 만들기</div><div class="card-sub mb8">처음 한 번만 나옵니다. 8자 이상.</div>' +
        '<div class="field"><input class="in" id="f-pw" type="password" autocomplete="new-password" placeholder="비밀번호"></div>' +
        '<div class="field"><input class="in" id="f-pw2" type="password" autocomplete="new-password" placeholder="비밀번호 확인" data-enter="setup"></div>' +
        '<button class="btn btn-primary btn-block" data-act="setup">만들고 시작</button>'
      : '<div class="card-title">원장 로그인</div><div class="card-sub mb8">직원은 원장이 보낸 개인 링크를 열면 바로 연결됩니다.</div>' +
        '<div class="field"><input class="in" id="f-pw" type="password" autocomplete="current-password" placeholder="비밀번호" data-enter="login"></div>' +
        '<button class="btn btn-primary btn-block" data-act="login">로그인</button>') + '</div></div>';
}

/* ── 화면: 오늘 ─────────────────────────────────────── */
function leadRow(l, extraHtml, actsHtml) {
  const dis = C.daysInStage(l, today());
  return '<div class="lead" data-act="open-lead" data-id="' + esc(l.id) + '"><div class="avatar' + (l.hot && l.status === 'open' ? ' hot' : l.status === 'won' ? ' ok' : '') + '">' + esc(initial(l.name)) + '</div><div class="grow"><div class="lead-name">' + esc(C.leadLabel(l)) +
    (l.hot && l.status === 'open' ? '<span class="pill hot">HOT</span>' : '') + statusPill(l) + '</div>' +
    '<div class="lead-sub"><span class="tag">' + esc(l.channel || '기타') + (l.partnerId && partnerById(l.partnerId) ? ' · ' + esc(partnerById(l.partnerId).name) : '') + '</span><span>' + esc(C.PIPELINE_LABEL[l.pipeline] || '') + ' · ' + esc(C.STAGE_LABEL[l.stage] || l.stage) + (dis !== null ? ' ' + dis + '일' : '') + '</span>' +
    (l.owner ? '<span>· ' + esc(staffName(l.owner)) + '</span>' : '') + (extraHtml || '') + '</div></div>' + (actsHtml ? '<div class="acts">' + actsHtml + '</div>' : '') + '</div>';
}
function statusPill(l) {
  if (l.status === 'won') return '<span class="pill ok">등록</span>';
  if (l.status === 'lost') return '<span class="pill bad">이탈' + (l.outcome && l.outcome.reason ? ' ' + esc(l.outcome.reason) : '') + '</span>';
  if (l.status === 'hold') return '<span class="pill warn">보류</span>';
  return '';
}
function viewToday() {
  const t = today();
  const b = C.todayBoard(state.leads, state.activities, t);
  let h = '<div class="between mb8"><h1 class="page" style="margin:0">오늘 <small class="muted small">' + esc(t) + '</small></h1><button class="btn btn-primary btn-sm" data-act="new-lead">＋ 새 문의</button></div>';
  h += '<div class="card"><div class="card-title">팔로업 <span class="badge soft">' + b.followups.length + '</span></div><div class="card-sub mb8">상담·CS 가 끝난 날 기준 D+3 · D+7 · D+14. 밀린 것이 먼저.</div>';
  h += b.followups.length ? b.followups.map(x => {
    const f = x.followup;
    return '<div class="fu' + (f.late > 0 ? ' late' : '') + '"><div class="grow"><b data-act="open-lead" data-id="' + esc(x.lead.id) + '" style="cursor:pointer">' + esc(C.leadLabel(x.lead)) + '</b> <span class="tag acc">D+' + f.day + ' ' + esc(C.FOLLOWUP_LABEL[f.day] || '') + '</span> <span class="due small">' + (f.late > 0 ? f.late + '일 밀림' : '오늘') + '</span></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="fu-draft" data-id="' + esc(x.lead.id) + '" data-day="' + f.day + '">초안 복사</button>' +
      '<button class="btn btn-sm btn-primary" data-act="fu-log" data-id="' + esc(x.lead.id) + '" data-day="' + f.day + '">기록</button>' +
      '<button class="btn btn-sm" data-act="fu-skip" data-id="' + esc(x.lead.id) + '" data-day="' + f.day + '">건너뜀</button></div>';
  }).join('') : '<div class="empty small">오늘 할 팔로업이 없습니다</div>';
  h += '</div>';
  if (b.decide.length) {
    h += '<div class="card"><div class="card-title">최종판정 대기 <span class="badge">' + b.decide.length + '</span></div><div class="card-sub mb8">상담 뒤 14일이 지났는데 아직 결정이 없습니다 — 등록 · 장기보류 · 이탈(사유) 중 하나로.</div>';
    h += b.decide.map(x => leadRow(x.lead, '<span class="tag warn">D+' + x.days + '</span>',
      '<button class="btn btn-sm btn-good" data-act="outcome" data-id="' + esc(x.lead.id) + '" data-kind="won">등록</button><button class="btn btn-sm btn-warn" data-act="outcome" data-id="' + esc(x.lead.id) + '" data-kind="hold">보류</button><button class="btn btn-sm btn-danger" data-act="outcome" data-id="' + esc(x.lead.id) + '" data-kind="lost">이탈</button>')).join('');
    h += '</div>';
  }
  if (b.hot.length || b.fresh.length) {
    h += '<div class="card"><div class="card-title">바로 연락할 문의</div>';
    if (b.hot.length) h += '<div class="sect">핫 리드 ' + b.hot.length + '</div>' + b.hot.map(l => leadRow(l)).join('');
    if (b.fresh.length) h += '<div class="sect">하루 넘게 연락 기록 없음 ' + b.fresh.length + '</div>' + b.fresh.map(l => leadRow(l)).join('');
    h += '</div>';
  }
  const rt = b.retest;
  const rtN = rt[30].length + rt[7].length + rt[0].length + rt.overdue.length;
  if (rtN) {
    h += '<div class="card"><div class="card-title">재검사 안내 <span class="badge soft">' + rtN + '</span></div><div class="card-sub mb8">검사일 + 2년(시선추적 1년). D-30 첫 안내 · D-7 독려 · D-day 는 원장 직접 통화.</div>';
    [['overdue', '지남'], [0, 'D-day'], [7, 'D-7'], [30, 'D-30']].forEach(([k, label]) => {
      if (!rt[k].length) return;
      h += '<div class="sect">' + label + ' ' + rt[k].length + '</div>' + rt[k].map(x => leadRow(x.lead, '<span class="tag' + (k === 'overdue' || k === 0 ? ' bad' : '') + '">재검사 ' + esc(x.lead.retestDue) + '</span>',
        k === 30 || k === 7 ? '<button class="btn btn-sm btn-ghost" data-act="retest-draft" data-id="' + esc(x.lead.id) + '" data-w="' + k + '">초안 복사</button>' : '')).join('');
    });
    h += '</div>';
  }
  if (session.canApprove && ui.hs.counts && (ui.hs.counts.pending || ui.hs.counts.failed)) {
    h += '<div class="banner warn">HubSpot 반영 대기 ' + (ui.hs.counts.pending || 0) + '건' + (ui.hs.counts.failed ? ' · 실패 ' + ui.hs.counts.failed + '건' : '') + ' <button class="btn btn-sm btn-ghost" data-act="go" data-r="hubspot">허브스팟 탭</button></div>';
  }
  if (!state.leads.length) h += '<div class="empty"><b>첫 문의를 등록해 보세요</b>문의 원문을 붙여 넣으면 유입 채널과 핫 리드 여부를 알아서 표시합니다.</div>';
  return h;
}

/* ── 화면: 파이프라인 ─────────────────────────────── */
function viewPipeline() {
  const p = ui.pipe;
  const t = today();
  const leads = state.leads.filter(l => l.pipeline === p);
  let h = '<div class="between mb8"><h1 class="page" style="margin:0">파이프라인</h1><button class="btn btn-primary btn-sm" data-act="new-lead">＋ 새 문의</button></div>';
  h += '<div class="pipe-switch">' + C.PIPELINES.map(k => '<button class="chip' + (k === p ? ' on' : '') + '" data-act="pipe" data-p="' + k + '">' + esc(C.PIPELINE_LABEL[k]) + ' <span class="small">' + state.leads.filter(l => l.pipeline === k && l.status !== 'lost' && l.status !== 'won').length + '</span></button>').join('') + '</div>';
  h += '<div class="board wide">' + C.stagesOf(p).map(s => {
    const closed = C.isClosed(s);
    const cards = leads.filter(l => l.stage === s).sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || String(a.stageAt).localeCompare(String(b.stageAt)));
    return '<div class="col' + (closed ? ' closed' : '') + '"><div class="col-head"><span>' + esc(C.STAGE_LABEL[s]) + '</span><span class="badge soft">' + cards.length + '</span></div>' +
      (closed && cards.length > 5 ? '<details><summary class="small muted">' + cards.length + '건 보기</summary>' : '') +
      cards.map(l => {
        const d = C.daysInStage(l, t);
        const stale = !closed && d !== null && d >= 14;
        return '<div class="kcard' + (l.hot && !closed ? ' hot' : '') + (stale ? ' stale' : '') + (closed ? ' closed' : '') + '" data-act="open-lead" data-id="' + esc(l.id) + '"><div class="kcard-name">' + esc(C.leadLabel(l)) + '</div>' +
          '<div class="kcard-sub"><span>' + esc(l.channel || '') + '</span>' + (d !== null ? '<span>' + d + '일</span>' : '') + (l.status === 'hold' ? '<span class="tag warn">보류</span>' : '') +
          (l.hubspot && l.hubspot.contactId ? '<span class="dot ok" title="HubSpot 연결됨"></span>' : '') + '</div></div>';
      }).join('') + (closed && cards.length > 5 ? '</details>' : '') + '</div>';
  }).join('') + '</div>';
  return h;
}

/* ── 화면: 리드 명단 ──────────────────────────────── */
function viewLeads() {
  const q = ui.q;
  let list = state.leads.filter(l => C.leadMatches(l, q));
  if (ui.status !== 'all') list = list.filter(l => ui.status === 'open' ? (l.status === 'open' || l.status === 'hold') : l.status === ui.status);
  if (ui.channel) list = list.filter(l => l.channel === ui.channel);
  if (ui.owner) list = list.filter(l => String(l.owner) === ui.owner);
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.name).localeCompare(String(b.name)));
  let h = '<div class="between mb8"><h1 class="page" style="margin:0">리드 <small class="muted small">' + list.length + '</small></h1><button class="btn btn-primary btn-sm" data-act="new-lead">＋ 새 문의</button></div>';
  h += '<div class="card"><div class="row wraprow mb8"><input class="in" id="f-q" placeholder="이름·아이·학교·전화 검색" value="' + esc(q) + '" style="flex:1;min-width:160px">' +
    '<select class="in" id="f-channel" style="width:auto"><option value="">채널 전체</option>' + opt(C.CHANNELS, ui.channel) + '</select>' +
    (session.canApprove ? '<select class="in" id="f-owner" style="width:auto"><option value="">담당 전체</option><option value="admin"' + (ui.owner === 'admin' ? ' selected' : '') + '>원장</option>' + liveStaff().map(s => '<option value="' + esc(s.id) + '"' + (ui.owner === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>' : '') + '</div>' +
    '<div class="chips mb8">' + [['open', '진행·보류'], ['won', '등록'], ['lost', '이탈'], ['all', '전체']].map(([k, l]) => '<button class="chip' + (ui.status === k ? ' on' : '') + '" data-act="status-filter" data-s="' + k + '">' + l + '</button>').join('') + '</div>';
  h += list.length ? list.slice(0, 200).map(l => leadRow(l, l.phone ? '<span>· ' + esc(C.maskPhone(l.phone)) + '</span>' : '')).join('') : '<div class="empty small">조건에 맞는 리드가 없습니다</div>';
  if (list.length > 200) h += '<div class="hint mt8">200건까지만 보입니다 — 검색으로 좁혀 주세요</div>';
  return h + '</div>';
}

/* ── 화면: 리드 상세 ──────────────────────────────── */
function viewLead(id) {
  const l = leadById(id);
  if (!l) return '<div class="empty"><b>리드를 찾을 수 없습니다</b><button class="btn btn-ghost btn-sm" data-act="go" data-r="leads">명단으로</button></div>';
  const t = today();
  const acts = activitiesOf(id);
  const stages = C.stagesOf(l.pipeline);
  const portal = hsSettings().portal || {};
  const hs = l.hubspot || {};
  const dis = C.daysInStage(l, t);
  let h = '<div class="row mb8"><button class="btn btn-sm btn-ghost" data-act="back">‹ 뒤로</button></div>';
  h += '<div class="card"><div class="between wraprow"><div><div class="card-title">' + esc(l.name) + ' <span class="muted small">' + esc(C.RELATION_HONORIFIC[l.relation] || '') + '</span>' + (l.child && l.child.name ? ' · ' + esc(l.child.name) + (l.child.grade ? ' <span class="muted small">' + esc(l.child.grade) + '</span>' : '') : '') + '</div>' +
    '<div class="row wraprow mt8">' + (l.hot && l.status === 'open' ? '<span class="pill hot">HOT</span>' : '') + '<span class="pill acc">' + esc(C.PIPELINE_LABEL[l.pipeline]) + '</span><span class="pill">' + esc(C.STAGE_LABEL[l.stage] || l.stage) + (dis !== null ? ' · ' + dis + '일' : '') + '</span>' + statusPill(l) + '<span class="tag">' + esc(l.channel) + (l.channelNote ? ' · ' + esc(l.channelNote) : '') + '</span></div></div>' +
    '<div class="row wraprow"><button class="btn btn-sm btn-ghost" data-act="edit-lead" data-id="' + esc(id) + '">수정</button><button class="btn btn-sm btn-primary" data-act="new-activity" data-id="' + esc(id) + '">＋ 기록</button></div></div>';
  h += '<div class="row wraprow mt14"><label class="fl" style="margin:0" for="f-stage">단계</label><select class="in" id="f-stage" data-id="' + esc(id) + '" style="width:auto">' + stages.map(s => '<option value="' + s + '"' + (s === l.stage ? ' selected' : '') + '>' + esc(C.STAGE_LABEL[s]) + '</option>').join('') +
    (l.pipeline === 'inspection' ? '<option value="__academy">→ 학원 등록 파이프라인으로(트라이얼)</option>' : '') + '</select>' +
    (l.status === 'open' ? '<button class="btn btn-sm btn-warn" data-act="outcome" data-id="' + esc(id) + '" data-kind="hold">장기보류</button>' : '') +
    (l.status === 'hold' ? '<button class="btn btn-sm btn-ghost" data-act="unhold" data-id="' + esc(id) + '">보류 해제</button>' : '') + '</div>';
  h += '<dl class="kv mt14">' +
    '<dt>전화</dt><dd>' + (l.phone ? (ui.phoneShown[id] ? '<a class="tel" href="tel:' + esc(l.phone.replace(/-/g, '')) + '">' + esc(l.phone) + '</a>' : '<button class="btn btn-sm btn-ghost" data-act="show-phone" data-id="' + esc(id) + '">' + esc(C.maskPhone(l.phone)) + ' 보기</button>') : '<span class="muted">—</span>') + '</dd>' +
    (l.email ? '<dt>이메일</dt><dd>' + esc(l.email) + '</dd>' : '') +
    (l.child && (l.child.birth || l.child.school) ? '<dt>아이</dt><dd>' + esc([l.child.birth, l.child.school].filter(Boolean).join(' · ')) + '</dd>' : '') +
    '<dt>관심</dt><dd>' + (l.interests && l.interests.length ? esc(l.interests.join(' · ')) : '<span class="muted">—</span>') + '</dd>' +
    '<dt>담당</dt><dd>' + esc(staffName(l.owner)) + '</dd>' +
    '<dt>문의일</dt><dd>' + esc(l.createdAt || '') + '</dd>' +
    (l.inspection && (l.inspection.type || l.inspection.date) ? '<dt>검사</dt><dd>' + esc([l.inspection.type, l.inspection.date].filter(Boolean).join(' · ')) + (l.retestDue ? ' <span class="tag">재검사 ' + esc(l.retestDue) + '</span>' : '') + '</dd>' : '') +
    (l.consultedAt ? '<dt>상담 완료</dt><dd>' + esc(l.consultedAt) + ' <span class="muted small">(D+' + C.daysBetween(l.consultedAt, t) + ')</span></dd>' : '') +
    (l.strength ? '<dt>강점</dt><dd>' + esc(l.strength) + '</dd>' : '') +
    (l.partnerId ? '<dt>파트너</dt><dd>' + esc(partnerById(l.partnerId) ? partnerById(l.partnerId).name : '(삭제됨)') + ' <span class="muted small">소개로 접수</span></dd>' : '') +
    (l.referrerLeadId ? '<dt>소개자</dt><dd>' + (leadById(l.referrerLeadId) ? '<a href="#/lead/' + esc(l.referrerLeadId) + '">' + esc(C.leadLabel(leadById(l.referrerLeadId))) + '</a>' : '<span class="muted">(삭제됨)</span>') + '</dd>' : '') +
    (l.academyStatus ? '<dt>학원 상태</dt><dd>' + esc(l.academyStatus) + '</dd>' : '') +
    (l.outcome && l.status !== 'open' ? '<dt>판정</dt><dd>' + esc(C.STATUS_LABEL[l.status]) + ' · ' + esc(l.outcome.at || '') + (l.outcome.reason ? ' · ' + esc(l.outcome.reason + ' ' + (C.LOST_REASON_LABEL[l.outcome.reason] || '')) : '') + (l.outcome.note ? '<div class="small muted">' + esc(l.outcome.note) + '</div>' : '') + '</dd>' : '') +
    (l.memo ? '<dt>메모</dt><dd style="white-space:pre-wrap">' + esc(l.memo) + '</dd>' : '') +
    '<dt>HubSpot</dt><dd>' + (hs.contactId ? '<span class="tag ok">연결됨</span> ' + (C.hubspotRecordUrl(portal, 'contact', hs.contactId) ? '<a href="' + esc(C.hubspotRecordUrl(portal, 'contact', hs.contactId)) + '" target="_blank" rel="noopener noreferrer">연락처 열기</a>' : '') +
      (hs.deals && hs.deals[l.pipeline] && C.hubspotRecordUrl(portal, 'deal', hs.deals[l.pipeline].dealId) ? ' · <a href="' + esc(C.hubspotRecordUrl(portal, 'deal', hs.deals[l.pipeline].dealId)) + '" target="_blank" rel="noopener noreferrer">딜 열기</a>' : '') : '<span class="tag">아직 안 보냄</span>') + leadQueueHtml(id) + '</dd></dl></div>';
  // 팔로업
  const fus = Array.isArray(l.followups) ? l.followups.slice().sort((a, b) => a.day - b.day) : [];
  h += '<div class="card"><div class="between"><div class="card-title">팔로업</div>' + (l.status === 'open' || l.status === 'hold' ? '<button class="btn btn-sm btn-ghost" data-act="fu-reset" data-id="' + esc(id) + '">' + (fus.length ? '일정 다시 잡기' : '일정 잡기') + '</button>' : '') + '</div>';
  h += fus.length ? fus.map(f => {
    const late = f.status === 'pending' ? C.daysBetween(f.due, t) : null;
    return '<div class="fu' + (f.status !== 'pending' ? ' done' : late > 0 ? ' late' : '') + '"><div class="grow"><span class="tag acc">D+' + f.day + ' ' + esc(C.FOLLOWUP_LABEL[f.day] || '') + '</span> <span class="due">' + esc(f.due) + '</span>' +
      (f.status === 'done' ? ' <span class="tag ok">완료 ' + esc(C.RESULT_LABEL[f.result] || '') + '</span>' : f.status === 'skipped' ? ' <span class="tag">건너뜀</span>' : late > 0 ? ' <span class="tag bad">' + late + '일 밀림</span>' : '') + (f.note ? '<div class="small muted">' + esc(f.note) + '</div>' : '') + '</div>' +
      (f.status === 'pending' && l.status === 'open' ? '<button class="btn btn-sm btn-ghost" data-act="fu-draft" data-id="' + esc(id) + '" data-day="' + f.day + '">초안</button><button class="btn btn-sm btn-primary" data-act="fu-log" data-id="' + esc(id) + '" data-day="' + f.day + '">기록</button><button class="btn btn-sm" data-act="fu-skip" data-id="' + esc(id) + '" data-day="' + f.day + '">건너뜀</button>' : '') + '</div>';
  }).join('') : '<div class="hint">상담·CS 기록을 남기면서 "팔로업 일정 시작"을 켜면 D+3 · D+7 · D+14 가 잡힙니다.</div>';
  h += '</div>';
  // 파트너에 소개(나가는 소개)
  const refs = referralsOf(id);
  h += '<div class="card"><div class="between"><div class="card-title">파트너 소개 <span class="muted small">' + refs.length + '</span></div>' +
    (activePartners().length ? '<button class="btn btn-sm btn-ghost" data-act="refer-form" data-id="' + esc(id) + '">파트너에 소개</button>' : (session.canApprove ? '<a class="small" href="#/partners">파트너 등록</a>' : '')) + '</div>';
  h += refs.length ? refs.map(r => { const p = partnerById(r.partnerId); return '<div class="fu"><div class="grow"><b>' + esc(p ? p.name : '(삭제된 파트너)') + '</b> <span class="muted small">' + esc(r.at) + (r.note ? ' · ' + esc(r.note) : '') + '</span>' + (r.partnerNote ? '<div class="small">파트너: ' + esc(r.partnerNote) + '</div>' : '') + '</div>' +
    '<select class="in" style="width:auto" id="f-refstatus-' + esc(r.id) + '" data-rid="' + esc(r.id) + '">' + C.REFERRAL_STATUS.map(k => '<option value="' + k + '"' + (k === r.status ? ' selected' : '') + '>' + esc(C.REFERRAL_STATUS_LABEL[k]) + '</option>').join('') + '</select></div>'; }).join('')
    : '<div class="hint">검사·해석 뒤 맞는 학원이 있으면 가정 동의를 받고 소개합니다. 파트너 포털에 아이 이름·학년·사유만 보입니다.</div>';
  h += '</div>';
  // 크레딧(원장)
  if (session.canApprove) {
    const credits = creditsOf(id);
    const referred = state.leads.filter(x => x.referrerLeadId === id);
    h += '<div class="card"><div class="between"><div class="card-title">소개 크레딧 <span class="muted small">잔액 ' + esc(fmtWon(C.creditBalance(state.credits, id))) + (l.creditBalanceHs !== undefined ? ' · HubSpot ' + esc(fmtWon(l.creditBalanceHs)) : '') + '</span></div>' +
      '<div class="row"><button class="btn btn-sm btn-ghost" data-act="credit-form" data-id="' + esc(id) + '" data-type="accrue">적립</button><button class="btn btn-sm btn-ghost" data-act="credit-form" data-id="' + esc(id) + '" data-type="use">사용</button></div></div>';
    if (referred.length) h += '<div class="hint mt8">소개한 리드: ' + referred.map(x => '<a href="#/lead/' + esc(x.id) + '">' + esc(C.leadLabel(x)) + '</a>').join(', ') + '</div>';
    h += credits.length ? credits.map(c => '<div class="fu"><div class="grow"><span class="tag' + (c.amount > 0 ? ' ok' : '') + '">' + esc(C.CREDIT_LABEL[c.type] || c.type) + '</span> ' + esc(fmtWon(c.amount)) + ' <span class="muted small">' + esc(c.at) + (c.note ? ' · ' + esc(c.note) : '') + '</span></div></div>').join('') : '<div class="hint mt8">v2.0 — 피소개자 검사 완료 시 소개자에게 15,000원, 같은 소개자 30일 쿨다운, 24개월 뒤 소멸.</div>';
    h += '</div>';
  }
  // 타임라인
  h += '<div class="card"><div class="card-title">기록 <span class="muted small">' + acts.length + '</span></div>';
  h += acts.length ? '<div class="tl mt8">' + acts.map(a => '<div class="tl-item' + (a.type === 'stage' || a.type === 'hubspot' ? ' sys' : '') + '"><div class="tl-head"><b>' + esc(C.ACTIVITY_LABEL[a.type] || a.type) + '</b>' +
    (a.result ? '<span class="tag">' + esc(C.RESULT_LABEL[a.result] || a.result) + '</span>' : '') + (a.followupDay ? '<span class="tag acc">D+' + a.followupDay + '</span>' : '') + '<span>' + esc(a.at) + '</span><span>' + esc(staffName(a.by)) + '</span>' +
    (a.hubspot && a.hubspot.noteId ? '<span class="dot ok" title="HubSpot 노트로 보냄"></span>' : '') + '</div>' +
    (a.type === 'stage' ? '<div class="tl-text muted">' + esc((C.STAGE_LABEL[a.from] || a.from || '') + ' → ' + (C.STAGE_LABEL[a.to] || a.to || '')) + (a.text ? ' · ' + esc(a.text) : '') + '</div>' : a.text ? '<div class="tl-text">' + esc(a.text) + '</div>' : '') + '</div>').join('') + '</div>'
    : '<div class="hint mt8">아직 기록이 없습니다.</div>';
  h += '</div>';
  if (session.canApprove) h += '<div class="right"><button class="btn btn-sm btn-danger" data-act="delete-lead" data-id="' + esc(id) + '">리드 삭제</button></div>';
  return h;
}
function leadQueueHtml(id) {
  const items = ui.leadQueue[id];
  if (!Array.isArray(items) || !items.length) return '';
  const open = items.filter(i => i.status === 'pending' || i.status === 'approved' || i.status === 'failed');
  if (!open.length) return '';
  return '<div class="small mt8">' + open.map(i => '<span class="tag' + (i.status === 'failed' ? ' bad' : i.status === 'approved' ? ' acc' : ' warn') + '">' + esc(C.SYNC_KIND_LABEL[i.kind]) + ' ' + esc(C.SYNC_STATUS_LABEL[i.status]) + '</span>').join(' ') +
    (session.canApprove ? ' <button class="btn btn-sm btn-ghost" data-act="go" data-r="hubspot">승인하러</button>' : '') + '</div>';
}
async function loadLeadQueue(id) {
  try { const r = await api('/api/hubspot/queue?leadId=' + encodeURIComponent(id)); ui.leadQueue[id] = r.items; ui.hs.counts = r.counts; if (route === 'lead' && leadId === id && !typingInView()) render(); }
  catch (e) { /* 큐 표시는 부가 정보 */ }
}

/* ── 화면: 성과 ─────────────────────────────────────── */
function barList(obj, labelFn, cls) {
  const entries = Object.keys(obj).map(k => [k, obj[k]]).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  if (!entries.length) return '<div class="hint">자료 없음</div>';
  return entries.map(([k, n]) => '<div class="bar' + (cls ? ' ' + cls : '') + '"><span>' + esc(labelFn ? labelFn(k) : k) + '</span><div class="track"><div class="fill" style="width:' + Math.round(n / max * 100) + '%"></div></div><span class="num">' + n + '</span></div>').join('');
}
function viewStats() {
  const ym = ui.ym;
  const k = C.kpi(state.leads, state.activities, ym, today());
  const prev = C.ymOf(C.addMonths(ym + '-01', -1)), next = C.ymOf(C.addMonths(ym + '-01', 1));
  let h = '<div class="between mb8"><button class="btn btn-sm btn-ghost" data-act="ym" data-ym="' + prev + '">‹</button><h1 class="page" style="margin:0">' + esc(ym.replace('-', '년 ')) + '월 성과</h1><button class="btn btn-sm btn-ghost" data-act="ym" data-ym="' + next + '">›</button></div>';
  h += '<div class="tiles">' +
    '<div class="tile"><div class="n">' + k.inquiries + '</div><div class="l">신규 문의</div></div>' +
    '<div class="tile"><div class="n">' + k.consulted + '</div><div class="l">상담 완료(코호트)</div></div>' +
    '<div class="tile good"><div class="n">' + k.won + '<small>/ ' + k.consulted + '</small></div><div class="l">등록</div></div>' +
    '<div class="tile' + (k.conversion !== null && k.conversion >= 60 ? ' good' : k.conversion !== null ? ' bad' : '') + '"><div class="n">' + esc(pct(k.conversion)) + '</div><div class="l">전환율 (목표 60%)</div></div>' +
    '<div class="tile"><div class="n">' + esc(pct(k.decidedIn14)) + '</div><div class="l">D+14 내 결정률 (목표 80%)</div></div>' +
    '<div class="tile"><div class="n">' + esc(pct(k.followup1Response)) + '</div><div class="l">팔로업1 응답률 (목표 40%)</div></div>' +
    '<div class="tile"><div class="n">' + k.lostMonth + '</div><div class="l">이달 이탈 확정</div></div>' +
    '<div class="tile"><div class="n">' + esc(pct(k.hotRate)) + '</div><div class="l">핫 리드 비율</div></div></div>';
  h += '<div class="grid2"><div class="card"><div class="card-title">채널별 유입</div><div class="card-sub mb8">이달 신규 문의</div>' + barList(k.channels) + '</div>' +
    '<div class="card"><div class="card-title">이탈 사유</div><div class="card-sub mb8">이달 이탈 확정</div>' + barList(k.lostReasons, c => c + ' ' + (C.LOST_REASON_LABEL[c] || ''), 'bad') + '</div></div>';
  h += '<div class="grid2">' + C.PIPELINES.map(p => '<div class="card"><div class="card-title">' + esc(C.PIPELINE_LABEL[p]) + ' — 진행 중</div><div class="card-sub mb8">지금 열려 있는 리드</div>' + barList(k.stages[p], s => C.STAGE_LABEL[s] || s) + '</div>').join('') + '</div>';
  h += '<div class="hint">전환율 = 그 달 상담 완료 코호트 중 등록 ÷ 코호트 전체. D+14 결정률은 상담 뒤 14일이 지난 리드만 센다.</div>';
  return h;
}

/* ── 화면: 허브스팟(원장) ──────────────────────────── */
async function loadHubspotPanel(force) {
  if (ui.hs.busy && !force) return;
  ui.hs.busy = 'status'; ui.hs.err = '';
  try {
    const s = await api('/api/hubspot/status');
    ui.hs.status = s; ui.hs.counts = s.queue;
    const q = await api('/api/hubspot/queue?limit=200');
    ui.hs.queue = q.items; ui.hs.counts = q.counts;
    if (s.connected && !ui.hs.props) { try { ui.hs.props = await api('/api/hubspot/properties'); } catch (e) { ui.hs.props = { error: e.message }; } }
  } catch (e) { ui.hs.err = e.message; }
  finally {
    ui.hs.busy = '';
    try { await poll(); } catch (e) { /* 상태 확인이 설정 문서(포털 정보)를 고쳤을 수 있어 meta 를 맞춘다 */ }
    if (route === 'hubspot' && !typingInView()) render(); else updateTabs();
  }
}
function viewHubspot() {
  const s = ui.hs.status;
  const hsS = hsSettings();
  let h = '<div class="between mb8"><h1 class="page" style="margin:0">허브스팟 연동</h1><button class="btn btn-sm btn-ghost" data-act="hs-refresh">다시 확인</button></div>';
  if (ui.hs.err) h += '<div class="banner bad">' + esc(ui.hs.err) + '</div>';
  // 연결
  h += '<div class="card"><div class="card-title">연결</div>';
  if (!s) h += '<div class="hint">확인 중…</div>';
  else if (s.connected) h += '<div class="banner ok" style="margin:8px 0 0">연결됨' + (s.portal && s.portal.portalId ? ' · 포털 ' + esc(s.portal.portalId) + ' · ' + esc(s.portal.timeZone || '') : '') + '</div>';
  else if (s.reason === 'no_token') h += '<div class="banner warn" style="margin:8px 0 0">토큰이 없습니다</div><div class="guide"><b>연결 방법</b>1. HubSpot → 설정 → 통합 → 비공개 앱(Private Apps) → 앱 만들기\n2. 스코프: crm.objects.contacts (읽기·쓰기) · crm.objects.deals (읽기·쓰기) · crm.schemas.contacts (읽기·쓰기) · crm.objects.owners (읽기)\n3. 토큰을 GitHub 저장소 Settings → Secrets → Actions 에 <b>HUBSPOT_ACCESS_TOKEN</b> 으로 저장\n4. Actions → "Deploy wb-crm worker" 를 한 번 실행(Run workflow) → 워커 시크릿으로 복사됩니다\n토큰은 저장소·화면·로그 어디에도 적지 않습니다.</div>';
  else h += '<div class="banner bad" style="margin:8px 0 0">연결 실패 — ' + esc(s.error || s.reason) + '</div><div class="hint mt8">토큰이 만료·폐기됐거나 스코프가 모자랍니다. 새 토큰을 저장소 시크릿에 넣고 배포 워크플로우를 다시 돌리세요.</div>';
  h += '</div>';
  if (s && s.connected) {
    // 속성
    const p = ui.hs.props;
    h += '<div class="card"><div class="between"><div class="card-title">WB 사용자 속성</div>' + (p && p.missing && p.missing.length ? '<button class="btn btn-sm btn-primary" data-act="hs-props-create"' + (ui.hs.busy ? ' disabled' : '') + '>없는 속성 ' + p.missing.length + '개 만들기</button>' : '') + '</div>';
    if (!p) h += '<div class="hint">확인 중…</div>';
    else if (p.error) h += '<div class="banner bad">' + esc(p.error) + '</div>';
    else h += '<div class="card-sub mt8">연락처 속성 — 있음 ' + p.present.length + ' · 없음 ' + p.missing.length + '</div><div class="row wraprow mt8">' + p.present.map(n => '<span class="tag ok">' + esc(n) + '</span>').join('') + p.missing.map(n => '<span class="tag warn">' + esc(n) + '</span>').join('') + '</div>' +
      (p.missing.length ? '<div class="hint mt8">없는 속성(검사 종류·검사일·자녀 정보·상담 완료일·이탈 사유·리드 ID)은 만들기 전까지 HubSpot 으로 보내지 않습니다 — 그 외 값은 지금도 갑니다.</div>' : '');
    h += '</div>';
    // 매핑
    h += '<div class="card"><div class="between"><div class="card-title">파이프라인 매핑</div><button class="btn btn-sm btn-ghost" data-act="hs-pipelines"' + (ui.hs.busy ? ' disabled' : '') + '>HubSpot 파이프라인 불러오기</button></div>' +
      '<div class="card-sub">우리 단계 ↔ HubSpot 딜 단계. 라벨이 같으면 자동으로 맞춰 둡니다(검사 여정·학원 등록). 매핑이 없는 단계의 딜은 반영되지 않습니다.</div>';
    const pipes = ui.hs.pipelines;
    const map = ui.hs.map || hsS.map || {};
    if (pipes) {
      h += C.PIPELINES.map(pk => {
        const m = map[pk] || {};
        const chosen = pipes.find(x => x.id === m.pipelineId);
        return '<div class="sect">' + esc(C.PIPELINE_LABEL[pk]) + '</div><div class="maprow"><span>HubSpot 파이프라인</span><select class="in" data-act="hs-map-pipe" data-p="' + pk + '"><option value="">— 선택 —</option>' + pipes.map(x => '<option value="' + esc(x.id) + '"' + (x.id === m.pipelineId ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select></div>' +
          (chosen ? C.stagesOf(pk).map(sk => '<div class="maprow"><span>' + esc(C.STAGE_LABEL[sk]) + '</span><select class="in" data-act="hs-map-stage" data-p="' + pk + '" data-s="' + sk + '"><option value="">— 없음 —</option>' + chosen.stages.map(st => '<option value="' + esc(st.id) + '"' + (m.stageMap && m.stageMap[sk] === st.id ? ' selected' : '') + '>' + esc(st.label) + '</option>').join('') + '</select></div>').join('') : '');
      }).join('') + '<button class="btn btn-primary btn-block mt14" data-act="hs-map-save">매핑 저장</button>';
    } else {
      const saved = hsS.map || {};
      const has = C.PIPELINES.filter(pk => saved[pk] && saved[pk].pipelineId);
      h += '<div class="hint mt8">' + (has.length ? '저장된 매핑: ' + has.map(pk => esc(C.PIPELINE_LABEL[pk]) + ' → ' + esc(saved[pk].pipelineLabel || saved[pk].pipelineId) + ' (' + Object.keys(saved[pk].stageMap || {}).length + '단계)').join(' · ') : '아직 매핑이 없습니다 — 불러오기를 누르면 제안이 채워집니다.') + '</div>';
    }
    h += '</div>';
    // 가져오기
    const pull = s.pull;
    h += '<div class="card"><div class="between"><div class="card-title">HubSpot 에서 가져오기</div><div class="row"><button class="btn btn-sm btn-ghost" data-act="hs-pull" data-full="1"' + (ui.hs.busy ? ' disabled' : '') + '>전체</button><button class="btn btn-sm btn-primary" data-act="hs-pull"' + (ui.hs.busy ? ' disabled' : '') + '>변경분 가져오기</button></div></div>' +
      '<div class="card-sub">연락처(+ 매핑된 딜)를 리드로 들여옵니다. 같은 연락처는 한 리드로, 우리 쪽 미반영 변경이 있는 리드는 건너뜁니다. 기록·팔로업·메모는 덮지 않습니다.</div>' +
      (pull && pull.at ? '<div class="hint mt8">마지막 가져오기 ' + esc(new Date(pull.at).toLocaleString('ko-KR')) + (pull.after ? ' · 이어서 받을 페이지가 있습니다 — 다시 누르세요' : '') + '</div>' : '') + (ui.hs.pullMsg ? '<div class="banner ok mt8">' + esc(ui.hs.pullMsg) + '</div>' : '') + '</div>';
  }
  // 큐
  const counts = ui.hs.counts || {};
  const filter = ui.hs.filter;
  const items = ui.hs.queue.filter(i => filter === 'all' ? true : filter === 'open' ? (i.status === 'pending' || i.status === 'approved' || i.status === 'failed') : i.status === filter);
  h += '<div class="card"><div class="between wraprow"><div class="card-title">반영 큐</div><div class="row wraprow">' +
    '<label class="check small"><input type="checkbox" id="f-autoquick"' + (hsS.autoApproveQuick ? ' checked' : '') + '> 빠른 입력(연락처·기록)은 자동 승인</label></div></div>' +
    '<div class="card-sub">리드·기록이 바뀌면 여기 줄이 생기고, 승인한 것만 HubSpot 으로 갑니다. 딜 단계 전이는 항상 원장 승인. 승인된 줄은 15분마다 자동 반영되고 [지금 반영]으로 바로 보낼 수도 있습니다.</div>' +
    '<div class="chips mt8">' + [['pending', '승인 대기 ' + (counts.pending || 0)], ['approved', '반영 대기 ' + (counts.approved || 0)], ['failed', '실패 ' + (counts.failed || 0)], ['done', '반영됨 ' + (counts.done || 0)], ['rejected', '반려 ' + (counts.rejected || 0)]].map(([k, l]) => '<button class="chip' + (filter === k ? ' on' : '') + '" data-act="hs-filter" data-f="' + k + '">' + esc(l) + '</button>').join('') + '</div>' +
    '<div class="row wraprow mt8">' + (counts.pending ? '<button class="btn btn-sm btn-good" data-act="hs-approve-all">전체 승인 (' + counts.pending + ')</button>' : '') +
    (counts.approved ? '<button class="btn btn-sm btn-primary" data-act="hs-push"' + (ui.hs.busy || !(s && s.connected) ? ' disabled' : '') + '>지금 반영 (' + counts.approved + ')</button>' : '') + '</div>';
  h += items.length ? items.slice(0, 100).map(i => {
    const l = leadById(i.leadId);
    const what = i.kind === 'deal' ? esc(C.PIPELINE_LABEL[i.payload.pipeline] || '') + ' → ' + esc(C.STAGE_LABEL[i.payload.stage] || i.payload.stage) : i.kind === 'contact' ? '연락처 ' + esc((i.payload.fields || []).join(', ')) : '기록(노트)';
    return '<div class="qitem"><div class="grow"><b data-act="open-lead" data-id="' + esc(i.leadId) + '" style="cursor:pointer">' + esc(l ? C.leadLabel(l) : i.leadId) + '</b> <span class="tag' + (i.track === 'review' ? ' warn' : '') + '">' + esc(C.SYNC_TRACK_LABEL[i.track]) + '</span> <span class="tag' + (i.status === 'done' ? ' ok' : i.status === 'failed' ? ' bad' : i.status === 'approved' ? ' acc' : '') + '">' + esc(C.SYNC_STATUS_LABEL[i.status]) + '</span>' +
      '<div class="small">' + esc(C.SYNC_KIND_LABEL[i.kind]) + ' · ' + what + ' <span class="muted">· ' + esc(staffName(i.createdBy)) + ' · ' + esc(new Date(i.createdAt).toLocaleString('ko-KR')) + '</span></div>' + (i.error ? '<div class="err">' + esc(i.error) + '</div>' : '') + '</div>' +
      '<div class="row">' + (i.status === 'pending' ? '<button class="btn btn-sm btn-good" data-act="hs-q" data-op="approve" data-id="' + esc(i.id) + '">승인</button><button class="btn btn-sm btn-danger" data-act="hs-q" data-op="reject" data-id="' + esc(i.id) + '">반려</button>' : '') +
      (i.status === 'approved' ? '<button class="btn btn-sm btn-ghost" data-act="hs-q" data-op="unapprove" data-id="' + esc(i.id) + '">승인 취소</button>' : '') +
      (i.status === 'failed' ? '<button class="btn btn-sm btn-warn" data-act="hs-q" data-op="retry" data-id="' + esc(i.id) + '">다시 시도</button>' : '') + '</div></div>';
  }).join('') : '<div class="hint mt8">해당 상태의 줄이 없습니다.</div>';
  return h + '</div>';
}
async function hsAction(kind, arg) {
  if (ui.hs.busy) return;
  ui.hs.busy = kind; render();
  try {
    if (kind === 'pipelines') {
      const r = await api('/api/hubspot/pipelines');
      ui.hs.pipelines = r.pipelines; ui.hs.suggested = r.suggested;
      const saved = hsSettings().map || {};
      ui.hs.map = {};
      C.PIPELINES.forEach(p => { ui.hs.map[p] = saved[p] && saved[p].pipelineId ? JSON.parse(JSON.stringify(saved[p])) : r.suggested[p]; });
      toast('파이프라인 ' + r.pipelines.length + '개 — 라벨이 같은 단계는 미리 맞춰 두었습니다');
    } else if (kind === 'props') {
      const r = await api('/api/hubspot/properties', {});
      ui.hs.props = await api('/api/hubspot/properties');
      toast('속성 ' + r.created.length + '개 만들었습니다' + (r.failed.length ? ' · 실패 ' + r.failed.length : ''));
    } else if (kind === 'pull') {
      const r = await api('/api/hubspot/pull', { full: !!arg });
      ui.hs.pullMsg = '가져오기 — 새 리드 ' + r.created + ' · 갱신 ' + r.updated + ' · 건너뜀(미반영 변경) ' + r.conflicts + (r.more ? ' · 더 있음(다시 누르세요)' : '');
      await loadAll();
    } else if (kind === 'push') {
      const r = await api('/api/hubspot/push', { limit: 25 });
      toast('반영 ' + r.done + '건' + (r.failed ? ' · 실패 ' + r.failed : '') + (r.remaining ? ' · 남은 ' + r.remaining + '건(다시 누르세요)' : '') + (r.stopped ? ' · 중단: ' + r.stopped : ''));
      await loadAll();
    } else if (kind === 'queue') {
      await api('/api/hubspot/queue', arg);
    }
  } catch (e) { toast((kind === 'pull' ? '가져오기 실패 — ' : kind === 'push' ? '반영 실패 — ' : '') + e.message); }
  finally { ui.hs.busy = ''; await loadHubspotPanel(true); }
}
function saveMapping() {
  const map = ui.hs.map || {};
  const cur = Object.assign({}, settings());
  const hs = Object.assign({}, cur.hubspot || {}, { map });
  queueChange('settings', 'main', Object.assign({}, cur, { hubspot: hs }));
  toast('매핑을 저장했습니다 — 반영 대기 중인 딜이 이 매핑으로 갑니다');
}
function setAutoQuick(on) {
  const cur = Object.assign({}, settings());
  queueChange('settings', 'main', Object.assign({}, cur, { hubspot: Object.assign({}, cur.hubspot || {}, { autoApproveQuick: !!on }) }));
  toast(on ? '빠른 입력은 이제 자동 승인됩니다(딜 단계 전이는 그대로 원장 승인)' : '모든 반영을 원장이 승인합니다');
}

/* ── 화면: 파트너(원장) ────────────────────────────── */
function viewPartners() {
  const ym = ui.ym;
  const prev = C.ymOf(C.addMonths(ym + '-01', -1)), next = C.ymOf(C.addMonths(ym + '-01', 1));
  const partners = state.partners.slice().sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
  const stats = C.partnerStats(state.leads, state.referrals, partners, ym);
  const all = C.partnerStats(state.leads, state.referrals, partners, '');
  let h = '<div class="between mb8"><h1 class="page" style="margin:0">파트너 학원</h1><button class="btn btn-primary btn-sm" data-act="partner-new">＋ 파트너</button></div>';
  h += '<div class="card-sub mb14">서로 광고·소개하고 센터는 검사를 제공하는 연계 학원. 파트너는 <b>/partner/</b> 포털(개인 링크)에서 소개를 보내고 받은 소개의 상태를 표시합니다. 기획: docs/파트너학원-연계-기획서-v0.md</div>';
  h += '<div class="between mb8"><button class="btn btn-sm btn-ghost" data-act="ym" data-ym="' + prev + '">‹</button><b>' + esc(ym.replace('-', '년 ')) + '월 집계</b><button class="btn btn-sm btn-ghost" data-act="ym" data-ym="' + next + '">›</button></div>';
  if (!partners.length) h += '<div class="empty"><b>아직 파트너가 없습니다</b>＋ 파트너로 학원을 등록하고 링크를 발급해 보내세요.</div>';
  h += partners.map((p, i) => {
    const s = stats[i], t = all[i];
    return '<div class="card' + (p.status !== 'active' ? ' dim' : '') + '"><div class="between wraprow"><div><div class="card-title">' + esc(p.name) + ' <span class="muted small">' + esc([p.kind, p.area].filter(Boolean).join(' · ')) + '</span>' + (p.status !== 'active' ? ' <span class="pill warn">일시 중지</span>' : '') + '</div>' +
      '<div class="card-sub">' + (p.contactName ? esc(p.contactName) + ' ' : '') + (p.phone ? (ui.phoneShown['p' + p.id] ? '<a class="tel" href="tel:' + esc(p.phone.replace(/-/g, '')) + '">' + esc(p.phone) + '</a>' : '<button class="btn btn-sm btn-ghost" data-act="show-phone" data-id="p' + esc(p.id) + '">' + esc(C.maskPhone(p.phone)) + '</button>') : '') + '</div></div>' +
      '<div class="row wraprow"><button class="btn btn-sm btn-primary" data-act="partner-link" data-id="' + esc(p.id) + '"' + (p.status !== 'active' ? ' disabled' : '') + '>링크 발급</button><button class="btn btn-sm btn-ghost" data-act="partner-edit" data-id="' + esc(p.id) + '">수정</button>' +
      '<button class="btn btn-sm btn-ghost" data-act="partner-toggle" data-id="' + esc(p.id) + '">' + (p.status === 'active' ? '중지' : '재개') + '</button><button class="btn btn-sm btn-danger" data-act="partner-revoke" data-id="' + esc(p.id) + '">기기 해제</button></div></div>' +
      '<div class="tiles mt14" style="margin-bottom:8px"><div class="tile"><div class="n">' + s.inbound + '<small>/ 누적 ' + t.inbound + '</small></div><div class="l">보내 준 가정</div></div><div class="tile"><div class="n">' + s.inboundTested + '</div><div class="l">검사 완료</div></div><div class="tile good"><div class="n">' + s.inboundWon + '</div><div class="l">등록</div></div>' +
      '<div class="tile"><div class="n">' + s.outbound + '<small>/ 등록 ' + s.outboundEnrolled + '</small></div><div class="l">우리가 소개</div></div></div>' +
      (p.terms && (p.terms.inbound || p.terms.outbound) ? '<div class="hint">혜택 — 보내 준 가정: ' + esc(p.terms.inbound || '—') + ' · 소개받은 가정: ' + esc(p.terms.outbound || '—') + '</div>' : '') +
      '<div class="row wraprow mt8"><button class="btn btn-sm btn-ghost" data-act="partner-statement" data-id="' + esc(p.id) + '">정산 문구 복사</button>' + (p.link ? '<a class="btn btn-sm btn-ghost" href="' + esc(p.link) + '" target="_blank" rel="noopener noreferrer">자료 링크</a>' : '') + '</div></div>';
  }).join('');
  return h;
}
function openPartnerForm(id) {
  const p = id ? partnerById(id) : null;
  if (id && !p) return;
  const P = p || { terms: {} };
  modal(p ? '파트너 수정' : '파트너 등록',
    '<div class="grid2"><div class="field"><label class="fl" for="f-pname">학원 이름 *</label><input class="in" id="f-pname" value="' + esc(P.name || '') + '" maxlength="40"></div><div class="field"><label class="fl" for="f-pkind">종류</label><input class="in" id="f-pkind" value="' + esc(P.kind || '') + '" placeholder="수학 / 영어 / 예체능" maxlength="20"></div></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="f-parea">지역</label><input class="in" id="f-parea" value="' + esc(P.area || '') + '" maxlength="40"></div><div class="field"><label class="fl" for="f-pcontact">담당자</label><input class="in" id="f-pcontact" value="' + esc(P.contactName || '') + '" maxlength="40"></div></div>' +
    '<div class="field"><label class="fl" for="f-pphone">담당자 전화</label><input class="in" id="f-pphone" inputmode="tel" value="' + esc(P.phone || '') + '"></div>' +
    '<div class="field"><label class="fl" for="f-pin">보내 준 가정에 주는 혜택(센터 →)</label><input class="in" id="f-pin" value="' + esc(P.terms && P.terms.inbound || '') + '" placeholder="검사비 20% 할인" maxlength="200"></div>' +
    '<div class="field"><label class="fl" for="f-pout">소개받은 가정에 주는 혜택(파트너 →)</label><input class="in" id="f-pout" value="' + esc(P.terms && P.terms.outbound || '') + '" placeholder="첫 달 수강료 10% 할인" maxlength="200"></div>' +
    '<div class="field"><label class="fl" for="f-plink">자료 링크(https)</label><input class="in" id="f-plink" value="' + esc(P.link || '') + '" placeholder="https://"></div>' +
    '<div class="field"><label class="fl" for="f-pmemo">메모</label><textarea class="in" id="f-pmemo" rows="2">' + esc(P.memo || '') + '</textarea><div class="hint">전화번호는 전화 칸에만.</div></div>',
    '<button class="btn btn-primary btn-block mt8" data-act="partner-save" data-id="' + esc(id || '') + '">' + (p ? '저장' : '등록') + '</button>');
}
function savePartnerForm(id) {
  const prev = id ? partnerById(id) : null;
  const data = Object.assign({}, prev || { status: 'active', createdAt: today() }, { name: val('f-pname'), kind: val('f-pkind'), area: val('f-parea'), contactName: val('f-pcontact'), phone: val('f-pphone'),
    terms: { inbound: val('f-pin'), outbound: val('f-pout'), note: prev && prev.terms ? prev.terms.note || '' : '' }, link: val('f-plink'), memo: val('f-pmemo') });
  const v = C.validatePartner(data, { today: today() });
  if (!v.ok) return toast(v.error);
  const pii = C.findPii(v.data);
  if (pii) return toast(pii + ' 에 전화번호·이메일이 있습니다 — 담당자 전화는 전화 칸에만');
  queueChange('partners', id || uid('pt'), v.data);
  closeModal(); toast(prev ? '저장했습니다' : '등록했습니다 — 링크를 발급해 파트너에게 보내세요'); render();
}
async function partnerLink(id) {
  const p = partnerById(id); if (!p) return;
  try {
    const r = await api('/api/partners', { op: 'link', partnerId: id });
    const dir = location.pathname.replace(/index\.html$/, '');
    const link = C.inviteLink(location.origin, dir + 'partner/', r.code);
    modal(p.name + ' 포털 링크', '<div class="hint mb8">파트너 학원 원장(담당자)에게 1:1 로 보내세요. 7일 안에 한 번 열면 그 기기에 연결됩니다. 가정 정보는 포털에 보이지 않습니다.</div><textarea class="in" rows="3" readonly id="f-link">' + esc(link) + '</textarea>',
      '<button class="btn btn-primary btn-block mt8" data-act="copy-link">링크 복사</button>');
  } catch (e) { toast('발급 실패 — ' + e.message); }
}
function openReferForm(id) {
  const l = leadById(id); if (!l) return;
  modal('파트너에 소개', '<div class="hint mb8">' + esc(C.leadLabel(l)) + ' → 파트너 포털에는 아이 이름·학년·보낸 날·사유만 보입니다. 전화번호는 가지 않습니다.</div>' +
    '<div class="field"><label class="fl" for="f-rpartner">파트너 학원</label><select class="in" id="f-rpartner">' + activePartners().map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.kind ? ' · ' + esc(p.kind) : '') + '</option>').join('') + '</select></div>' +
    '<div class="field"><label class="fl" for="f-rnote">소개 사유(한 줄)</label><input class="in" id="f-rnote" maxlength="300" placeholder="작업기억 보강이 필요해 수학 연산 수업 권함"></div>' +
    '<label class="check"><input type="checkbox" id="f-rconsent"> 가정의 동의를 받았습니다(필수)</label>',
    '<button class="btn btn-primary btn-block mt8" data-act="refer-save" data-id="' + esc(id) + '">소개 보내기</button>');
}
function saveReferForm(id) {
  const partnerId = val('f-rpartner');
  if (!partnerId) return toast('파트너를 골라 주세요');
  if (!checked('f-rconsent')) return toast('가정의 동의 확인을 체크해 주세요');
  const v = C.validateReferral({ leadId: id, partnerId, note: val('f-rnote'), consent: true, at: today(), by: session.staffId }, { today: today() });
  if (!v.ok) return toast(v.error);
  if (C.findPii({ note: v.data.note })) return toast('소개 사유에 전화번호·이메일을 적을 수 없습니다');
  queueChange('referrals', uid('rf'), v.data);
  const p = partnerById(partnerId);
  addActivity(id, { type: 'note', text: '파트너 소개 → ' + (p ? p.name : '') + (v.data.note ? ' · ' + v.data.note : '') });
  closeModal(); toast('소개를 보냈습니다 — 파트너 포털에 표시됩니다'); render();
}
function setReferralStatus(rid, status) {
  const r = state.referrals.find(x => x.id === rid); if (!r) return;
  const v = C.validateReferral(Object.assign({}, r, { status, statusAt: today() }), { today: today() });
  if (!v.ok) return toast(v.error);
  queueChange('referrals', rid, v.data); toast('상태를 바꿨습니다');
}

/* ── 화면: 관리(원장) ──────────────────────────────── */
function viewAdmin() {
  const st = state.staff.slice().sort((a, b) => (b.active === false ? 0 : 1) - (a.active === false ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
  const s = settings();
  let h = '<h1 class="page">관리</h1>';
  h += '<div class="card"><div class="between"><div class="card-title">직원</div><button class="btn btn-sm btn-primary" data-act="staff-new">＋ 직원</button></div><div class="card-sub mb8">직원은 개인 링크로 연결합니다(7일 안에 한 번). 리드 등록·기록은 할 수 있고 삭제·설정·HubSpot 승인은 원장만.</div>';
  h += st.length ? st.map(x => '<div class="fu' + (x.active === false ? ' done' : '') + '"><div class="grow"><b>' + esc(x.name) + '</b>' + (x.active === false ? ' <span class="tag">비활성</span>' : '') + '</div>' +
    (x.active !== false ? '<button class="btn btn-sm btn-primary" data-act="staff-link" data-id="' + esc(x.id) + '">링크 발급</button>' : '') +
    '<button class="btn btn-sm btn-ghost" data-act="staff-rename" data-id="' + esc(x.id) + '">이름</button>' +
    '<button class="btn btn-sm btn-ghost" data-act="staff-toggle" data-id="' + esc(x.id) + '" data-on="' + (x.active === false ? '1' : '0') + '">' + (x.active === false ? '활성화' : '비활성') + '</button>' +
    '<button class="btn btn-sm btn-danger" data-act="staff-revoke" data-id="' + esc(x.id) + '">기기 해제</button></div>').join('') : '<div class="hint">등록된 직원이 없습니다.</div>';
  h += '</div>';
  h += '<div class="card"><div class="card-title">설정</div>' +
    '<div class="field mt8"><label class="fl" for="f-org">조직 이름(앱바에 표시)</label><input class="in" id="f-org" value="' + esc(s.orgName || '') + '" maxlength="40"></div>' +
    '<div class="field"><label class="fl" for="f-offsets">팔로업 간격(일, 쉼표) — 기본 3, 7, 14</label><input class="in" id="f-offsets" value="' + esc((s.followupOffsets || C.FOLLOWUP_OFFSETS).join(', ')) + '"></div>' +
    '<button class="btn btn-ghost" data-act="settings-save">저장</button></div>';
  h += '<div class="card"><div class="card-title">계정·백업</div><div class="row wraprow mt8"><button class="btn btn-ghost" data-act="pw-form">비밀번호 변경</button><button class="btn btn-ghost" data-act="export">전체 백업(JSON)</button></div>' +
    '<div class="hint mt8">백업에는 리드·기록·크레딧·설정·직원·HubSpot 큐가 들어갑니다(토큰 없음). 보관은 원장 드라이브에.</div></div>';
  return h;
}
async function staffOp(body, okMsg) {
  try { const r = await api('/api/staff', body); if (okMsg) toast(okMsg); await loadAll(); render(); return r; }
  catch (e) { toast('실패 — ' + e.message); return null; }
}
function showLink(code, name) {
  const link = C.inviteLink(location.origin, location.pathname, code);
  modal(name + ' 개인 링크', '<div class="hint mb8">이 링크를 1:1 로 보내세요. 7일 안에 한 번 열면 그 기기에 연결됩니다. 다른 사람에게는 보내지 마세요.</div><textarea class="in" rows="3" readonly id="f-link">' + esc(link) + '</textarea>',
    '<button class="btn btn-primary btn-block mt8" data-act="copy-link">링크 복사</button>');
}
async function doExport() {
  try {
    const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + getToken() }, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'wb-crm-export-' + today() + '.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) { toast('백업 실패 — ' + e.message); }
}

/* ── 리드 폼 ───────────────────────────────────────── */
function leadFormHtml(l) {
  const L = l || { relation: '모', channel: '기타', child: {}, inspection: {}, interests: [] };
  const isNew = !l;
  const refOptions = state.leads.filter(x => !l || x.id !== l.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return '<div class="grid2"><div class="field"><label class="fl" for="f-name">보호자 이름 *</label><input class="in" id="f-name" value="' + esc(L.name || '') + '" maxlength="40"></div>' +
    '<div class="field"><label class="fl" for="f-rel">관계</label><select class="in" id="f-rel">' + opt(C.RELATIONS, L.relation, r => r + ' (' + C.RELATION_HONORIFIC[r] + ')') + '</select></div></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="f-phone">전화</label><input class="in" id="f-phone" inputmode="tel" value="' + esc(L.phone || '') + '" placeholder="010-0000-0000"></div>' +
    '<div class="field"><label class="fl" for="f-email">이메일</label><input class="in" id="f-email" inputmode="email" value="' + esc(L.email || '') + '"></div></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="f-child">아이 이름</label><input class="in" id="f-child" value="' + esc(L.child && L.child.name || '') + '" maxlength="40"></div>' +
    '<div class="field"><label class="fl" for="f-birth">생년월일</label><input class="in" id="f-birth" type="date" value="' + esc(L.child && L.child.birth || '') + '"></div></div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="f-grade">학년</label><input class="in" id="f-grade" value="' + esc(L.child && L.child.grade || '') + '" placeholder="초3 / 중1"></div>' +
    '<div class="field"><label class="fl" for="f-school">학교</label><input class="in" id="f-school" value="' + esc(L.child && L.child.school || '') + '"></div></div>' +
    (isNew ? '<div class="field"><label class="fl" for="f-source">문의 원문(카톡·전화 메모를 그대로)</label><textarea class="in" id="f-source" rows="3" placeholder="예: 판교맘카페에서 보고 연락드려요. 초3 아이 웩슬러 검사 내일 가능한가요?"></textarea><div class="hint" id="f-detect"></div></div>' : '') +
    '<div class="grid2"><div class="field"><label class="fl" for="f-channel2">유입 채널</label><select class="in" id="f-channel2">' + opt(C.CHANNELS, L.channel) + '</select></div>' +
    '<div class="field"><label class="fl" for="f-chnote">채널 메모</label><input class="in" id="f-chnote" value="' + esc(L.channelNote || '') + '" placeholder="어느 카페 / 누구 소개" maxlength="120"></div></div>' +
    '<div class="field" id="f-partner-wrap"' + (L.channel === '파트너' ? '' : ' hidden') + '><label class="fl" for="f-partner">파트너 학원(채널이 파트너일 때)</label><select class="in" id="f-partner"><option value="">— 선택 —</option>' + activePartners().map(p => '<option value="' + esc(p.id) + '"' + (L.partnerId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label class="fl" for="f-ref">소개자(기존 리드)</label><select class="in" id="f-ref"><option value="">— 없음 —</option>' + refOptions.map(x => '<option value="' + esc(x.id) + '"' + (L.referrerLeadId === x.id ? ' selected' : '') + '>' + esc(C.leadLabel(x)) + '</option>').join('') + '</select></div>' +
    '<div class="field"><div class="fl">관심</div><div class="chips">' + C.INTERESTS.map(i => '<label class="chip"><input type="checkbox" class="f-interest" value="' + i + '"' + ((L.interests || []).includes(i) ? ' checked' : '') + ' style="width:16px;height:16px"> ' + i + '</label>').join('') + '</div></div>' +
    (!isNew ? '<div class="grid2"><div class="field"><label class="fl" for="f-itype">검사 종류</label><select class="in" id="f-itype"><option value="">—</option>' + opt(C.INSPECTION_TYPES, L.inspection && L.inspection.type) + '</select></div>' +
      '<div class="field"><label class="fl" for="f-idate">검사일</label><input class="in" id="f-idate" type="date" value="' + esc(L.inspection && L.inspection.date || '') + '"></div></div>' +
      '<div class="grid2"><div class="field"><label class="fl" for="f-consulted">상담 완료일(팔로업 기준)</label><input class="in" id="f-consulted" type="date" value="' + esc(L.consultedAt || '') + '"></div>' +
      '<div class="field"><label class="fl" for="f-strength">검사에서 돋보인 강점</label><input class="in" id="f-strength" value="' + esc(L.strength || '') + '" maxlength="120" placeholder="처리속도 상위 20%"></div></div>' +
      '<div class="field"><label class="fl" for="f-acad">학원 상태(HubSpot wb_academy_status)</label><select class="in" id="f-acad"><option value="">—</option>' + opt(['미등록', '트라이얼', '재원', '이탈', '퇴원'], L.academyStatus) + '</select></div>' : '') +
    (session.canApprove ? '<div class="field"><label class="fl" for="f-owner2">담당</label><select class="in" id="f-owner2"><option value="admin"' + (!L.owner || L.owner === 'admin' ? ' selected' : '') + '>원장</option>' + liveStaff().map(x => '<option value="' + esc(x.id) + '"' + (L.owner === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></div>' : '') +
    '<label class="check"><input type="checkbox" id="f-hot"' + (L.hot ? ' checked' : '') + '> 핫 리드(바로 연락)</label>' +
    '<div class="field"><label class="fl" for="f-memo">메모</label><textarea class="in" id="f-memo" rows="2">' + esc(L.memo || '') + '</textarea><div class="hint">전화번호는 전화 칸에만 — 문의 원문·메모·기록에 번호가 있으면 저장되지 않습니다.</div></div>';
}
function openLeadForm(id) {
  const l = id ? leadById(id) : null;
  if (id && !l) return;
  modal(l ? '리드 수정' : '새 문의', leadFormHtml(l), '<button class="btn btn-primary btn-block mt8" data-act="lead-save" data-id="' + esc(id || '') + '">' + (l ? '저장' : '등록') + '</button>');
  if (!l) { const src = $('#f-source'); if (src) src.addEventListener('input', onSourceInput); }
}
function onSourceInput() {
  const text = val('f-source');
  const ch = C.detectChannel(text), hot = C.detectHot(text);
  const sel = $('#f-channel2'), hotBox = $('#f-hot'), hint = $('#f-detect');
  if (sel && !sel.dataset.touched && ch.channel) { sel.value = ch.channel; togglePartnerField(); }
  if (hotBox && !hotBox.dataset.touched) hotBox.checked = hot.hot;
  if (hint) hint.innerHTML = text ? '감지: 채널 <b>' + esc(ch.channel) + '</b>' + (ch.confidence === 'low' ? ' (단서 부족)' : ch.hits.length ? ' (' + esc(ch.hits.map(x => x.keyword).join(', ')) + ')' : '') + ' · HOT ' + (hot.confidence === 'high' ? '<b style="color:var(--hot)">예</b>' : hot.confidence === 'medium' ? '애매(' + esc(hot.hits.map(x => x.keyword).join(', ')) + ')' : '아니오') : '';
}
function togglePartnerField() { const w = $('#f-partner-wrap'); if (w) w.hidden = val('f-channel2') !== '파트너'; }
function saveLeadForm(id) {
  const prev = id ? leadById(id) : null;
  const base = prev ? JSON.parse(JSON.stringify(prev)) : { pipeline: 'inspection', stage: 'inquiry', status: 'open', followups: [], createdAt: today(), stageAt: today() };
  const data = Object.assign(base, {
    name: val('f-name'), relation: val('f-rel'), phone: val('f-phone'), email: val('f-email'),
    child: { name: val('f-child'), birth: val('f-birth'), grade: val('f-grade'), school: val('f-school') },
    channel: val('f-channel2'), channelNote: val('f-chnote'), referrerLeadId: val('f-ref'), partnerId: val('f-partner'),
    interests: Array.from(document.querySelectorAll('.f-interest:checked')).map(x => x.value), hot: checked('f-hot'), memo: val('f-memo')
  });
  if (session.canApprove) data.owner = val('f-owner2') || 'admin';
  if (!prev) data.source = val('f-source');
  else {
    data.inspection = { type: val('f-itype'), date: val('f-idate') };
    data.consultedAt = val('f-consulted'); data.strength = val('f-strength'); data.academyStatus = val('f-acad');
    data.retestDue = C.retestDue(data.inspection.date, data.inspection.type);
    if (data.consultedAt && !(Array.isArray(data.followups) && data.followups.length)) data.followups = C.scheduleFollowups(data.consultedAt, settings().followupOffsets);
  }
  const v = C.validateLead(data, { today: today() });
  if (!v.ok) return toast(v.error);
  // 서버가 거절할 저장은 여기서 막는다 — 저장이 뒤늦게 거절되면 리드가 사라진 것처럼 보인다
  const pii = C.findPii(v.data, '', ['phone', 'email', 'hubspot', 'creditBalanceHs']);
  if (pii) return toast((pii === 'source' ? '문의 원문' : pii === 'memo' ? '메모' : pii) + '에 전화번호·이메일이 있습니다 — 전화는 전화 칸에만 적고 본문에서는 지워 주세요');
  const out = Object.assign(v.data, { hubspot: prev ? prev.hubspot : {} });
  const newId = id || uid('ld');
  queueChange('leads', newId, out);
  if (!prev && out.source) addActivity(newId, { type: 'note', text: '문의 원문\n' + out.source, at: today() });
  closeModal();
  toast(prev ? '저장했습니다' : '등록했습니다' + (out.hot ? ' — 핫 리드' : ''));
  if (!prev) go('lead', newId); else render();
}
function addActivity(leadIdValue, fields) {
  const v = C.validateActivity(Object.assign({ leadId: leadIdValue, at: today(), ts: now(), by: session.staffId }, fields), { today: today() });
  if (!v.ok) { toast(v.error); return null; }
  if (C.findPii({ text: v.data.text })) { toast('기록에 전화번호·이메일을 적을 수 없습니다 — 전화는 리드의 전화 칸에만'); return null; }
  const id = uid('ac');
  queueChange('activities', id, v.data);
  return id;
}
function updateLead(id, patch, note) {
  const l = leadById(id); if (!l) return null;
  const next = Object.assign(JSON.parse(JSON.stringify(l)), patch);
  const v = C.validateLead(next, { today: today() });
  if (!v.ok) { toast(v.error); return null; }
  const out = Object.assign(v.data, { hubspot: l.hubspot || {} });
  queueChange('leads', id, out);
  if (note) toast(note);
  return out;
}
function moveStage(id, target, selectEl) {
  const l = leadById(id); if (!l) return;
  const reset = () => { if (selectEl) selectEl.value = l.stage; };   // 창을 닫거나 실패하면 select 가 실제 단계를 보여 줘야 같은 항목을 다시 고를 수 있다
  if (target === '__academy') { reset(); return openOutcome(id, 'won', true); }
  if (target === l.stage) return;
  if (target === 'won') { reset(); return openOutcome(id, 'won'); }
  if (target === 'lost' || target === 'churned') { reset(); return openOutcome(id, 'lost', false, target); }
  const from = l.stage;
  const patch = { stage: target, stageAt: today(), status: 'open', outcome: null };
  if (updateLead(id, patch)) { addActivity(id, { type: 'stage', from, to: target }); render(); } else reset();
}
function openOutcome(id, kind, toAcademy, lostStage) {
  const l = leadById(id); if (!l) return;
  const title = kind === 'won' ? '등록 확정' : kind === 'lost' ? '이탈 확정' : '장기보류';
  let body = '<div class="hint mb8">' + esc(C.leadLabel(l)) + ' · ' + esc(C.PIPELINE_LABEL[l.pipeline]) + ' / ' + esc(C.STAGE_LABEL[l.stage]) + '</div>';
  if (kind === 'won' && l.pipeline === 'inspection') body += '<label class="check"><input type="checkbox" id="f-to-academy"' + (toAcademy ? ' checked' : '') + '> 학원 등록 파이프라인으로 이어가기(트라이얼) — HubSpot 에는 검사 여정 딜 성사 + 학원 등록 딜이 생깁니다</label>';
  if (kind === 'lost') body += '<div class="fl">이탈 사유</div><div class="chips mb8">' + C.LOST_REASONS.map(r => '<label class="chip"><input type="radio" name="f-reason" value="' + r + '"' + (r === 'U' ? ' checked' : '') + ' style="width:14px;height:14px"> ' + r + ' ' + esc(C.LOST_REASON_LABEL[r]) + '</label>').join('') + '</div>';
  body += '<div class="field"><label class="fl" for="f-onote">한 줄 메모</label><input class="in" id="f-onote" maxlength="300" placeholder="' + (kind === 'lost' ? '왜 안 왔는지 — 분기 집계에 쓰입니다' : kind === 'won' ? '등록 과목·시작일 등' : '언제 다시 연락할지') + '"></div>';
  modal(title, body, '<button class="btn btn-block mt8 ' + (kind === 'won' ? 'btn-good' : kind === 'lost' ? 'btn-danger' : 'btn-warn') + '" data-act="outcome-save" data-id="' + esc(id) + '" data-kind="' + kind + '" data-lost="' + esc(lostStage || '') + '">' + title + '</button>');
}
function saveOutcome(id, kind, lostStage) {
  const l = leadById(id); if (!l) return;
  const note = val('f-onote');
  const from = l.stage;
  const fus = (l.followups || []).map(f => (f.status === 'pending' ? Object.assign({}, f, { status: 'skipped', note: f.note || title(kind) }) : f));
  let patch;
  if (kind === 'won') {
    const toAcademy = checked('f-to-academy');
    patch = toAcademy ? { pipeline: 'academy', stage: 'trial', stageAt: today(), status: 'open', outcome: null, followups: fus, academyStatus: l.academyStatus || '트라이얼' }
      : { stage: 'won', stageAt: today(), status: 'won', outcome: { status: 'won', at: today(), note }, followups: fus };
  } else if (kind === 'lost') {
    const reasonEl = document.querySelector('input[name="f-reason"]:checked');
    const stage = lostStage && C.stagesOf(l.pipeline).includes(lostStage) ? lostStage : 'lost';
    patch = { stage, stageAt: today(), status: 'lost', outcome: { status: 'lost', at: today(), reason: reasonEl ? reasonEl.value : 'U', note }, followups: fus };
  } else {
    patch = { status: 'hold', outcome: { status: 'hold', at: today(), note } };
  }
  if (!updateLead(id, patch)) return;
  if (kind !== 'hold') addActivity(id, { type: 'stage', from, to: patch.stage, text: (kind === 'won' && patch.pipeline === 'academy' ? '등록 → 학원 등록(트라이얼)' : title(kind)) + (note ? ' · ' + note : '') });
  else addActivity(id, { type: 'note', text: '장기보류' + (note ? ' · ' + note : '') });
  closeModal(); toast(title(kind) + ' 처리했습니다'); render();
  function title(k) { return k === 'won' ? '등록 확정' : k === 'lost' ? '이탈 확정' : '장기보류'; }
}
function unhold(id) {
  const l = leadById(id); if (!l) return;
  if (updateLead(id, { status: 'open', outcome: null })) { addActivity(id, { type: 'note', text: '보류 해제' }); render(); }
}

/* ── 기록 폼 ───────────────────────────────────────── */
function openActivityForm(id, preset) {
  const l = leadById(id); if (!l) return;
  const p = preset || {};
  const type = p.type || 'consult';
  const hasPending = (l.followups || []).some(f => f.status === 'pending');
  const stageIdx = C.stagesOf('inspection').indexOf(l.stage);
  modal(p.followupDay ? 'D+' + p.followupDay + ' ' + (C.FOLLOWUP_LABEL[p.followupDay] || '') + ' 기록' : '기록 남기기',
    '<div class="hint mb8">' + esc(C.leadLabel(l)) + '</div>' +
    '<div class="grid2"><div class="field"><label class="fl" for="f-atype">종류</label><select class="in" id="f-atype">' + opt(['consult', 'cs', 'call', 'msg', 'visit', 'note'], type, k => C.ACTIVITY_LABEL[k]) + '</select></div>' +
    '<div class="field"><label class="fl" for="f-aresult">결과</label><select class="in" id="f-aresult"><option value="">—</option>' + opt(['reached', 'replied', 'no_answer'], p.result || '', k => C.RESULT_LABEL[k]) + '</select></div></div>' +
    '<div class="field"><label class="fl" for="f-adate">날짜</label><input class="in" id="f-adate" type="date" value="' + esc(today()) + '"></div>' +
    '<div class="field"><label class="fl" for="f-atext">내용</label><textarea class="in" id="f-atext" rows="4" placeholder="' + (p.followupDay ? '보낸 문자·통화 요약, 반응' : '상담 요지 · 학부모 반응 · 다음 할 일') + '"></textarea></div>' +
    '<div id="f-consult-extra">' +
    (!l.inspection || !l.inspection.date ? '<div class="grid2"><div class="field"><label class="fl" for="f-itype2">검사 종류</label><select class="in" id="f-itype2"><option value="">—</option>' + opt(C.INSPECTION_TYPES, '') + '</select></div><div class="field"><label class="fl" for="f-idate2">검사일</label><input class="in" id="f-idate2" type="date"></div></div>' : '') +
    '<div class="field"><label class="fl" for="f-strength2">검사에서 돋보인 강점(팔로업 문자에 들어감)</label><input class="in" id="f-strength2" value="' + esc(l.strength || '') + '" maxlength="120"></div>' +
    '<label class="check"><input type="checkbox" id="f-startfu"' + (!hasPending && !p.followupDay ? ' checked' : '') + '> 이 날을 기준으로 팔로업 일정 시작 (D+' + (settings().followupOffsets || C.FOLLOWUP_OFFSETS).join(' · D+') + ')' + (hasPending ? ' — 기존 일정은 대체됩니다' : '') + '</label>' +
    (l.pipeline === 'inspection' && stageIdx >= 0 && stageIdx < C.stagesOf('inspection').indexOf('interpreted') ? '<label class="check"><input type="checkbox" id="f-tointerp" checked> 단계를 해석완료로 옮기기</label>' : '') + '</div>' +
    (p.followupDay ? '<input type="hidden" id="f-fuday" value="' + p.followupDay + '">' : ''),
    '<button class="btn btn-primary btn-block mt8" data-act="activity-save" data-id="' + esc(id) + '">저장</button>');
  const sel = $('#f-atype');
  const toggle = () => { const ex = $('#f-consult-extra'); if (ex) ex.style.display = C.ANCHOR_TYPES.includes(sel.value) ? '' : 'none'; };
  sel.addEventListener('change', toggle); toggle();
}
function saveActivityForm(id) {
  const l = leadById(id); if (!l) return;
  const type = val('f-atype'), result = val('f-aresult'), at = val('f-adate') || today(), text = val('f-atext');
  const fuDay = Number(val('f-fuday')) || 0;
  if (fuDay && !result) return toast('팔로업 결과(연락됨·답장·부재중)를 골라 주세요');
  if (C.findPii({ text, strength: val('f-strength2') })) return toast('기록·강점에 전화번호·이메일을 적을 수 없습니다 — 전화는 리드의 전화 칸에만');
  const actId = addActivity(id, { type: fuDay ? 'followup' : type, result, text, at, followupDay: fuDay });
  if (!actId) return;
  const patch = {};
  if (fuDay) patch.followups = C.markFollowup(l.followups, fuDay, { status: 'done', doneAt: at, result, note: text.slice(0, 80) });
  if (C.ANCHOR_TYPES.includes(type)) {
    const strength = val('f-strength2'); if (strength) patch.strength = strength;
    const itype = val('f-itype2'), idate = val('f-idate2');
    if (itype || idate) { patch.inspection = { type: itype || (l.inspection && l.inspection.type) || '', date: idate || (l.inspection && l.inspection.date) || '' }; patch.retestDue = C.retestDue(patch.inspection.date, patch.inspection.type); }
    if (checked('f-startfu')) { patch.consultedAt = at; patch.followups = C.scheduleFollowups(at, settings().followupOffsets); }
    else if (!l.consultedAt) patch.consultedAt = at;
    if (checked('f-tointerp') && l.pipeline === 'inspection') { patch.stage = 'interpreted'; patch.stageAt = today(); addActivity(id, { type: 'stage', from: l.stage, to: 'interpreted', at }); }
  }
  if (Object.keys(patch).length) updateLead(id, patch);
  closeModal(); toast('기록했습니다' + (patch.followups && !fuDay ? ' — 팔로업 일정이 잡혔습니다' : '')); render();
}
function skipFollowup(id, day) {
  const l = leadById(id); if (!l) return;
  if (updateLead(id, { followups: C.markFollowup(l.followups, day, { status: 'skipped', doneAt: today() }) })) { addActivity(id, { type: 'followup', followupDay: day, result: 'none', text: 'D+' + day + ' 건너뜀' }); render(); }
}
function resetFollowups(id) {
  const l = leadById(id); if (!l) return;
  const anchor = prompt('기준일(상담·CS 종료일, YYYY-MM-DD)', l.consultedAt || today());
  if (!anchor) return;
  if (!C.validYmd(anchor)) return toast('날짜 형식이 올바르지 않습니다');
  if (updateLead(id, { consultedAt: anchor, followups: C.scheduleFollowups(anchor, settings().followupOffsets) }, '팔로업 일정을 잡았습니다')) render();
}

/* ── 크레딧 폼(원장) ───────────────────────────────── */
function openCreditForm(id, type) {
  const l = leadById(id); if (!l) return;
  const referred = state.leads.filter(x => x.referrerLeadId === id);
  const body = type === 'accrue'
    ? '<div class="field"><label class="fl" for="f-referred">피소개자(검사 완료한 리드)</label><select class="in" id="f-referred"><option value="">— 선택 —</option>' + referred.map(x => '<option value="' + esc(x.id) + '">' + esc(C.leadLabel(x)) + ' · ' + esc(C.STAGE_LABEL[x.stage]) + '</option>').join('') + '</select>' + (referred.length ? '' : '<div class="hint">이 리드를 소개자로 둔 리드가 없습니다 — 피소개자 리드의 "소개자" 칸을 먼저 채워 주세요.</div>') + '</div>' +
      '<div class="field"><label class="fl" for="f-amount">금액</label><input class="in" id="f-amount" type="number" value="' + C.CREDIT_AMOUNT + '" step="1000"></div>'
    : '<div class="field"><label class="fl" for="f-amount">사용 금액(잔액 ' + esc(fmtWon(C.creditBalance(state.credits, id))) + ')</label><input class="in" id="f-amount" type="number" value="' + Math.min(C.CREDIT_AMOUNT, C.creditBalance(state.credits, id)) + '" step="1000"></div>';
  modal(type === 'accrue' ? '크레딧 적립' : '크레딧 사용', body + '<div class="field"><label class="fl" for="f-cnote">메모</label><input class="in" id="f-cnote" maxlength="200" placeholder="' + (type === 'accrue' ? '피소개자 검사 완료' : '학원 수강료 차감') + '"></div>',
    '<button class="btn btn-primary btn-block mt8" data-act="credit-save" data-id="' + esc(id) + '" data-type="' + type + '">기록</button>');
}
function saveCredit(id, type) {
  const amount = Math.abs(Number(val('f-amount')) || 0);
  if (!amount) return toast('금액을 입력해 주세요');
  const referred = type === 'accrue' ? val('f-referred') : '';
  if (type === 'accrue') {
    if (!referred) return toast('피소개자를 골라 주세요');
    const el = C.creditEligibility(state.credits, id, referred, today());
    if (!el.ok && !confirm(el.error + '\n그래도 적립할까요? (원장 판단)')) return;
  }
  if (type === 'use' && amount > C.creditBalance(state.credits, id) && !confirm('잔액보다 큽니다. 그래도 기록할까요?')) return;
  const v = C.validateCredit({ leadId: id, type, amount: type === 'accrue' ? amount : -amount, note: val('f-cnote'), at: today(), referredLeadId: referred, by: session.staffId }, { today: today() });
  if (!v.ok) return toast(v.error);
  if (C.findPii({ note: v.data.note })) return toast('메모에 전화번호·이메일을 적을 수 없습니다');
  queueChange('credits', uid('cr'), v.data);
  closeModal(); toast('크레딧을 기록했습니다 — HubSpot 잔액(wb_credit_balance)은 반영 큐로 갑니다'); render();
}

/* ── 이벤트 ───────────────────────────────────────── */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id || '';
  switch (act) {
    case 'login': return doLogin(el);
    case 'setup': return doSetup(el);
    case 'logout': return doLogout();
    case 'closemodal': return closeModal();
    case 'reload': return location.reload();
    case 'retry-sync': syncErr = ''; return flush();
    case 'go': return go(el.dataset.r);
    case 'back': return history.length > 1 ? history.back() : go('leads');
    case 'open-lead': e.stopPropagation(); return go('lead', id);
    case 'new-lead': return openLeadForm('');
    case 'edit-lead': return openLeadForm(id);
    case 'lead-save': return saveLeadForm(id);
    case 'delete-lead': if (confirm('이 리드와 연결된 화면 기록이 보이지 않게 됩니다(HubSpot 쪽은 그대로). 삭제할까요?')) { queueChange('leads', id, {}, true); go('leads'); } return;
    case 'show-phone': ui.phoneShown[id] = true; return render();
    case 'pipe': ui.pipe = el.dataset.p; return render();
    case 'status-filter': ui.status = el.dataset.s; return render();
    case 'ym': ui.ym = el.dataset.ym; return render();
    case 'new-activity': return openActivityForm(id);
    case 'activity-save': return saveActivityForm(id);
    case 'fu-draft': { const l = leadById(id); if (l) copyText(C.messageDraft(Number(el.dataset.day), l), 'D+' + el.dataset.day + ' 초안'); return; }
    case 'retest-draft': { const l = leadById(id); if (l) copyText(C.retestDraft(Number(el.dataset.w), l), '재검사 안내 초안'); return; }
    case 'fu-log': return openActivityForm(id, { type: 'msg', followupDay: Number(el.dataset.day) });
    case 'fu-skip': return skipFollowup(id, Number(el.dataset.day));
    case 'fu-reset': return resetFollowups(id);
    case 'outcome': return openOutcome(id, el.dataset.kind);
    case 'outcome-save': return saveOutcome(id, el.dataset.kind, el.dataset.lost);
    case 'unhold': return unhold(id);
    case 'credit-form': return openCreditForm(id, el.dataset.type);
    case 'credit-save': return saveCredit(id, el.dataset.type);
    case 'hs-refresh': ui.hs.props = null; return loadHubspotPanel(true);
    case 'hs-pipelines': return hsAction('pipelines');
    case 'hs-props-create': return hsAction('props');
    case 'hs-pull': return hsAction('pull', !!el.dataset.full);
    case 'hs-push': return hsAction('push');
    case 'hs-approve-all': return hsAction('queue', { op: 'approveAll' });
    case 'hs-q': return hsAction('queue', { op: el.dataset.op, ids: [id] });
    case 'hs-filter': ui.hs.filter = el.dataset.f; return render();
    case 'hs-map-save': return saveMapping();
    case 'partner-new': return openPartnerForm('');
    case 'partner-edit': return openPartnerForm(id);
    case 'partner-save': return savePartnerForm(id);
    case 'partner-link': return partnerLink(id);
    case 'partner-toggle': { const p = partnerById(id); if (!p) return; const next = p.status === 'active' ? 'paused' : 'active'; if (next === 'paused' && !confirm('일시 중지하면 파트너 포털이 바로 막힙니다. 계속할까요?')) return; queueChange('partners', id, Object.assign({}, p, { status: next })); toast(next === 'active' ? '연계를 재개했습니다' : '일시 중지했습니다'); return render(); }
    case 'partner-revoke': if (confirm('이 파트너의 모든 기기 연결을 해제할까요? 새 링크로 다시 연결해야 합니다.')) { try { await api('/api/partners', { op: 'revoke', partnerId: id }); toast('기기 연결을 해제했습니다'); } catch (err) { toast('실패 — ' + err.message); } } return;
    case 'partner-statement': { const p = partnerById(id); if (!p) return; const st = C.partnerStats(state.leads, state.referrals, [p], ui.ym)[0]; copyText(C.partnerStatement(st, ui.ym, p.terms), '정산 문구'); return; }
    case 'refer-form': return openReferForm(id);
    case 'refer-save': return saveReferForm(id);
    case 'staff-new': { const name = prompt('직원 이름'); if (name) await staffOp({ op: 'create', name }, '등록했습니다 — 링크를 발급해 보내세요'); return; }
    case 'staff-link': { const r = await staffOp({ op: 'link', staffId: id }); if (r) showLink(r.code, staffName(id)); return; }
    case 'staff-rename': { const name = prompt('새 이름', staffName(id)); if (name) await staffOp({ op: 'rename', staffId: id, name }, '이름을 바꿨습니다'); return; }
    case 'staff-toggle': return staffOp({ op: el.dataset.on === '1' ? 'activate' : 'deactivate', staffId: id }, '바꿨습니다');
    case 'staff-revoke': if (confirm('이 직원의 모든 기기 연결을 해제할까요? 새 링크로 다시 연결해야 합니다.')) await staffOp({ op: 'revoke', staffId: id }, '기기 연결을 해제했습니다'); return;
    case 'copy-link': return copyText(val('f-link'), '링크');
    case 'settings-save': {
      const offsets = val('f-offsets').split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
      queueChange('settings', 'main', Object.assign({}, settings(), { orgName: val('f-org'), followupOffsets: offsets.length ? offsets : C.FOLLOWUP_OFFSETS.slice() }));
      toast('저장했습니다'); return render();
    }
    case 'pw-form': return modal('비밀번호 변경',
      '<div class="field"><label class="fl" for="f-pw-cur">현재 비밀번호</label><input class="in" id="f-pw-cur" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label class="fl" for="f-pw-new">새 비밀번호 (8~72자)</label><input class="in" id="f-pw-new" type="password" autocomplete="new-password"></div>' +
      '<div class="field"><label class="fl" for="f-pw-new2">새 비밀번호 확인</label><input class="in" id="f-pw-new2" type="password" autocomplete="new-password" data-enter="pw-save"></div>',
      '<button class="btn btn-primary btn-block mt14" data-act="pw-save">변경</button>');
    case 'pw-save': {
      const cur = val('f-pw-cur'), next = val('f-pw-new'), next2 = val('f-pw-new2');
      if (!cur) return toast('현재 비밀번호를 입력하세요');
      if (next.length < 8 || next.length > 72) return toast('새 비밀번호는 8~72자');
      if (next !== next2) return toast('새 비밀번호 두 칸이 다릅니다');
      try { await api('/api/password', { password: cur, newPassword: next }); closeModal(); toast('비밀번호를 바꿨습니다 — 다른 원장 기기는 다시 로그인해야 합니다'); }
      catch (err) { toast(err.code === 'LOGIN_FAILED' ? '현재 비밀번호가 맞지 않습니다' : '변경 실패 — ' + err.message); }
      return;
    }
    case 'export': return doExport();
    default: return;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (!t || !t.id && !t.dataset.act) return;
  if (t.id === 'f-stage') return moveStage(t.dataset.id, t.value, t);
  if (t.id === 'f-channel') { ui.channel = t.value; return render(); }
  if (t.id === 'f-owner') { ui.owner = t.value; return render(); }
  if (t.id === 'f-channel2' || t.id === 'f-hot') { t.dataset.touched = '1'; if (t.id === 'f-channel2') togglePartnerField(); return; }
  if (t.dataset.rid) return setReferralStatus(t.dataset.rid, t.value);
  if (t.id === 'f-autoquick') return setAutoQuick(t.checked);
  if (t.dataset.act === 'hs-map-pipe') {
    const p = t.dataset.p; const pipe = (ui.hs.pipelines || []).find(x => x.id === t.value);
    const auto = pipe ? C.autoMapPipeline([pipe], p) : { pipelineId: '', pipelineLabel: '', stageMap: {} };
    ui.hs.map = Object.assign({}, ui.hs.map, { [p]: { pipelineId: pipe ? pipe.id : '', pipelineLabel: pipe ? pipe.label : '', stageMap: auto.stageMap } });
    return render();
  }
  if (t.dataset.act === 'hs-map-stage') {
    const p = t.dataset.p, s = t.dataset.s;
    const m = Object.assign({ stageMap: {} }, (ui.hs.map || {})[p]);
    m.stageMap = Object.assign({}, m.stageMap); if (t.value) m.stageMap[s] = t.value; else delete m.stageMap[s];
    ui.hs.map = Object.assign({}, ui.hs.map, { [p]: m });
  }
});
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'f-q') { ui.q = e.target.value; const card = e.target.closest('.card'); const list = card ? card.querySelectorAll('.lead') : []; void list; clearTimeout(render._q); render._q = setTimeout(() => { const pos = e.target.selectionStart; render(); const q = $('#f-q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (err) { /* iOS */ } } }, 160); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#modalHost').hidden) return closeModal();
  if (e.key !== 'Enter' || !e.target || !e.target.dataset || !e.target.dataset.enter) return;
  const btn = document.querySelector('[data-act="' + e.target.dataset.enter + '"]');
  if (btn) { e.preventDefault(); btn.click(); }
});
window.addEventListener('hashchange', onHash);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('beforeunload', e => { if (outbox.size()) { e.preventDefault(); e.returnValue = ''; } });

startApp();
