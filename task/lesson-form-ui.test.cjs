const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('task inline application script parses', () => {
  const start = html.lastIndexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start > 7 && end > start);
  assert.doesNotThrow(() => new Function(html.slice(start, end)));
});

test('teachers get an own-scope nine-field lesson route', () => {
  assert.match(html, /\['today', '오늘 할 일'\],[\s\S]{0,180}\['lesson', '수업 등록'\]/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /\['feedback', '피드백 상태'\]/);
  assert.match(html, /lessonDraftStorageKey/);
  assert.match(html, /persistLessonDraft/);
  assert.match(html, /staffId: session\.isStaffLink && !session\.isAdmin \? session\.staffId : ''/);
  assert.match(html, /if \(session\.isStaffLink && !session\.isAdmin\) lessonDraft\.staffId = session\.staffId/);
  assert.match(html, /sync\.post\('\/lesson-create'/);
  for (const key of ['subject', 'className', 'scheduleText', 'materials',
    'onlineProgram', 'homework', 'studentTraits', 'goal', 'parentRequest']) {
    assert.ok(html.includes(`lessonTextField('${key}'`), key);
  }
  assert.match(html, /data-lesson-student/);
  assert.match(html, /stable studentId로 연결합니다/);
});

test('admin publication readiness audit uses server reasons and an explicit stable-student repair flow', () => {
  assert.match(html, /action: 'publication_readiness_list'/);
  assert.match(html, /숙제·준비물 공개 설정 누락 수업/);
  assert.match(html, /publicationReadinessReasonHtml\(row, 'studentId', 'studentId'/);
  assert.match(html, /publicationReadinessReasonHtml\(row, 'staffId', '담당자'/);
  assert.match(html, /publicationReadinessReasonHtml\(row, 'schedule', '시간표'/);
  assert.match(html, /data-publication-student/);
  assert.match(html, /data-act="publicationlessonfix"/);
  assert.match(html, /lessonDraft\.studentId = student\.id/);
  assert.match(html, /lessonDraft\.staffId = row\.taskOwner/);
});

test('guardian publication editor activates only for a confirmed structured slot on today', () => {
  assert.match(html, /task\.taskKind !== 'lesson_instruction'/);
  assert.match(html, /task\.scheduleStatus !== 'confirmed'/);
  assert.match(html, /assignedLessonStudents\(\)\.some\(student => String\(student\.id\) === String\(task\.studentId\)\)/);
  assert.match(html, /task\.scheduleSlots\.some\(slot =>/);
  assert.match(html, /slot\.days\.map\(Number\)\.includes\(weekday\)/);
});

test('lesson edits send sourceTaskId as top-level optimistic-update metadata', () => {
  assert.match(html, /_sourceTaskId: t\.id, _sourceUpdatedAt: Number\(t\.updatedAt \|\| 0\)/);
  assert.match(html,
    /sync\.post\('\/lesson-create', \{[\s\S]{0,220}sourceTaskId: draft\._sourceTaskId \|\| undefined,[\s\S]{0,180}expectedUpdatedAt:[\s\S]{0,120}lesson: lessonPreviewPayload/);
});

test('admin lesson registration requires an explicit teacher selection', () => {
  assert.match(html, /<option value="">선생님을 선택하세요<\/option>/);
  assert.match(html, /if \(session\.isAdmin && !draft\.staffId\) return toast\('담당 선생님을 선택해 주세요'\)/);
});

test('feedback workflow sends immediately only through the server-side guardian gate', () => {
  assert.match(html, /data-act="feedbacksubmit">📱 보호자께 발송/);
  assert.match(html, /카카오 알림톡 발송 요청을 접수합니다/);
  assert.match(html, /보호자 연락처·발송 동의가 등록된 학생만 접수/);
  assert.match(html, /sync\.post\('\/feedback-request'/);
  assert.match(html, /sync\.post\('\/feedback-review'/);
  assert.match(html, /action: 'list', limit: 100/);
  assert.match(html, /원장 수정 요청/);
  assert.match(html, /문구 수정 후 다시 요청/);
  assert.match(html, /if \(res\.status === 'sent'\)/);
  assert.match(html, /보호자 알림톡 발송 요청이 접수됐습니다/);
  assert.match(html, /접수 여부 확인 필요/);
  assert.match(html, /if \(note\.startsWith\('접수 여부 확인 필요'\)\) return '⚠ 접수 여부 확인 — '/);
  assert.match(html, /if \(note\.startsWith\('카카오 발송이 거절되었습니다'\)\) return '발송 거절 — '/);
  assert.match(html, /item\.status === 'content_approved_send_blocked' && sendState\.retry/);
  assert.doesNotMatch(html, /승인 없이 바로 카카오 알림톡이 나갑니다|학부모 피드백 문자/);
  assert.doesNotMatch(html, /보호자께 카카오 알림톡을 보냈습니다|보호자 발송 완료/);
  assert.doesNotMatch(html, /api\.solapi\.com|SOLAPI_SECRET|recipientPhone|phoneNumber/);
});

test('guardian contacts are saved and rendered by stable studentId, not by student name', () => {
  assert.match(html, /new Map\(\(result\.contacts \|\| \[\]\)\.map\(c => \[c\.studentId, c\]\)\)/);
  assert.match(html, /action: 'set', studentId: student\.id,[\s\S]{0,100}studentName: student\.name/);
  assert.match(html, /guardianContacts\.get\(s\.id\)/);
  assert.doesNotMatch(html, /guardianContacts\.get\(s\.name\)/);
});

test('new lesson form core is loaded before the app script', () => {
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
  assert.ok(html.includes('<script src="./lesson-form-core.js?v=' + version.v + '"></script>'),
    'lesson-form-core 의 캐시버스터가 version.json 과 어긋나면 옛 파일이 쓰인다');
});
