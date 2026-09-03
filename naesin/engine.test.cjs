'use strict';
/* WB 내신브레인 — 암기 엔진 검증 (node naesin/engine.test.cjs)
   정본: 기획서 §4.1 · §4.4 · §5.4 · §14-1 */
const assert = require('assert');
const E = require('./engine.js');
const pack = require('./pack-sample.json');

const DAY = E.DAY;
const MIN10 = E.MIN10;
let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

/* 고정 시각 — 로컬 달력 기준으로 서로 다른 날을 확실하게 밟는다 */
const d1 = new Date(2026, 8, 2, 12, 0, 0).getTime();   // 9/2 낮
const d1b = new Date(2026, 8, 2, 20, 0, 0).getTime();  // 9/2 저녁 (같은 날)
const d2 = new Date(2026, 8, 3, 9, 0, 0).getTime();    // 9/3
const d3 = new Date(2026, 8, 4, 9, 0, 0).getTime();    // 9/4
const d4 = new Date(2026, 8, 5, 9, 0, 0).getTime();    // 9/5
const at = (m, d, h, mi) => new Date(2026, m - 1, d, h == null ? 9 : h, mi || 0).getTime();
const ok = { correct: true, confidence: 'sure' };

/* n개짜리 합성 팩 — planDay 분배 검증용 (픽스처 팩은 8단어뿐이라 부족) */
function mkPack(n) {
  const words = [];
  for (let i = 1; i <= n; i++) words.push({ id: 'w' + i });
  return { words, sentences: [] };
}
function reachedState(id, now) {
  const s = E.createState(id, 'word', now);
  return E.recordCriterion(s, ok, now);
}

/* ── 상태 생성 ── */
t('createState — 단어엔 stage 없음, 문장·대화문은 stage 1, due=now', () => {
  const w = E.createState('w-001', 'word', d1);
  assert.strictEqual(w.step, 0);
  assert.strictEqual(w.due, d1);
  assert.strictEqual(w.reached, false);
  assert.strictEqual(w.lastCriterionDate, null);
  assert.strictEqual(w.lastCriterionAt, null);
  assert.ok(!('stage' in w), '단어에 stage 가 생기면 안 된다');
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  assert.strictEqual(s.stage, 1);
  const d = E.createState('d-01', 'dialogue', d1);
  assert.strictEqual(d.stage, 1, '대화문도 사다리 단계를 갖는다(계약 0.5)');
  assert.strictEqual(d.kind, 'dialogue');
});

t('now 가 Date 객체여도 ms 로 정규화한다 — due 가 문자열이 되지 않는다', () => {
  const s = E.createState('w', 'word', new Date(d1));
  assert.strictEqual(s.due, d1);
  E.recordQuiz(s, ok, new Date(d1));
  assert.strictEqual(typeof s.due, 'number');
  assert.strictEqual(s.due, d1 + DAY);
  assert.strictEqual(E.localDate(new Date(d1)), '2026-09-02');
  assert.strictEqual(E.daysUntil('2026-09-12', new Date(d1)), 10);
});

/* ── 판정 퀴즈 SRS (§4.1) ── */
t('정답+확실 — 압축 간격표 1→2→3→5→7일, 상한 유지', () => {
  const s = E.createState('w', 'word', d1);
  let now = d1;
  [1, 2, 3, 5, 7].forEach((days, i) => {
    E.recordQuiz(s, ok, now);
    assert.strictEqual(s.step, i + 1);
    assert.strictEqual(s.due, now + days * DAY);
    now = s.due;
  });
  E.recordQuiz(s, ok, now);
  assert.strictEqual(s.step, 5, '간격표 끝에서 멈춘다');
  assert.strictEqual(s.due, now + 7 * DAY);
});

t('정답+찍음 — 간격 동결(step 유지), 하루 뒤 재출제 (§14-1)', () => {
  const s = E.createState('w', 'word', d1);
  s.step = 3;
  E.recordQuiz(s, { correct: true, confidence: 'guess' }, d1);
  assert.strictEqual(s.step, 3);
  assert.strictEqual(s.due, d1 + DAY);
});

t('정답이어도 힌트를 봤으면 간격을 안 올린다', () => {
  const s = E.createState('w', 'word', d1);
  s.step = 2;
  E.recordQuiz(s, { correct: true, confidence: 'sure', hinted: true }, d1);
  assert.strictEqual(s.step, 2);
  assert.strictEqual(s.due, d1 + DAY);
});

t('오답+확실 = 과신 오류 — overconfident+1, 2계단 후퇴, 10분 뒤 (§14-1)', () => {
  const s = E.createState('w', 'word', d1);
  s.step = 3;
  E.recordQuiz(s, { correct: false, confidence: 'sure' }, d1);
  assert.strictEqual(s.overconfident, 1);
  assert.strictEqual(s.step, 1);
  assert.strictEqual(s.due, d1 + MIN10);
  assert.strictEqual(s.wrong, 1);
  s.step = 1;
  E.recordQuiz(s, { correct: false, confidence: 'sure' }, d1);
  assert.strictEqual(s.step, 0, '최소 0에서 멈춘다');
});

t('오답+애매/찍음 — 1계단 후퇴, 과신 카운트 없음', () => {
  const s = E.createState('w', 'word', d1);
  s.step = 3;
  E.recordQuiz(s, { correct: false, confidence: 'unsure' }, d1);
  assert.strictEqual(s.step, 2);
  assert.strictEqual(s.overconfident, 0);
  assert.strictEqual(s.due, d1 + MIN10);
});

/* ── 기준 도달과 안정화 (§14-1) ── */
t('완전 인출 최초 성공 — 도달 기록(reached·reachedAt·lastCriterionDate·lastCriterionAt)', () => {
  const s = E.createState('w', 'word', d1);
  E.recordCriterion(s, ok, d1);
  assert.strictEqual(s.reached, true);
  assert.strictEqual(s.reachedAt, d1);
  assert.strictEqual(s.lastCriterionDate, '2026-09-02');
  assert.strictEqual(s.lastCriterionAt, d1);
  assert.strictEqual(s.relearnCount, 0, '도달은 안정화 0회전에서 시작');
});

t("안정화의 '다른 날' 규칙 — 같은 날 재성공은 불인정, 다른 날만 +1", () => {
  const s = E.createState('w', 'word', d1);
  E.recordCriterion(s, ok, d1);      // 도달
  E.recordCriterion(s, ok, d1b);     // 같은 날 저녁
  assert.strictEqual(s.relearnCount, 0, '같은 날 두 번째 성공은 안 센다');
  E.recordCriterion(s, ok, d2);
  assert.strictEqual(s.relearnCount, 1);
  assert.strictEqual(s.lastCriterionDate, '2026-09-03');
  E.recordCriterion(s, ok, d3);
  E.recordCriterion(s, ok, d4);
  assert.strictEqual(s.relearnCount, 3);
  E.recordCriterion(s, ok, d4 + DAY);
  assert.strictEqual(s.relearnCount, 3, '상한 3');
});

t('E12 자정 걸침 — 23:59/00:01 두 번은 이틀이 아니다(8시간 미만), 8시간 지나면 다른 날', () => {
  const s = E.createState('w', 'word', at(9, 1));
  E.recordCriterion(s, ok, at(9, 1, 23, 59));   // 도달
  E.recordCriterion(s, ok, at(9, 2, 0, 1));     // 2분 뒤, 달력은 다음 날
  assert.strictEqual(s.relearnCount, 0, '자정 걸침은 한 세션이다');
  assert.strictEqual(s.lastCriterionDate, '2026-09-01', '인정 안 된 성공은 날짜도 안 옮긴다');
  E.recordCriterion(s, ok, at(9, 2, 9, 0));     // 9시간 뒤
  assert.strictEqual(s.relearnCount, 1);
  assert.strictEqual(s.lastCriterionDate, '2026-09-02');
  /* 하위 호환 — lastCriterionAt 이 없는 옛 상태는 날짜만으로 판단 */
  const old = E.createState('o', 'word', at(9, 1));
  E.recordCriterion(old, ok, at(9, 1, 23, 59));
  delete old.lastCriterionAt;
  E.recordCriterion(old, ok, at(9, 2, 0, 1));
  assert.strictEqual(old.relearnCount, 1, '필드가 없으면 통과');
});

t('stability 0~3 게이지 · isStable — 도달 전엔 0', () => {
  const s = E.createState('w', 'word', d1);
  s.relearnCount = 2;               // 도달 전 오염값이 있어도
  assert.strictEqual(E.stability(s), 0, '도달 전엔 게이지 0');
  E.recordCriterion(s, ok, d1);
  E.recordCriterion(s, ok, d2);
  assert.strictEqual(E.stability(s), 3);
  assert.ok(E.isStable(s));
  assert.ok(!E.isStable(E.createState('x', 'word', d1)));
});

t('완전 인출 실패 — streak 리셋·wrong+1·10분 뒤, 확실이면 과신 집계', () => {
  const s = E.createState('w', 'word', d1);
  s.streak = 4; s.step = 3;
  E.recordCriterion(s, { correct: false, confidence: 'sure' }, d1);
  assert.strictEqual(s.streak, 0);
  assert.strictEqual(s.wrong, 1);
  assert.strictEqual(s.due, d1 + MIN10);
  assert.strictEqual(s.overconfident, 1);
  assert.strictEqual(s.reached, false, '실패는 도달이 아니다');
});

t('E3 안정화 완료 후 오답 — 회전이 깎이고(애매 -1·확실 -2) 다시 편성된다', () => {
  const s = E.createState('w1', 'word', at(9, 1));
  [1, 2, 3, 4].forEach((d) => E.recordCriterion(s, ok, at(9, d)));
  assert.ok(E.isStable(s));
  E.recordCriterion(s, { correct: false, confidence: 'unsure' }, at(9, 24));
  assert.strictEqual(s.relearnCount, 2, '애매 오답은 1회전 후퇴');
  assert.strictEqual(s.lastCriterionDate, null, '날짜를 지워 오늘 다시 성공하면 회복으로 센다');
  assert.strictEqual(s.reached, true, '도달 자체는 유지');
  E.recordQuiz(s, { correct: false, confidence: 'sure' }, at(9, 24, 10));
  assert.strictEqual(s.relearnCount, 0, '과신 오답은 2회전 후퇴 (판정 퀴즈도 같은 규칙)');
  assert.ok(!E.isStable(s));
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const p = { words: [{ id: 'w1' }], sentences: [] };
  assert.deepStrictEqual(E.planDay(p, { w1: s }, EX, at(9, 25)).words.relearn, ['w1'], '시험 D-5 안정화 레인에 복귀');
  assert.deepStrictEqual(E.planDay(p, { w1: s }, null, at(9, 25)).words.relearn, ['w1'], '연습 모드도 due 지났으니 복귀');
  E.recordCriterion(s, ok, at(9, 24, 11));
  assert.strictEqual(s.relearnCount, 1, '실패 직후 재성공은 회복 1회전');
  const z = E.createState('z', 'word', d1);
  E.recordQuiz(z, { correct: false, confidence: 'unsure' }, d1);
  assert.strictEqual(z.relearnCount, 0, '0 아래로 내려가지 않는다');
});

t('E17 완전 인출 "찍음" — 최초 도달만 허용(철자 재검증), 회전·날짜는 갱신하지 않는다', () => {
  const s = E.createState('w', 'word', at(9, 1));
  E.recordCriterion(s, { correct: true, confidence: 'guess' }, at(9, 1));
  assert.strictEqual(s.reached, true);
  assert.strictEqual(s.needsSpellCheck, true, '찍어서 맞은 도달은 재검증 대상');
  assert.strictEqual(s.lastCriterionDate, null);
  assert.strictEqual(s.relearnCount, 0);
  assert.strictEqual(s.due, at(9, 1) + DAY, '간격 동결');
  E.recordCriterion(s, { correct: true, confidence: 'guess' }, at(9, 2));
  assert.strictEqual(s.relearnCount, 0, '다른 날이어도 찍음은 회전이 아니다');
  E.recordCriterion(s, ok, at(9, 3));
  assert.strictEqual(s.needsSpellCheck, false);
  assert.strictEqual(s.relearnCount, 1, '진짜 인출부터 센다');
});

t('E8 힌트 본 철자는 완전 인출이 아니다 — recordCriterion(hinted) 는 판정 퀴즈로 처리', () => {
  const s = E.createState('w', 'word', d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure', hinted: true }, d1);
  assert.strictEqual(s.reached, false, '도달 아님');
  assert.strictEqual(s.due, d1 + DAY, '힌트 정답은 간격 동결');
  assert.strictEqual(s.last, d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure', hinted: false }, d2);
  assert.strictEqual(s.reached, true);
});

/* ── 출발선 진단 (§14-1) ── */
t('진단 적용 — 안다: 도달+철자재검증 플래그, 모름: 그대로', () => {
  const states = {
    a: E.createState('a', 'word', d1),
    b: E.createState('b', 'word', d1),
    c: E.createState('c', 'word', d1)
  };
  E.applyDiagnostic(states, [{ id: 'a', known: true }, { id: 'b', known: false }], d1);
  assert.strictEqual(states.a.reached, true);
  assert.strictEqual(states.a.needsSpellCheck, true, '4지선다 재인은 관대 — 철자 재검증 필요');
  assert.strictEqual(states.a.relearnCount, 0);
  assert.strictEqual(states.a.reachedAt, d1);
  assert.strictEqual(states.b.reached, false, '모름은 신규 큐 그대로');
  assert.strictEqual(states.c.reached, false, '결과에 없는 단어는 그대로');
});

t('진단 통과 단어의 철자 검증 성공 — 플래그 해제 + 그날부터 안정화 카운트', () => {
  const states = { a: E.createState('a', 'word', d1) };
  E.applyDiagnostic(states, [{ id: 'a', known: true }], d1);
  E.recordCriterion(states.a, ok, d2);
  assert.strictEqual(states.a.needsSpellCheck, false);
  assert.strictEqual(states.a.relearnCount, 1, '재검증 성공은 다른 날이므로 안정화 1회전');
});

/* ── 단어 요약 ── */
t('wordSummary — 도달(재검증 끝난 것만)·안정·위험·철자재검증 집계, 단어(kind word)만', () => {
  const states = {};
  states.a = reachedState('a', d1);                                   // 도달만
  states.b = reachedState('b', d1);                                   // 안정화 완료
  E.recordCriterion(states.b, ok, d2);
  E.recordCriterion(states.b, ok, d3);
  E.recordCriterion(states.b, ok, d4);
  states.c = E.createState('c', 'word', d1); states.c.wrong = 3;      // 오답 다수
  states.d = E.createState('d', 'word', d1); states.d.overconfident = 1; // 과신
  states.e = E.createState('e', 'word', d1); states.e.needsSpellCheck = true;
  states.s1 = E.createState(E.sentenceId(1), 'sentence', d1);         // 문장은 제외
  states['d-01'] = E.createState('d-01', 'dialogue', d1);              // 대화문도 제외(계약 0.5)
  const sum = E.wordSummary(states);
  assert.deepStrictEqual(sum, { total: 5, reached: 2, stable: 1, risky: 2, needsSpellCheck: 1 });
  /* E4 진단 '안다'는 reached 상태지만 재검증 전이라 '도달'로 세지 않는다 */
  const diag = { x: E.createState('x', 'word', d1) };
  E.applyDiagnostic(diag, [{ id: 'x', known: true }], d1);
  assert.deepStrictEqual(E.wordSummary(diag), { total: 1, reached: 0, stable: 0, risky: 0, needsSpellCheck: 1 });
});

t('E20 위험 표시는 안정화가 끝나면 해제된다 — 과신 1회가 영구 낙인이 아니다', () => {
  const s = E.createState('w', 'word', at(9, 1));
  E.recordCriterion(s, { correct: false, confidence: 'sure' }, at(9, 1));
  assert.strictEqual(E.wordSummary({ w: s }).risky, 1);
  [1, 2, 3, 4].forEach((d) => E.recordCriterion(s, ok, at(9, d)));
  assert.ok(E.isStable(s));
  assert.strictEqual(E.wordSummary({ w: s }).risky, 0, '안정화 완료 → 위험 해제');
  E.recordCriterion(s, { correct: false, confidence: 'sure' }, at(9, 10));
  assert.strictEqual(E.wordSummary({ w: s }).risky, 1, '다시 틀려 안정화가 깨지면 위험 복귀');
});

/* ── 단어 선행 게이트 (§4.4) ── */
const EXAM = { examDate: '2026-09-12', wordDeadlineDays: 7 };

t('게이트 — 연습 모드(exam 없음)는 항상 열림', () => {
  const states = { a: E.createState('a', 'word', d1) };
  const g = E.gate(states, null, d1);
  assert.deepStrictEqual(g, { open: true, reason: 'practice', done: 0, total: 1 });
});

t('게이트 — 시험 모드는 전 단어 도달 전까지 잠김, 전원 도달 시 열림', () => {
  const states = { a: reachedState('a', d1), b: E.createState('b', 'word', d1) };
  let g = E.gate(states, EXAM, d1);
  assert.deepStrictEqual(g, { open: false, reason: 'word-gate', done: 1, total: 2 });
  E.recordCriterion(states.b, ok, d1);
  g = E.gate(states, EXAM, d1);
  assert.deepStrictEqual(g, { open: true, reason: 'reached', done: 2, total: 2 });
});

t('E4 게이트 — 진단 "안다"만으로는 열리지 않는다(철자 재검증까지 끝나야 도달)', () => {
  const states = {};
  pack.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', d1); });
  E.applyDiagnostic(states, pack.words.map((w) => ({ id: w.id, known: true })), d1);
  const g = E.gate(states, EXAM, d1);
  assert.deepStrictEqual(g, { open: false, reason: 'word-gate', done: 0, total: 8 });
  pack.words.forEach((w) => E.recordCriterion(states[w.id], ok, d2));
  assert.strictEqual(E.gate(states, EXAM, d2).reason, 'reached');
  /* 대화문·문장 상태는 게이트 분모에 안 들어간다 */
  states['d-01'] = E.createState('d-01', 'dialogue', d1);
  states[E.sentenceId(1)] = E.createState(E.sentenceId(1), 'sentence', d1);
  assert.strictEqual(E.gate(states, EXAM, d2).total, 8);
});

t('게이트 — 강사 오버라이드·병행 모드는 미도달이어도 열림 (§14-4)', () => {
  const states = { a: E.createState('a', 'word', d1) };
  assert.strictEqual(E.gate(states, EXAM, d1, { override: true }).reason, 'override');
  const p = E.gate(states, EXAM, d1, { parallel: true });
  assert.strictEqual(p.open, true);
  assert.strictEqual(p.reason, 'parallel', 'UI가 선차감 처리할 수 있게 사유를 밝힌다');
  /* 전원 도달이면 병행 플래그가 있어도 사유는 reached — 선차감할 게 없다 */
  const done = { a: reachedState('a', d1) };
  assert.strictEqual(E.gate(done, EXAM, d1, { parallel: true }).reason, 'reached');
});

t('E20 게이트 — 시험이 지났거나 examDate 가 없으면 연습과 같다', () => {
  const states = { a: E.createState('a', 'word', d1) };
  assert.strictEqual(E.gate(states, { examDate: '2026-09-01' }, d1).reason, 'practice', '시험 지남');
  assert.strictEqual(E.gate(states, { examDate: '2026-09-02' }, d1).reason, 'practice', 'D-0 도 시험 후');
  assert.strictEqual(E.gate(states, { examDate: undefined }, d1).reason, 'practice', 'examDate 없음');
  assert.strictEqual(E.gate(states, {}, d1).reason, 'practice');
});

/* ── 오답노트 클리어 (§5.4) ── */
t('오답 클리어 — 같은 날 연속 정답은 1회, 서로 다른 날 2회에 클리어', () => {
  const s = E.createState('w', 'word', d1);
  assert.deepStrictEqual(E.clearWrong(s, d1), { cleared: false, days: 1 });
  assert.deepStrictEqual(E.clearWrong(s, d1b), { cleared: false, days: 1 }, '같은 날 재정답은 안 쌓인다');
  const r = E.clearWrong(s, d2);
  assert.deepStrictEqual(r, { cleared: true, days: 2 });
  assert.deepStrictEqual(s.wrongClearDates, ['2026-09-02', '2026-09-03']);
});

t('E13 오답 클리어 — 앱이 배열을 비우면(다시 틀림, 계약 0.6) 처음부터 센다', () => {
  const entry = { kind: 'gen', type: 'w-spell', ref: 'w-001', tries: 1, wrongClearDates: [], cleared: false };
  assert.deepStrictEqual(E.clearWrong(entry, d1), { cleared: false, days: 1 });
  entry.wrongClearDates = [];                       // 다시 틀림 — 앱이 리셋
  assert.deepStrictEqual(E.clearWrong(entry, d2), { cleared: false, days: 1 }, '리셋 뒤 첫 정답은 1일째');
  assert.deepStrictEqual(E.clearWrong(entry, d3), { cleared: true, days: 2 });
  const broken = { wrongClearDates: 'x' };
  assert.deepStrictEqual(E.clearWrong(broken, d1), { cleared: false, days: 1 }, '배열이 아니면 새로 만든다');
});

/* ── 오늘의 플랜 (§5.4 회복 편성 + §14-1 안정화 배분) ── */
t('planDay — 시험 10일 전 미도달 30개 → 마감(D-7 당일 포함)까지 4일, 하루 8개', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d1);   // 9/2, 시험 9/12
  assert.strictEqual(plan.mode, 'exam');
  assert.strictEqual(plan.dday, 10);
  assert.strictEqual(plan.words.fresh.length, 8);
  assert.deepStrictEqual(plan.words.fresh.slice(0, 3), ['w1', 'w2', 'w3'], '팩 순서대로');
});

t('planDay — 매일 전면 재계산: 진도가 나가면 다음 날 몫이 잔량/잔여일로 다시 나온다', () => {
  const p = mkPack(30);
  const states = {};
  for (let i = 1; i <= 10; i++) states['w' + i] = reachedState('w' + i, d1);
  const plan = E.planDay(p, states, EXAM, d2);        // D-9: 미도달 20, 잔여 3일
  assert.strictEqual(plan.words.fresh.length, 7);
  assert.strictEqual(plan.words.fresh[0], 'w11');
});

t('planDay — 결석해도 빚 목록 없음: 잔량을 다시 나누고 상한만 지킨다', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d3);   // D-8: 이틀 밀림, 잔여 2일에 30개 → 15
  assert.strictEqual(plan.words.fresh.length, 10, '하루 상한 10 유지');
  const plan2 = E.planDay(mkPack(30), {}, EXAM, d3, { maxNewWords: 15 });
  assert.strictEqual(plan2.words.fresh.length, 15, '상한은 opts로 조정');
});

t('E20 마감 경계 — D-7 당일은 아직 마감 안이고(경과 표시 없음), D-6부터 회복 편성', () => {
  const p = mkPack(20);
  const dD7 = new Date(2026, 8, 5, 9).getTime(), dD6 = new Date(2026, 8, 6, 9).getTime();
  const p7 = E.planDay(p, {}, EXAM, dD7);
  assert.strictEqual(p7.dday, 7);
  assert.strictEqual(p7.words.fresh.length, 10, '마감 당일 = 남은 전부(상한 10)');
  assert.ok(p7.note.indexOf('회복 편성') < 0, 'D-7 은 경과가 아니다: ' + p7.note);
  const p6 = E.planDay(p, {}, EXAM, dD6);
  assert.strictEqual(p6.words.fresh.length, 10);
  assert.ok(p6.note.indexOf('회복 편성') >= 0, 'D-6 부터 경과: ' + p6.note);
});

t('planDay — 마감 경과 후 미도달 잔여는 회복 편성으로 계속 나온다', () => {
  const d6 = new Date(2026, 8, 8, 9, 0, 0).getTime(); // D-4, 마감(9/5) 지남
  const plan = E.planDay(mkPack(4), {}, EXAM, d6);
  assert.strictEqual(plan.words.fresh.length, 4);
  assert.ok(plan.note.indexOf('회복 편성') >= 0, '플랜 노트에 회복 편성 표기: ' + plan.note);
});

t('E20 시험 후 모드 — D-0 이하면 신규 편성 없이 자율 복습(after)', () => {
  const p = mkPack(20);
  const states = { w1: reachedState('w1', d1) };
  const dExam = new Date(2026, 8, 12, 9).getTime(), dAfter = new Date(2026, 8, 14, 9).getTime();
  [dExam, dAfter].forEach((now) => {
    const plan = E.planDay(p, states, EXAM, now);
    assert.strictEqual(plan.mode, 'after');
    assert.ok(plan.dday <= 0);
    assert.deepStrictEqual(plan.words.fresh, [], '신규 없음');
    assert.deepStrictEqual(plan.words.relearn, ['w1'], '만기 도달 단어는 자율 복습');
    assert.ok(plan.note.indexOf('시험 종료 — 자율 복습') >= 0, plan.note);
    assert.ok(plan.note.indexOf('게이트') < 0, '시험 후엔 게이트 없음');
  });
  assert.strictEqual(E.planDay(p, {}, { examDate: undefined }, d1).mode, 'practice', 'examDate 없으면 연습');
});

t('planDay — 안정화 회전은 D-7~D-1에만, 잔여 회전/잔여일로 배분 (§14-1)', () => {
  const p = mkPack(6);
  const states = {};
  for (let i = 1; i <= 6; i++) states['w' + i] = reachedState('w' + i, d1);
  /* D-8(9/4): 전원 도달이어도 안정화 구간 전 — 회전 배분 없음(만기면 복습으로) */
  assert.strictEqual(E.planDay(p, states, EXAM, d3).words.relearn.length, 0);
  /* D-7(9/5): 잔여 회전 6단어×3=18 ÷ 7일 → 올림 3단어 */
  const plan = E.planDay(p, states, EXAM, d4);
  assert.strictEqual(plan.dday, 7);
  assert.strictEqual(plan.words.relearn.length, 3);
  /* D-1: 각 1회전 남음 → 6단어 전부 (상한 이내) */
  const dD1 = new Date(2026, 8, 11, 9, 0, 0).getTime();
  for (let i = 1; i <= 6; i++) states['w' + i].relearnCount = 2;
  assert.strictEqual(E.planDay(p, states, EXAM, dD1).words.relearn.length, 6);
  assert.strictEqual(E.planDay(p, states, EXAM, dD1, { maxRelearn: 4 }).words.relearn.length, 4, '상한 적용');
});

t('E5 시험 모드 D-7 전 — 만기 도달 단어는 복습(review)으로 편성해 SRS 를 끊지 않는다', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const s = E.createState('w1', 'word', at(9, 5));
  E.recordCriterion(s, ok, at(9, 5));            // D-25 도달, due +1일
  const p = { words: [{ id: 'w1' }], sentences: [] };
  [6, 10, 15, 22].forEach((d) => {
    const plan = E.planDay(p, { w1: s }, EX, at(9, d));
    assert.deepStrictEqual(plan.words, { fresh: [], review: ['w1'], relearn: [] }, '9/' + d + ' D-' + plan.dday);
  });
  E.recordQuiz(s, ok, at(9, 5));                 // due 를 밀어 두면
  assert.deepStrictEqual(E.planDay(p, { w1: s }, EX, at(9, 6)).words.review, [], 'due 전엔 복습 없음');
  assert.deepStrictEqual(E.planDay(p, { w1: s }, EX, at(9, 23)).words, { fresh: [], review: [], relearn: ['w1'] }, 'D-7 부터는 안정화 레인');
});

t('E4 철자 재검증 대기 단어는 D-day 와 무관하게 매일 안정화 레인(무힌트 철자)에 나온다', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const states = {};
  pack.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', at(9, 10)); });
  E.applyDiagnostic(states, pack.words.map((w) => ({ id: w.id, known: true })), at(9, 10));
  const p20 = E.planDay(pack, states, EX, at(9, 10));   // D-20
  assert.strictEqual(p20.words.relearn.length, 8, 'D-20 에도 재검증 편성');
  assert.ok(p20.note.indexOf('게이트 잠김') >= 0, '재검증 전이라 게이트 잠김');
  E.recordCriterion(states['w-001'], ok, at(9, 10));   // 하나 재검증 성공
  const again = E.planDay(pack, states, EX, at(9, 10, 12));
  assert.ok(again.words.relearn.indexOf('w-001') < 0, '오늘 성공한 건 빠진다');
  assert.strictEqual(again.words.relearn.length, 7);
  assert.strictEqual(E.planDay(pack, states, EX, at(9, 10, 12), { maxRelearn: 3 }).words.relearn.length, 3, '상한 안에서');
  /* 재검증 실패 뒤엔 여전히 대기 — 오늘 다시 나온다 */
  E.recordCriterion(states['w-002'], { correct: false, confidence: 'unsure' }, at(9, 10, 12));
  assert.ok(E.planDay(pack, states, EX, at(9, 10, 13)).words.relearn.indexOf('w-002') >= 0);
});

t('E2 안정화 레인 — 회전 적게 받은 단어 우선(동률은 오래된 성공 순), 팩 앞쪽만 뽑히지 않는다', () => {
  const p = mkPack(4);
  const states = {
    w1: reachedState('w1', at(9, 1)), w2: reachedState('w2', at(9, 1)),
    w3: reachedState('w3', at(9, 2)), w4: reachedState('w4', at(9, 1))
  };
  states.w1.relearnCount = 2; states.w2.relearnCount = 1; states.w3.relearnCount = 0; states.w4.relearnCount = 0;
  const dD1 = new Date(2026, 8, 11, 9).getTime();
  const plan = E.planDay(p, states, EXAM, dD1, { maxRelearn: 3 });   // D-1: 잔여 회전 9 → 상한 3
  assert.deepStrictEqual(plan.words.relearn, ['w4', 'w3', 'w2'], '0회전(오래된 순) → 1회전 → 2회전');
  assert.deepStrictEqual(E.planDay(p, states, EXAM, d4, { maxRelearn: 3 }).words.relearn, ['w4', 'w3'], 'D-7: 9회전 ÷ 7일 = 2개');
});

t('E2 77단어 완주 — D-14 시작·매일 출석·전답이면 D-1 에 77/77 안정화 (기본 상한)', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const p = mkPack(77), states = {};
  let firstRelearnDay = null;
  for (let d = 16; d <= 29; d++) {
    const now = at(9, d);
    const plan = E.planDay(p, states, EX, now);
    if (plan.words.relearn.length && firstRelearnDay == null) firstRelearnDay = plan.dday;
    /* fresh = 4지선다 + 힌트 철자(도달 아님) / review = 미도달이면 무힌트 철자, 도달이면 재인 /
       relearn = 무힌트 철자 — gen.dailySet 의 레인 의미 그대로 */
    plan.words.fresh.forEach((id) => {
      states[id] = E.createState(id, 'word', now);
      E.recordQuiz(states[id], ok, now);
      E.recordCriterion(states[id], { correct: true, confidence: 'sure', hinted: true }, now);
    });
    plan.words.review.forEach((id) => {
      if (!states[id].reached) E.recordCriterion(states[id], ok, now); else E.recordQuiz(states[id], ok, now);
    });
    plan.words.relearn.forEach((id) => E.recordCriterion(states[id], ok, now));
    assert.ok(plan.words.relearn.length <= 47, 'D-' + plan.dday + ' 안정화 상한(77×3÷5): ' + plan.words.relearn.length);
    assert.ok(plan.words.review.length <= 20, '복습 상한');
  }
  assert.strictEqual(firstRelearnDay, 7, '안정화 회전은 D-7 부터');
  const sum = E.wordSummary(states);
  assert.strictEqual(sum.reached, 77);
  assert.strictEqual(sum.stable, 77, '전원 안정화: ' + JSON.stringify(sum));
});

t('E1 신규일 철자 실패 단어 — 복습 레인으로 계속 나오고 도달 기회(완전 인출)가 이어진다', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const p = { words: [{ id: 'w1' }], sentences: [] };
  const s = E.createState('w1', 'word', at(9, 10));
  E.recordQuiz(s, ok, at(9, 10));
  E.recordCriterion(s, { correct: false, confidence: 'unsure' }, at(9, 10));   // 철자 실패
  const p1 = E.planDay(p, { w1: s }, EX, at(9, 11));
  assert.deepStrictEqual(p1.words, { fresh: [], review: ['w1'], relearn: [] }, '손댄 미도달 단어는 복습');
  E.recordCriterion(s, ok, at(9, 11));   // gen 이 무힌트 철자를 내고 맞힘 → 도달
  assert.strictEqual(s.reached, true);
});

t('planDay — 오늘 이미 기준 성공한 단어·안정화 완료 단어는 회전에서 뺀다', () => {
  const p = mkPack(3);
  const states = {
    w1: reachedState('w1', d4),                       // 오늘(9/5) 성공 — 제외
    w2: reachedState('w2', d1),
    w3: reachedState('w3', d1)
  };
  states.w3.relearnCount = 3;                          // 안정화 완료 — 제외
  const plan = E.planDay(p, states, EXAM, d4);         // D-7
  assert.deepStrictEqual(plan.words.relearn, ['w2']);
});

t('planDay — due 지난 학습 중 단어는 review, 급한 순', () => {
  const p = mkPack(3);
  const states = {
    w1: E.createState('w1', 'word', d1),
    w2: E.createState('w2', 'word', d1),
    w3: E.createState('w3', 'word', d1)
  };
  E.recordQuiz(states.w1, ok, d1);  // due 9/3
  E.recordQuiz(states.w2, { correct: false, confidence: 'unsure' }, d1); // due +10분
  E.recordQuiz(states.w3, ok, d3);  // due 9/5 — 아직
  const plan = E.planDay(p, states, EXAM, d3);         // 9/4
  assert.deepStrictEqual(plan.words.review, ['w2', 'w1'], '만기 오래된 순');
  assert.strictEqual(plan.words.fresh.length, 0, '손댄 단어는 신규가 아니다');
});

t('E10 복습 레인 상한 — 결석 뒤 만기 60개를 다 쏟지 않고 급한 순으로 자른다', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const p = mkPack(60), states = {};
  p.words.forEach((w, i) => { states[w.id] = E.createState(w.id, 'word', at(9, 1)); E.recordQuiz(states[w.id], ok, at(9, 1) + i * 60000); });
  const plan = E.planDay(p, states, EX, at(9, 8));
  assert.strictEqual(plan.words.review.length, 20, '기본 상한 20');
  assert.deepStrictEqual(plan.words.review.slice(0, 3), ['w1', 'w2', 'w3'], '만기 오래된 순');
  assert.strictEqual(E.planDay(p, states, EX, at(9, 8), { maxReview: 5 }).words.review.length, 5);
  /* 미도달 단어가 도달 단어보다 앞선다 — 도달 기회가 급하다 */
  states.w60 = reachedState('w60', at(9, 1));
  states.w1 = reachedState('w1', at(9, 1));
  const p2 = E.planDay(p, states, EX, at(9, 8));
  assert.ok(p2.words.review.indexOf('w1') < 0 || p2.words.review.indexOf('w1') > 15, '도달 단어는 미도달 뒤로');
  assert.strictEqual(p2.words.review[0], 'w2');
});

t('planDay — 연습 모드: dday 없음, 마감 없이 due 기준', () => {
  const plan = E.planDay(mkPack(30), {}, null, d1);
  assert.strictEqual(plan.mode, 'practice');
  assert.strictEqual(plan.dday, null);
  assert.strictEqual(plan.words.fresh.length, 10, '신규 상한만 적용');
  const states = { w1: reachedState('w1', d1) };       // due 가 내일로 밀림
  const p2 = E.planDay(mkPack(1), states, null, d1b);
  assert.strictEqual(p2.words.relearn.length, 0, '연습 모드 안정화는 due 전이면 안 나온다');
  const p3 = E.planDay(mkPack(1), states, null, d2 + DAY);
  assert.deepStrictEqual(p3.words.relearn, ['w1'], 'due 지나면 나온다');
});

t('planDay — 문장은 단락 순서로 현재 단계 도전, 암송 완료는 제외', () => {
  const states = {};
  const plan = E.planDay(pack, states, null, d1);      // 픽스처: 문장 5개
  assert.strictEqual(plan.sentences.length, 5);
  assert.deepStrictEqual(plan.sentences[0], { seq: 1, stage: 1 });
  assert.strictEqual(E.planDay(pack, states, null, d1, { maxSentences: 3 }).sentences.length, 3);
  /* 1번 문장 암송 완료 → 오늘 목록에서 빠진다 */
  states[E.sentenceId(1)] = E.createState(E.sentenceId(1), 'sentence', d1);
  states[E.sentenceId(1)].stage = 6;
  E.advanceStage(states[E.sentenceId(1)], true, d1);
  const plan2 = E.planDay(pack, states, null, d1);
  assert.deepStrictEqual(plan2.sentences.map((x) => x.seq), [2, 3, 4, 5]);
});

t('E20 백지 통과 문장 — 안정화 전이고 만기면 6단계 재도전으로 다시 편성(미통과 문장 뒤에)', () => {
  const states = {};
  const s1 = E.createState(E.sentenceId(1), 'sentence', d1);
  s1.stage = 6; E.advanceStage(s1, true, d1);           // 백지 통과, due +1일
  states[s1.id] = s1;
  const plan = E.planDay(pack, states, null, d2 + DAY, { maxSentences: 10 });
  assert.deepStrictEqual(plan.sentences.map((x) => x.seq), [2, 3, 4, 5, 1]);
  assert.deepStrictEqual(plan.sentences[4], { seq: 1, stage: 6 });
  s1.relearnCount = 3;
  assert.deepStrictEqual(E.planDay(pack, states, null, d2 + DAY).sentences.map((x) => x.seq), [2, 3, 4, 5], '안정화 완료면 안 부른다');
});

t('planDay — 게이트 잠김이면 5·6단계 문장 보류, 병행 모드면 도전 (§4.4)', () => {
  const states = { 'w-001': E.createState('w-001', 'word', d1) };      // 단어 미도달
  states[E.sentenceId(1)] = E.createState(E.sentenceId(1), 'sentence', d1);
  states[E.sentenceId(1)].stage = 5;
  const locked = E.planDay(pack, states, EXAM, d1);
  assert.ok(locked.sentences.every((x) => x.seq !== 1), '5단계 문장은 오늘 목록에 없다');
  assert.ok(locked.note.indexOf('게이트 잠김') >= 0, locked.note);
  const par = E.planDay(pack, states, EXAM, d1, { parallel: true });
  assert.deepStrictEqual(par.sentences[0], { seq: 1, stage: 5 }, '병행 모드는 연다');
  assert.ok(par.note.indexOf('병행') >= 0, par.note);
});

/* ── 문장 사다리 진급·요약 (§4.2) ── */
t('advanceStage — 통과 시 1→…→6, 실패는 단계 유지', () => {
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  for (let k = 2; k <= 6; k++) {
    E.advanceStage(s, true, d1 + k * 2 * 60000);       // 세트마다 2분 간격
    assert.strictEqual(s.stage, k);
  }
  assert.strictEqual(s.reached, false, '6단계 도전 전 — 아직 암송 완료 아님');
  E.advanceStage(s, false, d1 + DAY);
  assert.strictEqual(s.stage, 6, '실패는 단계 유지');
});

t('E7 advanceStage 이중 진급 가드 — 같은 세션(1분 안·같은 session)의 두 번째 호출은 무시', () => {
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  s.stage = 4;
  E.advanceStage(s, true, d1); E.advanceStage(s, true, d1 + 20000);   // 클로즈+배열 2문항이 각각 호출
  assert.strictEqual(s.stage, 5, '4단계 세트 한 번 = 5단계(영작)로만');
  E.advanceStage(s, true, d1 + E.STAGE_GUARD_MS + 1000);
  assert.strictEqual(s.stage, 6, '1분 지나면 정상 진급');
  /* session 키가 있으면 시간과 무관하게 세션 단위로 1회 */
  const u = E.createState(E.sentenceId(2), 'sentence', d1);
  E.advanceStage(u, true, d1, { session: 'A' }); E.advanceStage(u, true, d1 + 5 * 60000, { session: 'A' });
  assert.strictEqual(u.stage, 2);
  E.advanceStage(u, true, d1 + 6 * 60000, { session: 'B' });
  assert.strictEqual(u.stage, 3, '다른 세션이면 바로 진급');
  E.advanceStage(u, true, d1 + 6 * 60000 + 1000, { session: 'C' });
  assert.strictEqual(u.stage, 4, '세션 키가 다르면 1분 안이어도 진급');
});

t('advanceStage — 6단계(백지) 통과 = 도달, 이후는 단어와 같은 안정화 규칙', () => {
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  s.stage = 6;
  E.advanceStage(s, true, d1);
  assert.strictEqual(s.reached, true);
  assert.strictEqual(s.stage, 6);
  E.advanceStage(s, true, d1b);
  assert.strictEqual(s.relearnCount, 0, '같은 날 재통과는 불인정');
  E.advanceStage(s, true, d2);
  assert.strictEqual(s.relearnCount, 1, '다른 날 재통과만 +1');
});

t('sentenceSummary — 단계 분포·해석 통과(stage≥3)·암송 완료, 본문 문장만', () => {
  const states = {};
  [1, 2, 3, 3, 5].forEach((st, i) => {
    const s = E.createState(E.sentenceId(i + 1), 'sentence', d1);
    s.stage = st;
    states[s.id] = s;
  });
  const s6 = E.createState(E.sentenceId(6), 'sentence', d1);
  s6.stage = 6;
  E.advanceStage(s6, true, d1);                        // 백지 통과
  states[s6.id] = s6;
  states.w = E.createState('w', 'word', d1);           // 단어는 제외
  states['d-01'] = E.createState('d-01', 'dialogue', d1); states['d-01'].stage = 4; // 대화문 제외(계약 0.5)
  const sum = E.sentenceSummary(states);
  assert.strictEqual(sum.total, 6);
  assert.deepStrictEqual(sum.byStage, { 1: 1, 2: 1, 3: 2, 4: 0, 5: 1, 6: 1 });
  assert.strictEqual(sum.interpreted, 4, '2단계 통과 = stage≥3');
  assert.strictEqual(sum.memorized, 1);
  /* 4.5 같은 옛 단계값이 남아 있어도 NaN 칸이 생기지 않는다 */
  const odd = E.createState(E.sentenceId(9), 'sentence', d1); odd.stage = 4.5;
  const sum2 = E.sentenceSummary({ [odd.id]: odd });
  assert.deepStrictEqual(sum2.byStage, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0 });
  assert.strictEqual(sum2.interpreted, 1);
});

/* ── 픽스처 정합 — 플랜이 실제 팩 구조 위에서 돈다 ── */
t('픽스처 팩 — 단어 8·문장 5, 진단→플랜 한 사이클', () => {
  assert.strictEqual(pack.words.length, 8);
  assert.strictEqual(pack.sentences.length, 5);
  const states = {};
  pack.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', d1); });
  E.applyDiagnostic(states, pack.words.slice(0, 3).map((w) => ({ id: w.id, known: true })), d1);
  const plan = E.planDay(pack, states, EXAM, d1);
  assert.strictEqual(plan.words.fresh.length, 2, '미도달 5개 ÷ 잔여 4일 = 올림 2');
  assert.strictEqual(plan.words.relearn.length, 3, '진단 통과 3개는 D-10 이어도 철자 재검증 편성');
  assert.strictEqual(E.wordSummary(states).needsSpellCheck, 3, '진단 통과 3개는 철자 재검증 대기');
});

console.log('\n통과 ' + passed + '개 — naesin 암기 엔진 검증 완료');
