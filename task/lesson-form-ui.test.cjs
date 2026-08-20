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

test('teachers get an own-scope four-step lesson route', () => {
  assert.match(html, /\['today', '오늘 할 일'\],[\s\S]{0,180}\['lesson', '수업 등록'\]/);
  assert.match(html, /const allowed = \['today', 'week', 'lesson', 'feedback', 'books', 'transport', 'roster'\]/);
  assert.match(html, /\['feedback', '피드백 상태'\]/);
  assert.match(html, /lessonDraftStorageKey/);
  assert.match(html, /persistLessonDraft/);
  assert.match(html, /staffId: session\.isStaffLink && !session\.isAdmin \? session\.staffId : ''/);
  assert.match(html, /if \(session\.isStaffLink && !session\.isAdmin\) lessonDraft\.staffId = session\.staffId/);
  assert.match(html, /sync\.post\('\/lesson-create'/);
  for (const key of ['scheduleText']) {
    assert.ok(html.includes(`lessonTextField('${key}'`), key);
  }
  assert.match(html, /data-lesson-subject/);
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
  assert.match(html, /const teacherReady = !!draft\.studentId && ROSTER_SUBJECT_OPTIONS\.includes/);
  assert.match(html, /data-lesson-field="staffId"' \+ \(teacherReady \? '' : ' disabled'\)/);
  assert.match(html, /if \(session\.isAdmin && !draft\.staffId\) return toast\('담당 선생님을 선택해 주세요'\)/);
  assert.match(html, /선생님으로 자동 지정됩니다/);
  const previewStart = html.indexOf('function previewLessonRegistration()');
  const previewEnd = html.indexOf('function applyCreatedLesson(', previewStart);
  const preview = html.slice(previewStart, previewEnd);
  assert.ok(preview.indexOf('if (!selected)') < preview.indexOf("return toast('이번 수업 과목을 한 개 선택해 주세요')"));
  assert.ok(preview.indexOf("return toast('이번 수업 과목을 한 개 선택해 주세요')") < preview.indexOf("return toast('담당 선생님을 선택해 주세요')"));
});

test('admin direct lesson registration reuses the new-student information fields and saves roster before lesson', () => {
  const viewStart = html.indexOf('function lessonRosterInformationHtml(');
  const viewEnd = html.indexOf('async function loadPublicationReadiness(', viewStart);
  const fields = html.slice(viewStart, viewEnd);
  for (const key of ['name', 'school', 'grade', 'phoneSelf', 'phoneFather', 'phoneMother', 'registrationDate', 'firstClassDate', 'memo']) {
    assert.match(fields, new RegExp(`data-lesson-roster-field="${key}"`), key);
  }
  assert.doesNotMatch(fields, /data-lesson-roster-teacher/);
  assert.match(fields, /lessonList\.map\(item => String\(item\.staffId \|\| ''\)\)/);
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

test('direct lesson registration follows student, subject, teacher, schedule order', () => {
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.match(view, /personal \? lessonTextField\('scheduleText',[\s\S]{0,160} : ''/);
  assert.match(view, /\(draft\.scheduleSlots \|\| \[\]\)\.map\(lessonSlotHtml\)/);
  assert.match(view, /<div class="sect">4\. 수업 요일·시간/);
  assert.doesNotMatch(view, /<div class="sect">[5-9]\./);
  assert.match(view, /학생을 한 번 선택하고 과목·담당·시간표가 다른 수업을 여러 건 일괄 등록/);
  assert.match(view, /batchMode \? lessonBatchRegistrationHtml\(\) : lessonSubjectSelectionHtml\(\) \+ staffSelect/);
  assert.match(view, /lesson-direct-entry"' \+ \(lessonDirectEntryOpen \? ' open' : ''\) \+ '><summary><span><b>수업 정보 등록<\/b>/);
  assert.match(view, /const reviews = personal \? lessonAssignmentRequestHtml\(\) : viewLessonChangeReview\(\) \+ lessonAssignmentReviewHtml\(\)/);
  assert.match(view, /return directRegistration \+ reviews/);
});

test('admin can compose multiple independent lessons for one student and submit one batch', () => {
  const batchStart = html.indexOf('function lessonBatchSlotHtml(');
  const batchEnd = html.indexOf('function viewLessonEntry()', batchStart);
  const batchView = html.slice(batchStart, batchEnd);
  assert.match(batchView, /수업 ' \+ \(index \+ 1\)/);
  assert.match(batchView, /data-lesson-batch-subject/);
  assert.match(batchView, /data-lesson-batch-field="staffId"/);
  assert.match(batchView, /data-lesson-batch-slot="startTime"/);
  assert.match(batchView, /data-act="lessonbatchadd"/);
  assert.match(batchView, /이 학생의 다른 수업 추가/);
  assert.match(batchView, /수업 ' \+ entries\.length \+ '건 일괄 등록 미리보기/);

  const previewStart = html.indexOf('function previewLessonBatchRegistration(');
  const previewEnd = html.indexOf('function previewLessonRegistration()', previewStart);
  const preview = html.slice(previewStart, previewEnd);
  assert.match(preview, /lessonRosterStudentPayload\(selected, draft, entries\)/);
  assert.match(preview, /canonicalLessonIdentity/);
  assert.match(preview, /같은 담당 선생님과 과목의 수업이 중복/);
  assert.match(preview, /data-act="lessonbatchsave"/);

  const saveStart = html.indexOf('async function saveLessonBatchRegistration(');
  const saveEnd = html.indexOf('let feedbackQueue', saveStart);
  const save = html.slice(saveStart, saveEnd);
  assert.ok(save.indexOf("sync.post('/roster'") < save.indexOf("sync.post('/lesson-create-batch'"));
  assert.match(save, /result\.tasks\.forEach\(applyCreatedLesson\)/);
  assert.match(save, /수업 ' \+ result\.createdCount \+ '건을 한 번에 등록했습니다/);
});

test('lesson registration interactions update only the form panel and preserve its open state', () => {
  assert.match(html, /let lessonDirectEntryOpen = false/);
  assert.match(html, /function refreshLessonDirectEntry\(forceOpen\)[\s\S]{0,600}current\.replaceWith\(next\)/);
  assert.match(html, /document\.addEventListener\('toggle',[\s\S]{0,260}lessonDirectEntryOpen = ev\.target\.open/);

  const dayStart = html.indexOf("case 'lessonday':");
  const addStart = html.indexOf("case 'lessonslotadd':", dayStart);
  const deleteStart = html.indexOf("case 'lessonslotdel':", addStart);
  const editStart = html.indexOf("case 'lessonedit':", deleteStart);
  assert.ok(dayStart >= 0 && addStart > dayStart && deleteStart > addStart && editStart > deleteStart);

  const dayHandler = html.slice(dayStart, addStart);
  assert.doesNotMatch(dayHandler, /\brender\(/);
  assert.match(dayHandler, /classList\.toggle\('on'/);

  const addHandler = html.slice(addStart, deleteStart);
  assert.doesNotMatch(addHandler, /\brender\(/);
  assert.match(addHandler, /insertAdjacentHTML\('beforebegin'/);

  const deleteHandler = html.slice(deleteStart, editStart);
  assert.doesNotMatch(deleteHandler, /\brender\(/);
  assert.match(deleteHandler, /refreshLessonDirectEntry\(true\)/);

  const studentStart = html.indexOf("const lessonStudent = ev.target.closest('[data-lesson-student]')");
  const studentEnd = html.indexOf("const onboardingDate", studentStart);
  assert.ok(studentStart >= 0 && studentEnd > studentStart);
  const studentHandler = html.slice(studentStart, studentEnd);
  assert.doesNotMatch(studentHandler, /\brender\(/);
  assert.match(studentHandler, /refreshLessonDirectEntry\(true\)/);

  const batchAddStart = html.indexOf("case 'lessonbatchadd':");
  const batchEnd = html.indexOf("case 'lessonedit':", batchAddStart);
  const batchActions = html.slice(batchAddStart, batchEnd);
  assert.doesNotMatch(batchActions, /\brender\(/);
  assert.match(batchActions, /refreshLessonDirectEntry\(true\)/);
});

test('each lesson selects one subject while preserving the student multi-subject roster', () => {
  const subjectStart = html.indexOf('function lessonSubjectSelectionHtml()');
  const subjectEnd = html.indexOf('function lessonRosterInformationHtml()', subjectStart);
  const subjectView = html.slice(subjectStart, subjectEnd);
  assert.match(subjectView, /2\. 수업 과목 선택/);
  assert.match(subjectView, /ROSTER_SUBJECT_OPTIONS\.map/);
  assert.match(subjectView, /type="radio" name="lesson-course-subject" data-lesson-subject/);
  assert.match(subjectView, /disabled/);
  assert.match(subjectView, /현재 원생 등록과목/);
  assert.match(subjectView, /한 과목만 선택/);
  const changeStart = html.indexOf("const lessonSubject = ev.target.closest('[data-lesson-subject]')");
  const changeEnd = html.indexOf("const lessonStudent", changeStart);
  const change = html.slice(changeStart, changeEnd);
  assert.match(change, /draft\.subject = String\(lessonSubject\.value\)/);
  assert.match(change, /session\.isAdmin\) draft\.staffId = ''/);
  assert.match(change, /refreshLessonDirectEntry\(true\)/);
  assert.doesNotMatch(change, /\brender\(/);
  const payloadStart = html.indexOf('function lessonRosterStudentPayload(');
  const payloadEnd = html.indexOf('function lessonRosterStudentChanged(', payloadStart);
  const payload = html.slice(payloadStart, payloadEnd);
  assert.match(payload, /const rosterSubjects = \(info\.subjects \|\| \[\]\)/);
  assert.match(payload, /const lessonSubjects = lessonList\.map/);
  assert.match(payload, /rosterSubjects\.concat\(lessonSubjects\)/);
  assert.doesNotMatch(html, /draft\.subject = lessonPreviewRosterStudent\.subjects\.join\('·'\)/);
  const studentStart = html.indexOf("const lessonStudent = ev.target.closest('[data-lesson-student]')");
  const studentEnd = html.indexOf('const onboardingDate', studentStart);
  const studentChange = html.slice(studentStart, studentEnd);
  assert.match(studentChange, /if \(studentChanged\)[\s\S]{0,180}draft\.subject = ''/);
  assert.match(studentChange, /if \(session\.isAdmin\) \{[\s\S]{0,100}draft\.staffId = ''/);
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
