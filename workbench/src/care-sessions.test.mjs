import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./app.html',import.meta.url),'utf8');
const core=html.slice(html.indexOf('// CARE_CORE_START'),html.indexOf('// CARE_CORE_END'));
const ui=html.slice(html.indexOf('const csDrafts='),html.indexOf('/* ── 상담 관리 탭 ── */'));
const plain=x=>JSON.parse(JSON.stringify(x));
function setup(){
 let serial=0,fail=false;const elements=new Map(),c={URL,Intl,Date,console,Map,JSON,db:{students:[{id:'student-a',name:'합성 A',records:[{date:'2026-10-01',main:'기존 기록'}],planners:[{month:'2026-10',content:'기존 계획'}],consult:{reports:[{id:'keep'}],coursePlans:[{id:'keep-course'}]}},{id:'student-b',name:'합성 B'}]},
  uid:()=>`new-${++serial}`,jCopy:plain,jSerial:v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),
  adigaDate:v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,
  adigaUrl:v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\s\\]/.test(v)?u.href:'';}catch{return '';}},
  save:next=>{if(fail)throw Error('동시 수정 충돌');c.db=next;},
  $:k=>{if(!elements.has(k))elements.set(k,{innerHTML:'',checked:false,value:''});return elements.get(k);},esc:v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
  toast:message=>{c.message=message;},confirm:()=>true,render:()=>{},copy:t=>{c.copied=t;},saveFile:(name,text)=>{c.file={name,text};}};
 vm.createContext(c);vm.runInContext(core,c);c.csToday=()=> '2026-10-29';c.stu=()=>c.db.students[0];vm.runInContext(ui,c);
 return {c,get s(){return c.db.students[0];},set fail(v){fail=v;}};
}
const session=c=>({...c.csBlank(),title:'정기 합성 상담',status:'완료',summary:'확인된 요약',followUp:'학생: 다음 주 계획 확인'});
const policy=c=>({...c.csPolicyBlank(),monthlyRegular:'1',weeklyMeet:'2',weeklyPlanner:'2',monthlyDesign:'1'});

test('care board filters and prioritizes without changing records; missing targets differ from zero',()=>{
 const x=setup();x.c.csSavePolicy(x.s,{...policy(x.c),weeklyMeet:'0'});
 x.c.csSaveSession(x.s,{...session(x.c),status:'예정',date:'2026-10-28'});
 x.c.csSaveSession(x.s,{...session(x.c),status:'예정',date:'2026-11-01',time:'10:00'});
 x.c.db.students.push({id:'withdrawn',name:'퇴원 합성',enrollmentStatus:'withdrawn'},{id:'broken',name:'형식 합성',consult:{care:{sessions:null}}});
 const before=JSON.stringify(x.c.db),rows=x.c.csBoardRows('2026-10-29');
 assert.equal(rows.length,3);assert.equal(rows[0].attention,true);assert.equal(rows.find(r=>r.s.id==='student-a').next.date,'2026-11-01');
 assert.equal(x.c.csBoardRows('2026-10-29','','attention').length,2);
 assert.equal(x.c.csBoardRows('2026-10-29','','unconfigured').length,1);
 assert.equal(x.c.csBoardRows('2026-10-29',' 합성 a ')[0].s.id,'student-a');assert.equal(x.c.csBoardRows('2026-10-29','일치없음').length,0);
 assert.match(x.c.csMetric(rows.find(r=>r.s.id==='student-a').p,'weeklyMeet'),/목표 0회/);
 x.c.renderCare();const rendered=x.c.$('#main').innerHTML;assert.match(rendered,/기록 확인 필요/);assert.match(rendered,/관리 목표 설정/);assert.match(rendered,/data-label="월 정규 상담"/);assert.match(rendered,/colspan="5"/);
 assert.equal(JSON.stringify(x.c.db),before);
});

test('comparison columns distinguish unknown, zero, remaining and exceeded targets without changing counts',()=>{
 const {c}=setup(),p={counts:{monthlyRegular:3,weeklyMeet:0,weeklyPlanner:1,monthlyDesign:0},policy:null};
 assert.match(c.csBoardMetric(p,'monthlyRegular'),/data-state="unknown"/);assert.match(c.csBoardMetric(p,'monthlyRegular'),/완료 3회, 목표 미설정/);
 p.policy={monthlyRegular:'2',weeklyMeet:'0',weeklyPlanner:'2',monthlyDesign:'1'};const before=JSON.stringify(p);
 assert.match(c.csBoardMetric(p,'monthlyRegular'),/목표 달성/);assert.match(c.csBoardMetric(p,'monthlyRegular'),/<strong>3<\/strong>/);
 assert.match(c.csBoardMetric(p,'weeklyMeet'),/data-state="off"/);assert.doesNotMatch(c.csBoardMetric(p,'weeklyMeet'),/목표 달성/);
 assert.match(c.csBoardMetric(p,'weeklyPlanner'),/남은 1회/);assert.match(c.csBoardMetric(p,'monthlyDesign'),/data-state="pending"/);
 assert.equal(JSON.stringify(p),before);assert.equal((c.csBoardHtml().match(/scope="col"/g)||[]).length,6);
});

test('existing records and every saved version remain independent; editing does not double-count',()=>{
 const x=setup(),before=plain(x.s),draft=session(x.c),first=x.c.csSaveSession(x.s,draft);draft.summary='초안 수정';
 assert.equal(first.summary,'확인된 요약');assert.deepEqual(x.s.records,before.records);assert.deepEqual(x.s.planners,before.planners);assert.deepEqual(x.s.consult.reports,before.consult.reports);assert.deepEqual(x.s.consult.coursePlans,before.consult.coursePlans);
 x.c.csSaveSession(x.s,{...first,previousId:first.id,summary:'수정된 요약'});
 assert.equal(x.s.consult.care.sessions.length,2);assert.equal(x.s.consult.care.sessions[0].summary,'확인된 요약');assert.equal(x.c.csProgress(x.s,'2026-10-29').counts.monthlyRegular,1);
 assert.equal(x.c.db.students[1].consult,undefined);
});
test('stale versions and failed storage preserve all records',()=>{
 const x=setup(),first=x.c.csSaveSession(x.s,session(x.c));x.c.csSaveSession(x.s,{...first,previousId:first.id,summary:'2차'});const before=JSON.stringify(x.c.db);
 assert.throws(()=>x.c.csSaveSession(x.s,{...first,previousId:first.id}),/최신/);assert.equal(JSON.stringify(x.c.db),before);
 x.fail=true;assert.throws(()=>x.c.csSaveSession(x.s,session(x.c)),/충돌/);assert.throws(()=>x.c.csSavePolicy(x.s,policy(x.c)),/충돌/);assert.equal(JSON.stringify(x.c.db),before);
});
test('month and Monday-Sunday week boundaries remain separate across year/month',()=>{
 const {c}=setup();assert.deepEqual(plain(c.csPeriod('2027-01-01')),{month:'2027-01',start:'2026-12-28',end:'2027-01-03'});
 assert.deepEqual(plain(c.csPeriod('2026-11-01')),{month:'2026-11',start:'2026-10-26',end:'2026-11-01'});assert.throws(()=>c.csPeriod('2026-02-30'));
});
test('per-student target history applies from its effective date and zero is not unknown',()=>{
 const x=setup();assert.equal(x.c.csProgress(x.s,'2026-10-29').policy,null);
 x.c.csSavePolicy(x.s,{...policy(x.c),effectiveFrom:'2026-10-01',weeklyMeet:'0'});x.c.csSavePolicy(x.s,{...policy(x.c),effectiveFrom:'2026-11-01',weeklyMeet:'3'});
 assert.equal(x.c.csPolicy(x.s,'2026-10-29').weeklyMeet,'0');assert.equal(x.c.csPolicy(x.s,'2026-11-01').weeklyMeet,'3');assert.equal(x.s.consult.care.policies.length,2);
 assert.equal(x.c.csPolicy(x.c.db.students[1],'2026-10-29'),null);
 for(const value of ['','-1','1.5','15','NaN'])assert.throws(()=>x.c.csValidatePolicy({...policy(x.c),weeklyMeet:value}));
});
test('planned, missed and canceled sessions are not completed; planner checks count independently',()=>{
 const x=setup();for(const status of ['예정','불참','취소'])x.c.csSaveSession(x.s,{...session(x.c),status,date:'2026-10-27'});
 const r=x.c.csSaveSession(x.s,{...session(x.c),kind:'주간 미트 상담',mode:'Google Meet',plannerCheck:'확인',plannerDesign:'설계 완료',plannerRef:'10월 4주 계획 점검·수정'});
 const p=x.c.csProgress(x.s,'2026-10-29');assert.deepEqual(plain(p.counts),{monthlyRegular:0,weeklyMeet:1,weeklyPlanner:1,monthlyDesign:1});assert.equal(p.overdue,1);assert.equal(p.planned,1);
 x.c.csSaveSession(x.s,{...r,previousId:r.id,status:'취소'});assert.equal(x.c.csProgress(x.s,'2026-10-29').counts.weeklyMeet,0);
});
test('completion requires a real date, summary, planner evidence and reviewed PLAUD summary',()=>{
 const {c}=setup();for(const patch of [{date:'2026-02-30'},{date:'2026-11-01'},{time:'25:99'},{summary:''},{plannerCheck:'확인'},{plannerDesign:'설계 완료'},{source:'PLAUD'},{kind:'주간 미트 상담',mode:'대면'}])assert.throws(()=>c.csValidateSession({...session(c),...patch}));
 assert.doesNotThrow(()=>c.csValidateSession({...session(c),source:'PLAUD',summaryReviewed:true}));assert.doesNotThrow(()=>c.csValidateSession({...session(c),date:'2027-01-01',status:'예정',summary:''}));
});
test('unsafe Meet/provenance links and invalid file metadata fail before persistence',()=>{
 const {c}=setup();assert.ok(c.csMeet('https://meet.google.com/abc-defg-hij'));
 for(const link of ['javascript:alert(1)','https://meet.google.com.evil/abc-defg-hij','https://u:p@meet.google.com/abc-defg-hij','http://meet.google.com/abc-defg-hij','https://meet.google.com/abc-defg-hij?token=x'])assert.equal(c.csMeet(link),'');
 for(const patch of [{meetUrl:'javascript:alert(1)'},{sourceUrl:'https://u:p@example.com'},{transcript:'x'.repeat(150001)},{summary:'x'.repeat(30001)},{importedFiles:[null]},{importedFiles:[{kind:'audio',name:'x',size:1,importedAt:new Date().toISOString()}]}])assert.throws(()=>c.csValidateSession({...session(c),...patch}));
});
test('same PLAUD recording cannot attach to another student or another session',()=>{
 const x=setup(),p={...session(x.c),source:'PLAUD',sourceId:'source-one',summaryReviewed:true},r=x.c.csSaveSession(x.s,p),before=JSON.stringify(x.c.db);
 assert.throws(()=>x.c.csSaveSession(x.c.db.students[1],p),/이미 다른/);assert.throws(()=>x.c.csSaveSession(x.s,p),/이미 다른/);assert.equal(JSON.stringify(x.c.db),before);
 assert.doesNotThrow(()=>x.c.csSaveSession(x.s,{...r,previousId:r.id}));
});

test('malformed and duplicate history metadata cannot be restored or merged',()=>{
 const x=setup();x.c.csSaveSession(x.s,session(x.c));const state=plain(x.s.consult.care);
 for(const change of [s=>s.sessions.push({...s.sessions[0]}),s=>s.sessions[0].createdAt='bad-date',s=>s.sessions[0].id='',s=>s.sessions={},s=>s.policies={}]){const bad=plain(state);change(bad);assert.throws(()=>x.c.csValidateState({consult:{care:bad}}));assert.throws(()=>x.c.csMergeCare(undefined,bad));}
});
test('automation JSON requires explicit student identity, cannot overwrite a session and resets completion',()=>{
 const {c}=setup(),data={schema:'wb-care-session-v1',studentId:'student-a',session:{title:'가져온 자료',date:'2026-10-28',source:'PLAUD',summary:'요약',status:'완료',summaryReviewed:true}};
 const p=c.csImportBundle('student-a',JSON.stringify(data));assert.equal(p.status,'예정');assert.equal(p.summaryReviewed,false);assert.equal(p.sessionId,'');
 assert.throws(()=>c.csImportBundle('student-b',JSON.stringify(data)),/학생/);
 assert.throws(()=>c.csImportBundle('student-a',JSON.stringify({...data,session:{...data.session,sessionId:'existing'}})),/지원하지/);
 assert.throws(()=>c.csImportBundle('student-a','{"__proto__": {}}'));
});
test('backup merge keeps current session, both histories, and incoming order without duplicate reimports',()=>{
 const x=setup(),first=x.c.csSaveSession(x.s,session(x.c)),current=plain(x.s.consult.care),incoming=plain(current);
 incoming.sessions[0].summary='다른 기기 원문';incoming.sessions.push({...first,id:'new-other',sessionId:'other',summary:'새 회차'});
 const merged=x.c.csMergeCare(current,incoming);assert.equal(merged.sessions.length,3);assert.equal(x.c.csLatest({consult:{care:merged}}).find(r=>r.sessionId===first.sessionId).summary,'확인된 요약');
 assert.equal(x.c.csMergeCare(merged,incoming).sessions.length,3);assert.equal(current.sessions[0].summary,'확인된 요약');
 const empty={policies:[],sessions:[]},versions={policies:[],sessions:[first,{...first,id:'later',previousId:first.id,summary:'최신 버전'}]};assert.equal(x.c.csLatest({consult:{care:x.c.csMergeCare(empty,versions)}})[0].summary,'최신 버전');
});
test('text uploads are drafts, preserve the other body and reject stale reads or unsupported files',async()=>{
 const x=setup(),p=x.c.csDraft();p.summary='기존 요약';const before=JSON.stringify(x.c.db);
 await x.c.csReadFile({name:'PLAUD.txt',size:20,text:async()=> '전사 원문'},'transcript');assert.equal(x.c.csDraft().summary,'기존 요약');assert.equal(x.c.csDraft().transcript,'전사 원문');assert.equal(x.c.csDraft().source,'PLAUD');assert.equal(JSON.stringify(x.c.db),before);
 const draft=JSON.stringify(x.c.csDraft());await x.c.csReadFile({name:'bad.pdf',size:20},'transcript');assert.equal(JSON.stringify(x.c.csDraft()),draft);
 await x.c.csReadFile({name:'large.txt',size:1048577},'transcript');assert.equal(JSON.stringify(x.c.csDraft()),draft);
 await x.c.csReadFile({name:'late.txt',size:20,text:async()=>{x.c.stu=()=>x.c.db.students[1];return 'wrong';}},'transcript');x.c.stu=()=>x.c.db.students[0];assert.equal(JSON.stringify(x.c.csDraft()),draft);
});
test('rendered session text is escaped, tabs link to existing plans, and copy uses the displayed version',()=>{
 const x=setup(),p=x.c.csDraft();Object.assign(p,session(x.c),{title:'<img src=x onerror=alert(1)>',summary:'<script>bad</script>'});x.c.tabSessions();
 const rendered=x.c.$('#tabbody').innerHTML;assert.ok(rendered.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!rendered.includes('<img src=x'));assert.ok(rendered.includes("view.tab='plan'"));assert.ok(rendered.includes('cs_bundle'));
 x.c.csCopy();assert.ok(x.c.copied.includes(p.summary));x.c.csSet('source','PLAUD');assert.equal(x.c.csDraft().summaryReviewed,false);
 x.c.csTemplate();assert.equal(JSON.parse(x.c.file.text).studentId,'student-a');assert.equal(JSON.parse(x.c.file.text).schema,'wb-care-session-v1');
});
