const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('function makeupCanEditInstruction');
const end = html.indexOf('function makeupLessonTaskForCase', start);
const source = html.slice(start, end);
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function api(session, values = {}, confirm = () => true) {
  return Function('session', 'esc', 'makeupTeacherLabel', '$', 'confirm', source +
    '; return { render: makeupInstructionHtml, field: makeupInstructionFieldHtml, input: makeupInstructionInput };')(
      session, esc, id => id, id => values[id] || null, confirm);
}
const row = { caseId: 'case-1', currentTeacherId: 'source', confirmedStaffId: 'substitute',
  instructions: { text: '10쪽\n<script>alert(1)</script>', version: 2, authorId: 'source', acknowledged: false } };

test('오늘 수업 카드의 전달사항은 수업진행 접기와 무관하며 메모를 안전하게 표시한다', () => {
  const output = api({ staffId: 'substitute' }).render(row);
  assert.match(output, /보강 수업 전달사항/);
  assert.match(output, /white-space:pre-wrap/);
  assert.match(output, /&lt;script>/);
  assert.doesNotMatch(output, /<script>|<details|muinstructionedit/);
  assert.match(output, /muinstructionack/);
  assert.match(output, /color:#d00000/);
  const cardStart = html.indexOf('  if (makeupLesson) h += makeupInstructionHtml');
  const panelStart = html.indexOf('수업진행', cardStart);
  assert.ok(cardStart > 0 && panelStart > cardStart);
});

test('관리자/원담당은 편집, 보강 담당자는 읽음 처리하며 빈 메모는 패널을 숨긴다', () => {
  assert.match(api({ isAdmin: true }).render(row), /muinstructionedit/);
  assert.match(api({ staffId: 'source' }).render(row), /muinstructionedit/);
  assert.doesNotMatch(api({ staffId: 'source' }).render(row), /muinstructionack/);
  assert.equal(api({ staffId: 'substitute' }).render({ ...row, instructions: {} }), '');
  const read = api({ staffId: 'substitute' }).render({ ...row, instructions: { ...row.instructions, acknowledged: true } });
  assert.doesNotMatch(read, /새 전달사항|muinstructionack/);
  assert.match(read, /확인 완료/);
});

test('다른 담당자에게 빈 메모를 넘길 때만 확인하며 버전과 원문을 저장한다', () => {
  let confirmations = 0;
  const values = { '#muInstruction': { value: '' }, '#muInstructionVersion': { value: '2' } };
  const screen = api({}, values, () => { confirmations++; return false; });
  assert.equal(screen.input('source', 'substitute'), null);
  assert.equal(confirmations, 1);
  assert.deepEqual(screen.input('source', 'source'), { instructionText: '', instructionVersion: 2 });
  values['#muInstruction'].value = '  풀이 확인  ';
  assert.deepEqual(screen.input('source', 'substitute'), { instructionText: '풀이 확인', instructionVersion: 2 });
  assert.equal(confirmations, 1);
  assert.match(screen.field(row), /학부모 피드백에는 자동으로 포함되지 않습니다/);
});
