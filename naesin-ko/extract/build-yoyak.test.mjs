/* 직전 요약노트 추출기 (node naesin-ko/extract/build-yoyak.test.mjs)
 *
 * 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1). 그래서 **지면의 성질만
 * 베낀** 가상 시 두 편을 여기서 직접 지어 spans 구조로 만든다. 지키는 성질:
 *   ① 한 파일에 작품이 여러 편이고 **짝 지면(학생용/선생님용)이 아니다**
 *   ② 좌우 거울이다 — 왼쪽은 정답이 채워진 판, 오른쪽은 정답만 흰 글씨(dx = +252)
 *   ③ 흰 글씨라고 다 정답은 아니다 (size 7.4 장식 라벨이 절마다 하나씩 있다)
 *   ④ 표 라벨은 행 박스의 **세로 가운데**에 온다 — 행 높이가 제각각이다
 *   ⑤ 정답이 줄바꿈으로 쪼개진다 (오른끝에서 끊기고 다음 줄 첫 글자로 이어진다)
 *   ⑥ '・'가 기둥 왼끝에 있으면 표 밖 단락, 값셀 안에 있으면 표 행 안쪽이다
 *   ⑦ 어휘 뜻풀이도 세로 가운데 정렬이라 첫 줄이 표제어보다 위에 온다
 *   ⑧ 판면 부속물이 본문 줄에 섞여 들어온다
 * ①③④⑤⑥⑦ 은 실제 지면에서 초안을 망가뜨렸던 것들이다 — 회귀로 못 박는다. */
import assert from 'node:assert';
import { buildYoyak } from './build-yoyak.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const BLACK = '#000000', WHITE = '#ffffff', RED = '#b51010', GOLD = '#e9ae2b',
  HEADRED = '#bf0000', PINK = '#d90909', BLUE = '#215ab9';
const DX = 252;                 // 좌 → 우 오프셋 (실측 252.0 정확히 일정)
const CH = 7.5;                 // 글자 하나 폭 — 실측 7.9pt 글꼴에 맞춘 가상값
const LCOL = 64.6, LVAL = 116.2, LLAB = 83.0;   // 왼쪽 기둥 왼끝 / 값셀 / 라벨셀
const sp = (x, text, o = {}) => ({ x, w: o.w == null ? text.length * CH : o.w,
  size: o.size == null ? 7.9 : o.size, color: o.color || BLACK, text });

/* 셀 안 span 을 x 를 이어 붙여 놓는다 — joinSpans 가 없는 공백을 만들지 않게.
   parts: '글자' 또는 ['글자','ans'](정답). ans 는 오른쪽 기둥에서만 흰 글씨가 된다. */
function cell(x0, parts, right) {
  let x = x0;
  return parts.map((p) => {
    const [text, kind] = Array.isArray(p) ? p : [p];
    const s = sp(x, text, { color: right && kind === 'ans' ? WHITE : BLACK });
    x += text.length * CH;
    return s;
  });
}
/* 표 행 한 줄 — 좌우 거울로 함께 만든다 */
const tableLine = (y, label, parts, o = {}) => ({ y, spans: [
  ...(label ? [sp(o.labelX || LLAB, label)] : []), ...cell(LVAL, parts, false),
  ...(label ? [sp((o.labelX || LLAB) + DX, label)] : []), ...cell(LVAL + DX, parts, true),
] });
/* 표 밖 단락 한 줄 (기둥 왼끝의 마커 + 전폭 본문) */
const paraLine = (y, marker, text, parts) => ({ y, spans: [
  ...(marker ? [sp(LCOL, marker)] : []), ...cell(LCOL + (marker ? marker.length * CH : 0) + 2, parts, false),
  ...(marker ? [sp(LCOL + DX, marker)] : []), ...cell(LCOL + DX + (marker ? marker.length * CH : 0) + 2, parts, true),
] });
/* 절머리 — 왼쪽엔 제목, 오른쪽 같은 자리엔 흰 장식 라벨(정답이 아니다) */
const sectionLine = (y, name, o = {}) => ({ y, spans: [
  sp(o.x || LCOL, name, { color: o.color || BLACK, size: o.size || 7.9 }),
  sp(LCOL + DX, '빈 칸 채우기로 바로 확인', { size: 7.4, color: WHITE, w: 89.8 }),
] });
const starLine = (y, stars, title) => ({ y, spans: [
  sp(LCOL, stars, { color: GOLD }), sp(LCOL + stars.length * CH, title),
  sp(LCOL + DX, stars, { color: GOLD }), sp(LCOL + DX + stars.length * CH, title),
] });
const CHROME = [
  { y: 783.7, spans: [sp(351.8, 'I410-141-25-99-091285995', { size: 6 })] },
  { y: 790.2, spans: [sp(516.2, '- n -', { size: 9.1 })] },
  { y: 795.5, spans: [sp(123.8, '   일부터 5년간 보호됩니다.', { size: 5 })] },
];
const head = (key) => [
  { y: 44.3, spans: [sp(207.6, '천재(노미숙)', { size: 9.1 })] },
  { y: 66.8, spans: [sp(304.6, key, { size: 10.1 })] },
  { y: 75.6, spans: [sp(102, '중', { size: 10.1 }), sp(113.3, '2', { size: 11 }), sp(148.3, '국어', { size: 11 })] },
];
const summaryHead = (key) => ({ y: 39.6, spans: [sp(412.3, '[직전 요약노트] ' + key, { size: 7.9 })] });
const banner = { y: 66.3, spans: [sp(184.8, '핵심 요약', { size: 7, color: RED }), sp(216.2, '으로 빠르게 정리하고', { size: 7 }),
  sp(372.2, '반으로 접어 ', { size: 7 }), sp(414, '빈 칸 채우기', { size: 7, color: RED }), sp(456, '로 최종 실력 점검하세요!', { size: 7 })] };

/* ── 쪽 1·4: 체크리스트 쪽 (1단, 흰 글씨 0개) ── */
function checklistPage(no, key, terms) {
  const lines = head(key).concat([
    { y: 111.6, spans: [sp(79.4, '파이널 체크리스트', { size: 10.1, color: HEADRED })] },
    { y: 127.5, spans: [sp(83.3, '시험 직전 마지막 체크!', { size: 8.6, color: PINK })] },
    { y: 159.2, spans: [sp(73, '작품에 쓰인 표현의 효과를 이해하였는가?', { size: 9 })] },
    { y: 173.8, spans: [sp(56.6, '   ☐ 은유가 무엇인지 말할 수 있다.', { size: 9 })] },
    { y: 187.5, spans: [sp(56.6, '   ☐ 대조가 쓰인 부분을 찾을 수 있다.', { size: 9 })] },
    { y: 234.8, spans: [sp(73, '화자의 정서 변화를 알고 있는가?', { size: 9 })] },
    { y: 249.4, spans: [sp(56.6, '   ☐ 화자가 처한 상황을 말할 수 있다.', { size: 9 })] },
    { y: 509.5, spans: [sp(79.4, '어휘 체크리스트', { size: 9.6, color: HEADRED })] },
    { y: 529.5, spans: [sp(79.4, '문해력의 바탕은 어휘력!', { size: 8.6, color: PINK })] },
  ]);
  /* 첫 어휘는 뜻풀이가 두 줄이라 **첫 줄이 표제어보다 위에 온다**(세로 가운데 정렬) */
  lines.push(
    { y: 555.9, spans: [sp(138.7, '명', { size: 6.5, color: BLUE }), sp(149.8, terms[0][1], { size: 9 })] },
    { y: 563.1, spans: [sp(61.7, '☐ ' + terms[0][0], { size: 9 })] },
    { y: 570.3, spans: [sp(155.3, terms[0][2], { size: 9 })] },
    { y: 589.3, spans: [sp(61.7, '☐ ' + terms[1][0], { size: 9 }), sp(138.7, '명', { size: 6.5, color: BLUE }),
      sp(149.3, terms[1][1], { size: 9 })] },
  );
  return { no, width: 595.2, height: 841.9, lines: lines.concat(CHROME) };
}

/* ── 쪽 2: 개관 + 구성 (작품 A) ── */
const pageA1 = { no: 2, width: 595.2, height: 841.9, lines: [
  summaryHead('1-1.(1)모래시계'), banner,
  sectionLine(79.9, '개관'),
  tableLine(110, '갈래', [['자유', 'ans'], '시, 서정시']),
  tableLine(126, '제재', ['유리와 ', ['모래', 'ans']]),
  /* 주제는 두 줄인데 **라벨이 두 줄 사이**에 온다 — y 간격으로 가르면 특징 행이 딸려 온다 */
  tableLine(142, null, ['흘러가는 시간 속에서 ', ['자신', 'ans']]),
  { y: 148.5, spans: [sp(LLAB, '주제'), sp(LLAB + DX, '주제')] },
  tableLine(155, null, ['을 돌아보는 ', ['성찰', 'ans']]),
  /* 특징은 네 줄짜리 한 행이고 라벨이 가운데 줄에 온다 */
  tableLine(171, null, ['① 반복되는 시어로 ', ['운율', 'ans'], '을 형성함.']),
  tableLine(183, null, ['② 시간의 흐름을 ', ['대조', 'ans']]),
  { y: 189, spans: [sp(LLAB, '특징'), sp(LLAB + DX, '특징')] },
  tableLine(195, null, ['적으로 제시함.']),
  tableLine(207, null, ['③ 감각적 ', ['이미지', 'ans'], '를 사용함.']),
  sectionLine(250, '구성'),
  tableLine(274, null, ['모래가 떨어지는 모습을 ', ['관찰', 'ans']]),
  { y: 280, spans: [sp(86.4, '1연'), sp(86.4 + DX, '1연')] },
  tableLine(286, null, ['하며 하루를 연다.']),
  tableLine(305, '2연', ['지나온 날들을 ', ['사색', 'ans'], '한다.']),
  paraLine(325, '⇨ ', null, ['관찰 → ', ['사색', 'ans'], '의 구조로 전개됨.']),
  ...CHROME,
] };

/* ── 쪽 3: 출제 Point ② (작품 A) — 시어 표·인용 시구·줄바꿈 정답 ── */
const WRAP_L = 20.0;   // 값셀 오른끝 부근에서 끊기는 정답의 왼쪽 기둥 x (우 = +252)
const pageA2 = { no: 3, width: 595.2, height: 841.9, lines: [
  summaryHead('1-1.(1)모래시계'), banner,
  { y: 80.2, spans: [sp(LCOL + DX, '빈 칸 채우기로 바로 확인', { size: 7.4, color: WHITE, w: 89.8 })] },
  { y: 83.8, spans: [sp(76.6, '출제 Point ②', { color: RED })] },
  starLine(92.7, '★★★ ', '시어의 의미 파악하기'),
  paraLine(104.7, null, null, ['(1) 시어의 상징적 의미']),
  tableLine(124.6, '모래', ['흘러가는 ', ['시간', 'ans'], '.'], { labelX: 81.6 }),
  tableLine(145.5, '유리벽', ['시간을 가두는 ', ['한계', 'ans'], '.'], { labelX: 77.5 }),
  /* 인용 시구 박스는 기둥 왼끝 +4.3 에서 값셀을 가로질러 뻗는다. 두 줄짜리 박스다. */
  { y: 165, spans: [sp(68.9, '  모래는 조용히 흘러내리고', { w: 197 }), sp(68.9 + DX, '  모래는 조용히 흘러내리고', { w: 197 })] },
  { y: 177, spans: [sp(68.9, '  유리 벽에 침묵이 쌓인다', { w: 190 }), sp(68.9 + DX, '  유리 벽에 침묵이 쌓인다', { w: 190 })] },
  paraLine(190, '⇨ ', null, ['시간의 ', ['흐름', 'ans'], '을 감각으로 보여 줌.']),
  /* 기둥 왼끝의 '・' = 표 밖 단락 */
  paraLine(205, '・', null, ['일상의 반복 속에 ', ['성찰', 'ans'], '이 있음.']),
  paraLine(215, null, null, ['(2) 시간의 흔적']),
  /* 값셀 안의 '・' = 표 행 안쪽 (같은 글자인데 자리가 다르다) */
  tableLine(225, null, ['・쌓이는 ', ['흔적', 'ans'], '을 뜻함.']),
  { y: 231, spans: [sp(81.6, '시간'), sp(81.6 + DX, '시간')] },
  tableLine(237, null, ['・되돌릴 수 없음을 뜻함.']),
  /* 정답이 값셀 오른끝에서 끊겨 다음 줄로 이어진다 — 안 이으면 '상','처'가 모범답안이 된다 */
  { y: 258, spans: [
    sp(LVAL, '부모님의 손끝에 남은 자국을 오래 보며 ', { w: WRAP_L * CH }), sp(LVAL + WRAP_L * CH, '상'),
    sp(LVAL + DX, '부모님의 손끝에 남은 자국을 오래 보며 ', { w: WRAP_L * CH }),
    sp(LVAL + DX + WRAP_L * CH, '상', { color: WHITE }),
  ] },
  { y: 264, spans: [sp(81.6, '흔적'), sp(81.6 + DX, '흔적')] },
  { y: 270, spans: [...cell(LVAL, [['처', 'ans'], '를 헤아린다.'], false),
    ...cell(LVAL + DX, [['처', 'ans'], '를 헤아린다.'], true)] },
  /* 반례 — 오른끝에서 끝난 정답이라도 다음 줄 첫 글자가 검정이면 이으면 안 된다 */
  { y: 290, spans: [
    sp(LVAL, '유리 안쪽에 조용히 내려앉은 것은 결국 ', { w: WRAP_L * CH }), sp(LVAL + WRAP_L * CH, '시간'),
    sp(LVAL + DX, '유리 안쪽에 조용히 내려앉은 것은 결국 ', { w: WRAP_L * CH }),
    sp(LVAL + DX + WRAP_L * CH, '시간', { color: WHITE }),
  ] },
  { y: 296, spans: [sp(81.6, '유리'), sp(81.6 + DX, '유리')] },
  { y: 302, spans: [...cell(LVAL, ['이다.'], false), ...cell(LVAL + DX, ['이다.'], true)] },
  /* 판면 부속물이 본문 줄 끝에 섞여 들어온다 */
  paraLine(320, '・', null, ['모래는 ', ['시간', 'ans'], '의 은유임. I410-141-25-99-091285995- 3 -']),
  ...CHROME,
] };

/* ── 쪽 5·6: 작품 B — 앞 작품보다 흰 글씨가 적다(짝 지면 판정식의 함정) ── */
const pageB1 = { no: 5, width: 595.2, height: 841.9, lines: [
  summaryHead('1-1.(2)파도에게'), banner,
  sectionLine(79.9, '개관'),
  tableLine(110, '갈래', [['자유', 'ans'], '시, 서정시']),
  tableLine(126, '제재', ['파도']),
  tableLine(142, '주제', ['되풀이되는 ', ['시련', 'ans'], '을 견디는 마음']),
  ...CHROME,
] };
/* p6 은 왼쪽에만 마침표가 빠져 있다 — 원문 오탈자를 흉내낸 것이라 게이트가 걸려야 한다 */
const pageB2 = { no: 6, width: 595.2, height: 841.9, lines: [
  summaryHead('1-1.(2)파도에게'), banner,
  { y: 80.2, spans: [sp(LCOL + DX, '빈 칸 채우기로 바로 확인', { size: 7.4, color: WHITE, w: 89.8 })] },
  { y: 83.8, spans: [sp(76.6, '출제 Point ③', { color: RED })] },
  starLine(92.7, '★★ ', '표현 방식 파악하기'),
  { y: 110, spans: [sp(LCOL, '・'), ...cell(LCOL + CH + 2, ['의인법 : 파도를 사람처럼 말하게 함'], false),
    sp(LCOL + DX, '・'), ...cell(LCOL + DX + CH + 2, ['의인법 : 파도를 사람처럼 말하게 함.'], true)] },
  paraLine(130, '・', null, ['반복 : ‘온다’를 되풀이해 ', ['운율', 'ans'], '을 만듦.']),
  ...CHROME,
] };

const doc = { file: 'fixture.pdf', pages: [
  checklistPage(1, '1-1.(1)모래시계', [['은유', '사물의 상태를 암시적으로 나타내는', '수사법.'], ['대조', '둘을 맞대어 견줌.']]),
  pageA1, pageA2,
  checklistPage(4, '1-1.(2)파도에게', [['시련', '겪기 어려운 단련이나', '고비.'], ['여운', '남아 있는 운치.']]),
  pageB1, pageB2,
] };

const IDS = { '1-1.(1)모래시계': 'w-moraesigye', '1-1.(2)파도에게': 'w-padoege' };
const out = buildYoyak(doc, { workIds: IDS });
const [A, B] = out.patches;
const ansOf = (p) => p.blanks.map((b) => b.answers[0]);

t('한 파일의 작품을 다 읽는다 — 짝 지면(학생용/선생님용)으로 착각하면 뒤 작품이 통째로 사라진다', () => {
  assert.strictEqual(out.patches.length, 2, '작품 2편이어야 한다: ' + out.patches.map((p) => p.workKey));
  assert.deepStrictEqual(out.patches.map((p) => p.workKey), ['1-1.(1)모래시계', '1-1.(2)파도에게']);
  assert.deepStrictEqual(out.patches.map((p) => p.title), ['모래시계', '파도에게']);
  /* 뒤 작품에 흰 글씨가 더 적다 — build-ihae 의 짝 판정식이 여기서 paired=true 로 잘못 켜진다 */
  assert.ok(A.blanks.length > B.blanks.length);
  assert.ok(B.blanks.length >= 3, '뒤 작품의 빈칸이 버려졌습니다: ' + JSON.stringify(ansOf(B)));
  assert.ok(ansOf(B).includes('운율'), '작품 B 마지막 쪽이 통째로 빠졌습니다: ' + ansOf(B).join(','));
});

t('완전한 Work 가 아니라 덧붙일 조각이다 — 같은 workId 로 Work 를 두 번 내면 배포가 막힌다', () => {
  out.patches.forEach((p) => {
    assert.strictEqual(p.workId, undefined);
    assert.strictEqual(p.text, undefined);
    assert.strictEqual(p.hasCanon, undefined);
    assert.ok(p.workKey, '작품을 잇는 조인 키가 없습니다');
  });
  /* 이 시리즈에는 인쇄된 문항도 지문 세트도 없다 */
  assert.deepStrictEqual(out.items, []);
  assert.deepStrictEqual(out.sets, []);
});

t('빈칸은 흰 글씨 전부가 아니라 정답만이다 — 절마다 있는 장식 라벨은 걸러진다', () => {
  ['자유', '모래', '자신', '성찰', '운율', '대조', '이미지', '관찰', '사색'].forEach((a) => {
    assert.ok(ansOf(A).includes(a), `빈칸 정답에 '${a}'가 없습니다: ${ansOf(A).join(',')}`);
  });
  assert.ok(!ansOf(A).some((a) => /빈 칸 채우기/.test(a)), '장식 라벨이 빈칸으로 잡혔습니다');
  assert.ok(!JSON.stringify(A.blanks).includes('빈 칸 채우기로 바로 확인'), '장식 라벨이 문맥에 남았습니다');
});

t('표 라벨은 행의 세로 가운데에 온다 — y 간격으로 가르면 주제 행이 특징 행을 삼킨다', () => {
  const theme = A.blanks.filter((b) => b.path === 'overview.주제');
  assert.deepStrictEqual(theme.map((b) => b.answers[0]), ['자신', '성찰']);
  assert.strictEqual(theme[0].text, '흘러가는 시간 속에서 □□을 돌아보는 □□');
  const feat = A.blanks.filter((b) => b.path === 'overview.특징');
  assert.deepStrictEqual(feat.map((b) => b.answers[0]), ['운율', '대조', '이미지']);
  assert.ok(/^① 반복되는/.test(feat[0].text), feat[0].text);
  assert.ok(!/흘러가는 시간/.test(feat[0].text), '주제 행이 특징 행에 섞였습니다: ' + feat[0].text);
});

t('빈칸 path 는 이해완성과 같은 어휘를 쓴다 — 다르면 §2.2-2 중복 병합 경고가 영영 안 뜬다', () => {
  const paths = new Set(A.blanks.map((b) => b.path));
  ['overview.갈래', 'overview.제재', 'overview.주제', 'overview.특징'].forEach((p) => {
    assert.ok(paths.has(p), `${p} 가 없습니다: ${[...paths].join(' ')}`);
  });
  /* 구성은 이해완성처럼 **행 번호**로 센다 — 라벨('1연')로 매기면 서로 안 맞는다 */
  const comp = A.blanks.filter((b) => b.path.startsWith('composition.'));
  assert.deepStrictEqual(comp.map((b) => b.path), ['composition.1', 'composition.2', 'composition.p1']);
  assert.deepStrictEqual(comp.map((b) => b.label), ['1연', '2연', '구성']);
});

t('빈칸 id 는 작품 이름을 달고 나온다 — 파일마다 001부터 세면 팩 전역에서 부딪힌다', () => {
  A.blanks.forEach((b) => assert.ok(b.id.startsWith('w-moraesigye:sum-'), b.id));
  const ids = out.patches.flatMap((p) => p.blanks.map((b) => b.id))
    .concat(out.patches.flatMap((p) => p.vocab.map((v) => v.id)));
  assert.strictEqual(new Set(ids).size, ids.length, 'id 가 겹칩니다');
  /* 이해완성이 같은 작품에 붙이는 bl- 과도 안 부딪힌다 */
  assert.ok(!ids.some((id) => /:bl-/.test(id)));
  /* workId 를 모르면 id 대신 localNo 만 담고 붙이는 법을 검수 할 일로 남긴다 */
  const bare = buildYoyak(doc, {});
  assert.strictEqual(bare.patches[0].blanks[0].id, undefined);
  assert.strictEqual(bare.patches[0].blanks[0].localNo, 1);
  assert.strictEqual(bare.patches[0].blanks[0].series, 'yoyak');
  assert.ok(bare.review.todo.some((x) => /workId 가 없다/.test(x)), bare.review.todo.join(' | '));
});

t('줄바꿈으로 쪼개진 정답을 잇는다 — 안 이으면 한 글자가 모범답안이 된다', () => {
  assert.ok(ansOf(A).includes('상처'), `'상처'가 '상','처'로 쪼개졌습니다: ${ansOf(A).join(',')}`);
  assert.ok(!ansOf(A).includes('상') && !ansOf(A).includes('처'));
  const b = A.blanks.find((x) => x.answers[0] === '상처');
  assert.ok(/□□를 헤아린다\.$/.test(b.text), b.text);
  /* 반례 — 오른끝에서 끝났어도 다음 줄 첫 글자가 검정이면 이으면 안 된다 */
  assert.ok(ansOf(A).includes('시간'), ansOf(A).join(','));
  assert.ok(!ansOf(A).some((a) => /^시간이다/.test(a)), '이으면 안 되는 것을 이었습니다: ' + ansOf(A).join(','));
});

t('‘・’는 자리로 갈린다 — 기둥 왼끝이면 표 밖 단락, 값셀 안이면 표 행 안쪽이다', () => {
  const para = A.blanks.find((b) => b.answers[0] === '성찰' && b.path.startsWith('point.'));
  assert.ok(para, '기둥 왼끝 ・ 단락을 못 찾았습니다');
  assert.ok(/^\.p\d+$/.test(para.path.slice(para.path.indexOf('.', 6))), para.path);
  const row = A.blanks.find((b) => b.answers[0] === '흔적');
  assert.strictEqual(row.label, '시간', '값셀 안 ・가 단락으로 잘못 갈렸습니다: ' + JSON.stringify(row));
  /* 표 행이라 그 행의 두 줄이 한 문맥으로 붙는다 */
  assert.ok(/되돌릴 수 없음/.test(row.text), row.text);
});

t('판면 부속물은 정본에도 문맥에도 남지 않는다', () => {
  const dump = JSON.stringify(out.patches);
  assert.ok(!/I410|091285995/.test(dump), '자료 식별번호가 남았습니다');
  assert.ok(!/보호됩니다/.test(dump), '저작권 고지가 본문으로 샜습니다');
  assert.ok(!/- 3 -/.test(dump), '쪽번호가 남았습니다');
  assert.ok(ansOf(A).filter((a) => a === '시간').length >= 1);
});

t('좌우 거울이 짝 지면을 대신한다 — 어긋난 단위만 사람에게 넘긴다', () => {
  const clean = out.mirrors.filter((m) => m.page !== 6);
  clean.forEach((m) => assert.strictEqual(m.bad, 0, `p${m.page} 가 왜 어긋났나: ${m.min}`));
  const p6 = out.mirrors.find((m) => m.page === 6);
  assert.strictEqual(p6.bad, 1, '마침표 한 자 차이를 못 잡았습니다');
  const pend = out.review.pending.find((p) => p.page === 6 && p.left);
  assert.ok(pend.left && pend.right && pend.left !== pend.right, JSON.stringify(pend));
  assert.ok(pend.similarity < 0.99 && pend.similarity > 0.9, '문턱이 너무 헐겁거나 빡빡합니다: ' + pend.similarity);
  /* 왼쪽은 답 출처가 아니다 — 대조용 값은 check 안에만 둔다 */
  assert.strictEqual(A.overview, undefined);
  assert.deepStrictEqual(A.check.overview.genre, ['자유시', '서정시']);
  assert.strictEqual(A.check.overview.theme, '흘러가는 시간 속에서 자신을 돌아보는 성찰');
  assert.strictEqual(A.check.overview.features.length, 3);
  assert.deepStrictEqual(A.check.composition.map((c) => c.range), ['1연', '2연']);
  assert.strictEqual(A.check.composition[0].summary, '모래가 떨어지는 모습을 관찰하며 하루를 연다.');
});

t('어휘 뜻풀이도 세로 가운데 정렬이다 — 순진하게 읽으면 앞 어휘에 붙는다', () => {
  assert.deepStrictEqual(A.vocab.map((v) => v.term), ['은유', '대조']);
  assert.strictEqual(A.vocab[0].definition, '사물의 상태를 암시적으로 나타내는수사법.');
  assert.strictEqual(A.vocab[0].pos, '명');
  assert.strictEqual(A.vocab[1].definition, '둘을 맞대어 견줌.', '뜻풀이가 앞 어휘로 밀렸습니다');
  assert.strictEqual(A.vocab[0].id, 'v-w-moraesigye-001');
});

t('체크리스트 항목은 직전 그룹 질문에 붙는다', () => {
  assert.strictEqual(A.checklist.length, 2);
  assert.strictEqual(A.checklist[0].question, '작품에 쓰인 표현의 효과를 이해하였는가?');
  assert.strictEqual(A.checklist[0].items.length, 2);
  assert.strictEqual(A.checklist[0].items[0], '은유가 무엇인지 말할 수 있다.');
  assert.strictEqual(A.checklist[1].items.length, 1);
  /* 뽑기는 하지만 지금 앱이 아무 데서도 안 읽는다 — 검수자가 먼저 알아야 한다 */
  assert.ok(out.review.todo.some((x) => /앱이 어디서도 읽지 않는다/.test(x)), out.review.todo.join(' | '));
});

t('★ 출제 Point 는 왼쪽 기둥에서 한 번만 읽고, 절머리 바 밖에 있어도 소속을 찾는다', () => {
  assert.deepStrictEqual(A.examPoints, [{ point: '②', stars: 3, title: '시어의 의미 파악하기', page: 3 }]);
  assert.deepStrictEqual(B.examPoints, [{ point: '③', stars: 2, title: '표현 방식 파악하기', page: 6 }]);
});

t('검수 부속물은 조각에 섞이지 않는다 — 섞이면 병합기가 팩 루트로 복사해 학생에게 배달한다', () => {
  const dump = JSON.stringify(out.patches);
  assert.ok(!/candidates|_report|_todo|pending/.test(dump), '검수 부속물이 조각에 섞였습니다');
  out.patches.forEach((p) => { assert.strictEqual(p.keywords, undefined); assert.strictEqual(p.rhetoric, undefined); });
  /* 대신 review 의 별도 자리에 있다 — 시어 표는 후보로만, 인용 시구도 후보로만 */
  const kw = out.review.candidates.filter((c) => c.kind === 'keyword');
  assert.deepStrictEqual(kw.map((c) => c.word), ['모래', '유리벽']);
  const quotes = out.review.candidates.filter((c) => c.kind === 'quote');
  assert.strictEqual(quotes.length, 1, '두 줄짜리 인용 박스는 한 덩어리여야 합니다: ' + JSON.stringify(quotes));
  assert.ok(/모래는 조용히 흘러내리고유리 벽에 침묵이 쌓인다/.test(quotes[0].text), quotes[0].text);
  assert.ok(!dump.includes('모래는 조용히 흘러내리고'), '인용 시구가 조각에 들어갔습니다');
});

t('머리말에서 교과서 좌표를 읽어 둔다 — 여러 자료를 합칠 때 서로를 채운다', () => {
  assert.strictEqual(out.meta.publisher, '천재');
  assert.strictEqual(out.meta.grade, '중2');
  assert.strictEqual(out.meta.subUnit, '1-1');
  assert.ok(out.review.report.some((r) => /작품 2편/.test(r)), out.review.report.join(' | '));
  assert.ok(out.review.todo.some((x) => /author/.test(x)));
});

console.log(`\nOK — ${passed}개 통과. 초안은 초안이다 — 검수 게이트(§7[3])는 건너뛰지 않는다.`);
