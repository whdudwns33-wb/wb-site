'use strict';
/* 단어장 검사·파서 검증 (node hanja/book-check.test.cjs)
 *
 * 관리 웹 업로드 관문·미리보기·CLI 검증기가 이 규칙 하나를 쓴다. 규칙이 조용히 느슨해지면
 * 라이선스 낱말이 잘못된 모양으로 학생 기기까지 가고, 엄격해지면 정상 단어장이 막힌다. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const B = require('./book-check.js');

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const sample = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'book-sample.json'), 'utf8'));

t('체험 단어장은 오류 없이 통과하고 셈이 맞는다', () => {
  const r = B.checkBook(sample());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.warns, [], '체험 단어장에 경고가 남아 있다: ' + JSON.stringify(r.warns));
  assert.strictEqual(r.counts.words, 48);
  assert.strictEqual(r.counts.hanja, 34);
  assert.strictEqual(r.counts.native, 14);
  assert.strictEqual(r.counts.units, 5);
  assert.ok(r.counts.medians >= 20, '획순 데이터가 있는 글자가 줄었다: ' + r.counts.medians);
  assert.ok(r.counts.strokes >= 39);
  /* 라이선스 규칙 — 체험 단어장은 자체 창작이라야 커밋할 수 있다 */
  assert.ok(/자체 창작/.test(r.book.note), '체험 단어장 note 에 자체 창작 표시가 없다');
});

t('낱말의 한자 분해에서 한자 항목이 끌려 나오고, 직접 적은 글자가 이긴다', () => {
  const r = B.checkBook(sample());
  const by = {}; r.book.chars.forEach((c) => { by[c.ch] = c; });
  assert.ok(by['觀'] && by['觀'].derived, '觀 은 낱말에서 끌어낸 글자여야 한다');
  assert.strictEqual(by['觀'].hun, '볼'); assert.strictEqual(by['觀'].eum, '관');
  assert.ok(by['觀'].words.indexOf('관측') >= 0 && by['觀'].words.indexOf('객관') >= 0, '觀 이 든 낱말 목록: ' + by['觀'].words);
  assert.ok(by['山'] && !by['山'].derived && by['山'].strokes === 3, '山 은 직접 적은 글자(획수 3)');
  assert.ok(by['山'].words.indexOf('화산') >= 0, '직접 적은 글자에도 낱말 목록이 붙는다');
  assert.ok(Array.isArray(by['十'].medians) && by['十'].medians.length === 2);
});

t('id·제목·영어·뜻 없음·나쁜 한자는 오류', () => {
  const bad = (raw) => B.checkBook(raw);
  assert.ok(!bad({ id: '어휘', title: 'x', words: [{ word: '가', meaning: '나' }] }).ok, '한글 id 가 통과했다');
  assert.ok(!bad({ id: 'ok-book', title: '', words: [{ word: '가', meaning: '나' }] }).ok, '빈 제목이 통과했다');
  const eng = bad({ id: 'ok-book', title: 'x', words: [{ word: 'observe', meaning: '관찰하다' }] });
  assert.ok(!eng.ok && /워드브레인/.test(eng.errors[0].message), '영어 낱말은 막고 워드브레인으로 안내한다');
  assert.ok(!bad({ id: 'ok-book', title: 'x', words: [{ word: '관측' }] }).ok, '뜻 없는 낱말이 통과했다');
  assert.ok(!bad({ id: 'ok-book', title: 'x', words: [{ word: '관측', meaning: 'x', parts: [{ ch: '관', hun: '볼', eum: '관' }] }] }).ok, '한글이 한자 자리에 들어갔는데 통과했다');
  assert.ok(!bad({ id: 'ok-book', title: 'x' }).ok, '낱말도 한자도 없는데 통과했다');
  assert.ok(!bad({ id: 'ok-book', title: 'x', chars: [{ ch: '觀', hun: '볼' }] }).ok, '음 없는 한자가 통과했다');
  assert.ok(!bad({ id: 'ok-book', title: 'x', chars: [{ ch: '觀', hun: '볼', eum: '관', strokes: 0 }] }).ok, '획수 0이 통과했다');
});

t('획순 데이터 — 모양·좌표 범위·획수 일치를 지킨다', () => {
  const mk = (medians, strokes) => B.checkBook({ id: 'ok-book', title: 'x', chars: [{ ch: '十', hun: '열', eum: '십', strokes, medians }] });
  assert.ok(mk([[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.1], [0.5, 0.9]]], 2).ok);
  assert.ok(!mk([[[0.1, 0.5], [0.9, 0.5]]], 2).ok, '획수 2인데 획순 1획이 통과했다');
  assert.ok(!mk([[[0.1, 0.5]]], 1).ok, '점 하나짜리 획이 통과했다');
  assert.ok(!mk([[[0.1, 0.5], [1.4, 0.5]]], 1).ok, '0~1 밖 좌표가 통과했다');
  assert.ok(!mk('十', 1).ok, '문자열 medians 가 통과했다');
  /* {x,y} 점도 받아 [x,y] 로 통일한다 */
  const r = mk([[{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]], 1);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.book.chars[0].medians, [[[0.1, 0.5], [0.9, 0.5]]]);
  /* 획수를 안 적었으면 획순 데이터의 획 수를 쓴다 */
  const r2 = B.checkBook({ id: 'ok-book', title: 'x', chars: [{ ch: '十', hun: '열', eum: '십', medians: [[[0.1, 0.5], [0.9, 0.5]], [[0.5, 0.1], [0.5, 0.9]]] }] });
  assert.strictEqual(r2.book.chars[0].strokes, 2);
});

t('획수 표(strokes) — 낱말에서 끌어낸 글자에도 획수가 붙고, 직접 적은 획수가 이긴다', () => {
  const r = B.checkBook({ id: 'ok-book', title: 'x', chars: [{ ch: '測', hun: '잴', eum: '측', strokes: 12 }],
    words: [{ word: '관측', meaning: '뜻', hanja: '觀(볼 관)+測(잴 측)' }], strokes: { '觀': 25, '測': 30, '龜': 16 } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const by = {}; r.book.chars.forEach((c) => { by[c.ch] = c; });
  assert.strictEqual(by['觀'].strokes, 25);
  assert.strictEqual(by['測'].strokes, 12, '직접 적은 획수가 표에 밀렸다');
  assert.ok(r.warns.some((w) => /龜/.test(w.message)), '없는 글자의 획수는 경고');
  assert.ok(!B.checkBook({ id: 'ok-book', title: 'x', words: [{ word: '관측', meaning: '뜻', hanja: '觀測' }], strokes: { '관': 5 } }).ok, '한글 키가 통과했다');
  assert.ok(!B.checkBook({ id: 'ok-book', title: 'x', words: [{ word: '관측', meaning: '뜻', hanja: '觀測' }], strokes: { '觀': 0 } }).ok, '획수 0이 통과했다');
});

t('단원 — 적힌 순서를 지키고, 낱말이 가리키는 단원이 목록에 없으면 뒤에 붙이고 경고', () => {
  const r = B.checkBook({ id: 'ok-book', title: 'x', units: [{ id: 'b', title: '둘' }, 'a'],
    words: [{ word: '관측', meaning: '뜻', unit: 'a' }, { word: '반론', meaning: '뜻', unit: 'zz' }, { word: '여태', meaning: '뜻' }] });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.book.units.map((u) => u.id), ['b', 'a', 'zz']);
  assert.strictEqual(r.book.units[0].title, '둘');
  assert.strictEqual(r.book.units[1].title, 'a', '문자열 단원은 id 가 제목');
  assert.ok(r.warns.some((w) => /zz/.test(w.message)), '목록에 없는 단원 경고가 없다');
  assert.strictEqual(r.book.words[2].unit, '', '단원 없는 낱말은 빈 단원');
  assert.strictEqual(r.counts.unitless, 1);
});

t('같은 낱말은 앞의 것만 남기되, 한자가 다른 동음이의어는 둘 다 산다', () => {
  const r = B.checkBook({ id: 'ok-book', title: 'x', words: [
    { word: '사고', meaning: '생각함', hanja: '思(생각 사)+考(생각할 고)' },
    { word: '사고', meaning: '뜻밖의 일', hanja: '事(일 사)+故(연고 고)' },
    { word: '사고', meaning: '또 생각함', hanja: '思考' },
    { word: '여태', meaning: '지금까지' }, { word: '여태', meaning: '아직' },
  ] });
  assert.ok(r.ok);
  assert.strictEqual(r.book.words.length, 3);
  assert.strictEqual(r.warns.filter((w) => /다시 나와/.test(w.message)).length, 2);
  assert.notStrictEqual(r.book.words[0].id, r.book.words[1].id, 'id 가 겹친다');
});

t('훈음 없는 한자 표기(觀測)도 받되 조립 문제에서 빠진다고 경고한다', () => {
  const r = B.checkBook({ id: 'ok-book', title: 'x', words: [{ word: '관측', meaning: '뜻', hanja: '觀測' }] });
  assert.ok(r.ok);
  assert.strictEqual(r.book.words[0].type, 'hanja');
  assert.strictEqual(r.book.words[0].hanja, '觀測');
  assert.ok(!r.book.words[0].literal, '훈이 없는데 조립 뜻이 생겼다');
  assert.ok(r.warns.some((w) => /훈음/.test(w.message)));
  assert.strictEqual(r.book.chars.length, 2);
  assert.ok(r.book.chars.every((c) => c.derived && !c.hun));
  /* 직접 적은 글자의 훈음이 낱말 쪽 빈칸을 채운다 */
  const r2 = B.checkBook({ id: 'ok-book', title: 'x', chars: [{ ch: '觀', hun: '볼', eum: '관' }, { ch: '測', hun: '잴', eum: '측' }],
    words: [{ word: '관측', meaning: '뜻', hanja: '觀測' }] });
  assert.deepStrictEqual(r2.book.words[0].parts, [{ ch: '觀', hun: '볼', eum: '관' }, { ch: '測', hun: '잴', eum: '측' }]);
  assert.strictEqual(r2.book.words[0].literal, '볼 · 잴');
});

t('예문에서 낱말 자리 찾기 — 활용형·르 불규칙·어절 경계', () => {
  const f = (ex, w) => { const r = B.findInExample(ex, w); return r ? ex.slice(r.start, r.end) : null; };
  assert.strictEqual(f('천문대에서 별을 관측했다.', '관측'), '관측했다');
  assert.strictEqual(f('마음을 다잡고 다시 책을 폈다.', '다잡다'), '다잡고');
  assert.strictEqual(f('친구와 길에서 엇갈렸다.', '엇갈리다'), '엇갈렸다');
  assert.strictEqual(f('칭찬이 자신감을 북돋웠다.', '북돋우다'), '북돋웠다');
  assert.strictEqual(f('별러서 산 자전거', '벼르다'), '별러서');
  assert.strictEqual(f('눈으로 거리를 가늠해 보았다.', '가늠하다'), '가늠해');
  assert.strictEqual(f('예상과 어긋난 결과', '어긋나다'), '어긋난');
  assert.strictEqual(f('그는 관측소에 갔다', '측정'), null, '엉뚱한 낱말을 잡았다');
  assert.strictEqual(f('', '관측'), null);
  assert.ok(B.exampleHasWord('일기에는 주관이 담긴다', '주관'));
});

t('붙여넣기 텍스트 — 단원(#)·낱말 줄·한자 줄·구분자', () => {
  const text = [
    '# 1일차',
    '관측 | 보고 재는 것 | 觀(볼 관)+測(잴 측) | 별을 관측했다.',
    '다잡다\t흐트러진 마음을 단단히 하다\t마음을 다잡고 앉았다.',
    '觀 | 볼 관 | 25',
    '',
    '## 2일차',
    '여태, 지금까지',
    '測 | 잴 측',
  ].join('\n');
  const r = B.parseBookText(text, { id: 'paste-1', title: '붙여넣기', level: 'L2' });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.book.units.map((u) => u.title), ['1일차', '2일차']);
  assert.strictEqual(r.book.words.length, 3);
  assert.strictEqual(r.book.words[0].unit, 'u01');
  assert.strictEqual(r.book.words[0].hanja, '觀測');
  assert.strictEqual(r.book.words[0].example, '별을 관측했다.');
  assert.strictEqual(r.book.words[1].type, 'native');
  assert.strictEqual(r.book.words[1].example, '마음을 다잡고 앉았다.');
  assert.strictEqual(r.book.words[2].unit, 'u02');
  const by = {}; r.book.chars.forEach((c) => { by[c.ch] = c; });
  assert.strictEqual(by['觀'].strokes, 25);
  assert.ok(!by['觀'].derived, '직접 적은 글자인데 derived 로 잡혔다');
  assert.strictEqual(by['測'].unit, 'u02');
  assert.strictEqual(r.book.level, 'L2');
});

t('붙여넣기 — 줄 오류는 행 번호와 함께 막는다', () => {
  const r = B.parseBookText('관측\n觀 | 관\n觀 | 볼 관 | 스물다섯', { id: 'paste-2', title: 'x' });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /^1행/.test(e.message)), '뜻 없는 줄');
  assert.ok(r.errors.some((e) => /^2행/.test(e.message)), '훈음 띄어쓰기');
  assert.ok(r.errors.some((e) => /^3행/.test(e.message)), '획수 숫자');
  assert.strictEqual(r.book, null);
});

t('한계 — 낱말 3000·한자 2000 을 넘으면 막는다', () => {
  const many = []; for (let i = 0; i < 3001; i++) many.push({ word: '낱말' + i, meaning: '뜻' });
  assert.ok(!B.checkBook({ id: 'ok-book', title: 'x', words: many }).ok);
});

t('목록용 메타에는 본문이 없고 단원별 셈이 있다', () => {
  const r = B.checkBook(sample());
  const m = B.bookMeta(r.book);
  assert.deepStrictEqual(Object.keys(m).sort(), ['counts', 'id', 'level', 'note', 'publisher', 'title', 'units']);
  assert.strictEqual(m.units.length, 5);
  assert.strictEqual(m.units[0].chars, 19);
  assert.strictEqual(m.units[2].words, 12);
  assert.ok(!('words' in m) && !('chars' in m));
});

console.log(`\nOK — ${passed}개 통과`);
