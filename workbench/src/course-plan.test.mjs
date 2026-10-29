import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('./app.html',import.meta.url),'utf8');
const core=html.slice(html.indexOf('// COURSE_PLAN_CORE_START'),html.indexOf('// COURSE_PLAN_CORE_END'));
function setup(){let saved,fail=false,serial=0;const ctx=vm.createContext({URL,Date,JSON,today:()=> '2026-10-29',uid:()=> 'new-plan-'+(++serial),adigaUrl:v=>{try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}},adigaDate:v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,save:next=>{if(fail)throw Error('conflict');saved=next;ctx.db=next;}});vm.runInContext(core,ctx);ctx.db={meta:{keep:1},students:[{id:'synthetic-a',school:'합성 학교',career:'탐색',consult:{reports:[{id:'keep'}]},records:[{memo:'preserve'}]},{id:'synthetic-b',notes:'other student'}]};return{ctx,s:ctx.db.students[0],get saved(){return saved;},set fail(v){fail=v;}};}
function complete(ctx,s){const p=ctx.cpBlank(s);Object.assign(p,{curriculum:'2022',entryYear:'2025',admissionYear:'2028',major:'합성 대학 전공',schoolSource:'합성 편제표',schoolUrl:'https://school.example/plan',schoolChecked:'2026-10-29',univSource:'합성 대학 안내',univUrl:'https://uni.example/plan',univChecked:'2026-10-29',univYear:'2028'});p.rows=[{name:'기초 과목',type:'일반 선택',term:'고2-1',credits:'3',availability:'교내 확인',requirement:'권장',decision:'선택',reason:'진로 기초',prerequisite:''},{name:'심화 과목',type:'진로 선택',term:'고2-2',credits:'3',availability:'교내 확인',requirement:'권장',decision:'선택',reason:'탐구 심화',prerequisite:'기초 과목'}];p.rows=p.rows.map(r=>({...ctx.cpRow(p.curriculum),...r,learning:'합성 학습 내용',majors:'합성 전공 예시',infoSource:'합성 과목 안내',infoUrl:'https://school.example/course',infoChecked:'2026-10-29',condition:'합성 전공 권장 조건'}));return p;}
test('source scripts compile',()=>{for(const [,code] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(code);});
test('unverified plans are drafts and cannot be marked reviewed',()=>{const {ctx,s}=setup(),p=ctx.cpBlank(s);assert.ok(ctx.cpAudit(p).missing.length>=6);p.status='원장 검토 완료';assert.throws(()=>ctx.cpValidate(p),/미확인/);});
test('school availability, prior subjects, excluded requirements and duplicate semester choices surface',()=>{const {ctx,s}=setup(),p=complete(ctx,s);assert.equal(ctx.cpValidate(p).missing.length,0);assert.equal(ctx.cpAudit(p).totals['고2-1'],3);p.rows[1].term='고1-1';assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('선행')));p.rows[1].availability='미개설';assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('수강 가능')));p.rows[1].decision='제외';p.rows[1].requirement='필수';assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('필수')));p.rows.push({...p.rows[0]});assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('중복')));});
test('malformed input and unsafe provenance cannot be saved',()=>{const {ctx,s}=setup();for(const [k,v]of [['schoolUrl','javascript:alert(1)'],['univUrl','https://user:pass@example.com'],['schoolChecked','2027-01-01'],['univChecked','2026-02-30']]){const p=complete(ctx,s);p[k]=v;assert.throws(()=>ctx.cpValidate(p));}for(const v of ['-1','0','NaN','Infinity','3.5','31']){const p=complete(ctx,s);p.rows[0].credits=v;assert.throws(()=>ctx.cpValidate(p),/학점/);}const p=complete(ctx,s);p.rows=[null];assert.throws(()=>ctx.cpValidate(p),/형식/);});
test('new plan versions preserve old records and saved snapshots are independent of drafts',()=>{const x=setup(),p=complete(x.ctx,x.s),original=JSON.stringify(x.ctx.db);x.ctx.cpSavePlan(x.s,p);assert.equal(x.saved.students[0].consult.coursePlans.length,1);assert.equal(JSON.stringify(x.s),JSON.stringify(JSON.parse(original).students[0]));assert.deepEqual(x.saved.students[1],JSON.parse(original).students[1]);const text=x.saved.students[0].consult.coursePlans[0].reportText;p.rows[0].name='changed draft';assert.equal(x.saved.students[0].consult.coursePlans[0].reportText,text);x.ctx.cpSavePlan(x.ctx.db.students[0],p);assert.equal(x.saved.students[0].consult.coursePlans.length,2);assert.equal(x.saved.students[0].consult.coursePlans[0].reportText,text);});
test('failed saves leave all student records unchanged',()=>{const x=setup(),p=complete(x.ctx,x.s),before=JSON.stringify(x.ctx.db);x.fail=true;assert.throws(()=>x.ctx.cpSavePlan(x.s,p),/conflict/);assert.equal(JSON.stringify(x.ctx.db),before);});
test('report summaries distinguish unknown evidence and excluded rows',()=>{const {ctx,s}=setup(),p=complete(ctx,s);p.univYear='2029';p.rows[1].decision='제외';const a=ctx.cpAudit(p);assert.equal(a.totals['고2-2'],0);assert.ok(a.missing.some(x=>x.includes('대입 학년도')));assert.match(ctx.cpText(p),/학교 시간표/);assert.match(ctx.cpText(p),/제외/);});


test('catalog separates same-name curricula and career/general/convergence classifications',()=>{
 const {ctx}=setup();
 assert.equal(ctx.cpCourses('2015','전체','사회문제').length,1);
 assert.equal(ctx.cpCourses('2022','전체','사회문제').length,0);
 assert.equal(ctx.cpCourses('2022','전체','사회문제','전체')[0].type,'융합 선택');
 assert.equal(ctx.cpCourses('2015','사회','경제').length,0);
 assert.equal(ctx.cpCourses('2022','사회','경제').length,1);
 const a=ctx.cpNewCourse('2015','2015:기하'),b=ctx.cpNewCourse('2022','2022:기하');
 assert.notEqual(a.infoSource,b.infoSource);assert.equal(a.curriculum,'2015');assert.equal(b.curriculum,'2022');
 assert.equal(a.requirement,'미확인');assert.equal(a.availability,'미확인');
 assert.throws(()=>ctx.cpNewCourse('2022','2015:기하'),/교육과정/);
});

test('catalog searches refresh results while preserving the draft and all student records',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s),results={innerHTML:''};
 ctx.cpDraft=()=>p;ctx.$=selector=>selector==='#cp_catalog_results'?results:null;
 ctx.esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 vm.runInContext('const cpCatalogView={group:"전체",query:"",type:"진로 선택"};',ctx);
 vm.runInContext(html.slice(html.indexOf('function cpLink('),html.indexOf('function tabCourse(')),ctx);
 const before=JSON.stringify({p,db:ctx.db});
 ctx.cpSearch('경제');assert.match(results.innerHTML,/경제 수학/);assert.doesNotMatch(results.innerHTML,/인공지능 기초/);
 ctx.cpSearch('컴퓨터');assert.match(results.innerHTML,/인공지능 기초/);assert.match(results.innerHTML,/데이터 과학/);assert.doesNotMatch(results.innerHTML,/경제 수학/);
 ctx.cpSearch('없는검색어');assert.match(results.innerHTML,/검색 결과 0개/);
 ctx.cpSearch('');assert.match(results.innerHTML,/경제 수학/);assert.match(results.innerHTML,/인공지능 기초/);
 assert.equal(JSON.stringify({p,db:ctx.db}),before);
 p.curriculum='';ctx.cpSearch('기하');assert.match(results.innerHTML,/교육과정을 먼저 선택/);assert.doesNotMatch(results.innerHTML,/후보에 추가/);
 p.curriculum='2015';ctx.cpSearch('사회문제');assert.match(results.innerHTML,/사회문제 탐구/);
 p.curriculum='2022';ctx.cpSearch('사회문제');assert.doesNotMatch(results.innerHTML,/후보에 추가/);
 vm.runInContext('cpCatalogView.type="전체";',ctx);ctx.cpSearch();assert.match(results.innerHTML,/융합 선택/);
});

test('school list parser accepts pasted Excel/text and rejects invalid or duplicate rows atomically',()=>{
 const {ctx}=setup();
 assert.equal(ctx.cpParseSchool('과목명 | 학기 | 학점\n경제 수학 | 고2-1 | 3\n기하').length,2);
 assert.equal(ctx.cpParseSchool('경제 수학\t고2-1\t3')[0].credits,'3');
 for(const text of ['', '기하 | 고4-1 | 3','기하 | 고2-1 | -1','기하 | 고2-1 | 3 | extra','기하 | 고2-1 | 3\n기 하 | 고2-1 | 4','x'.repeat(60001)])assert.throws(()=>ctx.cpParseSchool(text));
});

test('school matching is exact within the same school/cohort/curriculum and never infers non-offering',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);p.rows=[ctx.cpNewCourse('2022','2022:경제 수학')];
 const original=JSON.stringify(p),q=ctx.cpImportSchool(p,'경제수학 | 고2-1 | 3\n기하');
 assert.equal(JSON.stringify(p),original);assert.equal(q.rows[0].availability,'미확인');
 assert.equal(ctx.cpSchoolMatch(q,q.rows[0]).state,'partial');
 assert.equal(ctx.cpSchoolMatch(q,{name:'물리학Ⅱ',curriculum:'2022'}).state,'absent');
 assert.match(ctx.cpSchoolMatch(q,{name:'없는 과목'}).text,/미개설 확정 아님/);
 for(const [k,v]of [['school','다른 학교'],['entryYear','2026'],['curriculum','2015'],['schoolSource','새 자료'],['schoolPaste','다른 과목 | 고2-1 | 3']])assert.equal(ctx.cpSchoolMatch({...q,[k]:v},q.rows[0]).state,'stale');
});

test('explicit school row application changes only draft scheduling and preserves unsupported alternatives',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);p.rows=[ctx.cpNewCourse('2022','2022:경제 수학'),ctx.cpNewCourse('2022','2022:생물의 유전')];
 const q=ctx.cpImportSchool(p,'경제 수학 | 고2-1 | 3'),before=JSON.stringify(q),applied=ctx.cpApplySchool(q,0,0);
 assert.equal(JSON.stringify(q),before);assert.equal(applied.rows[0].availability,'교내 확인');assert.equal(applied.rows[0].term,'고2-1');
 assert.equal(ctx.cpSchoolMatch(applied,applied.rows[0]).state,'match');assert.equal(applied.rows[1].decision,'검토');assert.equal(applied.rows.length,2);
 assert.throws(()=>ctx.cpApplySchool(q,1,0));assert.throws(()=>ctx.cpApplySchool({...q,entryYear:'2026'},0,0));
 const replaced=ctx.cpImportSchool(applied,'경제 수학 | 고2-2 | 4');
 assert.ok(ctx.cpAudit(replaced).missing.some(x=>x.includes('적용한 학교 목록')));
});

test('incomplete school rows remain unconfirmed and rejected imports preserve the draft',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);p.rows=[ctx.cpNewCourse('2022','2022:기하')];
 const q=ctx.cpImportSchool(p,'기하'),before=JSON.stringify(q);
 assert.throws(()=>ctx.cpApplySchool(q,0,0),/학기·학점/);
 assert.throws(()=>ctx.cpImportSchool(q,'기하 | 고2-1 | bad'));
 assert.equal(JSON.stringify(q),before);
});

test('curriculum changes require review and do not relabel old candidates',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);p.rows=[ctx.cpNewCourse('2015','2015:사회문제 탐구')];
 assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('교육과정 불일치')));
 p.rows[0].curriculum='2022';assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('공식 과목 분류')));
});

test('university conditions stay separate from related-major examples and partial evidence never mixes',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s),r=p.rows[0];
 assert.equal(ctx.cpUniversity(p,r).source,'합성 대학 안내');
 r.univTarget='별도 대학 학과';assert.equal(ctx.cpUniversity(p,r).source,'');
 assert.ok(ctx.cpAudit(p).missing.some(x=>x.includes('권장 조건·근거')));
 Object.assign(r,{univSource:'별도 대학 요강',univUrl:'https://another.example/guide',univChecked:'2026-10-29',univYear:'2028'});
 assert.equal(ctx.cpAudit(p).missing.length,0);p.status='원장 검토 완료';assert.doesNotThrow(()=>ctx.cpValidate(p));
 r.condition='';assert.throws(()=>ctx.cpValidate(p),/미확인/);
});

test('legacy saved plans and report text survive archive validation and editing uses a separate draft',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);delete p.schemaVersion;delete p.schoolPaste;
 p.rows=p.rows.map(({name,type,term,credits,availability,requirement,decision,reason,prerequisite})=>({name,type,term,credits,availability,requirement,decision,reason,prerequisite}));
 p.status='원장 검토 완료';p.reportText='이전 저장 보고서';const before=JSON.stringify(p);
 ctx.cpValidate(p,true);const q=ctx.cpEditable(p);assert.equal(JSON.stringify(p),before);assert.equal(q.schemaVersion,2);assert.equal(q.status,'검토중');
 q.rows[0].learning='새 상담 내용';assert.equal(p.rows[0].learning,undefined);assert.equal(p.reportText,'이전 저장 보고서');
});

test('school list and row provenance reject malformed imported structures and unsafe URLs',()=>{
 const {ctx,s}=setup(),p=ctx.cpImportSchool(complete(ctx,s),'기하 | 고2-1 | 3');
 for(const change of [q=>q.schoolOffer.rows=[null],q=>q.schoolOffer.url='javascript:alert(1)',q=>q.schoolOffer.checked='2026-02-30',q=>q.rows[0].infoUrl='https://user:pass@example.com',q=>q.rows[0].univChecked='2099-01-01',q=>q.rows[0].majors={},q=>q.schoolOffer.rows[0].term='고9-1']){
  const q=JSON.parse(JSON.stringify(p));change(q);assert.throws(()=>ctx.cpValidate(q,true));
 }
});

test('saved report freezes learning, conditions, school list and alternatives independently of later edits',()=>{
 const x=setup(),p=complete(x.ctx,x.s);p.rows[0].alternative='대체 후보 원문 확인';const q=x.ctx.cpImportSchool(p,'기초 과목 | 고2-1 | 3');
 const saved=x.ctx.cpSavePlan(x.s,q),before=JSON.stringify(saved);q.rows[0].learning='changed';q.schoolOffer.rows[0].name='changed';
 assert.equal(JSON.stringify(saved),before);for(const term of ['합성 학습 내용','합성 전공 예시','합성 전공 권장 조건','대체 후보 원문 확인'])assert.ok(saved.reportText.includes(term));
});

test('course names normalize consistently for duplicate credits and prerequisites',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);p.rows[1].prerequisite='기초과목';
 assert.equal(ctx.cpAudit(p).missing.length,0);
 p.rows.push({...p.rows[0],name:'기초과목'});const audit=ctx.cpAudit(p);
 assert.ok(audit.missing.some(x=>x.includes('중복')));assert.equal(audit.totals['고2-1'],3);
 p.status='원장 검토 완료';assert.throws(()=>ctx.cpValidate(p),/미확인/);
 p.rows.shift();p.status='검토중';p.rows.pop();p.completed='기초 과목';assert.ok(!ctx.cpAudit(p).missing.some(x=>x.includes('선행')));
});

test('changing target clears shared university confirmation without altering row-specific evidence or saved plans',()=>{
 const {ctx,s}=setup(),p=complete(ctx,s);Object.assign(p.rows[1],{univTarget:'별도 대학 전공',univSource:'별도 원문',univUrl:'https://another.example',univYear:'2028',univChecked:'2026-10-29'});
 const saved=ctx.cpSavePlan(s,p),before=JSON.stringify(saved),ownBefore=JSON.stringify(p.rows[1]);
 ctx.cpDraft=()=>p;vm.runInContext(html.match(/^function cpField\([^\n]+/m)[0],ctx);
 ctx.cpField('major',p.major);assert.equal(p.univSource,'합성 대학 안내');
 ctx.cpField('major','다른 대학 전공');assert.equal(p.univSource,'');assert.equal(p.rows[0].condition,'');assert.equal(p.rows[0].requirement,'미확인');
 assert.equal(JSON.stringify(p.rows[1]),ownBefore);assert.equal(JSON.stringify(saved),before);
 p.status='원장 검토 완료';assert.throws(()=>ctx.cpValidate(p),/미확인/);
});

test('copying a report enforces reviewed-state validation and reports failure without writing clipboard',()=>{
 const {ctx,s}=setup(),p=ctx.cpBlank(s);let copied='',message='';
 ctx.cpDraft=()=>p;ctx.copy=t=>{copied=t;};ctx.toast=t=>{message=t;};
 vm.runInContext(html.match(/^function cpCopy\([^\n]+/m)[0],ctx);
 p.status='원장 검토 완료';assert.throws(()=>ctx.cpText(p),/미확인/);ctx.cpCopy();assert.equal(copied,'');assert.match(message,/미확인/);
 p.status='검토중';ctx.cpCopy();assert.match(copied,/검토중/);assert.ok(html.includes('onclick="cpCopy()"'));
});
