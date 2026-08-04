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
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'roster'\]/);
  assert.match(html, /\['feedback', '피드백 상태'\]/);
  assert.match(html, /lessonDraftStorageKey/);
  assert.match(html, /persistLessonDraft/);
  assert.match(html, /staffId: session\.isStaffLink \? session\.staffId : ''/);
  assert.match(html, /if \(session\.isStaffLink\) lessonDraft\.staffId = session\.staffId/);
  assert.match(html, /sync\.post\('\/lesson-create'/);
  for (const key of ['studentName', 'grade', 'subject', 'className', 'scheduleText', 'materials',
    'onlineProgram', 'homework', 'studentTraits', 'goal', 'parentRequest']) {
    assert.ok(html.includes(`lessonTextField('${key}'`), key);
  }
});

test('lesson edits send sourceTaskId as top-level optimistic-update metadata', () => {
  assert.match(html, /_sourceTaskId: t\.id, _sourceUpdatedAt: Number\(t\.updatedAt \|\| 0\)/);
  assert.match(html,
    /sync\.post\('\/lesson-create', \{[\s\S]{0,220}sourceTaskId: draft\._sourceTaskId \|\| undefined,[\s\S]{0,180}expectedUpdatedAt:[\s\S]{0,120}lesson: lessonPreviewPayload/);
});

test('admin lesson registration requires an explicit teacher selection', () => {
  assert.match(html, /<option value="">선생님을 선택하세요<\/option>/);
  assert.match(html, /if \(!session\.isStaffLink && !draft\.staffId\) return toast\('담당 선생님을 선택해 주세요'\)/);
});

test('feedback workflow asks for director review and never promises delivery', () => {
  assert.match(html, /data-act="feedbacksubmit">원장 검토 요청/);
  assert.match(html, /문구 승인\(발송 아님\)/);
  assert.match(html, /보호자 미연결 · 실제 발송 차단/);
  assert.match(html, /sync\.post\('\/feedback-request'/);
  assert.match(html, /sync\.post\('\/feedback-review'/);
  assert.match(html, /action: 'list', limit: 100/);
  assert.match(html, /원장 수정 요청/);
  assert.match(html, /문구 수정 후 다시 요청/);
  assert.doesNotMatch(html, /api\.solapi\.com|SOLAPI_SECRET|recipientPhone|phoneNumber/);
});

test('new lesson form core is loaded before the app script', () => {
  assert.match(html, /<script src="\.\/lesson-form-core\.js\?v=2026-08-04\.2"><\/script>/);
});
