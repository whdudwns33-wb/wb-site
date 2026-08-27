const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('일반 선생님 수업 카드는 큰 완료 체크를 숨기고 관리담당은 유지한다', () => {
  const row = source.slice(source.indexOf('function taskRow('), source.indexOf('function taskPanel(', source.indexOf('function taskRow(')));
  assert.match(row, /const showFinalBox = session\.isAdmin \|\| !usesStandardLessonDisplay\(t\)/);
  assert.match(row, /\(showFinalBox \? '<button class="box"/);
});

test('수업은 저장된 done 플래그가 있어도 5개 체크리스트가 다 체크되어야 완료다', () => {
  const start = source.indexOf('function isDone(');
  const end = source.indexOf('function setCheck(', start);
  const factory = new Function('getCheck', 'state', 'taskSteps', 'usesStandardLessonDisplay', 'LESSON_OPERATIONAL_STEP_LABELS',
    source.slice(start, end) + '\nreturn isDone;');
  const task = { id: 'lesson-1' };
  const labels = ['1', '2', '3', '4', '5'];
  let check = { done: true, steps: { 1: true, 2: true, 3: true, 4: true } };
  const isDone = factory(() => check, { tasks: [task] }, () => labels.map(id => ({ id })), () => true, labels);
  assert.equal(isDone(task.id, '2026-08-14'), false);
  check.steps[5] = true;
  assert.equal(isDone(task.id, '2026-08-14'), true);
});

test('오늘 탭은 개인 태블릿의 담당자를 앞에 두고 나머지 기존 순서를 유지한다', () => {
  const start = source.indexOf('function todayStaffList(');
  const end = source.indexOf('function staffSwitcher(', start);
  const staff = ['테스트 선생님', '박지원', '김남기', '김혜지', '강민지'].map((name, index) => ({ id: String(index), name }));
  const staffById = id => staff.find(row => row.id === id);
  const factory = session => new Function('liveStaff', 'session', 'staffById',
    source.slice(start, end) + '\nreturn todayStaffList;')(() => staff, session, staffById);

  const directorList = factory({ isStaffLink: false, staffId: '' })();
  const namgiList = factory({ isStaffLink: true, staffId: '2' })();
  const hyejiList = factory({ isStaffLink: true, staffId: '3' })();
  const otherList = factory({ isStaffLink: true, staffId: '1' })();

  assert.deepEqual(directorList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(namgiList.map(row => row.name), ['김남기', '김혜지', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(hyejiList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.deepEqual(otherList.map(row => row.name), ['김혜지', '김남기', '강민지', '박지원', '테스트 선생님']);
  assert.notEqual(namgiList, staff, '원본 직원 배열은 변경하지 않아야 한다');
  assert.match(source, /return staffById\(viewStaff\) \|\| todayStaffList\(\)\[0\] \|\| null/);
});

test('수업 카드는 학생정보 업무지시 팝업과 수업진행 펼침의 두 탭을 사용한다', () => {
  const row = source.slice(source.indexOf('function taskRow('), source.indexOf('function taskPanel(', source.indexOf('function taskRow(')));
  assert.match(row, /class="lesson-card-tabs"/);
  assert.match(row, /data-act="lessonbriefing"[\s\S]{0,180}>학생정보 · 업무지시<\/button>/);
  assert.match(row, /data-act="panel"[\s\S]{0,220}수업진행/);
  assert.match(row, /if \(open\) h \+= taskPanel\(t, date, c, editable\)/);
  assert.doesNotMatch(row, /previousTaskMemosProgressHtml\(t\.id, date\)/);
  assert.match(source, /case 'lessonbriefing': showTodayLessonBriefing/);
  assert.match(source, /\.lesson-card-tab \{ min-height: 44px;/);
});

test('학생정보 업무지시는 stable studentId로 원생 탭과 같은 정보 팝업을 연다', () => {
  const start = source.indexOf('function lessonWorkInstructionHtml(');
  const end = source.indexOf('/* 보호자 공개 내용은', start);
  const briefing = source.slice(start, end);
  const work = source.slice(start, source.indexOf('function showTodayLessonBriefing(', start));
  assert.match(briefing, /const stableStudentId = String\(task\.studentId \|\| ''\)/);
  assert.match(briefing, /String\(row\.id\) === stableStudentId/);
  assert.match(briefing, /rosterStudentInfoHtml\(student, \[\], task\.id\)/);
  assert.match(briefing, /modal\('학생정보 · 업무지시'/);
  assert.match(briefing, /data-act="lessonbriefingedit"[\s\S]{0,180}학생정보 · 업무지시 수정/);
  assert.match(briefing, /수업 정보 수정/);
  for (const label of ['과목·반', '수업 요일·시간·시수', '교재·현재 진도', '온라인 프로그램', '숙제 루틴과 수행률', '학생 특징', '목표', '특이사항·학부모 요청', '관리자 요청사항']) {
    assert.ok(briefing.includes(`['${label}'`), label);
  }
  assert.match(work, /\['관리자 요청사항', task\.adminRequest \|\| '없음'/);
  for (const duplicate of ['업무 제목', '수업일', '등록 시간', '업무 상세', "['업무지시'", '기존 수업 참고 단계', '목표 수량']) {
    assert.doesNotMatch(work, new RegExp(duplicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), duplicate);
  }
  assert.ok(briefing.indexOf('lessonWorkInstructionHtml(task, lessonDate)') < briefing.indexOf('lesson-briefing-student'));
  assert.doesNotMatch(briefing, /rosterStudentMatches|studentName\).*find|studentOf\(task\).*find/);
});

test('관리자는 학생 공통 정보와 현재 수업 업무지시를 한 화면에서 수정한다', () => {
  const start = source.indexOf('let lessonBriefingEditor = null;');
  const end = source.indexOf('/* 보호자 공개 내용은', start);
  const editor = source.slice(start, end);
  assert.match(editor, /이 수업의 업무지시와 학생 공통 정보를 한 번에 수정합니다/);
  for (const key of ['name', 'school', 'grade', 'phoneSelf', 'phoneFather', 'phoneMother', 'registrationDate', 'firstClassDate', 'start', 'memo']) {
    assert.match(editor, new RegExp(`data-lesson-briefing-student="${key}"`), key);
  }
  assert.match(editor, /data-lesson-briefing-subject/);
  assert.match(editor, /data-lesson-briefing-teacher/);
  assert.match(editor, /data-lesson-briefing-instruction=/);
  for (const key of ['materials', 'onlineProgram', 'homework', 'studentTraits', 'goal', 'parentRequest', 'adminRequest']) {
    assert.match(editor, new RegExp(`'${key}'`), key);
  }
  assert.match(editor, /action: 'student_get', studentId: String\(studentId\)/);
  assert.match(editor, /String\(currentTask\.studentId \|\| ''\) !== String\(result\.student && result\.student\.id \|\| ''\)/);
  assert.match(editor, /action: 'student_update', expectedUpdatedAt: editor\.expectedRosterUpdatedAt/);
  assert.match(editor, /sourceTaskId: editor\.taskId, expectedUpdatedAt: editor\.expectedTaskUpdatedAt/);
  assert.ok(editor.indexOf("sync.post('/roster'") < editor.indexOf("sync.post('/lesson-create'"));
  assert.match(editor, /\|\| '없음'/);
  assert.match(editor, /출결·수업 메모·보호자 공개 숙제와 준비물은 수업진행에서 입력합니다/);
  assert.match(editor, /instructionEditorHtml \+ studentHtml/);
  assert.match(source, /case 'lessonbriefingedit': openLessonBriefingEditor/);
  assert.match(source, /case 'lessonbriefingsave': saveLessonBriefingEditor/);
});

test('학생정보 업무지시 팝업은 구형 태블릿에서도 세로 터치 스크롤이 된다', () => {
  assert.match(source, /\.modal \{[^}]*overflow-y: auto;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(source, /\.modal-box \{[^}]*min-height: 0;[^}]*max-height: calc\(100vh - 32px\);[^}]*max-height: calc\(100dvh - 32px\);/);
  assert.match(source, /\.modal-box \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*-webkit-overflow-scrolling: touch;[^}]*touch-action: pan-y;/);
});

test('수업진행은 출결을 최상단에 두고 기존 교사 기능을 모두 안으로 옮긴다', () => {
  const panel = source.slice(source.indexOf('function taskPanel('), source.indexOf('/** 수업 출결 표시용 */'));
  const attendance = panel.indexOf('lesson-attendance');
  const steps = panel.indexOf('수업 5단계 진행');
  const memo = panel.indexOf('taskMemoEditorHtml(t, date, c, editable)');
  const homework = panel.indexOf('guardianPublicationHtml(t, date)');
  const previous = panel.indexOf('previousTaskMemosProgressHtml(t.id, date)');
  assert.ok(attendance >= 0 && attendance < steps && steps < memo && memo < homework && homework < previous);
  for (const action of ['latt', 'step', 'cnt', 'block', 'fbtext', 'acaflowlessoncopy', 'ctlog', 'lcpropose']) {
    assert.match(panel, new RegExp(`data-act="${action}"`), action);
  }
  assert.match(panel, /makeupRequestHtml\(t, date, c\)/);
  assert.match(panel, /previousTaskMemosProgressHtml\(t\.id, date\)/);
  assert.match(panel, /<details class="lesson-progress-section lesson-progress-details"><summary>수업 5단계 진행<\/summary>/);
  assert.match(panel, /수업 메모\(실제 진도 및 특이사항\)/);
  assert.match(panel, /<details class="lesson-progress-section lesson-progress-details guardian-publication-details"><summary>숙제 · 준비물 \(보호자 · 학생 공개\)<\/summary>/);
  assert.match(panel, /canEditPublication \? guardianPublicationHtml\(t, date\) :[\s\S]{0,160}guardianPublicationAccessHint\(t, date\)/);
  assert.match(panel, /prepareGuardianPublicationPolicy\(date\);[\s\S]{0,80}if \(guardianContactEnabledFor\(t\.studentId\)\)/);
  assert.doesNotMatch(panel, /<details class="lesson-progress-section lesson-progress-details"\s+open/);
  assert.doesNotMatch(panel, /data-act="lessonedit"/);
  assert.match(panel, /lesson\s*\? \(canProposeLessonChange\(t\)[\s\S]{0,240}: \(canEditTask\(t\)/);
});

test('이전 수업 메모는 같은 수업의 기준일 전 기록만 최신순 3개까지 보여준다', () => {
  const start = source.indexOf('function previousTaskMemos(');
  const end = source.indexOf('function previousTaskMemosProgressHtml(', start);
  const checks = {};
  for (let day = 1; day <= 22; day += 1) {
    const date = '2026-07-' + String(day).padStart(2, '0');
    checks['lesson-1|' + date] = { taskId: 'lesson-1', date, note: '메모 ' + day };
  }
  checks['lesson-1|2026-08-14'] = { taskId: 'lesson-1', date: '2026-08-14', note: '오늘 메모' };
  checks['lesson-2|2026-07-30'] = { taskId: 'lesson-2', date: '2026-07-30', note: '다른 수업' };
  checks['lesson-1|2026-07-31'] = { taskId: 'lesson-1', date: '2026-07-31', note: '   ' };
  const previousTaskMemos = new Function('state', source.slice(start, end) + '\nreturn previousTaskMemos;')({ checks });
  const rows = previousTaskMemos('lesson-1', '2026-08-14');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2026-07-22');
  assert.equal(rows.at(-1).date, '2026-07-20');
  assert.ok(rows.every(row => row.taskId === 'lesson-1' && row.date < '2026-08-14'));
});

test('이전 수업 메모는 기본 접힘 상태이며 제목을 누르면 최신순 3개가 펼쳐진다', () => {
  const start = source.indexOf('function previousTaskMemos(');
  const end = source.indexOf('function lessonWorkInstructionHtml(', start);
  const state = { checks: {
    'lesson-1|2026-08-13': { taskId: 'lesson-1', date: '2026-08-13', note: '분수 복습 완료' }
  } };
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = new Function('state', 'esc', source.slice(start, end) + '\nreturn previousTaskMemosProgressHtml;')(state, esc);
  const html = render('lesson-1', '2026-08-14');
  assert.match(html, /^<details class="lesson-progress-section previous-memos"><summary>이전 수업 메모<\/summary>/);
  assert.match(html, /2026-08-13/);
  assert.match(html, /분수 복습 완료/);
  assert.match(html, /최신순 3개/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  assert.doesNotMatch(html, /data-act="prevmemos"/);
  assert.match(source, /\.previous-memos > summary::after \{ content: '펼치기'/);
});

test('메모는 포커스할 때 커지는 여러 줄 입력과 바로 아래 저장 버튼을 사용한다', () => {
  const editor = source.slice(source.indexOf('function taskMemoEditorHtml('), source.indexOf('function previousTaskMemos('));
  const panel = source.slice(source.indexOf('function taskPanel('), source.indexOf('/** 수업 출결 표시용 */'));
  assert.match(editor, /<textarea class="note" data-act="note"[^>]+rows="1" enterkeyhint="enter"/);
  assert.match(editor, /<button type="button" class="btn btn-primary btn-block memo-save" data-act="notesave"/);
  assert.match(panel, /수업 메모[\s\S]{0,180}taskMemoEditorHtml\(t, date, c, editable\)/);
  assert.match(source, /\.memo-editor:focus-within textarea\.note \{ min-height: 132px;/);
  assert.match(source, /\.memo-editor:focus-within \.memo-save \{ display: block; \}/);
  assert.match(source, /case 'notesave':[\s\S]{0,420}setCheck\(id, date, \{ note: noteEl\.value \}\)/);
  assert.doesNotMatch(source, /setTimeout\(\(\) => \{\s*setCheck\(noteEl\.dataset\.id/);
});
