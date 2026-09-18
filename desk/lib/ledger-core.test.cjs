const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./ledger-core.js');

/* 예시는 전부 자체 창작이다 — 학교는 코드(SCH-07)만, 학생·실명·전화는 없다. */
function asset(extra) {
  return core.normalizeAsset(Object.assign({
    id: 'MAT-0001',
    status: 'registered',
    catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '03', edition: 'student' },
    links: { needId: 'NEED-0001' }
  }, extra || {}));
}
function need(extra) {
  return core.normalizeNeed(Object.assign({
    id: 'NEED-0001',
    schoolCode: 'SCH-07',
    grade: 'm2',
    textbookCode: 'ne-kimgitaek',
    units: [5, 6],
    examRef: { examDateCopy: '2026-10-14' }
  }, extra || {}));
}

/* ── 저장 키 ── */

test('ledger keys carry their prefix and the task id half only', () => {
  assert.equal(core.ledgerKey('MAT-0107'), '__lic__MAT-0107');
  assert.equal(core.eventKey('LE-1'), '__licev__LE-1');
  assert.equal(core.needKey('NEED-0001'), '__licneed__NEED-0001');
  assert.equal(core.fullKey(core.ledgerKey('MAT-0107')), '__lic__MAT-0107|all');
});

test('isLedgerKey accepts all three prefixes with or without the |all suffix', () => {
  ['__lic__MAT-0107|all', '__licev__LE-1|all', '__licneed__NEED-0001|all', '__lic__MAT-0107'].forEach(k => {
    assert.equal(core.isLedgerKey(k), true, k);
  });
  assert.equal(core.kindOfKey('__lic__MAT-0107|all'), 'asset');
  assert.equal(core.kindOfKey('__licev__LE-1|all'), 'event');
  assert.equal(core.kindOfKey('__licneed__NEED-0001|all'), 'need');
});

test('other check prefixes are not mistaken for ledger rows', () => {
  ['__asset__A001|all', '__st__S1|2026-08-09', '__op__x|2026-08', 'task1|2026-09-09', '__license__x|all'].forEach(k => {
    assert.equal(core.isLedgerKey(k), false, k);
    assert.equal(core.assetIdFromKey(k), '');
  });
});

test('ids round-trip out of full keys and event keys are never read as asset ids', () => {
  assert.equal(core.assetIdFromKey('__lic__MAT-0107|all'), 'MAT-0107');
  assert.equal(core.eventIdFromKey('__licev__LE-abc-123|all'), 'LE-abc-123');
  assert.equal(core.needIdFromKey('__licneed__NEED-0002|all'), 'NEED-0002');
  assert.equal(core.assetIdFromKey('__licev__LE-1|all'), '');
  assert.equal(core.assetIdFromKey('__licneed__NEED-0001|all'), '');
});

/* ── 코드표 ── */

test('textbook table carries both lineups — 2022 중1·중2 ten, 2015 중3 twelve', () => {
  const codes = Object.keys(core.TEXTBOOKS);
  assert.equal(core.TEXTBOOKS['ne-kimgitaek'].label, 'NE능률(김기택)');
  assert.equal(core.TEXTBOOKS['mirae-munyeongin'].label, '미래엔(문영인)');
  assert.equal(core.TEXTBOOKS['chunjae-leesanggi'].label, '천재(이상기)');
  assert.equal(core.TEXTBOOKS['kumsung-choeincheol'].label, '금성(최인철)');
  /* 비상은 bisang 하나로 쓴다 — 국어 정본 표(docs/자료-폴더-표준.md)와 같은 표기여야
     같은 출판사가 두 갈래로 갈리지 않는다. */
  assert.ok(codes.every(c => !c.startsWith('visang')), 'no visang- codes; 비상 is bisang-');
  assert.equal(core.TEXTBOOKS['bisang-hwangjongbae'].label, '비상(황종배)');
  codes.forEach(c => assert.equal(core.TEXTBOOKS[c].code, c));
  /* 학년별 라인업 수는 사이트 목록 그대로다 — 중3만 12종이고 개정도 다르다. */
  const byGrade = g => codes.filter(c => core.TEXTBOOKS[c].grades.indexOf(g) >= 0);
  assert.equal(byGrade('m1').length, 10);
  assert.equal(byGrade('m2').length, 10);
  assert.equal(byGrade('m3').length, 12);
  /* 라벨은 폴더 이름이라 겹치면 경로를 못 가른다. */
  const labels = codes.map(c => core.TEXTBOOKS[c].label);
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique — they are folder names');
});

test('revision comes from the grade, not from a single hardcoded default', () => {
  assert.equal(core.REVISIONS.m2, '2022');
  assert.equal(core.REVISIONS.m3, '2015');
  assert.equal(core.revisionFor('ne-kimgitaek', 'm2'), '2022');
  /* 같은 저자가 두 라인업에 다 있는 교과서 — 여기가 조용히 2022 로 찍히던 자리다. */
  assert.equal(core.revisionFor('donga-yunjeongmi', 'm3'), '2015');
  assert.equal(core.revisionFor('donga-yunjeongmi', 'm2'), '2022');
  assert.equal(core.revisionFor('ne-kimgitaek', 'm3'), '', 'that book has no 중3 — do not guess');
  assert.equal(core.revisionFor('ne-kimgitaek', 'm2', '2009'), '2009', 'an explicit revision still wins');
});

test('series table follows the exam4you numbering and flags 02/03 required, 04-06 teacher', () => {
  assert.deepEqual(core.SERIES_CODES, ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09']);
  assert.deepEqual(core.REQUIRED_SERIES, ['02', '03']);
  assert.deepEqual(core.TEACHER_SERIES, ['04', '05', '06']);
  assert.equal(core.SERIES['02'].file, '02_본문워크북');
  assert.equal(core.SERIES['03'].file, '03_단어시험');
  assert.equal(core.SERIES['04'].file, '04_예상문제_PRE-STEP');
});

test('price hints exist for every series and stay in the 3,000-6,500 won band', () => {
  core.SERIES_CODES.forEach(s => {
    const v = core.PRICE_HINTS[s];
    assert.ok(Number.isFinite(v) && v >= 3000 && v <= 6500, s + ' → ' + v);
  });
  assert.equal(core.priceHint('03', 'teacher'), core.priceHint('03', 'student'));
  assert.equal(core.priceHint('zz'), 0);
});

test('file names carry the two-digit series prefix and the teacher suffix', () => {
  assert.equal(core.fileName('03', 'student'), '03_단어시험.pdf');
  assert.equal(core.fileName('04', 'teacher'), '04_예상문제_PRE-STEP_교사용.pdf');
  assert.equal(core.fileName('99', 'student'), '');
});

/* ── 카탈로그 키·중복 ── */

test('catalog key is source|textbook|grade|unit|series|edition', () => {
  assert.equal(core.catalogKey(asset()), 'examforyou|ne-kimgitaek|m2|L5|03|student');
  assert.equal(core.catalogKey({ textbookCode: 'ne-kimgitaek', grade: 'm2', unit: '05', series: '3', edition: 'teacher' }),
    'examforyou|ne-kimgitaek|m2|L5|03|teacher', 'bare catalog, numeric unit and short series are normalized');
  assert.equal(core.catalogKey({ textbookCode: 'ne-kimgitaek' }), '', 'incomplete catalog has no key');
});

test('a purchased twin of the same catalog key counts as a duplicate, a pending one does not', () => {
  const owned = asset({ id: 'MAT-0002', status: 'purchased' });
  const pending = asset({ id: 'MAT-0003', status: 'requested' });
  const teacher = asset({ id: 'MAT-0004', status: 'registered', catalog: Object.assign({}, asset().catalog, { edition: 'teacher' }) });
  assert.equal(core.isDuplicate(asset({ status: 'requested' }), [owned]), true);
  assert.equal(core.isDuplicate(asset({ status: 'requested' }), [pending]), false);
  assert.equal(core.isDuplicate(asset({ status: 'requested' }), [teacher]), false, 'edition is part of the key');
  assert.equal(core.isDuplicate(asset(), [asset()]), false, 'an asset is not its own duplicate');
  assert.equal(core.isDuplicate(asset(), [owned, { id: 'MAT-0009', deleted: true, status: 'registered', catalog: asset().catalog }]), true);
  assert.deepEqual(core.duplicatesOf(asset(), [owned]).map(a => a.id), ['MAT-0002']);
});

test('next asset id continues past the highest number and starts at 0001', () => {
  assert.equal(core.nextAssetId([]), 'MAT-0001');
  assert.equal(core.nextAssetId([{ id: 'MAT-0003' }, { id: 'MAT-0107' }, { id: 'A001' }]), 'MAT-0108');
  assert.equal(core.nextNeedId([{ id: 'NEED-0002' }]), 'NEED-0003');
});

/* ── 인테이크 경로 · packId ── */

test('intake path follows docs/자료-폴더-표준.md — app dir, term drawer, packId folder', () => {
  assert.equal(core.intakePath(asset(), '2026-2'),
    'WB 학습자료/naesin/2026-2/2022-ne-kimgitaek-m2-L5/03_단어시험.pdf');
  /* 서랍은 사람 편의라 없어도 된다 — 도구는 팩 id 폴더만 본다. */
  assert.equal(core.intakePath(asset()),
    'WB 학습자료/naesin/2022-ne-kimgitaek-m2-L5/03_단어시험.pdf');
  const t = asset({ catalog: { textbookCode: 'donga-yunjeongmi', grade: 'm3', unit: 3, series: '04', edition: 'teacher' } });
  assert.equal(core.intakePath(t, '2026-2'),
    'WB 학습자료/naesin/2026-2/2015-donga-yunjeongmi-m3-L3/04_예상문제_PRE-STEP_교사용.pdf',
    '중3 은 2015 개정 — 폴더 이름에도 그게 박힌다');
  assert.equal(core.intakePath(asset({ catalog: { series: '03' } })), '', 'no guessing when the folder is unknown');
  /* 폴더 이름은 팩 id 규칙을 만족해야 한다 — 한글·괄호가 들어가면 서버가 거부한다. */
  const folder = core.intakeFolder(asset(), '2026-2').split('/').pop();
  assert.ok(core.PACK_ID_RE.test(folder), folder + ' must match ^[A-Za-z0-9-]{3,60}$');
});

test('packId is the folder name — found at any drawer depth, never re-assembled', () => {
  assert.equal(core.packIdFromPath('WB 학습자료/naesin/2026-2/2022-ne-kimgitaek-m2-L6/02_본문워크북.pdf'),
    '2022-ne-kimgitaek-m2-L6');
  assert.equal(core.packIdFromPath('2022-ne-kimgitaek-m2-L6'), '2022-ne-kimgitaek-m2-L6', 'bare folder name works');
  assert.equal(core.packIdFromPath('a/b/c/d/e/2015-kumsung-choeincheol-m3-L4/00_교과서본문.pdf'),
    '2015-kumsung-choeincheol-m3-L4', 'drawers may be any depth');
  /* 개정이 학년과 어긋나면 거부한다 — 폴더 이름을 사람이 손으로 적는 자리라 오타가 난다. */
  assert.equal(core.packIdFromPath('2022-kumsung-choeincheol-m3-L4'), '', 'wrong revision for the grade');
  assert.equal(core.packIdFromPath('2015-ne-kimgitaek-m2-L6'), '', 'wrong revision for the grade');
  assert.equal(core.packIdFromPath('2022-nope-m2-L6'), '', 'unknown textbook');
  /* 옛 3겹 한글 구조는 더 이상 인정하지 않는다 — 팩 id 규칙을 만족하지 못하는 폴더 이름이었다. */
  assert.equal(core.packIdFromPath('WB 교재스캔/내신브레인_영어/NE능률(김기택)/중2/L06'), '');
  assert.equal(core.packIdFromPath(''), '');
});

test('unit tokens cover Special Lesson / Special Reading, not just numbers', () => {
  /* 이그잼포유 목록에 Special Lesson·Special Reading 이 실제로 있다 — 숫자만 받으면
     그 과는 폴더 이름을 만들 수 없어 인테이크가 멈춘다. */
  assert.equal(core.normalizeUnit(6), 'L6');
  assert.equal(core.normalizeUnit('6'), 'L6');
  assert.equal(core.normalizeUnit('l6'), 'L6', 'case is normalized');
  assert.equal(core.normalizeUnit('sl2'), 'SL2');
  assert.equal(core.normalizeUnit('SL'), 'SL', 'the site writes it without a number too');
  assert.equal(core.normalizeUnit('SR1'), 'SR1');
  assert.equal(core.normalizeUnit('Special Lesson 2'), '', 'the site label is not a token');
  assert.equal(core.normalizeUnit(0), '');
  assert.equal(core.normalizeUnit(core.UNIT_MAX + 1), '');
  /* 팩 id 로 왕복해야 폴더 이름으로 쓸 수 있다. */
  const id = core.packIdOf({ catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 'SL2' } });
  assert.equal(id, '2022-ne-kimgitaek-m2-SL2');
  assert.ok(core.PACK_ID_RE.test(id));
  assert.equal(core.packIdFromPath('WB 학습자료/naesin/2026-2/' + id + '/02_본문워크북.pdf'), id);
  assert.equal(core.packIdOf({ catalog: { textbookCode: 'ne-kimgitaek', grade: 'm1', unit: 'SR' } }),
    '2022-ne-kimgitaek-m1-SR');
  /* 정렬: 일반 과가 먼저, Special 은 뒤에 SL → SR 순. */
  assert.deepEqual(core.normalizeNeed({ units: ['SR1', 'L10', 'SL', 'L2', 'SL2'] }).units,
    ['L2', 'L10', 'SL', 'SL2', 'SR1']);
});

test('parsePackId decomposes a folder name, or refuses it', () => {
  assert.deepEqual(core.parsePackId('2015-donga-yunjeongmi-m3-L6'),
    { packId: '2015-donga-yunjeongmi-m3-L6', revision: '2015', textbookCode: 'donga-yunjeongmi', grade: 'm3', unit: 'L6' });
  assert.equal(core.parsePackId('2022 ne kimgitaek m2 L6'), null, 'spaces break the id rule');
  assert.equal(core.parsePackId('2022-ne-kimgitaek-m2-L6/'), null, 'a slash is not part of an id');
  assert.equal(core.parsePackId(''), null);
});

test('packIdOf prefers the stored path and falls back to the catalog', () => {
  assert.equal(core.packIdOf(asset()), '2022-ne-kimgitaek-m2-L5');
  assert.equal(core.packIdOf(asset({ storage: { drivePath: 'WB 학습자료/naesin/2026-2/2015-ybm-parkjuneon-m3-L2/03_단어시험.pdf' } })),
    '2015-ybm-parkjuneon-m3-L2');
  assert.equal(core.packIdOf({ catalog: { textbookCode: 'ne-kimgitaek', grade: 'm3', unit: 2 } }), '',
    'catalog fallback also refuses a grade the book does not have');
  assert.equal(core.packIdOf({ catalog: { textbookCode: 'nope', grade: 'm2', unit: 1 } }), '');
});

/* ── 상태 전이 ── */

test('material transitions follow the B.2 table', () => {
  const ok = [['needed', 'requested'], ['requested', 'approved'], ['requested', 'rejected'], ['approved', 'purchased'],
    ['purchased', 'registered'], ['registered', 'assigned'], ['registered', 'provided'], ['assigned', 'provided'],
    ['provided', 'revoked'], ['rejected', 'requested']];
  ok.forEach(([f, t]) => assert.equal(core.canTransition(f, t), true, f + '→' + t));
  const bad = [['needed', 'approved'], ['requested', 'purchased'], ['approved', 'registered'], ['registered', 'requested'],
    ['revoked', 'assigned'], ['approved', 'approved'], ['x', 'requested']];
  bad.forEach(([f, t]) => assert.equal(core.canTransition(f, t), false, f + '→' + t));
});

test('statusAfter moves on legal events and leaves the status alone otherwise', () => {
  assert.equal(core.statusAfter('requested', 'approve'), 'approved');
  assert.equal(core.statusAfter('approved', 'purchase'), 'purchased');
  assert.equal(core.statusAfter('purchased', 'register'), 'registered');
  assert.equal(core.statusAfter('provided', 'assign'), 'provided', 'a second assignment does not regress');
  assert.equal(core.statusAfter('registered', 'blocked'), 'registered', 'blocked is not a status');
  assert.equal(core.statusAfter('registered', 'audit'), 'registered');
});

/* ── 시험 범위 ── */

test('validateNeed accepts a well-formed set and normalizes it', () => {
  const r = core.validateNeed({ schoolCode: 'sch-07', grade: 'm2', textbookCode: 'ne-kimgitaek', units: [6, 5, 5], examDateCopy: '2026-10-14' });
  assert.equal(r.ok, true, r.errors.join(' / '));
  assert.equal(r.need.schoolCode, 'SCH-07');
  assert.deepEqual(r.need.units, ['L5', 'L6'], '숫자 입력도 토큰으로 정규화된다');
  assert.equal(r.need.subject, '영어');
  assert.equal(r.need.examRef.examDateCopy, '2026-10-14');
  assert.deepEqual(r.need.requiredSeries, ['02', '03']);
  assert.deepEqual(r.need.teacherSeries, ['04', '05', '06']);
});

test('validateNeed rejects school names, bad grades, unknown books, bad units and missing dates', () => {
  const r = core.validateNeed({ schoolCode: '어느중학교', grade: 'h1', textbookCode: 'unknown', units: [0, 99, 2.5], examDateCopy: '10/14' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('SCH-07')));
  assert.ok(r.errors.some(e => e.includes('학년')));
  assert.ok(r.errors.some(e => e.includes('교과서')));
  assert.ok(r.errors.some(e => e.includes('과')));
  assert.ok(r.errors.some(e => e.includes('시험일')));
  assert.equal(core.validateNeed({ schoolCode: 'SCH-7' }).errors.some(e => e.includes('SCH-07')), true, 'two or three digits only');
  assert.equal(core.validateNeed({ schoolCode: 'SCH-123', grade: 'm1', textbookCode: 'ybm-kimeunhyeong', units: [1], examDateCopy: '2026-04-20' }).ok, true);
});

test('required series can grow but 02 and 03 can never be dropped', () => {
  const n = core.normalizeNeed({ requiredSeries: ['07'], teacherSeries: [] });
  assert.deepEqual(n.requiredSeries, ['02', '03', '07']);
  assert.deepEqual(n.teacherSeries, []);
  assert.deepEqual(core.normalizeNeed({ requiredSeries: [] }).requiredSeries, ['02', '03']);
});

test('examDateOf prefers the consult reference and falls back to the Phase 0 copy', () => {
  const n = need({ examRef: { eventId: 'ev1', examDateCopy: '2026-10-14' } });
  assert.equal(core.examDateOf(n, [{ id: 'ev1', examDate: '2026-10-21' }]), '2026-10-21');
  assert.equal(core.examDateOf(n, [{ id: 'other', examDate: '2026-10-21' }]), '2026-10-14');
  assert.equal(core.examDateOf(n), '2026-10-14');
  assert.equal(core.examDateOf(need({ examRef: {} })), '');
});

test('needLabel names the set by code, grade, book and units', () => {
  assert.equal(core.needLabel(need()), 'SCH-07 · 중2 · NE능률(김기택) · L5·L6');
});

/* ── 필요 산출 ── */

test('deriveNeeds yields required student files plus recommended teacher files per unit', () => {
  const d = core.deriveNeeds(need(), []);
  assert.equal(d.needed, 10, '2 units × (02·03 student + 04·05·06 teacher)');
  assert.equal(d.toBuy, 10);
  assert.equal(d.owned, 0);
  assert.equal(d.estimate, 2 * (6500 + 5000 + 5500 * 3));
  const required = d.rows.filter(r => r.tier === 'required');
  assert.equal(required.length, 4);
  assert.ok(required.every(r => r.edition === 'student'));
  assert.ok(d.rows.filter(r => r.tier === 'recommended').every(r => r.edition === 'teacher'));
  assert.equal(d.rows[0].fileName, '02_본문워크북.pdf');
  assert.equal(d.rows[0].catalogKey, 'examforyou|ne-kimgitaek|m2|L5|02|student');
});

test('deriveNeeds excludes owned files and holds pending ones apart from the buy list', () => {
  const owned = asset({ id: 'MAT-0001', status: 'registered' });                              // L05 03 student
  const pending = asset({ id: 'MAT-0002', status: 'requested', catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '02' } });
  const rejected = asset({ id: 'MAT-0003', status: 'rejected', catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 6, series: '03' } });
  const gone = asset({ id: 'MAT-0004', status: 'registered', deleted: true, catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 6, series: '02' } });
  const d = core.deriveNeeds(need(), [owned, pending, rejected, gone]);
  assert.equal(d.needed, 10);
  assert.equal(d.owned, 1);
  assert.equal(d.pending, 1);
  assert.equal(d.toBuy, 8, 'rejected and deleted rows go back on the list');
  assert.ok(!d.rows.some(r => r.catalogKey === core.catalogKey(owned)));
  assert.ok(!d.rows.some(r => r.catalogKey === core.catalogKey(pending)));
  assert.ok(d.rows.some(r => r.catalogKey === core.catalogKey(rejected)));
});

test('deriveNeeds honours custom series choices', () => {
  const d = core.deriveNeeds(need({ units: [3], requiredSeries: ['07'], teacherSeries: [] }), []);
  assert.deepEqual(d.rows.map(r => r.series), ['02', '03', '07']);
  assert.ok(d.rows.every(r => r.edition === 'student'));
});

test('assetFromNeedRow starts life as requested and points back at its need set', () => {
  const row = core.deriveNeeds(need(), []).rows[0];
  const a = core.assetFromNeedRow(row, 'NEED-0001', 'MAT-0010', 1000);
  assert.equal(a.id, 'MAT-0010');
  assert.equal(a.status, 'requested');
  assert.equal(a.links.needId, 'NEED-0001');
  assert.equal(a.cost.hint, 6500);
  assert.equal(core.catalogKey(a), row.catalogKey);
  assert.equal(a.createdAt, 1000);
});

/* ── 잠자는 자료 ── */

test('sleeping lists registered assets whose exam is within seven days', () => {
  const list = [
    asset({ id: 'MAT-0001', status: 'registered' }),
    asset({ id: 'MAT-0002', status: 'assigned' }),
    asset({ id: 'MAT-0003', status: 'registered', links: { needId: 'NEED-0002' } }),
    asset({ id: 'MAT-0004', status: 'registered', links: { needId: '' } })
  ];
  const needs = [need(), need({ id: 'NEED-0002', examRef: { examDateCopy: '2026-11-30' } })];
  const s = core.sleeping(list, needs, '2026-10-08');
  assert.deepEqual(s.map(x => x.asset.id), ['MAT-0001']);
  assert.equal(s[0].daysLeft, 6);
  assert.equal(core.sleeping(list, needs, '2026-09-09').length, 0, 'D-35 is not yet urgent');
  assert.equal(core.sleeping(list, needs, '2026-10-15').length, 0, 'a passed exam is no longer actionable');
  assert.equal(core.sleeping(list, needs, '2026-10-14').length, 1, 'exam day itself still counts');
});

test('daysBetween uses calendar days and rejects bad input', () => {
  assert.equal(core.daysBetween('2026-10-07', '2026-10-14'), 7);
  assert.equal(core.daysBetween('2026-10-14', '2026-10-07'), -7);
  assert.equal(core.daysBetween('x', '2026-10-07'), null);
});

/* ── 이벤트 ── */

test('newEvent stamps id, actor and clipped note and rejects unknown types', () => {
  const e = core.newEvent('MAT-0001', 'blocked', 'S1', { reason: 'not_published', note: 'x'.repeat(400) }, 1700000000000);
  assert.match(e.id, /^LE-[0-9a-z]+-[0-9a-z]{6}$/);
  assert.equal(e.assetId, 'MAT-0001');
  assert.equal(e.type, 'blocked');
  assert.equal(e.byStaffId, 'S1');
  assert.equal(e.at, 1700000000000);
  assert.equal(e.payload.reason, 'not_published');
  assert.equal(e.note.length, 300);
  assert.equal('note' in e.payload, false, 'note lives at the top level, not in the payload');
  assert.equal(core.newEvent('MAT-0001', 'blocked', '', { reason: 'made-up' }).payload.reason, 'other');
  assert.equal(core.newEvent('MAT-0001', 'approve', '').byStaffId, 'admin');
  assert.throws(() => core.newEvent('MAT-0001', 'buy', 'S1'), /알 수 없는/);
});

test('two events created in the same millisecond still get different ids', () => {
  const a = core.newEvent('MAT-0001', 'approve', 'S1', {}, 5);
  const b = core.newEvent('MAT-0001', 'approve', 'S1', {}, 5);
  assert.notEqual(a.id, b.id);
});

test('leadTime measures approve→register and stops the clock while blocked', () => {
  const H = 36e5;
  const events = [
    { type: 'request', at: 0 },
    { type: 'approve', at: 1 * H },
    { type: 'blocked', at: 2 * H, payload: { reason: 'payment' } },
    { type: 'unblocked', at: 5 * H },
    { type: 'purchase', at: 6 * H },
    { type: 'register', at: 7 * H }
  ];
  const lt = core.leadTime(events);
  assert.equal(lt.ms, 3 * H, '6h wall clock minus 3h blocked');
  assert.equal(lt.blockedMs, 3 * H);
  assert.equal(lt.hours, 3);
  assert.equal(core.leadTime([{ type: 'approve', at: 1 }]), null, 'no register yet');
  assert.equal(core.leadTime([{ type: 'register', at: 1 }]), null, 'no approve at all');
  const open = core.leadTime([{ type: 'approve', at: H }, { type: 'blocked', at: 2 * H }, { type: 'register', at: 4 * H }]);
  assert.equal(open.ms, H, 'an unclosed block runs until registration');
});

test('priceDiff flags a 20% gap and any charge against a zero hint', () => {
  assert.deepEqual(core.priceDiff(5000, 5000), { diff: 0, pct: 0, warn: false });
  assert.equal(core.priceDiff(5000, 5500).warn, false);
  assert.equal(core.priceDiff(5000, 6500).warn, true);
  assert.equal(core.priceDiff(0, 100).warn, true);
  assert.equal(core.priceDiff(0, 0).warn, false);
});

test('discipline checks: purchase without request and duplicate purchases', () => {
  const events = [
    { assetId: 'MAT-0001', type: 'request', at: 1 }, { assetId: 'MAT-0001', type: 'purchase', at: 2 },
    { assetId: 'MAT-0002', type: 'purchase', at: 3 }
  ];
  assert.deepEqual(core.unrequestedPurchases(events), ['MAT-0002']);
  const dup = core.duplicatePurchases([asset({ id: 'MAT-0001' }), asset({ id: 'MAT-0002', status: 'purchased' }), asset({ id: 'MAT-0003', status: 'requested' })]);
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].ids, ['MAT-0001', 'MAT-0002']);
});

test('countByStatus skips deleted rows and lists every status', () => {
  const c = core.countByStatus([asset(), asset({ id: 'MAT-0002', status: 'requested' }), asset({ id: 'MAT-0003', deleted: true })]);
  assert.equal(c.registered, 1);
  assert.equal(c.requested, 1);
  assert.equal(c.needed, 0);
  assert.equal(Object.keys(c).length, core.STATUS.length);
});

/* ── 정규화 ── */

test('normalizeAsset fills defaults, derives the price hint and drops unknown status', () => {
  const a = core.normalizeAsset({ id: ' MAT-0001 ', status: 'bogus', catalog: { series: '3' }, cost: {}, note: 'n'.repeat(500) });
  assert.equal(a.id, 'MAT-0001');
  assert.equal(a.kind, 'material');
  assert.equal(a.source, 'examforyou');
  assert.equal(a.status, 'needed');
  assert.equal(a.catalog.series, '03');
  assert.equal(a.catalog.edition, 'student');
  assert.equal(a.cost.hint, 5000);
  assert.equal(a.license.scope, 'enrolled_only');
  assert.equal(a.license.redistribution, false);
  assert.equal(a.note.length, 300);
  assert.equal(a.deleted, false);
  assert.equal(a.blockReason, '');
});

test('normalizeAsset keeps an explicit hint and validates block reasons', () => {
  const a = core.normalizeAsset({ id: 'MAT-0001', cost: { hint: 1234, amount: '5000', paidAt: '2026-09-09' }, blockReason: 'made-up' });
  assert.equal(a.cost.hint, 1234);
  assert.equal(a.cost.amount, 5000);
  assert.equal(a.cost.paidAt, '2026-09-09');
  assert.equal(a.blockReason, '');
  assert.equal(core.normalizeAsset({ blockReason: 'drive_access' }).blockReason, 'drive_access');
});

test('the asset has no personal-data fields', () => {
  const keys = Object.keys(asset());
  ['studentId', 'studentName', 'phone', 'schoolName', 'email', 'password', 'account'].forEach(k => {
    assert.ok(!keys.includes(k), k);
  });
  const needKeys = Object.keys(need());
  assert.ok(!needKeys.includes('schoolName'));
  assert.ok(!needKeys.includes('examDate'), 'the exam date is a reference, not a column');
});

/* ── 업무지시서 ── */

test('purchaseAssignments folds several assets into one sheet with a step per asset', () => {
  const list = [
    asset({ id: 'MAT-0108', status: 'approved', catalog: { textbookCode: 'ne-kimgitaek', grade: 'm2', unit: 5, series: '04', edition: 'teacher' } }),
    asset({ id: 'MAT-0107', status: 'approved' })
  ];
  const out = core.purchaseAssignments(list, need(), '담당', '2026-09-09');
  assert.equal(out.assignments.length, 1);
  const a = out.assignments[0];
  assert.equal(a.staff, '담당');
  assert.equal(a.title, '[자산] MAT-0107~MAT-0108 구매·인테이크');
  assert.equal(a.steps.length, 2);
  assert.equal(a.target, 2);
  assert.equal(a.unit, '건');
  assert.equal(a.repeat, 'once');
  assert.equal(a.start, '2026-09-09');
  assert.equal(a.carry, true);
  assert.equal(a.priority, 'normal', 'D-35 is not urgent');
  assert.ok(a.detail.includes('SCH-07 · 중2 · NE능률(김기택) · L5·L6 · 시험 2026-10-14 (D-35)'));
  assert.ok(a.detail.includes('WB 학습자료/naesin/'));
  assert.ok(a.detail.includes('MAT-0107 → 2022-ne-kimgitaek-m2-L5/03_단어시험.pdf (예상 5,000원)'));
  assert.ok(a.detail.includes('MAT-0108 → 2022-ne-kimgitaek-m2-L5/04_예상문제_PRE-STEP_교사용.pdf'));
  assert.ok(a.detail.includes('예상 합계 10,500원'));
  assert.ok(a.guide.includes('승인된 건만 결제'));
  assert.ok(a.guide.includes('학생 이름·학교명은 적지 않습니다'));
  const first = typeof a.steps[0] === 'string' ? a.steps[0] : a.steps[0].label;
  assert.equal(first, 'MAT-0107 · 03_단어시험.pdf → NE능률(김기택)/중2/L5');
});

test('purchaseAssignments uses the official link key on steps when the link module is present', () => {
  const out = core.purchaseAssignments([asset({ status: 'approved' })], need(), '담당', '2026-10-01',
    { buyUrl: 'https://example.test/buy', linkKey: 'exam4you' });
  const a = out.assignments[0];
  assert.ok(a.detail.includes('https://example.test/buy'));
  assert.deepEqual(a.steps[0], { label: 'MAT-0001 · 03_단어시험.pdf → NE능률(김기택)/중2/L5', ext: 'exam4you' });
  assert.equal(a.priority, 'high', 'D-13 is urgent');
});

test('purchaseAssignments reads the exam4you link from a global WBExternalLinks when available', () => {
  globalThis.WBExternalLinks = { linkFor: key => (key === 'exam4you' ? { url: 'https://official.test/', label: 'x' } : null) };
  try {
    const a = core.purchaseAssignments([asset()], need(), '담당', '2026-09-09').assignments[0];
    assert.ok(a.detail.includes('https://official.test/'));
    assert.equal(a.steps[0].ext, 'exam4you');
  } finally {
    delete globalThis.WBExternalLinks;
  }
});

test('purchaseAssignments splits long lists and returns nothing without a staff name', () => {
  const many = [];
  for (let i = 1; i <= 15; i++) many.push(asset({ id: 'MAT-' + String(i).padStart(4, '0'), status: 'approved' }));
  const out = core.purchaseAssignments(many, need(), '담당', '2026-09-09');
  assert.equal(out.assignments.length, 2);
  assert.ok(out.assignments[0].title.endsWith('(1/2)'));
  assert.equal(out.assignments[0].steps.length + out.assignments[1].steps.length, 15);
  assert.deepEqual(core.purchaseAssignments(many, need(), '', '2026-09-09'), { assignments: [] });
  assert.deepEqual(core.purchaseAssignments([], need(), '담당', '2026-09-09'), { assignments: [] });
});
