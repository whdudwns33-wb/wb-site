/* 이해완성 추출기가 초안을 바르게 뽑는가 (node naesin-ko/extract/build-ihae.test.mjs)
 *
 * 왜 합성 fixture인가: 실제 족보닷컴 지면은 저장소에 못 들어온다(CLAUDE.md 절대 규칙 1).
 * 그래서 **지면의 성질만 베낀** 가상 시를 여기서 직접 지어 spans 구조로 만든다.
 * 지키는 성질 넷:
 *   ① 정답은 흰 글씨로 지면에 이미 있다 (학생용)
 *   ② 같은 지면이 뒤쪽에 선생님용으로 한 번 더 있고 거기서는 검정이다
 *   ③ 흰 글씨라고 다 정답은 아니다 — 색 박스 안의 흰 라벨은 두 쪽 모두 흰색이다
 *   ④ 판면 부속물(쪽번호·자료 식별번호)이 본문 줄 끝에 섞여 들어온다
 * ③④는 실제 지면에서 초안을 망가뜨렸던 두 가지다 — 회귀로 못 박는다. */
import assert from 'node:assert';
import { buildIhae, stripChrome } from './build-ihae.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };

const BLACK = '#000000', WHITE = '#ffffff', NOTE = '#2b5686';
const sp = (x, text, color, size) => ({ x, w: text.length * 9, size: size == null ? 9.5 : size, color: color || BLACK, text });
const ln = (y, spans) => ({ y, spans });
const pg = (no, lines) => ({ no, width: 595, height: 842, lines });

/* 한 벌(3쪽)을 만든다. ans = 빈칸 정답에 쓸 색 — 학생용은 흰색, 선생님용은 검정.
   '1연' 라벨 색은 ans 와 무관하게 늘 흰색이다(성질 ③). */
function half(ans, from) {
  return [
    pg(from + 1, [ln(100, [sp(60, '구조도')])]),                      // 다이어그램 쪽 — 건너뛴다
    pg(from + 2, [
      ln(60, [sp(40, '갈래'), sp(120, '자유', ans), sp(150, '시, 서정시')]),
      ln(80, [sp(40, '제재'), sp(120, '모래시계')]),
      ln(100, [sp(40, '성격'), sp(120, '성찰적, 상징적')]),
      ln(120, [sp(40, '주제'), sp(120, '시간', ans), sp(150, '의 흐름 속에서 자신을 돌아봄')]),
      ln(140, [sp(40, '특징'), sp(120, '① 반복되는 시어로 운율을 형성함')]),
      ln(158, [sp(120, '② 시간의 흐름을 '), sp(260, '대조', ans), sp(290, '적으로 제시함')]),
      ln(200, [sp(60, '모래는 조용히 흘러내리고'),
        sp(400, '1연 모래가 떨어지는 모습을 '), sp(520, '관찰', ans), sp(545, '함')]),
      ln(214, [sp(60, '유리 벽에 '), sp(150, '침묵', ans), sp(180, '이 쌓인다')]),
      ln(250, [sp(60, '나는 그 앞에 오래 앉아'), sp(400, '2연 지나온 시간을')]),
      ln(264, [sp(60, '지나온 날들을 헤아린다'),
        sp(400, '깊이 사색함. I410-141-25-99-091285995- 2 -')]),      // 판면 부속물이 섞인 줄
      ln(286, [sp(60, '* 헤아린다: 하나씩 세어 보다.', NOTE, 8.0)]),
    ]),
    pg(from + 3, [
      /* '핵심'은 색 박스 안의 흰 라벨이다 — 학생용에서도 선생님용에서도 흰색이라 정답이 아니다 */
      ln(100, [sp(60, '핵심', WHITE, 9.0), sp(90, '시어의 상징 — '),
        sp(200, '모래', ans), sp(230, '는 흘러가는 시간을 뜻한다.', NOTE)]),
    ]),
  ];
}

const student = half(WHITE, 0);
const doc = { file: 'fixture.pdf', pages: student.concat(half(BLACK, 3)) };
const out = buildIhae(doc, { workId: 'w-moraesigye', title: '모래시계' });
const w = out.work;
const answers = w.blanks.map((b) => b.answers[0]);

t('학생용/선생님용 짝을 알아본다', () => {
  assert.strictEqual(out.paired, true);
  assert.ok(/학생용 3쪽 사용/.test(out.report[0]), out.report[0]);
});

t('개관은 빈칸을 채운 값으로 들어간다 — □가 남으면 정본이 아니다', () => {
  assert.deepStrictEqual(w.overview.genre, ['자유시', '서정시']);
  assert.strictEqual(w.overview.material, '모래시계');
  assert.deepStrictEqual(w.overview.tone, ['성찰적', '상징적']);
  assert.strictEqual(w.overview.theme, '시간의 흐름 속에서 자신을 돌아봄');
  assert.strictEqual(w.overview.features.length, 2);
  assert.ok(/대조적으로 제시함$/.test(w.overview.features[1]), w.overview.features[1]);
});

t('연은 행 간격이 벌어지는 자리에서 갈린다', () => {
  assert.strictEqual(w.text.stanzas.length, 2);
  assert.deepStrictEqual(w.text.stanzas.map((s) => s.lines.length), [2, 2]);
  assert.strictEqual(w.text.stanzas[0].lines[1], '유리 벽에 침묵이 쌓인다');
  assert.strictEqual(w.text.stanzas[1].lines[0], '나는 그 앞에 오래 앉아');
});

t('연 요지는 이어지는 줄까지 붙인다', () => {
  assert.deepStrictEqual(w.composition.map((c) => c.range), ['1연', '2연']);
  assert.strictEqual(w.composition[0].summary, '모래가 떨어지는 모습을 관찰함');
  assert.strictEqual(w.composition[1].summary, '지나온 시간을 깊이 사색함.');
});

t('쪽번호·자료 식별번호는 어디에도 남지 않는다', () => {
  const dump = JSON.stringify(w);
  assert.ok(!/I410|091285995|-\s*2\s*-/.test(dump), '판면 부속물이 정본에 남았습니다');
  assert.strictEqual(stripChrome('깊이 사색함. I410-141-25-99-091285995- 2 -'), '깊이 사색함.');
  assert.strictEqual(stripChrome('- 3 -'), '');
  assert.strictEqual(stripChrome('바람이 분다'), '바람이 분다');
});

t('빈칸은 흰 글씨 전부가 아니라 선생님용에서 보이는 것만이다', () => {
  ['자유', '시간', '대조', '관찰', '침묵', '모래'].forEach((a) => {
    assert.ok(answers.includes(a), `빈칸 정답에 '${a}'가 없습니다: ${answers.join(',')}`);
  });
  assert.ok(!answers.includes('핵심'),
    `색 박스의 흰 라벨이 빈칸으로 잘못 잡혔습니다: ${answers.join(',')}`);
  assert.strictEqual(w.blanks.length, 6);
});

t('빈칸 문맥은 글자 수만큼 □로 가려진다', () => {
  const b = w.blanks.find((x) => x.answers[0] === '침묵');
  assert.strictEqual(b.text, '유리 벽에 □□이 쌓인다');
  assert.strictEqual(b.path, 'text.stanza1');
  assert.strictEqual(b.page, 2);
  const ids = w.blanks.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'blank id가 겹칩니다');
});

t('날개풀이는 바로 앞 시행에 걸린다', () => {
  assert.strictEqual(w.lineNotes.length, 1);
  assert.strictEqual(w.lineNotes[0].anchor, '지나온 날들을 헤아린다');
  assert.ok(/하나씩 세어 보다/.test(w.lineNotes[0].note));
});

t('구조도 쪽은 건드리지 않고, 이해 전략은 후보로만 모은다', () => {
  assert.ok(!JSON.stringify(w).includes('구조도'));
  assert.ok(out.candidates.some((c) => c.kind === 'strategy' && /흘러가는 시간/.test(c.text)));
  assert.ok(out.candidates.some((c) => c.kind === 'gloss'));
  assert.deepStrictEqual(w.keywords, []);      // 자동 배정하지 않는다 — 검수 몫
  assert.deepStrictEqual(w.rhetoric, []);
});

t('작가는 자료에 없으니 검수 할 일로 남는다', () => {
  assert.ok(out.todo.some((x) => /author/.test(x)), out.todo.join(' | '));
  assert.ok(!out.todo.some((x) => /빈칸을 못 찾았다/.test(x)));
});

t('선생님용이 없으면 색만 믿는다 — 그 대가가 라벨 오검출이다', () => {
  const solo = buildIhae({ pages: student }, { workId: 'w-x' });
  assert.strictEqual(solo.paired, false);
  assert.ok(/대조본 없음/.test(solo.report[0]));
  const a = solo.work.blanks.map((b) => b.answers[0]);
  assert.ok(a.includes('핵심'), '색만으로 판정하면 박스 라벨도 빈칸이 된다 — 이것이 짝 지면이 필요한 이유');
  assert.strictEqual(solo.work.blanks.length, w.blanks.length + 1);
});

console.log(`\nOK — ${passed}개 통과. 초안은 초안이다 — 검수 게이트(§7[3])는 건너뛰지 않는다.`);
