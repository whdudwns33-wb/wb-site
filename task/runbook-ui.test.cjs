const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* 이 테스트는 index.html을 읽지 않는다(계약 §0 — 자기 파일만 검사). 훅이 실제로 걸렸는지는 통합 담당의 테스트가 본다.
   1) 원문 정적 검사: 전역 노출·rb- 접두·공식 링크만·PII 필드 없음
   2) index.html 전역을 stub으로 넣고 그리는 스모크 검사 */

const src = fs.readFileSync(path.join(__dirname, 'runbook-ui.js'), 'utf8');
const core = require('./runbook-core.js');
const links = require('../shared/external-links.js');
const ui = require('./runbook-ui.js');

/* ── 정적 검사 ── */

test('exposes exactly one global (WBRunbookUI) through the house IIFE pattern', () => {
  assert.ok(/root\.WBRunbookUI = api/.test(src));
  assert.ok(/module\.exports = api/.test(src));
  assert.ok(src.trimStart().startsWith('/*') || src.trimStart().startsWith('(function'), 'no top-level statements before the IIFE');
  const topLevel = src.replace(/\/\*[\s\S]*?\*\//g, '').match(/^(?:const|let|var|function)\s+\w+/gm) || [];
  assert.deepEqual(topLevel, [], 'no top-level declarations leak into the page scope');
  ['todayBlocks', 'boardCard', 'stepExt', 'briefSection', 'ensureRequestsLoaded'].forEach(fn => {
    assert.equal(typeof ui[fn], 'function', fn);
  });
});

test('every data-act it renders or handles carries the rb- prefix', () => {
  const rendered = [...src.matchAll(/data-act="([^"]+)"/g)].map(m => m[1]).filter(a => !a.includes('+'));
  assert.ok(rendered.length >= 15, 'renders many actions, got ' + rendered.length);
  rendered.forEach(a => assert.ok(a.startsWith('rb-'), a));
  const handled = [...src.matchAll(/case '(rb-[a-z-]+)':/g)].map(m => m[1]);
  [...new Set(rendered)].forEach(a => {
    if (a === 'rb-pub-staff') return; // change 리스너가 처리한다
    assert.ok(handled.includes(a), 'no click handler for ' + a);
  });
  assert.ok(/closest\('\[data-act\^="rb-"\]'\)/.test(src), 'listener only looks at rb- actions');
  assert.ok(/document\.addEventListener\('click', onClick\)/.test(src));
  assert.ok(/typeof document !== 'undefined'/.test(src), 'listener registration is guarded for Node');
});

test('no hard-coded external URLs — links come from WBExternalLinks only', () => {
  const urls = src.match(/https?:\/\/[^\s'"]+/g) || [];
  assert.deepEqual(urls, [], 'found ' + urls.join(', '));
  assert.ok(/target="_blank" rel="noopener noreferrer"/.test(src));
  assert.ok(/isApprovedLink/.test(src), 'result urls are checked against the approved host list');
  assert.ok(!/<iframe/.test(src));
});

test('server calls go through sync.post(/ops-request) with app + auth, and failures stay hints', () => {
  assert.ok(/sync\.post\('\/ops-request'/.test(src));
  assert.ok(/app: appName\(\), auth: sync\.auth\(\)/.test(src));
  ['OPS_STALE', 'OPS_REQUEST_NOT_READY'].forEach(code => assert.ok(src.includes(code), code));
  assert.ok(/expectedUpdatedAt: r\.updatedAt/.test(src), 'CAS uses the cached updatedAt');
  assert.ok(/action: 'list'/.test(src) && /action: 'create'/.test(src), 'list and create actions');
  assert.ok(/런북 체크는 계속/.test(src), 'error hint explains that runbook checks still work');
});

test('no PII fields: the request form and cards never carry name, phone, password or file paths', () => {
  const ids = [...src.matchAll(/id="(rb-[a-z-]+)"/g)].map(m => m[1]);
  ids.forEach(id => assert.ok(!/(name|phone|tel|pass|pw|email|file|path)/.test(id), 'suspicious field ' + id));
  assert.ok(!/studentName|guardian|phone:|password|tel:/.test(src));
  assert.ok(/이름·전화 금지/.test(src), 'the form tells the user names and phones are forbidden');
  assert.ok(/maskIdentifiers/.test(src), 'director views mask SF codes');
  assert.ok(/validateRequest/.test(src) && /validateResult/.test(src), 'inputs go through core validation');
});

test('index.html globals are only touched inside functions (safe to load first and in Node)', () => {
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const iifeStart = body.indexOf("'use strict';");
  const firstFn = body.indexOf('function core()');
  const prelude = body.slice(iifeStart, firstFn);
  ['state', 'session', 'getCheck', 'tasksFor', 'sync', 'esc(', 'modal(', 'render('].forEach(g => {
    assert.ok(!prelude.includes(g), 'prelude references ' + g);
  });
  assert.ok(/typeof state === 'object'/.test(src) && /typeof getCheck === 'function'/.test(src), 'ready() guards');
  assert.ok(/typeof fetch !== 'function'/.test(src), 'fetch is guarded');
});

test('audit and attendance keys follow the reserved prefixes', () => {
  assert.ok(/AUDIT_PREFIX = '__audit__'/.test(src));
  assert.ok(/ATT_PREFIX = '__att__'/.test(src));
  assert.ok(/setCheck\(AUDIT_PREFIX \+ id, date/.test(src), 'audit is written via setCheck');
  assert.ok(!/setCheck\(ATT_PREFIX/.test(src), 'attendance is read-only here (정본은 /staff-attendance)');
});

test('publishing goes through expandPack → applyAssignments(…, true)', () => {
  assert.ok(/C\.expandPack\(st\.pack, s\.name, \{ start: start, existingSlotIds: existing, slotIds: chosen/.test(src));
  assert.ok(/applyAssignments\(\{ assignments: r\.assignments \}, true\)/.test(src));
  assert.ok(/fetch\(PACK_URL/.test(src) && /PACK_URL = '\.\/runbook-pack\.json'/.test(src));
  assert.ok(/validatePack\(pack/.test(src), 'the fetched pack is validated before use');
});

/* ── 스모크: index.html 전역을 흉내 낸다 ── */

function localMs(ymd, hmStr) {
  const p = ymd.split('-').map(Number), t = hmStr.split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0], t[1]).getTime();
}

const D = '2026-09-09';
let checks, tasks, staff, posted, postReply, toasts, modals;

function installGlobals(opts) {
  const o = opts || {};
  checks = {};
  toasts = []; modals = []; posted = [];
  postReply = { ok: true, requests: [], viewerId: o.staffId || 's1', role: o.admin ? 'admin' : 'staff' };
  staff = [{ id: 's1', name: '김직원', deleted: false }, { id: 's2', name: '박강사', deleted: false }, { id: 's9', name: '옛직원', deleted: true }];
  tasks = [
    { id: 't-open', staffId: 's1', title: '[R-1230-OPEN] 런북 확인', time: '12:30', window: 30, runbookSlotId: 'R-1230-OPEN', repeat: 'weekday', days: [], start: '2026-09-01', end: '', carry: false, steps: [{ id: 'a', label: '요청함 새 건 확인' }, { id: 'b', label: '이월 건 확인' }] },
    { id: 't-sf', staffId: 's1', title: '[R-2030-SF] 스터디포스 수행 확인', time: '20:30', window: 30, runbookSlotId: 'R-2030-SF', repeat: 'weekday', days: [], start: '2026-09-01', end: '', carry: false, steps: [{ id: 'a', label: '수행 화면 확인', ext: 'studyforce_admin' }, { id: 'b', label: 'handoff 갱신' }] },
    { id: 't-plain', staffId: 's1', title: '일반 업무', time: '09:00', steps: [] },
    { id: 't-s2', staffId: 's2', title: '[R-1500-CC] 클래스카드 세트 배정 점검', time: '15:00', window: 60, runbookSlotId: 'R-1500-CC', repeat: 'days', days: [3, 5], start: '2026-09-01', end: '', carry: true, unit: '반', steps: [{ id: 'a', label: '누락 반 확인', ext: 'classcard_teacher' }] }
  ];
  Object.assign(globalThis, {
    state: { staff: staff, tasks: tasks, checks: checks },
    session: { isAdmin: !!o.admin, isStaffLink: !o.admin, staffId: o.admin ? '' : (o.staffId || 's1'), isManager: false },
    getCheck: (id, date) => checks[id + '|' + date] || null,
    setCheck: (id, date, patch) => { checks[id + '|' + date] = Object.assign({}, checks[id + '|' + date] || {}, patch, { updatedAt: 1 }); },
    tasksFor: (staffId, date) => tasks.filter(t => t.staffId === staffId && !t.deleted && (t.repeat !== 'days' || t.days.includes(core.dowOf(date))) && (!t.start || t.start <= date))
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')),
    isDone: (id, date) => !!(checks[id + '|' + date] || {}).done,
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: m => toasts.push(m),
    modal: (title, body, foot) => modals.push({ title, body, foot: foot || '' }),
    closeModal: () => modals.push({ closed: true }),
    today: () => D,
    nowHM: () => '21:30',
    now: () => localMs(D, '21:30'),
    uid: () => 'abcd-1234-efgh',
    staffById: id => staff.find(s => s.id === id),
    liveStaff: () => staff.filter(s => !s.deleted),
    mondayOf: d => core.addDays(d, -((core.dowOf(d) + 6) % 7)),
    renderAfterSync: () => {},
    route: 'today', cursor: D,
    SYNC_APP: 'task',
    sync: {
      auth: () => (o.noAuth ? null : (o.admin ? { mode: 'admin', secret: 'x' } : { mode: 'person', id: o.staffId || 's1', token: 't' })),
      post: (p, body) => { posted.push({ path: p, body }); return typeof postReply === 'function' ? postReply(body) : Promise.resolve(postReply); }
    },
    applyAssignments: (input, pre) => { posted.push({ applied: input, pre }); }
  });
  const stt = ui._state;
  stt.requests = []; stt.loaded = false; stt.loading = false; stt.error = ''; stt.loadedKey = ''; stt.promise = null;
  stt.viewerId = ''; stt.role = ''; stt.pack = null; stt.packLoading = false; stt.packError = ''; stt.packPromise = null; stt.busy = false;
}

function request(extra) {
  return Object.assign({
    id: 'opr_abc123', reqType: 'account', program: 'studyforce', targetRef: 'SF-012', ownerId: 's2', assigneeId: 's1', via: 'app',
    neededBy: '2026-09-10', detail: '스터디포스 계정 발급', status: 'requested', resultNote: null, resultUrl: null,
    createdAt: localMs(D, '10:00'), acceptedAt: null, doneAt: null, updatedAt: 1000
  }, extra || {});
}

test('todayBlocks renders the runbook overview for a staff member with steps, limit, ext link and count', async () => {
  installGlobals({});
  checks['t-open|' + D] = { done: true, at: localMs(D, '12:41'), steps: { a: true, b: true } };
  const me = staff[0];
  const html = ui.todayBlocks(me, D);
  assert.ok(html.includes('오늘의 런북'));
  assert.ok(html.includes('1/2 완료'), 'one of two runbook slots done; plain task excluded');
  assert.ok(html.includes('런북 확인') && html.includes('스터디포스 수행 확인'));
  assert.ok(!html.includes('일반 업무'), 'non-runbook tasks are not in the overview');
  assert.ok(html.includes('마감 21:00'), 'time + window');
  assert.ok(html.includes('완료 12:41'));
  assert.ok(html.includes('지연'), '21:30 > 21:00 and not done → late');
  assert.ok(html.includes('href="https://hol.sfcenter.co.kr/"'), 'official link from the step ext');
  assert.ok(html.includes('data-act="rb-jump" data-id="t-sf"'));
  assert.ok(html.includes('출근 체크 먼저'), 'no __att__ record → badge');
  assert.ok(html.includes('내 요청함'), 'inbox block follows');
  assert.ok(html.includes('data-act="rb-req-new"'), '[＋ 운영 요청] is offered');
  assert.ok(!html.includes('rb-cnt'), 'no counter without a pack definition');
  checks['__att__s1|' + D] = { done: true };
  assert.ok(!ui.todayBlocks(me, D).includes('출근 체크 먼저'));
  assert.equal(ui.todayBlocks(null, D), '');
  await new Promise(r => setTimeout(r, 0));
});

test('todayBlocks for a teacher without runbook tasks still shows the inbox with own requests', async () => {
  installGlobals({ staffId: 's2' });
  postReply = { ok: true, viewerId: 's2', role: 'staff', requests: [request({ status: 'accepted', acceptedAt: 5 })] };
  const me = staff[1];
  assert.ok(ui.todayBlocks(me, D).includes('오늘의 런북'), '2026-09-09 is a Wednesday, so the CC slot is on');
  assert.equal(ui.todayBlocks(me, '2026-09-10'), '', 'Thursday: no CC slot and the inbox is today-only');
  await ui.ensureRequestsLoaded();
  let html = ui.todayBlocks(me, D);
  html = ui.todayBlocks(me, D);
  assert.ok(html.includes('내가 올린 요청'));
  assert.ok(html.includes('계정 발급 · 스터디포스'));
  assert.ok(html.includes('SF-012'), 'the requester sees the target code');
  assert.ok(!html.includes('data-action="accept"'), 'owner cannot accept');
  assert.ok(!html.includes('data-action="cancel"'), 'accepted work cannot be cancelled by the requester');
  assert.equal(posted[0].body.action, 'list');
  assert.equal(posted[0].body.app, 'task');
  assert.deepEqual(posted[0].body.auth, { mode: 'person', id: 's2', token: 't' });
});

test('the assignee sees action buttons that match the server transition table', async () => {
  installGlobals({});
  postReply = { ok: true, viewerId: 's1', role: 'staff', requests: [
    request({ id: 'opr_req1', status: 'requested' }),
    request({ id: 'opr_req2', status: 'accepted', acceptedAt: 5 }),
    request({ id: 'opr_req3', status: 'blocked', resultNote: '사이트 점검' }),
    request({ id: 'opr_req4', status: 'done', doneAt: localMs(D, '11:00'), resultNote: '발급 완료', resultUrl: 'https://hol.sfcenter.co.kr/x' }),
    request({ id: 'opr_req5', status: 'requested', neededBy: '2026-09-01' })
  ] };
  await ui.ensureRequestsLoaded();
  const html = ui.todayBlocks(staff[0], D);
  const card = id => html.slice(html.indexOf('data-rb-req="' + id + '"'), html.indexOf('</div></div>', html.indexOf('data-rb-req="' + id + '"')));
  assert.ok(card('opr_req1').includes('data-action="accept"') && card('opr_req1').includes('data-action="block"'));
  assert.ok(!card('opr_req1').includes('data-action="done"'), 'requested → done is not offered');
  ['start', 'done', 'block'].forEach(a => assert.ok(card('opr_req2').includes('data-action="' + a + '"'), a));
  assert.ok(card('opr_req3').includes('data-action="unblock"') && card('opr_req3').includes('data-action="done"'));
  assert.ok(card('opr_req3').includes('사유: 사이트 점검'));
  assert.ok(!card('opr_req4').includes('data-act="rb-req-act"'), 'done is terminal');
  assert.ok(card('opr_req4').includes('href="https://hol.sfcenter.co.kr/x"'), 'approved result link is clickable');
  assert.ok(card('opr_req5').includes('기한 지남'));
  assert.ok(html.includes('미처리 4'));
  assert.ok(html.indexOf('opr_req5') < html.indexOf('opr_req1'), 'earlier neededBy sorts first');
});

test('a transition posts action + expectedUpdatedAt and swaps in the server row; OPS_STALE refreshes instead', async () => {
  installGlobals({});
  postReply = { ok: true, viewerId: 's1', role: 'staff', requests: [request({ id: 'opr_req1', status: 'requested', updatedAt: 1000 })] };
  await ui.ensureRequestsLoaded();
  postReply = body => Promise.resolve({ ok: true, request: request({ id: 'opr_req1', status: 'accepted', acceptedAt: 7, updatedAt: 2000 }) });
  const el = { dataset: { act: 'rb-req-act', id: 'opr_req1', action: 'accept' }, closest: () => null };
  ui._onClick({ target: { closest: () => el } });
  await new Promise(r => setTimeout(r, 0));
  const call = posted[posted.length - 1].body;
  assert.equal(call.action, 'accept');
  assert.equal(call.id, 'opr_req1');
  assert.equal(call.expectedUpdatedAt, 1000);
  assert.equal(ui.requests()[0].status, 'accepted');
  assert.ok(toasts.some(t => t.includes('접수')));
  /* stale */
  postReply = () => { const e = new Error('stale'); e.code = 'OPS_STALE'; e.current = request({ id: 'opr_req1', status: 'done', updatedAt: 3000, doneAt: 9 }); return Promise.reject(e); };
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-req-act', id: 'opr_req1', action: 'start' }, closest: () => null }) } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(ui.requests()[0].status, 'done', 'server row replaced the cached one');
  assert.ok(toasts.some(t => t.includes('다른 기기')));
  /* illegal from the client side never reaches the server */
  const n = posted.length;
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-req-act', id: 'opr_req1', action: 'accept' }, closest: () => null }) } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(posted.length, n, 'no post for a terminal request');
});

test('request form: staff never sends via/assigneeId, admin does; PII is refused before the network', async () => {
  installGlobals({});
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-req-new' }, closest: () => null }) } });
  const form = modals[modals.length - 1];
  assert.equal(form.title, '운영 요청');
  assert.ok(form.body.includes('id="rb-f-target"') && form.body.includes('id="rb-f-detail"') && form.body.includes('id="rb-f-needed"'));
  assert.ok(!form.body.includes('rb-f-assignee') && !form.body.includes('rb-via'), 'staff form has no assignee or via');
  assert.ok(form.body.includes('이름·전화 금지'));
  /* Node에는 document가 없어 폼 값을 못 읽는다 — 값이 비면 검증이 먼저 막고 네트워크는 타지 않는다 */
  const n = posted.length;
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-req-submit' }, closest: () => null }) } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(posted.length, n, 'validation failed → nothing posted');
  assert.ok(toasts.length, 'user got a validation toast');

  installGlobals({ admin: true });
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-req-new', via: 'kakao', assignee: 's1' }, closest: () => null }) } });
  const adminForm = modals[modals.length - 1];
  assert.ok(adminForm.body.includes('id="rb-f-assignee"'));
  assert.ok(/value="s1" selected/.test(adminForm.body), 'preselected assignee');
  assert.ok(!adminForm.body.includes('value="s9"'), 'deleted staff not offered');
  assert.ok(/data-v="kakao"[^>]*>|class="chip on" data-act="rb-via" data-v="kakao"/.test(adminForm.body));
  assert.equal(ui._state.viaDraft, 'kakao');
});

test('boardCard (admin) shows rates, a masked timeline with audit buttons and the publish button', async () => {
  installGlobals({ admin: true });
  checks['t-open|' + D] = { done: true, at: localMs(D, '12:41') };
  checks['t-sf|' + D] = { done: true, at: localMs(D, '21:20'), note: 'SF-012 계정 없음 → 요청함' };
  checks['t-s2|' + D] = { blocked: true, note: '교사 화면 오류' };
  checks['__audit__t-open|' + D] = { done: true };
  postReply = { ok: true, viewerId: 'admin', role: 'admin', requests: [
    request({ id: 'opr_done1', status: 'done', createdAt: localMs(D, '09:00'), acceptedAt: localMs(D, '10:00'), doneAt: localMs(D, '11:00'), resultNote: 'SF-012 발급 완료', resultUrl: 'https://drive.google.com/x' }),
    request({ id: 'opr_open1', status: 'requested', assigneeId: '' })
  ] };
  await ui.ensureRequestsLoaded();
  const html = ui.boardCard(D);
  assert.ok(html.includes('완료율 67% (2/3)'), 'three runbook slots across staff, two done');
  assert.ok(html.includes('정시율 33%'), 'only 12:41 is inside its window');
  assert.ok(html.includes('막힘 1'));
  assert.ok(html.includes('오늘 결과 타임라인'));
  assert.ok(html.includes('김직원') && html.includes('박강사'));
  const timeline = html.slice(html.indexOf('오늘 결과 타임라인'), html.indexOf('<details'));
  assert.ok(timeline.includes('SF-•••'), 'student code is masked in the timeline');
  assert.ok(!timeline.includes('SF-012'), 'no raw SF code in the timeline (A.5) — the collapsed inbox may show the target for triage');
  assert.ok(html.includes('대조 ✓'), 'audited slot shows the mark');
  assert.ok(html.includes('data-act="rb-audit" data-id="t-sf"'));
  assert.ok(html.includes('요청 미처리 1'));
  assert.ok(html.includes('오늘 완료 1'));
  assert.ok(html.includes('소요 중위(7일) 2시간'));
  assert.ok(html.includes('링크: drive.google.com') && !html.includes('href="https://drive.google.com'), 'non-approved result host is text only');
  assert.ok(html.includes('data-act="rb-publish"') && html.includes('data-act="rb-weekly"'));
  assert.ok(html.includes('data-action="assign"'), 'admin can assign the open request');
  assert.ok(html.includes('data-act="rb-req-new" data-via="kakao"'));
  /* 대조 완료 클릭 → __audit__ 키 */
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-audit', id: 't-sf', date: D }, closest: () => null }) } });
  assert.equal(checks['__audit__t-sf|' + D].done, true);
  assert.equal(ui.boardCard(D).match(/대조 ✓/g).length, 2);
});

test('boardCard is empty for staff; briefSection lists slots with masked notes and request counts', async () => {
  installGlobals({});
  assert.equal(ui.boardCard(D), '');
  installGlobals({ admin: true });
  checks['t-sf|' + D] = { blocked: true, note: 'SF-012 화면 안 열림' };
  postReply = { ok: true, viewerId: 'admin', role: 'admin', requests: [request({ status: 'blocked' }), request({ id: 'opr_done2', status: 'done', doneAt: localMs(D, '11:00') })] };
  await ui.ensureRequestsLoaded();
  const txt = ui.briefSection(D);
  assert.ok(txt.startsWith('─────────\n📋 운영 런북 — 발행 3'));
  assert.ok(txt.includes('20:30 스터디포스 수행 확인 — 막힘'));
  assert.ok(txt.includes('SF-••• 화면 안 열림') && !txt.includes('SF-012'));
  assert.ok(txt.includes('📨 요청함 — 미처리 1 · 막힘 1 · 오늘 완료 1'));
  assert.ok(txt.includes('(김직원)'));
});

test('without a sync connection the inbox shows a hint and never posts; a server error becomes a retry hint', async () => {
  installGlobals({ noAuth: true });
  const html = ui.todayBlocks(staff[0], D);
  assert.ok(html.includes('동기화'), 'offline hint');
  assert.equal(posted.length, 0);
  installGlobals({});
  postReply = () => { const e = new Error('boom'); e.code = 'OPS_REQUEST_NOT_READY'; return Promise.reject(e); };
  await ui.ensureRequestsLoaded();
  const h2 = ui.todayBlocks(staff[0], D);
  assert.ok(h2.includes('준비하고 있습니다') && h2.includes('data-act="rb-req-refresh"'));
  assert.ok(h2.includes('오늘의 런북'), 'runbook overview still renders');
});

test('requests reload once per route and on force only', async () => {
  installGlobals({});
  postReply = { ok: true, viewerId: 's1', role: 'staff', requests: [] };
  await ui.ensureRequestsLoaded();
  await ui.ensureRequestsLoaded();
  assert.equal(posted.filter(p => p.body.action === 'list').length, 1, 'same route → no second list');
  globalThis.route = 'board';
  await ui.ensureRequestsLoaded();
  assert.equal(posted.filter(p => p.body.action === 'list').length, 2, 'new route → refresh');
  await ui.ensureRequestsLoaded(true);
  assert.equal(posted.filter(p => p.body.action === 'list').length, 3, 'force → refresh');
  globalThis.route = 'today';
});

test('normalizeRequest drops rows with bad ids and strips targets that are not codes', () => {
  assert.equal(ui._normalizeRequest({ id: 'tlr_x' }), null);
  assert.equal(ui._normalizeRequest(null), null);
  const r = ui._normalizeRequest(request({ targetRef: '홍길동', reqType: 'weird', status: 'nope', via: 'sms' }));
  assert.equal(r.targetRef, '');
  assert.equal(r.reqType, 'other');
  assert.equal(r.status, 'requested');
  assert.equal(r.via, 'app');
});

test('rb-cnt writes count through setCheck and rb-ext records extOpened only inside a task card', () => {
  installGlobals({});
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-cnt', id: 't-s2', date: D, n: '1' }, closest: () => null }) } });
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-cnt', id: 't-s2', date: D, n: '1' }, closest: () => null }) } });
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-cnt', id: 't-s2', date: D, n: '-5' }, closest: () => null }) } });
  assert.equal(checks['t-s2|' + D].count, 0, 'never below zero');
  const inCard = { dataset: { act: 'rb-ext', ext: 'studyforce_admin' }, closest: sel => sel === '[data-task]' ? { dataset: { task: 't-sf' } } : null };
  ui._onClick({ target: { closest: () => inCard } });
  assert.equal(checks['t-sf|' + D].extOpened, true);
  const outside = { dataset: { act: 'rb-ext', ext: 'studyforce_admin' }, closest: () => null };
  const before = Object.keys(checks).length;
  ui._onClick({ target: { closest: () => outside } });
  assert.equal(Object.keys(checks).length, before, 'overview links do not create checks');
});

test('publishing: modal lists slots with issued ones disabled; run expands only chosen new slots', async () => {
  installGlobals({ admin: true });
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'runbook-pack.json'), 'utf8'));
  ui._state.pack = pack;
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-publish' }, closest: () => null }) } });
  await new Promise(r => setTimeout(r, 0));
  const m = modals[modals.length - 1];
  assert.equal(m.title, '런북 발행');
  assert.ok(m.body.includes('value="R-1230-OPEN" disabled') && m.body.includes('발행됨'), 's1 already has R-1230-OPEN');
  assert.ok(/value="R-1600-EXAM">/.test(m.body) || /value="R-1600-EXAM"\s*>/.test(m.body), 'manual slot is not pre-checked');
  assert.ok(/value="R-1300-SF" checked/.test(m.body), 'auto slot is pre-checked');
  assert.ok(!m.body.includes('옛직원'));
  /* Node에는 document가 없어 선택을 못 읽는다 → 발행 없이 토스트 */
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-publish-run' }, closest: () => null }) } });
  assert.ok(!posted.some(p => p.applied), 'nothing applied without a staff selection');
  assert.ok(toasts.length);
});

test('weekly report modal is admin only and carries the disclaimer', () => {
  installGlobals({ admin: true });
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-weekly', date: D }, closest: () => null }) } });
  const m = modals[modals.length - 1];
  assert.equal(m.title, '주간 절차 리포트');
  assert.ok(m.body.includes('절차 지표이며 학습 결과가 아님'));
  assert.ok(m.body.includes('2026-09-07 ~ 2026-09-13'));
  installGlobals({});
  const n = modals.length;
  ui._onClick({ target: { closest: () => ({ dataset: { act: 'rb-weekly', date: D }, closest: () => null }) } });
  assert.equal(modals.length, n, 'staff cannot open it');
});
