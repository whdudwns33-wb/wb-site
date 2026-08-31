'use strict';
/* 교재 코칭 — 강사가 학생의 진도(교재·강)를 정하면 학부모 리포트에 그 주 코칭이 실린다.
   코칭글은 WB가 직접 쓴 글이다. words는 코칭글에서 뽑은 후보라서,
   강사가 확정(confirmed)하기 전에는 학생·학부모에게 내보내지 않는다. */

export function findBook(tb, bookId) {
  const books = (tb && tb.books) || [];
  return books.find((b) => b.id === bookId) || null;
}

export function findLesson(book, lesson) {
  if (!book) return null;
  const n = Number(lesson);
  return (book.lessons || []).find((l) => l.lesson === n) || null;
}

/* 강사가 지정할 수 있는 값인지 — 없는 교재·강을 저장하면 학부모 화면이 빈칸이 된다 */
export function validProgress(tb, bookId, lesson) {
  const book = findBook(tb, bookId);
  if (!book) return { ok: false, error: '없는 교재예요.' };
  const l = findLesson(book, lesson);
  if (!l) return { ok: false, error: '없는 강이에요.' };
  return { ok: true, book, lesson: l };
}

/* 강사 화면용 목차 — 코칭 원문(강당 1,500자)은 빼고 고르는 데 필요한 것만 보낸다 */
export function bookIndex(tb) {
  return ((tb && tb.books) || []).map((b) => ({
    id: b.id, title: b.title, short: b.short || b.title, grade: b.grade || '',
    lessons: (b.lessons || []).map((l) => ({
      lesson: l.lesson, week: l.week, title: l.title, pages: l.pages || '',
      words: (l.words || []).length, confirmed: !!l.confirmed,
    })),
  }));
}

/* 낱말 → SRS 상태.
   상태는 낱말 글자가 아니라 id로 저장된다(WBSRS.plant(id)). 선생님이 내준 낱말의 id는
   앱이 'tw-<배정id>-<순번>'으로 만든다 — vocab/index.html의 assignedWords()와 같은 규칙이라,
   한쪽만 바꾸면 학부모 화면의 낱말 진도가 조용히 0이 된다. quiz/srs 테스트가 이 규칙을 붙잡는다. */
function plantedByWord(vocabState, assignRec) {
  const states = (vocabState && vocabState.state && vocabState.state.states) || {};
  const out = {};
  for (const a of (assignRec && assignRec.items) || []) {
    (a.words || []).forEach((w, i) => {
      const s = states['tw-' + a.id + '-' + i];
      /* 같은 낱말이 여러 번 배정될 수 있다 — 더 자란 쪽을 남긴다 */
      if (!s || !w || !w.word) return;
      const prev = out[w.word];
      if (!prev || (s.step || 0) > (prev.step || 0) || (s.graduated && !prev.graduated)) out[w.word] = s;
    });
  }
  return out;
}

/* 학부모 리포트에 실을 카드. 낱말은 확정된 것만, 그리고 아이가 어디까지 왔는지 붙인다. */
export function coachingCard(tb, prog, vocabState, assignRec) {
  if (!prog || !prog.bookId) return null;
  const book = findBook(tb, prog.bookId);
  const l = findLesson(book, prog.lesson);
  if (!book || !l) return null;

  const card = {
    bookTitle: book.short || book.title,
    lesson: l.lesson,
    week: l.week,
    title: l.title,
    pages: l.pages || '',
    coaching: l.coaching || '',
    words: [],
    planted: 0,
    rooted: 0,
    notYet: [],
  };
  if (!l.confirmed || !l.words || !l.words.length) return card;

  card.words = l.words.slice();
  const grown = plantedByWord(vocabState, assignRec);
  for (const w of card.words) {
    const s = grown[w];
    if (!s) continue;
    card.planted += 1;
    /* 3계단(7일 간격)을 넘겼으면 뿌리내린 것으로 본다 */
    if (s.graduated || (s.step || 0) >= 3) card.rooted += 1;
    else card.notYet.push(w);
  }
  card.notYet = card.notYet.slice(0, 4);
  return card;
}
