'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const core = require('./staff-attendance-history-core.js');

const date = '2030-04-05';
const staff = [{ id: 's-example', name: '예시 선생님' }];
const at = Date.parse(date + 'T09:05:00+09:00');
const out = Date.parse(date + 'T11:35:00+09:00');
function row(record, overrides = {}) {
  return core.buildRows({ staff, checks: { ['__att__s-example|' + date]: record }, dates: [date], ...overrides })[0];
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('each supplied date has one row per staff, preserving both orders and empty records', () => {
  const rows = core.buildRows({
    staff: [{ id: 'z-example', name: '예시 둘' }, { id: 'a-example', name: '예시 하나' }],
    dates: ['2030-04-05', '2030-04-04'], checks: {}
  });
  assert.deepEqual(rows.map(r => [r.date, r.staffId]), [
    ['2030-04-05', 'z-example'], ['2030-04-05', 'a-example'],
    ['2030-04-04', 'z-example'], ['2030-04-04', 'a-example']
  ]);
  assert.ok(rows.every(r => r.status === 'no_record' && r.label === '기록 없음'));
  assert.ok(rows.every(r => r.clockIn === '' && r.clockOut === '' && r.duration === ''));
});

test('staff filter is exact, retains leading zeroes, and includes days without records', () => {
  const options = { staff: [{ id: '007', name: '예시 영칠' }, { id: '7', name: '예시 칠' }],
    dates: [date, '2030-04-04'], checks: { ['__att__007|' + date]: { done: true, at, out } } };
  const rows = core.buildRows({ ...options, staffId: '007' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.staffId, r.name, r.status]), [
    ['007', '예시 영칠', 'complete'], ['007', '예시 영칠', 'no_record']
  ]);
  assert.equal(core.buildRows({ ...options, staffId: '' }).length, 4);
  assert.deepEqual(core.buildRows({ ...options, staffId: 'missing' }), []);
});

test('formats KST clock times with leading zeroes and useful elapsed time units', () => {
  assert.deepEqual(row({ done: true, at, out }), {
    staffId: 's-example', name: '예시 선생님', date, clockIn: '09:05', clockOut: '11:35',
    duration: '2시간 30분', status: 'complete', label: '출퇴근 완료'
  });
  for (const [minutes, expected] of [[120, '2시간'], [5, '5분']]) {
    assert.equal(row({ done: true, at, out: at + minutes * 60000 }).duration, expected);
  }
  assert.equal(row({ done: true, at, out: at + 119999 }).duration, '1분');
  assert.equal(row({ done: true, at, out: at }).status, 'invalid');
  assert.equal(row({ done: true, at: String(at), out: String(out) }).status, 'complete');
});

test('uses the KST date at UTC midnight boundaries and is independent of device timezone', () => {
  const record = { done: true, at: Date.parse('2030-04-04T15:01:00Z'), out: Date.parse('2030-04-04T16:02:00Z') };
  assert.equal(row(record).clockIn, '00:01');
  assert.equal(row(record).clockOut, '01:02');
  assert.equal(row(record).status, 'complete');
  const script = 'const core = require(' + JSON.stringify(require.resolve('./staff-attendance-history-core.js')) + ');' +
    'process.stdout.write(JSON.stringify(core.buildRows(' + JSON.stringify({
      staff, dates: [date], checks: { ['__att__s-example|' + date]: record }
    }) + ')));';
  const utc = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
  const la = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' });
  assert.equal(utc, la);
  assert.equal(JSON.parse(la)[0].clockIn, '00:01');
});

test('no record and missing checkout remain neutral descriptions', () => {
  for (const record of [undefined, null, {}, { done: false }, { done: false, at: null, out: '' }]) {
    assert.equal(row(record).status, 'no_record');
    assert.equal(row(record).label, '기록 없음');
  }
  for (const empty of [undefined, null, '']) {
    const actual = row({ done: true, at, out: empty });
    assert.equal(actual.status, 'missing_out');
    assert.equal(actual.label, '퇴근 미기록');
    assert.equal(actual.clockIn, '09:05');
    assert.equal(actual.clockOut, '');
    assert.equal(actual.duration, '');
  }
});

test('corrupt, mismatched, reversed and orphan timestamps require attention without elapsed time', () => {
  const invalidRecords = [
    { done: true }, { done: true, at: null, out }, { done: false, at, out },
    { done: 'true', at, out }, { at, out }, { done: true, at, out: at - 1 },
    { done: true, at: at - 86400000, out }, { done: true, at, out: out + 86400000 },
    { done: false, out }, true, 'corrupt', 0, [],
    ...[NaN, Infinity, -1, 0, 'bad', ' ', false, {}, [], 9e20].flatMap(value => [
      { done: true, at: value, out }, { done: true, at, out: value }
    ])
  ];
  for (const record of invalidRecords) {
    const actual = row(record);
    assert.equal(actual.status, 'invalid', JSON.stringify(record));
    assert.equal(actual.label, '시간 확인 필요');
    assert.equal(actual.duration, '');
    assert.ok(!JSON.stringify(actual).includes('NaN'));
  }
  const wrongDay = row({ done: true, at: at - 86400000, out });
  assert.equal(wrongDay.clockIn, '');
  assert.equal(wrongDay.clockOut, '11:35');
});

test('summaries count the displayed rows, including all four statuses', () => {
  const rows = [row({ done: true, at, out }), row({ done: true, at }), row(null), row({ done: true, out })];
  assert.deepEqual(core.summary(rows), { total: 4, complete: 1, missingOut: 1, noRecord: 1, invalid: 1 });
  assert.deepEqual(core.summary(rows.slice(0, 2)), { total: 2, complete: 1, missingOut: 1, noRecord: 0, invalid: 0 });
  assert.deepEqual(core.summary([]), { total: 0, complete: 0, missingOut: 0, noRecord: 0, invalid: 0 });
});

test('history and summary never mutate inputs or reuse record objects', () => {
  const input = freeze({ staff, dates: [date], staffId: '', checks: {
    ['__att__s-example|' + date]: { done: true, at, out, note: '예시 메모' }
  } });
  const before = JSON.stringify(input);
  const rows = core.buildRows(input);
  core.summary(freeze(rows));
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(rows[0], input.checks['__att__s-example|' + date]);
  assert.notEqual(core.buildRows(input)[0], rows[0]);
});

test('empty inputs are safe and inherited checks are not treated as saved records', () => {
  assert.deepEqual(core.buildRows(), []);
  assert.deepEqual(core.buildRows({ staff, dates: [] }), []);
  assert.deepEqual(core.summary(), { total: 0, complete: 0, missingOut: 0, noRecord: 0, invalid: 0 });
  const checks = Object.create({ ['__att__s-example|' + date]: { done: true, at, out } });
  assert.equal(core.buildRows({ staff, dates: [date], checks })[0].status, 'no_record');
});
