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

test('teachers get an own-scope three-section lesson route', () => {
  assert.match(html, /\['today', '오늘 할 일'\],[\s\S]{0,180}\['lesson', '수업 등록'\]/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /\['feedback', '피드백 상태'\]/);
  assert.match(html, /lessonDraftStorageKey/);
  assert.match(html, /persistLessonDraft/);
  assert.match(html, /staffId: session\.isStaffLink && !session\.isAdmin \? session\.staffId : ''/);
  assert.match(html, /if \(session\.isStaffLink && !session\.isAdmin\) lessonDraft\.staffId = session\.staffId/);
  assert.match(html, /sync\.post\('\/lesson-create'/);
  for (const key of ['subject', 'className', 'scheduleText']) {
    assert.ok(html.includes(`lessonTextField('${key}'`), key);
  }
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  for (const section of ['4. 교재와 현재 진도', '5. 온라인 프로그램', '6. 숙제 루틴과 수행률',
    '7. 학생 특징', '8. 지금 목표', '9. 특이사항·학부모 요청']) {
    assert.doesNotMatch(view, new RegExp(section.replace('.', '\\.')));
  }
  assert.match(html, /materials: draft\._sourceTaskId \? \(draft\.materials \|\| '없음'\) : '없음'/);
  assert.match(html, /data-lesson-student/);
  assert.match(html, /stable studentId로 연결합니다/);
});

test('admin lesson screen omits the publication-readiness audit', () => {
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.doesNotMatch(view, /publicationReadinessHtml\(\)/);
  assert.doesNotMatch(view, /숙제·준비물 공개 설정 누락 수업/);
});

test('guardian publication editor activates for an assigned stable-student lesson today without schedule-slot requirements', () => {
  const start = html.indexOf('function canEditGuardianPublication(');
  const end = html.indexOf('function normalizeGuardianPublication(', start);
  const block = html.slice(start, end);
  assert.match(block, /!isLesson\(task\)/);
  assert.match(html, /assignedLessonStudents\(\)\.some\(student => String\(student\.id\) === String\(task\.studentId\)\)/);
  assert.doesNotMatch(block, /scheduleStatus|scheduleSlots|weekday/);
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

test('admin direct lesson registration reuses the new-student information fields and saves roster before lesson', () => {
  const viewStart = html.indexOf('function lessonRosterInformationHtml(');
  const viewEnd = html.indexOf('async function loadPublicationReadiness(', viewStart);
  const fields = html.slice(viewStart, viewEnd);
  for (const key of ['name', 'school', 'grade', 'phoneSelf', 'phoneFather', 'phoneMother', 'registrationDate', 'firstClassDate', 'memo']) {
    assert.match(fields, new RegExp(`data-lesson-roster-field="${key}"`), key);
  }
  assert.match(fields, /data-lesson-roster-teacher/);
  for (const subject of ['국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답']) {
    assert.match(html, new RegExp(subject));
  }
  const saveStart = html.indexOf('async function saveLessonRegistration(');
  const saveEnd = html.indexOf('let feedbackQueue', saveStart);
  const save = html.slice(saveStart, saveEnd);
  assert.ok(save.indexOf("sync.post('/roster'") < save.indexOf("sync.post('/lesson-create'"));
  assert.match(save, /action: 'student_update'/);
  assert.match(save, /원생 기본 정보는 저장됐습니다/);
});

test('admin direct lesson registration removes duplicate subject fields and free-text schedule input', () => {
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.match(view, /personal \? '<div class="sect">2\. 과목·반/);
  assert.match(view, /personal \? lessonTextField\('scheduleText',[\s\S]{0,160} : ''/);
  assert.match(view, /\(draft\.scheduleSlots \|\| \[\]\)\.map\(lessonSlotHtml\)/);
  assert.match(view, /<div class="sect">3\. 수업 요일·시간/);
  assert.doesNotMatch(view, /<div class="sect">[4-9]\./);
  assert.match(view, /<details class="card admin-collapsible lesson-direct-entry"><summary><span><b>수업 정보 등록<\/b>/);
  assert.doesNotMatch(view, /lesson-direct-entry" open/);
  assert.match(view, /const reviews = personal \? lessonAssignmentRequestHtml\(\) : viewLessonChangeReview\(\) \+ lessonAssignmentReviewHtml\(\)/);
  assert.match(view, /return directRegistration \+ reviews/);
});

test('admin direct lesson registration reuses the new-student multi-subject selector', () => {
  const subjectStart = html.indexOf('function lessonSubjectSelectionHtml()');
  const subjectEnd = html.indexOf('function lessonRosterInformationHtml()', subjectStart);
  const subjectView = html.slice(subjectStart, subjectEnd);
  assert.match(subjectView, /2\. 등록과목/);
  assert.match(subjectView, /ROSTER_SUBJECT_OPTIONS\.map/);
  assert.match(subjectView, /data-lesson-roster-subject/);
  assert.match(subjectView, /disabled/);
  assert.match(subjectView, /원생 정보와 이번 수업 정보에 함께 반영/);
  const changeStart = html.indexOf("const lessonRosterSubject = ev.target.closest('[data-lesson-roster-subject]')");
  const changeEnd = html.indexOf("const lessonRosterTeacher", changeStart);
  const change = html.slice(changeStart, changeEnd);
  assert.match(change, /info\.subjects = subjects/);
  assert.match(change, /draft\.subject = subjects\.join\('·'\)/);
  assert.match(html, /draft\.subject = lessonPreviewRosterStudent\.subjects\.join\('·'\)/);
});

test('feedback workflow is visibly paused and remains blocked in the stale click handler', () => {
  assert.match(html, /const GUARDIAN_CONTACT_ENABLED = false/);
  assert.doesNotMatch(html, /data-act="feedbacksubmit">📱 보호자께 발송/);
  assert.match(html, /학부모 연락 기능 사용 중지/);
  assert.match(html, /if \(!GUARDIAN_CONTACT_ENABLED\) return toast\('학부모 메시지 발송 기능은 현재 사용하지 않습니다'\)/);
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
