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
