'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
function source(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return html.slice(from, to);
}
function fixture() {
  let writes = 0, buttons = {};
  const root = {dataset: {}, get innerHTML() { return this.markup || ''; }, set innerHTML(value) {
    writes++;
    this.markup = value;
    buttons = Object.fromEntries([...value.matchAll(/data-go="([^"]+)"/g)].map(m => [m[1], {}]));
  }};
  const context = vm.createContext({
    route: 'schedule', session: {isAdmin: true, isStaffLink: false}, badge: 0,
    $: selector => { assert.equal(selector, '#tabs'); return root; },
    alertsToday: () => ({total: 0}), shouldGatePersonAccess: () => false,
    shouldGateStaffWork: () => false, isDriverFacilityStaff: () => false,
    makeupAttentionCount: () => 0, sessionPackAttentionCount: () => 0,
    onboardingAttentionCount: () => 0, deviceAlertCount: () => 0,
    capturePersistentDetails: () => {}, restorePersistentDetails: () => {}
  });
  vm.runInContext(source('function replaceView(root, html)', '/* ══════════════════════════════════════════════════════\n   7. 뷰'), context);
  vm.runInContext(source('function renderTabs()', '/* ── 링크로 들어온 지시서 확인'), context);
  vm.runInContext('function managerRequestInboxCount() { return badge; }', context);
  return {context, root, render: () => vm.runInContext('renderTabs()', context),
    writes: () => writes, button: key => buttons[key]};
}
test('background renders retain the settings button and its focus/click target', () => {
  const f = fixture(); f.render();
  const settings = f.button('settings');
  for (let n = 0; n < 5; n++) f.render();
  assert.equal(f.writes(), 1);
  assert.equal(f.button('settings'), settings);
});
test('route and badge changes still update navigation', () => {
  const f = fixture(); f.render();
  f.context.route = 'settings'; f.render();
  assert.match(f.root.innerHTML, /class="tab on" data-go="settings"/);
  f.context.badge = 2; f.render();
  assert.match(f.root.innerHTML, /현황판<span class="badge">2<\/span>/);
  assert.equal(f.writes(), 3);
});
test('locking removes privileged tabs and unlocking restores settings', () => {
  const f = fixture(); f.render();
  f.context.session.isAdmin = false; f.render();
  assert.equal(f.root.innerHTML, '');
  f.context.session.isAdmin = true; f.render();
  assert.ok(f.button('settings'));
});
