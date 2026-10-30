'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
function block(start, end) { return html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start))); }

test('manager roster shortcut opens the selected student and date under the original teacher', () => {
  const source = block('function selectAdminWeekendPlanDate(', 'function openWeekendPlan(');
  const selected = [];
  const task = { id: 'lesson', staffId: 'teacher', weekendAttendanceMode: 'flexible' };
  const session = { isAdmin: true };
  const select = new Function('session', 'state', 'document', 'today', 'flexibleWeekendAllowedOn', 'toast', 'openWeekendPlan',
    source + ';return selectAdminWeekendPlanDate;')(session, {tasks:[task]},
      {getElementById:()=>({value:'2026-11-01'})}, ()=>'2026-10-30', ()=>true,
      message=>selected.push(message), (...args)=>selected.push(args));
  select('lesson');
  assert.deepEqual(selected, [['teacher','lesson','2026-11-01']]);
  session.isAdmin=false;select('lesson');
  assert.equal(typeof selected[1], 'string');
});

test('admin roster has a direct reservation action while subscription creation remains available', () => {
  const roster = block('function rosterStudentLessonsHtml(', 'function rosterStudentSubscriptions(');
  assert.match(roster, /session\.isAdmin && task\.weekendAttendanceMode === 'flexible'/);
  assert.match(roster, /data-act="adminweekendplanopen"/);
  const subscriptions = block('function rosterSubscriptionActionsHtml(', 'function rosterStudentInfoHtml(');
  assert.match(subscriptions, /session\.isAdmin/);
  assert.match(subscriptions, /subscriptionlessonopen/);
  const picker = block('function openWeekendPlan(', 'async function saveWeekendPlan(');
  assert.match(picker, /selectedDate \|\| cursor/);
  assert.match(picker, /!taskId \|\| String\(task.id\) === String\(taskId\)/);
});
