const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function functionBlock(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  assert.ok(match, `${name} 함수가 있어야 한다`);
  const start = match.index;
  const tail = source.slice(start + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.exec(tail);
  return source.slice(start, next ? start + match[0].length + next.index : source.length);
}

test('교재 주문의 모든 학생 선택 화면은 이름과 학교·학년을 명시적으로 띄운다', () => {
  assert.match(source, /\.book-order-picker-option \.card-sub \{ display: inline-block; margin-left: 7px; \}/);
  for (const name of [
    'orderStudentPicker', 'openBookOrderStudentLink', 'externalBookOrderOptionsHtml',
    'openInternalBookStudentModal', 'openBoundBookStudentModal'
  ]) {
    const picker = functionBlock(name);
    assert.match(picker, /esc\(student\.name \|\| '이름 미입력'\)[\s\S]{0,120}' <small class="card-sub">'/,
      `${name}에서 이름과 학교·학년 사이에 실제 공백이 있어야 한다`);
    assert.match(picker, /studentSchoolGradeDetailLabel\(student\)/);
  }
});
