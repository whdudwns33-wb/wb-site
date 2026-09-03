/* 이해완성 추출기 (node naesin-ko/extract/build-ihae.test.mjs)
 *
 * 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1). 그래서 **지면의 성질만
 * 베낀** 가상 시를 여기서 직접 지어 spans 구조로 만든다. 지키는 성질:
 *   ① 정답은 흰 글씨로 지면에 이미 있다 (학생용)
 *   ② 같은 지면이 뒤쪽에 선생님용으로 한 번 더 있다 — 학생용 절만 읽는다
 *   ③ 시행 사이의 큰 간격은 대개 끼어든 날개풀이다 (연 나눔이 아니다)
 *   ④ 판면 부속물이 본문 줄 끝에 섞여 들어온다
 *   ⑤ 빈칸 id 는 팩 전역 유일이어야 한다
 *   ⑥ 검수 부속물은 정본 파일에 섞이면 안 된다
 * ③~⑥ 은 실제 지면에서 초안을 망가뜨렸던 것들이다 — 회귀로 못 박는다. */
import assert from 'node:assert';
import { buildIhae } from './build-ihae.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const BLACK = '#000000', WHITE = '#ffffff', NOTE = '#2b5686';
const sp = (x, text, o = {}) => ({ x, w: o.w == null ? text.length * 9 : o.w, size: o.size == null ? 9.5 : o.size, color: o.color || BLACK, text });
const ln = (y, spans) => ({ y, spans });
const pg = (no, lines) => ({ no, width: 595, height: 842, lines });

/* 한 벌(3쪽). ans = 빈칸 정답 색 — 학생용은 흰색, 선생님용은 검정.
   연 라벨은 두 쪽 모두 흰색이다(정답이 아니다). */
function half(ans, from) {
  return [
    /* 표지 — 마스트헤드가 절의 시작을 알린다. 구조도라 추출하지 않는다. */
    pg(from + 1, [ln(69.4, [sp(102, '중2 국어 1-1.(1)모래시계', { size: 11 })]), ln(200, [sp(60, '구조도')])]),
    pg(from + 2, [
      ln(46, [sp(60, '1-1.(1)모래시계', { size: 7.9 })]),
      ln(95.8, [sp(40, '갈래'), sp(120, '자유', { color: ans, w: 18 }), sp(138, '시, 서정시')]),
      ln(113.6, [sp(40, '제재'), sp(120, '모래시계')]),
      ln(131.6, [sp(40, '성격'), sp(120, '성찰적, 상징적')]),
      ln(149.6, [sp(40, '주제'), sp(120, '시간', { color: ans, w: 18 }), sp(138, '의 흐름 속에서 자신을 돌아봄')]),
      ln(165.2, [sp(40, '특징'), sp(120, '① 반복되는 시어로 운율을 형성함.')]),
      ln(180.3, [sp(120, '② 시간의 흐름을 '), sp(230, '대조', { color: ans, w: 18 }), sp(248, '적으로 제시함.')]),
      /* 본문 — 연 라벨은 오른쪽 초록 박스 안 흰 글씨(두 쪽 모두 흰색이라 정답이 아니다) */
      ln(300.3, [sp(60, '모래는 조용히 흘러내리고'),
        sp(427.4, '1연', { size: 8, color: WHITE, w: 16 }),
        sp(450, '모래가 떨어지는 모습을 '), sp(520, '관찰', { color: ans, w: 18 }), sp(538, '함.')]),
      ln(314, [sp(60, '유리 벽에 '), sp(105, '침묵', { color: ans, w: 18 }), sp(123, '이 쌓인다')]),
      ln(328.7, [sp(60, '쌓인다: 겹겹이 포개지다.', { color: NOTE, size: 8 })]),
      /* 여기서 연이 바뀐다 — 사이에 아무것도 없는 큰 간격 */
      ln(369.4, [sp(60, '나는 그 앞에 오래 앉아'),
        sp(427.4, '2연', { size: 8, color: WHITE, w: 16 }),
        sp(450, '지나온 시간을')]),
      /* 같은 연 안이지만 날개풀이가 끼어 간격이 두 배가 된다 — 여기서 나누면 틀린다 */
      ln(383, [sp(60, '헤아린다: 하나씩 세어 보다.', { color: NOTE, size: 8 })]),
      ln(396.5, [sp(60, '지나온 날들을 헤아린다'),
        sp(450, '깊이 사색함. I410-141-25-99-091285995- 2 -')]),
    ]),
    pg(from + 3, [
      ln(46, [sp(60, '1-1.(1)모래시계', { size: 7.9 })]),
      ln(120, [sp(60, '시어의 상징 — '), sp(200, '모래', { color: ans, w: 18 }),
        sp(218, '는 흘러가는 시간을 뜻한다.', { color: NOTE })]),
      ln(801, [sp(60, '일부터 5년간 보호됩니다. 법적 책임을 질 수 있습니다.', { size: 5 })]),
    ]),
  ];
}

const student = half(WHITE, 0);
const doc = { file: 'fixture.pdf', pages: student.concat(half(BLACK, 3)) };
const out = buildIhae(doc, { workId: 'w-moraesigye', title: '모래시계' });
const w = out.work;
const answers = w.blanks.map((b) => b.answers[0]);

t('학생용 절만 읽는다 — 선생님용은 검증용으로 남긴다', () => {
  assert.strictEqual(out.paired, true);
  assert.ok(/학생용 3쪽/.test(out.report[0]), out.report[0]);
  assert.ok(/선생님용 3쪽은 검증용/.test(out.report[0]), out.report[0]);
});

t('개관은 빈칸을 채운 값으로 들어간다 — □가 남으면 정본이 아니다', () => {
  assert.deepStrictEqual(w.overview.genre, ['자유시', '서정시']);
  assert.strictEqual(w.overview.material, '모래시계');
  assert.deepStrictEqual(w.overview.tone, ['성찰적', '상징적']);
  assert.strictEqual(w.overview.theme, '시간의 흐름 속에서 자신을 돌아봄');
  assert.strictEqual(w.overview.features.length, 2);
  assert.ok(/대조적으로 제시함/.test(w.overview.features[1]), w.overview.features[1]);
});

t('연 나눔은 날개풀이 높이를 뺀 간격으로 한다 — 안 빼면 한 연을 둘로 쪼갠다', () => {
  assert.strictEqual(w.text.stanzas.length, 2, '2연이어야 한다: ' + JSON.stringify(w.text.stanzas.map((s) => s.lines)));
  assert.deepStrictEqual(w.text.stanzas.map((s) => s.lines.length), [2, 2]);
  assert.strictEqual(w.text.stanzas[0].lines[1], '유리 벽에 침묵이 쌓인다');
  /* 383pt 의 날개풀이가 낀 2연은 갈리지 않아야 한다 */
  assert.strictEqual(w.text.stanzas[1].lines[1], '지나온 날들을 헤아린다');
});

t('연 요지는 이어지는 줄까지 붙이고, 판면 부속물은 남지 않는다', () => {
  assert.deepStrictEqual(w.composition.map((c) => c.range), ['1연', '2연']);
  assert.strictEqual(w.composition[0].summary, '모래가 떨어지는 모습을 관찰함.');
  assert.strictEqual(w.composition[1].summary, '지나온 시간을 깊이 사색함.');
  const dump = JSON.stringify(w);
  assert.ok(!/I410|091285995/.test(dump), '자료 식별번호가 정본에 남았습니다');
  assert.ok(!/보호됩니다|법적 책임/.test(dump), '저작권 고지 꼬리가 본문으로 샜습니다');
});

t('빈칸은 흰 글씨 전부가 아니라 정답만이다 — 연 라벨은 두 쪽 모두 흰색이라 걸러진다', () => {
  ['자유', '시간', '대조', '관찰', '침묵', '모래'].forEach((a) => {
    assert.ok(answers.includes(a), `빈칸 정답에 '${a}'가 없습니다: ${answers.join(',')}`);
  });
  assert.ok(!answers.includes('1연') && !answers.includes('2연'),
    `연 라벨이 빈칸으로 잘못 잡혔습니다: ${answers.join(',')}`);
  assert.strictEqual(w.blanks.length, 6);
});

t('빈칸 id 는 작품 이름을 달고 나온다 — 파일마다 001부터 세면 배포가 막힌다', () => {
  w.blanks.forEach((b) => assert.ok(b.id.startsWith('w-moraesigye:bl-'), b.id));
  const ids = w.blanks.map((b) => b.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  /* 다른 작품으로 한 번 더 뽑아도 id 가 안 부딪힌다 */
  const other = buildIhae(doc, { workId: 'w-other', title: '다른 시' }).work;
  const overlap = other.blanks.map((b) => b.id).filter((id) => ids.includes(id));
  assert.deepStrictEqual(overlap, [], '작품이 달라도 id 가 겹칩니다');
});

t('빈칸 문맥은 글자 수만큼 □로 가려지고 띄어쓰기는 살아 있다', () => {
  const b = w.blanks.find((x) => x.answers[0] === '침묵');
  assert.strictEqual(b.text, '유리 벽에 □□이 쌓인다');
  assert.strictEqual(b.path, 'text.stanza1');
  /* 정답 경계에서 공백이 사라지면 안 된다 — 실측 사고('일상속에서') */
  const theme = w.blanks.find((x) => x.answers[0] === '시간');
  assert.ok(/□□의 흐름 속에서/.test(theme.text), theme.text);
});

t('검수 부속물은 정본에 섞이지 않는다 — 섞이면 학생 기기까지 배달된다', () => {
  assert.strictEqual(w.candidates, undefined);
  assert.strictEqual(w._report, undefined);
  assert.strictEqual(w._todo, undefined);
  /* 대신 반환값의 별도 자리에 있다 */
  assert.ok(out.candidates.some((c) => c.kind === 'strategy'));
  assert.ok(out.candidates.some((c) => c.kind === 'gloss'));
  assert.deepStrictEqual(w.keywords, []);      // 자동 배정하지 않는다 — 검수 몫
  assert.deepStrictEqual(w.rhetoric, []);
});

t('날개풀이는 바로 앞 시행에 걸리고 3·4단계에서 감춰질 자리에 담긴다', () => {
  assert.strictEqual(w.lineNotes.length, 2);
  assert.strictEqual(w.lineNotes[0].anchor, '유리 벽에 침묵이 쌓인다');
  assert.ok(/겹겹이 포개지다/.test(w.lineNotes[0].note));
});

t('작가는 자료에 없으니 검수 할 일로 남는다', () => {
  assert.ok(out.todo.some((x) => /author/.test(x)), out.todo.join(' | '));
  assert.ok(!out.todo.some((x) => /빈칸을 못 찾았다/.test(x)));
  assert.ok(!out.todo.some((x) => /연 수가 어긋난다/.test(x)), '연 수가 맞는데 어긋난다고 합니다');
});

t('연 수가 연 요지와 어긋나면 조용히 넘기지 않고 검수로 넘긴다', () => {
  /* 연 요지가 '3연'까지 말하는데 본문은 2연뿐인 자료를 만든다 */
  const bent = JSON.parse(JSON.stringify(doc));
  bent.pages[1].lines[10].spans[1].text = '3연';
  const r = buildIhae(bent, { workId: 'w-x', title: 'x' });
  assert.ok(r.todo.some((x) => /연 수가 어긋난다/.test(x)), r.todo.join(' | '));
});

t('머리말에서 교과서 좌표를 읽어 둔다 — 여러 자료를 합칠 때 서로를 채운다', () => {
  assert.strictEqual(out.meta.grade, '중2');
  assert.strictEqual(out.meta.subUnit, '1-1');
  assert.strictEqual(out.meta.workTitle, '모래시계');
});

console.log(`\nOK — ${passed}개 통과. 초안은 초안이다 — 검수 게이트(§7[3])는 건너뛰지 않는다.`);
