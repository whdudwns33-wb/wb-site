const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('관리자는 전체·일부 선생님 실시간 관리자 요청을 작성·수정·종료하고 확인 현황을 본다', () => {
  assert.match(source, /📣 실시간 관리자 요청/);
  assert.match(source, /새 실시간 관리자 요청 작성/);
  assert.match(source, /data-act="adminDirectiveAdd"/);
  assert.match(source, /data-admin-directive-staff/);
  assert.match(source, /모든 선생님/);
  assert.match(source, /일부 선생님 중복 선택/);
  assert.match(source, /선생님별 확인 현황/);
  for (const action of ['adminDirectiveAdd', 'adminDirectiveEdit', 'adminDirectiveSave', 'adminDirectiveEnd']) {
    assert.match(source, new RegExp("case '" + action + "'"));
  }
});

test('학생정보 업무지시 안에서 수업 요청과 실시간 관리자 요청의 현재값·최근 3개 기록을 분리한다', () => {
  const start = source.indexOf('function lessonAdminRequestsHtml(');
  const end = source.indexOf('function adminDirectiveSoundKey(', start);
  const block = source.slice(start, end);
  assert.match(block, /현재 수업 요청/);
  assert.match(block, /지난 수업 요청 보기 · 최신 3개/);
  assert.match(block, /현재 실시간 관리자 요청/);
  assert.match(block, /지난 실시간 관리자 요청 보기 · 최신 3개/);
  assert.match(source, /function pastAdminDirectiveRows[\s\S]*?slice\(0, 3\)/);
});

test('개인 링크는 새 revision을 주기 조회하고 팝업·알림음·확인 이벤트를 사용한다', () => {
  assert.match(source, /setInterval\(\(\) => \{[\s\S]*?loadAdminDirectives\(true, true\)[\s\S]*?\}, 15000\)/);
  assert.match(source, /modal\('실시간 관리자 요청'/);
  assert.match(source, /playAdminDirectiveSound\(\)/);
  assert.match(source, /action: 'opened'/);
  assert.match(source, /action: 'acknowledge'/);
  assert.match(source, /item\.isCurrent && item\.displayStatus === 'active' && !item\.acknowledgedAt/);
});

test('교사 오늘 화면의 받은 관리자 요청은 최신순 최대 5개를 접힌 상태로 표시한다', () => {
  const start = source.indexOf('function teacherReceivedAdminDirectiveRows(');
  const end = source.indexOf('function currentAdminDirectiveRows(', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /adminDirectiveRowsForStaff\(staffId\)\.slice\(0, 5\)/);
  assert.match(block, /data-persist-key="today-admin-directive-received/);
  assert.match(block, /<details/);
  assert.doesNotMatch(block, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(block, /adminDirectiveLessonCard/);
  assert.match(block, /row\.isCurrent && row\.displayStatus === 'active'/);
  assert.match(block, /최신순으로 최대 5개/);
  assert.match(block, /불러오는 중/);
  assert.match(block, /불러오지 못했습니다/);
});

test('관리자 현황판은 실시간 관리자 요청과 학생정보·업무지시의 미확인을 함께 집계한다', () => {
  assert.match(source, /실시간 관리자 요청 미확인/);
  assert.match(source, /학생정보 미확인/);
  assert.match(source, /업무지시 미확인/);
  assert.match(source, /studentChangeAcknowledgementStatusHtml/);
  assert.match(source, /audienceStatus/);
});
