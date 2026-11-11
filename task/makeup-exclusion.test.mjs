import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {excludedFromMakeupNeeds} from '../sync/makeup.js';
const html=fs.readFileSync(new URL('./index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('function '+name+'\\([^)]*\\) \\{[\\s\\S]*?\\n}'))[0];
test('client and server agree on clinic and scoped session exclusions independent of cycle date',()=>{
 for(const student of [{billingMode:'monthly'},{billingMode:'session4',sessionCycleStartDate:'2027-01-01'},{billingMode:'session4',sessionBillingSubject:'수학'}]){
  for(const subject of ['수학','영어','클리닉'])for(const lessonRole of ['', '클리닉']){
    const task={studentId:'student',subject,lessonRole};const c=vm.createContext({rosterStudentByStableId:()=>student});
    vm.runInContext(fn('taskExcludedFromMakeupNeeds'),c);assert.equal(c.taskExcludedFromMakeupNeeds(task),excludedFromMakeupNeeds(student,task));
  }
 }
 assert.equal(excludedFromMakeupNeeds({billingMode:'session4',sessionBillingSubject:'수학'},{subject:'영어'}),false);
});
test('missing absence recovery omits session and clinic but keeps monthly normal lessons',()=>{
 const tasks=[{id:'s',studentId:'s',subject:'수학'},{id:'c',studentId:'c',subject:'클리닉'},{id:'m',studentId:'m',subject:'영어'}];
 const c=vm.createContext({makeupLoaded:true,makeupRows:[],state:{tasks,checks:Object.fromEntries(tasks.map(t=>[t.id+'|2026-11-01',{date:'2026-11-01',att:'A'}]))},
  today:()=> '2026-11-11',isRegularLessonTask:()=>true,isTestTeacherTask:()=>false,
  rosterStudentByStableId:id=>({billingMode:id==='s'?'session4':'monthly'})});
 vm.runInContext(fn('taskExcludedFromMakeupNeeds')+'\n'+fn('makeupMissingAbsenceRows'),c);
 assert.equal(c.makeupMissingAbsenceRows().length,1);assert.equal(c.makeupMissingAbsenceRows()[0].task.id,'m');
});
