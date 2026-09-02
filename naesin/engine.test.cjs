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

/* n개짜리 합성 팩 — planDay 분배 검증용 (픽스처 팩은 8단어뿐이라 부족) */
function mkPack(n) {
  const words = [];
  for (let i = 1; i <= n; i++) words.push({ id: 'w' + i });
  return { words, sentences: [] };
}
function reachedState(id, now) {
  const s = E.createState(id, 'word', now);
  return E.recordCriterion(s, { correct: true, confidence: 'sure' }, now);
}

/* ── 상태 생성 ── */
t('createState — 단어엔 stage 없음, 문장은 stage 1, due=now', () => {
  const w = E.createState('w-001', 'word', d1);
  assert.strictEqual(w.step, 0);
  assert.strictEqual(w.due, d1);
  assert.strictEqual(w.reached, false);
  assert.strictEqual(w.lastCriterionDate, null);
  assert.ok(!('stage' in w), '단어에 stage 가 생기면 안 된다');
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  assert.strictEqual(s.stage, 1);
});

/* ── 판정 퀴즈 SRS (§4.1) ── */
t('정답+확실 — 압축 간격표 1→2→3→5→7일, 상한 유지', () => {
  const s = E.createState('w', 'word', d1);
  let now = d1;
  [1, 2, 3, 5, 7].forEach((days, i) => {
    E.recordQuiz(s, { correct: true, confidence: 'sure' }, now);
    assert.strictEqual(s.step, i + 1);
    assert.strictEqual(s.due, now + days * DAY);
    now = s.due;
  });
  E.recordQuiz(s, { correct: true, confidence: 'sure' }, now);
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
t('완전 인출 최초 성공 — 도달 기록(reached·reachedAt·lastCriterionDate)', () => {
  const s = E.createState('w', 'word', d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1);
  assert.strictEqual(s.reached, true);
  assert.strictEqual(s.reachedAt, d1);
  assert.strictEqual(s.lastCriterionDate, '2026-09-02');
  assert.strictEqual(s.relearnCount, 0, '도달은 안정화 0회전에서 시작');
});

t("안정화의 '다른 날' 규칙 — 같은 날 재성공은 불인정, 다른 날만 +1", () => {
  const s = E.createState('w', 'word', d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1);      // 도달
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1b);     // 같은 날 저녁
  assert.strictEqual(s.relearnCount, 0, '같은 날 두 번째 성공은 안 센다');
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d2);
  assert.strictEqual(s.relearnCount, 1);
  assert.strictEqual(s.lastCriterionDate, '2026-09-03');
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d3);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d4);
  assert.strictEqual(s.relearnCount, 3);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d4 + DAY);
  assert.strictEqual(s.relearnCount, 3, '상한 3');
});

t('stability 0~3 게이지 · isStable — 도달 전엔 0', () => {
  const s = E.createState('w', 'word', d1);
  s.relearnCount = 2;               // 도달 전 오염값이 있어도
  assert.strictEqual(E.stability(s), 0, '도달 전엔 게이지 0');
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d1);
  E.recordCriterion(s, { correct: true, confidence: 'sure' }, d2);
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
  E.recordCriterion(states.a, { correct: true, confidence: 'sure' }, d2);
  assert.strictEqual(states.a.needsSpellCheck, false);
  assert.strictEqual(states.a.relearnCount, 1, '재검증 성공은 다른 날이므로 안정화 1회전');
});

/* ── 단어 요약 ── */
t('wordSummary — 도달·안정·위험(오답 3+ 또는 과신)·철자재검증 집계', () => {
  const states = {};
  states.a = reachedState('a', d1);                                   // 도달만
  states.b = reachedState('b', d1);                                   // 안정화 완료
  E.recordCriterion(states.b, { correct: true, confidence: 'sure' }, d2);
  E.recordCriterion(states.b, { correct: true, confidence: 'sure' }, d3);
  E.recordCriterion(states.b, { correct: true, confidence: 'sure' }, d4);
  states.c = E.createState('c', 'word', d1); states.c.wrong = 3;      // 오답 다수
  states.d = E.createState('d', 'word', d1); states.d.overconfident = 1; // 과신
  states.e = E.createState('e', 'word', d1); states.e.needsSpellCheck = true;
  states.s1 = E.createState(E.sentenceId(1), 'sentence', d1);         // 문장은 제외
  const sum = E.wordSummary(states);
  assert.deepStrictEqual(sum, { total: 5, reached: 2, stable: 1, risky: 2, needsSpellCheck: 1 });
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
  E.recordCriterion(states.b, { correct: true, confidence: 'sure' }, d1);
  g = E.gate(states, EXAM, d1);
  assert.deepStrictEqual(g, { open: true, reason: 'reached', done: 2, total: 2 });
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

/* ── 오답노트 클리어 (§5.4) ── */
t('오답 클리어 — 같은 날 연속 정답은 1회, 서로 다른 날 2회에 클리어', () => {
  const s = E.createState('w', 'word', d1);
  assert.deepStrictEqual(E.clearWrong(s, d1), { cleared: false, days: 1 });
  assert.deepStrictEqual(E.clearWrong(s, d1b), { cleared: false, days: 1 }, '같은 날 재정답은 안 쌓인다');
  const r = E.clearWrong(s, d2);
  assert.deepStrictEqual(r, { cleared: true, days: 2 });
  assert.deepStrictEqual(s.wrongClearDates, ['2026-09-02', '2026-09-03']);
});

/* ── 오늘의 플랜 (§5.4 회복 편성 + §14-1 안정화 배분) ── */
t('planDay — 시험 10일 전 미도달 30개 → 마감(D-7)까지 3일, 하루 10개', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d1);   // 9/2, 시험 9/12
  assert.strictEqual(plan.mode, 'exam');
  assert.strictEqual(plan.dday, 10);
  assert.strictEqual(plan.words.fresh.length, 10);
  assert.deepStrictEqual(plan.words.fresh.slice(0, 3), ['w1', 'w2', 'w3'], '팩 순서대로');
});

t('planDay — 매일 전면 재계산: 진도가 나가면 다음 날 몫이 잔량/잔여일로 다시 나온다', () => {
  const p = mkPack(30);
  const states = {};
  for (let i = 1; i <= 10; i++) states['w' + i] = reachedState('w' + i, d1);
  const plan = E.planDay(p, states, EXAM, d2);        // D-9: 미도달 20, 잔여 2일
  assert.strictEqual(plan.words.fresh.length, 10);
  assert.strictEqual(plan.words.fresh[0], 'w11');
});

t('planDay — 결석해도 빚 목록 없음: 잔량을 다시 나누고 상한만 지킨다', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d3);   // D-8: 이틀 밀림, 잔여 1일에 30개
  assert.strictEqual(plan.words.fresh.length, 10, '하루 상한 10 유지');
  const plan2 = E.planDay(mkPack(30), {}, EXAM, d3, { maxNewWords: 15 });
  assert.strictEqual(plan2.words.fresh.length, 15, '상한은 opts로 조정');
});

t('planDay — 마감 경과 후 미도달 잔여는 회복 편성으로 계속 나온다', () => {
  const d6 = new Date(2026, 8, 8, 9, 0, 0).getTime(); // D-4, 마감(9/5) 지남
  const plan = E.planDay(mkPack(4), {}, EXAM, d6);
  assert.strictEqual(plan.words.fresh.length, 4);
  assert.ok(plan.note.indexOf('회복 편성') >= 0, '플랜 노트에 회복 편성 표기: ' + plan.note);
});

t('planDay — 안정화 회전은 D-7~D-1에만, 잔여 회전/잔여일로 배분 (§14-1)', () => {
  const p = mkPack(6);
  const states = {};
  for (let i = 1; i <= 6; i++) states['w' + i] = reachedState('w' + i, d1);
  /* D-8(9/4): 전원 도달이어도 안정화 구간 전 — 배분 없음 */
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
  E.recordQuiz(states.w1, { correct: true, confidence: 'sure' }, d1);  // due 9/3
  E.recordQuiz(states.w2, { correct: false, confidence: 'unsure' }, d1); // due +10분
  E.recordQuiz(states.w3, { correct: true, confidence: 'sure' }, d3);  // due 9/5 — 아직
  const plan = E.planDay(p, states, EXAM, d3);         // 9/4
  assert.deepStrictEqual(plan.words.review, ['w2', 'w1'], '만기 오래된 순');
  assert.strictEqual(plan.words.fresh.length, 0, '손댄 단어는 신규가 아니다');
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
    E.advanceStage(s, true, d1);
    assert.strictEqual(s.stage, k);
  }
  assert.strictEqual(s.reached, false, '6단계 도전 전 — 아직 암송 완료 아님');
  E.advanceStage(s, false, d1);
  assert.strictEqual(s.stage, 6, '실패는 단계 유지');
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

t('sentenceSummary — 단계 분포·해석 통과(stage≥3)·암송 완료', () => {
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
  const sum = E.sentenceSummary(states);
  assert.strictEqual(sum.total, 6);
  assert.deepStrictEqual(sum.byStage, { 1: 1, 2: 1, 3: 2, 4: 0, 5: 1, 6: 1 });
  assert.strictEqual(sum.interpreted, 4, '2단계 통과 = stage≥3');
  assert.strictEqual(sum.memorized, 1);
});

/* ── 픽스처 정합 — 플랜이 실제 팩 구조 위에서 돈다 ── */
t('픽스처 팩 — 단어 8·문장 5, 진단→플랜 한 사이클', () => {
  assert.strictEqual(pack.words.length, 8);
  assert.strictEqual(pack.sentences.length, 5);
  const states = {};
  pack.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', d1); });
  E.applyDiagnostic(states, pack.words.slice(0, 3).map((w) => ({ id: w.id, known: true })), d1);
  const plan = E.planDay(pack, states, EXAM, d1);
  assert.strictEqual(plan.words.fresh.length, 2, '미도달 5개 ÷ 잔여 3일 = 올림 2');
  assert.strictEqual(E.wordSummary(states).needsSpellCheck, 3, '진단 통과 3개는 철자 재검증 대기');
});

console.log('\n통과 ' + passed + '개 — naesin 암기 엔진 검증 완료');
