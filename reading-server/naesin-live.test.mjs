/* 수업 라이브 세션 순수 로직 (node reading-server/naesin-live.test.mjs)
 *
 * 여기서 가장 중요한 것은 하나다: 정답이 학생 태블릿으로 내려가지 않는가.
 * TV에 문제를 띄우고 답만 태블릿에서 받는 구조라, 정답이 응답에 섞이면 그 자리에서 무너진다.
 */
import assert from 'node:assert';
import * as L from './naesin-live.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log('  ✓ ' + name); };
const T0 = Date.parse('2026-09-03T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/* ── 학생이 올리는 live 요약 ── */
t('normalizeLive — 열거값·길이·정수를 강제한다', () => {
  const v = L.normalizeLive({ at: iso(T0), where: 'runner', label: 'x'.repeat(200), idleSec: 12.7, todayDone: '5' });
  assert.strictEqual(v.where, 'runner');
  assert.strictEqual(v.label.length, L.LABEL_MAX);
  assert.strictEqual(v.idleSec, 12);
  assert.strictEqual(v.todayDone, 5);
});
t('normalizeLive — 모르는 where 는 home 으로, 음수·NaN 은 0', () => {
  const v = L.normalizeLive({ where: '<script>', idleSec: -50, todayDone: 'x' });
  assert.strictEqual(v.where, 'home');
  assert.strictEqual(v.idleSec, 0);
  assert.strictEqual(v.todayDone, 0);
  assert.strictEqual(v.at, null);
});
t('normalizeLive — 객체가 아니면 null (없는 값과 빈 값을 가른다)', () => {
  assert.strictEqual(L.normalizeLive(null), null);
  assert.strictEqual(L.normalizeLive('home'), null);
  assert.strictEqual(L.normalizeLive([]), null);
});
t('normalizeLive — 마크업은 문자열로 남는다 (지우지 않고 화면이 이스케이프한다)', () => {
  const v = L.normalizeLive({ where: 'home', label: '<img src=x onerror=1>' });
  assert.ok(v.label.indexOf('<img') === 0, v.label);
});

/* ── 단계(타임박스) ── */
t('normalizePhase — 분 입력으로 endsAt 을 서버가 계산한다 (강사 시계를 믿지 않는다)', () => {
  const p = L.normalizePhase({ key: 'words', label: '단어 10분', minutes: 10 }, T0);
  assert.strictEqual(p.key, 'words');
  assert.strictEqual(p.startedAt, iso(T0));
  assert.strictEqual(p.endsAt, iso(T0 + 10 * 60e3));
  assert.strictEqual(L.remainSec(p, T0 + 3 * 60e3), 7 * 60);
});
t('normalizePhase — 분을 안 주면 무제한(endsAt null), remainSec 도 null', () => {
  const p = L.normalizePhase({ key: 'free' }, T0);
  assert.strictEqual(p.endsAt, null);
  assert.strictEqual(L.remainSec(p, T0), null);
});
t('normalizePhase — 상한·하한을 넘기면 잘린다 (오타로 30일 타이머가 걸리지 않게)', () => {
  assert.strictEqual(L.normalizePhase({ key: 'quiz', minutes: 100000 }, T0).endsAt, iso(T0 + L.PHASE_MAX_MS));
  assert.strictEqual(L.normalizePhase({ key: 'quiz', minutes: 0.1 }, T0).endsAt, iso(T0 + L.PHASE_MIN_MS));
});
t('normalizePhase — 모르는 key 는 null (학생 앱이 못 따라가는 단계를 만들지 않는다)', () => {
  assert.strictEqual(L.normalizePhase({ key: 'hack' }, T0), null);
  assert.strictEqual(L.normalizePhase(null, T0), null);
});
t('normalizePhase — 연장은 시작 시각을 유지한다', () => {
  const p1 = L.normalizePhase({ key: 'words', minutes: 10 }, T0);
  const p2 = L.normalizePhase({ ...p1, minutes: 5 }, T0 + 9 * 60e3);
  assert.strictEqual(p2.startedAt, p1.startedAt, '시작 시각이 밀리면 화면의 경과 시간이 리셋된다');
  assert.strictEqual(p2.endsAt, iso(T0 + 14 * 60e3));
});
t('normalizePhase — 지난 endsAt 은 받지 않는다', () => {
  assert.strictEqual(L.normalizePhase({ key: 'words', endsAt: iso(T0 - 60e3) }, T0).endsAt, null);
});
t('normalizePhase — typeKeys 는 화이트리스트, seq 범위는 정수만', () => {
  const p = L.normalizePhase({ key: 'quiz', typeKeys: ['w-e2k', 'g-3', 'mock', 'DROP TABLE'], seqFrom: 3, seqTo: '9', minutes: 5 }, T0);
  assert.deepStrictEqual(p.typeKeys, ['w-e2k', 'g-3', 'mock']);
  assert.strictEqual(p.seqFrom, 3);
  assert.strictEqual(p.seqTo, 9, '입력 칸에서 온 문자열 숫자도 받는다');
  assert.strictEqual(L.normalizePhase({ key: 'quiz', seqFrom: 'x', seqTo: 0 }, T0).seqFrom, undefined, '숫자가 아니거나 0 이하면 들어가지 않는다');
});

/* ── 만료 ── */
t('isLive — 4시간 넘게 손대지 않은 세션은 없는 것으로 본다', () => {
  const rec = { updatedAt: iso(T0) };
  assert.strictEqual(L.isLive(rec, T0 + 3.9 * 3600e3), true);
  assert.strictEqual(L.isLive(rec, T0 + 4.1 * 3600e3), false);
  assert.strictEqual(L.isLive({ updatedAt: 'x' }, T0), false);
  assert.strictEqual(L.isLive(null, T0), false);
});
t('publicLive — 만료된 세션은 학생에게 null (어제 단계가 오늘 화면에 남지 않는다)', () => {
  const rec = { updatedAt: iso(T0), phase: L.normalizePhase({ key: 'words', minutes: 10 }, T0) };
  assert.ok(L.publicLive(rec, T0 + 60e3));
  assert.strictEqual(L.publicLive(rec, T0 + 5 * 3600e3), null);
});

/* ── 투사 모드: 정답 비노출 ── */
const PJ_IN = {
  items: [
    { ref: 'q1', prompt: 'apple 의 뜻은?', choices: [{ key: 'a', text: '사과' }, { key: 'b', text: '바나나' }], answerKey: 'a' },
    { ref: 'q2', prompt: 'run 의 과거형은?', choices: [{ key: 'a', text: 'runned' }, { key: 'b', text: 'ran' }], answerKey: 'b' },
  ],
};
t('publicLive — 공개 전에는 응답 어디에도 answerKey 가 없다', () => {
  const rec = { updatedAt: iso(T0), projector: L.normalizeProjector(PJ_IN, T0) };
  const pub = L.publicLive(rec, T0);
  assert.strictEqual(JSON.stringify(pub).indexOf('answerKey'), -1, JSON.stringify(pub));
  assert.strictEqual(pub.projector.item.ref, 'q1');
  assert.strictEqual(pub.projector.count, 2);
});
t('publicLive — 지금 문제만 준다 (다음 문제를 미리 못 본다)', () => {
  const rec = { updatedAt: iso(T0), projector: L.normalizeProjector(PJ_IN, T0) };
  const pub = L.publicLive(rec, T0);
  assert.strictEqual(JSON.stringify(pub).indexOf('ran'), -1, '다음 문제의 보기까지 내려가면 미리 풀어 버린다');
});
t('publicLive — 공개하면 그 문제의 정답만 붙는다', () => {
  const pj = L.normalizeProjector({ ...PJ_IN, revealed: true }, T0);
  const pub = L.publicLive({ updatedAt: iso(T0), projector: pj }, T0);
  assert.strictEqual(pub.projector.item.answerKey, 'a');
  const txt = JSON.stringify(pub);
  assert.strictEqual((txt.match(/answerKey/g) || []).length, 1, '공개된 문제 하나에만 정답이 붙는다');
  assert.strictEqual(txt.indexOf('ran'), -1, '두 번째 문제는 정답도 보기도 아직 안 나간다');
});
t('normalizeProjector — 정답이 보기에 없는 문제는 띄우지 않는다', () => {
  const pj = L.normalizeProjector({ items: [{ prompt: 'x', choices: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }], answerKey: 'z' }] }, T0);
  assert.strictEqual(pj, null, '풀 수 없는 문제를 TV에 띄우면 수업이 멈춘다');
});
t('normalizeProjector — 보기가 2개 미만인 문제는 버리고, 20개 상한을 지킨다', () => {
  const many = { items: Array.from({ length: 30 }, (_, i) => ({ ref: 'r' + i, prompt: 'p' + i, choices: [{ key: 'a', text: '1' }, { key: 'b', text: '2' }], answerKey: 'a' })) };
  assert.strictEqual(L.normalizeProjector(many, T0).items.length, L.PROJ_ITEMS_MAX);
  assert.strictEqual(L.normalizeProjector({ items: [{ prompt: 'x', choices: [{ key: 'a', text: '1' }], answerKey: 'a' }] }, T0), null);
});
t('normalizeProjector — index 는 문제 수 안으로 잘린다', () => {
  assert.strictEqual(L.normalizeProjector({ ...PJ_IN, index: 99 }, T0).index, 1);
  assert.strictEqual(L.normalizeProjector({ ...PJ_IN, index: -5 }, T0).index, 0);
});
t('normalizeProjector — 문자열 보기도 받는다 (강사 화면이 간단히 보낼 수 있게)', () => {
  const pj = L.normalizeProjector({ items: [{ prompt: 'x', choices: ['사과', '배'], answerKey: '1' }] }, T0);
  assert.deepStrictEqual(pj.items[0].choices, [{ key: '1', text: '사과' }, { key: '2', text: '배' }]);
});

/* ── 라이브 보드 ── */
const ROWS = [
  { code: 'a', name: '가', cls: 'A', linked: true, lastActive: iso(T0 - 10e3), summary: { live: { at: iso(T0 - 10e3), where: 'runner', label: '본문 3단계', idleSec: 20, todayDone: 4 }, sentence: { total: 25, memorized: 20 } } },
  { code: 'b', name: '나', cls: 'A', linked: true, lastActive: iso(T0 - 20e3), summary: { live: { at: iso(T0 - 20e3), where: 'words', label: '단어', idleSec: 300, todayDone: 1 }, sentence: { total: 25, memorized: 5 } } },
  { code: 'c', name: '다', cls: 'A', linked: true, lastActive: iso(T0 - 10 * 60e3), summary: { live: { at: iso(T0 - 10 * 60e3), where: 'home', label: '', idleSec: 5, todayDone: 0 }, sentence: { total: 25, memorized: 12 } } },
  { code: 'd', name: '라', cls: 'B', linked: false, lastActive: null },
];
t('boardRows — 정체 오래된 순으로 정렬한다 (먼저 봐야 할 학생이 위로)', () => {
  const b = L.boardRows(ROWS, T0);
  assert.deepStrictEqual(b.filter((r) => !r.stale).map((r) => r.code), ['b', 'a']);
});
t('boardRows — 앱을 닫은 학생은 stale 로 아래에 모인다', () => {
  const b = L.boardRows(ROWS, T0);
  assert.deepStrictEqual(b.slice(2).map((r) => r.code).sort(), ['c', 'd']);
  assert.strictEqual(b.find((r) => r.code === 'c').stale, true);
  assert.strictEqual(b.find((r) => r.code === 'd').stale, true);
});
t('boardRows — 정체 시간에 그 뒤 흐른 시간을 더한다 (앱을 덮으면 갱신이 멈춘다)', () => {
  const b = L.boardRows(ROWS, T0 + 60e3);
  assert.strictEqual(b.find((r) => r.code === 'a').idleSec, 20 + 70, '올라온 값에 머물면 정체가 영원히 20초다');
});
t('boardRows — 3분 넘은 정체가 경고선을 넘는다', () => {
  const b = L.boardRows(ROWS, T0);
  assert.ok(b.find((r) => r.code === 'b').idleSec > L.IDLE_WARN_SEC);
  assert.ok(b.find((r) => r.code === 'a').idleSec < L.IDLE_WARN_SEC);
});
t('boardRows — 한 번도 안 붙은 학생은 idleSec null (0으로 단정하지 않는다)', () => {
  const b = L.boardRows(ROWS, T0);
  const d = b.find((r) => r.code === 'd');
  assert.strictEqual(d.idleSec, null);
  assert.strictEqual(d.where, null);
  assert.strictEqual(d.blankAcc, null);
});
t('blankAccOf — 분모가 없으면 null, 있으면 0~1', () => {
  assert.strictEqual(L.blankAccOf(null), null);
  assert.strictEqual(L.blankAccOf({ sentence: { total: 0, memorized: 0 } }), null);
  assert.strictEqual(L.blankAccOf({ sentence: { total: 25, memorized: 5 } }), 0.2);
  assert.strictEqual(L.blankAccOf({ passage: { blankTotal: 4, blankDone: 3 } }), 0.75);
});
t('weakest — 값을 못 낸 학생은 하위 명단에 넣지 않는다', () => {
  const b = L.boardRows(ROWS, T0);
  assert.deepStrictEqual(L.weakest(b, 2), ['b', 'c']);
  assert.strictEqual(L.weakest(b, 9).indexOf('d'), -1, '못 잰 학생을 0점으로 세우면 엉뚱한 이름이 불린다');
});

/* ── 투표 집계 ── */
t('tally — 분포와 함께 틀린 학생 명단을 준다 (분포만으로는 부를 이름이 안 나온다)', () => {
  const pj = L.normalizeProjector(PJ_IN, T0);
  let v = {};
  v = L.putVote(v, 'q1', 'a', 'a');
  v = L.putVote(v, 'q1', 'b', 'b');
  v = L.putVote(v, 'q1', 'c', 'a');
  const r = L.tally(v, pj)[0];
  assert.strictEqual(r.answered, 3);
  assert.strictEqual(r.correct, 2);
  assert.deepStrictEqual(r.counts, { a: 2, b: 1 });
  assert.deepStrictEqual(r.wrong, ['b']);
});
t('tally — 보기에 없는 값은 세지 않는다', () => {
  const pj = L.normalizeProjector(PJ_IN, T0);
  const r = L.tally({ q1: { a: 'zzz', b: 'a' } }, pj)[0];
  assert.strictEqual(r.answered, 1);
  assert.deepStrictEqual(r.counts, { a: 1, b: 0 });
});
t('tally — 아무도 안 풀었으면 0 (문항은 그대로 나온다)', () => {
  const pj = L.normalizeProjector(PJ_IN, T0);
  const rs = L.tally({}, pj);
  assert.strictEqual(rs.length, 2);
  assert.strictEqual(rs[0].answered, 0);
});
t('putVote — 다시 고르면 마지막 것만 남는다 (고쳐 낼 수 있어야 한다)', () => {
  let v = L.putVote({}, 'q1', 'a', 'a');
  v = L.putVote(v, 'q1', 'a', 'b');
  assert.deepStrictEqual(v.q1, { a: 'b' });
});
t('putVote — 원본을 바꾸지 않는다', () => {
  const v0 = { q1: { a: 'a' } };
  const v1 = L.putVote(v0, 'q1', 'b', 'b');
  assert.deepStrictEqual(v0.q1, { a: 'a' });
  assert.deepStrictEqual(v1.q1, { a: 'a', b: 'b' });
});

console.log(`\n통과 ${passed}개 — 수업 라이브 세션 검증 완료`);
