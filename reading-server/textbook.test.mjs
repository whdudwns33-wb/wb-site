'use strict';
/* 교재 코칭 검증 (node reading-server/textbook.test.mjs) */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookIndex, coachingCard, findBook, findLesson, validProgress } from './textbook.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const TB = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'reading', 'textbook.json'), 'utf8'));

/* 확정된 강 하나를 흉내 낸 교재 — 실제 파일은 아직 전부 미확정이다 */
const FIX = {
  books: [{
    id: 'b1', title: '테스트 교재 1단계', short: '테스트 1단계', grade: '초1',
    lessons: [
      { lesson: 1, week: 1, title: '첫 강', pages: '9~14p', coaching: '앞 문단\n\n뒤 문단', words: ['가', '나', '다'], confirmed: true },
      { lesson: 2, week: 2, title: '둘째 강', pages: '', coaching: '코칭', words: ['라'], confirmed: false },
    ],
  }],
};
/* vocab/index.html assignedWords()가 만드는 id 규칙과 같아야 한다 */
const assign = (id, words) => ({ items: [{ id, title: '배정', at: '', words: words.map(w => ({ word: w })), done: false }] });
const st = (o) => ({ state: { states: o } });

t('실제 textbook.json — 초1 20강, 코칭글이 모두 있다', () => {
  const b = findBook(TB, 'eoduk-cho1');
  assert.ok(b, '교재를 찾아야 한다');
  assert.strictEqual(b.lessons.length, 20);
  for (const l of b.lessons) {
    assert.ok(l.coaching && l.coaching.length > 300, l.lesson + '강 코칭글이 너무 짧다');
    assert.ok(l.title, l.lesson + '강 제목 없음');
    /* 문단이 살아 있어야 한다 — 한 줄로 눌리면 휴대폰에서 안 읽힌다 */
    assert.ok(l.coaching.includes('\n'), l.lesson + '강 코칭글에 줄바꿈이 없다');
    assert.ok(!l.coaching.includes('""'), l.lesson + '강에 겹따옴표가 남았다');
  }
});

t('강사 검수 전에는 낱말이 나가지 않는다', () => {
  for (const l of findBook(TB, 'eoduk-cho1').lessons) {
    if (l.confirmed) continue;
    const card = coachingCard(TB, { bookId: 'eoduk-cho1', lesson: l.lesson }, null, null);
    assert.deepStrictEqual(card.words, [], l.lesson + '강 미확정인데 낱말이 나갔다');
    assert.ok(card.coaching.length > 0, '코칭글은 검수와 무관하게 나가야 한다');
  }
});

t('없는 교재·강은 거절한다', () => {
  assert.strictEqual(validProgress(FIX, 'nope', 1).ok, false);
  assert.strictEqual(validProgress(FIX, 'b1', 99).ok, false);
  assert.strictEqual(validProgress(FIX, 'b1', 99).error, '없는 강이에요.');
  assert.strictEqual(validProgress(FIX, 'b1', 1).ok, true);
  assert.strictEqual(validProgress(FIX, 'b1', '2').ok, true, '문자열 강 번호도 받는다');
});

t('진도가 없으면 카드도 없다', () => {
  assert.strictEqual(coachingCard(FIX, null, null, null), null);
  assert.strictEqual(coachingCard(FIX, {}, null, null), null);
  assert.strictEqual(coachingCard(FIX, { bookId: 'b1', lesson: 99 }, null, null), null, '지운 강을 가리키면 카드를 만들지 않는다');
});

t('확정된 강은 낱말과 진도를 함께 낸다', () => {
  const card = coachingCard(FIX, { bookId: 'b1', lesson: 1 },
    st({ 'tw-a1-0': { step: 4 }, 'tw-a1-1': { step: 1 } }), assign('a1', ['가', '나', '다']));
  assert.deepStrictEqual(card.words, ['가', '나', '다']);
  assert.strictEqual(card.planted, 2, '심은 낱말 2개');
  assert.strictEqual(card.rooted, 1, '3계단 넘긴 것만 뿌리내림');
  assert.deepStrictEqual(card.notYet, ['나']);
  assert.strictEqual(card.pages, '9~14p');
});

t('졸업한 낱말도 뿌리내린 것으로 센다', () => {
  const card = coachingCard(FIX, { bookId: 'b1', lesson: 1 },
    st({ 'tw-a1-0': { step: 0, graduated: true } }), assign('a1', ['가']));
  assert.strictEqual(card.rooted, 1);
  assert.deepStrictEqual(card.notYet, []);
});

t('같은 낱말이 두 번 배정되면 더 자란 쪽을 쓴다', () => {
  const rec = { items: [
    { id: 'a2', words: [{ word: '가' }] },
    { id: 'a1', words: [{ word: '가' }] },
  ] };
  const card = coachingCard(FIX, { bookId: 'b1', lesson: 1 },
    st({ 'tw-a1-0': { step: 5 }, 'tw-a2-0': { step: 0 } }), rec);
  assert.strictEqual(card.rooted, 1, '더 자란 배정을 골라야 한다');
});

t('아직인 낱말 목록은 4개까지만 보낸다', () => {
  const many = ['가', '나', '다', '라', '마', '바'];
  const fix = { books: [{ id: 'b1', lessons: [{ lesson: 1, title: 'x', coaching: 'c', words: many, confirmed: true }] }] };
  const states = {};
  many.forEach((w, i) => { states['tw-a1-' + i] = { step: 0 }; });
  const card = coachingCard(fix, { bookId: 'b1', lesson: 1 }, st(states), assign('a1', many));
  assert.strictEqual(card.planted, 6);
  assert.strictEqual(card.notYet.length, 4);
});

t('낱말 id 규칙이 앱과 같다', () => {
  /* 이 규칙이 어긋나면 학부모 화면의 낱말 진도가 조용히 0이 된다 */
  const app = fs.readFileSync(path.join(ROOT, '..', 'vocab', 'index.html'), 'utf8');
  assert.ok(app.includes("'tw-' + a.id + '-' + i"), 'vocab/index.html의 낱말 id 규칙이 바뀌었다 — textbook.mjs도 함께 고쳐야 한다');
});

t('강사 목차에는 코칭 원문이 실리지 않는다', () => {
  const idx = bookIndex(TB);
  assert.strictEqual(idx.length, TB.books.length);
  assert.strictEqual(JSON.stringify(idx).includes('안녕하세요'), false, '목차에 코칭 원문이 새어 나갔다');
  assert.strictEqual(idx[0].lessons[0].words, findLesson(findBook(TB, 'eoduk-cho1'), 1).words.length, '낱말은 개수만');
  assert.strictEqual(typeof idx[0].lessons[0].confirmed, 'boolean');
});

t('빈 교재에도 터지지 않는다', () => {
  assert.deepStrictEqual(bookIndex(null), []);
  assert.strictEqual(findBook(null, 'x'), null);
  assert.strictEqual(coachingCard({ books: [] }, { bookId: 'x', lesson: 1 }, null, null), null);
});

console.log('\n통과 ' + passed + '개 — 교재 코칭 검증 완료');
