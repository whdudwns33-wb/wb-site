/* 서술형 공략 추출기 (node naesin-ko/extract/build-seosul.test.mjs)
 *
 * 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1). 그래서 **지면의 성질만
 * 베낀** 가상 시·소설을 여기서 직접 지어 spans 구조로 만든다. 지키는 성질:
 *   ① 2단 조판이고 읽기 순서는 왼쪽단 전체 → 오른쪽단 전체다 (y로 훑으면 문항 순서가 뒤집힌다)
 *   ② 흰 글씨는 정답이 아니라 zb 문항번호이고, 지면에는 안 보이는 글자다
 *   ③ 문항번호 · zb · 해설 블록 세 수가 같아야 한다 (누락 검산)
 *   ④ <보기>/<조건> 상자에는 테두리(괘선)가 없다 — 라벨과 발문 격자로만 경계를 잡는다
 *   ⑤ 조건 문구를 잘못 분류하면 곧 오답 판정이다 — 확신이 없으면 사람 확인으로 내린다
 *   ⑥ 루브릭 없는 서술형은 팩에 넣는 순간 **오류**라 배포가 통째로 막힌다
 *   ⑦ 검수 부속물이 팩(items·sets·patches)에 섞이면 학생 기기까지 배달된다
 * ③~⑦ 은 실제 지면에서 초안을 망가뜨렸거나 배포를 막았던 것들이다 — 회귀로 못 박는다. */
import assert from 'node:assert';
import { buildSeosul, classifyCondition } from './build-seosul.mjs';
import * as U from './spans-util.mjs';
import PC from '../pack-check.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const BLACK = '#000000', WHITE = '#ffffff', MARK = '#191919', LABEL = '#3e88ab';
const sp = (x, text, o = {}) => ({ x, w: o.w == null ? text.length * 9 : o.w,
  size: o.size == null ? 9.1 : o.size, color: o.color || BLACK, text });
const ln = (y, spans) => ({ y, spans });
const pg = (no, lines) => ({ no, width: 595.2, height: 841.9, lines });
/* 문항 번호는 #191919 13.7pt, zb 는 1.0/0.7pt 두 조각 — 크기·색이 곧 마커다 */
const no = (x, n) => sp(x, n + '.', { size: 13.7, color: MARK, w: 11.3 });
const zb = (x, n) => [sp(x, 'zb', { size: 1.0, color: WHITE, w: 1.0 }),
  sp(x + 1, n + ')', { size: 0.7, color: WHITE, w: 0.7 })];
const lab = (x, s) => sp(x, s, { size: 7.0, color: LABEL, w: s.length * 6 });
const sol = (x, s, o = {}) => sp(x, s, Object.assign({ size: 7.9 }, o));

/* ── 지어낸 지면 ──
   시 '모래 언덕'(한여울) · 소설 '유리병 편지'(서리내). 좌표는 실측 지면의 격자를 그대로 옮겼다:
   기둥 왼끝 56.6/311.8 · 발문 첫 줄 +25.7 · 이어지는 줄 +16.6 · 문단 첫 줄 +13.0 · 이어지는 줄 +5.3 */
const p1 = pg(1, [
  ln(46.5, [sp(193.9, '천재(노미숙)2-1', { w: 62.9 })]),
  /* 마스트헤드는 절의 시작 신호이자 학년 메타다. 10.1/11.0pt 라 본문으로 안 샌다. */
  ln(65.4, [sp(79.4, '중', { size: 10.1, color: LABEL, w: 10.1 }), sp(90.7, '2', { size: 11.0, color: LABEL, w: 6.4 }),
    sp(121.9, '국어', { size: 11.0, color: LABEL, w: 21.4 }), sp(293.0, '1.문학을 펼치면(01)', { size: 10.1, w: 87.6 })]),
  ln(161.4, [sp(56.6, '※ 다음 글을 읽고 물음에 답하시오. ', { size: 7.9, w: 120.9 })]),
  ln(175.8, [sp(155.5, '모래 언덕', { w: 37.2 })]),
  ln(193.0, [sp(253.4, '한여울', { w: 25.2 })]),
  ln(232.9, [sp(69.6, '바람이 지운 발자국 위에', { w: 100.0 })]),
  ln(251.9, [sp(69.6, '㉠모래는 다시 길을 그린다', { w: 120.0 })]),
  ln(270.9, [sp(69.6, '나는 그 길을 밟으며', { w: 95.0 })]),
  /* 판면 부속물이 본문 줄 끝에 섞여 들어온다 — 줄을 통째로 버리는 필터로는 못 거른다 */
  ln(289.9, [sp(69.6, '어제의 나를 지운다 I410-141-25-99-091285995- 1 -', { w: 140.0 })]),
  ln(400.0, [no(56.6, 1)]),
  ln(405.2, [sp(82.3, '이 시의 운율 형성 요소를 한 가지만 쓰시오.', { w: 190.0 })]),
  ln(414.0, zb(73.2, 1)),
  ln(430.0, [sp(157.2, '<조건>', { w: 25.9 })]),
  ln(446.0, [sp(80.9, '‘~하여 운율을 형성하고 있다.’ 형식으로 쓸 것.', { w: 178.4 })]),
  /* 오른쪽단 2번이 왼쪽단 1번보다 위에 있다 — 읽기 순서가 y가 아님을 여기서 못 박는다 */
  ln(98.6, [no(311.8, 2)]),
  ln(103.8, [sp(337.4, '<보기>에서 ㉠과 같은 심상이 쓰인 부분을 모두 찾아 쓰', { w: 201.1 })]),
  ln(112.5, zb(328.3, 2)),
  ln(118.4, [sp(328.3, '시오.', { w: 116.2 })]),
  ln(136.6, [sp(412.3, '<보기>', { w: 25.9 })]),
  ln(152.7, [sp(316.8, '갯벌 냄새가 마당까지 밀려와', { w: 120.0 })]),
  ln(166.2, [sp(316.8, '저녁상 위에 앉는다', { w: 115.0 })]),
  ln(180.0, [sp(418.3, '- 한여울, <소금 창고> 중 일부', { w: 115.4 })]),
  ln(200.0, [sp(412.3, '<조건>', { w: 25.9 })]),
  ln(216.0, [sp(356.4, '해당하는 부분의 시행을 모두 쓸 것.', { w: 137.6 })]),
]);

const p2 = pg(2, [
  ln(46.3, [sp(64.6, '천재(노미숙)2-1', { size: 7.9, w: 56.9 })]),
  ln(64.3, [sp(56.6, '※ 다음 글을 읽고 물음에 답하시오. ', { size: 7.9, w: 120.9 })]),
  ln(78.2, [sp(152.4, '유리병 편지', { w: 43.5 })]),
  ln(99.4, [sp(253.4, '서리내', { w: 25.2 })]),
  ln(118.6, [sp(69.6, '(앞부분 줄거리)', { w: 58.6 })]),
  ln(132.0, [sp(69.6, '소라는 전학 온 학교에서 말을 잃었다. 어느 날 바닷가에서 ', { w: 209.0 })]),
  ln(145.5, [sp(61.9, '유리병 하나를 줍는다.', { w: 216.9 })]),
  ln(164.0, [sp(69.6, '유리병 안에는 색이 바랜 종이가 한 장 들어 있었다. 소라는 ', { w: 209.0 })]),
  ln(177.5, [sp(61.9, '조심스럽게 마개를 열고 종이를 꺼냈다. 글씨는 빗물에 번져 있', { w: 216.9 })]),
  ln(191.0, [sp(61.9, '었다.', { w: 100.0 })]),
  ln(210.0, [sp(69.6, '㉡“누구든 이걸 읽는 사람에게.” 첫 줄은 그렇게 시작했다. ', { w: 209.0 })]),
  ln(223.5, [sp(61.9, '소라는 숨을 삼켰다. ', { w: 180.0 })]),
  ln(237.0, [sp(61.9, '멀리서 파도가 한 번 더 밀려왔다.', { w: 190.0 })]),
  ln(260.0, [no(56.6, 3)]),
  ln(265.2, [sp(82.3, '소라가 유리병을 주운 뒤 마음이 어떻게 달라졌는지 쓰시오.', { w: 200.0 })]),
  ln(274.0, zb(73.2, 3)),
  ln(290.0, [sp(157.2, '<조건>', { w: 25.9 })]),
  ln(306.0, [sp(61.9, '1. 한 문장으로 쓸 것', { w: 90.0 })]),
  ln(320.0, [sp(61.9, '2. ‘소라는 ⓐ에서 ~으로 바뀌었다.’의 형태로 쓸 것', { w: 219.5 })]),
  ln(46.31, [sp(406.6, '[서술형 공략] 1.문학을 펼치면(01)', { size: 7.9, w: 124.6 })]),
  ln(64.31, [no(311.8, 4)]),
  ln(69.4, [sp(337.4, '유리병 편지가 소라에게 준 위로가 무엇인지 쓰시오.', { w: 190.0 })]),
  ln(78.2, zb(328.3, 4)),
  ln(95.0, [sp(412.3, '<조건>', { w: 25.9 })]),
  ln(111.0, [sp(316.8, '‘소라는 ~고 느꼈고, 친구는 ~고 느꼈다.’의 형태로 쓸 것.', { w: 219.5 })]),
]);

/* 해설쪽 — 청록 7.0pt 라벨이 절을 가르고, 'N)' 단독 줄이 문항 블록을 가른다. */
const p3 = pg(3, [
  ln(46.3, [sp(64.6, '천재(노미숙)2-1', { size: 7.9, w: 56.9 })]),
  ln(100.0, [sol(66.7, '1)', { w: 7.5 })]),
  ln(113.0, [lab(73.9, '모범 답안')]),
  ln(125.0, [sol(66.7, '유사한 시구를 반복하여 운율을 형성하고 있다. / 종결 어')]),
  ln(137.0, [sol(66.7, '미를 반복하여 운율을 형성하고 있다.')]),
  ln(150.0, [lab(73.9, '핵심 단어')]),
  ln(162.0, [sol(66.7, '유사한 시구, 종결 어미, 반복')]),
  /* 라벨 텍스트에 끝 공백이 붙어 온다 — startsWith 로 가르면 모범답안 수가 부풀어 오른다 */
  ln(175.0, [lab(73.9, '모범 답안 check list ')]),
  ln(187.0, [sol(66.7, '□ 운율을 만드는 요소를 떠올리며 작성한다.')]),
  ln(199.0, [sol(66.7, '□ 주어진 조건의 형식에 맞추어 서술한다.')]),
  ln(212.0, [lab(73.9, '이해 plus+')]),
  ln(224.0, [sol(66.7, '1연과 2연에서 같은 구조의 시구가 되풀이된다. I410-141-25-99-091285995- 3 -')]),
  ln(250.0, [sol(66.7, '2)', { w: 7.5 })]),
  ln(263.0, [lab(73.9, '모범 답안')]),
  ln(275.0, [sol(66.7, '갯벌 냄새가 마당까지 밀려와')]),
  ln(288.0, [lab(73.9, '해설')]),
  ln(300.0, [sol(66.7, '후각적 심상이 쓰인 시행을 그대로 옮기면 된다.')]),
  ln(772.2, [sp(134.4, '◇「콘텐츠산업 진흥법 시행령」제33조에 의한 표시', { size: 5.0 })]),
  ln(778.9, [sp(134.4, '1) 제작연월일 : ', { size: 5.0 }), sp(200.0, '2026-01-08', { size: 5.0 }),
    sp(240.0, '2) 제작자 : ', { size: 5.0 }), sp(280.0, '교육지대㈜', { size: 5.0 })]),
  ln(66.2, [sol(321.8, '3)', { w: 7.5 })]),
  ln(79.0, [lab(329.0, '모범 답안')]),
  ln(91.0, [sol(321.8, '소라는 무기력에서 설렘으로 바뀌었다.')]),
  ln(104.0, [lab(329.0, '핵심 단어')]),
  ln(116.0, [sol(321.8, '무기력, 설렘')]),
  ln(130.0, [lab(329.0, '해설')]),
  ln(142.0, [sol(321.8, '유리병 편지를 읽은 뒤 소라의 마음이 달라진다.')]),
  ln(170.0, [sol(321.8, '4)', { w: 7.5 })]),
  ln(183.0, [lab(329.0, '모범 답안')]),
  /* 조건은 '친구는'인데 모범답안은 '이웃은'이다 — 자료가 스스로 어긋난 자리 */
  ln(195.0, [sol(321.8, '소라는 혼자가 아니라고 느꼈고, 이웃은 함께라고 느꼈다.')]),
  ln(209.0, [lab(329.0, '개념 plus+')]),
  ln(221.0, [sol(321.8, '소설의 서술자 시점')]),
  ln(233.0, [sp(333.1, '1인칭 ', { size: 7.4, color: '#0c0c0c' }), sp(369.1, '· 서술자의 위치 : 이야기 안', { size: 7.4, color: '#0c0c0c' })]),
  ln(245.0, [lab(329.0, '해설')]),
  ln(257.0, [sol(321.8, '유리병 편지는 소라에게 위로를 준다.')]),
  /* 저작권 고지의 오른쪽 절반이 x=302.6 — 어느 기둥 밴드에도 없는 자리라 x로만 나누면 본문에 박힌다 */
  ln(790.0, [sp(302.6, '적 책임을 질 수 있습니다.', { size: 5.0 }), sp(400.0, 'I410-141-25-99-091285995', { size: 5.0 }),
    sp(511.2, '- 3 -', { size: 5.0 })]),
]);

const doc = { file: 'fixture.pdf', pages: [p1, p2, p3] };
const WORKS = { '모래 언덕': 'w-morae', '유리병 편지': 'w-yuribyeong' };
const out = buildSeosul(doc, { scope: 'u1', workIds: WORKS });
const allItems = out.items.concat(out.review.pending.filter((p) => p.kind === 'item').map((p) => p.item));
const byNo = (n) => allItems.filter((x) => x.source.no === n)[0];
const dump = JSON.stringify({ items: out.items, sets: out.sets, patches: out.patches });

t('읽기 순서는 왼쪽단 전체 → 오른쪽단 전체다 — y로 훑으면 문항 순서가 뒤집힌다', () => {
  /* 지면에서는 2번(오른쪽 y98)이 1번(왼쪽 y400)보다 위에 있다 */
  assert.deepStrictEqual(allItems.map((x) => x.source.no).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.strictEqual(byNo(1).setId, byNo(2).setId, '1·2번은 같은 지문 세트에 붙어야 한다');
  assert.strictEqual(byNo(3).setId, byNo(4).setId);
  assert.notStrictEqual(byNo(2).setId, byNo(3).setId);
});

t('문항번호·zb·해설 블록 세 수를 세서 검산한다 — 팩 counts 는 다시 세지므로 방어선이 못 된다', () => {
  const line = out.review.report.filter((r) => /검산 —/.test(r))[0];
  assert.ok(/문항번호 4 · zb id 4 · 해설 블록 4 \(일치\)/.test(line), line);
  assert.ok(!out.review.todo.some((x) => /검산 불일치/.test(x)));
  allItems.forEach((x) => assert.strictEqual(x.source.zbId, 'zb' + x.source.no + ')', x.id));
});

t('zb 는 지면에 안 보이는 글자다 — 발문에 남으면 학생 화면에 뜬다', () => {
  allItems.forEach((x) => assert.ok(!/zb\s*\d/.test(x.stem), x.stem));
});

t('stem 만 HTML 이다 — 꺾쇠를 안 막으면 <보기>가 화면에서 사라진다', () => {
  assert.ok(/&lt;보기&gt;에서/.test(byNo(2).stem), byNo(2).stem);
  /* 나머지 필드는 앱이 esc() 하므로 평문이어야 한다 */
  assert.ok(!/&lt;|&amp;/.test(JSON.stringify(byNo(2).bogi)), JSON.stringify(byNo(2).bogi));
});

t('발문은 상자 앞에서 끊고, 상자는 라벨이 없어도 발문 격자에서 벗어난 줄로 잡는다', () => {
  assert.strictEqual(byNo(2).stem, '&lt;보기&gt;에서 ㉠과 같은 심상이 쓰인 부분을 모두 찾아 쓰시오.');
  assert.ok(!/갯벌 냄새/.test(byNo(2).stem), '보기 상자가 발문에 붙었습니다');
});

t('<보기>의 출처 줄은 오른쪽 정렬로 갈라 sourceWork 로 뺀다', () => {
  assert.strictEqual(byNo(2).bogi.sourceWork, '한여울, <소금 창고> 중 일부');
  assert.ok(!/소금 창고/.test(byNo(2).bogi.text), byNo(2).bogi.text);
  /* 일부러 끊은 시행은 붙이면 글자가 엉킨다 — 인용 관례대로 ' / '로 잇는다 */
  assert.strictEqual(byNo(2).bogi.text, '갯벌 냄새가 마당까지 밀려와 / 저녁상 위에 앉는다');
});

t('조건 상자는 마커로 쪼개고, 마커가 없으면 상자 전체가 조건 1개다', () => {
  assert.strictEqual(byNo(1).conditions.length, 1);
  assert.strictEqual(byNo(1).conditions[0].kind, 'form');
  assert.strictEqual(byNo(1).conditions[0].value, '~하여 운율을 형성하고 있다.');
  assert.strictEqual(byNo(3).conditions.length, 2, JSON.stringify(byNo(3).conditions));
  assert.strictEqual(byNo(3).conditions[0].kind, 'sentences');
  assert.strictEqual(byNo(3).conditions[0].value, 1);
});

t('정규화가 지우는 글자(ⓐ·㉠·꺾쇠)가 든 틀은 사람 확인으로 내린다 — 억지 판정은 곧 오답 판정이다', () => {
  const c = byNo(3).conditions[1];
  assert.strictEqual(c.kind, 'quote', JSON.stringify(c));
  assert.ok(/ⓐ/.test(c.text), c.text);
  const p = out.review.pending.filter((x) => x.kind === 'condition' && x.no === 3)[0];
  assert.ok(p && /지우는 글자/.test(p.why), JSON.stringify(p));
});

t('자료의 모범답안이 자기 조건에서 떨어지면 자동 판정을 끈다 — 학생에게 즉시 오답이 돌아가기 때문', () => {
  /* 4번은 조건이 '친구는 ~'인데 모범답안은 '이웃은 ~'이다 */
  assert.strictEqual(byNo(4).conditions[0].kind, 'quote', JSON.stringify(byNo(4).conditions));
  const p = out.review.pending.filter((x) => x.kind === 'condition' && x.no === 4)[0];
  assert.ok(p && /모범답안이 이 조건에서 떨어진다/.test(p.why), JSON.stringify(p));
  assert.ok(out.review.todo.some((x) => /모범답안이 자기 조건에서 떨어졌다/.test(x)));
  /* 그래도 조건 문구는 학생 화면에 남는다 — 지우면 무엇을 지켜야 하는지 못 본다 */
  assert.ok(/친구는/.test(byNo(4).conditions[0].text));
});

t('루브릭 없는 서술형은 items 가 아니라 review.pending 으로 간다 — 빈 rubric 은 배포 차단 오류다', () => {
  out.items.forEach((x) => assert.ok(x.rubric.length, x.id));
  const noRubric = out.review.pending.filter((p) => p.kind === 'item' && p.reason === 'no-rubric');
  assert.deepStrictEqual(noRubric.map((p) => p.item.source.no), [2, 4]);
});

t('자료의 모범답안조차 자기 루브릭에서 떨어지는 문항도 내리지 않는다 — 학생이 무엇을 써도 영영 보류가 된다', () => {
  /* 1번은 발문이 '한 가지만 쓰시오'인데 핵심 단어가 3개라 AND 로 묶이면 어느 모범답안도 만점을 못 받는다 */
  const self = out.review.pending.filter((p) => p.kind === 'item' && p.reason === 'rubric-selfcheck');
  assert.deepStrictEqual(self.map((p) => p.item.source.no), [1], JSON.stringify(self.map((p) => p.why)));
  assert.ok(/영영 보류/.test(self[0].why), self[0].why);
  /* 팩에 나가는 것은 모범답안이 실제로 통과하는 문항뿐이다 */
  assert.deepStrictEqual(out.items.map((x) => x.source.no), [3]);
  assert.ok(out.review.report.some((r) => /모범답안이 자기 루브릭에서 떨어짐 1/.test(r)),
    out.review.report.join(' | '));
});

t('루브릭은 핵심 단어를 쉼표로 자른 요소이고 배점은 넣지 않는다', () => {
  assert.deepStrictEqual(byNo(1).rubric.map((r) => r.element), ['유사한 시구', '종결 어미', '반복']);
  byNo(1).rubric.forEach((r) => {
    assert.deepStrictEqual(r.keywords, [r.element]);
    assert.strictEqual(r.points, null);
    assert.strictEqual(r.source, 'material');
  });
  /* 배점이 지면에 없으므로 totalPoints 를 내면 요소 배점 합과 어긋나 오류가 난다 */
  allItems.forEach((x) => assert.strictEqual(x.totalPoints, undefined, x.id));
});

t('모범 답안의 복수 정답 병기(\' / \')는 그대로 쪼갠다', () => {
  assert.deepStrictEqual(byNo(1).modelAnswers,
    ['유사한 시구를 반복하여 운율을 형성하고 있다.', '종결 어미를 반복하여 운율을 형성하고 있다.']);
  assert.deepStrictEqual(byNo(1).answerChecks,
    ['운율을 만드는 요소를 떠올리며 작성한다.', '주어진 조건의 형식에 맞추어 서술한다.']);
});

t("해설 라벨이 '이해 plus+'와 '해설'로 갈려도 한 필드로 모은다", () => {
  assert.ok(/같은 구조의 시구/.test(byNo(1).explanation.main), byNo(1).explanation.main);
  assert.ok(/시행을 그대로 옮기면/.test(byNo(2).explanation.main));
  allItems.forEach((x) => assert.ok(x.explanation && x.explanation.main, x.id));
});

t('판면 부속물은 본문에 남지 않는다 — 저작권 고지가 오른쪽단으로 새는 자리까지 막는다', () => {
  const content = dump + JSON.stringify(out.review);
  assert.ok(!/I410|091285995/.test(content), '자료 식별번호가 본문에 남았습니다');
  assert.ok(!/법적 책임|콘텐츠산업/.test(content), '저작권 고지가 본문으로 샜습니다');
  assert.ok(!/-\s*3\s*-/.test(content), '쪽번호가 남았습니다');
  assert.ok(/어제의 나를 지운다/.test(JSON.stringify(out.review.candidates)), '본문까지 같이 지웠습니다');
  /* 식별번호는 출처 근거라 meta 에만 남긴다(§10 회신본 보관) — 학생 화면에는 안 간다 */
  assert.strictEqual(out.meta.sourceId, 'I410-141-25-99-091285995');
});

t('시 세트는 정본 본문에 맡기고 소설 세트만 발췌 본문을 담는다', () => {
  const poem = out.sets.filter((s) => s.works[0].workId === 'w-morae')[0];
  const novel = out.sets.filter((s) => s.works[0].workId === 'w-yuribyeong')[0];
  assert.strictEqual(poem.works[0].kind, 'full');
  assert.strictEqual(poem.works[0].text, undefined, '시 본문을 중복해 담았습니다');
  assert.strictEqual(novel.works[0].kind, 'excerpt');
  /* 발췌 세트는 text 가 없으면 검증기가 오류를 낸다 — 소설 전문은 자료에 없다 */
  assert.strictEqual(novel.works[0].text.paragraphs.length, 2, JSON.stringify(novel.works[0].text));
  /* 어절 경계 줄바꿈만 끝공백이 있다 — 임의로 띄우면 '번져 있 었다'가 된다 */
  assert.ok(/종이를 꺼냈다. 글씨는 빗물에 번져 있었다.$/.test(novel.works[0].text.paragraphs[0]),
    novel.works[0].text.paragraphs[0]);
  assert.ok(/^소라는 전학 온 학교에서 말을 잃었다. 어느 날 바닷가에서 유리병 하나를 줍는다.$/
    .test(novel.works[0].prefaceSummary), novel.works[0].prefaceSummary);
});

t('㉠ 기호는 세트에 매단다 — 같은 작품이라도 세트마다 가리키는 구절이 다르다', () => {
  const poem = out.sets.filter((s) => s.works[0].workId === 'w-morae')[0];
  assert.deepStrictEqual(poem.marks.map((m) => m.symbol), ['㉠']);
  assert.strictEqual(poem.marks[0].anchorText, '모래는 다시 길을 그린다');
  const novel = out.sets.filter((s) => s.works[0].workId === 'w-yuribyeong')[0];
  assert.strictEqual(novel.marks[0].symbol, '㉡');
  /* 앵커는 원문의 부분 문자열이어야 한다(work.marks 로 옮기면 검증기가 본문에서 찾는다) */
  assert.ok(novel.works[0].text.paragraphs[1].indexOf(novel.marks[0].anchorText) >= 0, novel.marks[0].anchorText);
});

t('제목·작가를 못 찾거나 workId 를 못 받은 세트는 팩에 내지 않는다 — 반쪽 세트는 지문을 잃는다', () => {
  const bare = buildSeosul(doc, { scope: 'u1' });          // --work 를 안 준 경우
  assert.deepStrictEqual(bare.sets, []);
  assert.strictEqual(bare.review.pending.filter((p) => p.kind === 'set').length, 2);
  /* 문항은 세트 번호를 달고 나간다 — 병합기가 세트를 살리면 그 번호로 다시 이어지고,
     끝내 못 살리면 병합기가 이 번호로 '지문 없는 문항'을 알아보고 팩에서 뺀다. */
  assert.ok(bare.items.some((x) => x.setId), '보류된 세트의 문항이 세트 번호를 잃었습니다');
  /* 검수에서 옮길 수 있게 본문을 pending 에 통째로 남긴다 */
  const ps = bare.review.pending.filter((p) => p.kind === 'set');
  assert.ok(ps.some((p) => (p.works[0].text || {}).paragraphs), JSON.stringify(ps[0]));
});

t('작가는 이 자료가 갖고 있다 — 완전한 Work 가 아니라 조각(patch)으로 낸다', () => {
  assert.deepStrictEqual(out.patches.map((p) => [p.workKey, p.title, p.author]),
    [['모래 언덕', '모래 언덕', '한여울'], ['유리병 편지', '유리병 편지', '서리내']]);
  /* 같은 workId 로 Work 를 두 번 내면 '작품 id 중복'으로 배포가 막힌다 */
  out.patches.forEach((p) => {
    assert.strictEqual(p.workId, undefined);
    assert.strictEqual(p.blanks, undefined);
    assert.strictEqual(p.text, undefined);
  });
  assert.ok(out.review.todo.some((x) => /patches 는 조각이다/.test(x)));
});

t('문항 id 는 시리즈 접두를 단다 — zb 번호는 파일 안에서만 유일해 단원집중과 충돌한다', () => {
  allItems.forEach((x) => assert.ok(/^ss-u1-\d{3}$/.test(x.id), x.id));
  const ids = allItems.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  ids.forEach((id) => assert.ok(!ids.includes(U.itemId('danwon', 'u1', 1)) || id !== U.itemId('danwon', 'u1', 1)));
  assert.notStrictEqual(U.itemId('seosul', 'u1', 1), U.itemId('danwon', 'u1', 1));
});

t('검수 부속물은 팩에 섞이지 않는다 — 섞이면 병합기가 팩 루트로 복사해 학생 기기까지 배달한다', () => {
  assert.ok(!/report|todo|candidates|pending|_review/.test(dump), dump.slice(0, 200));
  assert.ok(out.review.report.length && out.review.todo.length);
  assert.ok(out.review.candidates.some((c) => c.kind === 'concept'), '개념 plus+ 표를 후보로 남기지 않았습니다');
  /* 표는 셀이 여러 기둥으로 흩어져 줄 단위로 이으면 뒤섞인다 — 본문 필드에 넣지 않는다 */
  assert.ok(!/서술자의 위치/.test(dump), '개념 plus+ 표가 본문 필드로 샜습니다');
});

t('출판사·학기·제작 표시는 이 자료에만 있다 — 다른 시리즈의 빈 칸을 이것으로 메운다', () => {
  assert.strictEqual(out.meta.publisher, '천재');
  assert.strictEqual(out.meta.publisherAuthor, '노미숙');
  assert.strictEqual(out.meta.grade, '중2');
  assert.strictEqual(out.meta.semester, '1');
  assert.strictEqual(out.meta.unit, '1');
  assert.strictEqual(out.meta.producedAt, '2026-01-08');
  assert.strictEqual(out.meta.producer, '교육지대㈜');
});

t('조건 문구 분류는 확실한 것만 kind 를 준다 (순수 함수 단위 검사)', () => {
  const k = (s) => classifyCondition(s).kinds.map((x) => x.kind + ':' + JSON.stringify(x.value));
  assert.deepStrictEqual(k('‘~하여 운율을 형성하고 있다.’ 형식으로 쓸 것.'),
    ['form:"~하여 운율을 형성하고 있다."']);
  assert.deepStrictEqual(k('1. 답안은 반드시 두 문장으로 작성할 것.'), ['sentences:2']);
  assert.deepStrictEqual(k('2. 답안에는 ‘편견’과 ‘존중’이라는 두 어구를 모두 포함할 것.'),
    ['include:["편견","존중"]']);
  assert.deepStrictEqual(k('해당하는 부분의 시행을 모두 쓸 것.'),
    ['quote:"해당하는 부분의 시행을 모두 쓸 것."']);
  /* 한 조건이 두 종류를 겸한다 — 조건 객체를 둘로 낸다 */
  assert.deepStrictEqual(k("- ‘나는 A를 ~ 인물로 인식하고 있다.’와 같이 완결된 하나의 문장으로 쓸 것."),
    ['form:"나는 A를 ~ 인물로 인식하고 있다."', 'sentences:1']);
  /* 1글자 포함 어구는 다른 낱말 속에 걸려 오통과한다 */
  assert.deepStrictEqual(k('‘돌’과 ‘모래 무늬’의 의미를 함께 서술할 것'), []);
  assert.ok(/1글자/.test(classifyCondition('‘돌’과 ‘모래 무늬’의 의미를 함께 서술할 것').why[0]));
  /* 내용 요구형은 코드로 옮기지 않는다 */
  assert.deepStrictEqual(k('글의 내용을 바탕으로 서술할 것.'), []);
  assert.deepStrictEqual(k('문장 형태로 쓸 것.'), []);
  /* 마커 뒤 공백이 없는 표기가 섞여 있다 */
  assert.strictEqual(classifyCondition("1.‘나’의 현재 처지도 함께 서술할 것").text, "‘나’의 현재 처지도 함께 서술할 것");
});

t('산출물이 검증기를 그대로 통과한다 — 오류 하나면 팩 전체 배포가 막힌다', () => {
  const work = (id, title) => ({ workId: id, title, author: '', kind: 'poem',
    hasCanon: false, isExternal: false, blanks: [] });
  const r = PC.checkPack({
    packId: 'fixture-m2-1-U1', revision: '2022', publisher: '천재(노미숙)', grade: '중2',
    unit: '1.문학을 펼치면', source: { provider: '자체 창작 fixture' },
    works: [work('w-morae', '모래 언덕'), work('w-yuribyeong', '유리병 편지')],
    sets: out.sets, items: out.items,
  });
  assert.deepStrictEqual(r.errors, [], r.errors.join(' | '));
  assert.ok(r.ok);
});

console.log(`\nOK — ${passed}개 통과. 초안은 초안이다 — 루브릭 저작 게이트(§7[3])는 건너뛰지 않는다.`);
