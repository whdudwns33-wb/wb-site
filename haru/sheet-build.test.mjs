import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderExam, renderOmr, renderAnswerKey, paperKeyFrom, build } from './sheet-build.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PC = require('./pack-check.js');
const ATOMS = require('./atoms.json');
const SAMPLE = require('./pack-sample.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }

t('시험지에는 정답·해설·오답 태그가 0회', () => {
  const html = renderExam(SAMPLE, { title: '국어 체험' });
  ['answerKey', 'explanationKo', 'cueSteps', 'errKind', 'k-implicit', 'm-pct-inverse'].forEach((k) => assert.ok(!html.includes(k), k));
  assert.ok(!html.includes('물이 도시를 지나는 길'), '학생 시험지에는 지문 제목을 싣지 않는다(실제 시험 관행)');
  assert.ok(html.includes('취수장이 강물을 끌어올린다'));
  assert.equal((html.match(/class="q"/g) || []).length, 7);
  assert.ok(html.includes('①'));
  assert.ok(html.includes('<span class="neg">일치하지 않는</span>'));
  assert.ok(!/삼육|호남/.test(html), '인쇄물에 학교명 없음');
});
t('OMR 25칸', () => {
  const omr = renderOmr(25, { title: '회차 1' });
  assert.equal((omr.match(/<tr><td>\d+<\/td>/g) || []).length, 25);
});
t('정답표는 별도 — 정답·원자·세트', () => {
  const key = paperKeyFrom(SAMPLE, 'sample-key');
  const html = renderAnswerKey(SAMPLE, key);
  assert.ok(html.includes('원장·강사용'));
  assert.ok(html.includes('k-dev-pattern') && html.includes('p-01') && html.includes('물이 도시를 지나는 길'));
});
t('paperkey 는 검증기를 통과한다(자작·sets·answer)', () => {
  const key = paperKeyFrom(SAMPLE, 'sample-key', { frozen: true });
  const r = PC.checkPaperKey(key, { atoms: ATOMS });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  assert.deepEqual(key.sets['p-01'], [1, 2, 3, 4, 5]);
  assert.equal(key.answer['6'], '1');
});
t('build 는 파일 3개를 쓴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haru-sheet-'));
  const out = build(SAMPLE, dir, { atoms: ATOMS, title: '국어 체험' });
  assert.ok(fs.existsSync(out.exam) && fs.existsSync(out.answers) && fs.existsSync(out.paperkey));
  assert.ok(!fs.readFileSync(out.exam, 'utf8').includes('answerKey'));
});
console.log(n + ' tests passed');
