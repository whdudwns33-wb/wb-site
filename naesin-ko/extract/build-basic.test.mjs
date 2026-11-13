import assert from 'node:assert/strict';
import { buildBasic } from './build-basic.mjs';
import { basicFixture } from './practice-fixtures.mjs';
import PC from '../pack-check.js';
import * as U from './spans-util.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };
const run = (series, opts = {}) => buildBasic(basicFixture(series), { sourceSeries: series, workIds: { '등불의 약속': 'w-lamp' }, ...opts });

t('학생/교사용 쪽 수가 달라도 반복 표지와 1번으로 경계를 가른다', () => {
  const out = run('대표유형');
  assert.equal(out.review.extraction.studentPages, 2);
  assert.equal(out.review.extraction.teacherPages, 3);
  assert.equal(out.review.extraction.recognized, 2);
  assert.equal(out.review.extraction.teacherQuestions, 2);
  assert.equal(out.items.length, 1);
  assert.ok(!out.items[0].stem.includes('정답'));
});

t('실력완성의 빨간 정답과 빨강/파랑 선지별 첨삭을 그대로 읽는다', () => {
  const out = run('실력완성');
  assert.equal(out.items[0].answer, 3);
  assert.deepEqual(out.items[0].choices.map((c) => c.text), [1, 2, 3, 4, 5].map((n) => '창작 선지 ' + n));
  assert.deepEqual(Object.keys(out.items[0].explanation.perChoice), ['1', '2', '3', '4', '5']);
  assert.equal(out.items[0].explanation.perChoice[2], '창작 근거 2이다.');
  assert.ok(out.review.candidates.some((c) => c.kind === 'teacherSolution' && c.raw.includes('창작 근거')));
});

t('대표유형의 정답표와 인라인 오답 해설을 결합하고 서술형 기준은 검수로 보존한다', () => {
  const out = run('대표유형');
  assert.equal(out.items[0].answer, 3);
  assert.equal(Object.keys(out.items[0].explanation.perChoice).length, 5);
  const essay = out.review.pending.find((p) => p.kind === 'item' && p.item.format === 'essay');
  assert.ok(essay);
  assert.deepEqual(essay.item.rubric, []);
  assert.ok(essay.item.modelAnswers[0].includes('새로운 하루'));
  assert.ok(out.review.candidates.some((c) => c.kind === 'teacherSolution' && c.raw.includes('◎ 채점기준')));
  assert.ok(out.review.candidates.some((c) => c.kind === 'inlineTeacher' && c.lines.some((l) => l.includes('◎ 채점기준'))));
  assert.equal(essay.reason, 'rubric-authoring');
  assert.ok(!JSON.stringify(out.items).includes('◎ 채점기준'));
});

t('출처·지문 연결·파일별 id를 보존하고 기존 팩 검사에 맞는다', () => {
  const a = run('실력완성', { scope: 'f01', sourceFile: '자체견본.pdf' });
  const b = run('실력완성', { scope: 'f02' });
  assert.notEqual(a.items[0].id, b.items[0].id);
  assert.notEqual(a.sets[0].setId, b.sets[0].setId);
  assert.equal(a.items[0].source.file, '자체견본.pdf');
  assert.equal(a.items[0].source.series, '실력완성');
  const result = PC.checkPack({ packId: 'fixture-basic', works: [{ workId: 'w-lamp', title: '등불의 약속', hasCanon: false }], sets: a.sets, items: a.items });
  assert.deepEqual(result.errors, []);
});
t('같은 러닝헤더가 학생용 쪽에도 있으면 그 쪽을 교사용 시작으로 삼지 않는다', () => {
  const doc = basicFixture();
  doc.pages[1].lines = doc.pages[0].lines.filter((l) => l.y < 80).concat(doc.pages[1].lines.filter((l) => l.y >= 80));
  const halves = U.practiceHalves(doc);
  assert.equal(halves.student.length, 2);
  assert.equal(halves.teacher.length, 3);
});

t('작은 첨삭 글꼴과 줄 끝의 선지별 해설 번호를 놓치지 않는다', () => {
  const skill = basicFixture('실력완성');
  skill.pages[2].lines.flatMap((l) => l.spans).filter((s) => s.size === 7).forEach((s) => { s.size = 6.8; });
  assert.equal(Object.keys(buildBasic(skill, { sourceSeries: '실력완성' }).items[0].explanation.perChoice).length, 5);
  const typical = basicFixture('대표유형');
  const row = typical.pages[2].lines.find((l) => l.spans.some((s) => s.text.startsWith('② 창작 오답')));
  row.spans[0].text = '②';
  typical.pages[2].lines.push({ y: row.y + 5, spans: [{ ...row.spans[0], text: '창작 오답 근거 2. ' }] });
  typical.pages[2].lines.sort((a, b) => a.y - b.y);
  assert.ok(buildBasic(typical, { sourceSeries: '대표유형' }).items[0].explanation.perChoice[2]);
});

t('빨간 정답 표시가 둘이면 하나로 줄이지 않고 검수로 보존한다', () => {
  const doc = basicFixture('실력완성');
  doc.pages[2].lines.flatMap((l) => l.spans).filter((s) => s.text.startsWith('④ 창작 선지')).forEach((s) => { s.color = '#ff0000'; });
  const out = buildBasic(doc, { sourceSeries: '실력완성' });
  assert.equal(out.items.length, 0);
  assert.equal(out.review.pending.find((p) => p.reason === 'multi-answer').rawAnswer, '③,④');
});

console.log(`OK — ${passed}개 통과`);
