/* 공용 지면 유틸 (node naesin-ko/extract/spans-util.test.mjs)
 *
 * 여기 걸린 것은 대부분 **실제 지면에서 초안을 망가뜨렸던 것**들이다. 규칙 하나하나가
 * 실측에서 나왔으므로, 성질을 말로 적고 그 성질을 fixture 로 재현한다.
 * 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1) — 성질만 베낀다. */
import assert from 'node:assert';
import * as U from './spans-util.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const sp = (x, text, o = {}) => ({ x, w: o.w == null ? text.length * 9 : o.w, size: o.size == null ? 9.1 : o.size, color: o.color || '#000000', text });
const ln = (y, spans) => ({ y, spans });
const pg = (no, lines, w = 595) => ({ no, width: w, height: 842, lines });

t('띄어쓰기는 공백 문자가 아니라 좌표 간격으로 온다 — 복원하지 않으면 정답 경계가 붙는다', () => {
  /* 실측 사고: 정답 '일상'이 색만 다른 별개 span 이라 '일상속에서'로 붙어 나왔다 */
  const spans = [sp(60, '일상', { w: 18, color: '#ffffff' }), sp(78, '속에서', { w: 27 }),
    sp(108.9, '발견하는', { w: 36 })];
  assert.strictEqual(U.joinSpans(spans), '일상속에서 발견하는');
  /* 간격이 size*0.3 미만이면 붙은 글자다 — 없는 공백을 만들지 않는다 */
  assert.strictEqual(U.joinSpans([sp(60, '바', { w: 9 }), sp(69.5, '다', { w: 9 })]), '바다');
});

t('쪽번호를 식별번호보다 먼저 지운다 — 순서가 바뀌면 쪽번호가 살아남는다', () => {
  assert.strictEqual(U.stripChrome('깊이 사색함. I410-141-25-99-091285995- 2 -'), '깊이 사색함.');
  assert.strictEqual(U.stripChrome('- 3 -'), '');
  assert.strictEqual(U.stripChrome('바람이 분다'), '바람이 분다');
  /* 판면 부속물이 본문 줄에 섞이는 줄이 실측 이해완성 18줄 있었다 */
  assert.ok(!/I410|-\s*2\s*-/.test(U.stripChrome('본문 I410-141-25-99-091285995- 2 -')));
});

t('저작권 고지의 꼬리 문장까지 버린다 — 기존 필터는 이걸 본문으로 흘려보냈다', () => {
  assert.ok(U.isChromeLine('일부터 5년간 보호됩니다. 법적 책임을 질 수 있습니다.'));
  assert.ok(U.isChromeLine('2026-01-15'));
  assert.ok(U.isChromeLine('제작자 : 교육지대(주)'));
  assert.ok(!U.isChromeLine('모래는 조용히 흘러내리고'));
});

t('시리즈는 파일명이 아니라 지면 내용으로 가른다', () => {
  const doc = (txt) => ({ pages: [pg(1, [ln(45, [sp(60, txt)])])] });
  assert.deepStrictEqual(U.detectSeries(doc('[이해완성] 1-1')).series, 'ihae');
  assert.deepStrictEqual(U.detectSeries(doc('[직전 요약노트] 1-1')).series, 'yoyak');
  assert.deepStrictEqual(U.detectSeries(doc('[단원집중] 1-1')).series, 'danwon');
  assert.deepStrictEqual(U.detectSeries(doc('[서술형 공략] 1')).series, 'seosul');
  assert.strictEqual(U.detectSeries(doc('[이해완성] 1-1')).by, 'tag');
  /* 태그가 없으면 색·마커 지문으로 2차 판정하되 confident 를 내린다 */
  const fb = U.detectSeries({ pages: [pg(1, [ln(45, [sp(60, '[정답] ⑤')]), ln(60, [sp(60, '[해설] 그러므로')])])] });
  assert.strictEqual(fb.series, 'danwon');
  assert.strictEqual(fb.confident, false);
  /* 판정이 유일하지 않으면 추측하지 않는다 */
  assert.strictEqual(U.detectSeries(doc('아무 표시 없음')).series, null);
});

t('머리말 띠는 좁아야 한다 — 90으로 자르면 본문 첫 문항이 사라진다', () => {
  /* 실측: 러닝헤더 y 42~46, 첫 문항 번호 y 64.3 */
  assert.ok(U.HEAD_BAND < 64.3, `머리말 띠 ${U.HEAD_BAND} 가 본문을 먹는다`);
  const page = pg(1, [ln(46, [sp(60, '[단원집중] 1-1')]), ln(64.3, [sp(56.6, '2.', { size: 13.7, color: '#191919' })])]);
  const [left] = U.splitColumns(page);
  assert.strictEqual(left.length, 1);
  assert.strictEqual(U.itemMarkers(left).length, 1);
});

t('기둥은 왼쪽 전부 → 오른쪽 전부 순서다 — y로 훑으면 지문 순서가 뒤엉킨다', () => {
  const page = pg(1, [
    ln(130, [sp(60, '(가) 첫 지문'), sp(320, '(다) 셋째 지문')]),
    ln(529, [sp(60, '(나) 둘째 지문')]),
  ]);
  const [left, right] = U.splitColumns(page);
  assert.deepStrictEqual(left.map((l) => U.joinSpans(l.spans)), ['(가) 첫 지문', '(나) 둘째 지문']);
  assert.deepStrictEqual(right.map((l) => U.joinSpans(l.spans)), ['(다) 셋째 지문']);
});

t('안 보이는 색 목록에 #e7f4f6 이 있어야 한다 — 빠져서 실제 빈칸을 놓쳤다', () => {
  assert.ok(U.PALE.includes('#e7f4f6'), '#e7f4f6 누락 시 이해완성에서 은유법·의인법을 놓친다');
  assert.ok(U.isPale({ color: '#e7f4f6' }));
  assert.ok(!U.isPale({ color: '#000000' }));
});

t('흰 글씨라고 다 정답은 아니다 — 연 라벨·마스트헤드·배너를 거른다', () => {
  const page = pg(1, [], 595);
  const decoy = U.makeDecoy(page, 'ihae');
  /* 연 라벨: 오른쪽 초록 박스 안. 표기가 파일마다 다르다 */
  ['1연', '5연~6연', '1~2연'].forEach((label) => {
    assert.ok(decoy({ text: label, size: 8, x: 427, color: '#ffffff' }, 300, label), label);
  });
  /* 같은 글자라도 본문 크기·왼쪽이면 정답 후보다 */
  assert.ok(!decoy({ text: '1연', size: 9.5, x: 60, color: '#ffffff' }, 300, '1연 어쩌고'));
  /* 마스트헤드는 줄 전체를 봐야 걸린다 — 조각('중','2','국어')만 보면 못 거른다 */
  assert.ok(decoy({ text: '2', size: 11, x: 113, color: '#ffffff' }, 69.4, '중 2 국어 1-1.모래시계'));
  /* 머리말·판권 띠 */
  assert.ok(decoy({ text: '아무거나', size: 9, x: 60, color: '#ffffff' }, 40, '아무거나'));
  assert.ok(decoy({ text: '아무거나', size: 9, x: 60, color: '#ffffff' }, 800, '아무거나'));
  /* 요약노트의 안내 배너는 7.4pt 흰 글씨다 */
  assert.ok(U.makeDecoy(page, 'yoyak')({ text: '빈 칸 채우기로 바로 확인', size: 7.4, x: 316.8, color: '#ffffff' }, 66.3, '빈 칸 채우기로 바로 확인'));
});

t('readLine 은 채운 판과 가린 판을 함께 낸다', () => {
  const page = pg(1, [], 595);
  const decoy = U.makeDecoy(page, 'ihae');
  const line = ln(214, [sp(60, '유리 벽에 ', { w: 45 }), sp(105, '침묵', { w: 18, color: '#ffffff' }), sp(123, '이 쌓인다', { w: 40 })]);
  const r = U.readLine(line, { decoy });
  assert.strictEqual(r.full, '유리 벽에 침묵이 쌓인다');
  assert.strictEqual(r.masked, '유리 벽에 □□이 쌓인다');
  assert.deepStrictEqual(r.answers.map((a) => a.text), ['침묵']);
});

t('zb 문항번호는 색이 아니라 크기로 잡는다 — 검정 1pt 인 것이 실제로 있다', () => {
  const lines = [ln(78.2, [
    sp(73.2, 'zb', { size: 1, w: 2, color: '#ffffff' }), sp(75.2, '2)', { size: 0.7, w: 1.4, color: '#ffffff' }),
    sp(328.3, 'zb', { size: 1, w: 2, color: '#000000' }), sp(330.3, '22)', { size: 0.7, w: 1.4, color: '#000000' }),
  ])];
  /* 두 기둥의 zb 가 같은 y라 한 줄로 묶여 온다 — 기둥을 먼저 갈라야 한다 */
  const both = U.itemIds(lines);
  assert.deepStrictEqual(both.map((x) => x.no), [2, 22]);
  assert.strictEqual(both[1].id, 'zb22)');
  /* 지면에 안 보이는 글자다 — 발문에 남으면 학생 화면에 뜬다 */
  assert.strictEqual(U.stripItemIds('zb7) 이 시의 화자는?'), '이 시의 화자는?');
});

t('해설 마커 N) 은 저작권 고지의 1) 과 크기로 갈린다', () => {
  const lines = [
    ln(120, [sp(66.7, '1)', { size: 7.9 }), sp(77.5, '[정답] ⑤')]),
    ln(140, [sp(66.7, '2)', { size: 7.9 }), sp(77.5, '[정답] ③')]),
    ln(800, [sp(124, '1)', { size: 5 }), sp(134, '제작연월일 : 2026-01-21', { size: 5 })]),
  ];
  assert.deepStrictEqual(U.solutionEntries(lines).map((x) => x.no), [1, 2]);
});

t('연 나눔은 라벨 앵커로 한다 — y 간격 추정은 실측 두 파일 모두에서 틀렸다', () => {
  const page = pg(2, [
    ln(300.3, [sp(427.4, '1연', { size: 8, color: '#ffffff' })]),
    ln(377.3, [sp(427.4, '2연', { size: 8, color: '#ffffff' })]),
    ln(633.9, [sp(419.5, '5연~6연', { size: 8, color: '#ffffff' })]),
  ]);
  assert.deepStrictEqual(U.stanzaAnchors(page).map((a) => a.range), ['1연', '2연', '5연~6연']);
  /* '1~2연' 표기도 온다(파일마다 다르다) */
  const p2 = pg(2, [ln(300, [sp(420, '1~2연', { size: 8, color: '#ffffff' })])]);
  assert.deepStrictEqual(U.stanzaAnchors(p2).map((a) => a.range), ['1~2연']);
});

t('연 나눔의 큰 간격은 대개 끼어든 날개풀이다 — 그 높이를 빼야 진짜 연이 보인다', () => {
  /* 실물 이해완성 지면에서 잰 y값. 순진한 간격 추정은 여기서 6연을 5연으로 읽었다. */
  const verses = [300.3, 314, 369.4, 382.9, 458.2, 471.7, 534.1, 561.2, 613, 640.2, 667.3, 693.7].map((y) => ({ y }));
  const notes = [328.7, 397.8, 410.3, 486.4, 549, 575.2, 628, 681.3, 707.4].map((y) => ({ y }));
  const groups = U.stanzaSplit(verses, notes);
  assert.strictEqual(groups.length, 6, '6연이어야 한다 — ' + groups.map((g) => g.length).join('/'));
  assert.deepStrictEqual(groups.map((g) => g.length), [2, 2, 2, 2, 2, 2]);
  /* 날개풀이를 안 빼면 바로 틀린다 — 이게 기존 추출기가 5연으로 읽던 이유다 */
  assert.notStrictEqual(U.stanzaSplit(verses, []).length, 6);
  /* 같은 27.1pt라도 사이에 날개풀이가 있으면 같은 연(4연), 없으면 연 나눔(5연/6연 경계) */
  const g4 = groups[3].map((v) => v.y), g5 = groups[4].map((v) => v.y);
  assert.deepStrictEqual(g4, [534.1, 561.2], '날개풀이가 낀 27.1pt는 연 안이다');
  assert.deepStrictEqual(g5, [613, 640.2], '아무것도 없는 27.1pt는 연 나눔이다');

  /* 이해완성 두 번째 자료의 실측 y — 행 수가 연마다 다른 시다 */
  const vB = [321.4, 334.9, 361.3, 409.3, 436.4, 463.5, 477, 523, 536.5, 563.6, 624.6, 638.2, 678.8].map((y) => ({ y }));
  const nB = [348.9, 375.3, 424.2, 451.1, 491.7, 551.4, 577.6, 589.6, 653, 692.8].map((y) => ({ y }));
  assert.deepStrictEqual(U.stanzaSplit(vB, nB).map((g) => g.length), [3, 4, 3, 2, 1]);

  assert.deepStrictEqual(U.stanzaSplit([], []), []);
});

t('빈칸 id 는 팩 전역 유일이어야 한다 — 파일마다 001부터 세면 배포가 막힌다', () => {
  assert.strictEqual(U.blankId('w-a', 'ihae', 1), 'w-a:bl-001');
  assert.strictEqual(U.blankId('w-a', 'yoyak', 1), 'w-a:sum-001');
  /* 같은 작품·다른 시리즈, 같은 번호라도 안 부딪힌다 */
  assert.notStrictEqual(U.blankId('w-a', 'ihae', 1), U.blankId('w-a', 'yoyak', 1));
  /* 다른 작품끼리도 안 부딪힌다 */
  assert.notStrictEqual(U.blankId('w-a', 'ihae', 1), U.blankId('w-b', 'ihae', 1));
  /* 문항 id 도 시리즈끼리 부딪히면 안 된다 — zb 번호는 파일 안에서만 유일하다 */
  assert.notStrictEqual(U.itemId('danwon', 'w-a', 7), U.itemId('seosul', 'w-a', 7));
});

t('stem 만 HTML 이다 — 꺾쇠를 안 막으면 <보기>가 화면에서 사라진다', () => {
  assert.strictEqual(U.escapeStem('<보기>를 바탕으로'), '&lt;보기&gt;를 바탕으로');
  assert.strictEqual(U.escapeStem('a & b'), 'a &amp; b');
});

t('좌우 거울 지면의 대조는 완전 일치가 아니라 문턱이다', () => {
  assert.strictEqual(U.similarity('가나다', '가나다'), 1);
  assert.ok(U.similarity('가나다라마바사아자차', '가나다라마바사아자카') >= 0.9);
  assert.ok(U.similarity('가나다', '마바사') < 0.5);
  assert.strictEqual(U.similarity('', ''), 1);
});

t('절 경계는 마스트헤드 한 신호로 잡는다', () => {
  const doc = { pages: [
    pg(1, [ln(69.4, [sp(102, '중2 국어 1-1.(1)모래시계')])]),
    pg(2, [ln(42, [sp(60, '1-1.(1)모래시계')])]),
    pg(3, [ln(69.4, [sp(102, '중2 국어 1-1.(2)돌의 노래')])]),
  ] };
  assert.deepStrictEqual(U.sectionStarts(doc), [1, 3]);
});

t('머리말 메타는 마스트헤드와 단원 코드가 한 줄에 와도 둘 다 읽는다', () => {
  const doc = { pages: [
    pg(1, [ln(46.5, [sp(194, '천재(노미숙)2-1')]), ln(65.4, [sp(102, '중2 국어 1.문학을 펼치면(01)')])]),
  ] };
  const m = U.headerMeta(doc);
  assert.strictEqual(m.publisher, '천재');
  assert.strictEqual(m.publisherAuthor, '노미숙');
  assert.strictEqual(m.grade, '중2');
  assert.strictEqual(m.semester, '1');
  assert.strictEqual(m.unit, '1');
  assert.strictEqual(m.unitTitle, '문학을 펼치면(01)');
  /* 작품 코드 '1-1.(1)모래시계' 는 작품명으로 읽힌다 */
  const w = U.headerMeta({ pages: [pg(1, [ln(69.4, [sp(102, '중2 국어 1-1.(1)모래시계')])])] });
  assert.strictEqual(w.workTitle, '모래시계');
  assert.strictEqual(w.subUnit, '1-1');
});

console.log(`\nOK — ${passed}개 통과. 상수는 전부 실측값이다 — 새 출판사 자료가 오면 --colors 를 먼저 돌린다.`);
