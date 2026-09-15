const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./runbook-core.js');
const links = require('../../shared/external-links.js');
const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'runbook-pack.json'), 'utf8'));

/* index.html이 이 파일을 실제로 load하는지는 통합 담당의 훅 테스트가 본다. 여기서는 로직만. */

const CONTRACT_SLOTS = [
  'R-1230-OPEN', 'R-1300-SF', 'R-1400-INBOX', 'R-1500-CC', 'R-1600-EXAM', 'R-1700-MM',
  'R-2030-SF', 'R-2100-CLOSE', 'R-MON-SUB', 'R-Q-NELT', 'R-NEW-ACCT'
];

function localMs(ymd, hm) {
  const p = ymd.split('-').map(Number), t = hm.split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0], t[1]).getTime();
}

function task(extra) {
  return Object.assign({
    id: 't1', staffId: 's1', title: '[R-2030-SF] 스터디포스 수행 확인', time: '20:30', window: 30,
    runbookSlotId: 'R-2030-SF', steps: [{ id: 'a', label: '수행 화면 확인', ext: 'studyforce_admin' }, { id: 'b', label: 'handoff 갱신' }],
    repeat: 'weekday', days: [], start: '2026-09-01', end: '', carry: false, deleted: false
  }, extra || {});
}

/* ── 팩 ── */

test('shipped pack is valid against the link table and carries the 11 contract slots', () => {
  const v = core.validatePack(pack, { linkFor: links.linkFor });
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(pack.packVersion, '2026.09-1');
  assert.deepEqual(pack.slots.map(s => s.slotId).sort(), CONTRACT_SLOTS.slice().sort());
});

test('pack has no URLs, no personal data and only approved link keys', () => {
  const text = JSON.stringify(pack);
  assert.ok(!/https?:\/\//.test(text), 'URLs live in external-links.js only');
  assert.ok(!/01\d-?\d{3,4}-?\d{4}/.test(text), 'no phone numbers');
  assert.ok(!/@/.test(text), 'no email');
  pack.slots.forEach(s => s.steps.forEach(st => {
    if (st.ext) assert.ok(links.linkFor(st.ext), s.slotId + ' step ext ' + st.ext);
  }));
  pack.linkKeys.forEach(k => assert.ok(links.linkFor(k), 'linkKeys ' + k));
});

test('every slot guide explains procedure and judgement (long enough, has numbered steps)', () => {
  pack.slots.forEach(s => {
    assert.ok(s.guide.length >= 80, s.slotId + ' guide too short');
    assert.ok(/1\)|판단 기준/.test(s.guide), s.slotId + ' guide has numbered steps or a judgement rule');
  });
});

test('validatePack reports each broken field instead of throwing', () => {
  const bad = {
    packVersion: 'v1',
    linkKeys: ['nope_key'],
    slots: [
      { slotId: 'r-bad', title: '', slotTime: '25:00', window: 999, repeat: 'days', days: [], priority: 'urgent', guide: '', steps: [] },
      { slotId: 'R-1', title: 'ok', guide: '절차 https://evil.example.com', steps: [{ label: 'x', ext: 'evil_key' }] },
      { slotId: 'R-1', title: 'dup', guide: '괜찮은 안내 1) 하나', steps: [{ label: 'y' }] },
      'not an object'
    ]
  };
  const v = core.validatePack(bad, { linkFor: links.linkFor });
  assert.equal(v.ok, false);
  const text = v.errors.join('\n');
  ['packVersion', 'slotId 형식', 'title', 'slotTime', 'window', 'days', 'priority', 'guide가 비었습니다', 'steps는 1~12',
    'URL', 'evil_key', 'slotId 중복', 'nope_key', '객체가 아닙니다'].forEach(k => assert.ok(text.includes(k), 'missing error about ' + k));
  assert.equal(core.validatePack(null).ok, false);
  assert.equal(core.validatePack({ packVersion: '2026.09-1', slots: [] }).ok, false);
});

test('guide with a phone number is rejected by the pack validator', () => {
  const p = JSON.parse(JSON.stringify(pack));
  p.slots[0].guide += ' 문의 010-1234-5678';
  const v = core.validatePack(p);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.includes('전화번호')));
});

/* ── 슬롯 ↔ task ── */

test('titleFor / slotIdOf / isRunbookTask agree on the [R-…] prefix', () => {
  const slot = pack.slots.find(s => s.slotId === 'R-2030-SF');
  assert.equal(core.titleFor(slot), '[R-2030-SF] 스터디포스 수행 확인');
  assert.equal(core.slotIdOf({ title: '[R-2030-SF] 스터디포스 수행 확인' }), 'R-2030-SF', 'Phase 0 title-only instance');
  assert.equal(core.slotIdOf({ runbookSlotId: 'R-1300-SF', title: '아무거나' }), 'R-1300-SF', 'field wins');
  assert.equal(core.slotIdOf({ runbookSlotId: 'bad', title: '[R-1300-SF] x' }), 'R-1300-SF', 'bad field falls back to title');
  assert.equal(core.slotIdOf({ title: '스터디포스 수행 확인' }), '');
  assert.equal(core.slotIdOf({ title: '[주문] 교재' }), '');
  assert.equal(core.isRunbookTask(task()), true);
  assert.equal(core.isRunbookTask(task({ deleted: true })), false);
  assert.equal(core.isRunbookTask({ title: '일반 업무' }), false);
  assert.equal(core.isRunbookTask(null), false);
  assert.equal(core.stripSlotPrefix('[R-2030-SF]   스터디포스 수행 확인'), '스터디포스 수행 확인');
});

/* 슬롯 id 형식 — 프로그램데스크 런타임(applyAssignments)이 같은 정규식으로 통과시킨다. */
test('slot id regex accepts R-… ids only', () => {
  assert.ok(core.SLOT_ID_RE.test('R-2030-SF'));
  assert.ok(core.SLOT_ID_RE.test('R-Q-NELT'));
  assert.ok(!core.SLOT_ID_RE.test('r-2030'));
  assert.ok(!core.SLOT_ID_RE.test('R-'));
});

test('adoptLegacySlotTitle promotes title-only tasks once', () => {
  assert.deepEqual(core.adoptLegacySlotTitle({ title: '[R-MON-SUB] 구독 명단 대조' }), { runbookSlotId: 'R-MON-SUB' });
  assert.equal(core.adoptLegacySlotTitle(task()), null, 'already has the field');
  assert.equal(core.adoptLegacySlotTitle({ title: '일반' }), null);
});

/* ── 마감·지연 ── */

test('dueLimit is time + window with a 60 minute default and a 23:59 cap', () => {
  assert.equal(core.dueLimit(task()), '21:00');
  assert.equal(core.dueLimit(task({ window: undefined })), '21:30');
  assert.equal(core.dueLimit(task({ window: 0 })), '20:30');
  assert.equal(core.dueLimit(task({ time: '23:30', window: 120 })), '23:59');
  assert.equal(core.dueLimit(task({ time: '' })), '', 'no time → no limit');
  assert.equal(core.dueLimit(task({ window: 5000 })), '23:59', 'window is capped at MAX_WINDOW');
  assert.equal(core.windowOf({ window: '45' }), 45);
  assert.equal(core.windowOf({}), 60);
});

test('isLate: not done and past the limit; done after the limit; blocked never; boundary is inclusive', () => {
  const t = task();
  assert.equal(core.isLate(t, null, '20:59'), false);
  assert.equal(core.isLate(t, null, '21:00'), false, 'limit minute itself is still on time');
  assert.equal(core.isLate(t, null, '21:01'), true);
  assert.equal(core.isLate(t, { done: true, at: localMs('2026-09-09', '20:45') }, '23:00'), false);
  assert.equal(core.isLate(t, { done: true, at: localMs('2026-09-09', '21:07') }, '23:00'), true);
  assert.equal(core.isLate(t, { blocked: true }, '23:00'), false, 'blocked is reported as blocked, not late');
  assert.equal(core.isLate(task({ time: '' }), null, '23:00'), false);
});

test('done time prefers doneAt, then at, then updatedAt (approximation)', () => {
  assert.equal(core.doneAtOf({ doneAt: 3, at: 2, updatedAt: 1 }), 3);
  assert.equal(core.doneAtOf({ at: 2, updatedAt: 1 }), 2);
  assert.equal(core.doneAtOf({ updatedAt: 1 }), 1);
  assert.equal(core.doneAtOf(null), 0);
  const t = task();
  assert.equal(core.onTime(t, { done: true, updatedAt: localMs('2026-09-09', '20:50') }), true);
  assert.equal(core.onTime(t, { done: true, updatedAt: localMs('2026-09-09', '21:30') }), false);
  assert.equal(core.onTime(t, { done: false }), false);
  assert.equal(core.onTime(task({ time: '' }), { done: true }), true, 'no limit → done counts as on time');
});

test('checkStatus mirrors the app: blocked > done > doing(steps or count) > todo', () => {
  const t = task();
  assert.equal(core.checkStatus(t, null), 'todo');
  assert.equal(core.checkStatus(t, { steps: { a: true } }), 'doing');
  assert.equal(core.checkStatus(t, { count: 2 }), 'doing');
  assert.equal(core.checkStatus(t, { done: true }), 'done');
  assert.equal(core.checkStatus(t, { done: true, blocked: true }), 'blocked');
});

/* ── 발행 ── */

test('expandPack emits applyAssignments-shaped rows, skips existing and manual slots', () => {
  const r = core.expandPack(pack, '김직원', { start: '2026-09-09', existingSlotIds: ['R-1230-OPEN'], linkFor: links.linkFor });
  assert.deepEqual(r.errors, []);
  const ids = r.assignments.map(a => a.runbookSlotId);
  assert.ok(!ids.includes('R-1230-OPEN'), 'existing slot skipped');
  assert.ok(!ids.includes('R-1600-EXAM') && !ids.includes('R-Q-NELT'), 'manual slots are not auto-issued');
  assert.equal(ids.length, 8);
  assert.deepEqual(r.skipped.map(s => s.slotId + ':' + s.reason).sort(), ['R-1230-OPEN:exists', 'R-1600-EXAM:manual', 'R-Q-NELT:manual']);
  const sf = r.assignments.find(a => a.runbookSlotId === 'R-2030-SF');
  assert.equal(sf.staff, '김직원');
  assert.equal(sf.title, '[R-2030-SF] 스터디포스 수행 확인');
  assert.equal(sf.time, '20:30');
  assert.equal(sf.window, 30);
  assert.equal(sf.repeat, 'weekday');
  assert.deepEqual(sf.days, []);
  assert.equal(sf.start, '2026-09-09');
  assert.equal(sf.end, '');
  assert.equal(sf.carry, false);
  assert.equal(sf.priority, 'high');
  assert.equal(sf.target, 0, 'count is a measurement, not a completion target');
  assert.equal(sf.runbookPackVersion, '2026.09-1');
  assert.deepEqual(sf.steps, [{ label: '오늘 수행 화면 확인', ext: 'studyforce_admin' }, { label: 'handoff 문서(구독 엑셀) 갱신 완료' }]);
  assert.ok(sf.guide.length > 50);
  const cc = r.assignments.find(a => a.runbookSlotId === 'R-1500-CC');
  assert.equal(cc.repeat, 'days');
  assert.deepEqual(cc.days, [3, 5]);
  assert.equal(cc.unit, '반');
  const mon = r.assignments.find(a => a.runbookSlotId === 'R-MON-SUB');
  assert.deepEqual(mon.days, [1]);
  r.assignments.forEach(a => {
    ['staff', 'title', 'detail', 'guide', 'steps', 'target', 'unit', 'time', 'priority', 'repeat', 'days', 'start', 'end', 'carry',
      'runbookSlotId', 'runbookPackVersion', 'window'].forEach(k => assert.ok(k in a, a.runbookSlotId + ' has ' + k));
  });
});

test('expandPack with slotIds issues exactly the chosen slots, manual included', () => {
  const r = core.expandPack(pack, '김직원', { start: '2026-09-15', slotIds: ['R-1600-EXAM', 'R-2030-SF'] });
  assert.deepEqual(r.assignments.map(a => a.runbookSlotId), ['R-1600-EXAM', 'R-2030-SF']);
  const exam = r.assignments[0];
  assert.equal(exam.repeat, 'once');
  assert.equal(exam.start, '2026-09-15');
  const all = core.expandPack(pack, '김직원', { start: '2026-09-15', includeManual: true });
  assert.equal(all.assignments.length, 11);
});

test('expandPack refuses an invalid pack or a missing staff name', () => {
  assert.deepEqual(core.expandPack({ packVersion: 'x', slots: [] }, '김직원', {}).assignments, []);
  assert.ok(core.expandPack({ packVersion: 'x', slots: [] }, '김직원', {}).errors.length);
  assert.ok(core.expandPack(pack, '', {}).errors.length);
});

test('activeSlotIds ignores ended tasks and past once-slots', () => {
  const tasks = [
    task({ id: '1', runbookSlotId: 'R-2030-SF' }),
    task({ id: '2', runbookSlotId: 'R-1300-SF', end: '2026-09-01' }),
    task({ id: '3', runbookSlotId: 'R-Q-NELT', repeat: 'once', start: '2026-06-01' }),
    task({ id: '4', runbookSlotId: 'R-1600-EXAM', repeat: 'once', start: '2026-09-20' }),
    task({ id: '5', runbookSlotId: 'R-1230-OPEN', deleted: true }),
    { id: '6', title: '일반 업무' }
  ];
  assert.deepEqual(core.activeSlotIds(tasks, '2026-09-09').sort(), ['R-1600-EXAM', 'R-2030-SF']);
});

/* ── 집계 ── */

test('summarize counts only runbook tasks and sorts by time', () => {
  const d = '2026-09-09';
  const tasks = [
    task({ id: 'a', time: '20:30', window: 30, runbookSlotId: 'R-2030-SF', title: '[R-2030-SF] 수행 확인' }),
    task({ id: 'b', time: '13:00', window: 60, runbookSlotId: 'R-1300-SF', title: '[R-1300-SF] 명단 점검' }),
    task({ id: 'c', time: '15:00', window: 60, runbookSlotId: 'R-1500-CC', title: '[R-1500-CC] 세트 점검', unit: '반' }),
    task({ id: 'd', time: '12:30', window: 30, runbookSlotId: 'R-1230-OPEN', title: '[R-1230-OPEN] 런북 확인' }),
    { id: 'z', staffId: 's1', title: '일반 업무', time: '09:00' }
  ];
  const checks = {
    ['a|' + d]: { done: true, at: localMs(d, '21:10'), note: 'SF-012 계정 없음' },
    ['b|' + d]: { done: true, at: localMs(d, '13:20') },
    ['c|' + d]: { count: 2, steps: { a: true }, note: '' },
    ['d|' + d]: { blocked: true, note: '요청함이 안 열림' }
  };
  const s = core.summarize(tasks, (id, date) => checks[id + '|' + date] || null, d, '22:00');
  assert.equal(s.issued, 4);
  assert.equal(s.done, 2);
  assert.equal(s.onTime, 1);
  assert.equal(s.late, 2, 'a done late + c still open past limit');
  assert.equal(s.blocked, 1);
  assert.equal(s.doing, 1);
  assert.equal(s.completionRate, 50);
  assert.equal(s.onTimeRate, 25);
  assert.deepEqual(s.slots.map(x => x.slotId), ['R-1230-OPEN', 'R-1300-SF', 'R-1500-CC', 'R-2030-SF']);
  const cc = s.slots.find(x => x.slotId === 'R-1500-CC');
  assert.equal(cc.count, 2);
  assert.equal(cc.unit, '반');
  assert.equal(cc.stepsDone, 1);
  assert.equal(cc.stepsTotal, 2);
  assert.equal(cc.status, 'doing');
  const sf = s.slots.find(x => x.slotId === 'R-2030-SF');
  assert.equal(sf.doneHM, '21:10');
  assert.equal(sf.late, true);
  assert.equal(sf.dueLimit, '21:00');
  assert.equal(sf.title, '수행 확인');
  assert.equal(core.summarize([], () => null, d, '12:00').issued, 0);
});

test('carriedSlots looks back over unfinished carry slots', () => {
  const byDate = {
    '2026-09-08': [task({ id: 'a', carry: true }), task({ id: 'b', runbookSlotId: 'R-1230-OPEN', carry: false })],
    '2026-09-05': [task({ id: 'c', carry: true }), { id: 'x', title: '일반', carry: true }]
  };
  const checks = { 'c|2026-09-05': { done: true } };
  const out = core.carriedSlots('2026-09-09', d => byDate[d] || [], (id, d) => checks[id + '|' + d] || null, 7);
  assert.deepEqual(out.map(o => o.taskId + '@' + o.daysAgo), ['a@1']);
  assert.equal(out[0].status, 'todo');
});

/* ── 요청 상태 전이 (서버와 같은 표) ── */

test('nextStatus: the happy path requested→accepted→in_progress→done for the assignee', () => {
  const ctx = { role: 'staff', isOwner: false, isAssignee: true };
  assert.equal(core.nextStatus('requested', 'accept', ctx).status, 'accepted');
  assert.equal(core.nextStatus('accepted', 'start', ctx).status, 'in_progress');
  assert.equal(core.nextStatus('in_progress', 'done', ctx).status, 'done');
  assert.equal(core.nextStatus('requested', 'done', ctx).ok, false, 'cannot skip to done');
  assert.equal(core.nextStatus('accepted', 'done', ctx).status, 'done', 'server allows done straight after accept');
  assert.equal(core.nextStatus('blocked', 'done', ctx).status, 'done', 'server allows done from blocked');
  assert.equal(core.nextStatus('requested', 'start', ctx).ok, false);
});

test('nextStatus: blocked from anywhere open, unblock returns to in_progress', () => {
  const ctx = { role: 'staff', isAssignee: true };
  ['requested', 'accepted', 'in_progress'].forEach(s => assert.equal(core.nextStatus(s, 'block', ctx).status, 'blocked', s));
  assert.equal(core.nextStatus('blocked', 'block', ctx).ok, false);
  assert.equal(core.nextStatus('blocked', 'unblock', ctx).status, 'in_progress');
  assert.equal(core.nextStatus('accepted', 'unblock', ctx).ok, false);
});

test('nextStatus: cancel only from requested by the owner or an admin; assign is admin only', () => {
  const owner = { role: 'staff', isOwner: true, isAssignee: false };
  const other = { role: 'staff', isOwner: false, isAssignee: true };
  const admin = { role: 'admin' };
  assert.equal(core.nextStatus('requested', 'cancel', owner).status, 'cancelled');
  assert.equal(core.nextStatus('requested', 'cancel', other).ok, false, 'assignee cannot cancel');
  assert.equal(core.nextStatus('requested', 'cancel', admin).status, 'cancelled');
  assert.equal(core.nextStatus('accepted', 'cancel', owner).ok, false, 'accepted work is not cancelled by the requester');
  assert.equal(core.nextStatus('requested', 'assign', admin).ok, true);
  assert.equal(core.nextStatus('requested', 'assign', admin).status, 'requested', 'assign keeps the status');
  assert.equal(core.nextStatus('in_progress', 'assign', admin).ok, true);
  assert.equal(core.nextStatus('requested', 'assign', other).ok, false);
  assert.equal(core.nextStatus('requested', 'accept', owner).ok, false, 'requester who is not assignee cannot accept');
  assert.equal(core.nextStatus('requested', 'accept', admin).ok, true, 'admin may act as handler');
});

test('nextStatus: terminal states and garbage are refused with a reason', () => {
  const admin = { role: 'admin' };
  ['done', 'cancelled'].forEach(s => core.REQ_ACTIONS.forEach(a => assert.equal(core.nextStatus(s, a, admin).ok, false, s + ' ' + a)));
  assert.equal(core.nextStatus('nope', 'accept', admin).reason, 'unknown_status');
  assert.equal(core.nextStatus('requested', 'fly', admin).reason, 'unknown_action');
  assert.equal(core.nextStatus('requested', 'accept', null).ok, false);
  assert.deepEqual(core.allowedActions('requested', { role: 'staff', isAssignee: true }), ['accept', 'block']);
  assert.deepEqual(core.allowedActions('requested', { role: 'staff', isOwner: true }), ['cancel']);
  assert.deepEqual(core.allowedActions('blocked', { role: 'admin' }), ['done', 'unblock', 'assign']);
  assert.deepEqual(core.allowedActions('accepted', { role: 'staff', isAssignee: true }), ['start', 'done', 'block']);
});

/* ── 소요·SLA ── */

test('leadTime uses requester (created→done) and work (accepted→done) clocks, null when open', () => {
  const req = { status: 'done', createdAt: 1000, acceptedAt: 4000, doneAt: 10000 };
  assert.deepEqual(core.leadTime(req), { owner: 9000, work: 6000 });
  assert.deepEqual(core.leadTime({ status: 'done', createdAt: 1000, doneAt: 5000 }), { owner: 4000, work: null });
  assert.equal(core.leadTime({ status: 'in_progress', createdAt: 1000 }), null);
  assert.equal(core.leadTime(null), null);
  assert.equal(core.median([5, 1, 3]), 3);
  assert.equal(core.median([4, 1, 3, 2]), 2.5);
  assert.equal(core.median([]), null);
  assert.equal(core.median(['x']), null);
});

test('slaMet compares the done day with neededBy', () => {
  assert.equal(core.slaMet({ status: 'done', neededBy: '2026-09-10', doneAt: localMs('2026-09-10', '18:00') }), true);
  assert.equal(core.slaMet({ status: 'done', neededBy: '2026-09-10', doneAt: localMs('2026-09-11', '09:00') }), false);
  assert.equal(core.slaMet({ status: 'accepted', neededBy: '2026-09-10' }), null);
});

/* ── 요청 검증 ── */

test('validateRequest accepts SF codes and stable ids and rejects names or phones as target', () => {
  const base = { reqType: 'account', program: 'studyforce', targetRef: 'SF-012', neededBy: '2026-09-10', detail: '스터디포스 계정 발급', via: 'app' };
  assert.equal(core.validateRequest(base).ok, true);
  assert.equal(core.validateRequest(Object.assign({}, base, { targetRef: 'stu_8f3a-1' })).ok, true, 'stable id');
  const name = core.validateRequest(Object.assign({}, base, { targetRef: '홍길동' }));
  assert.equal(name.ok, false);
  assert.equal(name.errors[0].field, 'targetRef');
  assert.equal(core.validateRequest(Object.assign({}, base, { targetRef: '010-1234-5678' })).ok, false);
  assert.equal(core.validateRequest(Object.assign({}, base, { targetRef: '' })).ok, false, 'account needs a target');
  assert.equal(core.validateRequest(Object.assign({}, base, { targetRef: 'SF-12' })).ok, false, 'SF- prefix must be SF-000 like the server');
  assert.equal(core.validateRequest(Object.assign({}, base, { targetRef: 'sf-012' })).ok, false, 'server is case-strict on SF codes');
  assert.equal(core.validateRequest(Object.assign({}, base, { reqType: 'worksheet', targetRef: '' })).ok, true, 'worksheet may be class-level');
});

test('validateRequest checks vocabulary, date, detail sanitization and via', () => {
  const base = { reqType: 'other', program: 'none', targetRef: '', neededBy: '2026-09-10', detail: '넬트 단계 입력 부탁드립니다', via: 'kakao' };
  assert.equal(core.validateRequest(base).ok, true);
  const fields = input => core.validateRequest(Object.assign({}, base, input)).errors.map(e => e.field);
  assert.deepEqual(fields({ reqType: 'material' }), ['reqType'], 'material is a B ledger concern');
  assert.deepEqual(fields({ program: 'naesin' }), ['program']);
  assert.deepEqual(fields({ neededBy: '2026-02-30' }), ['neededBy']);
  assert.deepEqual(fields({ detail: '' }), ['detail'], 'server requires a 1~300 char line');
  assert.deepEqual(fields({ detail: '   ' }), ['detail']);
  assert.deepEqual(fields({ reqType: 'account', program: 'nelt', targetRef: 'SF-001', detail: '' }), ['detail'], 'even account needs a line');
  assert.deepEqual(fields({ detail: '연락처 010-9999-8888' }), ['detail']);
  assert.deepEqual(fields({ detail: 'x'.repeat(301) }), ['detail']);
  assert.deepEqual(fields({ via: 'auto' }), ['via'], 'auto is server-only');
  assert.deepEqual(fields({ assigneeId: '김 직원' }), ['assigneeId']);
  assert.deepEqual(fields({ reqType: 'assignment', program: 'none' }), ['program'], 'assignment needs a program');
  const v = core.validateRequest(Object.assign({}, base, { targetRef: '  SF-003 ', detail: '넬트  단계\n입력 ' }));
  assert.equal(v.value.targetRef, 'SF-003', 'value is trimmed');
  assert.equal(v.value.detail, '넬트 단계 입력', 'detail is folded to one line like the server cleanLine');
});

test('validateResult allows https official links only for account/assignment/worksheet', () => {
  const ok = core.validateResult({ resultNote: '세트 배정 완료', resultUrl: 'https://www.classcard.net/set/1' }, 'assignment', links.isApprovedLink);
  assert.equal(ok.ok, true);
  assert.equal(core.validateResult({ resultUrl: 'http://www.classcard.net/set/1' }, 'assignment', links.isApprovedLink).ok, false, 'http');
  assert.equal(core.validateResult({ resultUrl: 'https://drive.google.com/x' }, 'assignment', links.isApprovedLink).ok, false, 'not an approved host');
  assert.equal(core.validateResult({ resultUrl: 'https://www.classcard.net/set/1' }, 'other', links.isApprovedLink).ok, false, 'no url for other');
  assert.equal(core.validateResult({ resultNote: 'a@b.co' }, 'other', links.isApprovedLink).ok, false);
  assert.equal(core.validateResult({}, 'other', links.isApprovedLink).ok, true);
});

test('sortRequests: open first, by neededBy, then oldest', () => {
  const list = [
    { id: 'a', status: 'done', neededBy: '2026-09-01', createdAt: 1 },
    { id: 'b', status: 'requested', neededBy: '2026-09-12', createdAt: 5 },
    { id: 'c', status: 'in_progress', neededBy: '2026-09-10', createdAt: 9 },
    { id: 'd', status: 'requested', neededBy: '2026-09-10', createdAt: 2 },
    { id: 'e', status: 'blocked', neededBy: '', createdAt: 3 }
  ];
  assert.deepEqual(core.sortRequests(list).map(r => r.id), ['d', 'c', 'b', 'e', 'a']);
  assert.equal(core.isOpenRequest(list[0]), false);
  assert.equal(core.isOpenRequest(list[4]), true);
});

/* ── sanitizeNote ── */

test('sanitizeNote rejects phone, email, RRN and control chars, passes ordinary Korean notes', () => {
  [
    '요청 3건 중 1건 내일 처리', 'SF-012 계정 없음 → 막힘', '2026-09-09 16:00 자료 확인', '누락 반 2개 배정, 0건 오류',
    '1544-2300 문의 필요', '3주 전 · 12:30 · 21:00', '문제지 5장 제작 (학년 2, 단원 3-1)'
  ].forEach(s => assert.equal(core.sanitizeNote(s).ok, true, s));
  assert.equal(core.sanitizeNote('010-1234-5678').reason, 'phone');
  assert.equal(core.sanitizeNote('연락 01012345678 부탁').reason, 'phone');
  assert.equal(core.sanitizeNote('02-123-4567').reason, 'phone');
  assert.equal(core.sanitizeNote('메일 kim.ys@example.com').reason, 'email');
  assert.equal(core.sanitizeNote('900101-1234567').reason, 'rrn');
  assert.equal(core.sanitizeNote('9001011234567').reason, 'rrn');
  assert.equal(core.sanitizeNote('a\u0001b').reason, 'control');
  assert.equal(core.sanitizeNote('x'.repeat(301)).reason, 'too_long');
  assert.equal(core.sanitizeNote('x'.repeat(301), 400).ok, true, 'custom limit');
  assert.equal(core.sanitizeNote('').ok, true);
  assert.equal(core.sanitizeNote(null).ok, true);
  assert.equal(core.maskIdentifiers('SF-012 계정, SF-1234 아님'), 'SF-••• 계정, SF-1234 아님');
});

/* ── 주간 리포트 ── */

test('weeklyReport aggregates seven days and never carries a student identifier', () => {
  const week = '2026-09-07';
  const byDate = {};
  for (let i = 0; i < 5; i++) {
    const d = core.addDays(week, i);
    byDate[d] = [task({ id: 'sf' + i, staffId: 's1' }), task({ id: 'open' + i, runbookSlotId: 'R-1230-OPEN', time: '12:30', window: 30, title: '[R-1230-OPEN] 런북 확인' })];
  }
  const checks = {};
  Object.keys(byDate).forEach((d, i) => {
    checks['sf' + i + '|' + d] = i === 4 ? { blocked: true, note: 'SF-007 화면 오류' } : { done: true, at: localMs(d, i === 3 ? '21:30' : '20:50'), note: 'SF-001 ok' };
    checks['open' + i + '|' + d] = { done: true, at: localMs(d, '12:40') };
  });
  const ms = (d, hm) => localMs(d, hm);
  const requests = [
    { id: 'r1', reqType: 'account', program: 'studyforce', targetRef: 'SF-021', status: 'done', via: 'app', neededBy: '2026-09-09',
      createdAt: ms('2026-09-08', '10:00'), acceptedAt: ms('2026-09-08', '14:00'), doneAt: ms('2026-09-08', '16:00'), detail: 'SF-021 계정' },
    { id: 'r2', reqType: 'worksheet', program: 'metamath', targetRef: 'SF-022', status: 'done', via: 'kakao', neededBy: '2026-09-09',
      createdAt: ms('2026-09-08', '10:00'), acceptedAt: ms('2026-09-09', '10:00'), doneAt: ms('2026-09-10', '17:00') },
    { id: 'r3', reqType: 'other', status: 'blocked', via: 'kakao', neededBy: '2026-09-11', createdAt: ms('2026-09-09', '10:00') },
    { id: 'r4', reqType: 'account', status: 'requested', via: 'app', neededBy: '2026-09-11', createdAt: ms('2026-09-15', '10:00'), targetRef: 'SF-099' }
  ];
  const r = core.weeklyReport(week, d => byDate[d] || [], (id, d) => checks[id + '|' + d] || null, requests, '23:00');
  assert.equal(r.disclaimer, '절차 지표이며 학습 결과가 아님');
  assert.equal(r.weekStart, week);
  assert.equal(r.weekEnd, '2026-09-13');
  assert.equal(r.issued, 10);
  assert.equal(r.done, 9);
  assert.equal(r.onTime, 8);
  assert.equal(r.late, 1);
  assert.equal(r.blocked, 1);
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.bySlot.map(s => s.slotId), ['R-1230-OPEN', 'R-2030-SF']);
  assert.equal(r.bySlot[1].late, 1);
  assert.equal(r.requests.total, 3, 'r4 is next week');
  assert.equal(r.requests.done, 2);
  assert.equal(r.requests.open, 1);
  assert.equal(r.requests.blocked, 1);
  assert.equal(r.requests.kakao, 2);
  assert.equal(r.requests.kakaoRate, 67);
  assert.equal(r.requests.byType.account, 1);
  assert.equal(r.requests.byType.worksheet, 1);
  assert.equal(r.requests.byType.other, 1);
  assert.equal(r.requests.leadOwnerMedianMs, (6 * 3600000 + 55 * 3600000) / 2);
  assert.equal(r.requests.leadWorkMedianMs, (2 * 3600000 + 31 * 3600000) / 2);
  assert.equal(r.requests.slaMet, 1);
  assert.equal(r.requests.slaTotal, 2);
  const text = core.weeklyReportText(r);
  assert.ok(text.startsWith('📋 주간 절차 리포트'));
  assert.ok(text.split('\n')[1].includes('절차 지표이며 학습 결과가 아님'), 'disclaimer on the first lines');
  const dump = JSON.stringify(r) + text;
  assert.ok(!/SF-\d{3}/.test(dump), 'no SF code in the report');
  assert.ok(!/SF-•••/.test(dump), 'not even masked ones — notes are not in the report');
  assert.ok(!dump.includes('targetRef'), 'targetRef field is absent');
  assert.ok(!dump.includes('화면 오류'), 'notes are absent');
});

test('weeklyReportText survives an empty report', () => {
  const txt = core.weeklyReportText(core.weeklyReport('2026-09-07', () => [], () => null, []));
  assert.ok(txt.includes('발행 0'));
  assert.ok(txt.includes('—'), 'empty medians render as a dash');
  assert.equal(core.fmtDuration(30 * 60000), '30분');
  assert.equal(core.fmtDuration(5.5 * 3600000), '5.5시간');
  assert.equal(core.fmtDuration(3 * 24 * 3600000), '3일');
  assert.equal(core.fmtDuration(null), '—');
});

/* ── 어휘 상수 ── */

test('vocabulary matches the contract', () => {
  assert.deepEqual(core.REQ_TYPES, ['account', 'assignment', 'worksheet', 'followup', 'other']);
  assert.deepEqual(core.PROGRAMS, ['studyforce', 'classcard', 'metamath', 'nelt', 'exam4you', 'jokbo', 'none']);
  assert.deepEqual(core.REQ_STATUS, ['requested', 'accepted', 'in_progress', 'done', 'blocked', 'cancelled']);
  assert.deepEqual(core.REQ_ACTIONS, ['accept', 'start', 'done', 'block', 'unblock', 'cancel', 'assign']);
  assert.deepEqual(core.VIA, ['app', 'kakao', 'auto']);
  core.REQ_TYPES.forEach(t => assert.ok(core.REQ_TYPE_LABEL[t]));
  core.PROGRAMS.forEach(p => assert.ok(core.PROGRAM_LABEL[p]));
  core.REQ_STATUS.forEach(s => assert.ok(core.REQ_STATUS_LABEL[s]));
  core.REQ_ACTIONS.forEach(a => assert.ok(core.REQ_ACTION_LABEL[a]));
  /* 프로그램 어휘(none 제외)는 링크 표의 program 값과 맞아야 요청 카드에서 링크를 찾을 수 있다. */
  const linkPrograms = new Set(links.keys().map(k => links.programOf(k)));
  core.PROGRAMS.filter(p => p !== 'none').forEach(p => assert.ok(linkPrograms.has(p), 'link for program ' + p));
});

test('date helpers', () => {
  assert.equal(core.validYmd('2026-09-09'), true);
  assert.equal(core.validYmd('2026-13-01'), false);
  assert.equal(core.validYmd('2026-9-9'), false);
  assert.equal(core.dowOf('2026-09-09'), 3, 'Wednesday');
  assert.equal(core.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(core.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(core.hmToMin('20:30'), 1230);
  assert.equal(core.hmToMin('24:00'), -1);
  assert.equal(core.minToHM(1230), '20:30');
  assert.equal(core.minToHM(-5), '00:00');
  assert.equal(core.hmOf(localMs('2026-09-09', '07:05')), '07:05');
  assert.equal(core.hmOf(0), '');
});
