const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* 이 파일은 perf-panel.js 원문만 검사한다. index.html 접점(탭·라우트·ownerOfCheck·opModal 훅)은
   통합 담당의 훅 검사 테스트가 맡는다 — 여기서 index.html을 읽으면 병렬 작업이 서로를 깨뜨린다. */
const src = fs.readFileSync(path.join(__dirname, 'perf-panel.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(__dirname, 'perf-core.js'), 'utf8');

/* ── 정적 검사 ── */

test('panel is an IIFE that exposes exactly one global and a module.exports guard', () => {
  assert.ok(src.includes("root.WBPerfPanel = api"), 'window.WBPerfPanel');
  assert.ok(src.includes("typeof module === 'object' && module.exports"), 'module.exports guard');
  assert.ok(src.includes("'use strict'"));
  const globals = [...src.matchAll(/root\.(WB[A-Za-z]+)\s*=/g)].map(m => m[1]);
  assert.deepEqual([...new Set(globals)], ['WBPerfPanel'], '다른 전역을 만들지 않는다');
  assert.ok(coreSrc.includes('root.WBPerfCore = api'));
});

test('every data-act in the markup carries the pf- prefix and has a handler', () => {
  const acts = [...src.matchAll(/data-act="([^"]+)"/g)].map(m => m[1]);
  assert.ok(acts.length >= 10, 'markup has actions: ' + acts.length);
  acts.forEach(a => assert.ok(/^pf-[a-z-]+$/.test(a), 'prefix on ' + a));
  [...new Set(acts)].forEach(a => {
    const handled = src.includes("case '" + a + "'") || src.includes("d.act === '" + a + "'");
    assert.ok(handled, 'missing handler for ' + a);
  });
  assert.ok(src.includes('closest(\'[data-act^="pf-"]\')'), '자기 리스너는 pf- 접두만 받는다');
  assert.ok(!/data-act="[^"]*\$\{/.test(src), 'act 이름을 동적으로 만들지 않는다');
});

test('writes are gated on session.isAdmin and go through setCheck only', () => {
  assert.ok(/isAdmin/.test(src));
  assert.ok(src.includes('setCheck('), 'setCheck 사용');
  assert.ok(!/sync\.post\(|fetch\(|XMLHttpRequest|localStorage|sessionStorage/.test(src), '백엔드 직접 호출·브라우저 저장소 없음');
  ['pf-stamp', 'pf-unstamp', 'pf-ex', 'pf-plan', 'pf-act', 'pf-setup-save'].forEach(act => {
    const start = src.indexOf("case '" + act + "'");
    assert.ok(start >= 0, act);
    const end = src.indexOf("case '", start + 10);
    const block = src.slice(start, end < 0 ? undefined : end);
    assert.ok(block.includes('isAdmin()'), act + ' checks isAdmin before writing');
  });
  /* 저장 버튼은 admin 분기 안에서만 그려진다 */
  assert.ok(/admin\s*\?[\s\S]*pf-setup-save/.test(src), '설정 저장 버튼은 admin 분기');
  assert.ok(src.includes('개인 링크'), '개인 링크 거부 이유가 주석에 있다');
});

test('no score, contact-number or account fields and no separate link constant', () => {
  assert.ok(!/PERF_LINKS/.test(src), 'PERF_LINKS 상수를 따로 만들지 않는다');
  assert.ok(!/PERF_LINKS/.test(coreSrc));
  assert.ok(src.includes('WBExternalLinks'), '공식 링크는 shared/external-links.js에서');
  assert.ok(/rel="noopener noreferrer"/.test(src), '외부 링크는 noopener');
  assert.ok(!/https?:\/\//.test(src.replace(/\/\^https:\\\/\\\/\//g, '')), 'URL 리터럴이 파일 안에 없다');
  assert.ok(!/type="(number|tel|email|password)"/.test(src), '숫자·전화·계정 입력칸이 없다');
  assert.ok(!/\b(phone|score|tel|school|password|accountId|percentile)\b\s*[:=]/i.test(src), '점수·전화·학교·계정 필드 없음');
  assert.ok(!/\b(phone|tel|school|password|accountId|percentile)\b\s*[:=]/i.test(coreSrc));
  assert.ok(!/<style/.test(src), 'CSS 주입 없음');
  assert.ok(!/\bconfirm\(|\bprompt\(/.test(src), '자유 입력 프롬프트 없음');
});

test('browser globals are used only behind typeof guards', () => {
  ['state', 'session', 'rosterDb', 'setCheck', 'modal', 'closeModal', 'render', 'go', 'toast', 'loadRoster', 'today', 'mondayOf', 'staffById', 'document']
    .forEach(name => assert.ok(new RegExp('typeof ' + name + ' ').test(src), 'typeof guard for ' + name));
});

/* ── Node 스모크 (index.html 전역 없음) ── */

const panel = require('./perf-panel.js');
const core = require('./perf-core.js');

test('module loads in Node and degrades to a loading card without the app globals', () => {
  assert.equal(typeof panel.view, 'function');
  assert.equal(typeof panel.alertCount, 'function');
  assert.equal(typeof panel.legacyOpModal, 'function');
  const html = panel.view();
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('불러오는 중'));
  assert.equal(panel.alertCount(), 0);
  assert.equal(panel.legacyOpModal('학생A'), false);
});

/* ── 가짜 앱 전역을 얹은 렌더 스모크 ──
   index.html의 최상위 const/let은 뒤에 오는 classic script에 전역으로 보인다.
   Node에서는 globalThis 속성이 같은 역할을 하므로 최소한만 흉내 낸다. */
const TODAY = '2026-09-09', MON = '2026-09-07';
function installGlobals(adminMode) {
  globalThis.state = { staff: [{ id: 'st_1', name: '직원A' }], tasks: [], checks: {} };
  globalThis.session = { isAdmin: !!adminMode, staffId: '' };
  globalThis.rosterDb = { students: [
    { id: 'stu_a', name: '학생A', grade: '중1', start: '2026-03', end: '' },
    { id: 'stu_b', name: '학생B', grade: '중2', start: '2026-03', end: '' },
    { id: 'stu_x', name: '학생X', grade: '중3', start: '2026-03', end: '2026-08' }
  ] };
  globalThis.today = () => TODAY;
  globalThis.now = () => 1700000000000;
  globalThis.mondayOf = () => MON;
  globalThis.staffById = id => globalThis.state.staff.find(s => s.id === id);
  globalThis.setCheck = (taskId, date, patch) => {
    const k = taskId + '|' + date;
    const cur = globalThis.state.checks[k] || { taskId: taskId, date: date, done: false };
    globalThis.state.checks[k] = Object.assign({}, cur, patch, { updatedAt: 1 });
    return globalThis.state.checks[k];
  };
  globalThis.modalCalls = [];
  globalThis.modal = (title, body, foot) => globalThis.modalCalls.push({ title: title, body: body, foot: foot });
}

test('renders the board for active students only and never leaks undefined', () => {
  installGlobals(true);
  const ch = globalThis.state.checks;
  ch[core.perfsetKey('stu_a')] = { progs: ['studyforce', 'classcard'] };
  ch[core.perfsetKey('stu_x')] = { progs: ['studyforce'] };
  ch['__opset__학생B|all'] = { progs: ['클래스카드'] };
  for (let d = '2026-08-31'; d <= TODAY; d = core.addDays(d, 1)) {
    if (core.DEFAULT_DUE_DAYS.includes(core.dowOf(d))) ch[core.perfdayKey('studyforce', d)] = { stamp: { by: 'st_1', at: 5, basis: 'login_log' }, ex: { stu_a: { st: 'not_completed', why: 'no_login' } } };
  }
  const html = panel.view();
  assert.ok(html.includes('학생A'));
  assert.ok(!html.includes('학생X'), '재원 종료 학생은 신호판에 없다');
  assert.ok(!/undefined|\[object Object\]|NaN/.test(html), html.match(/.{40}(undefined|\[object Object\]|NaN).{40}/)?.[0]);
  assert.ok(html.includes('P0'), '8일 연속 미수행 → P0 신호');
  assert.ok(html.includes('data-act="pf-plan"'), 'admin에게 조치 계산 버튼');
  assert.equal(panel.alertCount(), 0, '아직 조치를 만들지 않았다');
  assert.equal(panel.planFor(TODAY), 2, 'S1 P0 contact + S6 teacher_note(이번 주 3일)');
  assert.equal(panel.alertCount(), 1, 'P0만 센다');
  const keys = Object.keys(ch).filter(k => k.startsWith('__act__')).sort();
  assert.deepEqual(keys, ['__act__admin|S1:studyforce:stu_a:' + TODAY, '__act__admin|S6:studyforce:stu_a:' + TODAY], '원장 화면의 조치는 admin 소유');
  const key = keys[0];
  assert.equal(ch[key].st, 'open');
  assert.ok(!ch[key].note.includes('학생A'), '저장 문구에 이름 없음');
  assert.equal(panel.planFor(TODAY), 0, '같은 저녁 두 번 저장해도 중복 없음');
  const again = panel.view();
  assert.ok(again.includes('data-act="pf-act"'), '조치 카드 버튼');
  assert.ok(again.includes('연락됨'));
});

test('input and setup views render, and the staff link shows no save controls', () => {
  panel.setTab('input');
  let html = panel.view();
  assert.ok(html.includes('data-act="pf-stamp"'), 'admin 스탬프 버튼');
  assert.ok(html.includes('data-act="pf-ex"'));
  panel.setTab('setup');
  html = panel.view();
  assert.ok(html.includes('data-act="pf-setup-save"'));
  assert.ok(html.includes('학생B'), '레거시 __opset__ 이름이 표에 있는 학생');
  assert.ok(html.includes('data-sid="stu_b" data-prog="classcard" checked'), '레거시에서 자동 채움');

  globalThis.session = { isAdmin: false, staffId: 'st_1' };
  panel.setTab('input');
  html = panel.view();
  assert.ok(!html.includes('data-act="pf-stamp"'), '개인 링크에는 스탬프 버튼이 없다');
  assert.ok(!html.includes('data-act="pf-ex"'));
  panel.setTab('setup');
  html = panel.view();
  assert.ok(!html.includes('data-act="pf-setup-save"'));
  panel.setTab('board');
  html = panel.view();
  assert.ok(!html.includes('data-act="pf-act"'), '조치 처리 버튼도 admin 전용');
  globalThis.session = { isAdmin: true, staffId: '' };
});

test('legacyOpModal replaces the weekly-count modal only for students with a perfset', () => {
  assert.equal(panel.legacyOpModal('학생B'), false, 'perfset 없음(레거시만) → 옛 경로');
  assert.equal(panel.legacyOpModal('없는학생'), false);
  assert.equal(panel.legacyOpModal('학생A'), true);
  const m = globalThis.modalCalls.pop();
  assert.ok(m.title.includes('학생A'));
  assert.ok(m.body.includes('이번 주') && m.body.includes('지난주'));
  assert.ok(m.foot.includes('data-act="pf-open-tab"'));
  /* 동명이인이면 잠그지 않는다 — 어느 학생의 기록인지 앱이 정하지 않는다 */
  globalThis.rosterDb.students.push({ id: 'stu_c', name: '학생A', grade: '고1', start: '2026-03', end: '' });
  assert.equal(panel.legacyOpModal('학생A'), false);
  globalThis.rosterDb.students.pop();
});

test('roster missing triggers loadRoster and shows a loading card', () => {
  let called = 0;
  globalThis.rosterDb = null;
  globalThis.rosterLoading = false;
  globalThis.loadRoster = () => { called++; };
  const html = panel.view();
  assert.ok(html.includes('불러오는 중'));
  assert.equal(called, 1);
  globalThis.rosterLoading = true;
  panel.view();
  assert.equal(called, 1, '이미 불러오는 중이면 다시 부르지 않는다');
});
