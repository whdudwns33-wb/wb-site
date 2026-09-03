const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function block(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} 블록을 찾을 수 없습니다`);
  return html.slice(start, end);
}

function syncApply(state) {
  const methods = block('collect(since) {', 'async post(path, body)');
  return new Function('state', `
    const ownerOfCheck = () => null;
    const isContactCheckKey = () => false;
    const onboardingServerConfirmedAt = new Map();
    const sync = { ${methods} };
    return sync.apply.bind(sync);
  `)(state);
}

test('forced canonical makeup tombstone replaces a locally newer active makeup task', () => {
  const local = {
    id: 'makeup_lesson_mu-1', title: '[수업] 로컬 변조 보강', updatedAt: 9999, deleted: false,
    lessonInstanceType: 'makeup', makeupCaseId: 'mu-1', makeupSourceTaskId: 'lesson-1'
  };
  const canonical = {
    ...local, title: '[수업] 서버 정본 보강', updatedAt: 100, deleted: true
  };
  const state = { staff: [], checks: {}, tasks: [local] };
  const apply = syncApply(state);

  assert.equal(apply([{
    table: 'tasks', key: canonical.id, data: canonical, updated_at: 100, authoritative: true
  }]), 1);
  assert.deepEqual(state.tasks[0], canonical);
  assert.equal(state.tasks[0].deleted, true, 'server tombstone must hide the stale local makeup lesson');
});

test('timestamp override is limited to an authoritative envelope carrying a same-id makeup marker', () => {
  const regularLocal = { id: 'regular-1', title: '일반 업무', updatedAt: 9999 };
  const regularOlder = { ...regularLocal, title: '서버 일반 업무', updatedAt: 100 };
  const staffLocal = { id: 'staff-1', name: '직원 로컬', updatedAt: 9999 };
  const state = { staff: [staffLocal], checks: {}, tasks: [regularLocal] };
  const apply = syncApply(state);

  assert.equal(apply([{ table: 'tasks', key: regularOlder.id, data: regularOlder,
    updated_at: 100, authoritative: true }]), 0, 'ordinary authoritative tasks keep normal LWW');
  assert.equal(state.tasks[0].title, '일반 업무');

  const dataFlagOnly = { ...regularOlder, authoritative: true, lessonInstanceType: 'makeup' };
  assert.equal(apply([{ table: 'tasks', key: dataFlagOnly.id, data: dataFlagOnly, updated_at: 100 }]), 0,
    'a flag inside client-controlled data is not an authoritative envelope');
  assert.equal(state.tasks[0].title, '일반 업무');

  const mismatched = { ...dataFlagOnly, id: 'different-id' };
  assert.equal(apply([{ table: 'tasks', key: regularLocal.id, data: mismatched,
    updated_at: 100, authoritative: true }]), 0, 'the canonical data id must match its envelope key');
  assert.equal(state.tasks[0].id, regularLocal.id);

  assert.equal(apply([{ table: 'staff', key: staffLocal.id,
    data: { ...staffLocal, name: '서버 직원', updatedAt: 100 }, updated_at: 100, authoritative: true }]), 0);
  assert.equal(state.staff[0].name, '직원 로컬');
});

test('all three persisted makeup identity markers can authorize a forced tombstone independently of deleted state', () => {
  for (const marker of [
    { lessonInstanceType: 'makeup' },
    { makeupCaseId: 'mu-2' },
    { makeupSourceTaskId: 'lesson-2' }
  ]) {
    const local = { id: 'makeup-marker', title: '로컬', updatedAt: 9999 };
    const canonical = { id: local.id, title: '서버', updatedAt: 1, deleted: true, ...marker };
    const state = { staff: [], checks: {}, tasks: [local] };
    assert.equal(syncApply(state)([{
      table: 'tasks', key: local.id, data: canonical, updated_at: 1, authoritative: true
    }]), 1);
    assert.deepEqual(state.tasks[0], canonical);
  }
});
