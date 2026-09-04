'use strict';
const assert = require('node:assert/strict');
const PC = require('./pack-check.js');
const ATOMS = require('./atoms.json');
const SAMPLE = require('./pack-sample.json');
let n = 0; function t(name, fn) { fn(); n++; console.log('ok', name); }
const clone = () => JSON.parse(JSON.stringify(SAMPLE));
const has = (r, sub) => r.errors.some(e => (e.where + ' ' + e.msg).includes(sub));
const NOW = Date.UTC(2026, 8, 20);

t('체험 팩은 오류 0', () => {
  const r = PC.checkPack(SAMPLE, { atoms: ATOMS, now: NOW });
  if (r.errors.length) console.log(r.errors);
  assert.equal(r.errors.length, 0);
});
t("정답 제거본에 answerKey·explanationKo·cueSteps·choices[].atomId·errKind 가 0회", () => {
  const s = JSON.stringify(PC.stripForStudent(SAMPLE));
  ['answerKey', 'explanationKo', 'cueSteps', '"atomId":"k-implicit"', '"atomId":"m-pct-inverse"', 'errKind', 'provenance'].forEach(k => assert.ok(!s.includes(k), k));
  assert.ok(s.includes('"atomId":"k-dev-pattern"'), '문항의 atomId 는 남는다 (좌표 갱신용)');
  assert.ok(s.includes('textKo'));
});
t("mode 는 screen 뿐 · origin 에 commercial 은 없다", () => {
  const d = clone(); d.mode = 'paper'; d.origin = 'commercial';
  const r = PC.checkPack(d, { atoms: ATOMS });
  assert.ok(has(r, "mode 는 'screen'")); assert.ok(has(r, 'origin 은 own|pd|kogl1'));
});
t('kogl1 은 attribution 필수', () => {
  const d = clone(); d.origin = 'kogl1'; d.attribution = { org: '국립국어원' };
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), 'attribution'));
  d.attribution = { org: '국립국어원', title: '공개 자료', year: 2024, url: 'https://example.org/x' };
  assert.equal(PC.checkPack(d, { atoms: ATOMS }).errors.length, 0);
});
t("pd 지문은 translation:'own'", () => {
  const d = clone(); d.origin = 'pd';
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), "translation:'own'"));
  d.passages[0].translation = 'own';
  assert.equal(PC.checkPack(d, { atoms: ATOMS }).errors.length, 0);
});
t('T2 는 sourceText:false 여야 한다', () => {
  const d = clone(); d.tier = 'T2'; d.provenance = { method: 'ai-concept-first', sourceText: true };
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), 'sourceText'));
});
t("license.allowedUse 에 serve 없음 · 만료 → 오류", () => {
  const d = clone(); d.license.allowedUse = ['print'];
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), "'serve'"));
  const e = clone(); e.license.expiresAt = '2026-01-01';
  assert.ok(has(PC.checkPack(e, { atoms: ATOMS, now: NOW }), '만료'));
});
t('screen-mock 은 timeLimitSec', () => {
  const d = clone(); d.kind = 'screen-mock';
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), 'timeLimitSec'));
});
t('문항 — 없는 원자·정답 아닌 answerKey·중복 no·setId 불일치', () => {
  const d = clone();
  d.items[0].atomId = 'k-ghost'; d.items[1].answerKey = '9'; d.items[2].no = 1; d.items[3].setId = 'p-99';
  const r = PC.checkPack(d, { atoms: ATOMS });
  ['없는 원자: k-ghost', 'answerKey', '중복 no', 'p-99'].forEach(k => assert.ok(has(r, k), k));
});
t('수학·어휘 문항은 오답에 atomId/errKind 가 하나는 있어야 한다 · 정답 선택지에는 없어야 한다', () => {
  const d = clone();
  d.items[5].choices.forEach(o => { delete o.atomId; delete o.errKind; });
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), '오답 선택지 중 하나 이상'));
  const e = clone(); e.items[0].choices[1].atomId = 'k-refer';
  assert.ok(has(PC.checkPack(e, { atoms: ATOMS }), '정답 선택지에는'));
  const f = clone(); f.items[0].choices[3].atomId = 'k-dev-pattern';
  assert.ok(has(PC.checkPack(f, { atoms: ATOMS }), '정답 원자 자신'));
});
t('지문 itemNos ↔ 문항 setId 양방향', () => {
  const d = clone(); d.passages[0].itemNos.push(6);
  assert.ok(has(PC.checkPack(d, { atoms: ATOMS }), 'setId 가 p-01 가 아닙니다'));
});

const KEY = { id: 'own-mock-01', label: '파일럿 1차 국어', subject: 'kor', n: 6, timeLimitSec: 2400, origin: 'own', holder: 'academy', frozen: true,
  sets: { A: [1, 2, 3], B: [4, 5], C: [6] }, map: { '1': 'k-dev-pattern', '2': 'k-refer', '3': 'k-main-sentence', '4': 'k-trap', '5': 'k-poly', '6': 'k-fig-id' },
  answer: { '1': '2', '2': '2', '3': '1', '4': '3', '5': '1', '6': '4' } };
const kc = () => JSON.parse(JSON.stringify(KEY));
const hk = (r, sub) => r.errors.some(e => (e.where + ' ' + e.msg).includes(sub));

t('자작 회차 대응표는 오류 0', () => {
  const r = PC.checkPaperKey(KEY, { atoms: ATOMS });
  if (r.errors.length) console.log(r.errors);
  assert.equal(r.errors.length, 0);
});
t('시판 자료 + 정답 표 → 오류 · holder:academy → 오류 · student 면 통과', () => {
  const k = kc(); k.origin = 'commercial';
  const r = PC.checkPaperKey(k, { atoms: ATOMS });
  assert.ok(hk(r, '정답 표')); assert.ok(hk(r, "holder:'student'"));
  delete k.answer; k.holder = 'student'; k.frozen = false;
  assert.equal(PC.checkPaperKey(k, { atoms: ATOMS }).errors.length, 0);
});
t('타 학원 모의고사는 등록 불가', () => {
  const k = kc(); k.origin = 'academy-mock';
  assert.ok(hk(PC.checkPaperKey(k, { atoms: ATOMS }), '타 학원'));
  const k2 = kc(); k2.origin = 'commercial'; k2.holder = 'student'; delete k2.answer; k2.frozen = false; k2.label = '○○학원 연합 모의고사 3회';
  assert.ok(hk(PC.checkPaperKey(k2, { atoms: ATOMS }), '연합'));
});
t('국어·영어는 sets 필수, 번호 중복·누락·범위 밖은 오류, 수학은 선택', () => {
  const k = kc(); delete k.sets;
  assert.ok(hk(PC.checkPaperKey(k, { atoms: ATOMS }), 'sets'));
  const k2 = kc(); k2.sets = { A: [1, 2, 2], B: [4, 5, 7] };
  const r = PC.checkPaperKey(k2, { atoms: ATOMS });
  assert.ok(hk(r, '중복: 2')); assert.ok(hk(r, '빠진 번호: 3')); assert.ok(hk(r, '범위 밖: 7'));
  const m = { id: 'own-drill-6-1-u6', label: '겉넓이 드릴', subject: 'math', n: 2, origin: 'own', holder: 'academy', map: { '1': 'm-unit-vol', '2': 'm-solid-cut' }, answer: { '1': '3', '2': '1' } };
  assert.equal(PC.checkPaperKey(m, { atoms: ATOMS }).errors.length, 0);
});
t('동결 세트는 own + timeLimitSec', () => {
  const k = kc(); delete k.timeLimitSec;
  assert.ok(hk(PC.checkPaperKey(k, { atoms: ATOMS }), 'timeLimitSec'));
});
t('map 이 없는 원자를 가리키면 오류', () => {
  const k = kc(); k.map['1'] = 'k-ghost';
  assert.ok(hk(PC.checkPaperKey(k, { atoms: ATOMS }), 'k-ghost'));
});
t('paperSource 존재 검사는 경고', () => {
  const r = PC.checkPaperSources(ATOMS, ['own-drill-6-1-u6']);
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.length >= 10);
});
console.log(n + ' tests passed');
