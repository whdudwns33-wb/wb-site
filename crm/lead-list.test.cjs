'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const C = require('./crm-core.js');

const TODAY = '2026-10-16';
const pending = due => ({ due, status: 'pending' });
const lead = (id, patch = {}) => ({ id, name: '보호자 ' + id, status: 'open', pipeline: 'inspection', stage: 'inquiry',
  channel: '블로그', owner: 'admin', createdAt: '2026-10-01', child: { name: '학생 ' + id, school: '가상학교' },
  followups: [], ...patch });
const ids = (leads, filters = {}, today = TODAY) => C.queryLeads(leads, filters, today).map(l => l.id);
const sample = [
  lead('a', { createdAt: '2026-10-01', followups: [pending('2026-10-15'), pending(TODAY)] }),
  lead('b', { createdAt: '2026-10-02', owner: 'staff-a', stage: 'tested', followups: [pending(TODAY)] }),
  lead('c', { createdAt: '2026-10-03', status: 'hold', channel: '맘카페', followups: [pending(TODAY)] }),
  lead('d', { createdAt: '2026-10-04', status: 'won', stage: 'won', followups: [pending('2026-10-15')] }),
  lead('e', { createdAt: '2026-10-05', status: 'lost', stage: 'lost' }),
  lead('f', { createdAt: '2026-10-06', owner: 'staff-a', pipeline: 'academy', stage: 'active', followups: [pending('2026-10-17')] })
];

test('기본 전체 보기와 빈 필터는 최신순이며, 기존 진행 필터는 보류도 포함한다', () => {
  assert.deepEqual(ids(sample), ['f', 'e', 'd', 'c', 'b', 'a']);
  assert.deepEqual(ids(sample, { q: '  ', status: '', channel: '', owner: '', pipeline: '', stage: '', followup: '' }), ids(sample));
  assert.deepEqual(ids(sample, { status: 'open' }), ['f', 'c', 'b', 'a']);
  assert.deepEqual(ids(sample, { status: 'hold' }), ['c']);
  assert.deepEqual(ids(sample, { status: 'won' }), ['d']);
  assert.deepEqual(ids(sample, { status: 'lost' }), ['e']);
});

test('검색은 기존 이름·아이·학교·전화 규칙을 재사용한다', () => {
  const records = [lead('a', { name: '가상 보호자', child: { name: '가상 학생', school: '테스트학교' }, phone: '010-0000-0000' }), lead('b')];
  for (const q of ['가상 보호자', '가상 학생', '테스트학교', '01000000000']) assert.deepEqual(ids(records, { q }), ['a']);
  assert.deepEqual(ids(records, { q: '찾을 수 없는 고객' }), []);
});

test('검색·상태·채널·담당·파이프라인·단계·날짜 필터를 모두 AND로 적용한다', () => {
  const filters = { q: '학생 b', status: 'open', channel: '블로그', owner: 'staff-a', pipeline: 'inspection', stage: 'tested', followup: 'today' };
  assert.deepEqual(ids(sample, filters), ['b']);
  for (const patch of [{ channel: '맘카페' }, { owner: 'admin' }, { pipeline: 'academy' }, { stage: 'active' }, { followup: 'overdue' }]) {
    assert.deepEqual(ids(sample, { ...filters, ...patch }), []);
  }
});

test('담당자와 파이프라인·단계는 독립적으로 좁혀지며 숫자 ID도 맞춘다', () => {
  assert.deepEqual(ids(sample, { owner: 'staff-a' }), ['f', 'b']);
  assert.deepEqual(ids(sample, { pipeline: 'academy' }), ['f']);
  assert.deepEqual(ids(sample, { stage: 'tested' }), ['b']);
  assert.deepEqual(ids([lead('n', { owner: 42 })], { owner: '42' }), ['n']);
});

test('고객 등급 필터는 미분류와 A~D를 구분하고 다른 조건과 함께 좁힌다', () => {
  const records = [lead('old'), lead('empty', { customerGrade: '' }),
    ...C.CUSTOMER_GRADES.map(customerGrade => lead(customerGrade, { customerGrade }))];
  const before = JSON.stringify(records);
  assert.equal(ids(records, { customerGrade: '' }).length, records.length);
  assert.deepEqual(ids(records, { customerGrade: 'unclassified' }).sort(), ['empty', 'old']);
  for (const customerGrade of C.CUSTOMER_GRADES) assert.deepEqual(ids(records, { customerGrade }), [customerGrade]);
  assert.deepEqual(ids(records, { customerGrade: 'D', q: '학생 D', status: 'open', channel: '블로그' }), ['D']);
  assert.deepEqual(ids(records, { customerGrade: 'D', channel: '맘카페' }), []);
  assert.deepEqual(ids(records, { customerGrade: 'D', q: '학생 A' }), []);
  for (const customerGrade of ['E', 'd', '__proto__', [], {}, 0]) assert.deepEqual(ids(records, { customerGrade }), []);
  assert.equal(JSON.stringify(records), before);
});

test('오늘·지연 보기는 표시되는 가장 이른 유효 미완료 일정과 일치한다', () => {
  assert.deepEqual(ids(sample, { followup: 'today' }), ['b']);
  assert.deepEqual(ids(sample, { followup: 'overdue' }), ['a']);
  assert.equal(C.nextLeadFollowup(sample[0]).due, '2026-10-15');
  assert.equal(C.nextLeadFollowup(sample[2]), null);
  assert.equal(C.nextLeadFollowup(sample[3]), null);
});

test('무효 날짜·완료·건너뜀·비정상 팔로업을 제외한 뒤 다음 일정을 고른다', () => {
  const expected = pending(TODAY);
  const record = lead('a', { followups: [null, [], 'bad', {}, pending({ toString: null }), pending('2026-02-30'), pending(''), pending('2026-13-01'),
    { due: '2026-10-14', status: 'done' }, { due: '2026-10-15', status: 'skipped' }, expected, pending('2026-10-17')] });
  assert.equal(C.nextLeadFollowup(record), expected);
  assert.deepEqual(ids([record], { followup: 'today' }), ['a']);
  assert.equal(C.nextLeadFollowup(lead('b', { followups: [pending('bad')] })), null);
  for (const malformed of [null, undefined, 4, [], {}, lead('a', { followups: 'bad' })]) assert.equal(C.nextLeadFollowup(malformed), null);
});

test('날짜 조건은 유효한 기준일을 요구하고 윤년을 구분한다', () => {
  const records = [lead('leap', { followups: [pending('2024-02-29')] }), lead('invalid', { followups: [pending('2026-02-29')] })];
  assert.deepEqual(ids(records, { followup: 'today' }, '2024-02-29'), ['leap']);
  assert.deepEqual(ids(records, { followup: 'today' }, '2026-02-29'), []);
  for (const today of ['', 'bad', null, undefined, { toString: null }]) assert.deepEqual(C.queryLeads(sample, { followup: 'overdue' }, today), []);
});

test('정렬은 최신·오래된·이름·다음 일정 순서와 미예정 마지막을 지원한다', () => {
  assert.deepEqual(ids(sample, { sort: 'oldest' }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(sample, { sort: 'name' }), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(sample, { sort: 'next' }), ['a', 'b', 'f', 'e', 'd', 'c']);
  assert.deepEqual(ids(sample, { sort: 'unknown' }), ids(sample));
});

test('다음 일정 동률은 최신·이름·ID 순이며 입력 배열의 순서에 의존하지 않는다', () => {
  const records = [lead('d', { name: '나', child: { name: '나학생' }, followups: [pending(TODAY)] }),
    lead('c', { name: '가', child: { name: '가학생' }, followups: [pending(TODAY)] }), lead('b', { name: '가', child: { name: '가학생' }, followups: [pending(TODAY)] }),
    lead('a', { name: '다', child: { name: '다학생' }, createdAt: '2026-10-02', followups: [pending(TODAY)] })];
  assert.deepEqual(ids(records, { sort: 'next' }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(records.slice().reverse(), { sort: 'next' }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(records, { sort: 'name' }), ['b', 'c', 'd', 'a']);
});

test('이름순은 보호자보다 학생 이름을 먼저 비교하고 기존 보호자 표기에서도 학생을 찾는다', () => {
  const records = [
    lead('last', { name: '가상보호', child: { name: '다학생' }, createdAt: '2026-10-03' }),
    lead('middle', { name: ' 나학생 보호자 ', child: {}, createdAt: '2026-10-02' }),
    lead('first', { name: '다상보호', child: { name: '가학생' }, createdAt: '2026-10-01' })
  ];
  assert.deepEqual(ids(records, { sort: 'name' }), ['first', 'middle', 'last']);
  assert.deepEqual(ids(records.slice().reverse(), { sort: 'name' }), ['first', 'middle', 'last']);
});

test('이름순에서 보호자는 같은 학생 이름의 동률 또는 학생 정보가 없을 때만 비교한다', () => {
  const records = [
    lead('same-b', { name: '다상보호', child: { name: '가학생' }, createdAt: '2026-10-03' }),
    lead('guardian-only', { name: '나상보호', child: {} }),
    lead('same-a', { name: '가상보호', child: { name: '가학생' }, createdAt: '2026-10-01' })
  ];
  assert.deepEqual(ids(records, { sort: 'name' }), ['same-a', 'same-b', 'guardian-only']);
});

test('알 수 없거나 비정상인 조건은 전체 결과로 조용히 넓히지 않는다', () => {
  for (const filters of [{ status: '__proto__' }, { pipeline: '__proto__' }, { stage: '__proto__' }, { channel: '없는 채널' },
    { followup: 'tomorrow' }, { q: {} }, { owner: [] }, { stage: { toString: null } }]) {
    assert.deepEqual(ids(sample, filters), []);
  }
  const literal = '<img src=x onerror=alert(1)>.*';
  assert.deepEqual(ids([lead('literal', { name: literal }), lead('other')], { q: literal }), ['literal']);
});

test('빈 목록·배열이 아닌 입력을 처리하고 비정상 배열 항목은 건너뛴다', () => {
  for (const records of [null, undefined, 4, 'bad', {}]) assert.deepEqual(C.queryLeads(records, {}, TODAY), []);
  assert.deepEqual(ids([null, 1, 'bad', [], lead('a')]), ['a']);
  assert.deepEqual(ids([], {}), []);
  assert.deepEqual(ids(sample, null), ids(sample));
});

test('200건 넘는 결과도 잘라내지 않고 원본 배열·객체·조건을 바꾸지 않는다', () => {
  const records = Array.from({ length: 250 }, (_, i) => lead(String(i).padStart(3, '0'), { followups: [pending(TODAY)] }));
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  freeze(records);
  const filters = freeze({ status: 'open', followup: 'today', sort: 'next' });
  const before = JSON.stringify(records);
  const result = C.queryLeads(records, filters, TODAY);
  assert.equal(result.length, 250);
  assert.notEqual(result, records);
  assert.equal(result[0], records[0]);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(filters, { status: 'open', followup: 'today', sort: 'next' });
});
