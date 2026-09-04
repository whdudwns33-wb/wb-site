'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./atoms-check.js');

const DOC = JSON.parse(fs.readFileSync(path.join(__dirname, 'atoms.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(DOC));
const has = (r, sub) => r.errors.some(e => (e.where + ' ' + e.msg).includes(sub));

// 출제지형도 표에서 트리 ID 를 긁어 커버리지를 잰다 — 문서가 정본이고 atoms 는 그 투영이다
function treeIdsFromDoc() {
  const p = path.join(__dirname, '..', 'docs', '삼육중-출제지형도-스킬트리-v0.md');
  if (!fs.existsSync(p)) return null;
  const ids = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\| (K\d{2}|E\d{2}|N[1-6]|A\d{1,2}|B\d{1,2}|C\d{1,2}|D[1-6]|E[1-5]) \|/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

t('실제 atoms.json 은 오류 0', () => {
  const r = A.check(DOC, { treeIds: treeIdsFromDoc() });
  if (r.errors.length) console.log(r.errors);
  assert.equal(r.errors.length, 0);
  assert.equal(r.stats.core.p2, 16);
  assert.equal(r.stats.core.p3, 16);
  assert.equal(r.stats.core.p4, 16);
  assert.ok(r.stats.total >= 48, '원자 수');
  console.log('   stats', JSON.stringify(r.stats));
  if (r.warnings.length) console.log('   warnings', r.warnings.map(w => w.where + ': ' + w.msg));
});

t('트리 커버리지 — 시험 운영 지표(K36·E35·수학 E1~E5) 말고는 전부 원자가 가리킨다', () => {
  const ids = treeIdsFromDoc();
  if (!ids) return;
  const r = A.check(DOC, { treeIds: ids });
  assert.deepEqual(r.stats.uncovered, []);
  assert.ok(ids.length >= 130, '트리 행 수 ' + ids.length);
});

t('코어 16 확정 구성 — 국어 6 · 수학 6 · 영어 4, 전부 teach:app', () => {
  const core = A.coreFor(DOC, 'p2');
  assert.deepEqual(core, ['k-word-build','k-poly','k-fig-id','k-imagery','k-dev-pattern','k-trap',
    'm-frac-div','m-ratio-base','m-pct-inverse','m-unit-vol','m-dec-remainder','m-avg-inverse',
    'e-vocab-300','e-3sg-past','e-form-26','e-read-skip']);
  assert.deepEqual(A.coreFor(DOC, 'p4'), core);
  const idx = Object.fromEntries(DOC.atoms.map(a => [a.id, a]));
  core.forEach(id => assert.equal(idx[id].teach, 'app', id));
});

t('중복 id 는 오류', () => {
  const d = clone(); d.atoms.push({ ...d.atoms[0] });
  assert.ok(has(A.check(d), '중복 id'));
});

t("teach:'paper' 인데 paperSource 없음 → 오류", () => {
  const d = clone(); const a = d.atoms.find(x => x.teach === 'paper'); delete a.paperSource;
  assert.ok(has(A.check(d), 'paperSource'));
});

t('코어에 teach:paper 원자 → 오류', () => {
  const d = clone(); const a = d.atoms.find(x => x.id === 'k-trap'); a.teach = 'paper'; a.paperSource = 'x';
  assert.ok(has(A.check(d), '코어가 될 수 없습니다'));
});

t('코어 15칸 → 오류 (16 고정)', () => {
  const d = clone(); d.coreByPhase.p2 = d.coreByPhase.p2.slice(0, 15);
  assert.ok(has(A.check(d), '16칸'));
});

t('없는 선수 원자 · 자기 참조 → 오류', () => {
  const d = clone(); d.atoms[0].prereq = ['ghost']; d.atoms[1].confuse = [d.atoms[1].id];
  const r = A.check(d);
  assert.ok(has(r, '없는 원자를 가리킵니다: ghost'));
  assert.ok(has(r, '자기 자신'));
});

t('선수 순환 → 오류', () => {
  const d = clone();
  const a = d.atoms.find(x => x.id === 'n-frac-basic'); a.prereq = ['m-frac-div'];   // m-frac-div → n-frac-basic → m-frac-div
  assert.ok(has(A.check(d), '순환'));
});

t('weight 는 2|1|0.5 · tier 1~3 · skillIds 형식', () => {
  const d = clone(); d.atoms[0].weight = 1.5; d.atoms[1].tier = 4; d.atoms[2].skillIds = ['K99'];
  const r = A.check(d);
  assert.ok(has(r, 'weight'));
  assert.ok(has(r, 'tier'));
  assert.ok(has(r, 'K99'));
});

t('시험 운영 스킬(K36)은 원자가 가리킬 수 없고, K38 은 habit 만', () => {
  const d = clone(); d.atoms[0].skillIds = ['K36']; d.atoms[1].skillIds = ['K38'];
  const r = A.check(d);
  assert.ok(has(r, 'K36'));
  assert.ok(has(r, 'K38'));
});

t("app 원자에 gen 없음 → 오류 (habit 은 예외)", () => {
  const d = clone(); d.atoms.find(x => x.id === 'k-poly').gen = [];
  assert.ok(has(A.check(d), 'gen'));
  const r2 = A.check(clone());
  assert.equal(r2.errors.filter(e => e.where === 'r-oneread').length, 0);
});

t('same-as 순환 참조 → 오류', () => {
  const d = clone(); d.coreByPhase.p3 = 'same-as-p4'; d.coreByPhase.p4 = 'same-as-p3';
  assert.ok(has(A.check(d), 'same-as-pX'));
});

t('bySkill 은 다대일 투영을 돌려준다', () => {
  const m = A.bySkill(DOC);
  assert.deepEqual(m.C9, ['m-ratio-base']);
  assert.ok(m.E01.includes('e-vocab-300'));
});

console.log(n + ' tests passed');
