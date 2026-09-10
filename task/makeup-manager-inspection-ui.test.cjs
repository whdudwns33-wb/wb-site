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
  assert.match(source, /showDirectCompletion\s*&&\s*\(session\.isAdmin\s*\|\|\s*\(typeof managerInspectionActive === 'function'\s*&&\s*managerInspectionActive\(\)\)\)/);
  assert.match(source, /mudirectcompleteopen/);
});

test('관리자 점검 모드의 직접 완료 전송은 manager_inspection을 허용한다', () => {
  const start = source.indexOf("if (!session.isAdmin && !(typeof managerInspectionActive === 'function' && managerInspectionActive())) return showMakeupModalError");
  assert.ok(start >= 0);
  assert.match(source.slice(start - 120, start + 180), /managerInspectionActive\(\)/);
});
