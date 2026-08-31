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
      /* 뜻이 채워진 개수 — 강 목록에서 "아직 몇 개 남았는지"가 바로 보여야 한다 */
      filled: (l.words || []).filter((w) => w && typeof w === 'object' && String(w.meaning || '').trim()).length,
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

  /* 학부모에게는 낱말 글자만 보낸다 — 뜻·예문은 강사 검수용이라 리포트를 길게 만들 뿐이다.
     오래된 파일은 낱말이 글자 배열이었다. 둘 다 받는다. */
  card.words = l.words.map((w) => (typeof w === 'string' ? w : (w && w.word) || '')).filter(Boolean);
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

/* ── 강사 검수 덧씌우기 ──
   교재 파일은 정적 자산이라 워커가 고쳐 쓸 수 없다. 그래서 검수 결과는 DB에 따로 두고
   읽을 때 덧씌운다 — articles.json 위에 pubmap을 얹는 것과 같은 방식이다.
   덧씌운 값이 원본을 이긴다: 강사가 고친 뜻이 뽑아 놓은 후보보다 언제나 옳다. */

const WORD_KEYS = ['word', 'meaning', 'example'];
/* 뜻의 출처 — coaching은 원장님 코칭글에서 옮긴 것, ai는 코칭글에 설명이 없어 대신 쓴 것.
   검수 화면에서 무게를 달리 보라고 표시할 뿐이라, 아는 값만 통과시킨다. */
const SRC = ['coaching', 'ai'];

/* 저장 전 다듬기 — 화면에서 온 값을 그대로 믿지 않는다 */
export function cleanWords(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const w = {};
    for (const k of WORD_KEYS) w[k] = String((raw && raw[k]) || '').trim().slice(0, 120);
    if (raw && SRC.indexOf(raw.src) >= 0 && w.meaning) w.src = raw.src;
    if (!w.word || seen.has(w.word)) continue;
    seen.add(w.word);
    out.push(w);
    if (out.length >= 60) break;
  }
  return out;
}

/* 검수를 끝냈다고 하려면 낱말마다 뜻이 있어야 한다 — 뜻 없는 낱말은 학생이 공부할 수 없다 */
export function readyToConfirm(words) {
  const list = cleanWords(words);
  if (!list.length) return { ok: false, error: '낱말이 없어요.' };
  const blank = list.filter((w) => !w.meaning).map((w) => w.word);
  if (blank.length) return { ok: false, error: '뜻이 비어 있어요: ' + blank.slice(0, 5).join(', ') + (blank.length > 5 ? ' 외 ' + (blank.length - 5) + '개' : '') };
  return { ok: true, words: list };
}

const ovKey = (bookId, lesson) => String(bookId) + '#' + Number(lesson);

/* 원본 교재 + 검수 덧씌우기 → 강사·학부모가 보는 실제 교재 */
export function withOverlay(tb, overlay) {
  if (!overlay || !Object.keys(overlay).length) return tb;
  const books = ((tb && tb.books) || []).map((b) => ({
    ...b,
    lessons: (b.lessons || []).map((l) => {
      const ov = overlay[ovKey(b.id, l.lesson)];
      if (!ov) return l;
      return {
        ...l,
        words: ov.words ? ov.words : l.words,
        confirmed: !!ov.confirmed,
        reviewedAt: ov.at || '',
      };
    }),
  }));
  return { ...tb, books };
}
