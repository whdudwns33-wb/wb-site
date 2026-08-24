const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionSource(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' function must exist');
  const open = html.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = open; i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(name + ' function is incomplete');
}

test('student management sorts Korean names in 가나다 order', () => {
  const compare = Function(functionSource('studentNameCompare') + '; return studentNameCompare;')();
  const names = [{ name: '이재후' }, { name: '김민준' }, { name: '박하은' }].sort(compare).map(row => row.name);
  assert.deepEqual(names, ['김민준', '박하은', '이재후']);
  assert.match(functionSource('viewStaffAdmin'), /liveStaff\(\)\.slice\(\)\.sort\(studentNameCompare\)/);
});

test('usage evidence ignores configuration-only rows and accepts real study actions', () => {
  const isActivity = Function(functionSource('isStudentActivityCheck') + '; return isStudentActivityCheck;')();
  assert.equal(isActivity('__stgoal__s1|all', { mins: 180, updatedAt: 1 }), false);
  assert.equal(isActivity('__st__s1|2026-08-24', { secs: { 수학: 600 }, updatedAt: 2 }), true);
  assert.equal(isActivity('task-1|2026-08-24', { claimed: true, updatedAt: 3 }), true);
  assert.equal(isActivity('__ingp__s1|2026-08-24', { items: [{ claimed: true, done: false }], updatedAt: 4 }), true);
});

test('student management shows the three at-a-glance usage groups', () => {
  const source = functionSource('viewStaffAdmin');
  assert.match(source, /오늘 학습/);
  assert.match(source, /1~7일 전/);
  assert.match(source, /확인 필요/);
  assert.match(functionSource('studentUsageLine'), /오늘 순공/);
  assert.match(functionSource('studentUsageLine'), /하루 마감/);
});
