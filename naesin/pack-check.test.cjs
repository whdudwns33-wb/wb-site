'use strict';
/* naesin/pack-check.js 검증 — 팩 검사 규칙이 세 곳(CLI·업로드·스튜디오)에서 같아야 한다.
   실행: node naesin/pack-check.test.cjs */
const assert = require('node:assert');
const CHECK = require('./pack-check.js');
const SAMPLE = require('./pack-sample.json');

let n = 0;
function t(name, fn) { fn(); n += 1; console.log('  ✓ ' + name); }
const clone = (o) => JSON.parse(JSON.stringify(o));
/* 오류·경고 메시지에 이 조각이 들어 있는지 — 문구 전체를 박으면 사소한 수정에 테스트가 깨진다 */
const has = (list, frag) => list.some((x) => (x.where + ': ' + x.message).indexOf(frag) >= 0);

console.log('pack-check — 팩 검사 규칙');

/* ── 기준선 ── */
t('자체 창작 샘플 팩은 오류 0', () => {
  const r = CHECK.checkPack(clone(SAMPLE));
  assert.deepStrictEqual(r.errors, [], '오류: ' + JSON.stringify(r.errors));
  assert.ok(r.summary.length >= 5, '요약 줄이 섹션마다 나와야 한다');
});

t('빈 팩은 "검사할 내용 없음" + 필수 배열 둘', () => {
  const r = CHECK.checkPack({});
  assert.ok(has(r.errors, '검사할 팩 내용이 하나도 없음'));
  assert.ok(has(r.errors, 'words 가 비었음'));
  assert.ok(has(r.errors, 'sentences 가 비었음'));
  assert.strictEqual(r.errors.length, 3);
});

/* ── 필수 배열 (2026-09-03 결함) ──
   스튜디오 assemble 은 행이 0인 종류를 팩에서 아예 뺀다. 한 종류만 넣고 만든 팩은
   words 또는 sentences 키가 없는 채로 나오는데, 학생 앱은 그 둘을 가드 없이 읽어
   (index.html 의 홈 진단 카드·본문 매트릭스) 첫 화면이 TypeError 로 죽는다.
   오류 메시지도 없이 '교재를 불러오는 중…' 에 멈춘다.
   전에는 이런 팩이 오류 0·경고 0 으로 배포 관문을 통과했다. */
t('문장만 있는 팩은 배포를 막는다 — words 없이는 학생 앱이 안 뜬다', () => {
  const p = { packId: SAMPLE.packId, sentences: clone(SAMPLE.sentences) };
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'words 가 비었음'), '막지 못했다: ' + JSON.stringify(r.errors));
  assert.ok(has(r.errors, 'WORD TEST'), '어느 자료가 필요한지 알려 줘야 한다');
  assert.ok(!has(r.errors, 'sentences 가 비었음'), '있는 것을 없다고 하면 안 된다');
});

t('단어만 있는 팩도 막는다 — sentences 없이는 본문·홈·성취도가 죽는다', () => {
  const p = { packId: SAMPLE.packId, words: clone(SAMPLE.words) };
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'sentences 가 비었음'), '막지 못했다: ' + JSON.stringify(r.errors));
  assert.ok(has(r.errors, '본문 워크북'));
});

t('배열이 있어도 비면 막는다 — 검수에서 전 행을 버린 경우', () => {
  const p = clone(SAMPLE);
  p.words = [];
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'words 가 비었음'));
});

t('둘 다 있으면 통과 — 나머지 종류는 없어도 된다', () => {
  const p = { packId: SAMPLE.packId, words: clone(SAMPLE.words), sentences: clone(SAMPLE.sentences) };
  const r = CHECK.checkPack(p);
  assert.deepStrictEqual(r.errors, [], '대화문·패턴·문항이 없다고 막으면 안 된다: ' + JSON.stringify(r.errors));
});

t('팩이 객체가 아니면 오류', () => {
  ['x', null, 3, []].forEach((v) => {
    const r = CHECK.checkPack(v);
    assert.ok(r.errors.length >= 1, String(v) + ' 는 오류여야 한다');
  });
});

t('where 라벨이 오류 위치에 쓰인다', () => {
  const p = clone(SAMPLE);
  p.words[0].headword = '';
  const r = CHECK.checkPack(p, { where: { words: 'words.json' } });
  assert.ok(has(r.errors, 'words.json:'), '라벨이 안 붙었다: ' + JSON.stringify(r.errors[0]));
});

/* ── 단어 ── */
t('단어 — id 중복·meaningKo 빈 값·잘못된 section', () => {
  const p = clone(SAMPLE);
  p.words[1].id = p.words[0].id;
  p.words[2].meaningKo = [];
  p.words[3].sections = ['listening'];
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'id 중복'));
  assert.ok(has(r.errors, 'meaningKo 비었음'));
  assert.ok(has(r.errors, '잘못된 section: listening'));
});

t('단어 — counts 불일치는 오류', () => {
  const p = clone(SAMPLE);
  p.counts = Object.assign({}, p.counts, { words: 99 });
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '단어 수 불일치'));
});

/* ── 본문 문장 ── */
t('문장 — seq 순번·en/ko 누락', () => {
  const p = clone(SAMPLE);
  p.sentences[2].seq = 99;
  p.sentences[3].en = '';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'seq가 순번'));
  assert.ok(has(r.errors, 'en 없음'));
});

t('문장 — dayGroup 은 값을 못 박지 않는다(출판사마다 다르다)', () => {
  const p = clone(SAMPLE);
  /* 단락 이름만 바꾼 팩 — 어색한 곳 문항은 옛 이름을 참조하므로 이 규칙만 보게 떼어 둔다 */
  delete p.oddOneItems;
  delete p.counts;
  p.sentences.forEach((s) => { s.dayGroup = 'Part 1'; });
  const r = CHECK.checkPack(p);
  assert.ok(!has(r.errors, 'dayGroup'), '형식이 달라도 오류가 아니어야 한다: ' + JSON.stringify(r.errors));
  p.sentences[0].dayGroup = '';
  const r2 = CHECK.checkPack(p);
  assert.ok(has(r2.errors, 'dayGroup 없음'), '없으면 오류여야 한다');
});

t('어색한 곳 — 단락 이름이 바뀌면 참조가 끊긴 것을 잡는다', () => {
  const p = clone(SAMPLE);
  p.sentences.forEach((s) => { s.dayGroup = 'Part 1'; });
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '없는 dayGroup'), '문항이 옛 단락을 가리키면 오류여야 한다');
});

t('문장 — 청크 연결이 en과 다르면 오류(해석 판정의 기준)', () => {
  const p = clone(SAMPLE);
  p.sentences[0].chunks[0].en = 'Next summer,';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'chunks 연결이 en과 불일치'));
});

t('문장 — 청크 표기 차이(굽은 따옴표·공백)는 오류가 아니다', () => {
  const p = clone(SAMPLE);
  const s = p.sentences[0];
  s.chunks = [{ en: s.en.replace(/'/g, '’'), ko: '전체' }];
  const r = CHECK.checkPack(p);
  assert.ok(!has(r.errors, 'chunks 연결'), '정규화 비교여야 한다: ' + JSON.stringify(r.errors));
});

t('문장 — tokens 재조립 불일치는 경고(인쇄 표기를 그대로 싣는 관례)', () => {
  const p = clone(SAMPLE);
  p.sentences[0].tokens = ['Last', 'winter,', 'nothing'];
  const r = CHECK.checkPack(p);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(has(r.warns, 'tokens 재조립이 en과 다름'));
});

t('문장 — 핵심어 뜻이 ko에 없으면 경고(한글 빈칸이 안 만들어진다)', () => {
  const p = clone(SAMPLE);
  p.sentences[0].keywords[0].ko = '없는뜻';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.warns, '한글 빈칸이 안 만들어짐'));
});

t('문장 — grammarChoices answerIdx 범위 밖은 오류', () => {
  const p = clone(SAMPLE);
  const g = p.sentences.find((s) => Array.isArray(s.grammarChoices) && s.grammarChoices.length);
  assert.ok(g, '샘플에 grammarChoices 가 있어야 한다');
  g.grammarChoices[0].answerIdx = 9;
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'answerIdx 범위 밖'));
});

t('문장 — 단락이 너무 많으면 경고', () => {
  const p = clone(SAMPLE);
  const base = p.sentences[0];
  p.sentences = [];
  for (let i = 0; i < 14; i += 1) {
    const s = clone(base); s.seq = i + 1; s.dayGroup = 'g' + i;
    p.sentences.push(s);
  }
  const r = CHECK.checkPack(p);
  assert.ok(has(r.warns, '단락 구분이 어긋났을 수 있음'));
});

/* ── 어색한 곳 찾기 ── */
t('어색한 곳 — correction 으로 되돌리면 정본이 되어야 한다', () => {
  const p = clone(SAMPLE);
  const ok = CHECK.checkPack(p);
  assert.ok(!has(ok.errors, 'oddOneItems'), '샘플은 통과해야 한다: ' + JSON.stringify(ok.errors));
  p.oddOneItems[0].correction = 'a quick train';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'correction 으로 되돌려도 정본 문장'));
});

t('어색한 곳 — 정답 조각이 어느 문장에도 없으면 오류', () => {
  const p = clone(SAMPLE);
  p.oddOneItems[0].options[p.oddOneItems[0].answerIdx] = '없는 조각';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '정답 조각'));
});

t('어색한 곳 — 없는 dayGroup·seq·kind 는 오류', () => {
  const p = clone(SAMPLE);
  p.oddOneItems[0].dayGroup = '9/9';
  p.oddOneItems[1].kind = 'weird';
  p.oddOneItems[1].sentences[0].seq = 99;
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '없는 dayGroup'));
  assert.ok(has(r.errors, 'kind 이상'));
  assert.ok(has(r.errors, '없는 문장 seq'));
});

t('어색한 곳 — id 중복·counts 불일치', () => {
  const p = clone(SAMPLE);
  p.oddOneItems[1].id = p.oddOneItems[0].id;
  p.counts = Object.assign({}, p.counts, { oddOneItems: 5 });
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'id 중복'));
  assert.ok(has(r.errors, 'counts.oddOneItems'));
});

/* ── 종합 Check ── */
t('종합 Check — 슬롯별 실제 스키마를 검사한다', () => {
  const p = clone(SAMPLE);
  const r = CHECK.checkPack(p);
  assert.ok(!has(r.errors, 'checkItems'), '샘플은 통과해야 한다: ' + JSON.stringify(r.errors));
  assert.ok(r.summary.some((s) => s.indexOf('checkItems') === 0 && s.indexOf('choice') > 0),
    '요약에 슬롯 분포가 나와야 한다: ' + r.summary.join(' | '));
});

t('종합 Check — 빈칸 수와 blanks 수가 어긋나면 오류', () => {
  const p = clone(SAMPLE);
  const b = p.checkItems.find((i) => i.slot === 'blank');
  b.blanks.push({ answers: ['extra'] });
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '개 ≠ blanks'));
});

t('종합 Check — 배열 문항 토막으로 정답을 못 만들면 오류', () => {
  const p = clone(SAMPLE);
  const a = p.checkItems.find((i) => i.slot === 'arrange');
  a.tokens = a.tokens.slice(0, 2);
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '풀 수 없는 문항'));
});

t('종합 Check — 배열 정답은 answers 없으면 정본 문장으로 본다', () => {
  const p = clone(SAMPLE);
  const a = p.checkItems.find((i) => i.slot === 'arrange');
  assert.ok(!Array.isArray(a.answers) || !a.answers.length, '샘플 배열 문항엔 answers 가 없다');
  const r = CHECK.checkPack(p);
  assert.ok(!has(r.errors, '정답을 알 수 없음'));
  delete a.seq;
  const r2 = CHECK.checkPack(p);
  assert.ok(has(r2.errors, '정답을 알 수 없음'), 'seq 도 없으면 오류여야 한다');
});

t('종합 Check — 보기 중복·answerIdx 범위·모르는 슬롯', () => {
  const p = clone(SAMPLE);
  const ch = p.checkItems.find((i) => i.slot === 'choice');
  ch.choices = [ch.choices[0], ch.choices[0]];
  ch.answerIdx = 7;
  p.checkItems[1].slot = 'zzz';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '보기 중복'));
  assert.ok(has(r.errors, 'answerIdx 범위 밖'));
  assert.ok(has(r.errors, 'slot 이상'));
});

/* ── 대화문·패턴·저장 문항 ── */
t('대화문 — speaker/en/ko 누락은 오류', () => {
  const p = clone(SAMPLE);
  p.dialogues[0].lines[0].ko = '';
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'speaker/en/ko 불완전'));
});

t('패턴 — title·conceptKo 누락은 오류, 예문 없음은 경고', () => {
  const p = clone(SAMPLE);
  p.patterns[0].conceptKo = '';
  p.patterns[0].textbookExamples = [];
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, 'conceptKo 없음'));
  assert.ok(has(r.warns, '교과서 예문 없음'));
});

t('저장 문항 — 정답이 보기 label에 없으면 오류', () => {
  const p = clone(SAMPLE);
  const it = p.items.find((x) => Array.isArray(x.choices) && x.choices.length);
  assert.ok(it, '샘플에 보기 있는 문항이 있어야 한다');
  it.answer = ['없는label'];
  const r = CHECK.checkPack(p);
  assert.ok(has(r.errors, '보기 label에 없음'));
});

t('저장 문항 — 보기 없는 낱말 정답은 단어 마스터와 대조(경고)', () => {
  const p = clone(SAMPLE);
  p.items = [{ no: 1, formatType: 'short', answer: ['zzzznotaword'] }];
  const r = CHECK.checkPack(p);
  assert.ok(has(r.warns, '단어 마스터에 없음'));
});

t('itemsLabel 로 문항 섹션 이름을 바꿀 수 있다', () => {
  const p = clone(SAMPLE);
  const r = CHECK.checkPack(p, { itemsLabel: 'items-grammar.json' });
  assert.ok(r.summary.some((s) => s.indexOf('items-grammar.json') === 0), r.summary.join(' | '));
});

/* ── 섹션 단독 검사 (스튜디오 검수 화면이 한 종류만 다시 볼 때) ── */
t('섹션 함수를 따로 부를 수 있다', () => {
  const c = CHECK.collector({});
  CHECK.checkWords({ words: [{ id: 'w1', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] }, c);
  assert.deepStrictEqual(c.errors, []);
  assert.ok(c.summary[0].indexOf('words: 1개') === 0, c.summary[0]);
});

/* 없는 섹션의 내용 검사는 건너뛴다 — 부분 팩이라도 "그 섹션 규칙 위반" 오류가 붙으면 안 된다.
   (필수 배열 관문은 별개로 걸리므로, 그 한 줄만 남는 것이 정상) */
t('없는 섹션의 내용은 검사하지 않는다', () => {
  const r = CHECK.checkPack({ words: [{ id: 'w1', headword: 'sea', meaningKo: ['바다'], sections: ['reading'] }] });
  assert.strictEqual(r.errors.length, 1, JSON.stringify(r.errors));
  assert.ok(has(r.errors, 'sentences 가 비었음'), JSON.stringify(r.errors));
  assert.strictEqual(r.summary.length, 1);
});

console.log('\n통과 ' + n + '개 — 팩 검사 규칙 검증 완료');
