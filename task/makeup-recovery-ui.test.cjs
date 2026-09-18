'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./makeup-recovery-core.js');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('async function mutateMakeup('), html.indexOf('async function createMakeupFromAbsence'));
function harness(options = {}) {
  const before = { caseId: 'case-a', revision: 1, status: 'reviewed', currentTeacherId: 'a' };
  const calls = [], button = { disabled: false, isConnected: true, dataset: {} };
  const host = { _makeupSnapshot: before };
  const bindings = {
    SYNC_APP: 'task',
    sync: { auth: () => ({ mode: 'fixture' }), post: async () => { calls.push('post'); return { case: before }; },
      run: async () => { if (options.refreshFails) throw new Error('offline'); } },
    makeupMutationGate: core.createFlightGate(), WBMakeupRecoveryCore: core,
    $: () => host, makeupRows: [before], loadLatestMakeupCase: options.load || (async () => options.latest || before),
    clearMakeupModalError: () => {}, replaceMakeup: () => {}, closeModal: () => calls.push('close'),
    renderAfterSync: () => {}, rememberMakeupFocus: () => {}, render: () => {}, route: 'makeup',
    toast: text => calls.push(text), showMakeupModalError: text => calls.push(text),
    showMakeupRecovery: () => { calls.push('recovery'); button.dataset.recoveryHold = 'yes'; },
    refreshMakeupsAfterConflict: async () => {}, sessionPackError: '', makeupLiveMessage: ''
  };
  const mutate = Function(...Object.keys(bindings), source + '; return mutateMakeup;')(...Object.values(bindings));
  return { mutate, calls, button, before };
}
test('한 번의 대기 중 두 번 호출되어도 실제 변경 요청은 한 번만 전송한다', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ load: () => pending });
  const payload = { action: 'instruction_update', caseId: 'case-a', revision: 1 };
  const first = h.mutate(payload, h.button, '저장', '', true);
  const second = await h.mutate(payload, h.button, '저장', '', true);
  assert.equal(second, null);
  release(h.before); await first;
  assert.equal(h.calls.filter(x => x === 'post').length, 1);
});
test('열린 팝업이 오래되었으면 저장하지 않고 입력을 유지하는 확인 단계로 보낸다', async () => {
  const h = harness({ latest: { caseId: 'case-a', revision: 2, status: 'confirmed' } });
  await h.mutate({ action: 'schedule', caseId: 'case-a', revision: 1 }, h.button, '저장', '', true);
  assert.equal(h.calls.includes('post'), false);
  assert.equal(h.calls.includes('close'), false);
  assert.equal(h.calls.includes('recovery'), true);
  assert.equal(h.button.disabled, true);
});
test('저장 성공 뒤 화면 동기화만 실패한 경우 저장 실패라고 안내하지 않는다', async () => {
  const h = harness({ refreshFails: true });
  const result = await h.mutate({ action: 'schedule', caseId: 'case-a', revision: 1 }, h.button, '저장', '', true);
  assert.ok(result);
  assert.ok(h.calls.some(x => /저장은 완료되었습니다/.test(x)));
  assert.equal(h.calls.some(x => /보강 처리 실패/.test(x)), false);
});
test('이미 완료된 동일 요청은 서버에 다시 전송하지 않는다', async () => {
  const h = harness({ latest: { caseId: 'case-a', revision: 2, status: 'completed', completedDate: '2026-09-18',
    completedStartTime: '10:00', completedEndTime: '10:50' } });
  const result = await h.mutate({ action: 'complete', caseId: 'case-a', revision: 1,
    date: '2026-09-18', startTime: '10:00', endTime: '10:50' }, h.button, '완료', '', true);
  assert.equal(result.idempotent, true);
  assert.equal(h.calls.includes('post'), false);
});
test('최신 상태 확인 버튼은 자동 저장하지 않고 기존 입력칸을 유지한다', () => {
  const accept = html.slice(html.indexOf('function acceptMakeupRecovery'), html.indexOf('async function refreshMakeupsAfterConflict'));
  assert.doesNotMatch(accept, /sync.post|mutateMakeup|innerHTML/);
  assert.match(accept, /button.dataset.rev = fresh.revision/);
  assert.match(accept, /input.value === String\(before\[field\]/);
  assert.match(html, /await prepareFreshMakeupOpen\(el\)/);
});

test('변경 확인 뒤 이전 기본값만 갱신하고 직접 바꾼 입력은 보존한다', () => {
  const before = { revision: 1, confirmedDate: '2026-09-20', confirmedStartTime: '10:00', confirmedEndTime: '10:50',
    confirmedStaffId: 'a', instructions: { version: 1, text: '기존 안내' } };
  const fresh = { ...before, revision: 2, confirmedDate: '2026-09-21', confirmedStartTime: '11:00',
    confirmedEndTime: '11:50', instructions: { version: 2, text: '다른 기기의 안내' } };
  const button = { isConnected: true, disabled: true, dataset: { rev: '1', recoveryHold: 'yes' } };
  const host = { _makeupRecovery: { before, fresh, button, canRebase: true, payload: { action: 'reschedule' } } };
  const elements = { '#modalHost': host, '#muDate': { value: '2026-09-20' },
    '#muStart': { value: '10:00' }, '#muEnd': { value: '12:30' },
    '#muInstruction': { value: '작성 중인 새 안내' }, '#muInstructionVersion': { value: '1' },
    '#muRecovery': { remove() {} } };
  const source = html.slice(html.indexOf('function acceptMakeupRecovery'), html.indexOf('async function refreshMakeupsAfterConflict'));
  Function('$', 'showMakeupModalError', source + ';acceptMakeupRecovery();')(id => elements[id], () => {});
  assert.equal(button.dataset.rev, 2);
  assert.equal(button.disabled, false);
  assert.equal(elements['#muDate'].value, '2026-09-21');
  assert.equal(elements['#muStart'].value, '11:00');
  assert.equal(elements['#muEnd'].value, '12:30');
  assert.equal(elements['#muInstruction'].value, '작성 중인 새 안내');
  assert.equal(elements['#muInstructionVersion'].value, 2);
});
