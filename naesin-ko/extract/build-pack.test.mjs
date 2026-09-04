/* 폴더 → 팩 병합기 (node naesin-ko/extract/build-pack.test.mjs)
 *
 * 병합기가 지는 책임은 추출기가 못 하는 것들이다 — 자료 하나만 봐서는 알 수 없고
 * 여러 자료를 같이 봐야 하는 것. 그 셋을 여기서 건다:
 *   ① 같은 개념을 가리키는 빈칸 합치기 (학습량이 지면 수가 아니라 개념 수에 비례하게)
 *   ② 자료마다 다른 띄어쓰기를 정본 표기로 맞추기 (기호 앵커)
 *   ③ 팩 전역 유일 id
 * 실제 지면은 저장소에 못 들어오므로(CLAUDE.md 절대 규칙 1) 자체 창작 값으로 만든다. */
import assert from 'node:assert';
import { mergeBlanks, reanchor, workIdFor } from './build-pack.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const bl = (id, path, text, answers, slot) => ({ id, path, text, answers, slot: slot || 0, label: path.split('.')[1] || path });

t('같은 자리·같은 정답은 합친다 — 두 자료가 같은 칸을 뚫은 것이다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.갈래', '□□시, 서정시', ['자유']),
    bl('w:sum-001', 'overview.갈래', '□□시', ['자유']),
  ] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 1);
  assert.strictEqual(w.blanks.length, 1);
  /* 이해완성 것이 대표가 된다 — 정본 문맥이 먼저 보여야 한다 */
  assert.strictEqual(w.blanks[0].id, 'w:bl-001');
  assert.strictEqual(w.blanks[0].mergedCount, 2);
});

t('자리가 달라도 같은 개념이면 합치고, 나머지 문맥은 회전 변이로 남긴다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'strategy.p4', '전략 절에서 □□를 설명한다', ['구두']),
    bl('w:bl-002', 'overview.제재', '부모님의 □□', ['구두']),
    bl('w:bl-003', 'composition.2', '벗어두신 □□의 모습을 배로 형상화함', ['구두']),
  ] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 2);
  assert.strictEqual(w.blanks.length, 1);
  const b = w.blanks[0];
  /* 대표는 정본에 가까운 것(개관 > 구성 > 전략) */
  assert.strictEqual(b.path, 'overview.제재');
  assert.strictEqual(b.alts.length, 2);
  const paths = b.alts.map((a) => a.path).sort();
  assert.deepStrictEqual(paths, ['composition.2', 'strategy.p4']);
});

t('한 글자 정답은 자리가 같을 때만 합친다 — 같은 글자라고 같은 개념이 아니다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'strategy.p5', '□관념과 보조 관념', ['원']),
    bl('w:bl-002', 'strategy.p7', '고향의 □을 그린다', ['원']),
  ] };
  assert.strictEqual(mergeBlanks(w).merged, 0);
  assert.strictEqual(w.blanks.length, 2);
  /* 같은 자리면 합친다 */
  const w2 = { blanks: [
    bl('w:bl-001', 'strategy.p5', '□관념', ['원']),
    bl('w:sum-001', 'strategy.p5', '□관념과 보조 관념', ['원']),
  ] };
  assert.strictEqual(mergeBlanks(w2).merged, 1);
});

t('잘려 두 번 들어온 같은 문장은 변이가 아니다 — 긴 쪽만 남는다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.제재', '부모님의 □□', ['구두']),
    bl('w:bl-002', 'composition.2', '벗어두신 □□의', ['구두']),
    bl('w:bl-003', 'composition.2', '벗어두신 □□의 모습을 배로 형상화함', ['구두']),
  ] };
  mergeBlanks(w);
  const alts = w.blanks[0].alts;
  assert.strictEqual(alts.length, 1, JSON.stringify(alts));
  assert.ok(/형상화함/.test(alts[0].text), alts[0].text);
});

t('변이 문맥은 자기 슬롯을 달고 간다 — 안 그러면 엉뚱한 □에 입력칸이 뚫린다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.제재', '부모님의 □□', ['구두'], 0),
    bl('w:bl-002', 'strategy.p4', '□(보조)에 □□(원관념)를 비유', ['구두'], 1),
  ] };
  mergeBlanks(w);
  assert.strictEqual(w.blanks[0].alts[0].slot, 1);
});

t('변이는 회전 한 바퀴만큼만 남긴다 — 그 이상은 저장만 늘린다', () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push(bl('w:bl-' + i, 'strategy.p' + i, '문맥' + i + ' □□ 뒤', ['편견']));
  const w = { blanks: many };
  mergeBlanks(w);
  assert.strictEqual(w.blanks.length, 1);
  assert.strictEqual(w.blanks[0].alts.length, 3);
  assert.strictEqual(w.blanks[0].mergedCount, 9);
});

t('합쳐도 지면 순서는 지킨다 — 검수자가 지면 순서로 훑는다', () => {
  const w = { blanks: [
    bl('w:bl-001', 'overview.갈래', '□□시', ['자유']),
    bl('w:bl-002', 'overview.제재', '□□', ['구두']),
    bl('w:bl-003', 'strategy.p4', '□□ 어쩌고', ['자유']),
    bl('w:bl-004', 'text.stanza1', '□□가 어쩌고', ['바다']),
  ] };
  mergeBlanks(w);
  assert.deepStrictEqual(w.blanks.map((b) => b.id), ['w:bl-001', 'w:bl-002', 'w:bl-004']);
});

t('합칠 게 없으면 아무것도 안 건드린다', () => {
  const w = { blanks: [bl('w:bl-001', 'overview.갈래', '□□시', ['자유']), bl('w:bl-002', 'overview.제재', '□□', ['구두'])] };
  const r = mergeBlanks(w);
  assert.strictEqual(r.merged, 0);
  assert.strictEqual(w.blanks.length, 2);
  assert.strictEqual(w.blanks[0].alts, undefined);
});

t('기호 앵커는 정본 표기로 맞춘다 — 같은 시가 자료마다 다르게 조판돼 있다', () => {
  const w = { text: { stanzas: [{ no: 1, lines: ['닻을 내리고 쉬고 있다 우리 집 현관에서', '아빠 구두는 통통배'] }] } };
  /* 그대로 있으면 손대지 않는다 */
  assert.strictEqual(reanchor(w, '아빠 구두는 통통배'), '아빠 구두는 통통배');
  /* 띄어쓰기만 다르면 정본 표기를 돌려준다 */
  assert.strictEqual(reanchor(w, '있다우리 집 현관에서'), '있다 우리 집 현관에서');
  /* 본문에 아예 없으면 null — 조용히 지우지 않고 사람에게 넘기라는 뜻 */
  assert.strictEqual(reanchor(w, '없는 구절이다'), null);
  assert.strictEqual(reanchor(w, ''), null);
  /* 산문(문단)에서도 된다 */
  const prose = { text: { paragraphs: ['그는 천천히 걸어 나갔다.'] } };
  assert.strictEqual(reanchor(prose, '천천히걸어'), '천천히 걸어');
});

t('작품 id 는 머리말 좌표에서 기계적으로 나온다 — 한글은 팩 id 문자셋에 못 들어간다', () => {
  assert.strictEqual(workIdFor('1-1.(2)비린내라뇨!', 0), 'w-1-1-2');
  assert.strictEqual(workIdFor('2-3.(1)어떤 시', 5), 'w-2-3-1');
  assert.strictEqual(workIdFor('좌표 없는 제목', 4), 'w-05');
  assert.ok(/^[A-Za-z0-9-]+$/.test(workIdFor('1-1.(2)비린내라뇨!', 0)));
});

console.log(`\nOK — ${passed}개 통과. 병합기는 자료 하나만 봐서는 못 하는 것을 한다.`);
