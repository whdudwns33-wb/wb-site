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
/* 청크 트랙(뜻 세우기)을 통과시켜 둔다 — 재설계 §3.4에서 그 단락 문장 사다리는 청크 트랙이
   reached 여야 1단계도 열린다. 문장 사다리만 보는 검증들은 이 준비를 깔고 예전 기대를 지킨다. */
function passChunks(states, p, now) {
  E.dayGroups(p || pack).forEach((g) => {
    const s = E.createState(E.chunkId(g.day), 'chunk', now);
    s.stage = 3;
    E.advanceStage(s, true, now, { fromStage: 3 });
    states[s.id] = s;
  });
  return states;
}
/* 범위 플랜 항목에서 packId 를 떼어 낸다 — planDay 항목과 모양을 맞춰 비교하려고 */
function noPack(x) {
  const o = {};
  Object.keys(x).forEach((k) => { if (k !== 'packId') o[k] = x[k]; });
  return o;
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
  assert.strictEqual(s.cue, 1, '사다리를 갖는 상태는 단서 농도 1(빈칸+첫 글자)에서 시작(§3.3)');
  assert.ok(!('cue' in w), '단어에 단서 농도가 생기면 안 된다');
});

t('createState — 청크 트랙·단락 관문 kind (재설계 §3.1)', () => {
  const ck = E.createState(E.chunkId('8/1'), 'chunk', d1);
  const pg = E.createState(E.paraId('8/1'), 'para', d1);
  assert.strictEqual(ck.id, 'ck-8/1');
  assert.strictEqual(pg.id, 'pg-8/1');
  assert.deepStrictEqual([ck.stage, ck.cue, ck.reached], [1, 1, false]);
  assert.deepStrictEqual([pg.stage, pg.cue, pg.reached], [1, 1, false]);
  /* 둘 다 3단(청크: 듣기·인출·순서 / 관문: 줄거리·어색한 곳·백지)이고 마지막 통과가 reached */
  assert.strictEqual(E.stageMaxOf(ck), 3);
  assert.strictEqual(E.stageMaxOf(pg), 3);
  assert.strictEqual(E.stageMaxOf(E.createState('s-1', 'sentence', d1)), 6, '문장은 6단 그대로');
  ck.stage = 9;
  assert.strictEqual(E.stageOf(ck), 3, '범위 밖 값도 3으로 눌러 읽는다');
  /* 단어 집계·게이트·문장 집계 어디에도 섞이지 않는다 */
  const states = { ck: ck, pg: pg, w: reachedState('w', d1), s1: E.createState(E.sentenceId(1), 'sentence', d1) };
  assert.deepStrictEqual(E.wordSummary(states), { total: 1, reached: 1, stable: 0, risky: 0, needsSpellCheck: 0 });
  assert.strictEqual(E.gate(states, { examDate: '2026-09-12' }, d1).total, 1, '게이트 분모는 단어만');
  assert.strictEqual(E.sentenceSummary(states).total, 1, '문장 집계도 문장만');
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

t('E20 게이트 — 시험이 지났거나 examDate 가 없으면 연습과 같다(D-0 은 아직 시험)', () => {
  const states = { a: E.createState('a', 'word', d1) };
  assert.strictEqual(E.gate(states, { examDate: '2026-09-01' }, d1).reason, 'practice', '시험 지남');
  assert.strictEqual(E.gate(states, { examDate: '2026-09-02' }, d1).reason, 'word-gate', 'D-0(시험 당일)은 잠긴 채');
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
t('planDay — 시험 10일 전 미도달 30개 → 마감(D-7) 하루 전까지 3일, 하루 10개', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d1);   // 9/2, 시험 9/12
  assert.strictEqual(plan.mode, 'exam');
  assert.strictEqual(plan.dday, 10);
  /* 신규는 마감 당일이 아니라 그 하루 전까지 나눈다 — 마감 당일 처음 꺼낸 단어는
     그날 도달(무힌트 철자는 다음 날 복습 레인)할 수 없어 마감을 못 지킨다 */
  assert.strictEqual(plan.words.fresh.length, 10, '30개 ÷ 3일');
  assert.deepStrictEqual(plan.words.fresh.slice(0, 3), ['w1', 'w2', 'w3'], '팩 순서대로');
});

t('planDay — 매일 전면 재계산: 진도가 나가면 다음 날 몫이 잔량/잔여일로 다시 나온다', () => {
  const p = mkPack(30);
  const states = {};
  for (let i = 1; i <= 10; i++) states['w' + i] = reachedState('w' + i, d1);
  const plan = E.planDay(p, states, EXAM, d2);        // D-9: 미도달 20, 마감 하루 전까지 2일
  assert.strictEqual(plan.words.fresh.length, 10);
  assert.strictEqual(plan.words.fresh[0], 'w11');
});

t('planDay — 결석해도 빚 목록 없음: 잔량을 마감까지 다시 나눈다(기본 상한이 마감을 막지 않는다)', () => {
  const plan = E.planDay(mkPack(30), {}, EXAM, d3);   // D-8: 이틀 밀림, 마감 하루 전까지 1일
  assert.strictEqual(plan.words.fresh.length, 30, '마감을 지키려면 오늘 30개 — 그 사실을 감추지 않는다');
  assert.ok(plan.note.indexOf('하루 신규 30개 필요') >= 0, '필요량을 노트에 그대로: ' + plan.note);
  const plan2 = E.planDay(mkPack(30), {}, EXAM, d3, { maxNewWords: 15 });
  assert.strictEqual(plan2.words.fresh.length, 15, '상한은 opts로 조정(명시가 이긴다)');
  assert.ok(plan2.note.indexOf('신규 상한 15개 — 마감까지 도달 어려움') >= 0, plan2.note);
});

t('E20 마감 경계 — D-7 당일은 아직 마감 안이고(경과 표시 없음), D-6부터 회복 편성', () => {
  const p = mkPack(20);
  const dD7 = new Date(2026, 8, 5, 9).getTime(), dD6 = new Date(2026, 8, 6, 9).getTime();
  const p7 = E.planDay(p, {}, EXAM, dD7);
  assert.strictEqual(p7.dday, 7);
  assert.strictEqual(p7.words.fresh.length, 20, '마감 당일 = 남은 전부');
  assert.ok(p7.note.indexOf('회복 편성') < 0, 'D-7 은 경과가 아니다: ' + p7.note);
  const p6 = E.planDay(p, {}, EXAM, dD6);
  assert.strictEqual(p6.words.fresh.length, 20);
  assert.ok(p6.note.indexOf('회복 편성') >= 0, 'D-6 부터 경과: ' + p6.note);
});

t('planDay — 마감 경과 후 미도달 잔여는 회복 편성으로 계속 나온다', () => {
  const d6 = new Date(2026, 8, 8, 9, 0, 0).getTime(); // D-4, 마감(9/5) 지남
  const plan = E.planDay(mkPack(4), {}, EXAM, d6);
  assert.strictEqual(plan.words.fresh.length, 4);
  assert.ok(plan.note.indexOf('회복 편성') >= 0, '플랜 노트에 회복 편성 표기: ' + plan.note);
});

t('E20 시험 후 모드 — 시험이 지나야(D-1 이하) 신규 편성 없이 자율 복습(after)', () => {
  const p = mkPack(20);
  const states = { w1: reachedState('w1', d1) };
  [new Date(2026, 8, 13, 9).getTime(), new Date(2026, 8, 14, 9).getTime()].forEach((now) => {
    const plan = E.planDay(p, states, EXAM, now);
    assert.strictEqual(plan.mode, 'after');
    assert.ok(plan.dday < 0);
    assert.deepStrictEqual(plan.words.fresh, [], '신규 없음');
    assert.deepStrictEqual(plan.words.relearn, ['w1'], '만기 도달 단어는 자율 복습');
    assert.ok(plan.note.indexOf('시험 종료 — 자율 복습') >= 0, plan.note);
    assert.ok(plan.note.indexOf('게이트') < 0, '시험 후엔 게이트 없음');
  });
  assert.strictEqual(E.planDay(p, {}, { examDate: undefined }, d1).mode, 'practice', 'examDate 없으면 연습');
});

/* 시험 당일 아침이 마지막 복습 기회다 — 여기서 편성이 0이 되면 그날 학습이 통째로 빈다 */
t('D-0(시험 당일) — 아직 시험 모드, 단어 편성이 0이 아니고 게이트도 잠긴 채', () => {
  const p = mkPack(20);
  const states = { w1: reachedState('w1', d1) };
  const dExam = new Date(2026, 8, 12, 8).getTime();   // 9/12 아침 = D-0
  const plan = E.planDay(p, states, EXAM, dExam);
  assert.strictEqual(plan.mode, 'exam');
  assert.strictEqual(plan.dday, 0);
  const n = plan.words.fresh.length + plan.words.review.length + plan.words.relearn.length;
  assert.ok(n > 0, '시험 당일 편성이 비면 안 된다: ' + JSON.stringify(plan.words));
  assert.ok(plan.words.fresh.length > 0, '미도달 잔량은 마감 경과 회복 편성으로 오늘 다 나온다');
  assert.ok(plan.note.indexOf('D-0') >= 0, plan.note);
  assert.strictEqual(E.gate({ a: E.createState('a', 'word', d1) }, EXAM, dExam).open, false, 'D-0 게이트는 잠긴 채');
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
  const states = passChunks({}, pack, d1);             // 청크 트랙 통과 후에야 사다리가 열린다
  const plan = E.planDay(pack, states, null, d1);      // 픽스처: 문장 5개
  assert.strictEqual(plan.sentences.length, 5);
  assert.deepStrictEqual(plan.sentences[0], { kind: 'sentence', seq: 1, stage: 1 });
  assert.strictEqual(E.planDay(pack, states, null, d1, { maxSentences: 3 }).sentences.length, 3);
  /* 1번 문장 암송 완료 → 오늘 목록에서 빠진다 */
  states[E.sentenceId(1)] = E.createState(E.sentenceId(1), 'sentence', d1);
  states[E.sentenceId(1)].stage = 6;
  E.advanceStage(states[E.sentenceId(1)], true, d1);
  const plan2 = E.planDay(pack, states, null, d1);
  assert.deepStrictEqual(plan2.sentences.map((x) => x.seq), [2, 3, 4, 5]);
});

t('E20 백지 통과 문장 — 안정화 전이고 만기면 6단계 재도전으로 다시 편성(미통과 문장 뒤에)', () => {
  const states = passChunks({}, pack, d1);
  const s1 = E.createState(E.sentenceId(1), 'sentence', d1);
  s1.stage = 6; E.advanceStage(s1, true, d1);           // 백지 통과, due +1일
  states[s1.id] = s1;
  const plan = E.planDay(pack, states, null, d2 + DAY, { maxSentences: 10 });
  assert.deepStrictEqual(plan.sentences.map((x) => x.seq), [2, 3, 4, 5, 1]);
  assert.deepStrictEqual(plan.sentences[4], { kind: 'sentence', seq: 1, stage: 6 });
  s1.relearnCount = 3;
  assert.deepStrictEqual(E.planDay(pack, states, null, d2 + DAY).sentences.map((x) => x.seq), [2, 3, 4, 5], '안정화 완료면 안 부른다');
});

t('planDay — 게이트 잠김이면 5·6단계 문장 보류, 병행 모드면 도전 (§4.4)', () => {
  const states = passChunks({ 'w-001': E.createState('w-001', 'word', d1) }, pack, d1);  // 단어 미도달
  states[E.sentenceId(1)] = E.createState(E.sentenceId(1), 'sentence', d1);
  states[E.sentenceId(1)].stage = 5;
  const locked = E.planDay(pack, states, EXAM, d1);
  assert.ok(locked.sentences.every((x) => x.seq !== 1), '5단계 문장은 오늘 목록에 없다');
  assert.ok(locked.note.indexOf('게이트 잠김') >= 0, locked.note);
  const par = E.planDay(pack, states, EXAM, d1, { parallel: true });
  assert.deepStrictEqual(par.sentences[0], { kind: 'sentence', seq: 1, stage: 5 }, '병행 모드는 연다');
  assert.ok(par.note.indexOf('병행') >= 0, par.note);
});

t('E19 planDay — 옛 상태의 비정수·범위 밖 단계(4.5·9·x)는 1~6 정수로 읽어 편성한다(dailySet 정수 키와 같은 눈)', () => {
  const states = passChunks({}, pack, d1);
  const s2 = E.createState(E.sentenceId(2), 'sentence', d1); s2.stage = 4.5; states[s2.id] = s2;
  const s3 = E.createState(E.sentenceId(3), 'sentence', d1); s3.stage = 9; states[s3.id] = s3;
  const s4 = E.createState(E.sentenceId(4), 'sentence', d1); s4.stage = 'x'; states[s4.id] = s4;
  const plan = E.planDay(pack, states, null, d1);
  const by = {}; plan.sentences.forEach((x) => { by[x.seq] = x.stage; });
  assert.deepStrictEqual([by[2], by[3], by[4]], [4, 6, 1]);
  /* 4.5 는 5 미만 — 게이트 잠김에도 보류되지 않는다 */
  const lockedStates = passChunks({ 'w-001': E.createState('w-001', 'word', d1) }, pack, d1);
  lockedStates[s2.id] = s2; lockedStates[s3.id] = s3;
  const locked = E.planDay(pack, lockedStates, EXAM, d1);
  assert.ok(locked.sentences.some((x) => x.seq === 2 && x.stage === 4));
  assert.ok(!locked.sentences.some((x) => x.seq === 3), '9→6 단계는 게이트 잠김에 보류');
});

/* ── 통합 시험 범위(여러 과) — planRange · gateRange · rangeSummary (계약 R3) ──
   실제 학교 시험 범위는 보통 2~3과다. 과별로 planDay를 돌려 합치면 하루 할당도 마감도
   과 수만큼 불어나므로, 범위 전체를 한 단위로 배분하는지가 여기서 검증할 핵심이다. */

/* 샘플 팩을 id·lesson만 바꿔 복제 — 커밋 가능한 유일한 팩으로 2과 범위를 만든다 */
function clonePack(id, lesson) {
  const p = JSON.parse(JSON.stringify(pack));
  p.packId = id; p.lesson = lesson;
  return p;
}
/* 학생 앱 ensureStates 와 같게 팩 전량에 상태를 미리 만든다(last == null 이라 편성은 그대로) */
function seedEntry(id, lesson) {
  const p = clonePack(id, lesson), states = {};
  p.words.forEach((w) => { states[w.id] = E.createState(w.id, 'word', d1); });
  p.sentences.forEach((s) => { const k = E.sentenceId(s.seq); states[k] = E.createState(k, 'sentence', d1); });
  return { packId: id, pack: p, states, rec: { cumulative: {}, check: null } };
}
/* 플랜 항목 하나를 '통과'로 소화한다 — 학생 앱이 다섯 종류를 처리하는 자리와 같다.
   청크·관문 상태는 없으면 그때 만든다(앱의 ensureStates 자리). */
function runItem(e, x, now) {
  const st = (id, kind) => {
    if (!e.states[id]) e.states[id] = E.createState(id, kind, now);
    return e.states[id];
  };
  if (x.kind === 'chunk') return E.advanceStage(st(E.chunkId(x.day), 'chunk'), true, now, { fromStage: x.stage });
  if (x.kind === 'para') return E.advanceStage(st(E.paraId(x.day), 'para'), true, now, { fromStage: x.stage });
  if (x.kind === 'cumulative') { e.rec.cumulative[x.lastDay] = { at: now, okCount: 1, total: 1, score: 100 }; return null; }
  if (x.kind === 'check') { e.rec.check = { at: now, correct: 8, total: 8 }; return null; }
  const s = e.states[E.sentenceId(x.seq)];
  if (!E.isCueStage(x.stage)) return E.advanceStage(s, true, now, { fromStage: x.stage });
  /* 단서 단계는 한 세션 안에서 단서를 끝까지 돌린다(앱 권장 리듬 — 문장당 6세션) */
  for (let i = 0; i < 4 && E.stageOf(s) === x.stage && !s.reached; i++) {
    E.recordCue(s, true, now, { session: 'cue' + now + '#' + x.seq + '#' + i, fromStage: x.stage });
  }
  return s;
}
/* n단어 합성 팩 — 상한 검증용 (단어 id는 과마다 달라야 합산 결과가 읽힌다) */
function mkRangePack(id, lesson, prefix, n) {
  const words = [];
  for (let i = 1; i <= n; i++) words.push({ id: prefix + i });
  return { packId: id, lesson, words, sentences: [] };
}

t('planRange — 과가 하나면 planDay와 같은 편성(하위 호환)', () => {
  const e = seedEntry('sample-L6', 6);
  const single = E.planDay(e.pack, e.states, EXAM, d1);
  const r = E.planRange([e], EXAM, d1);
  assert.strictEqual(r.mode, single.mode);
  assert.strictEqual(r.dday, single.dday);
  assert.strictEqual(r.note, single.note, '과가 하나면 범위 표기도 붙지 않는다');
  assert.deepStrictEqual(r.words.fresh.map((x) => x.id), single.words.fresh);
  assert.deepStrictEqual(r.words.review.map((x) => x.id), single.words.review);
  assert.deepStrictEqual(r.words.relearn.map((x) => x.id), single.words.relearn);
  assert.deepStrictEqual(r.perPack['sample-L6'].words, single.words, 'perPack은 dailySet에 그대로 넘길 모양');
  assert.deepStrictEqual(r.sentences.map(noPack), single.sentences, 'packId만 더 붙는다(항목 모양 동일)');
  assert.deepStrictEqual(r.perPack['sample-L6'].sentences, single.sentences);
  assert.ok(r.words.fresh.every((x) => x.packId === 'sample-L6'), '항목마다 packId가 붙는다');
});

t('planRange — 신규는 범위 잔량 ÷ 마감으로 한 번 산정하고, 과가 갈마들어 한 과가 독식하지 않는다', () => {
  const A = { packId: 'L6', pack: mkRangePack('L6', 6, 'a', 30), states: {} };
  const B = { packId: 'L7', pack: mkRangePack('L7', 7, 'b', 30), states: {} };
  const r = E.planRange([A, B], EXAM, d1);            // D-10: 마감 하루 전까지 3일에 60개
  assert.strictEqual(r.words.fresh.length, 20, '범위 60개 ÷ 3일 — 과마다 따로 나누지 않는다');
  assert.strictEqual(r.perPack.L6.words.fresh.length, 10);
  assert.strictEqual(r.perPack.L7.words.fresh.length, 10, '두 과가 절반씩');
  assert.deepStrictEqual(r.words.fresh.slice(0, 4), [
    { packId: 'L6', id: 'a1' }, { packId: 'L7', id: 'b1' },
    { packId: 'L6', id: 'a2' }, { packId: 'L7', id: 'b2' }
  ], '과 → 팩 안 순번으로 갈마든다');
  assert.ok(r.note.indexOf('L6·L7 범위') >= 0, '범위가 여러 과임을 노트에 밝힌다: ' + r.note);
  assert.ok(r.note.indexOf('하루 신규 20개 필요') >= 0, '필요량을 그대로 보여 준다: ' + r.note);
});

t('planRange — 복습·문장 상한은 범위 전체에 한 번(과별 planDay 합의 절반)', () => {
  const t0 = at(9, 1);
  function dueLearning(id, lesson, prefix, n) {
    const pk = mkRangePack(id, lesson, prefix, n), states = {};
    pk.words.forEach((w) => {
      states[w.id] = E.createState(w.id, 'word', t0);
      E.recordQuiz(states[w.id], { correct: false, confidence: 'unsure' }, t0);   // 학습 중 + 만기
    });
    return { packId: id, pack: pk, states };
  }
  const A = dueLearning('L6', 6, 'a', 30), B = dueLearning('L7', 7, 'b', 30);
  const r = E.planRange([A, B], EXAM, d1);
  assert.strictEqual(r.words.review.length, 20, '범위 전체 복습 상한 20 — 과별 20+20=40이 아니다');
  assert.strictEqual(r.perPack.L6.words.review.length, 10);
  assert.strictEqual(r.perPack.L7.words.review.length, 10, '두 과가 갈마들어 절반씩');
  assert.strictEqual(E.planDay(A.pack, A.states, EXAM, d1).words.review.length, 20, '과별로 부르면 각자 20');
});

t('planDay·planRange — 신규 기본 상한은 잔량·마감에서 자동 산정(범위가 커지면 따라 오른다)', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const now = at(9, 16);                               // D-14 — 마감 하루 전까지 7일
  const one = { packId: 'L6', pack: mkRangePack('L6', 6, 'a', 77), states: {} };
  const two = { packId: 'L7', pack: mkRangePack('L7', 7, 'b', 77), states: {} };
  assert.strictEqual(E.planDay(one.pack, one.states, EX, now).words.fresh.length, 11,
    '단일 과 77단어 = 77÷7 — 옛 고정 상한 10과 사실상 같다');
  assert.strictEqual(E.planRange([one, two], EX, now).words.fresh.length, 22,
    '2과 154단어면 상한이 따라 오른다 — 고정 10이면 마감까지 다 못 나간다');
  assert.strictEqual(E.planRange([one, two], EX, now, { maxNewWords: 12 }).words.fresh.length, 12,
    '명시 상한이 이긴다');
  assert.ok(E.planRange([one, two], EX, now, { maxNewWords: 12 }).note.indexOf('신규 상한 12개 — 마감까지 도달 어려움') >= 0);
  /* 연습 모드는 마감이 없다 — 자동 산정할 분모가 없으니 하루 10개 고정 */
  assert.strictEqual(E.planRange([one, two], null, now).words.fresh.length, 10);
  assert.strictEqual(E.planDay(one.pack, one.states, null, now).words.fresh.length, 10);
});

t('planRange — 문장은 팩 순서 → seq 순, 상한도 범위 전체에 한 번', () => {
  const A = seedEntry('L6', 6), B = seedEntry('L7', 7);
  [A, B].forEach((e) => passChunks(e.states, e.pack, d1));   // 청크 트랙을 지나야 문장이 나온다
  const r = E.planRange([A, B], null, d1, { maxSentences: 7 });
  assert.deepStrictEqual(r.sentences.map((x) => x.packId + '#' + x.seq),
    ['L6#1', 'L6#2', 'L6#3', 'L6#4', 'L6#5', 'L7#1', 'L7#2']);
  assert.deepStrictEqual(r.perPack.L7.sentences,
    [{ kind: 'sentence', seq: 1, stage: 1 }, { kind: 'sentence', seq: 2, stage: 1 }],
    'perPack 문장은 상한에 잘린 뒤의 진짜 오늘 몫');
  assert.strictEqual(E.planRange([A, B], null, d1).sentences.length, 5, '기본 상한 5 — 과별 5+5가 아니다');
});

t('planRange — 5·6단계 보류는 그 과의 단어 게이트로 판단(실전 모의만 범위 전체·§4.4)', () => {
  const A = seedEntry('L6', 6), B = seedEntry('L7', 7);
  [A, B].forEach((e) => passChunks(e.states, e.pack, d1));
  A.pack.words.forEach((w) => E.recordCriterion(A.states[w.id], ok, d1));   // L6만 단어 완성
  A.states[E.sentenceId(1)].stage = 5;
  B.states[E.sentenceId(1)].stage = 5;
  const r = E.planRange([A, B], EXAM, d2, { maxSentences: 20 });
  assert.ok(r.sentences.some((x) => x.packId === 'L6' && x.seq === 1), 'L6는 단어 완성 → 5단계 도전');
  assert.ok(!r.sentences.some((x) => x.packId === 'L7' && x.seq === 1), 'L7은 잠김 → 5단계 보류');
  assert.strictEqual(r.perPack.L7.sentences.length, 4);
  assert.ok(r.note.indexOf('게이트 잠김') >= 0, r.note);
  /* 범위 전체 게이트(실전 모의)는 아직 닫혀 있다 — L7이 남았다 */
  assert.strictEqual(E.gateRange([A, B], EXAM, d2).open, false);
});

t('gateRange — 범위 전체 단어 합산, 완료 기준은 isDone(철자 재검증 포함)', () => {
  const A = seedEntry('L6', 6), B = seedEntry('L7', 7);
  A.pack.words.forEach((w) => E.recordCriterion(A.states[w.id], ok, d1));
  let g = E.gateRange([A, B], EXAM, d1);
  assert.deepStrictEqual([g.open, g.reason, g.done, g.total], [false, 'word-gate', 8, 16],
    '한 과만 끝나선 실전 모의가 안 열린다');
  assert.strictEqual(E.gate(A.states, EXAM, d1).open, true, '그 과만 보는 기존 게이트는 열려 있다');
  assert.strictEqual(E.gateRange([A, A], EXAM, d1).total, 8, '같은 packId 중복은 한 번만 센다');
  B.pack.words.forEach((w) => E.recordCriterion(B.states[w.id], ok, d1));
  g = E.gateRange([A, B], EXAM, d1);
  assert.deepStrictEqual([g.open, g.reason, g.done, g.total], [true, 'reached', 16, 16]);
  const C = seedEntry('L8', 8);
  E.applyDiagnostic(C.states, C.pack.words.map((w) => ({ id: w.id, known: true })), d1);
  const g3 = E.gateRange([A, B, C], EXAM, d1);
  assert.deepStrictEqual([g3.done, g3.total, g3.open], [16, 24, false], '진단 통과분(철자 미검증)은 도달로 안 센다');
  assert.strictEqual(E.gateRange([A, C], null, d1).reason, 'practice');
  assert.strictEqual(E.gateRange([A, C], { examDate: '2026-09-01' }, d1).reason, 'practice', '시험이 지났으면 게이트 없음');
  assert.strictEqual(E.gateRange([A, C], EXAM, d1, { override: true }).reason, 'override');
  assert.strictEqual(E.gateRange([A, C], EXAM, d1, { parallel: true }).reason, 'parallel');
});

t('rangeSummary — 범위 합계 + 과별 값(계약 R1 summary.range)', () => {
  const A = seedEntry('L6', 6), B = seedEntry('L7', 7);
  [d1, d2, d3, d4].forEach((n) => E.recordCriterion(A.states['w-001'], ok, n));   // 안정화 3회전
  E.applyDiagnostic(A.states, [{ id: 'w-002', known: true }], d1);                // 철자 재검증 대기
  A.states[E.sentenceId(1)].stage = 3;
  B.states[E.sentenceId(1)].stage = 6;
  E.advanceStage(B.states[E.sentenceId(1)], true, d1);                            // 백지 통과
  const r = E.rangeSummary([A, B]);
  assert.deepStrictEqual(r, {
    packIds: ['L6', 'L7'],
    word: { total: 16, reached: 1, stable: 1, risky: 0, needsSpellCheck: 1 },
    sentence: { total: 10, interpreted: 2, memorized: 1, byStage: { 1: 8, 2: 0, 3: 1, 4: 0, 5: 0, 6: 1 } },
    /* 본문 진행(§3.6) — 두 과 각 2단락, 청크 재료가 있으니 분모 4·4 */
    passage: { chunkDone: 0, chunkTotal: 4, paraBlank: 0, paraTotal: 4, cumulative: 0, check: null },
    packs: {
      L6: { word: { total: 8, reached: 1, stable: 1 }, sentence: { total: 5, interpreted: 1, memorized: 0 } },
      L7: { word: { total: 8, reached: 0, stable: 0 }, sentence: { total: 5, interpreted: 1, memorized: 1 } }
    }
  });
});

t('planRange — 빈 과도 perPack 키를 갖고, 잘못된 엔트리·중복 packId는 걸러진다', () => {
  const A = seedEntry('L6', 6);
  const B = { packId: 'L7', pack: mkRangePack('L7', 7, 'b', 0), states: {} };
  const r = E.planRange([A, B, null, A], EXAM, d1);
  assert.deepStrictEqual(Object.keys(r.perPack), ['L6', 'L7'], '범위 순서 유지');
  assert.deepStrictEqual(r.perPack.L7, { words: { fresh: [], review: [], relearn: [] }, sentences: [] });
  assert.strictEqual(r.words.fresh.length, 3, '중복 엔트리를 두 번 세지 않는다(미도달 8 ÷ 3일 = 3, 중복이면 6)');
  const empty = E.planRange([], EXAM, d1);
  assert.deepStrictEqual(empty.words, { fresh: [], review: [], relearn: [] });
  assert.deepStrictEqual([empty.sentences, empty.perPack, empty.mode], [[], {}, 'exam']);
});

t('E-R 2과 범위 완주 — D-14 시작·매일 출석·전답이면 두 과가 함께 도달·안정화', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const entries = [seedEntry('sample-L6', 6), seedEntry('sample-L7', 7)];
  /* 본문 상한은 넘기지 않는다 — 시험 모드에서는 엔진이 잔여 작업량÷잔여일로 스스로 정한다
     (옛 고정 5로는 새 사다리가 14일에 안 끝난다). 단어 편성은 상한과 무관하다. */
  const OPT = {};
  let reachDay = null, stableDay = null, maxGap = 0, firstRelearn = null, senMax = 0;
  for (let d = 16; d <= 29; d++) {                    // 9/16(D-14) ~ 9/29(D-1)
    const now = at(9, d);
    const plan = E.planRange(entries, EX, now, OPT);
    assert.ok(plan.words.fresh.length <= 10, 'D-' + plan.dday + ' 신규 상한(범위 전체 10)');
    assert.ok(plan.words.review.length <= 20, '복습 상한');
    assert.ok(plan.words.relearn.length <= 15, '안정화 상한(16×3÷5 → 최소 15)');
    assert.ok(plan.sentences.length <= 20, '자동 산정 상한 안: ' + plan.sentences.length);
    senMax = Math.max(senMax, plan.sentences.length);
    if (plan.words.relearn.length && firstRelearn == null) firstRelearn = plan.dday;
    const load = entries.map((e) => {
      const w = plan.perPack[e.packId].words;
      return w.fresh.length + w.review.length + w.relearn.length;
    });
    maxGap = Math.max(maxGap, Math.abs(load[0] - load[1]));
    entries.forEach((e) => {
      const pp = plan.perPack[e.packId];
      /* gen.dailySet 레인 의미 그대로: fresh = 4지선다+힌트 철자(도달 아님) /
         review = 미도달이면 무힌트 철자, 도달이면 재인 / relearn = 무힌트 철자 */
      pp.words.fresh.forEach((id) => {
        E.recordQuiz(e.states[id], ok, now);
        E.recordCriterion(e.states[id], { correct: true, confidence: 'sure', hinted: true }, now);
      });
      pp.words.review.forEach((id) => {
        if (!e.states[id].reached) E.recordCriterion(e.states[id], ok, now); else E.recordQuiz(e.states[id], ok, now);
      });
      pp.words.relearn.forEach((id) => E.recordCriterion(e.states[id], ok, now));
      pp.sentences.forEach((x) => runItem(e, x, now));
    });
    const sum = E.rangeSummary(entries);
    if (reachDay == null && sum.word.reached === sum.word.total) reachDay = plan.dday;
    if (stableDay == null && sum.word.stable === sum.word.total) stableDay = plan.dday;
  }
  assert.strictEqual(firstRelearn, 7, '안정화 회전은 범위 전체가 D-7 부터');
  assert.ok(maxGap <= 2, '한 과가 다른 과를 굶기지 않는다(하루 몫 차이 ' + maxGap + ')');
  const sum = E.rangeSummary(entries);
  assert.deepStrictEqual(sum.word, { total: 16, reached: 16, stable: 16, risky: 0, needsSpellCheck: 0 },
    '두 과 단어 전량 안정화: ' + JSON.stringify(sum.word));
  assert.strictEqual(sum.sentence.memorized, 10, '두 과 문장 전량 백지 통과');
  /* 본문 세 층이 모두 끝난다: 청크 트랙 4단락 · 단락 백지 4단락 · 누적 2+2 · 종합 Check */
  assert.deepStrictEqual(sum.passage,
    { chunkDone: 4, chunkTotal: 4, paraBlank: 4, paraTotal: 4, cumulative: 4, check: { correct: 16, total: 16 } },
    JSON.stringify(sum.passage));
  assert.ok(reachDay >= 7, '마감(D-7)까지 두 과 전량 도달 — 실제 D-' + reachDay);
  assert.strictEqual(stableDay, 1, 'D-1 에 전량 안정화');
});

t('E-R 2과 77단어 범위(154) — 자동 산정 상한이 마감을 지킨다(고정 상한 10이면 130개에서 멈췄다)', () => {
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const entries = [
    { packId: 'big-L6', pack: mkRangePack('big-L6', 6, 'a', 77), states: {} },
    { packId: 'big-L7', pack: mkRangePack('big-L7', 7, 'b', 77), states: {} }
  ];
  entries.forEach((e) => e.pack.words.forEach((w) => { e.states[w.id] = E.createState(w.id, 'word', d1); }));
  let reachDay = null, stableDay = null, maxNew = 0, maxRev = 0, maxRe = 0, gap = 0;
  for (let d = 16; d <= 29; d++) {
    const now = at(9, d);
    const plan = E.planRange(entries, EX, now);
    maxNew = Math.max(maxNew, plan.words.fresh.length);
    maxRev = Math.max(maxRev, plan.words.review.length);
    maxRe = Math.max(maxRe, plan.words.relearn.length);
    const load = entries.map((e) => {
      const w = plan.perPack[e.packId].words;
      return w.fresh.length + w.review.length + w.relearn.length;
    });
    gap = Math.max(gap, Math.abs(load[0] - load[1]));
    if (plan.dday === 14) assert.ok(plan.note.indexOf('하루 신규 22개 필요') >= 0, plan.note);
    entries.forEach((e) => {
      const pp = plan.perPack[e.packId];
      pp.words.fresh.forEach((id) => {
        E.recordQuiz(e.states[id], ok, now);
        E.recordCriterion(e.states[id], { correct: true, confidence: 'sure', hinted: true }, now);
      });
      pp.words.review.forEach((id) => {
        if (!e.states[id].reached) E.recordCriterion(e.states[id], ok, now); else E.recordQuiz(e.states[id], ok, now);
      });
      pp.words.relearn.forEach((id) => E.recordCriterion(e.states[id], ok, now));
    });
    const sum = E.rangeSummary(entries);
    if (reachDay == null && sum.word.reached === sum.word.total) reachDay = plan.dday;
    if (stableDay == null && sum.word.stable === sum.word.total) stableDay = plan.dday;
  }
  assert.ok(reachDay >= 7, '마감(D-7)까지 154개 전량 도달 — 실제 D-' + reachDay);
  assert.strictEqual(stableDay, 1, 'D-1 에 전량 안정화');
  assert.deepStrictEqual(E.rangeSummary(entries).word,
    { total: 154, reached: 154, stable: 154, risky: 0, needsSpellCheck: 0 });
  assert.deepStrictEqual([maxNew, maxRev], [22, 22], '하루 신규·복습 최대 (154 ÷ 7일)');
  assert.ok(maxRe <= 93, '안정화 상한(154×3÷5) 안: ' + maxRe);
  assert.ok(gap <= 2, '두 과의 하루 부담이 갈린다(최대 차 ' + gap + ')');
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

t('E7 advanceStage fromStage — 세트의 단계를 밝히면 1분 안의 빠른 정상 진급은 통과, 지난 단계용 세트만 무시', () => {
  const s = E.createState(E.sentenceId(3), 'sentence', d1);
  s.stage = 3;
  E.advanceStage(s, true, d1, { fromStage: 3 });                 // 3단계 세트 통과
  E.advanceStage(s, true, d1 + 45000, { fromStage: 4 });         // 45초 뒤 4단계 세트(클로즈+배열) 통과
  assert.strictEqual(s.stage, 5, '1분 안이어도 다른 단계 세트면 정상 진급');
  E.advanceStage(s, true, d1 + 50000, { fromStage: 4 });         // 같은 4단계 세트가 문항마다 부른 두 번째
  assert.strictEqual(s.stage, 5, '이미 지난 단계용 세트는 무시');
  E.advanceStage(s, true, d1 + 60000, { fromStage: '5' });       // 문자열 단계도 받는다
  assert.strictEqual(s.stage, 6);
  E.advanceStage(s, false, d1 + 70000, { fromStage: 6 });
  assert.strictEqual(s.reached, false, '실패는 단계용 옵션과 무관하게 유지');
  /* 옵션 없는 호출은 시간 안전판에 걸린다 — 앱이 fromStage 를 넘겨야 빠른 학생이 막히지 않는다 */
  const u = E.createState(E.sentenceId(4), 'sentence', d1); u.stage = 3;
  E.advanceStage(u, true, d1); E.advanceStage(u, true, d1 + 45000);
  assert.strictEqual(u.stage, 4, '옵션 없이 1분 안 두 번째 호출은 무시(안전판)');
});

/* 옛 상태에 4.5 같은 비정수 단계가 남아 있어도 planDay·sentenceSummary(stageOf 내림)와
   같은 눈으로 읽어야 한다 — 원시값을 비교하면 fromStage 4가 영영 안 맞아 진급이 막히고,
   session 경로에선 5.5→6.5로 비정수가 번져 dailySet이 문항을 못 만든다 */
t('advanceStage — 비정수 단계(4.5)는 stageOf(내림)로 읽어 정수로 진급한다', () => {
  const a = E.createState(E.sentenceId(11), 'sentence', d1); a.stage = 4.5;
  E.advanceStage(a, true, d1, { fromStage: 4 });
  assert.strictEqual(a.stage, 5, 'planDay가 준 단계(4)와 맞아 진급');
  assert.strictEqual(a.stageAdvancedFrom, 4);

  const b = E.createState(E.sentenceId(12), 'sentence', d1); b.stage = 4.5;
  E.advanceStage(b, true, d1, { session: 'A' });
  assert.strictEqual(b.stage, 5, '세션 경로도 정수로 떨어진다');
  E.advanceStage(b, true, d1 + 5000, { session: 'A' });
  assert.strictEqual(b.stage, 5, '같은 세션 두 번째는 무시');
  E.advanceStage(b, true, d1 + 6 * 60000, { session: 'B' });
  assert.strictEqual(b.stage, 6);

  const c = E.createState(E.sentenceId(13), 'sentence', d1); c.stage = 6.5;
  E.advanceStage(c, true, d1, { fromStage: 6 });
  assert.strictEqual(c.reached, true, '6 초과도 6으로 눌러 백지 통과로 처리');
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

t('sentenceSummary — 단계 분포·해석 통과(stage≥2)·암송 완료, 본문 문장만', () => {
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
  /* 재설계 §3.2 — 새 1단계가 '줄 해석'이라 그 한 단을 통과하면 해석이 된 것이다.
     옛 기준(stage≥3)이면 못 읽는 학생의 진도가 두 단 뒤에야 화면에 뜬다. */
  assert.strictEqual(sum.interpreted, 5, '1단계(줄 해석) 통과 = stage≥2');
  assert.strictEqual(sum.memorized, 1);
  /* 4.5 같은 옛 단계값이 남아 있어도 NaN 칸이 생기지 않는다 */
  const odd = E.createState(E.sentenceId(9), 'sentence', d1); odd.stage = 4.5;
  const sum2 = E.sentenceSummary({ [odd.id]: odd });
  assert.deepStrictEqual(sum2.byStage, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0 });
  assert.strictEqual(sum2.interpreted, 1);
  /* 청크 트랙·단락 관문은 kind가 달라 문장 집계에 섞이지 않는다(§3.1) */
  const mixed = { [odd.id]: odd };
  mixed['ck-8/1'] = E.createState('ck-8/1', 'chunk', d1);
  mixed['pg-8/1'] = E.createState('pg-8/1', 'para', d1);
  assert.strictEqual(E.sentenceSummary(mixed).total, 1);
});

/* ── 본문 재설계 — 뜻 먼저, 청크 → 줄 → 단락 (재설계 명세 §1~§4.E) ──────────────
   전제: 학생이 영어를 못 읽는다. 옛 사다리는 2단계가 '한글로 해석해 쓰기'라 첫날 막혔다.
   여기서 검증할 것은 셋이다 — 뜻(청크)이 먼저 서고, 단서가 점진적으로 지워지고,
   단위가 청크 → 줄 → 단락으로 올라간다. */

t('chunkGate — 청크 트랙을 통과해야 그 단락 문장 사다리가 1단계도 열린다 (§3.4)', () => {
  const states = {};
  const g0 = E.chunkGate(pack, states, '8/1');
  assert.deepStrictEqual([g0.open, g0.reason, g0.stage, g0.total], [false, 'chunk-gate', 1, 3]);
  const plan = E.planDay(pack, states, null, d1, { maxSentences: 10 });
  assert.deepStrictEqual(plan.sentences, [
    { kind: 'chunk', day: '8/1', stage: 1 }, { kind: 'chunk', day: '8/2', stage: 1 }
  ], '문장은 하나도 없고 단락별 청크 트랙만 나온다');

  /* 청크 트랙은 3세션(듣고 짝 맞추기 → 뜻 인출 → 순서 세우기) 뒤에 통과다 */
  const ck = E.createState(E.chunkId('8/1'), 'chunk', d1);
  states[ck.id] = ck;
  E.advanceStage(ck, true, d1, { fromStage: 1 });
  assert.strictEqual(E.chunkGate(pack, states, '8/1').open, false, '2세션째 — 아직 잠김');
  E.advanceStage(ck, true, d1 + 60000, { fromStage: 2 });
  E.advanceStage(ck, true, d1 + 120000, { fromStage: 3 });
  assert.deepStrictEqual([ck.stage, ck.reached], [3, true], '3세션 통과 = 트랙 reached');
  assert.strictEqual(E.chunkGate(pack, states, '8/1').reason, 'reached');
  assert.strictEqual(E.chunkGate(pack, states, '8/2').open, false, '다른 단락은 그대로 잠김');

  const p2 = E.planDay(pack, states, null, d1, { maxSentences: 10 });
  assert.deepStrictEqual(p2.sentences.map((x) => x.kind + (x.seq || '')),
    ['chunk', 'sentence1', 'sentence2', 'sentence3'], '열린 단락 문장만 사다리에 오른다');

  /* 청크 재료가 없는 팩(옛 팩)은 잠그지 않는다 — 열 방법이 없는 자물쇠는 본문 탭을 통째로 잠근다 */
  const noCk = JSON.parse(JSON.stringify(pack));
  noCk.sentences.forEach((s) => { s.chunks = []; });
  assert.strictEqual(E.chunkGate(noCk, {}, '8/1').reason, 'no-chunk');
  assert.deepStrictEqual(E.planDay(noCk, {}, null, d1, { maxSentences: 10 }).sentences.map((x) => x.seq),
    [1, 2, 3, 4, 5]);
});

t('청크 트랙은 단어 게이트를 받지 않는다 — 못 읽는 학생의 첫 자리가 여기다', () => {
  const states = { 'w-001': E.createState('w-001', 'word', d1) };   // 단어 미도달 → 게이트 잠김
  const plan = E.planDay(pack, states, EXAM, d1, { maxSentences: 10 });
  assert.ok(plan.note.indexOf('게이트 잠김') >= 0, plan.note);
  assert.deepStrictEqual(plan.sentences.map((x) => x.kind), ['chunk', 'chunk'],
    '단어를 하나도 못 외웠어도 뜻 세우기는 오늘 시작한다');
});

t('paraGate — 단락 문장이 전부 stage >= need 여야 관문이 열린다 (§3.4)', () => {
  const states = passChunks({}, pack, d1);
  const g0 = E.paraGate(pack, states, '8/1', 2);
  assert.deepStrictEqual([g0.open, g0.reason, g0.done, g0.total, g0.need], [false, 'stage-gate', 0, 3, 2]);
  [1, 2, 3].forEach((seq) => {
    const s = E.createState(E.sentenceId(seq), 'sentence', d1);
    s.stage = 2; states[s.id] = s;
  });
  assert.strictEqual(E.paraGate(pack, states, '8/1', 2).open, true, '전부 stage≥2 → 줄거리 개방');
  assert.strictEqual(E.paraGate(pack, states, '8/1', 5).open, false, '어색한 곳·백지는 stage≥5부터');
  states[E.sentenceId(1)].stage = 6;
  E.advanceStage(states[E.sentenceId(1)], true, d1, { fromStage: 6 });
  assert.strictEqual(E.paraGate(pack, states, '8/1', 5).done, 1, '백지 통과 문장은 최고 단계로 센다');
  assert.strictEqual(E.paraGate(pack, states, '8/1').need, 2, '기본 need 는 줄거리 기준 2');
  assert.strictEqual(E.paraGate(pack, states, '없는날', 2).reason, 'empty', '없는 단락은 열리지 않는다');
});

t('cue — 통과하면 단서가 줄고 실패하면 늘어난다, 진급은 cue 0 통과에서만 (§3.3)', () => {
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  assert.strictEqual(E.cueOf(s), 1, '기본 1 = 빈칸+첫 글자');
  assert.strictEqual(E.cueOf({ kind: 'sentence', stage: 3 }), 1, '필드 없는 옛 상태도 1로 읽는다');
  assert.deepStrictEqual([E.isCueStage(1), E.isCueStage(3), E.isCueStage(5)], [true, true, true]);
  assert.deepStrictEqual([E.isCueStage(2), E.isCueStage(4), E.isCueStage(6)], [false, false, false]);

  /* 실패 — 단서가 한 겹 늘고 단계는 유지된다(실패로 내려가지 않는다) */
  const r1 = E.recordCue(s, false, d1);
  assert.deepStrictEqual([r1.before, r1.cue, r1.stage, r1.advanced], [1, 2, 1, false]);
  E.recordCue(s, false, d1 + 60000);
  E.recordCue(s, false, d1 + 120000);
  assert.strictEqual(E.cueOf(s), E.CUE_MAX, '상한 3 = 전문을 보여 주고 그대로 옮겨 쓰기(전사)');

  /* 통과 — 한 겹씩 지운다. 단계는 그대로 */
  [2, 1, 0].forEach((want) => {
    const r = E.recordCue(s, true, d2);
    assert.strictEqual(r.cue, want);
    assert.strictEqual(r.advanced, false);
    assert.strictEqual(s.stage, 1, '단서가 남아 있는 동안은 같은 단계를 다시 본다');
  });
  /* cue 0 통과에서만 진급하고, 다음 단계는 다시 단서 1에서 시작한다 */
  const up = E.recordCue(s, true, d3);
  assert.deepStrictEqual([up.before, up.advanced, up.stage, up.cue], [0, true, 2, 1]);

  /* advanceStage 단독 호출도 faded 를 밝히면 단서를 지킨다 */
  const u = E.createState(E.sentenceId(2), 'sentence', d1);
  E.advanceStage(u, true, d1, { faded: true, fromStage: 1 });
  assert.strictEqual(u.stage, 1, '단서가 남았으면 진급 없음');
  E.advanceStage(u, true, d1, { fromStage: 1 });
  assert.deepStrictEqual([u.stage, u.cue], [2, 1], 'faded 를 안 밝힌 단계(2·4·6)는 예전대로 한 번에');
});

t('recordCue — 기존 이중 진급 가드 유지(같은 session 두 번째 호출은 무시)', () => {
  const s = E.createState(E.sentenceId(1), 'sentence', d1);
  s.cue = 0;
  E.recordCue(s, true, d1, { session: 'A', fromStage: 1 });
  assert.strictEqual(s.stage, 2, '단서 0 통과 → 진급');
  const dup = E.recordCue(s, true, d1 + 5000, { session: 'A', fromStage: 2 });
  assert.deepStrictEqual([dup.duplicate, s.stage], [true, 2], '같은 세션 두 번째 호출은 무시');
  /* 단서만 지우는 호출도 세션당 한 번 — 한 세트가 문항마다 부르면 힌트가 두 겹 사라진다 */
  const u = E.createState(E.sentenceId(2), 'sentence', d1);
  u.cue = 2;
  E.recordCue(u, true, d1, { session: 'B' });
  E.recordCue(u, true, d1 + 5000, { session: 'B' });
  assert.strictEqual(E.cueOf(u), 1);
  E.recordCue(u, true, d1 + 10000, { session: 'C' });
  assert.strictEqual(E.cueOf(u), 0, '다른 세션이면 다시 한 겹');
  /* 6단계(단락 백지)에서 cue 0 통과는 도달 — 단어와 같은 안정화 규칙을 탄다 */
  const v = E.createState(E.sentenceId(3), 'sentence', d1);
  v.stage = 6; v.cue = 0;
  const r = E.recordCue(v, true, d1);
  assert.deepStrictEqual([r.advanced, r.reached, v.reached], [true, true, true]);
});

t('못 읽는 학생 경로 — 영어를 한 글자도 쓰지 않고 청크 트랙과 1단계(줄 해석)를 통과한다 (§5)', () => {
  /* 영어 입력이 필요한 항목(2단계 이상·단락 관문)은 아예 손대지 않는다.
     한글만 다루는 항목 = 청크 트랙 3세션 + 문장 1단계(줄 해석, 단서 1→0 두 번). */
  const states = {}, rec = { cumulative: {}, check: null };
  let touched = 0;
  for (let d = 0; d < 8; d++) {
    const now = d1 + d * DAY;
    const plan = E.planDay(pack, states, null, now, { maxSentences: 10, rec: rec });
    plan.sentences.forEach((x) => {
      if (x.kind === 'chunk') {
        if (!states[E.chunkId(x.day)]) states[E.chunkId(x.day)] = E.createState(E.chunkId(x.day), 'chunk', now);
        E.advanceStage(states[E.chunkId(x.day)], true, now, { fromStage: x.stage });
        touched += 1;
        return;
      }
      if (x.kind !== 'sentence' || x.stage !== 1) return;   // 영어를 써야 하는 항목은 건너뛴다
      const id = E.sentenceId(x.seq);
      if (!states[id]) states[id] = E.createState(id, 'sentence', now);
      E.recordCue(states[id], true, now, { session: 'day' + d + '#' + x.seq, fromStage: 1 });
      touched += 1;
    });
  }
  const sum = E.sentenceSummary(states);
  assert.strictEqual(sum.interpreted, 5, '5문장 전부 해석 통과: ' + JSON.stringify(sum.byStage));
  assert.deepStrictEqual(sum.byStage, { 1: 0, 2: 5, 3: 0, 4: 0, 5: 0, 6: 0 }, '2단계에서 멈춘다(영어 배열은 안 했다)');
  const p = E.passageSummary(pack, states, rec);
  assert.deepStrictEqual([p.chunkDone, p.chunkTotal], [2, 2], '두 단락 청크 트랙 통과');
  assert.ok(touched >= 16, '실제로 밟은 세션 수 ' + touched);
});

t('passageSummary — 청크·단락 백지·누적·종합 (§3.6)', () => {
  const states = {};
  assert.deepStrictEqual(E.passageSummary(pack, states),
    { chunkDone: 0, chunkTotal: 2, paraBlank: 0, paraTotal: 2, cumulative: 0, check: null },
    '기록을 안 넘기면 누적은 미시작·종합은 null');
  passChunks(states, pack, d1);
  const pg = E.createState(E.paraId('8/1'), 'para', d1);
  pg.stage = 3; E.advanceStage(pg, true, d1, { fromStage: 3 }); states[pg.id] = pg;
  const rec = {
    cumulative: { '8/1': { at: d1, okCount: 3, total: 3, score: 100 } },
    check: { at: d1, correct: '7', total: 8 }
  };
  assert.deepStrictEqual(E.passageSummary(pack, states, rec),
    { chunkDone: 2, chunkTotal: 2, paraBlank: 1, paraTotal: 2, cumulative: 1, check: { correct: 7, total: 8 } },
    '문자열 숫자도 정수로 눌러 담는다(요약은 서버·강사 화면으로 간다)');
  assert.strictEqual(E.passageSummary(pack, states, { cumulative: { '8/2': {} } }).cumulative, 0,
    '앞을 건너뛴 누적 기록은 진행으로 안 본다');
  /* 청크 재료가 없는 단락은 분모에서 빠진다 — 못 여는 자물쇠를 진도로 세지 않는다 */
  const noCk = JSON.parse(JSON.stringify(pack));
  noCk.sentences.forEach((s) => { if (s.dayGroup === '8/2') s.chunks = []; });
  assert.deepStrictEqual([E.passageSummary(noCk, {}).chunkTotal, E.passageSummary(noCk, {}).paraTotal], [1, 2]);
});

t('planDay — 본문 후보는 청크 → 문장 → 단락 관문 → 누적 → 종합 순서다 (§4.E.6)', () => {
  const states = {};
  const ck = E.createState(E.chunkId('8/2'), 'chunk', d1);
  ck.stage = 3; E.advanceStage(ck, true, d1, { fromStage: 3 }); states[ck.id] = ck;
  [4, 5].forEach((seq) => {
    const s = E.createState(E.sentenceId(seq), 'sentence', d1);
    s.stage = 2; states[s.id] = s;
  });
  const plan = E.planDay(pack, states, null, d1, { maxSentences: 10 });
  assert.deepStrictEqual(plan.sentences, [
    { kind: 'chunk', day: '8/1', stage: 1 },
    { kind: 'sentence', seq: 4, stage: 2 },
    { kind: 'sentence', seq: 5, stage: 2 },
    { kind: 'para', day: '8/2', step: 'summary', stage: 1 }
  ], JSON.stringify(plan.sentences));
  assert.strictEqual(E.planDay(pack, states, null, d1, { maxSentences: 2 }).sentences.length, 2,
    '상한은 다섯 종류 전체에 한 번 걸린다');

  /* 모든 단락이 백지를 통과해야 누적·종합이 열리고, 누적은 1일차 → 1+2일차 순서로만 */
  const done = passChunks({}, pack, d1);
  E.dayGroups(pack).forEach((g) => {
    const s = E.createState(E.paraId(g.day), 'para', d1);
    s.stage = 3; E.advanceStage(s, true, d1, { fromStage: 3 }); done[s.id] = s;
  });
  pack.sentences.forEach((sn) => {
    const s = E.createState(E.sentenceId(sn.seq), 'sentence', d1);
    s.stage = 6; E.advanceStage(s, true, d1, { fromStage: 6 }); done[s.id] = s;
  });
  const run = (rec) => E.planDay(pack, done, null, d1, { maxSentences: 10, rec: rec }).sentences;
  assert.deepStrictEqual(run(null), [{ kind: 'cumulative', lastDay: '8/1' }], '누적은 1일차부터');
  assert.deepStrictEqual(run({ cumulative: { '8/1': { at: d1 } } }), [{ kind: 'cumulative', lastDay: '8/2' }],
    '1일차를 밟아야 1+2일차가 열린다');
  const full = { cumulative: { '8/1': {}, '8/2': {} } };
  assert.deepStrictEqual(run(full), [{ kind: 'check' }], '누적을 다 밟아야 종합 Check');
  full.check = { at: d1, correct: 8, total: 8 };
  assert.deepStrictEqual(run(full), [], '끝난 뒤엔 더 부르지 않는다');
  /* 단락 백지가 하나라도 남아 있으면 누적·종합은 없다 */
  delete done[E.paraId('8/2')];
  assert.ok(run(null).every((x) => x.kind !== 'cumulative' && x.kind !== 'check'));
});

t('planDay — 본문 상한은 시험 모드에서 잔여 작업량 ÷ 잔여일로 자동 산정한다', () => {
  /* 픽스처: 2단락·5문장. 잔여 = 청크 2×3 + 문장 5×6 + 관문 2×3 = 42.
     누적·종합은 하루 한 칸씩 직렬이라 날짜를 먼저 뗀다: tailDays = 단락 2 + 종합 1 = 3.
     D-10 → 사다리에 쓸 날 7 → ceil(42/7)=6, 누적 자리 +1 → 하루 7칸.
     이 역산이 없으면 42/10 = 5칸이 되어 마지막 3일에 누적만 남고 종합까지 못 간다. */
  const plan = E.planDay(pack, {}, EXAM, d1);
  assert.strictEqual(plan.dday, 10);
  assert.ok(plan.note.indexOf('하루 본문 7칸 필요') >= 0, plan.note);
  /* 연습 모드는 마감이 없다 — 나눌 분모가 없으니 예전대로 하루 5 고정 */
  assert.ok(E.planDay(pack, {}, null, d1).note.indexOf('하루 본문') < 0);
  assert.strictEqual(E.planDay(pack, passChunks({}, pack, d1), null, d1).sentences.length, 5, '연습 모드 5 고정');
  /* 잔여일이 줄면 하루 몫이 따라 오른다(매 호출 전면 재계산 — '밀린 것'을 만들지 않는다) */
  const late = E.planDay(pack, {}, EXAM, at(9, 9));            // D-3
  assert.ok(late.note.indexOf('하루 본문 43칸 필요') >= 0, late.note);
  /* 명시 상한이 이기고, 못 지킬 상한이면 그 사실을 노트가 밝힌다 */
  const capped = E.planDay(pack, passChunks({}, pack, d1), EXAM, d1, { maxSentences: 3 });
  assert.strictEqual(capped.sentences.length, 3);
  assert.ok(capped.note.indexOf('본문 상한 3칸 — 시험 전 완료 어려움') >= 0, capped.note);
});

t('planDay — 단락 관문·누적·종합은 상한에 먼저 자리를 뗀다(문장이 잘린다)', () => {
  const states = passChunks({}, pack, d1);
  pack.sentences.forEach((sn) => {
    const s = E.createState(E.sentenceId(sn.seq), 'sentence', d1);
    s.stage = 5; states[s.id] = s;                    // 두 단락 모두 stage 5 → 관문 개방
  });
  const plan = E.planDay(pack, states, null, d1, { maxSentences: 3 });
  assert.deepStrictEqual(plan.sentences.map((x) => x.kind), ['sentence', 'para', 'para'],
    '관문 2칸을 떼고 남은 1칸에 문장 — 뒤로 밀리면 그날이 통째로 날아간다');
  /* 백지 재도전(redo)은 맨 뒤 — 이미 통과한 문장의 회전이 새 땅을 밀어내지 않는다 */
  const done = passChunks({}, pack, d1);
  pack.sentences.forEach((sn) => {
    const s = E.createState(E.sentenceId(sn.seq), 'sentence', d1);
    s.stage = 6; E.advanceStage(s, true, d1, { fromStage: 6 }); done[s.id] = s;
  });
  const p2 = E.planDay(pack, done, null, d2 + DAY, { maxSentences: 10 });   // due 지남 → redo 5
  const kinds = p2.sentences.map((x) => x.kind);
  assert.strictEqual(kinds.indexOf('para') < kinds.indexOf('sentence'), true,
    '관문이 redo 앞: ' + JSON.stringify(p2.sentences));
  assert.strictEqual(p2.sentences.filter((x) => x.kind === 'sentence').length, 5, 'redo 5개는 뒤에 그대로');
});

t('planDay — 손대지 않은 문장이 세 칸에 한 칸은 들어온다(꼬리 굶주림 완화)', () => {
  /* seq 순으로만 채우면 앞 문장이 정체할 때 뒤 문장은 상한에 밀려 영영 1단계도 못 받는다.
     25문장 팩 시뮬레이션에서 해석이 5/25에서 멈추던 자리다. */
  const states = passChunks({}, pack, d1);
  [1, 2].forEach((seq) => {
    const s = E.createState(E.sentenceId(seq), 'sentence', d1);
    s.stage = 2; s.last = d1; states[s.id] = s;       // 이미 손댄 문장
  });
  const plan = E.planDay(pack, states, null, d1, { maxSentences: 10 });
  assert.deepStrictEqual(plan.sentences.map((x) => x.seq), [3, 1, 2, 4, 5],
    '손대지 않은 3번이 첫 칸 — 이후 세 칸에 한 칸씩');
  assert.deepStrictEqual(E.planDay(pack, states, null, d1, { maxSentences: 3 }).sentences.map((x) => x.seq),
    [3, 1, 2], '상한 3에서도 새 문장이 한 자리를 갖는다');
  /* 전부 손대지 않았으면 예전 그대로 seq 순 */
  assert.deepStrictEqual(E.planDay(pack, passChunks({}, pack, d1), null, d1).sentences.map((x) => x.seq),
    [1, 2, 3, 4, 5]);
});

t('cue — 한 겹씩 기록해도 한 세션에서 끝까지 돌려도 같은 자리에 닿는다', () => {
  /* 앱이 화면 한 번에 단서를 두 라운드 돌리든(문장당 6세션) 하루 한 겹씩 지우든(9세션)
     엔진은 둘 다 받는다 — 리듬은 화면이 정하고 엔진은 단서 수만 센다. */
  const a = E.createState(E.sentenceId(1), 'sentence', d1);      // 하루 한 겹씩
  E.recordCue(a, true, d1, { session: 'a1', fromStage: 1 });
  E.recordCue(a, true, d2, { session: 'a2', fromStage: 1 });
  const b = E.createState(E.sentenceId(2), 'sentence', d1);      // 한 세션 안에서 끝까지
  E.recordCue(b, true, d1, { session: 'b1', fromStage: 1 });
  E.recordCue(b, true, d1, { session: 'b2', fromStage: 1 });
  assert.deepStrictEqual([a.stage, a.cue], [2, 1]);
  assert.deepStrictEqual([b.stage, b.cue], [2, 1], '같은 자리에 닿는다');
  /* 전사(3)에서 시작해도 한 세션에서 네 번 돌리면 진급한다 */
  const c = E.createState(E.sentenceId(3), 'sentence', d1);
  c.cue = 3;
  for (let i = 0; i < 4; i++) E.recordCue(c, true, d1, { session: 'c' + i, fromStage: 1 });
  assert.deepStrictEqual([c.stage, c.cue], [2, 1]);
});

t('하위 호환 — 문장 항목의 {seq, stage} 는 그대로고 kind 만 늘었다 (§4.E.6)', () => {
  const states = passChunks({}, pack, d1);
  const plan = E.planDay(pack, states, null, d1);
  assert.deepStrictEqual(plan.sentences.map((x) => ({ seq: x.seq, stage: x.stage })),
    [1, 2, 3, 4, 5].map((seq) => ({ seq: seq, stage: 1 })), '옛 소비자가 읽던 두 필드가 그대로다');
  plan.sentences.forEach((x) => { assert.strictEqual(x.kind, 'sentence'); });
  assert.strictEqual(E.STAGE_MAX, 6, '단계 수는 6 그대로 — 서버 화이트리스트·관리 매트릭스를 건드리지 않는다');
  /* 단서·kind 필드가 없는 옛 상태도 그대로 돈다 */
  const old = { id: E.sentenceId(1), kind: 'sentence', stage: 3, reached: false, due: d1, relearnCount: 0 };
  const st2 = passChunks({ [old.id]: old }, pack, d1);
  assert.deepStrictEqual(E.planDay(pack, st2, null, d1).sentences[0], { kind: 'sentence', seq: 1, stage: 3 });
  E.advanceStage(old, true, d1, { fromStage: 3 });
  assert.deepStrictEqual([old.stage, old.cue], [4, 1], '옛 상태도 진급하면서 단서 필드를 갖는다');
  /* 범위 요약의 옛 필드는 그대로고 passage 만 늘었다 */
  const r = E.rangeSummary([{ packId: 'L6', pack: pack, states: st2 }]);
  assert.deepStrictEqual(Object.keys(r), ['packIds', 'word', 'sentence', 'passage', 'packs']);
  assert.deepStrictEqual(Object.keys(r.packs.L6), ['word', 'sentence'], '과별 값의 모양은 그대로');
});

t('E-P 25문장·5단락 완주 — D-14 시작이면 누적 백지·종합 Check까지 시험 전에 끝난다', () => {
  /* 실제 과 규모(25문장·5단락·77단어)에서 자동 상한이 마감을 지키는지가 이 검증의 핵심이다.
     학생 앱과 같은 고리로 돈다: 하루 시작에 상한(=오늘 분량)을 정하고, 한 세션이 끝날 때마다
     플랜을 다시 계산해 맨 앞 항목을 집는다(render() → rangePlan(Date.now())). */
  const EX = { examDate: '2026-09-30', wordDeadlineDays: 7 };
  const words = [], sentences = [];
  for (let i = 1; i <= 77; i++) words.push({ id: 'w' + i });
  for (let p = 1; p <= 5; p++) for (let k = 0; k < 5; k++) {
    const s = JSON.parse(JSON.stringify(pack.sentences[k]));
    s.seq = (p - 1) * 5 + k + 1; s.dayGroup = '8/' + p; sentences.push(s);
  }
  const big = { packId: 'big', lesson: 6, words, sentences };
  const e = { packId: 'big', pack: big, states: {}, rec: { cumulative: {}, check: null } };
  big.words.forEach((w) => { e.states[w.id] = E.createState(w.id, 'word', at(9, 16)); });
  big.sentences.forEach((s) => { const k = E.sentenceId(s.seq); e.states[k] = E.createState(k, 'sentence', at(9, 16)); });

  let peak = 0, doneDay = null;
  for (let d = 16; d <= 29; d++) {
    const now = at(9, d);
    const plan = E.planDay(big, e.states, EX, now, { rec: e.rec });
    const wN = plan.words.fresh.length + plan.words.review.length + plan.words.relearn.length;
    const budget = plan.sentences.length;                 // 오늘 본문 몫 = 하루 시작 상한
    plan.words.fresh.forEach((id) => {
      E.recordQuiz(e.states[id], ok, now);
      E.recordCriterion(e.states[id], { correct: true, confidence: 'sure', hinted: true }, now);
    });
    plan.words.review.forEach((id) => {
      if (!e.states[id].reached) E.recordCriterion(e.states[id], ok, now); else E.recordQuiz(e.states[id], ok, now);
    });
    plan.words.relearn.forEach((id) => E.recordCriterion(e.states[id], ok, now));
    let did = 0;
    for (let tick = 1; did < budget && tick < 300; tick++) {
      const x = E.planDay(big, e.states, EX, now + tick * 60000, { rec: e.rec }).sentences[0];
      if (!x) break;
      runItem(e, x, now + tick * 60000);
      did += 1;
    }
    peak = Math.max(peak, wN + did);
    const p = E.passageSummary(big, e.states, e.rec);
    if (doneDay == null && p.cumulative === 5 && p.check) doneDay = plan.dday;
  }
  const S = E.sentenceSummary(e.states), P = E.passageSummary(big, e.states, e.rec);
  assert.strictEqual(S.interpreted, 25, '25문장 전부 해석 통과');
  assert.strictEqual(S.memorized, 25, '25문장 전부 백지 통과');
  assert.deepStrictEqual([P.chunkDone, P.paraBlank, P.cumulative], [5, 5, 5], JSON.stringify(P));
  assert.ok(P.check && P.check.total === 8, '종합 Check까지 끝난다');
  assert.ok(doneDay >= 1, '시험 전에 끝난다 — 실제 D-' + doneDay);
  /* 하루 부담은 단어가 대부분이다. 이 숫자가 커지면 노트가 그 사실을 밝힌다(HEAVY_DAY) */
  assert.ok(peak <= 70, '하루 최대 세션 ' + peak + '개');
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
