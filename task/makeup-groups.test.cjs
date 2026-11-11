'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const core=require('./makeup-groups.js');
const options={mode:'teacher',teacherLabel:id=>id,studentLabel:r=>r.studentName,needsSchedule:r=>r.status!=='confirmed'||r.absent};
const rows=[
 {caseId:'a',studentId:'s1',studentName:'가 나',sourceTeacherId:'original',confirmedStaffId:'sub',status:'confirmed',confirmedDate:'2026-11-20',confirmedStartTime:'12:00'},
 {caseId:'b',studentId:'s1',studentName:'가 나',sourceTeacherId:'sub',status:'review_pending',sourceDate:'2026-11-21'},
 {caseId:'c',studentId:'s2',studentName:'가 나',sourceTeacherId:'other',status:'confirmed',confirmedDate:'2026-11-18'},
 {caseId:'d',studentId:'s3',studentName:'다라',sourceTeacherId:'sub',status:'confirmed',confirmedStaffId:'sub',confirmedDate:'2026-11-19',confirmedStartTime:'13:00'}];
test('assigned teacher grouping, needed first and date order without mutating records',()=>{
 const before=JSON.stringify(rows),g=core.group(rows,options),sub=g.find(x=>x.id==='sub');
 assert.deepEqual(sub.rows.map(r=>r.caseId),['b','d','a']);assert.equal(sub.needed,1);assert.equal(sub.scheduled,2);
 assert.equal(g.some(x=>x.id==='original'),false);assert.equal(JSON.stringify(rows),before);
});
test('student grouping keeps homonyms distinct and joins multiple teachers by ID',()=>{
 const g=core.group(rows,{...options,mode:'student'});assert.equal(g.length,3);assert.deepEqual(g.find(x=>x.id==='s1').rows.map(r=>r.caseId),['b','a']);
});
test('name search ignores spaces and leaves unmatched search empty',()=>{
 const g=core.group(rows,{...options,query:'가나'});assert.equal(g.flatMap(x=>x.rows).length,3);assert.equal(core.group(rows,{...options,query:'없음'}).length,0);
});
test('absent scheduled makeup counts as needed; archive sorted newest first',()=>{
 const g=core.group([{...rows[0],absent:true}],options)[0];assert.equal(g.needed,1);assert.equal(g.scheduled,0);
 const a=core.group([{...rows[0],status:'completed',updatedAt:1},{...rows[1],status:'cancelled',updatedAt:2}],{...options,archived:true})[0];assert.deepEqual(a.rows.map(r=>r.caseId),['b','a']);
});
test('admin controls retain input focus and native collapsed groups',()=>{
 const html=fs.readFileSync(__dirname+'/index.html','utf8');assert.match(html,/makeupGroupMode = el.dataset.mode/);
 assert.match(html,/if \(session.isAdmin\) \{[\s\S]*?aria-label="보강 보기 및 검색"/);
 assert.match(html,/results.innerHTML = makeupAdminResultsHtml\(\)/);
 assert.match(html,/data-makeup-group=/);assert.match(html,/makeupGroupOpen.has\(key\)/);
});

test('date filter shows scheduled day only; unscheduled needs remain in all dates',()=>{
 const g=core.group(rows,{...options,date:'2026-11-20'});assert.deepEqual(g.flatMap(x=>x.rows).map(r=>r.caseId),['a']);
 assert.equal(core.group(rows,{...options,date:'2026-11-22'}).length,0);
 assert.deepEqual(core.group(rows,{...options,date:'2026-11-20',query:'다라'}),[]);
 const archived=[{...rows[0],status:'completed',completedDate:'2026-11-21'}];
 assert.equal(core.group(archived,{...options,archived:true,date:'2026-11-21'}).length,1);
});
