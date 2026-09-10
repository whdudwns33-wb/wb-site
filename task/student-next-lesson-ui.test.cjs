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

test('수업진행에는 같은 학생의 다음 수업을 접어서 확인하는 읽기 전용 패널이 있다', () => {
  const panel = block('function taskPanel(t, date, c, editable)', '/** 수업 출결 표시용 */');
  assert.match(panel, /studentNextLessonHtml\(t, date\)/);
  assert.match(source, /student-next-lesson/);
  assert.match(source, /data-persist-key="next-lesson\|/);
  assert.match(source, /다음 수업 확인/);
  assert.match(source, /담당:/);
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

test('다음 수업 패널은 details 열림 상태에서 자동 조회되고 다시 렌더링되어도 유지된다', () => {
  const toggle = block("document.addEventListener('toggle'", "document.addEventListener('change'",);
  assert.match(toggle, /lesson-next-lesson-details/);
  assert.match(toggle, /loadStudentNextLesson\(/);
  assert.match(toggle, /ev\.target\.open/);
});
