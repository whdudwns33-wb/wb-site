const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText + ' 블록');
  return html.slice(start, end);
}

test('보호자 공지는 관리자 설정 안에서 선택 학생을 기본값으로 작성한다', () => {
  const source = block('function guardianAnnouncementsHtml()', '/* ── 보호자 연락처·발송 동의');
  assert.match(source, /data-guardian-announcements/);
  assert.match(source, /const targetType = current \? current\.targetType : 'students'/);
  assert.match(source, /<option value="students"/);
  assert.match(source, /<option value="all"/);
  assert.match(source, /모든 공지는 일정·운영·준비 안내용입니다\. 연락처·주소·상담\/내부 수업 메모를 입력하지 마세요/);
  assert.match(source, /전체 공지에는 학생 이름도 입력하지 마세요/);
  assert.match(html, /backupCard \+ guardianAnnouncementsHtml\(\) \+ viewGuardianContactPanel\(\)/);
  assert.match(html, /backupCard \+[\s\S]*guardianAnnouncementsHtml\(\) \+[\s\S]*관리 비밀번호/);
});

test('공지 저장·게시·종료는 안전한 필드와 revision CAS만 보낸다', () => {
  const source = block('async function saveGuardianAnnouncement', '/* ── 보호자 연락처·발송 동의');
  assert.match(source, /action: 'announcement_save'/);
  assert.match(source, /announcementId, expectedRevision, title, body, publishDate, expiresDate, targetType, studentIds/);
  assert.match(source, /\['announcement_publish', 'announcement_end'\]/);
  assert.match(source, /expectedRevision: Number\(expectedRevision\)/);
  assert.match(source, /이 공지를 전체 보호자에게 공개할까요/);
  assert.doesNotMatch(source, /phone|address|attachment|readReceipt|comment/);
  for (const action of ['garefresh', 'gaadd', 'gaedit', 'gasave', 'gapublish', 'gaend']) {
    assert.match(html, new RegExp("case '" + action + "'"));
  }
});

test('보호자 공개 v4 미리보기는 공지·교재를 escape하고 내부 식별자를 쓰지 않는다', () => {
  const source = block('function parentPreviewHtml(data)', 'async function previewParentPortal');
  assert.match(source, /capabilities\.announcements === true/);
  assert.match(source, /capabilities\.bookStatus === true/);
  assert.match(source, /parentPreviewSection\('Notice', '학원 공지'/);
  assert.match(source, /parentPreviewSection\('Book', '교재 준비·수령'/);
  assert.match(source, /esc\(row\.title \|\| '학원 공지'\)/);
  assert.match(source, /esc\(row\.body \|\| ''\)/);
  assert.match(source, /esc\(row\.label \|\| '상태 확인 중'\)/);
  assert.doesNotMatch(source, /studentIds|announcementId|bookId|taskId|assignmentId|vendor|provider|updatedBy/);
  assert.match(html, /const GUARDIAN_PORTAL_SCOPE_VERSION = 4/);
  assert.match(html, /관리자 미리보기 · 보호자 공개 v4/);
});
