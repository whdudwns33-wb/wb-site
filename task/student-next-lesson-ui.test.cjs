const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0, `${from} 시작 지점이 있어야 한다`);
  assert.ok(end > start, `${to} 종료 지점이 있어야 한다`);
  return source.slice(start, end);
}

test('수업진행을 접은 상태에서 일정 메타 옆에 다음 수업 요약이 표시된다', () => {
  const row = block('function taskRow(t, date, editable, isCarry)', 'const LESSON_MEMO_FIELDS');
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(row, /lesson-meta/);
  assert.ok(row.indexOf('lessonAttendanceTag') < row.indexOf('studentNextLessonCompactHtml(t, date)'),
    '현재 출결이 다음 수업 요약보다 먼저 표시되어야 한다');
  assert.match(row, /현재 출결 ·/);
  assert.match(row, /studentNextLessonCompactHtml\(t, date\)/);
  assert.match(source, /function studentNextLessonCompactHtml\(task, date\)/);
  assert.doesNotMatch(panel, /studentNextLessonHtml\(t, date\)/);
  assert.match(source, /다음 수업/);
  assert.match(source, /teacherName \+ ' 선생님'/);
});

test('다음 수업 조회는 taskId·stable studentId·날짜만 보내며 응답을 최소 필드로 검증한다', () => {
  const loader = block('async function loadStudentNextLesson', 'function studentNextLessonHtml');
  assert.match(loader, /sync\.post\('\/student-next-lesson'/);
  assert.match(loader, /taskId:/);
  assert.match(loader, /studentId:/);
  assert.match(loader, /lessonDate:/);
  assert.match(loader, /normalizeNextStudentLessonResult/);
  assert.doesNotMatch(loader, /studentName\s*:|note\s*:|attendance\s*:/);
});

test('다음 수업 요약은 오늘 화면 렌더 뒤 자동 조회되고 폭이 부족하면 한 덩어리로 내려간다', () => {
  assert.match(source, /function queueTodayNextLessonLoads\(\)/);
  assert.match(source, /if \(route === 'today'\) \{[\s\S]{0,140}requestAnimationFrame\(queueTodayNextLessonLoads\)/);
  assert.match(source, /function arrangeLessonNextMeta\(\)/);
  assert.match(source, /lesson-next-below/);
  assert.match(source, /\.lesson-next-compact \{ flex: 0 0 auto/);
  assert.match(source, /\.lesson-next-compact \{ flex-basis: 100%;/);
});
