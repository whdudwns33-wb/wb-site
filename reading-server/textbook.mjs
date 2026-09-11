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
/* 뜻의 출처 — 검수 화면에서 무게를 달리 보라고 표시할 뿐이라, 아는 값만 통과시킨다.
     coaching — 코칭글에서 그대로 옮긴 것
     fixed    — 코칭글에서 옮겼지만 끝이 잘려("…말하는") 손으로 마무리한 것
     ai       — 코칭글에 설명이 없어 대신 쓴 것 */
const SRC = ['coaching', 'fixed', 'ai'];

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

/* 검수를 끝냈다고 하려면 낱말마다 뜻이 있어야 한다 — 뜻 없는 낱말은 학생이 공부할 수 없다.
   낱말이 아예 없는 강은 통과시킨다: 1강처럼 자음·모음을 배우는 주에는 외울 낱말이 없고,
   그걸 막아 두면 그 강은 영영 검수를 못 끝내 진행 표시가 20/20이 될 수 없다. */
export function readyToConfirm(words) {
  const list = cleanWords(words);
  if (!list.length) return { ok: true, words: [] };
  const blank = list.filter((w) => !w.meaning).map((w) => w.word);
  if (blank.length) return { ok: false, error: '뜻이 비어 있어요: ' + blank.slice(0, 5).join(', ') + (blank.length > 5 ? ' 외 ' + (blank.length - 5) + '개' : '') };
  return { ok: true, words: list };
}

/* 교재 한 권을 통째로 열고 닫는다.
   한 강씩 40번 누르는 대신 한 번에 끝내되, 낱말마다 뜻이 있어야 한다는 조건은 그대로 건다 —
   뜻 빈 강이 섞여 있으면 그 강만 건너뛰고 어느 강이 왜 남았는지 돌려준다.
   되돌리기(닫기)에는 조건을 걸지 않는다. 잘못 열었을 때 막힘없이 닫을 수 있어야 한다. */
export function confirmAllPlan(book, overlay, confirmed) {
  const ov = overlay || {};
  const out = { entries: [], done: [], blocked: [], skipped: [] };
  for (const l of (book && book.lessons) || []) {
    const key = String(book.id) + '#' + Number(l.lesson);
    const cur = ov[key];
    /* 강사가 고쳐 둔 값이 있으면 그것을, 없으면 교재 원본을 쓴다 */
    const words = cleanWords(cur && cur.words ? cur.words : l.words);
    if (confirmed) {
      const r = readyToConfirm(words);
      if (!r.ok) { out.blocked.push({ lesson: l.lesson, title: l.title, error: r.error }); continue; }
      if (cur && cur.confirmed) { out.skipped.push(l.lesson); continue; }
      out.entries.push({ key, value: { words: r.words, confirmed: true } });
      out.done.push(l.lesson);
    } else {
      if (!(cur && cur.confirmed)) { out.skipped.push(l.lesson); continue; }
      out.entries.push({ key, value: { words, confirmed: false } });
      out.done.push(l.lesson);
    }
  }
  return out;
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

/* 원문 업로드 검증(구조) + 책별 요약 — 원문이 공개 저장소에서 서버 저장소로 옮겨지면서
   (2026-09), "넣다가 흘린 강"을 잡던 저장소 테스트의 역할을 업로드 관문이 이어받는다.
   개수 기준을 하드코딩하지 않고 책별 강 수·빈 코칭 수를 되돌려 강사가 눈으로 확인한다. */
export function sourceSummary(tb) {
  const errors = [];
  if (!tb || typeof tb !== 'object' || !Array.isArray(tb.books)) {
    return { errors: ['books 배열이 필요합니다 — reading/textbook.json 형식 그대로 올려 주세요.'], books: [] };
  }
  const seen = new Set();
  const books = tb.books.map((b, i) => {
    const id = String((b && b.id) || '');
    if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) errors.push(`books[${i}] id 형식 오류: ${id || '(없음)'}`);
    else if (seen.has(id)) errors.push(`books[${i}] id 중복: ${id}`);
    else seen.add(id);
    const lessons = Array.isArray(b && b.lessons) ? b.lessons : [];
    if (!lessons.length) errors.push(`${id || 'books[' + i + ']'}: lessons 비었음`);
    let emptyCoaching = 0;
    lessons.forEach((l, j) => {
      if (!l || typeof l.lesson !== 'number') errors.push(`${id} lessons[${j}] lesson 번호 없음`);
      if (!l || !String(l.coaching || '').trim()) emptyCoaching += 1;
    });
    return { id, title: String((b && b.title) || ''), lessons: lessons.length, emptyCoaching };
  });
  return { errors, books };
}
