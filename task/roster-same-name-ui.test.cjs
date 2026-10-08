'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const helper = source.slice(source.indexOf('function confirmRosterSameName('), source.indexOf('async function saveRosterStudent('));
function setup() {
  const buttons = {};
  const same = { dataset: { sameStudent: '0' } };
  const dialog = {
    style: {}, setAttribute() {}, addEventListener(event, fn) { this[event] = fn; },
    querySelector(key) { return buttons[key] ||= { focus() {} }; }, querySelectorAll() { return [same]; },
    showModal() { this.opened = true; }, close() { this.closed = true; }, remove() { this.removed = true; }
  };
  const context = vm.createContext({ document: { createElement: () => dialog, body: { appendChild() {} } },
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
  vm.runInContext(helper, context);
  const result = context.confirmRosterSameName([{ id: 'student-a', name: '<script>', school: '학교', grade: '5', father: '끝 1234', mother: '미입력' }]);
  return { dialog, buttons, same, result };
}
test('same-name dialog preserves form on cancel and escapes labels', async () => {
  const s = setup();
  assert.equal(s.dialog.className, 'modal');
  assert.ok(!s.dialog.innerHTML.includes('<script>'));
  s.buttons['[data-cancel-duplicate]'].onclick();
  assert.equal((await s.result).cancel, true);
  assert.equal(s.dialog.removed, true);
});
test('different student requires explicit choice', async () => {
  const s = setup(); s.buttons['[data-different-student]'].onclick();
  assert.equal((await s.result).different, true);
});
test('same student resolves stable id instead of creating or merging', async () => {
  const s = setup(); s.same.onclick();
  assert.equal((await s.result).studentId, 'student-a');
});
test('escape cancels without registering', async () => {
  const s = setup(); let prevented = false;
  s.dialog.keydown({ key: 'Escape', stopPropagation() {}, preventDefault() { prevented = true; } });
  assert.equal((await s.result).cancel, true); assert.equal(prevented, true);
});
test('preflight precedes create and sends checked ids with roster revision', () => {
  const save = source.slice(source.indexOf('async function saveRosterStudent('), source.indexOf('let subscriptionSessionDraft'));
  assert.ok(save.indexOf("action: 'student_name_check'") < save.indexOf("'student_create'"));
  assert.match(save, /expectedUpdatedAt = Number\(check.updatedAt\)/);
  assert.match(save, /confirmedDuplicateStudentIds: confirmedDuplicateStudentIds/);
});
