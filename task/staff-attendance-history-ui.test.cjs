'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('./staff-attendance-history-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('let attendanceHistoryDates = []'), html.indexOf('/** 출퇴근 기록 수정'));
function app(admin = true) {
  const date = '2030-04-05', nodes = new Map(), changes = [], modals = [], copied = [];
  for (const id of ['attHistoryDate', 'attHistoryAll', 'attHistoryStaff', 'attHistoryPrev', 'attHistoryNext', 'attHistoryResults']) {
    nodes.set('#' + id, { value: id === 'attHistoryDate' ? date : '', checked: false, disabled: false, innerHTML: '' });
  }
  const checks = { ['__att__staff-a|' + date]: { done: true, at: Date.parse(date + 'T09:00:00+09:00'), out: Date.parse(date + 'T12:30:00+09:00') } };
  const state = { checks };
  const context = vm.createContext({ window: { WBStaffAttendanceHistoryCore: core }, session: { isAdmin: admin }, state,
    document: { addEventListener: (event, handler) => changes.push(handler) }, $: id => nodes.get(id),
    liveStaff: () => [{ id: 'staff-a', name: '창작가' }, { id: 'staff-b', name: '<img src=x onerror=1>' }],
    today: () => '2030-04-04', seoulNowParts: () => ({ date }), addDays: (d, offset) => new Date(Date.parse(d + 'T12:00:00Z') + offset * 86400000).toISOString().slice(0, 10),
    shortDate: d => d.slice(5), dowOf: d => new Date(d + 'T12:00:00Z').getUTCDay(), DOW: ['일', '월', '화', '수', '목', '금', '토'],
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    toast: () => {}, modal: (...args) => modals.push(args), copy: text => copied.push(text)
  });
  vm.runInContext(source, context);
  return { nodes, changes, modals, copied, state, run: code => vm.runInContext(code, context) };
}
test('opens admin-only readable table with one row per teacher, explicit state labels, and escaped names', () => {
  const ui = app(); ui.run('openAttendanceHistory()');
  const result = ui.nodes.get('#attHistoryResults').innerHTML;
  assert.equal(ui.modals[0][0], '전체 출퇴근 이력');
  assert.match(result, /<th scope="col">출근<\/th>/);
  assert.match(result, /09:00/); assert.match(result, /3시간 30분/);
  assert.match(result, /출퇴근 완료/); assert.match(result, /기록 없음/);
  assert.match(result, /&lt;img/); assert.doesNotMatch(result, /<img/);
  assert.match(ui.modals[0][1], /기록 없음은 결근을 뜻하지 않습니다/);
  assert.match(ui.modals[0][1], /월별 급여용 CSV 내보내기/);
  const teacher = app(false); teacher.run('openAttendanceHistory()');
  assert.equal(teacher.modals.length, 0);
});
test('date and staff filtering redraws only results and never mutates attendance or opens a new modal', () => {
  const ui = app(); const original = JSON.stringify(ui.state); ui.run('openAttendanceHistory()');
  ui.nodes.get('#attHistoryStaff').value = 'staff-a';
  ui.changes[0]({ target: { id: 'attHistoryStaff' } });
  assert.equal(ui.run('attendanceHistoryRows().length'), 1);
  ui.nodes.get('#attHistoryAll').checked = true;
  ui.changes[0]({ target: { id: 'attHistoryAll' } });
  assert.equal(ui.run('attendanceHistoryRows().length'), 14);
  assert.equal(ui.nodes.get('#attHistoryDate').disabled, true);
  assert.equal(ui.nodes.get('#attHistoryPrev').disabled, true);
  assert.equal(ui.modals.length, 1);
  assert.equal(JSON.stringify(ui.state), original);
});
test('navigation cannot leave the last14day window and copying follows the current filter', () => {
  const ui = app(); ui.run('openAttendanceHistory()');
  assert.equal(ui.nodes.get('#attHistoryNext').disabled, true);
  ui.run('shiftAttendanceHistoryDate(1)');
  assert.equal(ui.nodes.get('#attHistoryDate').value, '2030-04-05');
  for (let i = 0; i < 20; i++) ui.run('shiftAttendanceHistoryDate(-1)');
  assert.equal(ui.nodes.get('#attHistoryDate').value, '2030-03-23');
  assert.equal(ui.nodes.get('#attHistoryPrev').disabled, true);
  ui.nodes.get('#attHistoryStaff').value = 'staff-a';
  ui.run('copyAttendanceHistory()');
  assert.match(ui.copied[0], /2030-03-23\t창작가/);
  assert.doesNotMatch(ui.copied[0], /onerror/);
});
test('history dates follow Korea rather than device date, and an empty or invalid date recovers safely', () => {
  const ui = app(); ui.run('openAttendanceHistory()');
  assert.equal(ui.run('attendanceHistoryDates[0]'), '2030-04-05');
  for (const date of ['', '1999-01-01', '2030-04-06']) {
    ui.nodes.get('#attHistoryDate').value = date;
    ui.changes[0]({ target: { id: 'attHistoryDate' } });
    assert.equal(ui.nodes.get('#attHistoryDate').value, '2030-04-05');
    assert.equal(ui.run('attendanceHistoryRows().length'), 2);
  }
});
test('the existing entry points use the visual view while mobile cards and legacy export remain available', () => {
  assert.match(html, /case 'atthist': openAttendanceHistory\(\); break;/);
  assert.equal((html.match(/data-act="atthist"[^>]*>🕘 전체 출퇴근 이력/g) || []).length, 2);
  assert.match(html, /\.att-history-table th \{ position: sticky/);
  assert.match(html, /\.att-history-table tr \{ display: grid/);
  assert.match(html, /function payrollCsv\(ym\)/);
  assert.doesNotMatch(source, /setCheck\(|queueSync\(|sync\.post\(|localStorage/);
});
