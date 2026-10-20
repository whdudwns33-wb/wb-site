'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8');
const source=html.slice(html.indexOf('let operationsSnapshot ='),html.indexOf('function render()'));
test('read snapshots never merge into editable task state; unverified readers cannot use them',()=>{
  const ctx={session:{isAdmin:false},sync:{personVerified:false,operationsRead:true},state:{tasks:[{id:'own'}]}};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  vm.runInContext("operationsSnapshot={tasks:[{id:'other'}]};",ctx);
  assert.equal(ctx.canReadOperations(),false);
  assert.equal(ctx.readLessonTasks()[0].id,'own');
  ctx.sync.personVerified=true;
  assert.equal(ctx.readLessonTasks()[0].id,'other');
  assert.equal(ctx.state.tasks[0].id,'own');
  ctx.sync.operationsRead=false;
  assert.equal(ctx.readLessonTasks()[0].id,'own');
  assert.doesNotMatch(source,/localStorage|state\.tasks\s*=/);
});
test('search results use current authorized roster, escape values and keep duplicate identities separate',()=>{
  const ctx={window:{WBRosterSearch:require('./roster-search-core')},rosterDb:{students:[
    {id:'one',name:'샘플<학생>',school:'가초',grade:'3'},
    {id:'two',name:'샘플<학생>',school:'나초',grade:'5'}]},
    esc:s=>String(s??'').replaceAll('<','&lt;'),studentSchoolGradeDetailLabel:s=>s.school+' '+s.grade,
    rosterStudentInfoStatus:()=>['재원 중']};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('let rosterSearchQuery ='),html.indexOf('function viewRoster()')),ctx);
  vm.runInContext("rosterSearchQuery='샘플';",ctx);
  const result=ctx.rosterSearchResultsHtml();
  assert.match(result,/검색 결과 2명/);assert.match(result,/data-id="one"/);assert.match(result,/data-id="two"/);
  assert.doesNotMatch(result,/<학생>/);
  ctx.rosterDb.students=ctx.rosterDb.students.slice(0,1);
  assert.match(ctx.rosterSearchResultsHtml(),/검색 결과 1명/);
});
test('readonly roster and attendance views have explicit server capability gates',()=>{
  assert.match(html,/if \(canReadOperations\(\)\) allowed.push\('schedule'\)/);
  assert.match(html,/전체 원생 · 조회 전용/);
  assert.match(html,/data-act="personaldevicerevoke"/);
  assert.match(html,/previousOperationsRead !== this.operationsRead/);
  assert.match(html,/operationsSnapshot = null; operationsLoadedAt = 0; rosterDb = null; rosterLoadGeneration\+\+/);
});
