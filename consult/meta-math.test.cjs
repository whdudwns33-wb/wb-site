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

test('learning hub supports all seven study sources and keeps legacy MetaMath tasks', () => {
  const sources = section('const LEARNING_SOURCES', 'const DOW');
  [
    ['metamath', '메타수학'],
    ['classcard', '클래스카드'],
    ['studyforce', '스터디포스'],
    ['wb_reading', '자체 독해력 교재'],
    ['reading', '독서'],
    ['inquiry_report', '탐구보고서'],
    ['exam_material', '시험대비자료']
  ].forEach(([key, label]) => {
    assert.match(sources, new RegExp('\\b' + key + ': \\{'));
    assert.ok(sources.includes("label: '" + label + "'"));
  });

  const rows = section('function taskRow(', 'function taskPanel(');
  assert.match(rows, /LEARNING_SOURCES\[t\.source\]/);
  assert.match(rows, /t\.learningKind \|\| t\.metaKind/);
});

test('external study services use fixed official links without embedded login', () => {
  assert.match(html, /const METAMATH_CENTER_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=center'/);
  assert.match(html, /const METAMATH_STUDENT_URL = 'https:\/\/www\.mmatht\.co\.kr\/Pages\/home2\/login\.cshtml\?kind=student'/);
  assert.match(html, /const CLASSCARD_URL = 'https:\/\/www\.classcard\.net\/Login'/);
  assert.match(html, /const STUDYFORCE_STUDENT_URL = 'https:\/\/www\.studyforce\.co\.kr\/user\/user_login\/\?go_url=%2F'/);

  const card = section('function learningHubCard(', '/* ── 학습 탭');
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(card, /iframe|fetch\(|type="password"/i);
});

test('learning tasks stay student-scoped and only the director can send them', () => {
  const list = section('function learningTasksFor(', 'function learningHubCard(');
  const card = section('function learningHubCard(', '/* ── 학습 탭');
  const save = section("case 'learnsave':", '/* 회독 */');
  assert.match(list, /t\.staffId === staffId/);
  assert.match(list, /!!LEARNING_SOURCES\[t\.source\]/);
  assert.match(card, /learningTasksFor\(me\.id\)/);
  assert.match(card, /taskRow\(t, t\.start, editable, false\)/);
  assert.match(card, /director \? '<button[^']*data-act="learnadd"/);
  assert.match(card, /학생 과제·자료 발행은 원장 화면에서/);

  assert.match(save, /if \(!session\.isAdmin\) break/);
  assert.match(save, /state\.tasks\.push\(/);
  assert.match(save, /staffId: me\.id/);
  assert.match(save, /source: sourceKey/);
  assert.match(save, /origin: 'admin'/);
  assert.match(save, /repeat: 'once'/);
  assert.match(save, /start: due/);
  assert.match(save, /steps: source\.steps\.map/);
  assert.match(save, /save\(\); queueSync\(\)/);
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
