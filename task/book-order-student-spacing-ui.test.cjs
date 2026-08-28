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

function bookOrderStudentLabelCore() {
  return new Function(`${functionBlock('schoolLevelLabel')}
    ${functionBlock('schoolGradeDisplayLabel')}
    ${functionBlock('studentDisplayGradeLabel')}
    ${functionBlock('studentSchoolGradeDetailLabel')}
    ${functionBlock('bookOrderStudentSchoolGradeLabel')}
    return { bookOrderStudentSchoolGradeLabel };`)();
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
    assert.match(picker, /bookOrderStudentSchoolGradeLabel\(student\)/);
    assert.doesNotMatch(picker, /studentSchoolGradeDetailLabel\(student\)/);
  }
});

test('교재 학생 표시는 중복 학교급만 숨기고 실제 학교명과 충돌 정보는 유지한다', () => {
  const core = bookOrderStudentLabelCore();
  const elementary = { school: '초', grade: '3' };

  assert.equal(core.bookOrderStudentSchoolGradeLabel(elementary), '초3');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: ' 초등학교 ', grade: '초 3학년' }), '초3');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '중', grade: '2학년' }), '중2');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '고교', grade: '1' }), '고1');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '유안초', grade: '6' }), '유안초 · 초6');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '치평중학교', grade: '2' }), '치평중학교 · 중2');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '초', grade: '중3' }), '초 · 중3');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '', grade: '3' }), '3');
  assert.equal(core.bookOrderStudentSchoolGradeLabel({ school: '초', grade: '' }), '초');
  assert.deepEqual(elementary, { school: '초', grade: '3' });
});
