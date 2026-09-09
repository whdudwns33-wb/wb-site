const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* 이 테스트는 자기 파일(ledger-ui.js)과 코어만 본다. index.html 은 읽지 않는다 —
   접점(탭·라우트·ownerOfCheck)은 통합 담당의 훅 테스트가 검사한다. */
const src = fs.readFileSync(path.join(__dirname, 'ledger-ui.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // 주석을 뺀 본문

/* ── 정적 검사 ── */

test('ui module is an IIFE that exposes exactly one global and a module.exports guard', () => {
  assert.ok(src.startsWith('(function (root, factory) {'), 'same wrapper as asset-core.js');
  assert.ok(src.includes("if (typeof module === 'object' && module.exports) module.exports = api;"));
  assert.ok(src.includes('root.WBLedgerUI = api'));
  assert.ok(!/root\.WB(?!LedgerUI|LedgerCore|ExternalLinks)\w+\s*=/.test(code), 'no other globals are assigned');
  assert.ok(code.includes("'use strict'"));
});

test('every data-act in the markup carries the lg- prefix', () => {
  const acts = [...code.matchAll(/data-act="([^"']*)"/g)].map(m => m[1]).filter(a => !a.includes("' +"));
  assert.ok(acts.length >= 15, 'actions are present, got ' + acts.length);
  acts.forEach(a => assert.ok(a.startsWith('lg-'), 'unprefixed act: ' + a));
  const dyn = [...code.matchAll(/btn\('([a-z-]+)'/g)].map(m => m[1]);
  dyn.forEach(a => assert.ok(a.startsWith('lg-'), 'unprefixed dynamic act: ' + a));
  assert.ok(code.includes("closest('[data-act^=\"lg-\"]')"), 'the click listener only claims lg- actions');
});

test('every lg- action rendered has a handler case', () => {
  const rendered = new Set([...code.matchAll(/data-act="(lg-[a-z-]+)"/g)].map(m => m[1])
    .concat([...code.matchAll(/btn\('(lg-[a-z-]+)'/g)].map(m => m[1])));
  rendered.forEach(a => assert.ok(code.includes("case '" + a + "'"), 'missing handler for ' + a));
});

test('writes go through setCheck only and are gated on session.isAdmin', () => {
  assert.ok(code.includes("h.setCheck(c.ledgerKey(a.id), 'all', a)"), 'asset rows saved via setCheck');
  assert.ok(code.includes("h.setCheck(c.eventKey(ev.id), 'all', ev)"), 'event rows saved via setCheck');
  assert.ok(code.includes("h.setCheck(c.needKey(n.id), 'all', n)"), 'need rows saved via setCheck');
  assert.ok(!/state\.checks\[[^\]]*\]\s*=/.test(code), 'no direct state.checks writes');
  assert.ok(!/\bsave\(\)|\bqueueSync\(\)/.test(code), 'save/queueSync are setCheck\'s job');
  assert.ok(code.includes('h.session.isAdmin'), 'admin gate present');
  const gates = (code.match(/needAdmin\(\)/g) || []).length;
  assert.ok(gates >= 15, 'every write action asks needAdmin(), got ' + gates);
});

test('the module never touches rosterDb, student identity or contact fields', () => {
  ['rosterDb', 'studentName', 'studentId', 'schoolName', 'phone', 'email', 'password', 'loadRoster'].forEach(w => {
    assert.ok(!new RegExp('\\b' + w + '\\b').test(code), w + ' must not appear');
  });
});

test('purchase sheets are issued through applyAssignments with preConfirmed=true', () => {
  assert.ok(code.includes('c.purchaseAssignments(approved, n, staff.name, h.today()'));
  assert.ok(code.includes('h.applyAssignments(sheet, true)'));
});

test('external links open in a new window with noopener, and only official or drive hosts', () => {
  const anchors = [...code.matchAll(/<a [^>]*href=[^>]*>/g)].map(m => m[0]);
  assert.ok(anchors.length >= 1);
  anchors.forEach(a => {
    assert.ok(a.includes('target="_blank"'), a);
    assert.ok(a.includes('rel="noopener noreferrer"'), a);
  });
  assert.ok(code.includes("officialLink('exam4you')"), 'official store link comes from WBExternalLinks');
  assert.ok(code.includes("DRIVE_HOSTS = ['drive.google.com', 'docs.google.com']"));
  assert.ok(!/https?:\/\/(?!drive\.google|docs\.google)[a-z]/.test(code.replace(/https:\/\/\//g, '')), 'no hard-coded external URLs');
});

test('free text is capped at 300 characters and the note guide forbids names', () => {
  assert.ok(code.includes('NOTE_MAX = 300'));
  assert.ok(code.includes('maxlength="\' + NOTE_MAX + \'"'));
  assert.ok(code.includes('.slice(0, NOTE_MAX)'));
  assert.ok(src.includes('학생 이름·학교명은 적지 않습니다'));
});

test('rendering uses house classes only, no injected stylesheet', () => {
  assert.ok(!code.includes('<style'), 'no <style> injection');
  ['card', 'card-title', 'card-sub', 'task', 'task-body', 'task-t', 'meta', 'tag', 'pill', 'btn btn-sm', 'chips', 'chip', 'in', 'fl', 'hint', 'sect', 'empty', 'guide']
    .forEach(cls => assert.ok(code.includes('"' + cls) || code.includes("'" + cls) || code.includes(' ' + cls + ' ') || code.includes(cls + '"') || code.includes(cls + "'"), 'uses ' + cls));
});

/* ── Node 스모크: index.html 없이 가짜 호스트로 전체 흐름을 돈다 ── */

function makeHost() {
  const checks = {};
  const inputs = {};
  const toasts = [];
  const modals = [];
  let issued = null;
  const staff = [
    { id: 'S-owner', name: '원장', owner: true, deleted: false },
    { id: 'S-mgr', name: '관리 담당', owner: false, manager: true, deleted: false },
    { id: 'S-1', name: '직원 하나', owner: false, deleted: false }
  ];
  const h = {
    state: { staff: staff, tasks: [], checks: checks },
    session: { isAdmin: true, isStaffLink: false, staffId: '' },
    setCheck: (taskId, date, patch) => {
      const k = taskId + '|' + date;
      const cur = checks[k] || { taskId: taskId, date: date, done: false, note: '', steps: {}, count: 0, blocked: false };
      checks[k] = Object.assign({}, cur, patch, { updatedAt: Date.now() });
      return checks[k];
    },
    esc: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: m => toasts.push(m),
    modal: (title, body, foot) => modals.push({ title, body, foot }),
    closeModal: () => modals.push(null),
    $: sel => (sel in inputs ? { value: inputs[sel] } : null),
    render: () => {},
    today: () => '2026-09-09',
    now: () => Date.now(),
    liveStaff: () => staff.filter(s => !s.deleted),
    staffById: id => staff.find(s => s.id === id),
    applyAssignments: (sheet, pre) => { issued = { sheet, pre }; modals.push(null); }
  };
  return { h, checks, inputs, toasts, modals, issued: () => issued };
}

function installHost(env) {
  const names = ['state', 'session', 'setCheck', 'esc', 'toast', 'modal', 'closeModal', '$', 'render', 'today', 'now', 'liveStaff', 'staffById', 'applyAssignments'];
  names.forEach(n => { globalThis[n] = env.h[n]; });
  return () => names.forEach(n => { delete globalThis[n]; });
}

/* document 가짜: 리스너를 붙잡아 두고 클릭·입력을 직접 흘려 넣는다. */
const listeners = {};
globalThis.document = { addEventListener: (type, fn) => { listeners[type] = fn; } };
globalThis.confirm = () => true;
const core = require('./ledger-core.js');
const ui = require('./ledger-ui.js');
delete globalThis.document;

function click(act, id) {
  const el = { dataset: { act: act, id: id == null ? '' : String(id) } };
  listeners.click({ target: { closest: sel => (sel === '[data-act^="lg-"]' ? el : null) } });
}
function input(field, value) {
  listeners.input({ target: { dataset: { lgField: field }, value: value } });
}

test('ui exports view/alertCount and degrades to a hint card without the host', () => {
  assert.equal(typeof ui.view, 'function');
  assert.equal(typeof ui.alertCount, 'function');
  assert.equal(typeof listeners.click, 'function', 'click listener registered at load');
  assert.equal(typeof listeners.input, 'function');
  assert.equal(ui.alertCount(), 0);
  assert.ok(ui.view().includes('불러오지 못했습니다'));
});

test('full Phase 0 flow: need set → request → approve/issue → register → pack confirm → block', () => {
  const env = makeHost();
  const restore = installHost(env);
  try {
    /* 빈 화면 */
    let html = ui.view();
    assert.ok(html.includes('승인 대기 · 0건'));
    assert.ok(html.includes('data-act="lg-need-new"'), 'admin sees the add button');

    /* 시험 범위 입력 */
    click('lg-need-new');
    input('schoolCode', 'sch-07');
    input('grade', 'm2');
    input('textbookCode', 'ne-kimgitaek');
    input('examDateCopy', '2026-10-14');
    click('lg-unit', 5);
    click('lg-unit', 6);
    click('lg-series', '02');           // 필수는 빠지지 않는다
    click('lg-tseries', '06');          // 교사용 하나 뺀다
    click('lg-need-save');
    const needRows = Object.keys(env.checks).filter(k => k.startsWith('__licneed__'));
    assert.equal(needRows.length, 1);
    const need = core.normalizeNeed(env.checks[needRows[0]]);
    assert.equal(need.id, 'NEED-0001');
    assert.equal(need.schoolCode, 'SCH-07');
    assert.deepEqual(need.units, [5, 6]);
    assert.deepEqual(need.requiredSeries, ['02', '03']);
    assert.deepEqual(need.teacherSeries, ['04', '05']);
    assert.equal(need.examRef.examDateCopy, '2026-10-14');
    assert.ok(!('examDate' in need), 'no exam date column');
    html = ui.view();
    assert.ok(html.includes('SCH-07 · 중2 · NE능률(김기택) · L05·L06'));
    assert.ok(html.includes('사야 할 8'), '2 units × (02·03 + 04t·05t)');

    /* 구매 요청 → 승인 대기 */
    click('lg-request', 'NEED-0001');
    const assetKeys = Object.keys(env.checks).filter(k => k.startsWith('__lic__'));
    assert.equal(assetKeys.length, 8);
    assert.ok(assetKeys.includes('__lic__MAT-0001|all'));
    assert.ok(assetKeys.includes('__lic__MAT-0008|all'));
    assert.equal(ui.alertCount(), 8);
    const eventKeys = () => Object.keys(env.checks).filter(k => k.startsWith('__licev__'));
    assert.equal(eventKeys().length, 16, 'need + request per asset');
    html = ui.view();
    assert.ok(html.includes('승인 대기 · 8건'));
    assert.ok(html.includes('data-act="lg-approve" data-id="NEED-0001"'));
    assert.ok(html.includes('사야 할 0'), 'requested rows are no longer on the buy list');
    assert.ok(html.includes('진행 8'));

    /* 반려 하나 */
    click('lg-reject', 'MAT-0008');
    env.inputs['#lg-m-note'] = '이번 시즌은 08 없이 간다';
    click('lg-reject-go', 'MAT-0008');
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0008|all']).status, 'rejected');
    assert.equal(ui.alertCount(), 7);

    /* 승인 → 지시서 */
    click('lg-approve', 'NEED-0001');
    const m = env.modals[env.modals.length - 1];
    assert.ok(m && m.title.startsWith('구매 승인 · 7건'));
    assert.ok(m.body.includes('관리 담당'), 'staff picker defaults to the manager');
    env.inputs['#lg-m-staff'] = 'S-1';
    click('lg-approve-go', 'NEED-0001');
    const issued = env.issued();
    assert.ok(issued, 'applyAssignments was called');
    assert.equal(issued.pre, true);
    assert.equal(issued.sheet.assignments.length, 1);
    const sheet = issued.sheet.assignments[0];
    assert.equal(sheet.staff, '직원 하나');
    assert.equal(sheet.title, '[자산] MAT-0001~MAT-0007 구매·인테이크');
    assert.equal(sheet.steps.length, 7);
    assert.ok(sheet.detail.includes('WB 교재스캔/내신브레인_영어/'));
    assert.ok(sheet.detail.includes('NE능률(김기택)/중2/L05/02_본문워크북.pdf'));
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0001|all']).status, 'approved');
    assert.equal(ui.alertCount(), 0);

    /* [등록] = purchase + register */
    click('lg-open', 'MAT-0001');
    html = ui.view();
    assert.ok(html.includes('data-act="lg-register" data-id="MAT-0001"'));
    click('lg-register', 'MAT-0001');
    env.inputs['#lg-m-url'] = 'http://not-secure.example/';
    env.inputs['#lg-m-amount'] = '6,500';
    env.inputs['#lg-m-path'] = '';
    env.inputs['#lg-m-paid'] = '2026-09-09';
    env.inputs['#lg-m-note'] = '';
    click('lg-register-go', 'MAT-0001');
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0001|all']).status, 'approved', 'http url is refused');
    env.inputs['#lg-m-url'] = 'https://drive.google.com/file/d/abc/view';
    click('lg-register-go', 'MAT-0001');
    const reg = core.normalizeAsset(env.checks['__lic__MAT-0001|all']);
    assert.equal(reg.status, 'registered');
    assert.equal(reg.cost.amount, 6500);
    assert.equal(reg.cost.paidAt, '2026-09-09');
    assert.equal(reg.storage.drivePath, 'WB 교재스캔/내신브레인_영어/NE능률(김기택)/중2/L05/02_본문워크북.pdf');
    assert.equal(reg.storage.viewUrl, 'https://drive.google.com/file/d/abc/view');
    assert.equal(reg.links.packId, '2022-ne-kimgitaek-m2-L5');
    const types = eventKeys().map(k => env.checks[k].type);
    assert.ok(types.includes('purchase') && types.includes('register'), 'both events written');
    html = ui.view();
    assert.ok(html.includes('드라이브 보기 ↗'));
    assert.ok(html.includes('보유 1'));
    assert.ok(html.includes('사야 할 1'), 'the rejected MAT-0008 is back on the buy list, the rest are in flight');
    assert.ok(html.includes('진행 6'));

    /* 잠자는 자료 — D-6 시점 */
    env.h.today = () => '2026-10-08'; globalThis.today = env.h.today;
    html = ui.view();
    assert.ok(html.includes('잠자는 자료 · 1건'));
    click('lg-packok', 'MAT-0001');
    const packed = core.normalizeAsset(env.checks['__lic__MAT-0001|all']);
    assert.equal(packed.status, 'assigned');
    assert.ok(packed.packConfirmedAt > 0);
    assert.ok(ui.view().includes('잠자는 자료 · 0건'));

    /* 막힘 표시·해제 */
    click('lg-block', 'MAT-0002');
    env.inputs['#lg-m-reason'] = 'not_published';
    env.inputs['#lg-m-note'] = '10월 출간 예정';
    click('lg-block-go', 'MAT-0002');
    const blocked = core.normalizeAsset(env.checks['__lic__MAT-0002|all']);
    assert.equal(blocked.blockReason, 'not_published');
    assert.equal(blocked.status, 'approved', 'blocked is a flag, not a status');
    assert.ok(ui.view().includes('미출간'));
    click('lg-unblock', 'MAT-0002');
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0002|all']).blockReason, '');

    /* 이력 카드 */
    html = ui.view();
    assert.ok(html.includes('이벤트 이력 · 최근'));
    assert.ok(html.includes('막힘 해제'));
    assert.ok(!html.includes('규율 위반'), 'every purchase followed a request');

    /* 지움 표시는 키를 남긴다 */
    click('lg-del', 'MAT-0007');
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0007|all']).deleted, true);
    assert.ok('__lic__MAT-0007|all' in env.checks);
    assert.ok(!ui.view().includes('MAT-0007 ·'));
  } finally {
    restore();
  }
});

test('a non-admin session sees the ledger read-only and cannot write', () => {
  const env = makeHost();
  env.h.session = { isAdmin: false, isStaffLink: true, staffId: 'S-1' };
  env.h.setCheck(core.needKey('NEED-0001'), 'all', core.normalizeNeed({ id: 'NEED-0001', schoolCode: 'SCH-07', grade: 'm2', textbookCode: 'ne-kimgitaek', units: [5], examRef: { examDateCopy: '2026-10-14' } }));
  env.h.setCheck(core.ledgerKey('MAT-0001'), 'all', core.normalizeAsset({ id: 'MAT-0001', status: 'requested', catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '03' }, links: { needId: 'NEED-0001' } }));
  const restore = installHost(env);
  try {
    const html = ui.view();
    assert.ok(html.includes('읽기만 됩니다'));
    assert.ok(!html.includes('data-act="lg-approve"'));
    assert.ok(!html.includes('data-act="lg-request"'));
    assert.ok(!html.includes('data-act="lg-need-new"'));
    const before = Object.keys(env.checks).length;
    click('lg-request', 'NEED-0001');
    click('lg-approve', 'NEED-0001');
    click('lg-block', 'MAT-0001');
    assert.equal(Object.keys(env.checks).length, before, 'nothing written');
    assert.ok(env.toasts.some(t => t.includes('원장·관리 담당')));
    assert.equal(ui.alertCount(), 1, 'the badge still counts');
  } finally {
    restore();
  }
});

test('duplicate approval asks for a second confirmation', () => {
  const env = makeHost();
  const cat = { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '03' };
  env.h.setCheck(core.needKey('NEED-0001'), 'all', core.normalizeNeed({ id: 'NEED-0001', schoolCode: 'SCH-07', grade: 'm2', textbookCode: 'ne-kimgitaek', units: [5], examRef: { examDateCopy: '2026-10-14' } }));
  env.h.setCheck(core.ledgerKey('MAT-0001'), 'all', core.normalizeAsset({ id: 'MAT-0001', status: 'registered', catalog: cat }));
  env.h.setCheck(core.ledgerKey('MAT-0002'), 'all', core.normalizeAsset({ id: 'MAT-0002', status: 'requested', catalog: cat, links: { needId: 'NEED-0001' } }));
  const restore = installHost(env);
  const asked = [];
  globalThis.confirm = msg => { asked.push(msg); return false; };
  try {
    assert.ok(ui.view().includes('중복 — MAT-0001 보유'));
    click('lg-approve', 'NEED-0001');
    assert.equal(asked.length, 1);
    assert.ok(asked[0].includes('MAT-0002'));
    assert.equal(env.modals.length, 0, 'declined → no staff picker');
    assert.equal(core.normalizeAsset(env.checks['__lic__MAT-0002|all']).status, 'requested');
  } finally {
    globalThis.confirm = () => true;
    restore();
  }
});

test('the catalog search narrows rows without touching state', () => {
  const env = makeHost();
  env.h.setCheck(core.ledgerKey('MAT-0001'), 'all', core.normalizeAsset({ id: 'MAT-0001', status: 'registered', catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '03' } }));
  env.h.setCheck(core.ledgerKey('MAT-0002'), 'all', core.normalizeAsset({ id: 'MAT-0002', status: 'registered', catalog: { textbookCode: 'ybm-parkjuneon', grade: 'm3', unit: 1, series: '02' } }));
  const restore = installHost(env);
  try {
    let list = { innerHTML: '' };
    env.inputs['#lg-catalog-list'] = '';
    env.h.$ = sel => (sel === '#lg-catalog-list' ? list : null); globalThis.$ = env.h.$;
    listeners.input({ target: { dataset: { lgSearch: '1' }, value: 'ybm' } });
    assert.ok(list.innerHTML.includes('MAT-0002'));
    assert.ok(!list.innerHTML.includes('MAT-0001'));
    listeners.input({ target: { dataset: { lgSearch: '1' }, value: '' } });
    assert.ok(list.innerHTML.includes('MAT-0001'));
    assert.equal(Object.keys(env.checks).length, 2);
  } finally {
    restore();
  }
});
