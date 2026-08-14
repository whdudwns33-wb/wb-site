const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function diffHtml(task, changes) {
  const start = source.indexOf('function lessonChangeDiffHtml(');
  const end = source.indexOf('function ownLessonChangeCard(', start);
  const factory = new Function('DOW', 'LESSON_CHANGE_REPEAT_LABEL', 'esc',
    source.slice(start, end) + '\nreturn lessonChangeDiffHtml;');
  const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  return factory(['일', '월', '화', '수', '목', '금', '토'], { weekly: '매주' }, esc)(task, changes);
}

test('관리자 수업 변경 검토는 요청된 항목만 변경 전과 변경 후로 나란히 표시한다', () => {
  const html = diffHtml(
    { days: [1, 3], time: '16:00', repeat: 'weekly', detail: '기존 진도', guide: '기존 메모' },
    { days: [2, 4], time: '17:00', detail: '새 진도 <확인>' }
  );
  assert.match(html, /요일[\s\S]*변경 전[\s\S]*월·수[\s\S]*변경 후[\s\S]*화·목/);
  assert.match(html, /시간[\s\S]*16:00[\s\S]*17:00/);
  assert.match(html, /교재·진도[\s\S]*기존 진도[\s\S]*새 진도 &lt;확인&gt;/);
  assert.doesNotMatch(html, /수업 메모/);
});

test('관리자 변경 요청 카드는 문장 요약 대신 전후 비교 표를 사용한다', () => {
  const start = source.indexOf('function lessonChangeQueueCard(');
  const end = source.indexOf('function viewLessonChangeReview(', start);
  const card = source.slice(start, end);
  assert.match(card, /lessonChangeDiffHtml\(task, item\.changes\)/);
  assert.doesNotMatch(card, /lessonChangeSummary\(item\.changes\)/);
  assert.match(source, /\.lesson-change-after \{ border-color: #B9E3C7; background: #F3FCF6; \}/);
});
