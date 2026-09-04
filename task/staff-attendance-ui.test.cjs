const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return source.slice(start, end);
}

test('teacher card permits initial clock-in and clock-out without edit or cancellation controls', () => {
  const card = block(
    'if (session.isStaffLink && me.id === session.staffId && cursor === today()) {',
    'if (!rosterDb && !rosterErr) loadRoster();'
  );
  assert.match(card, /data-act="attcheck">출근했습니다/);
  assert.match(card, /data-act="attout">퇴근했습니다/);
  assert.match(card, /저장된 출퇴근 기록의 수정은 관리자에게 요청해 주세요/);
  assert.doesNotMatch(card, />취소</);
  assert.doesNotMatch(card, /퇴근 취소|atteditopen|최근 기록 수정/);
});

test('teacher attendance buttons use the dedicated server path and never toggle a saved row locally', () => {
  const submit = block('async function recordStaffAttendance(action, button)', '/** 학생 연락 기록.');
  assert.match(submit, /sync\.post\('\/staff-attendance'/);
  assert.match(submit, /result\.record\.taskId !== attKey\(me\.id\)/);
  assert.doesNotMatch(submit, /setCheck\(|queueSync\(/);

  const actions = block("case 'attcheck':", "case 'atthist':");
  assert.match(actions, /이미 저장된 출근 기록은 관리자만 수정할 수 있습니다/);
  assert.match(actions, /recordStaffAttendance\('clock_in', el\)/);
  assert.match(actions, /이미 저장된 퇴근 기록은 관리자만 수정할 수 있습니다/);
  assert.match(actions, /recordStaffAttendance\('clock_out', el\)/);
  assert.doesNotMatch(actions, /setCheck\(|confirm\(/);
});

test('attendance correction UI and handlers remain available only to administrators', () => {
  assert.match(source, /const canEditAtt = \(\) => session\.isAdmin;/);
  const modal = block('function attEditModal(staffId)', '/** 급여용 출퇴근 내보내기');
  assert.match(modal, /if \(!session\.isAdmin \|\| !s\) return;/);
  assert.match(modal, /관리자는 모든 날짜를 수정할 수 있습니다/);

  const open = block("case 'atteditopen':", "case 'payrollmodal':");
  assert.match(open, /if \(!session\.isAdmin\) break;/);
  const change = block('/* 출퇴근 시각 직접 수정', '/* 엔터 제출 */');
  assert.match(change, /if \(!canEditAtt\(staffId, date\)\)/);
  assert.match(change, /출퇴근 기록은 관리자만 수정할 수 있습니다/);

  const staffAdmin = block('function viewStaffAdmin()', '/* ── 보호자 공지 ── */');
  assert.match(staffAdmin, /data-act="atteditopen"/);
  assert.match(staffAdmin, /🕘 출퇴근 수정/);
});
