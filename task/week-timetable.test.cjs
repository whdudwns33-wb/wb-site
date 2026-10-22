'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('./week-timetable.js');
const days = ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25'];
const entry = (id, start, date = days[0], staffId = 'staff-a') => ({key:id, staffId, date, studentName:id, slot:{startMinute:start,endMinute:start+50},task:{subject:'수학'}});
const entries = [entry('b', 900), entry('a', 900), entry('c', 870), entry('other',870,days[0],'staff-b'), entry('weekend',600,days[6]), entry('old',900,'2026-10-12')];
const rows = core.rows(entries.concat(entries[0]),days,'staff-a');
assert.deepEqual(rows.map(r=>r.start),[600,870,900]);
assert.deepEqual(rows[2].cells[0].map(e=>e.key),['a','b']);
assert.equal(rows[0].cells[6][0].key,'weekend');
assert.equal(core.rows(entries,days,'').length,0);
assert.equal(core.rows([entry('bad',-1)],days,'staff-a').length,0);
const special = entry('<script>',900); special.task={subject:'<img>',lessonInstanceType:'makeup',firstClassDate:days[0]};
const html = core.render([special],days,'staff-a',days[0]);
assert.ok(html.includes('is-first')); assert.ok(html.includes('첫수업 · 보강'));
assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
assert.ok(html.includes('15:00–15:50')); assert.ok(html.includes('is-today'));
assert.ok(core.render([],days,'staff-a','').includes('등록된 수업이 없습니다'));
const page=fs.readFileSync(__dirname+'/index.html','utf8');
assert.ok(page.includes('function viewWeekChecklist()'));
assert.ok(page.includes("let weekPlannerMode = 'timetable'"));
assert.ok(page.includes('session.isAdmin && weekPlannerAll'));
assert.ok(page.includes('WBWeekTimetable.render'));
assert.ok(page.includes("if (session.isAdmin) { weekPlannerAll"));
console.log('week timetable: ordering, duplicates, teacher isolation, colors, escaping and integration OK');
const vm = require('node:vm');
const context = {WBWeekTimetable:core, session:{isAdmin:false}, cursor:days[0],
  currentStaff:()=>({id:'staff-a',name:'가상교사'}), mondayOf:()=>days[0],
  addDays:(_,i)=>days[i], today:()=>days[0], esc:v=>core.render ? String(v) : '',
  staffSwitcher:()=>'<div>직원 선택</div>', todayStaffList:()=>[{id:'staff-a',name:'가상교사'},{id:'staff-b',name:'다른교사'}],
  ensureWeekendVisitScheduleDates:()=>{}, weeklyLessonSchedule:()=>({entries,issues:[]}),
  staffStudentCompactLabelById:(_,name)=>name};
vm.createContext(context);
vm.runInContext(page.slice(page.indexOf("let weekPlannerMode = 'timetable'"),page.indexOf('function viewWeekChecklist()')),context);
assert.ok(vm.runInContext('viewWeek()',context).includes('가상교사'));
assert.ok(!vm.runInContext('viewWeek()',context).includes('other'));
vm.runInContext('weekPlannerAll = true',context);
assert.ok(!vm.runInContext('viewWeek()',context).includes('다른교사'),'non-admin cannot enable all');
context.session.isAdmin=true;
assert.ok(vm.runInContext('viewWeek()',context).includes('다른교사'));
assert.ok(vm.runInContext('viewWeek()',context).includes('other'));
context.viewWeekChecklist=()=>'<p>기존 체크표</p>';
vm.runInContext("weekPlannerMode = 'checklist'",context);
assert.ok(vm.runInContext('viewWeek()',context).includes('기존 체크표'));
