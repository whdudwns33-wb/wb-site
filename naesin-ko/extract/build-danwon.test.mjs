/* 단원집중 추출기 (node naesin-ko/extract/build-danwon.test.mjs)
 *
 * 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1). 그래서 **지면의 성질만
 * 베낀** 가상 작품 2편을 여기서 직접 지어 spans 구조로 만든다. 지키는 성질:
 *   ① 2단 조판이고 읽기 순서는 기둥 우선 — 지문이 왼단에서 오른단으로 이어진다
 *   ② 흰 글씨는 정답이 아니라 zb 문항번호다. 그중 일부는 흰색이 아니라 **검정**이다
 *   ③ 줄 이어붙이기에 공백을 넣으면 안 되고, 이어붙이기 전에 trim 해도 안 된다
 *   ④ 밑줄 서식 경계에서 공백이 먹힌다 — '적절하지 않은것은?'
 *   ⑤ 정답 선지의 개별 해설은 없다 — 앞 산문이 그 역할을 한다
 *   ⑥ 객관식 문제집인데 서술형이 섞여 있고, 그 rubric 은 자료에 없다
 *   ⑦ 판면 부속물(식별번호·제작일)이 해설쪽 기둥 '한가운데'에 떠 있다
 *   ⑧ 같은 작품이 여러 세트에 다시 실린다
 * 전부 실제 지면에서 초안을 망가뜨렸던 것들이다 — 회귀로 못 박는다. */
import assert from 'node:assert';
import * as U from './spans-util.mjs';
import { buildDanwon } from './build-danwon.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const BLACK = '#000000', WHITE = '#ffffff', NUM = '#191919';
const sp = (x, text, o = {}) => ({ x, w: o.w == null ? text.length * 9 : o.w,
  size: o.size == null ? 9.1 : o.size, color: o.color || BLACK, text });
const ln = (y, spans) => ({ y, spans });
const pg = (no, lines) => ({ no, width: 595.2, height: 841.9, lines });
const head = (y) => ln(y, [sp(415.2, '[단원집중] 1-1.유리와 겨울(1회)', { size: 7.9 })]);
/* zb 는 'zb' 와 'N)' 이 별개 span 이고 둘 다 1pt 이하다 — 색은 흰색일 때도 검정일 때도 있다 */
const zb = (x, no, color) => [sp(x, 'zb', { size: 1.0, w: 2, color }), sp(x + 2, no + ')', { size: 0.7, w: 1.4, color })];

const doc = { file: 'fixture.pdf', pages: [
  /* ── 1쪽: 세트1((가)(나) 두 작품) + 1번 문항 ──
     (나)의 뒷부분이 오른단 맨 위로 넘어간다. y로 훑으면 1번 문항 뒤로 밀려 순서가 깨진다. */
  pg(1, [
    ln(48.4, [sp(304.1, '1.가상 대단원', { size: 9.1 })]),                 // 머리말 띠 — 버려진다
    ln(69.4, [sp(66.5, '중', { size: 10.1, color: WHITE }), sp(78.0, '2', { size: 11.0, color: WHITE }),
      sp(112.8, '국어', { size: 11.0, color: WHITE }), sp(290.2, '1-1.유리와 겨울(1회)', { size: 10.1 })]),
    ln(115.8, [sp(56.6, '※ 다음 글을 읽고, 물음에 답하시오. ', { size: 7.9 })]),
    ln(130.2, [sp(69.6, '(가)', { w: 13.7 })]),
    ln(149.4, [sp(155.5, '유리 새', { w: 28.0 })]),
    ln(168.3, [sp(253.4, '한도연', { w: 25.2 })]),
    ln(187.3, [sp(69.6, '창틀에 앉은 새는')]),
    ln(206.2, [sp(69.6, '㉠유리 너머 하늘을 본다')]),
    ln(529.3, [sp(69.6, '(나)', { w: 13.7 })]),
    ln(548.0, [sp(152.4, '겨울 문장', { w: 40.0 })]),
    ln(564.3, [sp(253.4, '서봄', { w: 17.0 })]),
    ln(586.2, [sp(69.6, '눈이 내려 마당을 덮고')]),
    ln(790.2, [sp(286.3, '- 1 -')]),                                       // 쪽번호 — 버려진다
    /* 오른단 */
    ln(103.5, [sp(324.7, '문장은 천천히 얼어붙는다')]),
    ln(396.2, [sp(311.8, '1.', { size: 13.7, color: NUM })]),
    ln(401.4, [sp(337.4, '(가)의 표현에 대한 이해로 적절하지 않은')]),
    ln(410.1, zb(328.3, 1, WHITE)),
    ln(415.3, [sp(328.3, '것은?')]),
    ln(434.2, [sp(321.8, '①창틀은 새가 머무는 자리를 뜻한다.')]),
    ln(450.0, [sp(321.8, '②유리는 새와 하늘 사이를 가르는 ')]),           // 어절 경계 — 끝공백이 있다
    ln(463.0, [sp(334.8, '경계로 읽힌다.')]),
    ln(477.7, [sp(321.8, '③하늘은 새가 닿고 싶은 자리다.')]),
    ln(491.1, [sp(321.8, '④날개를 접은 것은 포기를 뜻한')]),              // 어절 중간 — 끝공백이 없다
    ln(504.8, [sp(334.8, '다.')]),
    ln(521.1, [sp(321.8, '⑤창틀은 새가 부순 흔적이다.')]),
  ]),
  /* ── 2쪽: 2번(<보기> 제시형) + 세트2(같은 작품 재수록) + 3번(서술형) ── */
  pg(2, [
    head(42.3),
    ln(64.3, [sp(56.6, '2.', { size: 13.7, color: NUM })]),
    ln(69.4, [sp(82.3, '<보기>를 바탕으로 (나)를 감상한 내용으로 가장')]),
    ln(78.2, zb(73.2, 2, WHITE)),
    ln(84.3, [sp(73.2, '적절한 것은?')]),
    ln(102.3, [sp(157.2, '<보기>')]),
    ln(116.0, [sp(69.6, '겨울은 말을 멈추게 하는 계절이다. ')]),
    ln(132.1, [sp(61.7, '시인은 그 침묵을 문장에 빗대었다.')]),
    ln(204.6, [sp(66.7, '①마당은 눈이 쌓이는 자리다.')]),
    ln(218.2, [sp(66.7, '②침묵을 문장에 빗대어 겨울의 무게를 드러낸다.')]),
    ln(231.7, [sp(66.7, '③눈은 소리를 키우는 사물이다.')]),
    ln(248.0, [sp(66.7, '④겨울은 계절의 이름일 뿐이다.')]),
    ln(261.4, [sp(66.7, '⑤문장은 끝내 얼지 않는다.')]),
    ln(790.2, [sp(286.3, '- 2 -')]),
    /* 오른단 — 세트2는 라벨이 없고(작품 1편) ※ 에 쉼표도 없다 */
    ln(64.3, [sp(311.8, '※ 다음 글을 읽고 물음에 답하시오. ', { size: 7.9 })]),
    ln(78.2, [sp(410.4, '유리 새', { w: 28.0 })]),
    ln(99.4, [sp(508.6, '한도연', { w: 25.2 })]),
    ln(137.6, [sp(324.7, '창틀에 앉은 새는')]),
    ln(156.6, [sp(324.7, '㉠유리 너머 하늘을 본다')]),
    ln(468.2, [sp(311.8, '3.', { size: 13.7, color: NUM })]),
    ln(473.4, [sp(337.9, '㉠이 뜻하는 바를 한 문장으로 서술하시오.')]),
    ln(482.1, zb(328.3, 3, BLACK)),                                        // 검정 zb — 색으로 잡으면 놓친다
  ]),
  /* ── 3쪽: 정답·해설 ── */
  pg(3, [
    head(42.3),
    ln(115.6, [sp(145.2, '2026-01-21', { size: 4.6, color: '#808080' })]),        // 기둥 한가운데의 부속물
    ln(143.9, [sp(137.0, 'I410-141-25-99-091285995', { size: 5.0, color: '#919294' })]),
    ln(194.3, [sp(66.7, '1)', { size: 7.9, w: 6 }), sp(77.5, '[정답] ④', { size: 7.9 })]),
    ln(206.3, [sp(66.7, '[해설] 날개를 접은 것은 기다림이지 포기가 아니다. ', { size: 7.9 })]),
    ln(218.3, [sp(83.8, '따라서 ④는 적절하지 않다. ① 창틀은 새가 머무는 ', { size: 7.9 })]),
    ln(230.3, [sp(83.8, '자리다. ② 유리는 경계를 이룬다. ③ 하늘은 닿고 ', { size: 7.9 })]),
    ln(242.3, [sp(83.8, '싶은 자리다. ⑤ 창틀을 부순 흔적은 나오지 않는다.', { size: 7.9 })]),
    ln(406.2, [sp(66.7, '2)', { size: 7.9, w: 6 }), sp(77.5, '[정답] ②', { size: 7.9 })]),
    ln(418.2, [sp(66.7, '[해설] 침묵을 문장에 빗댄 점이 핵심이다. ', { size: 7.9 })]),
    ln(430.2, [sp(83.8, '① 마당은 배경일 뿐이다. ③ 눈은 소리를 지운다. ', { size: 7.9 })]),
    ln(442.2, [sp(83.8, '④ 겨울은 계절이다. ⑤ 문장은 얼지 않는다.', { size: 7.9 })]),
    ln(790.2, [sp(286.3, '- 3 -')]),
    /* 오른단 — 서술형 정답은 원문자가 아니라 문장이고 두 줄에 걸쳐 있다 */
    ln(122.3, [sp(321.8, '3)', { size: 7.9, w: 6 }), sp(332.8, '[정답] 유리 너머를 바라보는 기다림의 ', { size: 7.9 })]),
    ln(134.3, [sp(338.6, '태도를 뜻한다.', { size: 7.9 })]),
    ln(146.3, [sp(321.8, '[해설] 새는 유리에 막혀 있지만 시선은 하늘에 있다.', { size: 7.9 })]),
  ]),
] };

const WORKS = { '유리 새': 'w-yurisae', '겨울 문장': 'w-gyeoul' };
const out = buildDanwon(doc, { scope: 't1', workIds: WORKS });
const byId = {};
out.items.forEach((i) => { byId[i.id] = i; });

t('세 숫자가 같아야 한다 — 문항번호 · zb id · 해설 블록', () => {
  const line = out.review.report.filter((r) => /검산/.test(r))[0];
  assert.ok(/문항번호 3 · zb id 3 · 해설 블록 3/.test(line), line);
  assert.ok(/\(일치\)/.test(line), line);
  assert.ok(!out.review.todo.some((x) => /검산 불일치/.test(x)), out.review.todo.join(' | '));
});

t('읽기 순서는 기둥 우선이다 — 오른단으로 넘어간 지문이 뒤 문항에 붙으면 안 된다', () => {
  const nara = out.review.candidates.filter((c) => c.kind === 'setText' && c.title === '겨울 문장')[0];
  assert.deepStrictEqual(nara.lines, ['눈이 내려 마당을 덮고', '문장은 천천히 얼어붙는다']);
  /* 오른단 첫 줄(y=103.5)이 왼단 마지막 줄(y=586.2)보다 뒤에 와야 한다 */
  assert.strictEqual(nara.label, '(나)');
});

t('세트는 지면 y가 아니라 스트림 순서로 문항을 가른다', () => {
  assert.strictEqual(byId['dj-t1-001'].setId, 's-dj-t1-01');
  assert.strictEqual(byId['dj-t1-002'].setId, 's-dj-t1-01');
  /* 3번은 지면상 세트2 지문 아래에 있고, 세트2 소속이다 */
  assert.strictEqual(out.review.pending.filter((p) => p.kind === 'item')[0].item.setId, 's-dj-t1-02');
});

t('zb 는 크기로 잡는다 — 검정 1pt 인 것이 실제로 있다', () => {
  assert.strictEqual(byId['dj-t1-001'].source.zbId, 'zb1)');
  const essay = out.review.pending.filter((p) => p.kind === 'item')[0].item;
  assert.strictEqual(essay.source.zbId, 'zb3)', '검정 zb 를 색으로 거르면 여기서 빈다');
  /* 지면에 안 보이는 글자다 — 발문에 남으면 학생 화면에 'zb1) (가)의…'로 뜬다.
     source.zbId 에는 남긴다(오추출을 원본 지면으로 되짚는 경로다) — 화면에 나가는 곳만 검사한다. */
  const shown = out.items.map((i) => i.stem + JSON.stringify(i.choices) +
    JSON.stringify(i.bogi || '') + JSON.stringify(i.explanation || '')).join('');
  assert.ok(!/zb/.test(shown), 'zb 문항번호가 학생 화면에 나가는 자리로 샜습니다');
});

t('밑줄 경계에서 공백이 먹혀도 부정발문을 잡고 <b>않은</b>으로 표시한다', () => {
  assert.strictEqual(byId['dj-t1-001'].stem, '(가)의 표현에 대한 이해로 적절하지 <b>않은</b>것은?');
  assert.strictEqual(byId['dj-t1-001'].isNegative, true);
  assert.strictEqual(byId['dj-t1-002'].isNegative, false);
});

t('stem 만 HTML 이다 — 꺾쇠를 안 막으면 <보기>가 화면에서 사라진다', () => {
  assert.ok(/^&lt;보기&gt;를 바탕으로/.test(byId['dj-t1-002'].stem), byId['dj-t1-002'].stem);
  /* 나머지 필드는 앱이 esc() 하므로 평문이어야 한다 */
  assert.strictEqual(byId['dj-t1-002'].bogi.text, '겨울은 말을 멈추게 하는 계절이다. 시인은 그 침묵을 문장에 빗대었다.');
  assert.ok(!/&lt;|&amp;/.test(byId['dj-t1-002'].bogi.text));
});

t('줄 이어붙이기 — 공백을 넣어도, 붙이기 전에 trim 해도 안 된다', () => {
  const ch = byId['dj-t1-001'].choices;
  assert.strictEqual(ch.length, 5);
  assert.strictEqual(ch[1].text, '유리는 새와 하늘 사이를 가르는 경계로 읽힌다.');   // 어절 경계
  assert.strictEqual(ch[3].text, '날개를 접은 것은 포기를 뜻한다.');               // 어절 중간
  assert.deepStrictEqual(ch.map((c) => c.no), [1, 2, 3, 4, 5]);
});

t('정답 선지의 개별 해설은 없다 — 앞 산문을 main 과 perChoice[정답] 양쪽에 넣는다', () => {
  const it = byId['dj-t1-001'];
  assert.strictEqual(it.answer, 4);
  assert.ok(/^날개를 접은 것은 기다림이지/.test(it.explanation.main), it.explanation.main);
  /* 자료에는 ①②③⑤ 넷뿐이다. 그대로 두면 문항마다 '선지별 해설 누락' 경고가 뜬다 */
  assert.deepStrictEqual(Object.keys(it.explanation.perChoice).sort(), ['1', '2', '3', '4', '5']);
  assert.strictEqual(it.explanation.perChoice['4'], it.explanation.main);
  assert.strictEqual(it.explanation.perChoice['1'], '창틀은 새가 머무는 자리다.');
  /* 마커 뒤 공백을 강제하지 않으면 정답 근거 안의 '④는' 에서 잘린다 */
  assert.ok(/따라서 ④는 적절하지 않다/.test(it.explanation.main), it.explanation.main);
});

t('판면 부속물은 해설에 섞이지 않는다 — y밴드로는 안 걸린다', () => {
  /* meta.sourceId 에는 남는다(팩 source.contentCode 후보다) — 본문으로 새는지를 본다 */
  const dump = JSON.stringify({ sets: out.sets, items: out.items,
    patches: out.patches, candidates: out.review.candidates, pending: out.review.pending });
  assert.ok(!/I410|091285995/.test(dump), '자료 식별번호가 본문으로 샜습니다');
  assert.ok(!/2026-01-21/.test(dump), '제작일이 해설 본문으로 샜습니다');
  assert.ok(!/단원집중\] /.test(JSON.stringify(out.items)), '머리말이 해설 앞에 붙었습니다');
});

t('서술형은 items 가 아니라 review.pending 으로 나간다 — 빈 rubric 은 배포 차단 오류다', () => {
  assert.deepStrictEqual(out.items.map((i) => i.format), ['mc5', 'mc5']);
  const p = out.review.pending.filter((x) => x.kind === 'item');
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].item.format, 'essay');
  assert.deepStrictEqual(p[0].item.rubric, []);
  assert.deepStrictEqual(p[0].item.modelAnswers, ['유리 너머를 바라보는 기다림의 태도를 뜻한다.']);
  assert.ok(/새는 유리에 막혀/.test(p[0].item.explanation.main));
  assert.ok(out.review.todo.some((x) => /rubric/.test(x)), out.review.todo.join(' | '));
});

t('문항 id 는 시리즈 접두를 단다 — zb 번호는 파일 안에서만 유일하다', () => {
  assert.deepStrictEqual(out.items.map((i) => i.id), ['dj-t1-001', 'dj-t1-002']);
  assert.notStrictEqual(U.itemId('danwon', 't1', 1), U.itemId('seosul', 't1', 1));
  assert.strictEqual(new Set(out.items.map((i) => i.id)).size, out.items.length);
});

t('targetRefs 는 빈 배열이다 — 억지 매칭은 오답을 엉뚱한 빈칸 큐로 보낸다', () => {
  out.items.forEach((i) => assert.deepStrictEqual(i.targetRefs, []));
  assert.ok(out.review.todo.some((x) => /targetRefs/.test(x)));
});

t('patches 는 조각이다 — 완전한 Work 를 내면 작품 id 중복으로 배포가 막힌다', () => {
  assert.strictEqual(out.patches.length, 2, '같은 작품 3 인스턴스가 2편으로 접혀야 한다');
  const p = out.patches.filter((x) => x.title === '유리 새')[0];
  assert.strictEqual(p.author, '한도연');
  assert.strictEqual(p.workKey, '유리 새');          // 시리즈끼리 잇는 유일한 조인 키
  assert.strictEqual(p.source.instances, 2);
  /* Work 를 통째로 내면 안 된다 */
  assert.strictEqual(p.workId, undefined);
  assert.strictEqual(p.blanks, undefined);
  assert.strictEqual(p.text, undefined);
  assert.strictEqual(out.patches.filter((x) => x.title === '겨울 문장')[0].author, '서봄');
});

t('작가는 가운데 정렬이 아니라 기둥 왼끝 오프셋으로 가른다 — 제목이 더 넓을 수 있다', () => {
  /* '겨울 문장'(폭 40)이 작가 '서봄'(폭 17)보다 넓다 — 폭만으로 가르면 뒤바뀐다 */
  const c = out.review.candidates.filter((x) => x.kind === 'attribution' && x.title === '겨울 문장')[0];
  assert.strictEqual(c.author, '서봄');
  assert.strictEqual(out.review.candidates.filter((x) => x.kind === 'attribution').length, 3);
});

t('㉠는 patches 로만 낸다 — 본문이 여기 없어 anchorText 를 검증할 수 없다', () => {
  const p = out.patches.filter((x) => x.title === '유리 새')[0];
  assert.strictEqual(p.marks.length, 2, '세트마다 따로 담아야 한다');
  p.marks.forEach((m) => {
    assert.strictEqual(m.symbol, '㉠');
    assert.strictEqual(m.anchorText, '유리 너머 하늘을 본다');   // 기호는 앵커에 넣지 않는다
    assert.ok(m.setId);
  });
  assert.ok(out.review.todo.some((x) => /anchorText/.test(x)), out.review.todo.join(' | '));
  /* 지문 줄에는 기호가 그대로 남는다 — 원문 보존(스키마 원칙 3) */
  const s = out.review.candidates.filter((x) => x.kind === 'setText' && x.title === '유리 새')[0];
  assert.ok(s.lines.some((l) => l.indexOf('㉠') === 0), s.lines.join(' / '));
});

t('작품이 여럿인 세트의 문항에는 workId 를 달지 않는다 — 어느 작품인지는 발문이 정한다', () => {
  assert.strictEqual(out.sets.length, 2);
  const s1 = out.sets.filter((s) => s.setId === 's-dj-t1-01')[0];
  assert.deepStrictEqual(s1.works.map((w) => w.label), ['(가)', '(나)']);
  assert.deepStrictEqual(s1.works.map((w) => w.workId), ['w-yurisae', 'w-gyeoul']);
  assert.strictEqual(byId['dj-t1-001'].workId, undefined);
  /* 작품 1편짜리 세트는 문항에 그대로 건다 */
  assert.strictEqual(out.review.pending.filter((p) => p.kind === 'item')[0].item.workId, 'w-yurisae');
});

t('workId 를 못 받은 세트는 팩에 내지 않는다 — 반쪽만 담으면 지문이 조용히 사라진다', () => {
  const half = buildDanwon(doc, { scope: 't1', workIds: { '유리 새': 'w-yurisae' } });
  assert.deepStrictEqual(half.sets.map((s) => s.setId), ['s-dj-t1-02']);
  const pend = half.review.pending.filter((p) => p.kind === 'set');
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].setId, 's-dj-t1-01');
  /* 세트를 못 냈으면 문항도 그 세트를 가리키면 안 된다(없는 setId 참조는 오류다) */
  half.items.forEach((i) => assert.notStrictEqual(i.setId, 's-dj-t1-01'));
  assert.strictEqual(half.items.filter((i) => i.id === 'dj-t1-001')[0].setId, undefined);
});

t('머리말에서 교과서 좌표를 읽어 둔다 — 여러 자료를 합칠 때 서로를 채운다', () => {
  assert.strictEqual(out.meta.grade, '중2');
  assert.strictEqual(out.meta.subUnit, '1-1');
  assert.strictEqual(out.meta.roundTitle, '유리와 겨울(1회)');
  assert.strictEqual(out.series, 'danwon');
  assert.strictEqual(U.detectSeries(doc).series, 'danwon');
});

t('검수 부속물은 팩에 낼 것과 섞이지 않는다 — 섞이면 학생 기기까지 배달된다', () => {
  const packable = JSON.stringify({ sets: out.sets, items: out.items });
  assert.ok(!/candidates|pending|report|todo/.test(packable));
  out.items.forEach((i) => {
    assert.strictEqual(i.candidates, undefined);
    assert.strictEqual(i.review, undefined);
  });
  assert.ok(out.review.candidates.length > 0 && out.review.todo.length > 0);
});

console.log(`\nOK — ${passed}개 통과. 초안은 초안이다 — 검수 게이트(§7[3])는 건너뛰지 않는다.`);
