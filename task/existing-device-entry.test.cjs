const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const block = name => html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n}'))[0];
function context(stored, kakao = false) {
  const stats = { syncs: 0, scrubs: 0, renders: 0 };
  const c = vm.createContext({
    pendingBootstrapCode: 'unconsumed-code', personAccessProblem: null,
    IS_KAKAO_IN_APP: kakao, navigator: {}, linkExchangeBusy: false,
    session: { isStaffLink: true }, sync: { personVerified: false },
    hasStoredPersonToken: () => stored, hasVerifiedPersonAuth: () => false,
    personProblemHtml: () => '', esc: s => s, toast: () => {},
    scrubBootstrapCodeFromAddress: () => stats.scrubs++, render: () => stats.renders++,
    startSyncSession: () => stats.syncs++
  });
  vm.runInContext(block('viewPersonAccess') + '\n' + block('useExistingPersonAuth'), c);
  return {c, stats};
}
test('stored device button is visible on first render before authentication or work login', () => {
  for (const kakao of [false, true]) {
    const {c, stats} = context(true, kakao);
    assert.match(c.viewPersonAccess(), /data-act="useexistingauth"/);
    assert.equal(stats.syncs, 0);
    assert.equal(c.pendingBootstrapCode, 'unconsumed-code');
  }
});
test('choosing saved device starts normal authentication without marking it verified', () => {
  const {c, stats} = context(true);
  c.useExistingPersonAuth();
  assert.equal(c.pendingBootstrapCode, '');
  assert.equal(stats.scrubs, 1);
  assert.equal(stats.syncs, 1);
  assert.equal(c.sync.personVerified, false);
});
test('missing token or concurrent new-device exchange cannot select a saved connection', () => {
  const absent = context(false);
  assert.doesNotMatch(absent.c.viewPersonAccess(), /data-act="useexistingauth"/);
  absent.c.useExistingPersonAuth();
  assert.equal(absent.stats.syncs, 0);
  assert.equal(absent.c.pendingBootstrapCode, 'unconsumed-code');
  const busy = context(true); busy.c.linkExchangeBusy = true;
  assert.match(busy.c.viewPersonAccess(), /data-act="useexistingauth" disabled/);
  busy.c.useExistingPersonAuth();
  assert.equal(busy.stats.syncs, 0);
  assert.equal(busy.c.pendingBootstrapCode, 'unconsumed-code');
});
