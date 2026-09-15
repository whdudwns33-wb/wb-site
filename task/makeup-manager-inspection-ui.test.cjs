const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('관리자 점검 모드에서 일정 없는 보강의 직접 완료 입력을 열 수 있다', () => {
  const start = source.indexOf('function makeupCanComplete');
  const end = source.indexOf('function makeupLessonTaskForCase', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /session\.isAdmin\s*\|\|\s*\(typeof managerInspectionActive === 'function'\s*&&\s*managerInspectionActive\(\)\s*&&\s*!row\.confirmedDate\s*&&\s*!row\.proposedDate\)/);
  assert.match(source, /showDirectCompletion\s*&&\s*makeupCanComplete\(row\)/);
  assert.match(source, /mudirectcompleteopen/);
  const modalStart = source.indexOf('function makeupDateTimeModal');
  const modalEnd = source.indexOf('function makeupNoMakeupModal', modalStart);
  assert.ok(modalStart >= 0 && modalEnd > modalStart);
  assert.match(source.slice(modalStart, modalEnd), /directCompletion\s*&&\s*!makeupCanComplete\(row\)/,
    '점검 모드에서는 일정 없는 직접 완료 입력 모달을 열 수 있어야 합니다');
});

test('담당자 직접 완료는 공통 권한 검사로 검증한다', () => {
  const start = source.indexOf("if (!makeupCanComplete(row)) return showMakeupModalError");
  assert.ok(start >= 0);
  assert.match(source.slice(start, start + 160), /본인이 담당하는 보강/);
});

test('일정 없는 본인 보강은 후보 조회 없이 완료 입력하고 이전 담당자는 허용하지 않는다', async () => {
  const start = source.indexOf('function makeupCanComplete');
  const end = source.indexOf('function makeupLessonTaskForCase', start);
  const session = { isAdmin: false, isStaffLink: true, staffId: 'teacher-a' };
  const can = Function('session', 'makeupDefaultStaffId', source.slice(start, end) + '; return makeupCanComplete;')(
    session, row => row.currentTeacherId || row.sourceTeacherId);
  const row = { status: 'review_pending', currentTeacherId: 'teacher-a', sourceTeacherId: 'teacher-b' };
  assert.equal(can(row), true);
  assert.equal(can({ ...row, currentTeacherId: 'teacher-b' }), false);
  assert.equal(can({ ...row, status: 'completed' }), false);
  const calls = [];
  const fnStart = source.indexOf('async function openMakeupProcessModal');
  const fnEnd = source.indexOf('async function openMakeupLinkModal', fnStart);
  row.caseId = 'case-a';
  const open = Function('makeupRows', 'makeupCanComplete', 'makeupDateTimeModal', 'openMakeupLinkModal',
    source.slice(fnStart, fnEnd) + '; return openMakeupProcessModal;')([row], can,
    (selected, mode) => calls.push(mode), () => assert.fail('후보 조회가 완료 입력을 막으면 안 된다'));
  await open({ dataset: { case: 'case-a' } });
  assert.deepEqual(calls, ['complete']);
});

test('일정 없는 직접 완료는 날짜·시간을 비워 둔 상태로 전송할 수 있다', () => {
  const start = source.indexOf('function makeupDateTimeInput');
  const end = source.indexOf('async function submitMakeupSchedule', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /allowEmpty/);
  const submitStart = source.indexOf('async function submitMakeupComplete');
  const submitEnd = source.indexOf('async function submitMakeupNoMakeup', submitStart);
  assert.match(source.slice(submitStart, submitEnd), /allowEmpty: row\.status !== 'confirmed'/);
  assert.match(source.slice(submitStart, submitEnd), /timeUnrecorded/);
  const modalStart = source.indexOf('function makeupDateTimeModal');
  const modalEnd = source.indexOf('function makeupNoMakeupModal', modalStart);
  assert.match(source.slice(modalStart, modalEnd), /날짜·시작시간·종료시간을 비워 두면/);
});
