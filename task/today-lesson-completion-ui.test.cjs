const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('일반 선생님 수업 카드는 큰 완료 체크를 숨기고 관리담당은 유지한다', () => {
  const row = source.slice(source.indexOf('function taskRow('), source.indexOf('function taskPanel(', source.indexOf('function taskRow(')));
  assert.match(row, /const showFinalBox = session\.isAdmin \|\| !usesStandardLessonDisplay\(t\)/);
  assert.match(row, /\(showFinalBox \? '<button class="box"/);
});

test('수업은 저장된 done 플래그가 있어도 5개 체크리스트가 다 체크되어야 완료다', () => {
  const start = source.indexOf('function isDone(');
  const end = source.indexOf('function setCheck(', start);
  const factory = new Function('getCheck', 'state', 'taskSteps', 'usesStandardLessonDisplay', 'LESSON_OPERATIONAL_STEP_LABELS',
    source.slice(start, end) + '\nreturn isDone;');
  const task = { id: 'lesson-1' };
  const labels = ['1', '2', '3', '4', '5'];
  let check = { done: true, steps: { 1: true, 2: true, 3: true, 4: true } };
  const isDone = factory(() => check, { tasks: [task] }, () => labels.map(id => ({ id })), () => true, labels);
  assert.equal(isDone(task.id, '2026-08-14'), false);
  check.steps[5] = true;
  assert.equal(isDone(task.id, '2026-08-14'), true);
});

test('관리자 오늘 할 일의 선생님 순서는 김혜지, 김남기, 가나다순, 테스트 순이다', () => {
  const start = source.indexOf('function todayStaffList(');
  const end = source.indexOf('function staffSwitcher(', start);
  const staff = ['테스트 선생님', '박지원', '김남기', '김혜지', '강민지'].map((name, index) => ({ id: String(index), name }));
  const list = new Function('liveStaff', source.slice(start, end) + '\nreturn todayStaffList;')(() => staff)();
  assert.deepEqual(list.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.notEqual(list, staff, '원본 직원 배열은 변경하지 않아야 한다');
  assert.match(source, /return staffById\(viewStaff\) \|\| todayStaffList\(\)\[0\] \|\| null/);
});

test('수업 카드에는 같은 opener 스타일의 이전 수업 메모 버튼이 있다', () => {
  const row = source.slice(source.indexOf('function taskRow('), source.indexOf('function taskPanel(', source.indexOf('function taskRow(')));
  assert.match(row, /class="opener" data-act="prevmemos"/);
  assert.match(row, /이전 수업 메모 보기/);
  assert.match(source, /case 'prevmemos': previousTaskMemosModal\(id, date\)/);
});

test('이전 수업 메모는 같은 수업의 기준일 전 기록만 최신순 20개까지 보여준다', () => {
  const start = source.indexOf('function previousTaskMemos(');
  const end = source.indexOf('function previousTaskMemosModal(', start);
  const checks = {};
  for (let day = 1; day <= 22; day += 1) {
    const date = '2026-07-' + String(day).padStart(2, '0');
    checks['lesson-1|' + date] = { taskId: 'lesson-1', date, note: '메모 ' + day };
  }
  checks['lesson-1|2026-08-14'] = { taskId: 'lesson-1', date: '2026-08-14', note: '오늘 메모' };
  checks['lesson-2|2026-07-30'] = { taskId: 'lesson-2', date: '2026-07-30', note: '다른 수업' };
  checks['lesson-1|2026-07-31'] = { taskId: 'lesson-1', date: '2026-07-31', note: '   ' };
  const previousTaskMemos = new Function('state', source.slice(start, end) + '\nreturn previousTaskMemos;')({ checks });
  const rows = previousTaskMemos('lesson-1', '2026-08-14');
  assert.equal(rows.length, 20);
  assert.equal(rows[0].date, '2026-07-22');
  assert.equal(rows.at(-1).date, '2026-07-03');
  assert.ok(rows.every(row => row.taskId === 'lesson-1' && row.date < '2026-08-14'));
});
