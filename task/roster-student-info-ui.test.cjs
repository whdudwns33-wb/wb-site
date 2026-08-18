const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} 구간을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

test('관리자 기본 정보 목록과 선생님 내 학생 목록의 이름이 정보 팝업을 연다', () => {
  const view = block('function viewRoster()', '/* ── 직원 관리');
  assert.equal((view.match(/data-act="rosterstudentinfo"/g) || []).length, 2);
  assert.match(view, /managed\.map\(student =>[\s\S]*data-act="rosterstudentinfo" data-id="' \+ esc\(student\.id\)/);
  assert.match(view, /mineActive\.map\(s =>[\s\S]*data-act="rosterstudentinfo" data-id="' \+ esc\(s\.id\)/);
  assert.match(view, /aria-label="' \+ esc\(student\.name\) \+ ' 학생 정보 보기"/);
  assert.match(view, /aria-label="' \+ esc\(s\.name\) \+ ' 학생 정보 보기"/);
  assert.match(source, /case 'rosterstudentinfo': showRosterStudentInfo\(String\(id \|\| ''\)\)/);
});

test('학생 정보 팝업은 기본 정보를 escape하고 연락처를 만들지 않는다', () => {
  const code = block('function rosterStudentInfoStatus(', 'function showRosterStudentInfo(');
  const render = new Function('today', 'esc', `${code}\nreturn rosterStudentInfoHtml;`)(
    () => '2026-08-18', escapeHtml
  );
  const attack = '<img src=x onerror=alert(1)>';
  const html = render({
    id: 'student-safe', name: attack, grade: attack, subject: attack, teacher: attack,
    start: '2026-08', end: '', reason: '', memo: attack
  });
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  for (const label of ['학년', '과목·분야', '담당 선생님', '재원 기간', '내부 메모']) {
    assert.match(html, new RegExp(label));
  }
  assert.doesNotMatch(code, /phone|contact|guardian/i);
});

test('팝업은 이름 추측 없이 현재 권한 범위의 stable studentId만 조회한다', () => {
  const code = block('function showRosterStudentInfo(', 'let rosterStudentEditor');
  assert.match(code, /rosterDb\.students\.find\(item => String\(item\.id\) === String\(studentId\)\)/);
  assert.doesNotMatch(code, /find\([^\n]*name|student\.name\s*===/);
  assert.match(code, /session\.isAdmin[\s\S]*data-act="rosterstudentedit"/);
  assert.match(source, /\.student-info-name \{[^}]*min-height: 44px/);
  assert.match(source, /\.student-info-name:focus-visible/);
  assert.match(source, /@media\(max-width:430px\) \{[\s\S]*\.student-info-grid \{ grid-template-columns: 1fr; \}/);
});
