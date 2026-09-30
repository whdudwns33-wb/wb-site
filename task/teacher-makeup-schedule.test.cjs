'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/index.html', 'utf8');
test('teacher processing separates future scheduling from past completion', async () => {
  const session = { isStaffLink: true, staffId: 'a' };
  const predicate = source.slice(source.indexOf('function makeupCanSchedule('), source.indexOf('function makeupCanComplete('));
  const can = new Function('session', predicate + ';return makeupCanSchedule;')(session);
  const row = { caseId: 'case', revision: 1, status: 'reviewed', currentTeacherId: 'a' };
  assert.equal(can(row), true);
  assert.equal(can({ ...row, currentTeacherId: 'b' }), false);
  assert.equal(can({ ...row, status: 'completed' }), false);
  const process = source.slice(source.indexOf('async function openMakeupProcessModal('), source.indexOf('async function openMakeupLinkModal('));
  let buttons;
  const open = new Function('makeupRows', 'makeupCanSchedule', 'esc', 'makeupScheduleHtml', 'modal', process + ';return openMakeupProcessModal;')(
    [row], can, String, () => '', (title, body, actions) => { buttons = actions; });
  await open({ dataset: { case: 'case' } });
  assert.match(buttons, /data-act="muschedule"/);
  assert.match(buttons, /data-act="mudirectcompleteopen"/);
  assert.match(source, /directCompletion \? ' max="'/);
  assert.match(source, /mode === 'schedule' \? !makeupCanSchedule\(row\)/);
});
