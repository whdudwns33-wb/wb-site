'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
const source = html.slice(html.indexOf('const quickAttendance ='), html.indexOf('/* 오늘 수업 화면 */'));
function setup() {
  const tasks = [
    {id:'a',studentName:'가학생',subject:'수학',time:'16:00',staffId:'teacher'},
    {id:'b',studentName:'나학생',subject:'국어',time:'15:00',staffId:'teacher'},
    {id:'c',studentName:'가학생',subject:'수학',time:'17:00',staffId:'teacher',makeup:true},
    {id:'other',studentName:'다학생',staffId:'other',time:'15:00'}
  ];
  const checks = {b:{att:'A'}}, writes=[];
  const ctx = { Map, Set, console, tasks, checks, writes,
    teacherTaskCardsFor:(id)=>tasks.filter(t=>t.staffId===id), isLesson:()=>true,
    lessonRecordContext:(t,d)=>({recordDate:t.id==='a'?'2026-10-18':d,inputEnabled:true}),
    getCheck:id=>checks[id], sessionPackAttendanceState:t=>({locked:t.id==='c'}),
    makeupAttendanceReconcileStates:new Map(),makeupCreateKey:(id,d)=>id+'|'+d,
    lessonHandoffSlots:()=>[], ATT_LABEL:{P:['출석','ok'],A:['결석','blk'],L:['지각','high'],E:['조퇴','doing']},
    esc:v=>String(v||'').replaceAll('<','&lt;'),taskRosterStudent:()=>null,studentOf:t=>t.studentName,
    isScheduledMakeupTask:t=>!!t.makeup,isFlexibleWeekendLesson:()=>false,isSubscriptionSessionTask:()=>false,
    currentStaff:()=>({id:'teacher'}),cursor:'2026-10-17',session:{isStaffLink:true},shouldGateStaffWork:()=>false,shouldGatePersonAccess:()=>false,
    confirm:()=>true,toast:()=>{},render:()=>{},setCheck:(id,date,patch)=>{writes.push({id,date,patch});checks[id]=patch;},settleSync:async()=>{},sync:{}
  };
  vm.createContext(ctx); vm.runInContext(source+'\nthis.qa=quickAttendance;',ctx); return ctx;
}
test('own lessons sorted; same student makeup separate; actual date and cutoff respected',()=>{
  const c=setup(),rows=c.quickAttendanceRows('teacher',c.cursor);
  assert.equal(rows.map(r=>r.task.id).join(','),'b,a,c');
  assert.equal(rows[1].recordDate,'2026-10-18');
  assert.match(rows[2].issue,/마감/);
  const rendered=c.quickAttendanceHtml('teacher',c.cursor);
  assert.match(rendered,/details open/); assert.match(rendered,/미입력 2/);assert.match(rendered,/실제 기록일/);
  assert.doesNotMatch(rendered,/다학생/);assert.match(rendered,/보강/);
});
test('bulk only writes unchecked attendance at actual date, never overwrites absence or locked class',async()=>{
  const c=setup();c.quickAttendanceHtml('teacher',c.cursor);
  ['a','b','c','other'].forEach(id=>c.qa.selected.add(id));
  await c.saveQuickAttendanceBatch();
  assert.equal(c.writes.length,1);assert.equal(c.writes[0].id,'a');assert.equal(c.writes[0].date,'2026-10-18');
  assert.equal(c.checks.b.att,'A');assert.equal(c.qa.busy,false);
});
test('compact rows group time once and put attendance next to name',()=>{
  const c=setup(); c.tasks[0].time='15:00';
  const rendered=c.quickAttendanceHtml('teacher',c.cursor);
  assert.match(rendered,/class="quick-att-grid"/);
  assert.equal((rendered.match(/class="quick-att-time"/g)||[]).length,2);
  assert.match(rendered,/class="quick-att-name"><b>나학생<\/b><span class="tag blk">결석<\/span><\/div>/);
  assert.match(rendered,/class="quick-att-name"><b>가학생<\/b><span class="tag blk">미입력<\/span><\/div>/);
  assert.doesNotMatch(rendered,/ · 정규/);
  assert.match(html,/\.quick-att-grid \{[^}]*repeat\(auto-fit,minmax\(min\(100%,max\(330px/);
  assert.match(html,/\.quick-att-error:empty \{ display: none; \}/);
  assert.match(html,/min-height: 42px/);
});
test('bulk cancellation, gate, failure and repeat preserve safety',async()=>{
  const c=setup();c.qa.selected.add('a');c.confirm=()=>false;
  await c.saveQuickAttendanceBatch();assert.equal(c.writes.length,0);
  c.confirm=()=>true;c.shouldGatePersonAccess=()=>true;
  await c.saveQuickAttendanceBatch();assert.equal(c.writes.length,0);
  c.shouldGatePersonAccess=()=>false;c.settleSync=async()=>{throw Error('offline');};
  await c.saveQuickAttendanceBatch();assert.match(c.qa.errors.get('a'),/서버 반영 확인 필요/);
  c.qa.selected.add('a');await c.saveQuickAttendanceBatch();assert.equal(c.writes.length,1);
});
test('center chat uses bounded fixed regions, date groups and new-message navigation',()=>{
  assert.match(html,/grid-template-rows: auto auto auto minmax\(0,1fr\) auto auto/);
  assert.match(html,/#centerChatMissing \{[^}]*max-height: 22vh; overflow-y: auto/);
  assert.match(html,/item.actorId.*auth.managerId/);
  assert.match(html,/class="center-chat-day"/);
  assert.match(html,/case 'centerchatlatest'/);
});
