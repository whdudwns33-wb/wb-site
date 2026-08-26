'use strict';
/* WB 워드브레인 — 엔진·데이터 검증 (node vocab/srs.test.cjs) */
const assert = require('assert');
const SRS = require('./srs.js');
const { WB_WORDS } = require('./words.js');

const DAY = SRS.DAY;
let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ✓ ' + name); }

/* ── 단어 데이터 ── */
t('단어 135개 — 어종별 45개씩 균형', () => {
  assert.strictEqual(WB_WORDS.length, 135);
  const by = { hanja: 0, native: 0, english: 0 };
  WB_WORDS.forEach((w) => { by[w.type] += 1; });
  assert.deepStrictEqual(by, { hanja: 45, native: 45, english: 45 });
});

t('id 중복 없음, 공통 필드 존재', () => {
  const ids = new Set();
  WB_WORDS.forEach((w) => {
    assert.ok(!ids.has(w.id), 'dup id: ' + w.id);
    ids.add(w.id);
    ['id', 'type', 'word', 'meaning', 'example'].forEach((f) => assert.ok(w[f], w.id + ' missing ' + f));
  });
});

t('어종별 부호화 필드 — 한자 분해·연상·장면', () => {
  WB_WORDS.forEach((w) => {
    if (w.type === 'hanja') {
      assert.ok(w.hanja && w.literal, w.id);
      assert.ok(Array.isArray(w.parts) && w.parts.length >= 2, w.id);
      w.parts.forEach((p) => assert.ok(p.ch && p.hun && p.eum, w.id + ' part'));
      assert.strictEqual(w.parts.map((p) => p.ch).join(''), w.hanja, w.id + ' parts≠hanja');
    }
    if (w.type === 'english') assert.ok(w.pron && w.cue && w.scene, w.id);
    if (w.type === 'native') assert.ok(w.scene && Array.isArray(w.syn) && w.syn.length >= 1, w.id);
  });
});

t('한자 뿌리 가족 — 觀 6단어, 2개 이상 달린 뿌리 7개', () => {
  const fam = {};
  WB_WORDS.filter((w) => w.type === 'hanja').forEach((w) => {
    w.parts.forEach((p) => { (fam[p.ch] = fam[p.ch] || []).push(w.word); });
  });
  assert.ok(fam['觀'].length >= 6, '觀 뿌리 가족: ' + (fam['觀'] || []).join(','));
  assert.ok(fam['論'].length >= 3, '論 뿌리 가족');
  const multi = Object.keys(fam).filter((k) => fam[k].length >= 2);
  assert.ok(multi.length >= 7, '낱말이 2개 이상 달린 뿌리(=뿌리 회상이 가능한 뿌리)가 줄면 안 된다: ' + multi.length);
});

/* ── 엔진 ── */
const noon = new Date(2026, 7, 26, 12, 0, 0).getTime(); // 낮 12시
const night = new Date(2026, 7, 26, 22, 0, 0).getTime(); // 밤 10시

t('심기 — 첫 복습은 당일 밤 21시', () => {
  const s = SRS.plant('w1', noon);
  const d = new Date(s.due);
  assert.strictEqual(d.getHours(), 21);
  assert.ok(SRS.sameDay(s.due, noon));
});

t('심기 — 21시 이후엔 10분 뒤 첫 복습', () => {
  const s = SRS.plant('w1', night);
  assert.strictEqual(s.due, night + 600000);
});

t('good — 간격 사다리 1→3→7일', () => {
  const s = SRS.plant('w1', noon);
  let now = s.due;
  SRS.review(s, 'good', now, 'review');
  assert.strictEqual(s.step, 1);
  assert.strictEqual(s.due, now + 1 * DAY);
  now = s.due; SRS.review(s, 'good', now, 'review');
  assert.strictEqual(s.step, 2);
  assert.strictEqual(s.due, now + 3 * DAY);
  now = s.due; SRS.review(s, 'good', now, 'review');
  assert.strictEqual(s.step, 3);
  assert.strictEqual(s.due, now + 7 * DAY);
});

t('fail — 2계단 후퇴 + 10분 뒤 재도전, hard — 계단 유지 + 내일', () => {
  const s = SRS.plant('w1', noon);
  s.step = 3;
  SRS.review(s, 'fail', noon, 'review');
  assert.strictEqual(s.step, 1);
  assert.strictEqual(s.due, noon + 600000);
  assert.strictEqual(s.lapses, 1);
  SRS.review(s, 'hard', noon, 'review');
  assert.strictEqual(s.step, 1);
  assert.strictEqual(s.due, noon + DAY);
});

t('졸업 — 30일 통과 + 연속 3회 + 맥락 3종', () => {
  const s = SRS.plant('w1', noon);
  let now = s.due;
  ['review', 'flash', 'review', 'speed', 'review', 'review'].forEach((ctx) => {
    SRS.review(s, 'good', now, ctx); now = s.due;
  });
  assert.strictEqual(s.step, 6);
  assert.ok(s.graduated, '30일 간격 통과 시 졸업');
  // 맥락이 1종뿐이면 같은 경로여도 졸업 불가
  const s2 = SRS.plant('w2', noon);
  now = s2.due;
  for (let i = 0; i < 6; i++) { SRS.review(s2, 'good', now, 'review'); now = s2.due; }
  assert.ok(!s2.graduated, '맥락 1종은 졸업 불가');
});

t('시듦 — 제때 0, 반 간격 지나면 2, 한참 지나면 3(응급)', () => {
  const s = SRS.plant('w1', noon);
  s.step = 2; s.due = noon; // 3일 간격
  assert.strictEqual(SRS.wither(s, noon), 0);
  assert.strictEqual(SRS.wither(s, noon + 1 * DAY), 1);   // 0.33 간격 경과
  assert.strictEqual(SRS.wither(s, noon + 2 * DAY), 2);   // 0.66
  assert.strictEqual(SRS.wither(s, noon + 4 * DAY), 3);   // 1.33 → 응급
  s.graduated = true;
  assert.strictEqual(SRS.wither(s, noon + 30 * DAY), 0, '졸업 단어는 시들지 않음');
});

t('물 주기 큐 — 만기만, 급한 순서', () => {
  const states = {
    a: SRS.plant('a', noon), b: SRS.plant('b', noon), c: SRS.plant('c', noon)
  };
  states.a.step = 1; states.a.due = noon - 2 * DAY;   // 1일 간격, 2일 연체 → ratio 2
  states.b.step = 3; states.b.due = noon - 2 * DAY;   // 7일 간격, 2일 연체 → ratio 0.28
  states.c.due = noon + DAY;                          // 아직
  const q = SRS.dueList(states, noon);
  assert.deepStrictEqual(q.map((s) => s.id), ['a', 'b']);
});

t('스피드 리콜 — EMA 반응속도 기록, 간격은 안 올라감', () => {
  const s = SRS.plant('w1', noon);
  s.step = 2; s.due = noon + DAY;
  SRS.speedResult(s, true, 2000, noon);
  assert.strictEqual(s.emaMs, 2000);
  SRS.speedResult(s, true, 1000, noon);
  assert.strictEqual(s.emaMs, 1600); // 0.6*2000+0.4*1000
  assert.strictEqual(s.step, 2, '간격 계단은 그대로');
  assert.strictEqual(s.due, noon + DAY + 12 * 3600000, '보너스 +6h × 2회만');
});

t('시간 이동(데모) — due/plantedAt이 함께 밀린다', () => {
  const states = { a: SRS.plant('a', noon) };
  const before = states.a.due;
  SRS.shiftTime(states, 2);
  assert.strictEqual(states.a.due, before - 2 * DAY);
  assert.strictEqual(states.a.plantedAt, noon - 2 * DAY);
});

t('요약 — 만기·응급·졸업 집계', () => {
  const states = { a: SRS.plant('a', noon), b: SRS.plant('b', noon), c: SRS.plant('c', noon) };
  states.a.due = noon - 1;                 // 만기 (step0, 12h 기준 → 응급 아님)
  states.b.step = 1; states.b.due = noon - 5 * DAY; // 1일 간격 5일 연체 → 응급
  states.c.graduated = true;
  const sum = SRS.summary(states, noon);
  assert.strictEqual(sum.total, 3);
  assert.strictEqual(sum.due, 2);
  assert.strictEqual(sum.emergency, 1);
  assert.strictEqual(sum.graduated, 1);
});

/* ── 브리지: 진로독서 어휘장 → 씨앗 ── */
const BR = require('./bridge.js');

t('한자 분해 문자열 파싱 — "發(쏠 발)+射(쏠 사)+體(몸 체)"', () => {
  assert.deepStrictEqual(BR.parseHanja('發(쏠 발)+射(쏠 사)+體(몸 체)'), [
    { ch: '發', hun: '쏠', eum: '발' }, { ch: '射', hun: '쏠', eum: '사' }, { ch: '體', hun: '몸', eum: '체' }
  ]);
  assert.deepStrictEqual(BR.parseHanja('軌(바퀴 자국 궤)+道(길 도)')[0], { ch: '軌', hun: '바퀴 자국', eum: '궤' }, '여러 어절 훈');
  assert.strictEqual(BR.parseHanja(null), null);
  assert.strictEqual(BR.parseHanja('한자 없음'), null);
});

t('진로독서 항목 변환 — 한자어/영어/고유어 판별', () => {
  const h = BR.fromReadingEntry({ word: '발사체', easy: '로켓', hanja: '發(쏠 발)+射(쏠 사)+體(몸 체)' });
  assert.strictEqual(h.type, 'hanja');
  assert.strictEqual(h.hanja, '發射體');
  assert.strictEqual(h.literal, '쏠 · 쏠 · 몸');
  assert.strictEqual(h.source, 'reading');
  const e = BR.fromReadingEntry({ word: 'orbit', easy: '궤도', lang: 'en' });
  assert.strictEqual(e.type, 'english');
  assert.strictEqual(e.id, 'rd-orbit');
  const n = BR.fromReadingEntry({ word: '드넓다', easy: '아주 넓다' });
  assert.strictEqual(n.type, 'native');
});

t('씨앗 도착함 — 최신 우선·중복 제거·심은 단어 제외·시드 우선', () => {
  const seedByWord = { '관측': { id: 'h-gwancheuk', word: '관측', type: 'hanja' } };
  const arr = [
    { word: '관측', easy: '살펴 재기', hanja: '觀(볼 관)+測(잴 측)' },
    { word: '궤도', easy: '도는 길', hanja: '軌(바퀴 자국 궤)+道(길 도)' },
    { word: '궤도', easy: '도는 길', hanja: '軌(바퀴 자국 궤)+道(길 도)' },
    { word: '발사체', easy: '로켓', hanja: null }
  ];
  const inbox = BR.collectInbox(arr, { plantedIds: {}, seedByWord });
  assert.deepStrictEqual(inbox.map((w) => w.word), ['발사체', '궤도', '관측'], '최신 우선 + 중복 제거');
  assert.strictEqual(inbox[2].id, 'h-gwancheuk', '시드에 있는 단어는 시드 데이터 우선');
  const inbox2 = BR.collectInbox(arr, { plantedIds: { 'rd-궤도': true }, seedByWord });
  assert.deepStrictEqual(inbox2.map((w) => w.word), ['발사체', '관측'], '이미 심은 단어 제외');
  assert.deepStrictEqual(BR.collectInbox(null, {}), [], '어휘장 없음 = 빈 도착함');
});

console.log('\n통과 ' + passed + '개 — vocab 엔진·데이터·브리지 검증 완료');
