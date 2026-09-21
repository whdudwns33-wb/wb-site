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
  assert.strictEqual(why('호주는 한겨울이다', 0), null, '「호주는」 은 명사+조사 — 「-오는·-주는」 앞 글자를 본다');
  assert.strictEqual(why('그 라디오는 처음엔 불편했다', 1), null, '「라디오는」 도 명사+조사');
  assert.strictEqual(why('멀리서 돌아오는 기차를 보았다', 1), 'adn', '「돌아오는」 은 관형형');
  assert.strictEqual(why('민호는 줄을 잡았다', 0), null, '「줄을」 은 보통 명사(끈)');
  assert.strictEqual(why('나는 자전거를 탈 줄 안다', 2), 'dep', '「탈 줄」 — ㄹ 관형형 뒤의 의존명사');
  assert.strictEqual(why('배식대 앞에서 양을 조절한다', 1), null, '「양을」 은 보통 명사(분량)');
  assert.strictEqual(why('먹는 양을 조절한다', 0), 'dep', '「먹는 양」 은 의존명사');
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
  const long = R.check(['하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나'], 'G12');
  assert.ok(long.some((x) => /11어절/.test(x)));
  assert.ok(R.check(['나는', '학교에 갔다.'], 'G1').some((x) => /공백/.test(x)));
  assert.ok(R.check(['매우 높은 ', '상태로 이어진다.'], 'G8').some((x) => /adn/.test(x)));
  assert.ok(R.check(['사과 다섯 ', '개를 먹었다.'], 'G3').some((x) => /num/.test(x)));
});

t('학년 → 밴드, 위·아래 밴드', () => {
  assert.strictEqual(R.bandOfGrade(0), 'K'); assert.strictEqual(R.bandOfGrade('유치'), 'K');
  assert.strictEqual(R.bandOfGrade(1), 'G1'); assert.strictEqual(R.bandOfGrade(4), 'G4');
  assert.strictEqual(R.bandOfGrade(6), 'G6'); assert.strictEqual(R.bandOfGrade(8), 'G8'); assert.strictEqual(R.bandOfGrade(12), 'G12');
  assert.strictEqual(R.bandOfGrade(15), 'G12', '학년이 넘치면 고3');
  assert.strictEqual(R.nextBand('G12'), null); assert.strictEqual(R.prevBand('K'), null); assert.strictEqual(R.nextBand('G3'), 'G4'); assert.strictEqual(R.prevBand('G1'), 'K');
  assert.strictEqual(R.BAND_ORDER.length, 13, '유치 + 초1~고3');
  R.BAND_ORDER.forEach((b, i) => {
    assert.ok(R.BANDS[b].max <= 8, b + ' 상한은 8어절 이하 (규격서 2장)');
    if (i) assert.ok(R.BANDS[b].target >= R.BANDS[R.BAND_ORDER[i - 1]].target, b + ' 눈금은 아래 학년보다 작지 않다');
  });
  assert.ok(R.BANDS.K.sentenceMode && R.BANDS.G2.sentenceMode && !R.BANDS.G3.sentenceMode, '유치·초1·초2 는 문장 하나씩');
});

t('조각 통계', () => {
  const s = R.stats(['아기 곰이 ', '잠을 자요. ', '엄마 곰이 이불을 덮어 줘요.']);
  assert.strictEqual(s.n, 3); assert.strictEqual(s.words, 9); assert.strictEqual(s.max, 5); assert.strictEqual(s.over8, 0);
});

t('초안 끊기 — 문장 끝·쉼표·연결어미는 늘 끊고, 사이는 눈금대로, 붙여 읽는 자리는 피한다', () => {
  const text = '우리 반은 지난봄에 학교 텃밭에 상추 씨앗을 심었다. 씨앗은 깨알처럼 작았지만, 일주일이 지나자 연둣빛 싹이 고개를 내밀었다.';
  const segs = R.autoChunk(text, 'G3');
  assert.strictEqual(segs.join(''), text, '이어붙이면 원문');
  assert.ok(segs.some((x) => /심었다\.\s*$/.test(x)) && segs.some((x) => /작았지만,\s*$/.test(x)) && segs.some((x) => /지나자\s*$/.test(x)), '강한 경계에서 끊는다: ' + segs.map((x) => x.trim()).join(' / '));
  const ws = R.words(text);
  R.modelBoundaries(segs).forEach((i) => assert.strictEqual(R.whyNotCut(ws, i), null, '붙여 읽는 자리에서 끊었다: ' + ws[i]));
  segs.forEach((x) => assert.ok(R.words(x).length <= R.BANDS.G3.max, '상한 초과: ' + x));
  /* 상한 보호 — 허용 자리가 드문 긴 관형 연쇄도 max 를 넘기지 않는다 */
  const long = '작은 새 한 마리가 아주 높은 나무 위의 오래된 둥지에서 조용히 노래를 부른다.';
  R.autoChunk(long, 'G1').forEach((x) => assert.ok(R.words(x).length <= R.BANDS.G1.max, 'G1 상한 초과: ' + x));
  assert.deepStrictEqual(R.draftParagraphs('첫 문단이다. 짧다.\n\n둘째 문단은 여기.', 'G3').length, 2);
  assert.deepStrictEqual(R.autoChunk('', 'G3'), []);
});

t('문장 끝 미리 표시 — sentenceEnds 는 마지막 어절 뒤를 빼고, explain 은 그 자리를 채점에서 뺀다', () => {
  const text = '비가 온다. 우산을 편다. 집에 간다.';
  assert.deepStrictEqual(R.sentenceEnds(text), [1, 3]);
  const model = [0, 1, 3, 4];               /* 비가∕온다.∕우산을∕편다.∕집에∕간다. 중 «비가∕» «우산을∕» «집에∕» 는 가짜 모범 */
  const r = R.explain(text, model, [1, 3], [1, 3]);    /* 학생은 주어진 자리만 찍음 */
  assert.strictEqual(r.model, 2, '주어진 자리를 뺀 모범 경계 수');
  assert.strictEqual(r.hit, 0); assert.strictEqual(r.given, 2); assert.strictEqual(r.score, 0);
  const r2 = R.explain(text, model, [0, 1, 3, 4], [1, 3]);
  assert.strictEqual(r2.score, 100);
  assert.strictEqual(R.explain(text, model, [0, 4]).given, 0, 'given 없으면 예전 그대로');
});

t('피드백 묶기 — 규칙별 한 묶음, 많은 순, 쉼표 뒤는 맨 뒤', () => {
  const notes = [
    { i: 1, kind: 'miss', tag: 'miss:phrase', why: 'A', at: '가' }, { i: 3, kind: 'neutral', tag: 'ok:comma', why: 'C', at: '다,' },
    { i: 5, kind: 'extra', tag: 'extra:adn', why: 'B', at: '작은' }, { i: 7, kind: 'miss', tag: 'miss:phrase', why: 'A', at: '라' },
    { i: 9, kind: 'extra', tag: 'extra:adn', why: 'B2', at: '큰' }, { i: 11, kind: 'extra', tag: 'extra:adn', why: 'B3', at: '먼' },
  ];
  const g = R.groupNotes(notes);
  assert.deepStrictEqual(g.map((x) => x.tag + ':' + x.n), ['extra:adn:3', 'miss:phrase:2', 'ok:comma:1']);
  assert.deepStrictEqual(g[0].at, ['작은', '큰', '먼']); assert.strictEqual(g[0].why, 'B'); assert.strictEqual(g[0].label, R.TAG_LABEL['extra:adn']);
  assert.deepStrictEqual(R.groupNotes([]), []);
});

t('check — 모르는 단계여도 죽지 않는다(옛 6단계 id)', () => {
  assert.doesNotThrow(() => R.check(['작은 새가 ', '노래를 부른다.'], 'E2'));
});

console.log('\n' + passed + '건 통과 — chunk/rules.js');
