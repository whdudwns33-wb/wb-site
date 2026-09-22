'use strict';
/* 어휘브레인 문항 출제 검증 (node hanja/quiz.test.cjs)
 *
 * 문항이 조용히 안 나오거나(반환 null) 정답이 보기에 없으면 훈련 화면이 카드 넘기기로 퇴화한다.
 * 체험 단어장으로 어종별·계단별 유형이 실제로 만들어지는지, 정답이 늘 보기 안에 있는지 본다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Q = require('./quiz.js');
const B = require('./book-check.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

/* 결정적 난수 — 같은 씨앗이면 같은 문항 */
function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const book = B.checkBook(JSON.parse(fs.readFileSync(path.join(__dirname, 'book-sample.json'), 'utf8'))).book;
book.words.forEach((w) => { w._sid = 'w:' + book.id + ':' + w.id; });
book.chars.forEach((c) => { c._sid = 'c:' + c.ch; });
const ctx = { words: book.words, chars: book.chars, find: B.findInExample };
const byWord = (w) => book.words.find((x) => x.word === w);
const byCh = (ch) => book.chars.find((x) => x.ch === ch);

t('모든 유형이 정답을 보기 안에 두고 보기 4개가 서로 다르다', () => {
  const rnd = seeded(7);
  const kinds = {};
  book.words.forEach((w) => {
    Object.keys(Q.HEAD).filter((k) => k[0] === 'w').forEach((k) => {
      const q = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: [k] });
      if (!q) return;
      assert.strictEqual(q.kind, k, '허용 목록 밖의 유형이 나왔다');
      kinds[q.kind] = (kinds[q.kind] || 0) + 1;
      if (!q.input && !q.write) {
        assert.strictEqual(q.choices.length, 4, q.kind + ' ' + w.word);
        assert.ok(q.choices.indexOf(q.answer) >= 0, '정답이 보기에 없다: ' + q.kind + ' ' + w.word);
        assert.strictEqual(new Set(q.choices).size, 4, '보기가 겹친다: ' + q.kind + ' ' + w.word + ' ' + q.choices);
      }
      assert.strictEqual(q.id, w._sid);
      assert.ok(q.head, '머리말이 없다: ' + q.kind);
    });
  });
  book.chars.forEach((c) => {
    Object.keys(Q.HEAD).filter((k) => k[0] === 'c').forEach((k) => {
      const q = Q.makeQuestion({ kind: 'char', c }, ctx, { rnd, kinds: [k] });
      if (!q) return;
      assert.strictEqual(q.kind, k, '허용 목록 밖의 유형이 나왔다');
      kinds[q.kind] = (kinds[q.kind] || 0) + 1;
      if (q.write) { assert.strictEqual(q.answer, c.ch); assert.ok(Q.check(q, { level: 'good' }) && Q.check(q, { level: 'ok' }) && !Q.check(q, { level: 'retry' }) && !Q.check(q, null)); return; }
      assert.strictEqual(q.choices.length, 4, q.kind + ' ' + c.ch);
      assert.ok(q.choices.indexOf(q.answer) >= 0, '정답이 보기에 없다: ' + q.kind + ' ' + c.ch);
      assert.strictEqual(new Set(q.choices).size, 4, '보기가 겹친다: ' + q.kind + ' ' + c.ch + ' ' + q.choices);
    });
  });
  Object.keys(Q.HEAD).forEach((k) => assert.ok(kinds[k] > 0, k + ' 유형이 체험 단어장에서 한 번도 안 나온다'));
});

t('한자어 — 뜻·낱말·빈칸·조립·표기·쓰기가 모두 나온다 (관측)', () => {
  const rnd = seeded(3);
  const w = byWord('관측');
  const q1 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-meaning'] });
  assert.ok(/관측 \(觀測\)/.test(q1.prompt));
  assert.strictEqual(q1.answer, w.meaning);
  const q2 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-cloze'] });
  assert.ok(/○○○/.test(q2.prompt) && !/관측/.test(q2.prompt), '빈칸에 낱말이 남아 있다: ' + q2.prompt);
  assert.strictEqual(q2.answer, '관측');
  const q3 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-build'] });
  assert.ok(/□/.test(q3.prompt));
  assert.ok(['볼 관', '잴 측'].indexOf(q3.answer) >= 0);
  assert.ok(q3.choices.every((v) => v !== (q3.answer === '볼 관' ? '잴 측' : '볼 관')), '같은 낱말의 다른 글자 훈음이 오답 보기로 나왔다');
  const q4 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-hanja'] });
  assert.strictEqual(q4.answer, '觀測');
  assert.ok(q4.choices.every((v) => v.length === 2), '글자 수가 다른 한자 보기: ' + q4.choices);
  assert.ok(q4.choices.some((v) => v !== '觀測' && /觀/.test(v)), '觀 을 나눠 쓰는 낱말(관점·객관…)이 보기에 먼저 와야 한다: ' + q4.choices);
  const q5 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-type'] });
  assert.ok(q5.input && q5.answer === '관측' && /觀測/.test(q5.hint));
  assert.ok(Q.check(q5, ' 관 측 '), '띄어쓰기 차이로 틀리면 안 된다');
  assert.ok(!Q.check(q5, '관점'));
});

t('고유어 — 활용형 예문도 빈칸이 되고, 조립·표기 유형은 나오지 않는다', () => {
  const rnd = seeded(11);
  const w = byWord('엇갈리다');
  const q = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-cloze'] });
  assert.ok(q && /길에서 ○○○/.test(q.prompt), '활용형(엇갈렸다)을 못 가렸다: ' + (q && q.prompt));
  /* 허용 유형을 만들 수 없으면 다른 유형으로 바꾸지 않고 건너뛴다 */
  const fb = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-build'] });
  assert.strictEqual(fb, null);
  /* 낱말 고르기 보기는 같은 꼴(~다)끼리 — 명사 사이에 용언 하나면 문법만으로 답이 보인다 */
  const q2 = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd, kinds: ['w-word'] });
  assert.ok(q2.choices.every((v) => /다$/.test(v)), '고유어 용언 보기에 명사가 섞였다: ' + q2.choices);
});

t('한자 — 훈음·글자·낱말·획수 (觀·山)', () => {
  const rnd = seeded(5);
  const gwan = byCh('觀'), san = byCh('山');
  const q1 = Q.makeQuestion({ kind: 'char', c: gwan }, ctx, { rnd, kinds: ['c-hun'] });
  assert.strictEqual(q1.answer, '볼 관');
  const q2 = Q.makeQuestion({ kind: 'char', c: gwan }, ctx, { rnd, kinds: ['c-char'] });
  assert.strictEqual(q2.answer, '觀');
  assert.ok(q2.choices.every((v) => v.length === 1));
  const q3 = Q.makeQuestion({ kind: 'char', c: gwan }, ctx, { rnd, kinds: ['c-word'] });
  assert.ok(['관측', '관점', '객관', '주관', '관찰'].indexOf(q3.answer) >= 0, q3.answer);
  q3.choices.filter((v) => v !== q3.answer).forEach((v) => assert.ok(!/觀/.test(byWord(v).hanja), '觀 이 든 낱말이 오답 보기에 있다: ' + v));
  const q4 = Q.makeQuestion({ kind: 'char', c: san }, ctx, { rnd, kinds: ['c-count'] });
  assert.strictEqual(q4.answer, '3');
  assert.ok(q4.choices.every((v) => Number(v) >= 1));
  const noStrokes = { ch: '龜', hun: '거북', eum: '귀', unit: 'u01', _sid: 'c:龜' };
  assert.strictEqual(Q.makeQuestion({ kind: 'char', c: noStrokes }, ctx, { rnd, kinds: ['c-count'] }), null, '획수 없는 글자에 획수 문제가 나왔다');
});

t('계단이 오르면 재인에서 산출로 — 계단의 유형 묶음 안에서만 나오고, 같은 계단 안에서는 섞인다', () => {
  /* 계단이 난이도를 정하고 그 계단 안의 유형은 섞인다 — 고정이면 같은 계단 항목이 전부 같은 문제로 나온다.
     그래서 「무엇이 나오는가」가 아니라 「그 계단의 묶음 안에 있는가」를 지킨다. */
  const w = byWord('추론'), c = byCh('十');
  const kindsOf = (item, step, n) => {
    const out = new Set();
    for (let i = 1; i <= n; i++) { const q = Q.makeQuestion(item, ctx, { rnd: seeded(i), step: step }); if (q) out.add(q.kind); }
    return out;
  };
  const inTier = (got, tierList, where) => got.forEach((k) => assert.ok(tierList.includes(k), where + ' 에 없는 유형: ' + k));
  inTier(kindsOf({ kind: 'word', w }, 0, 12), Q.PLAN.word[0], '낱말 계단 0');
  inTier(kindsOf({ kind: 'word', w }, 4, 12), Q.PLAN.word[3], '낱말 계단 3');
  inTier(kindsOf({ kind: 'char', c }, 0, 12), Q.PLAN.char[0], '한자 계단 0');
  inTier(kindsOf({ kind: 'char', c }, 4, 12), Q.PLAN.char[3], '한자 계단 3');
  /* 재인에서 산출로 — 낮은 계단에 쓰기(산출)가 없고, 높은 계단에는 있다 */
  assert.ok(!Q.PLAN.word[0].includes('w-type') && Q.PLAN.word[3].includes('w-type'));
  assert.ok(!Q.PLAN.char[0].includes('c-write') && Q.PLAN.char[3].includes('c-write'));
  /* 섞이는지 — 씨앗을 바꾸면 한 계단 안에서 유형이 두 가지 이상 나온다 */
  assert.ok(kindsOf({ kind: 'char', c }, 0, 12).size >= 2, '같은 계단인데 유형이 하나뿐 — 섞이지 않는다');
  assert.deepStrictEqual([0, 1, 2, 3, 4, 6].map(Q.tier), [0, 1, 2, 2, 3, 3]);
});

t('고유어 비슷한 말 — 유의어가 정답, 다른 낱말의 유의어가 보기', () => {
  const w = byWord('거들다');
  const q = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd: seeded(2), kinds: ['w-syn'] });
  assert.strictEqual(q.kind, 'w-syn');
  assert.ok(w.syn.indexOf(q.answer) >= 0);
  q.choices.filter((v) => v !== q.answer).forEach((v) => assert.ok(w.syn.indexOf(v) < 0 && v !== w.word, '정답 낱말의 다른 유의어가 오답 보기에 있다: ' + v));
  assert.strictEqual(Q.makeQuestion({ kind: 'word', w: byWord('관측') }, ctx, { rnd: seeded(2), kinds: ['w-syn'] }), null, '유의어 없는 낱말에 비슷한 말 문항이 나왔다');
});

t('닮은 글자·같은 부수가 오답 보기로 먼저 온다', () => {
  const chars = [
    { ch: '日', hun: '날', eum: '일', unit: 'a', similar: ['目', '曰'], radical: '日', _sid: 'c:日' },
    { ch: '目', hun: '눈', eum: '목', unit: 'b', radical: '目', _sid: 'c:目' },
    { ch: '曰', hun: '가로', eum: '왈', unit: 'b', radical: '曰', _sid: 'c:曰' },
    { ch: '旦', hun: '아침', eum: '단', unit: 'b', radical: '日', _sid: 'c:旦' },
    { ch: '山', hun: '메', eum: '산', unit: 'a', radical: '山', _sid: 'c:山' },
    { ch: '水', hun: '물', eum: '수', unit: 'a', radical: '水', _sid: 'c:水' },
    { ch: '火', hun: '불', eum: '화', unit: 'a', radical: '火', _sid: 'c:火' },
  ];
  for (let seed = 1; seed <= 5; seed++) {
    const q = Q.makeQuestion({ kind: 'char', c: chars[0] }, { words: [], chars }, { rnd: seeded(seed), kinds: ['c-char'] });
    const wrong = q.choices.filter((v) => v !== '日');
    assert.deepStrictEqual(wrong.slice().sort(), ['旦', '曰', '目'], '닮은 글자·같은 부수 대신 다른 글자가 보기로 왔다: ' + wrong);
  }
});

t('같은 씨앗이면 같은 문항 — 화면이 다시 그려도 보기가 뒤바뀌지 않는다', () => {
  const w = byWord('모순');
  const a = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd: seeded(42), step: 2 });
  const b = Q.makeQuestion({ kind: 'word', w }, ctx, { rnd: seeded(42), step: 2 });
  assert.deepStrictEqual(a, b);
});

t('보기가 모자라면 null — 억지 문항을 내지 않는다', () => {
  const tiny = { words: book.words.slice(0, 2), chars: [], find: B.findInExample };
  const item = { kind: 'word', w: tiny.words[0] };
  assert.strictEqual(Q.makeQuestion(item, tiny, { rnd: seeded(1), kinds: ['w-meaning'] }), null, '보기 부족을 허용하지 않은 쓰기 문항으로 대체했다');
  assert.strictEqual(Q.makeQuestion(item, tiny, { rnd: seeded(1), kinds: ['w-meaning', 'w-type'] }).kind, 'w-type', '허용된 쓰기로는 대체할 수 있다');
  assert.strictEqual(Q.makeQuestion(item, tiny, { rnd: seeded(1), vocabulary: true }).kind, 'w-type', '어휘 모드도 허용 유형 안에서 대체한다');
  assert.strictEqual(Q.makeQuestion(item, ctx, { kinds: [] }), null, '빈 허용 목록을 무시했다');
  assert.strictEqual(Q.makeQuestion(item, ctx, { kinds: ['c-hun', 'unknown', 'constructor'] }), null, '낱말에 없는 유형을 허용했다');
  /* 훈음이 있는 글자는 보기가 없어도 쓰기 문항은 낼 수 있다 — 훈음이 없으면 아무 문항도 못 낸다 */
  const lone = { ch: '龜', hun: '거북', eum: '귀', unit: 'u01', _sid: 'c:龜' };
  const s = Q.session([{ kind: 'char', c: lone, step: 0 }], { words: [], chars: [lone] }, { rnd: seeded(1) });
  assert.strictEqual(s.questions.length, 1);
  assert.strictEqual(s.questions[0].kind, 'c-write');
  const mute = { ch: '龜', hun: '', eum: '', unit: 'u01', _sid: 'c:龜' };
  const s2 = Q.session([{ kind: 'char', c: mute, step: 0 }], { words: [], chars: [mute] }, { rnd: seeded(1) });
  assert.strictEqual(s2.questions.length, 0);
  assert.strictEqual(s2.skipped.length, 1);
});

t('세션 — 항목마다 계단에 맞는 문항 하나, max 로 자른다', () => {
  const items = book.words.slice(0, 6).map((w, i) => ({ kind: 'word', w, step: i }));
  const s = Q.session(items, ctx, { rnd: seeded(9), max: 4 });
  assert.strictEqual(s.questions.length, 4);
  assert.strictEqual(s.skipped.length, 0);
});

t('어휘 모드 — 계단별 어휘 유형만 내고 한자 병기·힌트를 숨긴다', () => {
  const allowed = ['w-meaning', 'w-word', 'w-cloze', 'w-type', 'w-syn'];
  const w = byWord('관측'), item = { kind: 'word', w };
  const meaning = Q.makeQuestion(item, ctx, { vocabulary: true, kinds: ['w-meaning'], rnd: seeded(2) });
  assert.strictEqual(meaning.prompt, '관측 의 뜻은?');
  const writing = Q.makeQuestion(item, ctx, { vocabulary: true, kinds: ['w-type'] });
  assert.strictEqual(writing.hint, '관 _');
  assert.strictEqual(Q.makeQuestion(item, ctx, { vocabulary: true, kinds: ['w-build', 'w-hanja'] }), null);
  [0, 1, 2, 4].forEach((step) => {
    const plan = Q.PLAN.word[Q.tier(step)].filter((k) => allowed.includes(k));
    for (let seed = 1; seed <= 12; seed++) {
      const q = Q.makeQuestion(item, ctx, { vocabulary: true, step, rnd: seeded(seed) });
      assert.ok(q && plan.includes(q.kind), '어휘 계단 ' + step + ' 밖의 유형: ' + (q && q.kind));
      const c = { kind: 'char', c: byCh('十') };
      assert.deepStrictEqual(Q.makeQuestion(c, ctx, { vocabulary: true, step, rnd: seeded(seed) }),
        Q.makeQuestion(c, ctx, { step, rnd: seeded(seed) }), '한자 문항까지 바뀌었다');
    }
  });
  const s = Q.session([item], ctx, { vocabulary: true, kinds: ['w-meaning'], rnd: seeded(2) });
  assert.deepStrictEqual(s.questions, [meaning], '세션에서 어휘 옵션을 잃었다');
  const skipped = Q.session([item], ctx, { vocabulary: true, kinds: ['w-hanja'] });
  assert.deepStrictEqual(skipped, { questions: [], skipped: [item] });
});

t('급수 교재 — 낱말 항목이 없어도 글자의 예시 낱말로 「이 글자가 든 낱말」 문항이 나온다', () => {
  /* 초등 한자 어휘 같은 급수 교재는 교재에 낱말 뜻이 없어 낱말 항목을 못 넣는다. 글자의 words 목록이 유일한 낱말 정보다. */
  const chars = [
    { ch: '一', hun: '한', eum: '일', unit: 'g01', strokes: 1, words: ['일등', '일주', '일생', '일주일'], _sid: 'c:一' },
    { ch: '二', hun: '두', eum: '이', unit: 'g02', strokes: 2, words: ['이월', '이중', '이십'], _sid: 'c:二' },
    { ch: '人', hun: '사람', eum: '인', unit: 'g03', strokes: 2, words: ['인기', '인물', '인간'], _sid: 'c:人' },
    { ch: '日', hun: '날', eum: '일', unit: 'g04', strokes: 4, words: ['요일', '매일', '일기'], _sid: 'c:日' },
  ];
  const ctx = { words: [], chars: chars };
  const q = Q.makeQuestion({ kind: 'char', c: chars[0], _sid: 'c:一' }, ctx, { kinds: ['c-word'], rnd: seeded(7) });
  assert.ok(q, '급수 교재에서 c-word 가 안 나온다');
  assert.strictEqual(q.kind, 'c-word');
  assert.ok(chars[0].words.includes(q.answer), '정답이 그 글자의 낱말이 아니다: ' + q.answer);
  assert.strictEqual(q.choices.length, 4);
  /* 보기는 다른 글자의 낱말에서 온다 — 같은 글자의 낱말이 오답으로 섞이면 정답이 둘이 된다 */
  const wrong = q.choices.filter((x) => x !== q.answer);
  assert.strictEqual(wrong.length, 3);
  wrong.forEach((w) => assert.ok(!chars[0].words.includes(w), '같은 글자의 낱말이 오답으로 섞였다: ' + w));
  assert.ok(/일등|일주|일생|일주일/.test(q.reveal || ''), '해설에 그 글자의 낱말 목록이 없다');
  /* 예시 낱말이 없으면 c-word 를 만들지 않는다 */
  const none = Q.makeQuestion({ kind: 'char', c: { ch: '天', hun: '하늘', eum: '천', unit: 'g05', strokes: 4, _sid: 'c:天' }, _sid: 'c:天' },
    { words: [], chars: [{ ch: '天', words: [] }] }, { kinds: ['c-word'], rnd: seeded(3) });
  assert.strictEqual(none, null, '예시 낱말이 없는데 문항을 만들었다');
  /* 낱말 항목이 있는 단어장은 예전처럼 그것을 쓴다 */
  const withWords = { words: [
    { word: '관측', hanja: '觀測', meaning: '재다', unit: 'u1' }, { word: '학교', hanja: '學校', meaning: '배우는 곳', unit: 'u1' },
    { word: '이월', hanja: '二月', meaning: '두 번째 달', unit: 'u1' }, { word: '인간', hanja: '人間', meaning: '사람', unit: 'u1' },
  ], chars: chars };
  const q2 = Q.makeQuestion({ kind: 'char', c: { ch: '觀', hun: '볼', eum: '관', unit: 'u1', words: ['안 쓰는 낱말'], _sid: 'c:觀' }, _sid: 'c:觀' },
    withWords, { kinds: ['c-word'], rnd: seeded(11) });
  assert.strictEqual(q2.answer, '관측', '낱말 항목이 있으면 그쪽이 먼저다');
});

console.log(`\nOK — ${passed}개 통과`);
