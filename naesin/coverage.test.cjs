'use strict';
/* node naesin/coverage.test.cjs — 팩 커버리지(교과서·학년) 순수 로직
 *
 * 이 카드가 거짓 경고를 한 번 내면 원장이 화면을 안 믿는다. 그래서 '모를 때 침묵하는가' 를
 * 정상 동작과 같은 무게로 잠근다. 예시는 전부 자체 창작이고 실명·실제 학교는 없다. */
const C = require('./coverage.js');
let fail = 0;
const t = (name, fn) => { try { fn(); } catch (e) { fail++; console.error('✗ ' + name + '\n   ' + e.message); } };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((m ? m + ' — ' : '') + 'got ' + x + ' want ' + y); };
const ok = (c, m) => { if (!c) throw new Error(m || 'false'); };

/* ── packId 문법 ── */
t('splitPackId — 일반 과와 Special 과를 모두 읽고, 코드표는 묻지 않는다', () => {
  eq(C.splitPackId('2022-ne-kimgitaek-m2-L6').book, 'ne-kimgitaek');
  eq(C.splitPackId('2022-ne-kimgitaek-m2-L12').unit, 'L12');
  eq(C.splitPackId('2015-kumsung-choeincheol-m3-SL2').grade, 'm3');
  eq(C.splitPackId('2022-bisang-hwangjongbae-m1-SR').unit, 'SR');
  /* 아는 교과서인지 묻지 않는다 — 새 교과서가 생겨도 이 파일을 고치지 않기 위해서다 */
  eq(C.splitPackId('2022-aaa-bbb-m2-L1').book, 'aaa-bbb');
  /* 문법이 아니면 null — 추측해서 조각을 만들지 않는다 */
  for (const bad of ['', '2022-ne-kimgitaek-m2', 'ne-kimgitaek-m2-L6', '2022-ne-kimgitaek-m2-L6/',
                     '2022-NE-kimgitaek-m2-L6', '2022-ne-kimgitaek-x2-L6', '2022-ne-kimgitaek-m2-Q1'])
    eq(C.splitPackId(bad), null, JSON.stringify(bad));
});

t('gradeToken — 명부 표기가 흔들려도 같은 토큰으로 모은다', () => {
  for (const [a, b] of [['중2','m2'], ['중 2','m2'], ['2','m2'], ['m2','m2'], ['고1','h1'], ['중3','m3']])
    eq(C.gradeToken(a), b, a);
  /* 못 읽으면 빈 문자열 — 아래에서 '보류'로 센다 */
  for (const bad of ['', '중등', '초6', null, undefined, '4']) eq(C.gradeToken(bad), '', JSON.stringify(bad));
});

/* ── 배정 해석: 서버 규약과 같아야 한다 ── */
t('examFor — 개별 배정이 살아 있으면 그것, 만료면 반 공통으로 내려온다', () => {
  const exams = [
    { scope: 'default', packIds: ['2022-ne-kimgitaek-m2-L6'] },
    { scope: 'S1', packIds: ['2022-ne-kimgitaek-m2-L7'] },
    { scope: 'S2', packIds: ['2022-ne-kimgitaek-m2-L8'], expired: true },
  ];
  eq(C.examFor(exams, 'S1').scope, 'S1');
  eq(C.examFor(exams, 'S2').scope, 'default', '만료된 개별 배정은 반 공통으로 폴백');
  eq(C.examFor(exams, 'S9').scope, 'default', '개별 배정이 없으면 반 공통');
  eq(C.examFor([{ scope: 'default', expired: true }], 'S1'), null, '반 공통도 만료면 배정 없음');
  eq(C.examFor([], 'S1'), null);
});

/* ── 조합 집계 ── */
const ROSTER = [
  { code: 'S1', name: '가가', grade: '중2', cls: 'A' },
  { code: 'S2', name: '나나', grade: '중2', cls: 'A' },
  { code: 'S3', name: '다다', grade: '중3', cls: 'B' },
  { code: 'S4', name: '라라', grade: '중2', cls: 'B' },
];
const BOOKS = { S1: 'ne-kimgitaek', S2: 'ne-kimgitaek', S3: 'kumsung-choeincheol' };  /* S4 미지정 */

t('combos — 학생 많은 조합이 먼저 서고, 팩 0개가 empty 로 표시된다', () => {
  const r = C.report({ roster: ROSTER, books: BOOKS, packs: ['2022-ne-kimgitaek-m2-L6'], exams: [] });
  eq(r.combos.length, 2, '지정된 학생의 조합 둘');
  eq(r.combos[0].book, 'ne-kimgitaek'); eq(r.combos[0].students, 2);
  eq(r.combos[0].packs, 1); eq(r.combos[0].empty, false);
  eq(r.combos[1].book, 'kumsung-choeincheol'); eq(r.combos[1].students, 1);
  eq(r.combos[1].empty, true, '학생은 있고 팩이 0개 — 먼저 만들 조합');
  /* 먼저 만들 드라이브 폴더 이름 접두사 — 과 번호만 붙이면 된다 */
  eq(r.combos[1].folderPrefix, '2015-kumsung-choeincheol-m3-', '중3은 2015 개정');
  eq(r.combos[0].folderPrefix, '2022-ne-kimgitaek-m2-');
});

t('combos — 교과서 미지정·학년 불명은 경고가 아니라 보류로 센다', () => {
  const r = C.report({ roster: ROSTER, books: BOOKS, packs: [], exams: [] });
  eq(r.unset.map((u) => u.code + ':' + u.why), ['S4:no-book']);
  const r2 = C.report({ roster: [{ code: 'X', name: '마마', grade: '초6' }], books: { X: 'ne-kimgitaek' }, packs: [], exams: [] });
  eq(r2.unset.map((u) => u.why), ['no-grade'], '학년을 못 읽으면 조합을 만들지 않는다');
  eq(r2.combos.length, 0);
});

t('combos — 문법이 아닌 팩 id 는 어느 조합에도 세지 않는다(조용히 무시, 경고 아님)', () => {
  const r = C.report({ roster: [ROSTER[0]], books: BOOKS, packs: ['쓰레기', '2022-ne-kimgitaek-m2-L6'], exams: [] });
  eq(r.combos[0].packIds, ['2022-ne-kimgitaek-m2-L6']);
});

/* ── 불일치 경고: 모를 때 침묵하는가 ── */
t('mismatches — 다른 교과서·다른 학년 팩이 배정되면 잡는다', () => {
  const exams = [{ scope: 'default', packIds: ['2022-bisang-hwangjongbae-m2-L6'] }];
  const r = C.report({ roster: [ROSTER[0]], books: BOOKS, packs: [], exams: exams });
  eq(r.mismatches.length, 1);
  eq(r.mismatches[0].bad[0].kind, 'book');
  eq(r.mismatches[0].bad[0].got, 'bisang-hwangjongbae');
  eq(r.mismatches[0].bad[0].want, 'ne-kimgitaek');
  /* 교과서는 맞고 학년만 어긋난 경우 */
  const r2 = C.report({ roster: [ROSTER[0]], books: BOOKS, packs: [],
    exams: [{ scope: 'default', packIds: ['2022-ne-kimgitaek-m3-L6'] }] });
  eq(r2.mismatches[0].bad[0].kind, 'grade');
  eq(r2.mismatches[0].bad[0].got, 'm3');
});

t('mismatches — 교과서 지정이 없으면 판정하지 않는다 (거짓 경고 금지)', () => {
  const exams = [{ scope: 'default', packIds: ['2022-bisang-hwangjongbae-m2-L6'] }];
  /* S4 는 BOOKS 에 없다 — 그 학생에게는 아무 말도 하지 않아야 한다 */
  const r = C.report({ roster: [ROSTER[3]], books: BOOKS, packs: [], exams: exams });
  eq(r.mismatches, [], '모르는 것을 틀렸다고 하지 않는다');
});

t('mismatches — 배정이 없거나 만료면 판정하지 않는다', () => {
  eq(C.report({ roster: [ROSTER[0]], books: BOOKS, packs: [], exams: [] }).mismatches, []);
  eq(C.report({ roster: [ROSTER[0]], books: BOOKS, packs: [],
    exams: [{ scope: 'default', packIds: ['2022-bisang-hwangjongbae-m2-L6'], expired: true }] }).mismatches, [],
    '지난 시험의 배정은 경고 대상이 아니다');
});

t('mismatches — 올바른 배정에는 아무 말도 하지 않는다', () => {
  const r = C.report({ roster: [ROSTER[0], ROSTER[1]], books: BOOKS,
    packs: ['2022-ne-kimgitaek-m2-L6'],
    exams: [{ scope: 'default', packIds: ['2022-ne-kimgitaek-m2-L6', '2022-ne-kimgitaek-m2-SL2'] }] });
  eq(r.mismatches, []);
  eq(r.combos[0].packs, 1);
});

t('report — 빈 입력에도 깨지지 않는다 (명부를 못 받았을 때 카드가 조용히 빈다)', () => {
  const r = C.report({});
  eq(r.combos, []); eq(r.unset, []); eq(r.mismatches, []);
  const r2 = C.report({ roster: null, books: null, packs: null, exams: null });
  eq(r2.combos, []); eq(r2.mismatches, []);
});

t('고등 학년은 개정을 모르므로 폴더 접두사를 주지 않는다', () => {
  eq(C.folderPrefix('ne-kimgitaek', 'h1'), '', '추측해서 폴더 이름을 만들지 않는다');
  const r = C.report({ roster: [{ code: 'H1', name: '바바', grade: '고1' }], books: { H1: 'x-y' }, packs: [], exams: [] });
  eq(r.combos[0].folderPrefix, '');
});

if (fail) { console.error('\n실패 ' + fail + '건'); process.exit(1); }
console.log('OK — packId 문법·학년 정규화·배정 해석·조합 집계·불일치 경고, 그리고 모를 때 침묵하는 것까지 통과');
