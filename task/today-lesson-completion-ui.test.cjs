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

test('오늘 탭은 개인 태블릿의 담당자를 앞에 두고 나머지 기존 순서를 유지한다', () => {
  const start = source.indexOf('function todayStaffList(');
  const end = source.indexOf('function staffSwitcher(', start);
  const staff = ['테스트 선생님', '박지원', '김남기', '김혜지', '강민지'].map((name, index) => ({ id: String(index), name }));
  const staffById = id => staff.find(row => row.id === id);
  const factory = session => new Function('liveStaff', 'session', 'staffById',
    source.slice(start, end) + '\nreturn todayStaffList;')(() => staff, session, staffById);

  const directorList = factory({ isStaffLink: false, staffId: '' })();
  const namgiList = factory({ isStaffLink: true, staffId: '2' })();
  const hyejiList = factory({ isStaffLink: true, staffId: '3' })();
  const otherList = factory({ isStaffLink: true, staffId: '1' })();

  assert.deepEqual(directorList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(namgiList.map(row => row.name), ['김남기', '김혜지', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(hyejiList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(otherList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.notEqual(namgiList, staff, '원본 직원 배열은 변경하지 않아야 한다');
  assert.match(source, /return staffById\(viewStaff\) \|\| todayStaffList\(\)\[0\] \|\| null/);
});

test('수업 카드의 이전 수업 메모는 팝업 없이 카드 아래에서 펼쳐진다', () => {
  const row = source.slice(source.indexOf('function taskRow('), source.indexOf('function taskPanel(', source.indexOf('function taskRow(')));
  assert.match(row, /previousTaskMemosInline\(t\.id, date\)/);
  assert.match(source, /<details class="previous-memos"><summary class="opener">이전 수업 메모 보기<\/summary>/);
  assert.doesNotMatch(source, /previousTaskMemosModal|case 'prevmemos'/);
  assert.match(source, /\.previous-memos-body \{ margin-top: 8px;/);
  assert.match(source, /\.opener \{ display: block; width: 100%; text-align: left;/);
});

test('이전 수업 메모는 같은 수업의 기준일 전 기록만 최신순 3개까지 보여준다', () => {
  const start = source.indexOf('function previousTaskMemos(');
  const end = source.indexOf('function previousTaskMemosInline(', start);
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
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2026-07-22');
  assert.equal(rows.at(-1).date, '2026-07-20');
  assert.ok(rows.every(row => row.taskId === 'lesson-1' && row.date < '2026-08-14'));
});

test('이전 수업 메모 인라인 보기는 날짜와 메모를 details 본문에 렌더링한다', () => {
  const start = source.indexOf('function previousTaskMemos(');
  const end = source.indexOf('function taskPanel(', start);
  const state = { checks: {
    'lesson-1|2026-08-13': { taskId: 'lesson-1', date: '2026-08-13', note: '분수 복습 완료' }
  } };
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = new Function('state', 'esc', source.slice(start, end) + '\nreturn previousTaskMemosInline;')(state, esc);
  const html = render('lesson-1', '2026-08-14');
  assert.match(html, /^<details class="previous-memos">/);
  assert.match(html, /2026-08-13/);
  assert.match(html, /분수 복습 완료/);
  assert.doesNotMatch(html, /modalHost|data-act="prevmemos"/);
});
