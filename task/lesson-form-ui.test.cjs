const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function studentLabelHelperSource() {
  const start = html.indexOf('function schoolLevelLabel(school)');
  const end = html.indexOf('function taskRosterStudent(t)', start);
  assert.ok(start >= 0 && end > start, 'student display label helper block exists');
  return html.slice(start, end);
}

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
  assert.doesNotMatch(html, /lessonTextField\('scheduleText'/);
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

test('guardian publication editor activates only for an allowed assigned stable-student lesson today', () => {
  const start = html.indexOf('function canEditGuardianPublication(');
  const end = html.indexOf('function normalizeGuardianPublication(', start);
  const block = html.slice(start, end);
  assert.match(block, /!isLesson\(task\)/);
  assert.match(block, /!guardianContactEnabledFor\(task\.studentId\)/);
  assert.match(html, /assignedLessonStudents\(\)\.some\(student => String\(student\.id\) === String\(task\.studentId\)\)/);
  assert.doesNotMatch(block, /scheduleStatus|scheduleSlots|weekday/);
});

test('lesson edits send sourceTaskId as top-level optimistic-update metadata', () => {
  assert.match(html, /_sourceTaskId: t\.id, _sourceUpdatedAt: Number\(t\.updatedAt \|\| 0\)/);
  assert.match(html,
    /sync\.post\('\/lesson-create', \{[\s\S]{0,220}sourceTaskId: draft\._sourceTaskId \|\| undefined,[\s\S]{0,180}expectedUpdatedAt:[\s\S]{0,120}lesson: lessonPreviewPayload/);
  const previewStart = html.indexOf('function previewLessonRegistration()');
  const previewEnd = html.indexOf('function applyCreatedLesson(', previewStart);
  const preview = html.slice(previewStart, previewEnd);
  assert.match(preview, /const sourceExisting = draft\._sourceTaskId && state\.tasks\.find/);
  assert.match(preview, /!item\.deleted && item\.id === draft\._sourceTaskId/);
  assert.match(preview, /const existing = sourceExisting \|\| state\.tasks\.find/);
  assert.match(preview, /lessonPreviewExpectedUpdatedAt = existing \? Number\(existing\.updatedAt/);
});

test('lesson edits do not turn legacy roster defaults into a common student-change notification', () => {
  const helperStart = html.indexOf('function comparableRosterStudentField(');
  const helperEnd = html.indexOf('async function saveLessonBriefingEditor(', helperStart);
  const rosterStart = html.indexOf('function lessonRosterStudentChanged(');
  const rosterEnd = html.indexOf('async function loadPublicationReadiness(', rosterStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart && rosterStart >= 0 && rosterEnd > rosterStart);
  const helpers = new Function(html.slice(helperStart, helperEnd) + '\n' + html.slice(rosterStart, rosterEnd) +
    '\nreturn { lessonBriefingStudentChanged, lessonRosterStudentChanged };')();
  const legacy = {
    name: '학생', school: '학교', grade: '중2', subject: '수학·영어',
    start: '2026-08', billingMode: undefined, sessionCycleStartDate: undefined
  };
  const materializedDefaults = {
    ...legacy, subject: '영어·수학', subjects: ['영어', '수학'],
    billingMode: 'monthly', sessionCycleStartDate: ''
  };
  assert.equal(helpers.lessonBriefingStudentChanged(legacy, materializedDefaults), false);
  assert.equal(helpers.lessonRosterStudentChanged(legacy, materializedDefaults), false);
  assert.equal(helpers.lessonBriefingStudentChanged(legacy, { ...materializedDefaults, school: '새학교' }), true);
  assert.equal(helpers.lessonRosterStudentChanged(legacy, {
    ...materializedDefaults, billingMode: 'session4', sessionCycleStartDate: '2026-08-29'
  }), true);
});

test('lesson edits keep teacher authority on each lesson and never synthesize a roster-wide teacher list', () => {
  const start = html.indexOf('function lessonRosterStudentPayload(');
  const end = html.indexOf('function lessonRosterStudentChanged(', start);
  const block = html.slice(start, end);
  assert.doesNotMatch(block, /teacherTransfer|teacherIds|lessonList\.map\(item => String\(item\.staffId/);
  assert.match(block, /Object\.assign\(\{\}, selected/);
  assert.match(block, /Object\.assign 원본 그대로 보존/);
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

test('lesson registration teacher choices prioritize Hyeji, Namgi, then Korean name order', () => {
  const start = html.indexOf('function lessonRegistrationStaffList()');
  const end = html.indexOf('function staffSwitcher(', start);
  assert.ok(start >= 0 && end > start);
  const staff = ['박지원', '김남기', '이다온', '김혜지', '강민지'].map((name, index) => ({ id: String(index), name }));
  const factory = new Function('liveStaff', html.slice(start, end) + '\nreturn lessonRegistrationStaffList;')(() => staff);
  assert.deepEqual(factory().map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '이다온']);
  assert.notEqual(factory(), staff, '원본 직원 배열은 변경하지 않아야 한다');

  const batchStart = html.indexOf('function lessonBatchEntryHtml(');
  const batchEnd = html.indexOf('function viewLessonEntry()', batchStart);
  const batch = html.slice(batchStart, batchEnd);
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.match(batch, /lessonRegistrationStaffList\(\)\.map\(staff/);
  assert.match(view, /lessonRegistrationStaffList\(\)\.map\(staff/);
});

test('admin direct lesson registration reuses the new-student information fields and saves roster before lesson', () => {
  const viewStart = html.indexOf('function lessonRosterInformationHtml(');
  const viewEnd = html.indexOf('async function loadPublicationReadiness(', viewStart);
  const fields = html.slice(viewStart, viewEnd);
  for (const key of ['name', 'school', 'grade', 'phoneSelf', 'phoneFather', 'phoneMother', 'registrationDate', 'firstClassDate', 'memo']) {
    assert.match(fields, new RegExp(`data-lesson-roster-field="${key}"`), key);
  }
  assert.doesNotMatch(fields, /data-lesson-roster-teacher/);
  assert.doesNotMatch(fields, /teacherTransfer|teacherIds|lessonList\.map\(item => String\(item\.staffId/);
  for (const subject of ['국어', '영어', '수학', '사회', '과학', '독해사고력', '독해력수업', '독해력훈련', '사고력수학', '질답', '클리닉']) {
    assert.match(html, new RegExp(subject));
  }
  const saveStart = html.indexOf('async function saveLessonRegistration(');
  const saveEnd = html.indexOf('let feedbackQueue', saveStart);
  const save = html.slice(saveStart, saveEnd);
  assert.ok(save.indexOf("sync.post('/roster'") < save.indexOf("sync.post('/lesson-create'"));
  assert.match(save, /action: 'student_update'/);
  assert.match(save, /원생 기본 정보는 저장됐습니다/);
});

test('new lesson starts follow the student first class date without rewriting existing lesson dates', () => {
  const start = html.indexOf('function lessonRegistrationIsoDate(');
  const end = html.indexOf('function normalizeLessonBatchEntry(', start);
  assert.ok(start >= 0 && end > start, 'lesson start helper block exists');
  const helpers = new Function('today', html.slice(start, end) +
    '\nreturn { lessonStudentFirstClassDate, lessonRegistrationStartFloor, lessonFirstClassDateMinimum, ' +
    'raiseLessonRegistrationStart, lessonStartBeforeFirstClassDate, newLessonBatchEntry };')(() => '2026-08-29');
  const future = { firstClassDate: '2026-09-05' };
  const past = { firstClassDate: '2026-08-01' };
  assert.equal(helpers.lessonRegistrationStartFloor(future), '2026-09-05');
  assert.equal(helpers.lessonRegistrationStartFloor(past), '2026-08-29');
  assert.equal(helpers.lessonRegistrationStartFloor([
    { firstClassDate: '2026-09-01' }, future
  ]), '2026-09-05');
  assert.equal(helpers.lessonFirstClassDateMinimum([past, future]), '2026-09-05');
  assert.equal(helpers.raiseLessonRegistrationStart('2026-08-29', future), '2026-09-05');
  assert.equal(helpers.raiseLessonRegistrationStart('2026-09-10', future), '2026-09-10');
  assert.equal(helpers.raiseLessonRegistrationStart('2026-08-10', past), '2026-08-10');
  assert.equal(helpers.lessonStartBeforeFirstClassDate('2026-09-04', future), true);
  assert.equal(helpers.lessonStartBeforeFirstClassDate('2026-09-05', future), false);
  assert.equal(helpers.newLessonBatchEntry('2026-09-05').start, '2026-09-05');

  const studentChangeStart = html.indexOf("const lessonStudent = ev.target.closest('[data-lesson-student]')");
  const studentChangeEnd = html.indexOf('const onboardingDate', studentChangeStart);
  const studentChange = html.slice(studentChangeStart, studentChangeEnd);
  assert.match(studentChange, /draft\.start = lessonRegistrationStartFloor\(student\)/);
  assert.match(studentChange, /draft\.lessonEntries = \[newLessonBatchEntry\(draft\.start\)\]/);
  assert.match(html, /entries\.push\(newLessonBatchEntry\(lessonRegistrationStartFloor\(currentLessonRosterDraft\(\) \|\| lessonDraftSelectedStudent\(\)\)\)\)/);
  assert.match(html, /lessonStartBeforeFirstClassDate\(entries\[index\]\.start, effectiveStudent\)/);
  assert.match(html, /lessonStartBeforeFirstClassDate\(draft\.start, students\)/);
  assert.match(html, /draft\.startDate = lessonRegistrationStartFloor\(student\)/);

  const editStart = html.indexOf('function lessonDraftFromTask(');
  const editEnd = html.indexOf('function lessonTextField(', editStart);
  assert.match(html.slice(editStart, editEnd), /start: t\.start \|\| today\(\)/);
  assert.doesNotMatch(html.slice(editStart, editEnd), /firstClassDate/);
});

test('direct lesson registration puts lesson hours inside every confirmed-time row', () => {
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.doesNotMatch(view, /lessonTextField\('scheduleText'/);
  assert.match(view, /\(draft\.scheduleSlots \|\| \[\]\)\.map\(lessonSlotHtml\)/);
  assert.match(view, /<div class="sect">4\. 수업 요일·시간·시수/);
  assert.doesNotMatch(view, /data-lesson-field="lessonHours"/);
  assert.match(html, /data-lesson-slot="lessonHours"/);
  assert.doesNotMatch(view, /<div class="sect">[5-9]\./);
  assert.match(view, /학생 1명의 여러 수업 또는 한 개 수업의 여러 학생을 선택해 일괄 등록/);
  assert.match(view, /studentBatchMode \? lessonStudentBatchRegistrationHtml\(\) : studentFields/);
  assert.match(view, /lesson-direct-entry"' \+ \(lessonDirectEntryOpen \? ' open' : ''\) \+ '><summary><span><b>수업 등록<\/b>/);
  assert.match(view, /lesson-existing-change"' \+ \(lessonExistingChangeOpen \|\| editing \? ' open' : ''\) \+ '><summary><span><b>기존 수업 변경<\/b>/);
  assert.match(view, /registration[\s\S]*lessonAssignmentReviewHtml\(\)/);
  assert.match(view, /existingChange[\s\S]*viewLessonChangeReview\(\)/);
  assert.match(view, /return registration \+ existingChange/);
});

test('all lesson registration paths use per-time lesson hours and Monday-first weekday controls', () => {
  for (const option of ['1T', '1.5T', '2T', '2.5T', '3T', '3.5T', '4T', '4.5T', '5T', '6T']) {
    assert.match(html, new RegExp(`['"]${option.replace('.', '\\.')}['"]`), option);
  }
  assert.match(html, /data-lesson-slot="lessonHours"/);
  assert.match(html, /data-lesson-batch-slot="lessonHours"/);
  assert.match(html, /data-assignment-slot="lessonHours"/);
  assert.match(html, /data-roster-return-hours/);
  assert.doesNotMatch(html, /data-lesson-briefing-hours|id="eLessonHours"|data-assignment-hours/);
  assert.match(html, /const DOW_DISPLAY_ORDER = \[1, 2, 3, 4, 5, 6, 0\]/);
  assert.match(html, /function groupedScheduleSlotsForDisplay\(slots, fallbackLessonHours\)/);
  assert.match(html, /lessonAssignmentScheduleText\(taskBody\.scheduleSlots, taskBody\.lessonHours\)/);
});

test('lesson card metadata renders each grouped weekday-time-hours schedule', () => {
  const card = html.slice(html.indexOf("const lesson = isLesson(t);"), html.indexOf("'<div class=\"task-actions\">", html.indexOf("const lesson = isLesson(t);")));
  assert.match(card, /lessonScheduleMetaHtml\(t\)/);
  assert.match(html, /groupedScheduleSlotsForDisplay\(task && task\.scheduleSlots, task && task\.lessonHours\)/);
});

test('admin lesson registration and existing changes are separate collapsed panels with a blank default', () => {
  const viewStart = html.indexOf('function viewLessonEntry()');
  const viewEnd = html.indexOf('function lessonInputPayload()', viewStart);
  const view = html.slice(viewStart, viewEnd);
  assert.match(html, /let lessonDirectEntryOpen = false;[\s\S]{0,100}let lessonExistingChangeOpen = false;[\s\S]{0,100}let lessonExistingSearchQuery = ''/);
  assert.match(html, /function resetLessonRegistrationDraft\(\)[\s\S]{0,420}lessonDraft = newLessonDraft\(\)/);
  assert.match(html, /function prepareAdminLessonRoute\(nextRoute\)[\s\S]{0,500}resetLessonRegistrationDraft\(\)[\s\S]{0,200}lessonExistingSearchQuery = ''/);
  assert.match(view, /<b>수업 등록<\/b>/);
  assert.match(view, /<b>기존 수업 변경<\/b>/);
  assert.match(view, /data-lesson-existing-search/);
  assert.match(view, /placeholder="선생님 이름 또는 학생 이름"/);
  assert.match(html, /case 'lessonedit':[\s\S]{0,500}lessonDirectEntryOpen = false;[\s\S]{0,100}lessonExistingChangeOpen = true/);
  assert.match(html, /case 'lessoneditcancel':[\s\S]{0,300}resetLessonRegistrationDraft\(\)/);
});

test('existing lesson search finds editable tasks by teacher or student name and edits by task id', () => {
  const start = html.indexOf('function lessonExistingSearchKey(');
  const end = html.indexOf('function viewLessonEntry()', start);
  assert.ok(start >= 0 && end > start);
  const tasks = [
    { id: 'lesson-a', studentId: 'student-a', studentName: 'Legacy Alpha', staffId: 'teacher-a', subject: '수학', scheduleText: '월 18:00-19:50', lessonFormVersion: 1 },
    { id: 'lesson-b', studentId: 'student-b', studentName: 'Student Beta', staffId: 'teacher-b', subject: '영어', scheduleText: '화 19:00-20:00', lessonFormVersion: 1 },
    { id: 'makeup-a', studentId: 'student-a', studentName: 'Student Alpha', staffId: 'teacher-a', subject: '수학', lessonFormVersion: 1, lessonInstanceType: 'makeup', makeupCaseId: 'mu-a' },
    { id: 'deleted', studentId: 'student-a', staffId: 'teacher-a', deleted: true, lessonFormVersion: 1 },
    { id: 'general', studentId: 'student-a', staffId: 'teacher-a' }
  ];
  const students = [
    { id: 'student-a', name: 'Student Alpha', school: 'WB Middle', grade: 'G2' },
    { id: 'student-b', name: 'Student Beta', school: 'WB Primary', grade: 'G6' },
    { id: 'student-same-name', name: 'Student Alpha', school: 'Other School', grade: 'G3' }
  ];
  const staff = { 'teacher-a': { name: 'Teacher One' }, 'teacher-b': { name: 'Teacher Two' } };
  const helpers = new Function('session', 'rosterDb', 'state', 'isLesson', 'isRegularLessonTask', 'canEditLessonTask', 'staffById', 'studentOf',
    'lessonAssignmentScheduleText', 'esc', studentLabelHelperSource() + html.slice(start, end) +
    '\nreturn { lessonExistingChangeRows, lessonExistingChangeResultsHtml };')(
      { isAdmin: true }, { students }, { tasks }, task => !!task.lessonFormVersion,
      task => !!task.lessonFormVersion && !task.deleted && task.lessonInstanceType !== 'makeup' && !task.makeupCaseId, task => !!task.lessonFormVersion,
      id => staff[id] || null, task => task.studentName || '', () => '', value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    );
  assert.deepEqual(helpers.lessonExistingChangeRows('Teacher One').map(row => row.task.id), ['lesson-a']);
  assert.deepEqual(helpers.lessonExistingChangeRows('Student Alpha').map(row => row.task.id), ['lesson-a']);
  assert.deepEqual(helpers.lessonExistingChangeRows('Teacher Two').map(row => row.task.id), ['lesson-b']);
  assert.deepEqual(helpers.lessonExistingChangeRows('').map(row => row.task.id), []);
  const rendered = helpers.lessonExistingChangeResultsHtml('Student Alpha');
  assert.match(rendered, /Student Alpha · WB Middle · G2/);
  assert.match(rendered, /Teacher One 선생님/);
  assert.match(rendered, /data-act="lessonedit" data-id="lesson-a"/);
  assert.doesNotMatch(rendered, /Other School|deleted|general/);
  assert.doesNotMatch(rendered, /makeup-a/);
  const helperSource = html.slice(start, end);
  assert.match(helperSource, /students\.find\(item => String\(item\.id\) === String\(task\.studentId \|\| ''\)\)/);
  assert.doesNotMatch(helperSource, /students\.find\([^\n]*name/);
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

test('admin can select multiple stable students and register one shared lesson in a batch', () => {
  const batchStart = html.indexOf('function lessonRegistrationModeHtml(');
  const batchEnd = html.indexOf('function lessonExistingSearchKey(', batchStart);
  const view = html.slice(batchStart, batchEnd);
  assert.match(view, /data-act="lessonregistrationmode" data-mode="students"/);
  assert.match(view, /수업 일괄 등록 · 여러 학생/);
  assert.match(view, /data-lesson-bulk-search/);
  assert.match(view, /data-lesson-bulk-student value=/);
  assert.match(view, /rosterStudentIdentityLabel\(student\)/);
  assert.match(view, /한 번에 최대 50명/);
  assert.match(view, /data-act="lessonbulkselectvisible"/);
  assert.match(view, /data-act="lessonbulkclear"/);
  assert.match(view, /\(draft\.scheduleSlots \|\| \[\]\)\.map\(lessonSlotHtml\)/);

  const previewStart = html.indexOf('function previewLessonStudentBatchRegistration(');
  const previewEnd = html.indexOf('function previewLessonBatchRegistration(', previewStart);
  const preview = html.slice(previewStart, previewEnd);
  assert.match(preview, /new Set\(\(draft\.bulkStudentIds \|\| \[\]\)\.map\(String\)\)/);
  assert.match(preview, /lessonStudentBatchRosterPayload\(student, draft\)/);
  assert.match(preview, /lessonBatchInputPayload\(draft, student\)/);
  assert.match(preview, /선택 ' \+ studentNames\.length \+ '명에게 수업 일괄 등록/);

  const saveStart = html.indexOf('async function saveLessonBatchRegistration(');
  const saveEnd = html.indexOf('let feedbackQueue', saveStart);
  const save = html.slice(saveStart, saveEnd);
  assert.match(preview, /lessonPreviewBatchKind = 'students'/);
  assert.match(save, /const previewBatchKind = lessonPreviewBatchKind/);
  assert.ok(save.indexOf('const previewBatchKind = lessonPreviewBatchKind') < save.indexOf("sync.post('/roster'"));
  assert.match(save, /batchKind: previewBatchKind/);
  assert.match(save, /for \(const rosterStudent of rosterCandidates\)/);
  assert.match(save, /previewBatchKind === 'students' \? \[\]/);
  assert.match(save, /previewBatchKind === 'students' \|\| result\.rosterUpdated/);
  assert.match(save, /rosterDb = null/);
});

test('lesson registration interactions update only the form panel and preserve its open state', () => {
  assert.match(html, /let lessonDirectEntryOpen = false/);
  assert.match(html, /function refreshLessonDirectEntry\(forceOpen\)[\s\S]{0,900}current\.replaceWith\(next\)/);
  assert.match(html, /document\.addEventListener\('toggle',[\s\S]{0,700}lessonDirectEntryOpen = ev\.target\.open/);
  assert.match(html, /document\.addEventListener\('toggle',[\s\S]{0,900}lessonExistingChangeOpen = ev\.target\.open/);
  assert.match(html, /querySelector\('\.lesson-form-panel'\)/);

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

test('lesson time inputs sync on input, change, and immediately before preview', () => {
  const helperStart = html.indexOf('function lessonClockLabel(');
  const helperEnd = html.indexOf('function captureRenderedLessonScheduleInputs()', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const singleDraft = { scheduleSlots: [{ days: [6], startTime: '', endTime: '', lessonHours: '' }] };
  const batchEntries = [{ scheduleSlots: [{ days: [0], startTime: '', endTime: '', lessonHours: '' }] }];
  const helpers = new Function('currentLessonDraft', 'lessonBatchEntries', 'DOW', 'DOW_DISPLAY_ORDER', 'esc', 'lessonHoursOptionsHtml',
    html.slice(helperStart, helperEnd) + '\nreturn { lessonClockLabel, lessonClockSummary, lessonSlotHtml, lessonBatchSlotHtml, syncRenderedLessonScheduleField };')(
      () => singleDraft, () => batchEntries, ['일', '월', '화', '수', '목', '금', '토'], [1, 2, 3, 4, 5, 6, 0], value => String(value || ''),
      value => '<option>' + String(value || '') + '</option>');
  assert.equal(helpers.lessonClockLabel('00:00'), '오전 12:00 (00:00)');
  assert.equal(helpers.lessonClockLabel('12:00'), '오후 12:00 (12:00)');
  assert.equal(helpers.lessonClockLabel('18:50'), '오후 6:50 (18:50)');
  assert.equal(helpers.lessonClockLabel(''), '미선택');
  assert.match(helpers.lessonSlotHtml({ days: [1], startTime: '09:00', endTime: '10:50' }, 0),
    /data-lesson-time-display aria-live="polite">선택 결과 · 오전 9:00 \(09:00\) → 오전 10:50 \(10:50\)/);
  assert.match(helpers.lessonSlotHtml({ days: [1], startTime: '09:00', endTime: '10:50', lessonHours: '2T' }, 0),
    /data-lesson-slot="lessonHours"/);
  assert.match(helpers.lessonBatchSlotHtml({ days: [2], startTime: '13:00', endTime: '14:50' }, 0, 0),
    /data-lesson-time-display aria-live="polite">선택 결과 · 오후 1:00 \(13:00\) → 오후 2:50 \(14:50\)/);
  assert.match(helpers.lessonBatchSlotHtml({ days: [2], startTime: '13:00', endTime: '14:50', lessonHours: '2T' }, 0, 0),
    /data-lesson-batch-slot="lessonHours"/);
  const target = (selector, dataset, value) => {
    const display = { textContent: '' };
    const row = { querySelector(query) { return query === '[data-lesson-time-display]' ? display : null; } };
    return {
    dataset, value,
      display,
      closest(query) { return query === selector ? this : query === '.lesson-slot' ? row : null; }
    };
  };
  const singleField = target('[data-lesson-slot]', { i: '0', lessonSlot: 'startTime' }, '10:00');
  assert.equal(helpers.syncRenderedLessonScheduleField(singleField), true);
  assert.equal(singleDraft.scheduleSlots[0].startTime, '10:00');
  assert.equal(singleField.display.textContent, '선택 결과 · 오전 10:00 (10:00) → 미선택');
  const batchField = target('[data-lesson-batch-slot]', {
    lessonI: '0', slotI: '0', lessonBatchSlot: 'endTime'
  }, '11:50');
  assert.equal(helpers.syncRenderedLessonScheduleField(batchField), true);
  assert.equal(batchEntries[0].scheduleSlots[0].endTime, '11:50');
  assert.equal(batchField.display.textContent, '선택 결과 · 미선택 → 오전 11:50 (11:50)');
  const hoursField = target('[data-lesson-slot]', { i: '0', lessonSlot: 'lessonHours' }, '1.5T');
  assert.equal(helpers.syncRenderedLessonScheduleField(hoursField), true);
  assert.equal(singleDraft.scheduleSlots[0].lessonHours, '1.5T');

  const captureStart = helperEnd;
  const previewStart = html.indexOf('function previewLessonRegistration()', captureStart);
  const previewEnd = html.indexOf('function applyCreatedLesson(', previewStart);
  assert.match(html.slice(captureStart, previewStart), /querySelectorAll\('\.lesson-form-panel \[data-lesson-slot\], \.lesson-form-panel \[data-lesson-batch-slot\]'\)/);
  const preview = html.slice(previewStart, previewEnd);
  assert.ok(preview.indexOf('captureRenderedLessonScheduleInputs()') < preview.indexOf('const draft = lessonInputPayload()'));
  assert.equal((html.match(/syncRenderedLessonScheduleField\(ev\.target\)/g) || []).length, 2,
    'input과 change 이벤트가 모두 시간값을 저장해야 한다');
  assert.match(html, /\.lesson-time-display \{[^}]*font-size: 15px;[^}]*font-weight: 900/);
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

test('parent feedback is enabled for all students without enabling the other guardian-contact features', () => {
  assert.match(html, /const GUARDIAN_CONTACT_ENABLED = false/);
  assert.match(html, /const PARENT_FEEDBACK_ALL_STUDENTS_ENABLED = true/);
  assert.match(html, /let guardianDeliveryStudentIds = new Set\(\)/);
  assert.match(html, /function guardianContactEnabledFor\(studentId\)/);
  assert.match(html, /function parentFeedbackEnabledFor\(studentId\)/);
  assert.match(html, /PARENT_FEEDBACK_ALL_STUDENTS_ENABLED \|\| guardianContactEnabledFor\(studentId\)/);
  assert.match(html, /applyGuardianDeliveryStudentIds\(result\.deliveryEnabledStudentIds\)/);
  assert.match(html, /data-act="feedbackpolish">코멘트만 AI 다듬기/);
  assert.match(html, /data-act="feedbackfinalsend">최종 전송/);
  assert.match(html, /전체 원생 학부모 피드백 사용 중/);
  assert.match(html, /이 학생은 학부모 피드백 전달 허용 대상이 아닙니다/);
  assert.match(html, /id="feedbackFinalSendStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(html, /<button class="btn btn-primary btn-block mt8" disabled>최종 전송<\/button>/);
  assert.match(html, /confirm\('저장된 보호자 연락처로 수업 피드백 알림톡을 실제 발송할까요\?'\)/);
  assert.match(html, /sync\.post\('\/feedback-request'/);
  assert.match(html, /sync\.post\('\/feedback-review'/);
  assert.match(html, /action: 'list', limit: 100/);
  assert.match(html, /원장 수정 요청/);
  assert.match(html, /문구 수정 후 다시 요청/);
  assert.match(html, /if \(res\.status === 'sent'\)/);
  assert.match(html, /보호자 알림톡 발송 요청이 접수됐습니다/);
  assert.match(html, /접수 여부 확인 필요/);
  assert.match(html, /const category = feedbackDeliveryCategory\(item\)/);
  assert.match(html, /if \(category === 'unknown'\) return '⚠ 상태 확인 필요 — '/);
  assert.match(html, /if \(category === 'failed'\) return '발송 실패 — '/);
  assert.match(html, /item\.status === 'content_approved_send_blocked'[\s\S]{0,260}data-act="fbsend"/);
  assert.doesNotMatch(html, /sendState\.retry/);
  assert.doesNotMatch(html, /승인 없이 바로 카카오 알림톡이 나갑니다|학부모 피드백 문자/);
  assert.doesNotMatch(html, /보호자께 카카오 알림톡을 보냈습니다|보호자 발송 완료/);
  assert.doesNotMatch(html, /api\.solapi\.com|SOLAPI_SECRET|recipientPhone|phoneNumber/);
});

test('feedback v2 preview uses the fixed approved template and keeps send fields from lesson records', () => {
  const computeStart = html.indexOf('function computeFeedbackFields(');
  const previewStart = html.indexOf('function showFeedbackPreview(', computeStart);
  const previewEnd = html.indexOf('function todayStaffList(', previewStart);
  const submitStart = html.indexOf('async function submitFeedbackForReview(');
  const submitEnd = html.indexOf('async function reviewFeedbackRequest(', submitStart);
  const compute = html.slice(computeStart, previewStart);
  const preview = html.slice(previewStart, previewEnd);
  const submit = html.slice(submitStart, submitEnd);
  assert.match(compute, /lessonMemoValues\(c\)/);
  assert.match(compute, /memo\.contentProgress[\s\S]*doneSteps\.length[\s\S]*taskCardDetail\(t\)/);
  assert.doesNotMatch(preview, /id="fldContent"|<label class="fl">오늘 배운 내용<\/label>/);
  assert.match(preview, /templateVersion: templateVersion,[\s\S]*contentText: feedbackFlatField/);
  assert.match(preview, /baseCommentText: String\(fields\.baseCommentText \|\| initialCommentText\)/);
  assert.match(preview, /templateVersion === 'v2' \? ' readonly'/);
  for (const field of ['subjectText', 'contentText', 'homeworkText', 'commentText']) {
    assert.match(preview, new RegExp('data-feedback-final-field="' + field + '"'),
      field + ' 최종 발송 변수를 직접 수정할 수 있어야 한다');
  }
  assert.match(preview, /승인 템플릿과[^']*발송 변수로 만든 최종 미리보기입니다/);
  assert.match(preview, /아래 네 항목만 실제 알림톡 변수로 전송됩니다/);
  assert.match(preview, /data-act="feedbackpolish">코멘트만 AI 다듬기/);
  assert.match(preview, /data-act="feedbackfinalsend">최종 전송/);
  assert.match(submit, /const contentText = String\(fbCtx\.contentText \|\| ''\)\.trim\(\)/);
  assert.match(submit, /templateVersion: templateVersion/);
  assert.match(submit, /homeworkText: fbCtx\.homeworkText, commentText: fbCtx\.commentText/);
  assert.doesNotMatch(submit, /#fldContent/);
});

test('feedback v2 has 100+ formal base sentences and renders the requested fixed template', () => {
  assert.ok(html.includes('placeholder="예) ___ (하)는 모습을 보였습니다"'));
  const bankStart = html.indexOf('const FB_FORMAL_OPENERS');
  const bankEnd = html.indexOf('/** 학생이 보는 교재', bankStart);
  const bank = html.slice(bankStart, bankEnd);
  const templateStart = html.indexOf('function feedbackV2Message(');
  const templateEnd = html.indexOf('/** 새 알림톡 v2', templateStart);
  const template = html.slice(templateStart, templateEnd);
  assert.match(bank, /formalFeedbackSentenceCount\(\) < 100/);
  assert.match(bank, /function formalizeDirectFeedback/);
  assert.match(bank, /\[\/했어요\$\/, '했습니다'\]/);
  assert.match(bank, /const FB_DIRECT_SOFT_PATTERNS/);
  assert.doesNotMatch(bank, /선생님이 직접 기록한 핵심 내용은|[“”]/);
  assert.match(template, /안녕하세요, WB 웩슬러브레인센터\(독해력학원\) 입니다\./);
  assert.match(template, /학생의 오늘 수업 피드백을 정리해 보내드립니다/);
  for (const label of ['- 일시 : ', '- 과목 : ', '- 수업내용 · 진도 : ', '- 과제 : ', '- 코멘트 : ']) {
    assert.ok(template.includes(label), label);
  }
  assert.match(template, /문의 사항이 있으시면 학원으로 연락부탁드립니다\. 감사합니다\./);
  const templateFunctionEnd = html.indexOf('\n}', templateStart) + 2;
  const renderTemplate = Function(
    "const studentOf = task => task.studentName; const feedbackDateLabel = () => '2026년 9월 1일';\n" +
    html.slice(templateStart, templateFunctionEnd) + '; return feedbackV2Message;'
  )();
  assert.equal(renderTemplate({ studentName: '테스트학생' }, '2026-09-01', {
    subjectText: '국어', contentText: '비문학 중심 내용 찾기',
    homeworkText: '어휘 10개 복습', commentText: '근거를 찾아 설명했습니다.'
  }), '안녕하세요, WB 웩슬러브레인센터(독해력학원) 입니다.\n\n' +
    '테스트학생 학생의 오늘 수업 피드백을 정리해 보내드립니다.\n\n' +
    '- 일시 : 2026년 9월 1일\n\n' +
    '- 과목 : 국어\n\n' +
    '- 수업내용 · 진도 : 비문학 중심 내용 찾기\n\n' +
    '- 과제 : 어휘 10개 복습\n\n' +
    '- 코멘트 : 근거를 찾아 설명했습니다.\n\n' +
    '문의 사항이 있으시면 학원으로 연락부탁드립니다. 감사합니다.');
  assert.match(html, /const studentKey = String\(t\.studentId \|\| studentOf\(t\) \|\| ''\)/);
  assert.match(html, /buildFormalFeedbackComment\(fbCtx \|\| \{\}, seed, studentOf\(t\), date, studentKey\)/);
  const helpers = Function("const seedPick = (rows, seed, slot) => rows[Math.abs(slot) % rows.length];\n" + bank +
    '; return { count: formalFeedbackSentenceCount(), formalize: formalizeDirectFeedback, ' +
    'givenName: studentGivenName, subject: feedbackStudentSubject, possessive: feedbackStudentPossessive, neutralize: neutralizeStudentNameInFeedback, ' +
    'directSentence: feedbackDirectStudentSentence, dailyPick: feedbackDailyRotatingPick, closings: FB_FORMAL_CLOSINGS, ' +
    'focus: FB_FORMAL_FOCUS, namedOpeners: FB_FORMAL_NAMED_OPENERS, build: buildFormalFeedbackComment };')();
  assert.ok(helpers.count >= 100, '격식체 기본 문장이 실제로 100개 이상이어야 한다');
  assert.equal(helpers.closings.length, 100, '마무리 문장은 정확히 100개여야 한다');
  assert.equal(new Set(helpers.closings).size, 100, '마무리 문장 100개가 서로 달라야 한다');
  assert.ok(helpers.closings.every(sentence => /습니다\.$/.test(sentence)), '마무리 문장은 모두 격식체여야 한다');
  assert.ok(helpers.closings.every(sentence => sentence.length <= 50), '마무리 문장이 코멘트 예산을 지나치게 차지하면 안 된다');
  assert.ok(!helpers.closings.includes('확인된 강점은 더욱 발전시키고 필요한 부분은 차근차근 보완하겠습니다.'));
  assert.equal(helpers.formalize('집중을 잘했어요'), '수업 중 집중력을 안정적으로 유지하며 학습에 성실하게 참여했습니다.');
  assert.equal(helpers.formalize('스스로 설명해요'), '스스로 설명합니다.');
  assert.equal(helpers.formalize('어휘 정리'), '어휘 정리.',
    '안전하게 격식체로 바꾸지 못하는 짧은 메모는 임의 사실을 붙이지 않고 원문을 유지한다');
  assert.equal(helpers.formalize('자꾸 산만함'), '수업 중 집중력을 유지하는 데 다소 어려움이 있었습니다.');
  assert.equal(helpers.formalize('설명을 잘했지만 계산 실수도 있었어요'),
    '설명을 잘했지만 계산 실수도 있었습니다.', '복합문의 두 관찰을 모두 보존해야 한다');
  assert.equal(helpers.formalize('설명을 잘했고 계산 실수도 있었음'),
    '설명을 잘했고 계산 실수도 있었습니다.', '`...했고` 복합문의 두 관찰을 보존하며 인식 가능한 어미만 격식체로 바꿔야 한다');
  assert.equal(helpers.formalize('집중 잘함 숙제 안함'),
    '수업 중 집중력을 안정적으로 유지하며 학습에 성실하게 참여했습니다. 숙제 준비가 충분하지 않은 부분이 있었습니다.',
    '짧은 복합 메모가 여러 soft pattern에 일치하면 원문 순서대로 모든 관찰을 남겨야 한다');
  assert.equal(helpers.formalize('집중 잘함 계산 실수 많음'),
    '수업 중 집중력을 안정적으로 유지하며 학습에 성실하게 참여했습니다. 계산 과정에서 실수가 여러 차례 나타나 정확도를 조금 더 보완할 필요가 있었습니다.',
    '집중과 계산 실수 관찰을 둘 다 보존해야 한다');
  assert.equal(helpers.formalize('숙제 잘함 숙제 안함'),
    '숙제를 성실하게 준비해 와 수업 내용을 안정적으로 이어갈 수 있었습니다. 숙제 준비가 충분하지 않은 부분이 있었습니다.',
    '동일한 주제의 서로 다른 두 관찰도 greedy 매칭으로 하나가 사라지면 안 된다');
  assert.equal(helpers.formalize('집중 잘함 발표 소극적'), '집중 잘함 발표 소극적.',
    'soft pattern이 덮지 못한 관찰이 남으면 매칭된 첫 사실만 반환하지 말고 원문 전체를 보존해야 한다');
  assert.equal(helpers.givenName('김민우'), '민우');
  assert.equal(helpers.subject('김민우'), '민우는');
  assert.equal(helpers.givenName('황보민준'), '민준');
  assert.equal(helpers.subject('황보민준'), '민준이는');
  assert.equal(helpers.subject('김수'), '수 학생은');
  assert.equal(helpers.subject('Alex'), 'Alex 학생은');
  assert.equal(helpers.subject('테스트학생1'), '테스트학생1 학생은');
  assert.equal(helpers.possessive('김민우'), '민우의');
  assert.equal(helpers.possessive('김민준'), '민준이의');
  assert.equal(helpers.possessive('김수'), '수 학생의');
  assert.ok(helpers.namedOpeners.length >= 8, '이름 소유격으로 시작하는 도입 문장은 8개 이상이어야 한다');
  helpers.namedOpeners.forEach(sentence => assert.match(sentence, /^\{P\}/,
    '이름 도입 문장은 학생이 정리·전달한 것으로 오해되지 않게 소유격으로 시작해야 한다'));
  assert.equal(helpers.givenName('황보람'), '보람', '흔한 단성 황 + 보람을 복성 황보로 오인하면 안 된다');
  assert.equal(helpers.neutralize('수업에서 할 수 있도록 지도했습니다.', '김수'),
    '수업에서 할 수 있도록 지도했습니다.', '한 글자 이름이 수업이나 할 수를 훼손하면 안 된다');
  assert.equal(helpers.neutralize('김수는 수업에 참여했고 수가 질문했습니다.', '김수'),
    '학생은 수업에 참여했고 학생이 질문했습니다.');
  assert.equal(helpers.neutralize('황보민준이는 문제를 풀었고 민준이의 풀이를 설명했습니다.', '황보민준'),
    '학생은 문제를 풀었고 학생의 풀이를 설명했습니다.', '복성·받침 이름의 친근한 조사형도 일반화해야 한다');
  const friendlyForms = [
    ['민준이는', '학생은'], ['민준이의', '학생의'], ['민준이가', '학생이'], ['민준이를', '학생을'],
    ['민준이와', '학생과'], ['민준이도', '학생도'], ['민준이로', '학생으로']
  ];
  friendlyForms.forEach(([source, expected]) => assert.equal(helpers.neutralize(source + ' 확인', '황보민준'), expected + ' 확인'));
  for (const [fullName, givenName] of [['김민우', '민우'], ['황보민준', '민준']]) {
    const generated = helpers.build({ comment: '', focus: 'good', plus: [], minus: null }, 'named-' + fullName, fullName);
    assert.ok(generated.startsWith(helpers.possessive(fullName) + ' '), '성을 뺀 이름의 소유격이 첫 문장 첫머리에 와야 한다');
    assert.equal((generated.match(new RegExp(givenName, 'g')) || []).length, 1,
      '성 제외 이름은 생성 코멘트의 자연스러운 주어로 한 번만 사용해야 한다');
    assert.ok(!generated.includes(fullName), '생성 코멘트 주어에는 성을 포함한 전체 이름을 반복하지 않는다');
  }
  const singleNamed = helpers.build({ comment: '', focus: null, plus: [], minus: null }, 'named-single', '김수');
  assert.ok(singleNamed.startsWith('수 학생의 '), '한 글자 이름은 `학생의`를 붙여 자연스럽게 시작해야 한다');
  const latinNamed = helpers.build({ comment: '', focus: null, plus: [], minus: null }, 'named-latin', 'Alex');
  assert.ok(latinNamed.startsWith('Alex 학생의 '), '비한글 이름은 조사를 추측하지 않고 `학생의`를 사용한다');
  const directNamed = helpers.build({ comment: '김민우는 문제를 풀었고 민우가 설명했어요', focus: 'good', plus: [], minus: null },
    'direct-named', '김민우', '2026-09-01', 'student-minwoo');
  assert.equal((directNamed.match(/민우/g) || []).length, 1, '직접 코멘트의 반복 이름은 학생으로 일반화해야 한다');
  assert.match(directNamed, /^민우는 오늘 수업에서 문제를 풀었고 학생이 설명했습니다\./);
  const friendlyNamed = helpers.build({ comment: '민준이는 문제를 풀었고 민준이의 풀이를 설명했습니다', focus: null, plus: [], minus: null },
    'friendly-named', '황보민준', '2026-09-01', 'student-minjun');
  assert.ok(friendlyNamed.startsWith('민준이는 오늘 수업에서 문제를 풀었고 학생의 풀이를 설명했습니다.'));
  assert.equal((friendlyNamed.match(/민준/g) || []).length, 1,
    '친근한 조사형을 쓴 직접 코멘트도 첫 문장 첫머리 외에는 이름이 남지 않아야 한다');
  assert.equal(helpers.directSentence('오늘 수업에서 집중하는 모습을 보였습니다.', '김민우'),
    '민우는 오늘 수업에서 집중하는 모습을 보였습니다.');
  assert.equal(helpers.directSentence('민준이는 오늘 수업에서 집중하는 모습을 보였습니다.', '황보민준'),
    '민준이는 오늘 수업에서 집중하는 모습을 보였습니다.');
  assert.equal(helpers.directSentence('수 학생은 오늘 수업에서 집중하는 모습을 보였습니다.', '김수'),
    '수 학생은 오늘 수업에서 집중하는 모습을 보였습니다.');
  assert.equal(helpers.directSentence('Alex 학생은 오늘 수업에서 집중하는 모습을 보였습니다.', 'Alex'),
    'Alex 학생은 오늘 수업에서 집중하는 모습을 보였습니다.');
  assert.equal(helpers.directSentence('오늘 수업에서 오늘 수업에서 질문했고 계산 실수도 있었어요.', '김민우'),
    '민우는 오늘 수업에서 질문했고 계산 실수도 있었습니다.', '중복 선두만 제거하고 복합 사실은 보존해야 한다');
  const rotationDates = Array.from({ length: 100 }, (_, index) =>
    new Date(Date.UTC(2026, 0, 28 + index)).toISOString().slice(0, 10));
  const rotatedClosings = rotationDates.map(date =>
    helpers.dailyPick(helpers.closings, 'student-minwoo', date, 108, 'fallback'));
  assert.equal(new Set(rotatedClosings).size, 100,
    '월 경계를 지나도 같은 학생의 서로 다른 연속 100일에는 마무리가 반복되면 안 된다');
  assert.equal(helpers.dailyPick(helpers.closings, 'student-minwoo', rotationDates[0], 108, 'fallback'),
    rotatedClosings[0], '같은 학생과 날짜로 다시 열면 같은 문장을 골라야 한다');
  const noFocus = helpers.build({ comment: '어휘 정리', plus: [], minus: null }, 'no-focus', '김민우');
  for (const sentence of Object.values(helpers.focus).flat()) {
    assert.ok(!noFocus.includes(sentence), '집중·태도를 선택하지 않으면 포커스 문장을 임의로 추가하지 않아야 한다');
  }
  const buildSource = bank.slice(bank.indexOf('function buildFormalFeedbackComment'));
  assert.doesNotMatch(buildSource, /parts\.push\(seedPick\(FB_FORMAL_CONNECTORS/,
    '원문에 없는 수업 행위를 만드는 연결 문장을 무조건 삽입하면 안 된다');
});

test('feedback final v2 variable fields update context and rebuild the readonly approved-template preview', () => {
  const helperStart = html.indexOf('function syncFeedbackFinalFieldFromInput(');
  assert.ok(helperStart >= 0, '최종 문구 수동 편집 동기화 함수가 필요하다');
  const helperEnd = html.indexOf('\nfunction ', helperStart + 10);
  const helper = html.slice(helperStart, helperEnd);
  assert.match(helper, /data-feedback-final-field|dataset\.feedbackFinalField/);
  assert.match(helper, /fbCtx\[(?:field|fieldName|key)\]/);
  assert.match(helper, /feedbackV2Message\(/);
  assert.match(helper, /#mText|feedbackPreview/);
  assert.match(helper, /baseCommentText/,
    '코멘트를 직접 고친 뒤 AI 다듬기를 누르면 수동 수정본을 기준으로 해야 한다');
  assert.match(helper, /status\.dataset\.state === 'error'/);
  assert.match(helper, /발송 내용을 직접 수정했습니다/,
    '길이 오류 뒤 수업내용·과제를 고치면 이전 빨간 오류를 지워야 한다');
  assert.match(html, /addEventListener\('input',[\s\S]*syncFeedbackFinalFieldFromInput\(ev\.target\)/);
  const lengthStart = html.indexOf('function updateFeedbackPreviewLength(');
  const lengthEnd = html.indexOf('function syncFeedbackFinalFieldFromInput(', lengthStart);
  const lengthLogic = html.slice(lengthStart, lengthEnd);
  assert.match(lengthLogic, /const sendValid = hasRequiredFields[\s\S]*commentText\.length <= limit/);
  assert.doesNotMatch(lengthLogic, /finalButton\.disabled/,
    '최종 전송 버튼은 검증 실패 중에도 눌러서 정확한 이유를 확인할 수 있어야 한다');
  assert.match(lengthLogic, /refreshFeedbackFinalSendStatus\(t, scope\)/);
  assert.match(lengthLogic, /polishButton\.disabled = !!fbCtx\.polishPending/,
    'AI 다듬기 버튼은 진행 중일 때만 중복 클릭을 막아야 한다');
  assert.doesNotMatch(lengthLogic, /polishButton\.disabled[\s\S]*!polishValid/,
    '입력 문제는 비활성 버튼이 아니라 클릭 뒤 지속 안내로 설명해야 한다');
  const budgetStart = html.indexOf('const FEEDBACK_AI_MIN_BODY_CHARS');
  const budgetEnd = html.indexOf('function updateFeedbackPreviewLength(', budgetStart);
  const budgetApi = Function("const feedbackStudentSubject = () => '민우는'; const studentOf = () => '김민우';\n" +
    html.slice(budgetStart, budgetEnd) + '; return { minimum: feedbackPolishMinimumBudget, ready: feedbackPolishBudgetReady };')();
  const minimumBudget = budgetApi.minimum({});
  assert.equal(budgetApi.ready({}, 0), false, '코멘트 예산이 0이면 AI 다듬기를 활성화하면 안 된다');
  assert.equal(budgetApi.ready({}, minimumBudget - 1), false);
  assert.equal(budgetApi.ready({}, minimumBudget), true, '이름 도입문+공백+AI 본문 20자가 모두 들어갈 예산이 필요하다');
});

test('feedback AI polish updates only the send comment and exact fixed-template preview before a separate final send', () => {
  const polishStart = html.indexOf('async function polishFeedbackComment(');
  const polishEnd = html.indexOf('let feedbackSubmitting', polishStart);
  const polish = html.slice(polishStart, polishEnd);
  const submitStart = html.indexOf('async function submitFeedbackForReview(');
  const submitEnd = html.indexOf('async function reviewFeedbackRequest(', submitStart);
  const submit = html.slice(submitStart, submitEnd);
  assert.match(polish, /sync\.post\('\/feedback-polish'/);
  assert.match(polish, /commentText: sourceComment/);
  assert.match(polish, /subjectText: context\.subjectText/);
  assert.match(polish, /const stopWithReason = message =>/);
  assert.match(polish, /missing\.join\('\u00b7'\).*AI로 다듬을 수 없습니다/,
    '빈칸이 있으면 버튼 아래에 누락 항목을 정확히 표시해야 한다');
  assert.match(polish, /sourceComment\.length > FEEDBACK_COMMENT_MAX_CHARS/);
  assert.match(polish, /feedbackPolishBudgetReady\(task, localBudget\)/);
  assert.match(polish, /latestCommentField[\s\S]*syncFeedbackFinalFieldFromInput\(latestCommentField\)[\s\S]*sourceComment/,
    'AI 다듬기는 클릭 직전 DOM의 최신 코멘트를 사용해야 한다');
  assert.doesNotMatch(polish, /otherNotes|guardian|phone|studentName/);
  assert.match(polish, /if \(fbCtx !== context \|\| Number\(context\.polishSeq\) !== seq \|\|/);
  assert.match(polish, /context\.commentText = commentText/);
  assert.match(polish, /setFeedbackPolishStatus\('working'/);
  assert.match(polish, /setFeedbackPolishStatus\('success'/);
  assert.match(polish, /setFeedbackPolishStatus\('error'/);
  assert.match(polish, /result\.source \|\| ''\) === 'fallback'/,
    '비용 한도나 안전 검증 fallback은 기존 코멘트를 덮어쓰지 않아야 한다');
  assert.match(polish, /feedbackPolishFallbackText\(result\.fallbackReason\)/,
    'fallback 이유는 버튼 아래 지속 안내로 표시해야 한다');
  assert.match(polish, /result\.source \|\| ''\) === 'cache'/,
    '캐시 재사용은 새 AI 호출과 구분해 안내해야 한다');
  assert.match(polish, /feedbackPolishErrorText\(error\)/,
    'AI 실패 사유는 사라지는 토스트만 쓰지 않고 지속 상태에 안전하게 표시해야 한다');
  assert.match(polish, /feedbackPolishHasArtifacts\(/,
    'AI 결과를 평탄화하거나 화면에 넣기 전에 코드 흔적을 클라이언트에서도 차단해야 한다');
  assert.ok(polish.indexOf('feedbackPolishHasArtifacts') < polish.indexOf('feedbackFlatField(rawCommentText)'),
    '코드 흔적 검사는 줄바꿈·기호를 지우기 전에 실행해야 한다');
  assert.match(polish, /data-feedback-final-field="commentText"|querySelector\('\[data-feedback-final-field="commentText"\]'\)/,
    'AI 성공 결과는 수동 코멘트 입력칸에도 반영해야 한다');
  assert.match(polish, /feedback-polish-updated/,
    'AI가 바꾼 코멘트 칸은 선생님이 바로 찾을 수 있게 강조해야 한다');
  assert.match(polish, /button\.closest\('\.modal-box'\)/,
    'AI 응답은 요청을 시작한 피드백 팝업 인스턴스에만 적용해야 한다');
  assert.match(polish, /!modalBox\.isConnected \|\| !button\.isConnected/,
    '기다리는 동안 팝업이 닫혔다면 늦은 AI 응답을 폐기해야 한다');
  assert.match(polish, /modalBox\.querySelector\('#mText'\)/,
    'AI 결과가 다른 팝업의 공용 텍스트 상자를 덮어쓰면 안 된다');
  assert.match(polish, /preview\.value = nextMessage/);
  assert.match(polish, /feedbackV2Message\(task, context\.date/);
  assert.match(polish, /FEEDBACK_ALIMTALK_MAX_CHARS/);
  assert.match(submit, /feedbackFinalSendBlockReason\(task, templateVersion, message\)/);
  assert.match(html, /if \(fbCtx\.polishPending\) return 'AI 다듬기가 아직 진행 중입니다\.'/);
  assert.doesNotMatch(polish, /finalButton\.disabled/,
    'AI 처리 중에도 최종 전송 버튼은 활성 상태로 두고 버튼 아래 이유를 보여야 한다');
  assert.match(submit, /feedbackSubmitting = true/);
  assert.match(submit, /finally \{[\s\S]*feedbackSubmitting = false/);
  assert.match(html, /case 'feedbackpolish': polishFeedbackComment\(el\)/);
  assert.match(html, /case 'feedbackfinalsend': submitFeedbackForReview\(el\)/);
  assert.match(html, /id="feedbackPolishStatus"[^>]*role="status"[^>]*aria-live="polite"/,
    'AI 처리 결과는 버튼 아래의 지속적인 접근성 상태 영역에 표시해야 한다');
  assert.ok(html.includes('placeholder="예) ___ (하)는 모습을 보였습니다"'));
  const errorStart = html.indexOf('function feedbackPolishErrorText(');
  const errorEnd = html.indexOf('/** 서버 검증', errorStart);
  const errorText = html.slice(errorStart, errorEnd);
  assert.match(errorText, /FEEDBACK_STORAGE_BUSY/);
  assert.match(errorText, /D1\|STORE\|STORAGE\|DATABASE/);
  assert.doesNotMatch(errorText, /error\s*&&\s*error\.message/,
    '서버의 D1 원문 오류를 사용자에게 노출하면 안 된다');

  const artifactStart = html.indexOf('function feedbackPolishHasArtifacts(');
  const artifactEnd = html.indexOf('function feedbackDateLabel(', artifactStart);
  const hasArtifacts = Function(html.slice(artifactStart, artifactEnd) + '; return feedbackPolishHasArtifacts;')();
  assert.equal(hasArtifacts('민우는 오늘 3개 문제를 차분하게 풀었습니다.'), false);
  for (const value of [
    '```민우는 오늘 3개 문제를 풀었습니다.```',
    '{"comment":"민우는 오늘 3개 문제를 풀었습니다."}',
    '<p>민우는 오늘 3개 문제를 풀었습니다.</p>',
    '민우는 오늘 3개 문제를 풀었습니다. const result = true;',
    '민우는 오늘 3개 문제를 풀었습니다. def polish(): return True',
    '# 민우는 오늘 3개 문제를 풀었습니다.',
    '**민우는** 오늘 3개 문제를 풀었습니다.',
    '민우는 오늘 3개 문제를 풀었습니다. => {}',
    '민우는 오늘 3개 문제를 풀었습니다. assistant: 완료했습니다.',
    'commentText: 민우는 오늘 3개 문제를 차분하게 풀었습니다.',
    '민우는 오늘 3개 문제를 풀었습니다. SELECT value FROM users',
    '민우는 오늘 3개 문제를 풀었습니다. foo_bar',
    '민우는 오늘 3개 문제를 풀었습니다. 😊',
    '민우는 오늘 3개 문제를 풀었습니다. @@@ ^^^ ~완료~'
  ]) assert.equal(hasArtifacts(value), true, value);
});

test('feedback interview includes the new condition choices and omits every category explicitly set to none', () => {
  const bankStart = html.indexOf('const FB_PLUS = [');
  const bankEnd = html.indexOf('/** 학생이 보는 교재', bankStart);
  const bank = html.slice(bankStart, bankEnd);
  const interviewStart = html.indexOf('let fbCtx = null;');
  const interviewEnd = html.indexOf('/** 학부모 피드백 문구', interviewStart);
  const interview = html.slice(interviewStart, interviewEnd);

  for (const label of ['컨디션 저하', '스스로 풀어낸 문제 늘어남', '오답 줄어듬',
    '즐겁고 적극적으로 수업', '컨디션 관리']) {
    assert.ok(html.includes(label), '피드백 선택 화면에 ' + label + ' 버튼이 있어야 한다');
  }
  assert.match(interview, /2\. 오늘 집중·태도는\?/);
  assert.match(interview, /3\. 잘한 점은\?[\s\S]*FB_PLUS\.map/);
  assert.match(interview, /4\. 보완할 점은\?[\s\S]*FB_MINUS\.map/);
  const actionsStart = html.indexOf("case 'fbq':");
  const actionsEnd = html.indexOf("case 'fbmake':", actionsStart);
  const actions = html.slice(actionsStart, actionsEnd);
  assert.match(actions, /n === FB_PLUS_NONE_INDEX[\s\S]*fbCtx\.plus = fbCtx\.plus\.includes\(n\) \? \[\] : \[n\]/);
  assert.match(actions, /fbCtx\.plus\.filter\(x => x !== FB_PLUS_NONE_INDEX\)/,
    '잘한 점의 일반 항목을 고르면 없음 선택은 해제되어야 한다');

  const helpers = Function(bank +
    '; return { plus: FB_PLUS, minus: FB_MINUS, focus: FB_FORMAL_FOCUS, praise: FB_FORMAL_PRAISE, ' +
    'minusSentences: FB_FORMAL_MINUS, build: buildFormalFeedbackComment };')();
  const plusNone = helpers.plus.findIndex(row => row[0] === '없음');
  const minusNone = helpers.minus.findIndex(row => row[0] === '없음');
  assert.ok(plusNone >= 0, '잘한 점에도 없음 선택지가 있어야 한다');
  assert.ok(minusNone >= 0, '보완할 점의 없음 선택지가 유지되어야 한다');
  assert.equal(helpers.plus[plusNone][1], '', '잘한 점 없음은 문장 재료를 가지면 안 된다');
  assert.equal(helpers.minus[minusNone][1], '', '보완할 점 없음은 문장 재료를 가지면 안 된다');

  const noneComment = helpers.build({ comment: '', focus: 'none', plus: [plusNone], minus: minusNone }, 'none-case');
  assert.doesNotMatch(noneComment, /없음/, '없음을 선택해도 실제 피드백에 없음 문장을 쓰면 안 된다');
  for (const sentence of Object.values(helpers.focus).flat()) {
    assert.ok(!noneComment.includes(sentence), '집중·태도 없음은 집중 문장을 완전히 생략해야 한다');
  }
  for (const template of helpers.praise) {
    assert.ok(!noneComment.includes(template.replace('{x}', '')), '잘한 점 없음은 빈 칭찬 문장을 만들면 안 된다');
  }
  for (const template of helpers.minusSentences) {
    assert.ok(!noneComment.includes(template.replace('{y}', '')), '보완할 점 없음은 빈 보완 문장을 만들면 안 된다');
  }

  assert.ok(Array.isArray(helpers.focus.condition_low) && helpers.focus.condition_low.length,
    '컨디션 저하 선택에는 실제 생성 문장이 연결되어야 한다');
  for (const label of ['스스로 풀어낸 문제 늘어남', '오답 줄어듬', '즐겁고 적극적으로 수업']) {
    const row = helpers.plus.find(item => item[0] === label);
    assert.ok(row && row[1], label + ' 선택에는 실제 생성 문장이 연결되어야 한다');
  }
  const conditionCare = helpers.minus.find(item => item[0] === '컨디션 관리');
  assert.ok(conditionCare && conditionCare[1], '컨디션 관리 선택에는 실제 생성 문장이 연결되어야 한다');
});

test('teacher-only other notes never enter parent feedback text or send fields', () => {
  const feedbackStart = html.indexOf('function feedbackText(');
  const feedbackEnd = html.indexOf('function todayStaffList(', feedbackStart);
  const feedback = html.slice(feedbackStart, feedbackEnd);
  assert.match(feedback, /memo\.contentProgress\.trim\(\)/);
  assert.match(feedback, /memo\.homework\.trim\(\)/);
  assert.match(feedback, /memo\.comment\.trim\(\)/);
  assert.doesNotMatch(feedback, /memo\.otherNotes|otherNotes\.trim/);
  assert.match(html, /선생님 내부 공유 · 학부모 미발송/);
});

test('feedback interview owns the direct comment as question one and preserves it across choices', () => {
  const interviewStart = html.indexOf('let fbCtx = null;');
  const interviewEnd = html.indexOf('/** 학부모 피드백 문구', interviewStart);
  const interview = html.slice(interviewStart, interviewEnd);
  assert.match(interview, /modal\('피드백 문구 선택'/);
  assert.match(interview, /1\. 코멘트\(직접작성, 간단히\)/);
  assert.match(interview, /data-feedback-comment/);
  assert.match(interview, /2\. 오늘 집중·태도는\?/);
  assert.match(interview, /3\. 잘한 점은\?/);
  assert.match(interview, /4\. 보완할 점은\?/);
  assert.match(interview, /captureFeedbackComment\(\)/);
  const actionsStart = html.indexOf("case 'fbtext':");
  const actionsEnd = html.indexOf("case 'feedbacksubmit':", actionsStart);
  const actions = html.slice(actionsStart, actionsEnd);
  assert.match(actions, /comment: lessonMemoValues\(getCheck\(id, date\)\)\.comment/);
  assert.match(actions, /case 'fbq':[\s\S]*captureFeedbackComment\(\)/);
  assert.match(actions, /case 'fbmake':[\s\S]*lessonMemo\.comment = String\(fbCtx\.comment \|\| ''\)/);
  assert.match(actions, /setCheck\(fbCtx\.id, fbCtx\.date, \{ lessonMemo: lessonMemo, note: lessonMemoText\(lessonMemo\) \}\)/);
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
