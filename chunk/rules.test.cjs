'use strict';
/* 청크브레인 규칙 모듈 검증 — node chunk/rules.test.cjs
   점수는 모범 조각과의 일치로만 나오고, 「왜」 태그는 설명·복습 연결에만 쓰인다는 전제를 지킨다. */
const assert = require('assert');
const R = require('./rules.js');
let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

t('어절 나누기 — 뒤 공백을 어절 끝에 붙여 이어붙이면 원문', () => {
  const s = '바닷물의 온도가  평년보다 높다.';
  assert.deepStrictEqual(R.words(s).join(''), s);
  assert.strictEqual(R.wordCount(s), 4);
  assert.deepStrictEqual(R.words(''), []);
});

t('모범 경계 — 조각 끝 어절 인덱스, 마지막 조각 뒤는 제외', () => {
  const segs = ['여름에는 날씨가 ', '아주 더워요. ', '그런데 바다도 ', '더워질 때가 있어요.'];
  assert.deepStrictEqual(R.modelBoundaries(segs), [1, 3, 5]);
  assert.deepStrictEqual(R.segsFromBoundaries(segs.join(''), [1, 3, 5]), segs);
  assert.deepStrictEqual(R.segsFromBoundaries('가 나 다', []), ['가 나 다']);
});

t('채점 — 규격서 9장 공식 (맞힘 − 0.5×군더더기) / 모범 × 100', () => {
  assert.strictEqual(R.score([1, 3, 5], [1, 3, 5]).score, 100);
  assert.strictEqual(R.score([1, 3, 5], [1, 3]).score, 67);
  assert.strictEqual(R.score([1, 3, 5], [1, 3, 5, 2]).score, 83);   /* 군더더기 하나는 절반만 벌점 */
  assert.strictEqual(R.score([1, 3, 5], []).score, 0);
  assert.strictEqual(R.score([1, 3, 5], [0, 2, 4, 6, 7, 8, 9]).score, 0);   /* 음수는 0으로 */
  const r = R.score([1, 3, 5], [1, 2, 5]);
  assert.deepStrictEqual(r.missed, [3]); assert.deepStrictEqual(r.extras, [2]); assert.strictEqual(r.hit, 2);
  assert.strictEqual(R.score([], []).score, 100, '경계가 없는 한 어절 문장은 안 찍으면 만점');
});

t('경계 종류 — 문장 끝 > 쉼표 > 연결어미 > 구·절', () => {
  const ws = R.words('비가 오지만, 우리는 소풍을 갔다. 그리고 놀았다');
  assert.strictEqual(R.classifyBoundary(ws, 1), 'comma');
  assert.strictEqual(R.classifyBoundary(ws, 4), 'sent');
  assert.strictEqual(R.classifyBoundary(ws, 2), 'phrase');
  assert.strictEqual(R.classifyBoundary(R.words('비가 오면 우산을 쓴다'), 1), 'conn');
  assert.strictEqual(R.classifyBoundary(R.words('책을 읽고 잠을 잤다'), 1), 'conn');
  assert.strictEqual(R.classifyBoundary(R.words('「해양열파」라고 한다. 다음'), 1), 'sent', '닫는 따옴표 뒤 마침표도 문장 끝');
});

t('붙여 읽는 자리 — 관형어·부사·수+단위·의존명사·보조용언·가리키는 말', () => {
  const why = (s, i) => { const w = R.whyNotCut(R.words(s), i); return w && w.tag; };
  assert.strictEqual(why('평년 값보다 매우 높은 상태로 이어진다', 3), 'adn');
  assert.strictEqual(why('평년 값보다 매우 높은 상태로 이어진다', 2), 'adv');
  assert.strictEqual(why('사과 다섯 개를 먹었다', 1), 'num');
  assert.strictEqual(why('최근 10 년 동안', 1), 'num');
  assert.strictEqual(why('밥을 먹을 수 있다', 1), 'dep', '「먹을 수」 — 뒤에 의존명사');
  assert.strictEqual(why('밥을 먹을 수 있다', 2), 'dep', '「수 있다」');
  assert.strictEqual(why('편지를 읽어 보았다', 1), 'aux');
  assert.strictEqual(why('그 아이는 웃었다', 0), 'det');
  assert.strictEqual(why('지속되는 현상을 말한다', 0), 'adn');
  assert.strictEqual(why('빨간 모자를 썼다', 0), 'adn');
  assert.strictEqual(why('책은 내 친구다', 0), null, '조사 「은」은 관형형이 아니다');
  assert.strictEqual(why('학교에서는 공부를 한다', 0), null, '「-에서는」 은 조사');
  assert.strictEqual(why('나는 학교에 간다', 0), null, '「나는」 은 대명사+조사');
  assert.strictEqual(why('비가 오지만, 우리는 갔다', 1), null, '쉼표 뒤는 언제나 끊어도 된다');
  assert.strictEqual(why('밥을 먹었다. 그리고 잤다', 1), null, '문장 끝 뒤도 마찬가지');
  assert.strictEqual(R.whyNotCut(R.words('끝 어절'), 1).tag, 'end');
  assert.strictEqual(why('나는 바다에 가고 싶다', 2), 'aux', '「-고 싶다」');
  assert.strictEqual(why('밥을 먹고 있다', 1), 'aux', '「-고 있다」');
  assert.strictEqual(why('밥을 먹고 이를 닦는다', 1), null, '「-고」 뒤가 보조용언이 아니면 절 경계');
  assert.strictEqual(why('숙제를 하지 않았다', 1), 'aux', '「-지 않다」');
  assert.strictEqual(why('친구를 만나게 되었다', 1), 'aux', '「-게 되다」');
  assert.strictEqual(why('일찍 자야 한다', 1), 'aux', '「-어야 하다」');
  assert.strictEqual(why('사과 한 상자를 샀다', 1), 'num', '단위 「상자」');
});

t('쉼표 뒤에 찍은 군더더기는 벌점이 없다(neutral) — 모범이 이어 읽었더라도', () => {
  const segs = ['6월 12일 목요일, 맑음. ', '오늘은 ', '발표를 했다.'];
  const text = segs.join('');
  const model = R.modelBoundaries(segs);          /* [3, 4] */
  const r = R.score(model, [2, 3, 4], text);
  assert.strictEqual(r.score, 100); assert.deepStrictEqual(r.neutral, [2]); assert.strictEqual(r.extra, 0);
  assert.strictEqual(R.score(model, [2, 3, 4]).score, 75, 'text 없이 부르면 규격서 공식 그대로');
  const e = R.explain(text, model, [2, 3, 4]);
  assert.deepStrictEqual(e.tags, [], '중립 표시는 약한 규칙 태그에 들어가지 않는다');
  assert.strictEqual(e.notes[0].kind, 'neutral');
});

t('설명 — 놓친 경계와 군더더기 경계에 이유·태그가 붙는다', () => {
  const segs = ['비가 오면 ', '우산을 쓰고, ', '눈이 오면 ', '장갑을 낀다.'];
  const text = segs.join('');
  const model = R.modelBoundaries(segs);            /* [1, 3, 5] */
  const r = R.explain(text, model, [1, 2, 3, 5]);
  assert.strictEqual(r.score, 83);
  assert.deepStrictEqual(r.tags, ['extra:fine']);
  assert.strictEqual(r.notes[0].i, 2);
  const m = R.explain(text, model, [3]);
  assert.deepStrictEqual(m.tags, ['miss:conn', 'miss:conn']);
  assert.ok(m.notes[0].why.indexOf('이어 주는 말') >= 0);
  const p = R.explain('평년 값보다 매우 높은 상태로 이어진다.', [], [3]);
  assert.deepStrictEqual(p.tags, ['extra:adn']);
  assert.ok(p.notes[0].why.indexOf('꾸며') >= 0);
  assert.ok(R.TAG_LABEL['extra:adn'] && R.TAG_LABEL['miss:sent'], '태그마다 사람이 읽는 이름이 있다');
});

t('문장 묶기 — 유치·초1~2 는 문장 하나씩 연습한다', () => {
  const segs = ['아기 곰이 ', '잠을 자요. ', '엄마 곰이 ', '이불을 ', '덮어 줘요.', ' 끝'];
  const ss = R.sentencesOf(segs);
  assert.strictEqual(ss.length, 3);
  assert.deepStrictEqual(ss[0], ['아기 곰이 ', '잠을 자요. ']);
  assert.deepStrictEqual(ss[2], [' 끝']);
});

t('표시 문자열 ↔ 조각 — 교사가 붙여 넣은 글을 조각으로', () => {
  const segs = ['나는 ', '학교에 갔다. ', '그리고 ', '집에 왔다.'];
  assert.strictEqual(R.toMarked(segs), '나는 ∕ 학교에 갔다. ∕ 그리고 ∕ 집에 왔다.');
  const back = R.fromMarked('나는 / 학교에 갔다. ∕ 그리고 /집에 왔다.\n\n둘째 문단이다.');
  assert.deepStrictEqual(back, [segs, ['둘째 문단이다.']]);
  assert.strictEqual(back[0].join(''), segs.join(''));
});

t('밴드 검사 — 상한 초과·공백 누락·붙여 읽을 자리를 이름 붙여 잡는다', () => {
  assert.deepStrictEqual(R.check(['아기 곰이 ', '잠을 자요.'], 'K'), []);
  const long = R.check(['하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나'], 'H');
  assert.ok(long.some((x) => /11어절/.test(x)));
  assert.ok(R.check(['나는', '학교에 갔다.'], 'E1').some((x) => /공백/.test(x)));
  assert.ok(R.check(['매우 높은 ', '상태로 이어진다.'], 'M').some((x) => /adn/.test(x)));
  assert.ok(R.check(['사과 다섯 ', '개를 먹었다.'], 'E2').some((x) => /num/.test(x)));
});

t('학년 → 밴드, 위·아래 밴드', () => {
  assert.strictEqual(R.bandOfGrade(0), 'K'); assert.strictEqual(R.bandOfGrade('유치'), 'K');
  assert.strictEqual(R.bandOfGrade(2), 'E1'); assert.strictEqual(R.bandOfGrade(4), 'E2');
  assert.strictEqual(R.bandOfGrade(6), 'E3'); assert.strictEqual(R.bandOfGrade(8), 'M'); assert.strictEqual(R.bandOfGrade(12), 'H');
  assert.strictEqual(R.nextBand('H'), null); assert.strictEqual(R.prevBand('K'), null); assert.strictEqual(R.nextBand('E2'), 'E3');
  R.BAND_ORDER.forEach((b) => { assert.ok(R.BANDS[b].max <= 8, b + ' 상한은 8어절 이하 (규격서 2장)'); });
});

t('조각 통계', () => {
  const s = R.stats(['아기 곰이 ', '잠을 자요. ', '엄마 곰이 이불을 덮어 줘요.']);
  assert.strictEqual(s.n, 3); assert.strictEqual(s.words, 9); assert.strictEqual(s.max, 5); assert.strictEqual(s.over8, 0);
});

console.log('\n' + passed + '건 통과 — chunk/rules.js');
