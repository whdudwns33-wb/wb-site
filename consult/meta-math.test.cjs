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

test('study screen renders seven separate source cards and keeps legacy MetaMath tasks', () => {
  const sources = section('const LEARNING_SOURCES', 'const DOW');
  const expected = [
    ['metamath', '메타수학'],
    ['classcard', '클래스카드'],
    ['studyforce', '스터디포스'],
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
  assert.match(html, /const METAMATH_CENTER_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=center'/);
  assert.match(html, /const METAMATH_STUDENT_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=student'/);
  assert.match(html, /const CLASSCARD_ANDROID_APP_URL = 'https:\/\/play\.google\.com\/store\/apps\/details\?id=classcard\.net'/);
  assert.match(html, /const CLASSCARD_IOS_APP_URL = 'https:\/\/apps\.apple\.com\/kr\/app\/id1176435331'/);
  assert.doesNotMatch(html, /www\.classcard\.net\/Login/);
  assert.match(html, /const STUDYFORCE_URL = 'https:\/\/hol\.sfcenter\.co\.kr\/'/);
  assert.match(html, /centerUrl: STUDYFORCE_URL, studentUrl: STUDYFORCE_URL/);
  assert.doesNotMatch(html, /www\.studyforce\.co\.kr/);

  const card = section('function learningSourceCard(', '/* ── 학습 탭');
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /iframe|fetch\(|type="password"/i);
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
  const modal = section('function learningTaskModal(', 'function wnAddModal(');
  const add = section("case 'learnadd':", "case 'learnsave':");
  const save = section("case 'learnsave':", '/* 회독 */');
  assert.match(list, /t\.staffId === staffId/);
  assert.match(list, /t\.source === sourceKey/);
  assert.match(card, /learningTasksFor\(me\.id, sourceKey\)/);
  assert.match(card, /taskRow\(t, learningTaskDate\(t\), editable, false\)/);
  assert.match(card, /<details class="card study-source-card"/);
  assert.match(card, /완료 기록/);
  assert.match(card, /director \? '<button[^']*data-act="learnadd"/);
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
  assert.match(rows, /learningDueDate\(t\)/);
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
