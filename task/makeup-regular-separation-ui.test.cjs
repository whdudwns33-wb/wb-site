const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test('보강 투영 수업은 정규수업 판별과 독립되고 오늘 수업 판별은 유지한다', () => {
  const helpers = block('/** 수업 지시서인가', '/** 수업 지시서 제목에서 학생 이름만 뽑는다');
  const api = new Function(`${helpers}\nreturn { isLesson, isScheduledMakeupTask, isRegularLessonTask };`)();
  const regular = { title: '[수업] 정규', taskKind: 'lesson_instruction' };
  const makeup = { title: '[수업] 보강', taskKind: 'lesson_instruction', lessonInstanceType: 'makeup', makeupCaseId: 'mu-a' };
  assert.equal(api.isLesson(regular), true);
  assert.equal(api.isLesson(makeup), true, '오늘 수업·출결·메모용 수업 판별에서는 보강도 수업이다');
  assert.equal(api.isRegularLessonTask(regular), true);
  assert.equal(api.isRegularLessonTask(makeup), false);
});
test('기존 수업 변경·원생 파생·업무 관리·회차제 생성에는 보강 투영 수업을 섞지 않는다', () => {
  const existing = block('function lessonExistingChangeRows(', 'function viewLessonEntry()');
  const roster = block('function studentLessonReferenceItems(', 'function rosterStudentInfoHtml(');
  const rosterView = block('function viewRoster()', '/* ── 직원 관리');
  const manage = block('function manageTasks(', '/* ── 업무 수정');
  const sessionPacks = block('function sessionPackLessonOptions()', 'function sessionPackCreateHtml()');
  assert.match(existing, /filter\(task => isRegularLessonTask\(task\)/);
  assert.match(roster, /if \(!isRegularLessonTask\(task\)/);
  assert.match(roster, /filter\(task => isRegularLessonTask\(task\)/);
  assert.match(rosterView, /some\(task => isRegularLessonTask\(task\)/);
  assert.match(manage, /!isScheduledMakeupTask\(t\)/);
  assert.match(sessionPacks, /!isScheduledMakeupTask\(task\)/);
  assert.match(source, /case 'deltask':[\s\S]{0,180}isScheduledMakeupTask\(t\)/);
});

test('확정됐지만 생성 task가 없는 레거시 보강은 확정 일시를 보여주고 복구한다', () => {
  const actionsSource = block('function makeupActions(', 'function makeupCard(');
  const actions = new Function('session', 'esc', `${actionsSource}\nreturn makeupActions;`)(
    { isAdmin: true, isStaffLink: false }, value => String(value || '')
  );
  const missing = actions({ caseId: 'mu-a', revision: 3, status: 'confirmed', hasLessonTask: false });
  const healthy = actions({ caseId: 'mu-a', revision: 3, status: 'confirmed', hasLessonTask: true });
  assert.match(missing, /data-act="murestoreschedule"[^>]*>보강생성/);
  assert.doesNotMatch(missing, />생성완료</);
  assert.match(healthy, /data-act="mureschedule"[^>]*>보강 수정/);
  assert.equal((healthy.match(/<button/g) || []).length, 3, '확정 카드도 세 동작을 유지한다');

  const modal = block('function makeupDateTimeModal(', 'function makeupNoMakeupModal(');
  assert.match(modal, /mode === 'restore'/);
  assert.match(modal, /확정된 일시는 유지하고 누락된 보강수업 화면만 다시 생성합니다/);
  assert.match(modal, /murestoreschedulesubmit/);
  assert.match(source, /action: 'restore_schedule', caseId: button\.dataset\.case, revision: Number\(button\.dataset\.rev\)/);
  assert.match(source, /case 'murestoreschedule':[\s\S]{0,180}makeupDateTimeModal\([\s\S]{0,100}'restore'\)/);
});
