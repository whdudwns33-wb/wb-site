const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start + marker.length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

function storage() {
  const values = new Map();
  return {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
    clear: () => values.clear()
  };
}

function documentStub() {
  const node = () => ({
    innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, remove() {}, select() {}, focus() {}, click() {},
    setAttribute() {}, removeAttribute() {}, querySelector: () => null,
    querySelectorAll: () => [], closest: () => null
  });
  return {
    body: node(), documentElement: node(), visibilityState: 'visible',
    querySelector: () => null, querySelectorAll: () => [],
    createElement: node, addEventListener() {}, execCommand: () => true
  };
}

function reportApi() {
  const scriptStart = html.indexOf('<script>');
  const handlersStart = html.indexOf("document.addEventListener('click'", scriptStart);
  assert.ok(scriptStart >= 0 && handlersStart > scriptStart, 'inline application source must exist');
  const appSource = html.slice(scriptStart + '<script>'.length, handlersStart);
  const localStorage = storage();
  const sessionStorage = storage();
  const location = {
    origin: 'https://example.test', pathname: '/consult/', search: '', hash: '', href: 'https://example.test/consult/'
  };
  const document = documentStub();
  const context = {
    console, Date, Math, JSON, Object, Array, Map, Set, Promise,
    URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData,
    crypto: webcrypto, localStorage, sessionStorage, location, document,
    navigator: { clipboard: { writeText: async () => {} } },
    history: { replaceState() {} },
    fetch: async () => { throw new Error('network is not available in report tests'); },
    alert() {}, confirm: () => true,
    atob, btoa,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, scrollTo() {}, print() {}
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(appSource + `
    globalThis.__reportApi = {
      buildReportSnapshot: typeof buildReportSnapshot === 'function' ? buildReportSnapshot : null,
      publishReportSnapshot: typeof publishReportSnapshot === 'function' ? publishReportSnapshot : null,
      reportSnapshotsFor: typeof reportSnapshotsFor === 'function' ? reportSnapshotsFor : null,
      reportPrintHtml: typeof reportPrintHtml === 'function' ? reportPrintHtml : null,
      printReportSnapshot: typeof printReportSnapshot === 'function' ? printReportSnapshot : null,
      viewWeek, viewMonth, occursOn,
      setState(next) { state = next; },
      getState() { return state; },
      setSession(search, admin) {
        location.search = search || '';
        sessionStorage.clear();
        if (admin) sessionStorage.setItem('wb_consult_admin', '1');
      },
      setCursor(value) { cursor = value; ymCursor = String(value).slice(0, 7); agendaDate = value; },
      setViewStaff(value) { viewStaff = value; }
    };
  `, context, { filename: 'consult/index.html' });
  return context.__reportApi;
}

function fixture() {
  const stamp = value => new Date(value + 'T12:00:00+09:00').getTime();
  return {
    version: 2,
    staff: [
      { id: 'student-a', name: '가학생', owner: false, createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01') },
      { id: 'student-b', name: '나학생', owner: false, createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01') }
    ],
    tasks: [
      { id: 'a-math', staffId: 'student-a', title: '수학 개념', studySubject: 'math', origin: 'admin', repeat: 'once', start: '2026-08-17', createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01'), deleted: false },
      { id: 'a-english', staffId: 'student-a', title: '영단어 복습', studySubject: 'english', origin: 'staff', repeat: 'once', start: '2026-08-18', carry: true, createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01'), deleted: false },
      { id: 'a-science', staffId: 'student-a', title: '과학 문제', studySubject: 'science', origin: 'admin', repeat: 'once', start: '2026-08-20', target: 2, unit: '쪽', createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01'), deleted: false },
      { id: 'a-future', staffId: 'student-a', title: '미래 국어', studySubject: 'korean', origin: 'admin', repeat: 'once', start: '2026-08-21', createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01'), deleted: false },
      { id: 'b-private', staffId: 'student-b', title: '다른 학생 비공개 과제', studySubject: 'math', origin: 'admin', repeat: 'once', start: '2026-08-17', createdAt: stamp('2026-08-01'), updatedAt: stamp('2026-08-01'), deleted: false }
    ],
    checks: {
      'a-math|2026-08-17': { taskId: 'a-math', date: '2026-08-17', done: true, updatedAt: stamp('2026-08-17') },
      'a-english|2026-08-18': { taskId: 'a-english', date: '2026-08-18', done: false, blocked: true, note: '어휘가 어려움', updatedAt: stamp('2026-08-18') },
      'a-science|2026-08-20': { taskId: 'a-science', date: '2026-08-20', done: false, count: 1, updatedAt: stamp('2026-08-20') },
      'a-future|2026-08-21': { taskId: 'a-future', date: '2026-08-21', done: true, updatedAt: stamp('2026-08-21') },
      'b-private|2026-08-17': { taskId: 'b-private', date: '2026-08-17', done: true, note: '노출 금지', updatedAt: stamp('2026-08-17') },
      '__st__student-a|2026-08-17': { secs: { '수학': 3600 }, updatedAt: stamp('2026-08-17') },
      '__st__student-a|2026-08-18': { secs: { '영어': 1800 }, updatedAt: stamp('2026-08-18') },
      '__st__student-a|2026-08-21': { secs: { '국어': 7200 }, updatedAt: stamp('2026-08-21') },
      '__st__student-b|2026-08-17': { secs: { '수학': 99999 }, updatedAt: stamp('2026-08-17') },
      '__stgoal__student-a|all': { mins: 60, updatedAt: stamp('2026-08-01') },
      '__weekplan__student-a|2026-08-17': { plan: { reflection: '주간 학생 회고', directorNote: '주간 원장 피드백' }, updatedAt: stamp('2026-08-20') },
      '__monthplan__student-a|2026-08': { plan: { reflection: '월간 학생 회고', directorNote: '월간 원장 피드백', nextFocus: '다음 달 수학 집중', events: [] }, updatedAt: stamp('2026-08-20') }
    },
    settings: {
      centerName: 'WB 테스트센터', adminPin: 'pin-private-91', adminLoginId: 'director-private',
      syncUrl: 'https://private-sync.example/secret', syncSecret: 'secret-private-92',
      adminToken: 'admin-token-private-93', myToken: 'student-token-private-94'
    }
  };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('report snapshot functions keep the consult storage and sync identity', () => {
  assert.match(html, /const LS_KEY = 'wb_consult_v1'/);
  assert.match(html, /const SYNC_APP = 'consult'/);
  const api = reportApi();
  ['buildReportSnapshot', 'publishReportSnapshot', 'reportSnapshotsFor', 'reportPrintHtml', 'printReportSnapshot']
    .forEach(name => assert.equal(typeof api[name], 'function', name + ' must be implemented'));
});

test('weekly and monthly aggregation execute against real task, check, and timer helpers', () => {
  const api = reportApi();
  const state = fixture();
  api.setState(state);
  const asOf = new Date('2026-08-20T20:00:00+09:00').getTime();
  const week = plain(api.buildReportSnapshot('student-a', 'week', '2026-08-17', asOf));

  assert.equal(week.periodStart, '2026-08-17');
  assert.equal(week.periodEnd, '2026-08-23');
  assert.equal(week.asOf, asOf);
  assert.equal(week.isPartial, true);
  assert.deepEqual({
    done: week.summary.done, total: week.summary.total, pct: week.summary.pct,
    blocked: week.summary.blocked, studySecs: week.summary.studySecs, goalDays: week.summary.goalDays
  }, { done: 1, total: 3, pct: 33, blocked: 1, studySecs: 5400, goalDays: 1 });
  assert.deepEqual({ done: week.subjects.math.done, total: week.subjects.math.total, studySecs: week.subjects.math.studySecs },
    { done: 1, total: 1, studySecs: 3600 });
  assert.deepEqual({ done: week.subjects.english.done, total: week.subjects.english.total, studySecs: week.subjects.english.studySecs },
    { done: 0, total: 1, studySecs: 1800 });
  assert.deepEqual({ done: week.subjects.science.done, total: week.subjects.science.total, studySecs: week.subjects.science.studySecs },
    { done: 0, total: 1, studySecs: 0 });
  assert.equal(week.reflection, '주간 학생 회고');
  assert.equal(week.directorNote, '주간 원장 피드백');
  assert.equal(week.nextFocus, '');
  assert.deepEqual(week.rows.map(row => row.taskId), ['a-math', 'a-english', 'a-science']);
  assert.ok(!JSON.stringify(week).includes('a-future'), 'asOf date must cut off future period rows');
  assert.ok(!JSON.stringify(week).includes('student-b'), 'another student must never enter the snapshot');
  assert.ok(!JSON.stringify(week).includes('다른 학생 비공개 과제'));

  const monthEnd = new Date('2026-08-31T23:59:00+09:00').getTime();
  const month = plain(api.buildReportSnapshot('student-a', 'month', '2026-08', monthEnd));
  assert.equal(month.periodStart, '2026-08-01');
  assert.equal(month.periodEnd, '2026-08-31');
  assert.equal(month.isPartial, false);
  assert.deepEqual({
    done: month.summary.done, total: month.summary.total, pct: month.summary.pct,
    blocked: month.summary.blocked, studySecs: month.summary.studySecs, goalDays: month.summary.goalDays
  }, { done: 2, total: 4, pct: 50, blocked: 1, studySecs: 12600, goalDays: 2 });
  assert.equal(month.reflection, '월간 학생 회고');
  assert.equal(month.directorNote, '월간 원장 피드백');
  assert.equal(month.nextFocus, '다음 달 수학 집중');
});

test('publishing and republishing append immutable admin-origin revisions', () => {
  const api = reportApi();
  const state = fixture();
  api.setState(state);
  api.setSession('', true);
  const firstAt = new Date('2026-08-20T20:00:00+09:00').getTime();
  const secondAt = firstAt + 60_000;
  const first = plain(api.publishReportSnapshot('student-a', 'week', '2026-08-17', firstAt));
  const firstSealed = JSON.stringify(first);
  const second = plain(api.publishReportSnapshot('student-a', 'week', '2026-08-17', secondAt));
  const snapshots = plain(api.reportSnapshotsFor('student-a', 'week', '2026-08-17'));

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map(row => row.reportRevision), [2, 1]);
  assert.equal(JSON.stringify(snapshots[1]), firstSealed, 'republish must not mutate revision 1');
  assert.notEqual(second.id, first.id);
  assert.equal(second.supersedesId, first.id);
  for (const row of [first, second]) {
    assert.equal(row.kind, 'report_snapshot');
    assert.equal(row.origin, 'admin');
    assert.equal(row.staffId, 'student-a');
    assert.equal(row.reportType, 'week');
    assert.equal(row.periodKey, '2026-08-17');
    assert.equal(row.reportStatus, 'published');
    assert.equal(row.repeat, 'none');
    assert.equal(api.occursOn(row, '2026-08-17'), false, 'report events must not enter normal task lists');
  }
  assert.equal(first.reportRevision, 1);
  assert.equal(second.reportRevision, 2);
  assert.ok(first.snapshot && second.snapshot, 'each revision must carry its own sealed aggregate');
  assert.equal(state.tasks.filter(row => row.kind === 'report_snapshot').length, 2);
});

test('student mode is read-only and scoped to the signed-in student', () => {
  const api = reportApi();
  const state = fixture();
  api.setState(state);
  api.setSession('', true);
  api.publishReportSnapshot('student-a', 'week', '2026-08-17', new Date('2026-08-20T20:00:00+09:00').getTime());
  api.publishReportSnapshot('student-b', 'week', '2026-08-17', new Date('2026-08-20T20:01:00+09:00').getTime());
  const before = state.tasks.length;

  api.setSession('?u=student-a', false);
  const attempt = api.publishReportSnapshot('student-a', 'week', '2026-08-17', Date.now());
  assert.equal(attempt, null, 'student publication must fail closed');
  assert.equal(state.tasks.length, before);

  api.setCursor('2026-08-20');
  api.setViewStaff('student-b');
  const studentHtml = api.viewWeek();
  assert.match(studentHtml, /주간 리포트/);
  assert.match(studentHtml, /인쇄|PDF/);
  assert.doesNotMatch(studentHtml, /data-act="reportpublish"|data-act="reportwithdraw"|다시 발행/);
  assert.doesNotMatch(studentHtml, /나학생|다른 학생 비공개 과제/);

  api.setSession('', true);
  api.setViewStaff('student-a');
  const adminHtml = api.viewWeek();
  assert.match(adminHtml, /data-act="reportpublish"/);
  assert.match(adminHtml, /다시 발행/);
});

test('print/PDF HTML is a same-page native print view with no credential, id, or URL leakage', () => {
  const api = reportApi();
  const state = fixture();
  api.setState(state);
  api.setSession('', true);
  const published = api.publishReportSnapshot('student-a', 'month', '2026-08', new Date('2026-08-31T23:59:00+09:00').getTime());
  published.snapshot.syncSecret = state.settings.syncSecret;
  published.snapshot.adminToken = state.settings.adminToken;
  published.snapshot.myToken = state.settings.myToken;
  published.snapshot.privateUrl = state.settings.syncUrl;
  const printable = api.reportPrintHtml(published.snapshot);

  assert.match(printable, /가학생/);
  assert.match(printable, /월간/);
  assert.match(printable, /총|완료|달성/);
  [
    'student-a', 'pin-private-91', 'director-private', 'secret-private-92',
    'admin-token-private-93', 'student-token-private-94', 'https://private-sync.example/secret'
  ].forEach(secret => assert.ok(!printable.includes(secret), 'print leaked: ' + secret));
  assert.doesNotMatch(printable, /https?:\/\//i);

  const htmlSource = functionSource('reportPrintHtml');
  const printSource = functionSource('printReportSnapshot');
  assert.doesNotMatch(htmlSource, /state\.settings|staffLink|location\.|adminToken|syncSecret|myToken/i);
  assert.match(printSource, /window\.print\(\)/);
  assert.doesNotMatch(printSource, /window\.open|target\s*=\s*["']_blank/i);
});
