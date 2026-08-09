const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./asset-core.js');

function asset(extra) {
  return core.normalizeAsset(Object.assign({
    id: 'A001',
    model: 'SM-T583',
    battery: 'ok',
    charge: 'ok',
    screen: 'ok',
    chrome: '138',
    checkedAt: 1
  }, extra || {}));
}

/* ── 저장 키 ── */

test('asset key round-trips and stays inside the checks prefix scheme', () => {
  const key = core.assetKey('A007');
  assert.equal(key, '__asset__A007|all');
  assert.equal(core.isAssetKey(key), true);
  assert.equal(core.assetIdFromKey(key), 'A007');
});

test('other check prefixes are not mistaken for assets', () => {
  ['__st__S1|2026-08-09', '__op__홍길동|2026-08', 'task123|2026-08-09'].forEach(k => {
    assert.equal(core.isAssetKey(k), false, k);
    assert.equal(core.assetIdFromKey(k), '');
  });
});

/* ── 기종 판별 ── */

test('model codes map to device kinds regardless of spacing or case', () => {
  assert.equal(core.kindOfModel('SM-T583'), 'adv2');
  assert.equal(core.kindOfModel('sm t583'), 'adv2');
  assert.equal(core.kindOfModel('SM-T500'), 'a7');
  assert.equal(core.kindOfModel('SM-T505'), 'a7');
  assert.equal(core.kindOfModel('SM-X200'), 'other');
  assert.equal(core.kindOfModel(''), 'other');
});

test('only Advanced2 carries the S Pen', () => {
  assert.equal(core.kindInfo('adv2').spen, true);
  assert.equal(core.kindInfo('a7').spen, false);
});

/* ── 상태 판정 ── */

test('a swollen battery is fatal and names the safety reason', () => {
  const h = core.healthOf(asset({ battery: 'swollen' }));
  assert.equal(h.level, 'dead');
  assert.ok(h.reasons.some(r => r.includes('부풀음')));
});

test('charge failure and cracked screen are fatal', () => {
  assert.equal(core.healthOf(asset({ charge: 'fail' })).level, 'dead');
  assert.equal(core.healthOf(asset({ screen: 'crack' })).level, 'dead');
});

test('launcher lock is a watch item, not a fatal one', () => {
  const h = core.healthOf(asset({ locked: 'mbest' }));
  assert.equal(h.level, 'watch');
  assert.ok(h.reasons.some(r => r.includes('1544-2300')));
});

test('Advanced2 below Chrome 138 is flagged for update', () => {
  const h = core.healthOf(asset({ chrome: '120' }));
  assert.equal(h.level, 'watch');
  assert.ok(h.reasons.some(r => r.includes('138')));
});

test('Chrome version is only judged on Advanced2', () => {
  const h = core.healthOf(asset({ model: 'SM-T500', kind: 'a7', chrome: '120' }));
  assert.equal(h.level, 'ok');
});

test('a fatal fault outranks a watch fault', () => {
  const h = core.healthOf(asset({ battery: 'swollen', locked: 'mbest' }));
  assert.equal(h.level, 'dead');
});

test('an unaudited device is never reported as ok', () => {
  const h = core.healthOf(core.normalizeAsset({ id: 'A002', model: 'SM-T583' }));
  assert.equal(h.level, 'watch');
  assert.ok(h.reasons.includes('실사 미완료'));
});

/* ── 실사 완료 판정 ── */

test('audit needs all three condition fields plus a timestamp', () => {
  assert.equal(core.isAudited(asset()), true);
  assert.equal(core.isAudited(asset({ checkedAt: 0 })), false);
  assert.equal(core.isAudited(asset({ screen: '' })), false);
});

/* ── 티어 추천 ── */

test('A7 is recommended for teachers, Advanced2 for single-purpose', () => {
  assert.equal(core.recommendTier(asset({ model: 'SM-T500', kind: 'a7' })).tier, 'T');
  assert.equal(core.recommendTier(asset()).tier, 'B');
});

test('a broken device is recommended for quarantine whatever its model', () => {
  const rec = core.recommendTier(asset({ model: 'SM-T500', kind: 'a7', battery: 'swollen' }));
  assert.equal(rec.tier, 'C');
});

test('placing a device implies its tier', () => {
  assert.equal(core.tierOfPlace('teacher'), 'T');
  assert.equal(core.tierOfPlace('student'), 'S');
  assert.equal(core.tierOfPlace('center'), 'B');
  assert.equal(core.tierOfPlace('quarantine'), 'C');
  assert.equal(core.tierOfPlace('nope'), '');
  assert.equal(core.placeLabel('center'), '센터');
});

/* ── 라벨 번호 ── */

test('next label continues past the highest number, not the gap', () => {
  const list = [asset({ id: 'A001' }), asset({ id: 'A004' })];
  assert.equal(core.nextId(list, 'A'), 'A005');
  assert.equal(core.nextId([], 'A'), 'A001');
});

test('next label ignores other prefixes', () => {
  const list = [asset({ id: 'B009' })];
  assert.equal(core.nextId(list, 'A'), 'A001');
});

/* ── 집계 ── */

test('audit progress counts done, remaining, and faults', () => {
  const list = [
    asset({ id: 'A001' }),
    asset({ id: 'A002', battery: 'swollen' }),
    core.normalizeAsset({ id: 'A003', model: 'SM-T583' })
  ];
  const p = core.auditProgress(list);
  assert.equal(p.total, 3);
  assert.equal(p.done, 2);
  assert.equal(p.left, 1);
  assert.equal(p.dead, 1);
  assert.equal(p.pct, 67);
});

test('progress on an empty ledger does not divide by zero', () => {
  assert.deepEqual(core.auditProgress([]), { total: 0, done: 0, left: 0, dead: 0, watch: 0, pct: 0 });
});

test('devices group by placement and unset ones are visible', () => {
  const counts = core.countBy([
    asset({ id: 'A001', place: 'teacher' }),
    asset({ id: 'A002', place: 'teacher' }),
    asset({ id: 'A003' })
  ], 'place');
  assert.equal(counts.teacher, 2);
  assert.equal(counts['(미지정)'], 1);
});

test('a staff member only sees devices assigned to them', () => {
  const list = [asset({ id: 'A001', holder: 'S1' }), asset({ id: 'A002', holder: 'S2' })];
  assert.deepEqual(core.assetsOfHolder(list, 'S1').map(a => a.id), ['A001']);
  assert.deepEqual(core.assetsOfHolder(list, ''), []);
});

/* ── 일괄 등록 ── */

test('bulk paste accepts commas or tabs and fills missing labels', () => {
  const out = core.parseBulk('A010, SM-T583, R52M1\n\tSM-T500\tR9XT2', []);
  assert.equal(out.errors.length, 0);
  assert.equal(out.added.length, 2);
  assert.equal(out.added[0].id, 'A010');
  assert.equal(out.added[0].kind, 'adv2');
  assert.equal(out.added[0].serial, 'R52M1');
  assert.equal(out.added[1].id, 'A011', 'auto label continues from the row above');
  assert.equal(out.added[1].kind, 'a7');
  assert.equal(out.added[1].os, '12');
});

test('bulk paste accepts a line that starts straight at the model code', () => {
  const out = core.parseBulk('SM-T583, R52M1\nSM-T500', []);
  assert.equal(out.errors.length, 0);
  assert.equal(out.added[0].id, 'A001');
  assert.equal(out.added[0].model, 'SM-T583');
  assert.equal(out.added[0].serial, 'R52M1');
  assert.equal(out.added[1].id, 'A002');
  assert.equal(out.added[1].model, 'SM-T500');
});

test('bulk paste rejects duplicates against existing and within the same paste', () => {
  const existing = [asset({ id: 'A001' })];
  const out = core.parseBulk('A001, SM-T583\nA002, SM-T583\nA002, SM-T500', existing);
  assert.equal(out.added.length, 1);
  assert.equal(out.added[0].id, 'A002');
  assert.equal(out.errors.length, 2);
  assert.ok(out.errors[0].why.includes('이미 있는 번호'));
});

test('bulk paste reports the offending line instead of dropping it silently', () => {
  const out = core.parseBulk('A001\nA002, SM-T583', []);
  assert.equal(out.errors[0].line, 1);
  assert.ok(out.errors[0].why.includes('모델명'));
  assert.equal(out.added.length, 1);
});

/* ── 업무지시서 연동 ── */

test('audit assignments cover only unaudited devices and split into batches', () => {
  const list = [];
  for (let i = 1; i <= 30; i++) list.push(core.normalizeAsset({ id: 'A' + i, model: 'SM-T583' }));
  list.push(asset({ id: 'A900' }));

  const out = core.buildAuditAssignments(list, { staff: '김혜지', perTask: 25 });
  assert.equal(out.length, 2);
  assert.equal(out[0].target, 25);
  assert.equal(out[1].target, 5);
  assert.equal(out[0].staff, '김혜지');
  assert.ok(out[0].title.includes('1/2'));
  assert.equal(out[0].steps.length, 25);
  assert.equal(out[0].priority, 'high');
  assert.ok(!out.some(a => a.steps.some(s => s.startsWith('A900 '))), 'audited device is excluded');
});

test('audit assignment title has no batch suffix when it fits in one', () => {
  const list = [core.normalizeAsset({ id: 'A001', model: 'SM-T583' })];
  const out = core.buildAuditAssignments(list, { staff: '김혜지' });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, '태블릿 실사');
});

test('no staff or nothing pending yields no assignment', () => {
  assert.deepEqual(core.buildAuditAssignments([asset()], { staff: '김혜지' }), []);
  assert.deepEqual(core.buildAuditAssignments([core.normalizeAsset({ id: 'A1' })], { staff: '' }), []);
});

test('repair assignment lists each broken device with its reason', () => {
  const list = [asset({ id: 'A001', battery: 'swollen' }), asset({ id: 'A002' })];
  const a = core.buildRepairAssignment(list, { staff: '김혜지' });
  assert.equal(a.target, 1);
  assert.ok(a.steps[0].startsWith('A001 — '));
  assert.ok(a.steps[0].includes('부풀음'));
  assert.equal(core.buildRepairAssignment([asset()], { staff: '김혜지' }), null);
});

test('privacy-handling devices get their own recurring check', () => {
  const list = [asset({ id: 'A020', pii: true, spot: '센터 대기실' }), asset({ id: 'A021' })];
  const a = core.buildPiiCheckAssignment(list, { staff: '김혜지' });
  assert.equal(a.target, 1);
  assert.equal(a.repeat, 'days');
  assert.deepEqual(a.days, [1]);
  assert.ok(a.steps[0].includes('센터 대기실'));
  assert.ok(a.guide.includes('키오스크'));
  assert.equal(core.buildPiiCheckAssignment([asset()], { staff: '김혜지' }), null);
});

/* ── 정규화 ── */

test('normalize tolerates junk and never returns undefined fields', () => {
  const a = core.normalizeAsset(null);
  assert.equal(a.id, '');
  assert.equal(a.kind, 'other');
  assert.equal(a.pii, false);
  assert.equal(a.checkedAt, 0);
  assert.equal(core.normalizeAsset({ checkedAt: 'x' }).checkedAt, 0);
});

test('kind is inferred from the model when not stored', () => {
  assert.equal(core.normalizeAsset({ model: 'SM-T583' }).kind, 'adv2');
  assert.equal(core.normalizeAsset({ model: 'SM-T583', kind: 'a7' }).kind, 'a7', 'explicit kind wins');
});
