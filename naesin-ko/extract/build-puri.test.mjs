import assert from 'node:assert/strict';
import { buildPuri } from './build-puri.mjs';
import { puriFixture } from './practice-fixtures.mjs';
import PC from '../pack-check.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const run = (series = 'solution', doc = puriFixture(series)) => buildPuri(doc, { scope: 'f01',
  sourceSeries: series === 'concept2' ? '개념완성 step2.풀이전략' : '풀이완성', workIds: { '등불의 약속': 'w-lamp' } });

t('그림 예제형 발문과 Q1/Q2 텍스트형을 모두 기존 mc5로 읽는다', () => {
  for (const series of ['solution', 'concept2']) {
    const out = run(series);
    assert.equal(out.review.extraction.recognized, 4);
    assert.equal(out.review.extraction.teacherQuestions, 4);
    const mc = out.items.filter((i) => i.format === 'mc5');
    assert.equal(mc.length, 3);
    assert.deepEqual(mc.map((i) => i.answer), [3, 4, 3]);
    assert.deepEqual(mc.map((i) => i.choices.length), [5, 5, 4]);
    assert.ok(mc.every((i) => !i.stem.includes('Q1.')));
    assert.ok(mc[1].isNegative);
    assert.equal(mc[0].choices[0].text, '창작 설명 1이다.');
    assert.ok(Object.keys(mc[0].explanation.perChoice).length === 5);
  }
});

t('원문에 명시된 OX가 여러 개 참이면 각 설명을 독립 OX로 변환한다', () => {
  const out = run();
  const ox = out.items.filter((i) => i.format === 'ox');
  assert.deepEqual(ox.map((i) => i.answer), [true, false, true, false]);
  assert.equal(new Set(out.items.map((i) => i.id)).size, out.items.length);
  assert.ok(ox.every((i) => typeof i.answer === 'boolean' && i.source.choiceNo));
  assert.equal(ox[0].stem, '창작 설명 1이다.');
});

t('근거 기호·첨삭·하단 안내를 검수에 남기며 학생 본문에 교사용 정답을 섞지 않는다', () => {
  const out = run('concept2');
  const evidence = out.review.candidates.find((c) => c.kind === 'choiceEvidence');
  assert.deepEqual(evidence.choices[0].marks, ['㉠', '㉡']);
  assert.ok(evidence.choices[0].text.includes('창작 첨삭'));
  assert.ok(out.review.candidates.some((c) => c.kind === 'strategyNotes' && c.lines.some((l) => l.includes('고쳐 쓰는 창작 안내'))));
  assert.ok(out.review.candidates.filter((c) => c.kind === 'strategyNotes').every((c) => c.source.file === '창작-풀이.pdf' && Array.isArray(c.images)));
  assert.ok(!JSON.stringify(out.sets).includes('정답'));
  assert.ok(!JSON.stringify(out.items.map((i) => i.choices)).includes('창작 첨삭'));
  const result = PC.checkPack({ packId: 'fixture-puri', works: [{ workId: 'w-lamp', title: '등불의 약속', hasCanon: false }], sets: out.sets, items: out.items });
  assert.deepEqual(result.errors, []);
});

t('학생/교사 예제 수가 어긋나면 순번으로 답을 밀어 붙이지 않는다', () => {
  const doc = puriFixture();
  doc.pages[3].lines = doc.pages[3].lines.filter((l) => l.spans.every((s) => s.x < 300));
  const out = run('solution', doc);
  assert.equal(out.items.length, 0);
  assert.equal(out.review.pending.filter((p) => p.kind === 'item').length, 4);
  assert.ok(out.review.todo.some((t) => t.includes('예제 수')));
});
t('그림 선지 번호는 두 예제의 반복 순서로 복원하고 교사 정답과 연결한다', () => {
  const doc = puriFixture();
  doc.pages.forEach((p) => {
    p.images = [];
    p.lines.forEach((l) => l.spans.forEach((s) => {
      const m = s.text.match(/^([①-⑤])\s*/);
      if (!m || s.color !== '#000000') return;
      p.images.push({ x: s.x, y: l.y + 4, w: 8.4, h: 8.4, digest: 'glyph-' + m[1] });
      s.x += 13; s.text = s.text.slice(m[0].length);
    }));
  });
  const out = run('solution', doc);
  assert.strictEqual(out.items[0].choices.length, 5);
  assert.strictEqual(out.items[0].answer, 3);
  assert.strictEqual(out.items[0].choices[1].text, '창작 설명 2이다.');
});

t('정답 표시가 없으면 1번으로 채우지 않고 원문과 함께 검수에 보존한다', () => {
  const doc = puriFixture();
  doc.pages.slice(2).forEach((p) => p.lines.forEach((l) => {
    l.spans = l.spans.filter((s) => !/[○◯〇✕×✖]/.test(s.text));
    l.spans.forEach((s) => { if (['#d30000', '#ff0000'].includes(s.color)) s.color = '#000000'; });
  }));
  const out = run('solution', doc);
  assert.strictEqual(out.items.length, 0);
  assert.strictEqual(out.review.pending.filter((p) => p.kind === 'item').length, 4);
  assert.ok(out.review.candidates.some((c) => c.kind === 'choiceEvidence' && c.rawTeacher.length));
});

t('복수 정답 표시는 마지막 정답으로 덮어쓰지 않는다', () => {
  const doc = puriFixture('concept2');
  doc.pages[2].lines.flatMap((l) => l.spans).filter((s) => s.text === '(정답 ③)').forEach((s) => { s.text = '(정답 ③,④)'; });
  const out = run('concept2', doc);
  assert.ok(!out.items.some((i) => i.source.no === 1));
  assert.ok(out.review.pending.some((p) => p.reason === 'multi-answer' && p.item.source.no === 1));
  assert.deepEqual(out.review.candidates.find((c) => c.kind === 'choiceEvidence' && c.source.no === 1).printedAnswers, [3, 4]);
});

t('짙은 회색(#222222) 선지 본문도 읽고, 선지 본문이 비면 빈 발문 OX 대신 검수로 내린다', () => {
  const darkDoc = puriFixture('solution');
  darkDoc.pages[1].lines.flatMap((l) => l.spans)
    .filter((s) => s.text.includes('창작 설명')).forEach((s) => { s.color = '#222222'; });
  const darkOut = run('solution', darkDoc);
  const ox = darkOut.items.filter((i) => i.format === 'ox');
  assert.equal(ox.length, 4);
  assert.ok(ox.every((i) => i.stem && i.stem.trim().length > 0));

  const emptyChoiceDoc = puriFixture('solution');
  emptyChoiceDoc.pages[1].lines.filter((l) => l.spans.some((s) => s.x >= 300)).forEach((l) => {
    l.spans.forEach((s) => {
      const m = s.text.match(/^([①-⑤])\s*/);
      if (m) s.text = m[1];
    });
  });
  const emptyOut = run('solution', emptyChoiceDoc);
  assert.equal(emptyOut.items.filter((i) => i.format === 'ox').length, 0);
  assert.ok(emptyOut.review.pending.some((p) => p.reason === 'incomplete-practice' && p.item.source.no === 4));
});

console.log(`OK — ${passed}개 통과`);
