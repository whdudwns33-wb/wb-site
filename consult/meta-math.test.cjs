const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const section = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  return from >= 0 && to > from ? html.slice(from, to) : '';
};

test('study screen renders thirteen separate source cards and keeps legacy MetaMath tasks', () => {
  const sources = section('const LEARNING_SOURCES', 'const ONLINE_LEARNING_SOURCE_KEYS');
  const expected = [
    ['leaders_eye', '리더스아이'],
    ['metamath', '메타수학'],
    ['brain_letter', '브레인레터'],
    ['chunk_brain', '청크브레인'],
    ['vocabulary', '어휘'],
    ['classcard', '클래스카드'],
    ['studyforce', '스터디포스'],
    ['nelt_exam', '넬트 시험'],
    ['daily_nonfiction', '하루 비문학 독서'],
    ['wb_reading', '자체 독해력 교재'],
    ['reading', '독서'],
    ['inquiry_report', '탐구보고서'],
    ['exam_material', '시험대비자료']
  ];
  assert.deepEqual([...sources.matchAll(/^  ([a-z_]+): \{/gm)].map(match => match[1]), expected.map(x => x[0]));
  expected.forEach(([key, label]) => {
    assert.match(sources, new RegExp('\\b' + key + ': \\{'));
    assert.ok(sources.includes("label: '" + label + "'"));
  });

  const rows = section('function taskRow(', 'function taskPanel(');
  const study = section('function viewStudy(', 'function rdAddModal(');
  assert.match(rows, /LEARNING_SOURCES\[t\.source\]/);
  assert.match(rows, /t\.learningKind \|\| t\.metaKind/);
  assert.match(study, /const sourceKeys = Object\.keys\(LEARNING_SOURCES\)/);
  assert.match(study, /group\.keys\.map\(key => learningSourceCard\(me, editable, key\)\)/);
  assert.match(study, /온라인 학습/);
  assert.match(study, /자기주도 학습/);
  assert.match(study, /시험 준비/);
  assert.match(study, /study-hub-hero/);
  assert.match(study, /원장 관리 화면/);
  assert.match(study, /학생 화면/);
});

test('external study services use fixed official links without embedded login', () => {
  assert.match(html, /const LEADERS_EYE_URL = 'https:\/\/www\.eyestudent\.com\/login'/);
  assert.match(html, /centerUrl: LEADERS_EYE_URL, studentUrl: LEADERS_EYE_URL/);
  assert.match(html, /const METAMATH_CENTER_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=center'/);
  assert.match(html, /const METAMATH_STUDENT_URL = 'https:\/\/new\.mmath\.co\.kr\/Pages\/Student\/Login\/login\.cshtml\?f_next='/);
  assert.match(html, /const CLASSCARD_ANDROID_APP_URL = 'https:\/\/play\.google\.com\/store\/apps\/details\?id=classcard\.net'/);
  assert.match(html, /const CLASSCARD_IOS_APP_URL = 'https:\/\/apps\.apple\.com\/kr\/app\/id1176435331'/);
  assert.doesNotMatch(html, /www\.classcard\.net\/Login/);
  assert.match(html, /const STUDYFORCE_URL = 'https:\/\/hol\.sfcenter\.co\.kr\/'/);
  assert.match(html, /centerUrl: STUDYFORCE_URL, studentUrl: STUDYFORCE_URL/);
  assert.doesNotMatch(html, /www\.studyforce\.co\.kr/);
  assert.match(html, /const BRAIN_LETTER_URL = 'https:\/\/wb-reading\.whdudwns33\.workers\.dev\/letter\/'/);
  assert.match(html, /const CHUNK_BRAIN_URL = 'https:\/\/wb-reading\.whdudwns33\.workers\.dev\/chunk\/'/);
  assert.match(html, /const VOCABULARY_URL = 'https:\/\/wb-reading\.whdudwns33\.workers\.dev\/hanja\/'/);
  const chunk = section('  chunk_brain: {', '  vocabulary: {');
  assert.doesNotMatch(chunk, /\?t=|print\.html|class\.html|chunk-admin\.html/);

  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /iframe|fetch\(|type="password"/i);
});

test('requested brain learning cards appear first in the requested order', () => {
  const sources = section('const LEARNING_SOURCES', 'const DOW');
  const study = section('function viewStudy(', 'function rdAddModal(');
  assert.ok(sources.indexOf('  leaders_eye: {') < sources.indexOf('  metamath: {'));
  assert.match(sources, /const ONLINE_LEARNING_SOURCE_KEYS = Object\.freeze\(\[\s*'brain_letter', 'chunk_brain', 'vocabulary', 'leaders_eye', 'metamath',\s*'classcard', 'studyforce', 'nelt_exam', 'daily_nonfiction'/);
  assert.match(study, /keys: ONLINE_LEARNING_SOURCE_KEYS/);
});

test('Leaders Eye keeps its direct daily fallback and recurring assignments resolve the current occurrence', () => {
  const helpers = section('const LEARNING_DAILY_LOG_KIND', 'const LEARNING_LOGIN_MEMO_SOURCES');
  const modal = section('function leadersEyeDailyResultModal(', 'function studyPlannerCard(');
  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  const add = section("case 'learnadd':", "case 'learnsave':");
  const assign = section("case 'learnsave':", '/* 학사관리 · 시험대비 자료 요청 */');
  const open = section("case 'learningdailyopen':", "case 'learningdailysave':");
  const save = section("case 'learningdailysave':", "case 'learningresultopen':");

  assert.match(helpers, /const LEARNING_DAILY_LOG_KIND = 'learning_daily_log'/);
  assert.match(helpers, /\['learning-daily', staffId, sourceKey, date\]\.join\('-'\)/);
  assert.match(helpers, /task\.id === id/);
  assert.match(helpers, /effectiveOccursOn\(task, date\)/);
  assert.match(card, /sourceKey === 'leaders_eye'/);
  assert.match(card, /task\.kind !== LEARNING_DAILY_LOG_KIND \|\| task\.start !== today\(\)/);
  assert.match(card, /effectiveOccursOn\(task, today\(\)\)/);
  assert.match(card, /const occurrenceDate = task => learningOccurrenceDate\(task, today\(\)\)/);
  assert.match(card, /taskRow\(t, occurrenceDate\(t\), editable, false\)/);
  assert.match(card, /data-act="learningchecklistopen"/);
  assert.match(card, /data-act="learningdailyopen"/);
  assert.match(card, /오늘 미기록/);
  assert.match(card, /✓ 오늘 완료/);
  assert.match(modal, /회차 입력 없이 오늘의 학습 여부만 기록/);
  assert.match(modal, /data-act="learningdailysave"/);
  assert.match(add, /sourceKey === 'leaders_eye'/);
  assert.match(assign, /sourceKey === 'leaders_eye'/);
  assert.doesNotMatch(open, /state\.tasks\.push/);
  assert.match(save, /kind: LEARNING_DAILY_LOG_KIND/);
  assert.match(save, /repeat: 'once'/);
  assert.match(save, /start: d/);
  assert.match(save, /carry: false/);
  assert.match(save, /origin: 'staff'/);
  assert.match(save, /learningResult: \{ outcome: note \|\| '학습 완료' \}/);
  assert.match(save, /setCheck\(t\.id, d/);
});

test('Leaders Eye and daily nonfiction use the requested recurring checklist defaults', () => {
  const match = html.match(/const CHECKLIST_ONLINE_SOURCE_DEFAULTS = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(match, 'recurring checklist defaults must exist');
  const defaults = Function(match[0] + '\nreturn CHECKLIST_ONLINE_SOURCE_DEFAULTS;')();
  assert.deepEqual(Object.keys(defaults), ['leaders_eye', 'daily_nonfiction']);
  assert.equal(defaults.leaders_eye.title, '리더스아이 오늘 학습');
  assert.equal(defaults.leaders_eye.subject, 'english');
  assert.equal(defaults.leaders_eye.minutes, 20);
  assert.equal(defaults.daily_nonfiction.title, '하루 비문학 독서');
  assert.equal(defaults.daily_nonfiction.subject, 'korean');
  assert.equal(defaults.daily_nonfiction.minutes, 20);

  const modal = section('function learningChecklistScheduleModal(', 'function learningSourceCard(');
  const save = section("case 'learningchecklistsave':", "case 'learnadd':");
  assert.match(modal, /CHECKLIST_ONLINE_SOURCE_DEFAULTS\[sourceKey\]/);
  assert.match(modal, /매일/);
  assert.match(modal, /평일/);
  assert.match(modal, /요일 지정/);
  assert.match(modal, /반복 종료일/);
  assert.match(modal, /patternLocked \? ' disabled' : ''/);
  assert.match(modal, /과거 기록 보호를 위해 반복 방식과 요일은 고정/);
  assert.match(save, /let task = learningChecklistScheduleFor\(me\.id, sourceKey\)/);
  assert.match(save, /const patternLocked = learningChecklistPatternLocked\(task\)/);
  assert.match(save, /const start = task \? task\.start :/);
  assert.match(save, /days\.some\(day => !Number\.isInteger\(day\) \|\| day < 0 \|\| day > 6\)/);
  assert.match(save, /repeat: repeat, days: repeat === 'days' \? days\.sort\(\(a, b\) => a - b\) : \[\], start: start, end: end/);
  assert.match(save, /dueDate: '', carry: false, requiresClaim: false/);
  assert.match(save, /occursOn\(\{ repeat: repeat, days: days, start: start, end: end, deleted: false \}, start\)/);
  assert.match(save, /check\.steps = Object\.fromEntries\(task\.steps\.map\(step => \[step\.id, true\]\)\)/);

  const lockSource = html.match(/const learningChecklistPatternLocked = task => [^;]+;/)?.[0] || '';
  const lock = Function('today', 'getCheck', lockSource + '\nreturn learningChecklistPatternLocked;')(
    () => '2026-09-15', (id, date) => id === 'checked' && date === '2026-09-15' ? { done: true } : null
  );
  assert.equal(lock({ id: 'new', start: '2026-09-15' }), false);
  assert.equal(lock({ id: 'checked', start: '2026-09-15' }), true);
  assert.equal(lock({ id: 'old', start: '2026-09-14' }), true);
});

test('a same-day Leaders Eye result becomes the recurring schedule without losing its completion', () => {
  const handler = section("case 'learningchecklistsave': {", "case 'learnadd':");
  const date = '2026-09-15';
  const id = 'learning-daily-student-a-leaders_eye-' + date;
  const log = { id, staffId: 'student-a', source: 'leaders_eye', kind: 'learning_daily_log', start: date, steps: [] };
  const check = { done: true, learningResult: { outcome: '학습 완료' } };
  const state = { tasks: [log], checks: { [id + '|' + date]: check } };
  const values = {
    '#learningChecklistRepeat': 'weekday',
    '#learningChecklistStart': date,
    '#learningChecklistEnd': '',
    '#learningChecklistMinutes': '20'
  };
  const run = Function(
    'session', 'currentStaff', 'el', 'CHECKLIST_ONLINE_SOURCE_DEFAULTS', 'LEARNING_SOURCES', '$', 'document',
    'learningChecklistScheduleFor', 'learningChecklistPatternLocked', 'today', 'occursOn', 'dailyLearningRecordTask', 'uid', 'now', 'state',
    'LEARNING_DAILY_LOG_KIND', 'getCheck', 'save', 'queueSync', 'closeModal', 'render', 'toast',
    `return function () { switch ('learningchecklistsave') { ${handler} } };`
  )(
    { isAdmin: true }, () => ({ id: 'student-a', name: '학생' }), { dataset: { source: 'leaders_eye' } },
    { leaders_eye: { title: '리더스아이 오늘 학습', subject: 'english', minutes: 20 } },
    { leaders_eye: { label: '리더스아이', detail: '오늘 학습', guide: '', steps: ['학습하기'] } },
    selector => ({ value: values[selector] || '' }), { querySelectorAll: () => [] }, () => null, () => false, () => date,
    () => true, () => log, () => 'new-id', () => 1234, state, 'learning_daily_log',
    (taskId, day) => state.checks[taskId + '|' + day] || null, () => true,
    () => {}, () => {}, () => {}, () => {}
  );

  run();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0], log);
  assert.equal(log.id, id);
  assert.equal('kind' in log, false);
  assert.equal(log.repeat, 'weekday');
  assert.equal(state.checks[id + '|' + date], check);
  assert.equal(state.checks[id + '|' + date].done, true);
  assert.deepEqual(state.checks[id + '|' + date].steps, { 'new-id': true });
});

test('a recurring learning assignment resolves only scheduled occurrences and drives Study KPI checks', () => {
  const repeatingSource = html.match(/const isRepeatingTask = task => [^;]+;/)?.[0] || '';
  const isRepeatingTask = Function(repeatingSource + '\nreturn isRepeatingTask;')();
  assert.equal(isRepeatingTask({ repeat: 'daily' }), true);
  assert.equal(isRepeatingTask({ repeat: 'weekday' }), true);
  assert.equal(isRepeatingTask({ repeat: 'days' }), true);
  assert.equal(isRepeatingTask({ repeat: 'once' }), false);
  assert.equal(isRepeatingTask({}), false, 'legacy tasks without repeat stay one-time');

  const occurrenceSource = section('function learningOccurrenceDate(', 'function learningAcademicEvent(');
  const learningOccurrenceDate = Function(
    'isRepeatingTask', 'effectiveOccursOn', 'learningTaskDate',
    occurrenceSource + '\nreturn learningOccurrenceDate;'
  )(
    isRepeatingTask,
    (task, date) => task.scheduled.includes(date),
    task => task.start || ''
  );
  const recurring = { repeat: 'weekday', scheduled: ['2026-09-15'] };
  assert.equal(learningOccurrenceDate(recurring, '2026-09-15'), '2026-09-15');
  assert.equal(learningOccurrenceDate(recurring, '2026-09-19'), '');
  assert.equal(learningOccurrenceDate({ start: '2026-09-15' }, '2026-09-19'), '2026-09-15');

  const study = section('function viewStudy(', 'function rdAddModal(');
  assert.match(study, /learningTasks\.map\(task => \(\{ task: task, date: learningOccurrenceDate\(task, today\(\)\) \}\)\)\s*\.filter\(item => item\.date\)/);
  assert.match(study, /learningOccurrences\.filter\(item => !isDone\(item\.task\.id, item\.date\)\)/);

  const source = section('function assignedLearningTaskForDate(', 'const LEARNING_LOGIN_MEMO_SOURCES');
  const task = { id: 'leaders-weekday', kind: 'learning', repeat: 'weekday' };
  const seen = [];
  const assignedLearningTaskForDate = Function(
    'learningTasksFor', 'LEARNING_DAILY_LOG_KIND', 'effectiveOccursOn',
    source + '\nreturn assignedLearningTaskForDate;'
  )(
    () => [task],
    'learning_daily_log',
    (candidate, date) => { seen.push([candidate.id, date]); return date !== '2026-09-19'; }
  );

  assert.equal(assignedLearningTaskForDate('student-a', 'leaders_eye', '2026-09-15'), task);
  assert.equal(assignedLearningTaskForDate('student-a', 'leaders_eye', '2026-09-16'), task);
  assert.equal(assignedLearningTaskForDate('student-a', 'leaders_eye', '2026-09-19'), null);
  assert.deepEqual(seen, [
    ['leaders-weekday', '2026-09-15'],
    ['leaders-weekday', '2026-09-16'],
    ['leaders-weekday', '2026-09-19']
  ]);
});

test('online services open the requested URLs for director, manager, and student', () => {
  const sources = section('const LEADERS_EYE_URL', 'const DOW');
  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  const renderCard = Function('session', 'isManager', 'learningTasksFor', 'learningChecklistScheduleFor', 'esc', 'LEARNING_LOGIN_MEMO_SOURCES',
    sources + card + '\nreturn learningSourceCard;');
  const expected = [
    ['nelt_exam', '넬트 시험', 'https://www.netutor.co.kr/st/'],
    ['daily_nonfiction', '하루 비문학 독서', 'https://wb-reading.whdudwns33.workers.dev'],
    ['brain_letter', '브레인레터', 'https://wb-reading.whdudwns33.workers.dev/letter/'],
    ['chunk_brain', '청크브레인', 'https://wb-reading.whdudwns33.workers.dev/chunk/'],
    ['vocabulary', '어휘', 'https://wb-reading.whdudwns33.workers.dev/hanja/']
  ];
  for (const role of ['director', 'manager', 'student']) {
    const render = renderCard({ isAdmin: role === 'director' }, () => role === 'manager', () => [], () => null, String,
      ['leaders_eye', 'metamath']);
    for (const [key, label, url] of expected) {
      const output = render({ id: 'student-a', name: '테스트' }, role !== 'manager', key);
      assert.ok(output.includes('data-learning-source="' + key + '"'));
      assert.ok(output.includes('<b>' + label + '</b>'));
      assert.ok(output.includes('href="' + url + '" target="_blank" rel="noopener noreferrer"'));
      assert.equal(output.includes('data-act="learnadd"'), role === 'director');
    }
  }
  const study = section('function viewStudy(', 'function rdAddModal(');
  assert.match(study, /title: '온라인 학습'[^\n]*keys: ONLINE_LEARNING_SOURCE_KEYS/);
  assert.match(study, /title: '자기주도 학습'[^\n]*keys: \['wb_reading', 'reading', 'inquiry_report'\]/);
});

test('ClassCard opens the native app store route only on supported mobile devices', () => {
  const source = html.match(/function classcardAppUrl\(userAgent, maxTouchPoints\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(source, 'classcardAppUrl function must exist');
  const classcardAppUrl = Function(
    "const CLASSCARD_ANDROID_APP_URL='https://play.google.com/store/apps/details?id=classcard.net';" +
    "const CLASSCARD_IOS_APP_URL='https://apps.apple.com/kr/app/id1176435331';" +
    source + '\nreturn classcardAppUrl;'
  )();

  assert.equal(classcardAppUrl('Mozilla/5.0 (Linux; Android 14)', 5), 'https://play.google.com/store/apps/details?id=classcard.net');
  assert.equal(classcardAppUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 5), 'https://apps.apple.com/kr/app/id1176435331');
  assert.equal(classcardAppUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5), 'https://apps.apple.com/kr/app/id1176435331');
  assert.equal(classcardAppUrl('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0), '');
  assert.equal(classcardAppUrl('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0), '');

  const classcard = section('  classcard: {', '  studyforce: {');
  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  assert.match(classcard, /appOnly: true/);
  assert.doesNotMatch(classcard, /centerUrl|studentUrl/);
  assert.match(card, /classcardAppUrl\(navigator\.userAgent, navigator\.maxTouchPoints\)/);
  assert.match(card, /공식 앱 스토어 화면으로 이동합니다/);
  assert.match(card, /이미 설치했다면 ‘열기’를 눌러 주세요/);
  assert.match(card, /클래스카드 앱 연결은 휴대폰에서 이 화면을 열어 이용하세요/);
  assert.doesNotMatch(classcard, /https:\/\//);
});

test('learning tasks stay student-scoped and only the director can send them', () => {
  const list = section('function learningTasksFor(', 'function learningSourceCard(');
  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  const rows = section('function taskRow(', 'function taskPanel(');
  const modal = section('function learningTaskModal(', 'function wnAddModal(');
  const add = section("case 'learnadd':", "case 'learnsave':");
  const save = section("case 'learnsave':", '/* 회독 */');
  assert.match(list, /t\.staffId === staffId/);
  assert.match(list, /t\.source === sourceKey/);
  assert.match(card, /learningTasksFor\(me\.id, sourceKey\)/);
  assert.match(card, /String\(row\.dailyCarryFrom \|\| ''\)\.startsWith\(task\.id \+ '\|'\)/);
  assert.match(card, /studentDue[\s\S]*?occurrenceDate\(task\) <= today\(\)/);
  assert.match(card, /‘학습 완료 기록’/);
  assert.match(card, /taskRow\(t, occurrenceDate\(t\), editable, false\)/);
  assert.match(card, /<details class="card study-source-card"/);
  assert.match(card, /완료 기록/);
  assert.match(card, /data-act="learningchecklistopen"/);
  assert.match(card, /director && sourceKey !== 'leaders_eye'[\s\S]*?data-act="learnadd"/);
  assert.match(card, /data-source="' \+ esc\(sourceKey\)/);
  assert.match(add, /const sourceKey = el\.dataset\.source/);
  assert.match(add, /!LEARNING_SOURCES\[sourceKey\]/);
  assert.match(add, /learningTaskModal\(sourceKey\)/);
  assert.match(modal, /id="learnSource" value="' \+ esc\(sourceKey\)/);
  assert.doesNotMatch(modal, /<select[^>]+id="learnSource"/);

  assert.match(save, /if \(!session\.isAdmin\) break/);
  assert.match(save, /state\.tasks\.push\(/);
  assert.match(save, /staffId: me\.id/);
  assert.match(save, /source: sourceKey/);
  assert.match(save, /origin: 'admin'/);
  assert.match(save, /repeat: 'once'/);
  assert.match(save, /studySubject: subjectKey/);
  assert.match(save, /dueDate: due/);
  assert.match(save, /estimatedMin: estimatedMin/);
  assert.match(save, /academicEventId: linkedExam \? linkedExam\.id : ''/);
  assert.match(save, /start: planned/);
  assert.match(save, /steps: source\.steps\.map/);
  assert.match(save, /save\(\); queueSync\(\)/);
  assert.match(rows, /learningState \? '' : '<button class="box"/);
  assert.match(rows, /data-act="learningresultopen"/);
  assert.match(rows, /✓ 학습 완료 기록/);
});

test('learning schedule, deadline, subject and weekly move stay distinct across tabs', () => {
  const helpers = section('function learningTaskDate(', 'function learningTasksFor(');
  const modal = section('function learningTaskModal(', 'function wnAddModal(');
  const edit = section('function saveEditedTask(', '8-1. 말로 쓴 지시를 업무로');
  const rows = section('function taskRow(', 'function taskPanel(');
  assert.match(helpers, /weekMovesFor\(task\.staffId\)/);
  assert.match(helpers, /return move \? move\.to : \(task\.start \|\| ''\)/);
  assert.match(helpers, /task\.dueDate \|\| task\.start/);
  assert.match(modal, /id="learnSubject"/);
  assert.match(modal, /id="learnEstimatedMin"/);
  assert.match(modal, /id="learnStudyDate"/);
  assert.match(modal, /id="learnDueDate"/);
  assert.match(modal, /id="learnAcademicEvent"/);
  assert.match(edit, /마감일은 학습 예정일보다 빠를 수 없습니다/);
  assert.match(edit, /moveCheck\.moves\.filter\(move => move\.taskId !== t\.id\)/);
  assert.match(rows, /learningDueDate\(t(?:, date)?\)/);
  assert.match(rows, /예상 /);
  assert.match(rows, /linkedExam\.title/);
});

test('wrong answers and reading rounds can become timed today checklist tasks', () => {
  const review = section('function rdDue(', 'function wnRow(');
  const today = section('function viewToday(', 'function studyOffersCard(');
  const handlers = section("case 'rdsave':", '/* 인강 플래너 */');
  assert.match(today, /studyReviewOffersCard\(me\)/);
  assert.match(review, /function studyReviewOffersCard\(me\)/);
  assert.match(review, /data-act="wnclaim"/);
  assert.match(review, /data-act="rdclaim"/);
  assert.match(review, /function syncLinkedStudyTask\(task, date\)/);
  assert.match(review, /stTimelineSegments\(task\.staffId, date\)/);
  assert.match(handlers, /source: 'reading_round'/);
  assert.match(handlers, /source: 'wrong_note_review'/);
  assert.match(handlers, /nextReviewDate: addDays\(d, WN_REVIEW\[0\]\)/);
  assert.match(handlers, /history\.push/);
});

test('exam materials accept only safe HTTPS links and open without leaking the student URL', () => {
  const source = html.match(/function safeHttpsUrl\(value\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(source, 'safeHttpsUrl function must exist');
  const safeHttpsUrl = Function(source + '\nreturn safeHttpsUrl;')();

  assert.equal(safeHttpsUrl('https://example.com/material.pdf'), 'https://example.com/material.pdf');
  ['http://example.com', 'javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/a.pdf', '/relative.pdf',
    'https://user:pass@example.com/a'].forEach(url => assert.equal(safeHttpsUrl(url), ''));

  const panel = section('function taskPanel(', 'function staffSwitcher(');
  const save = section("case 'learnsave':", '/* 회독 */');
  assert.match(panel, /safeHttpsUrl\(t\.resourceUrl\)/);
  assert.match(panel, /href="' \+ esc\(resourceUrl\)/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
  assert.match(panel, /시험대비자료 열기/);
  assert.match(save, /rawUrl && !resourceUrl/);
  assert.match(save, /sourceKey === 'exam_material' && !resourceUrl/);
  assert.match(save, /resourceUrl: resourceUrl/);
  assert.match(html, /id="eResourceUrl"/);
  assert.match(html, /resourceEl && rawResourceUrl && !resourceUrl/);
  assert.match(html, /t\.source === 'exam_material' && resourceEl && !resourceUrl/);
});
