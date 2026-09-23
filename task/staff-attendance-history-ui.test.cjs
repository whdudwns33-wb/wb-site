'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.slice(
  html.indexOf('let attendanceHistoryMonth ='),
  html.indexOf('/** 출퇴근 기록 수정')
);

test('recent-14-day entry points are replaced by the monthly attendance calendar', () => {
  assert.equal((html.match(/data-act="atthist"[^>]*>🗓️ 월별 출퇴근 달력/g) || []).length, 2);
  assert.doesNotMatch(html, /전체 출퇴근 이력 \(최근 14일\)/);
  assert.match(source, /modal\('월별 출퇴근 달력'/);
  assert.match(source, /type="month"/);
  assert.match(source, /data-act="atthistmonth"/);
});

test('a selected month is loaded from the authenticated server endpoint', () => {
  assert.match(source, /sync\.post\('\/staff-attendance', \{ app: SYNC_APP, auth, action: 'history', month \}\)/);
  assert.match(source, /월을 바꾸면 최초 저장 기록부터 현재까지 모두 조회할 수 있습니다/);
  assert.match(source, /attendanceHistoryBounds\.earliestMonth/);
  assert.match(source, /attendanceHistoryBounds\.currentMonth/);
  assert.doesNotMatch(source, /Array\.from\(\{ length: 14 \}/);
});

test('each teacher has an expandable seven-column calendar and editable day cells', () => {
  assert.match(source, /<details class="att-calendar-person"/);
  assert.match(source, /<div class="att-calendar-week"><span>일<\/span><span>월<\/span>/);
  assert.match(source, /data-act="atthistdayedit"/);
  assert.match(html, /case 'atthistdayedit'/);
  assert.match(html, /attEditModal\(id, el\.dataset\.date\)/);
  assert.match(html, /\.att-calendar-week, \.att-calendar-grid \{ display: grid; grid-template-columns: repeat\(7/);
});

test('calendar distinguishes complete, missing-out, invalid, no-record, and future days', () => {
  assert.match(html, /\.att-calendar-day\.complete/);
  assert.match(html, /\.att-calendar-day\.missing_out/);
  assert.match(html, /\.att-calendar-day\.invalid/);
  assert.match(source, /row\.status === 'no_record' \? '기록 없음'/);
  assert.match(source, /const status = future \? 'future' : row\.status/);
  assert.match(source, /기록 없음은 결근을 뜻하지 않습니다/);
});

test('monthly copy and existing payroll CSV remain available', () => {
  assert.match(source, /선택 월 결과 복사/);
  assert.match(source, /월별 급여용 CSV 내보내기/);
  assert.match(html, /function payrollCsv\(ym\)/);
});
