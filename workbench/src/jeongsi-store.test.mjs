import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const source=[html.match(/^function uniNorm.*$/m)[0],html.match(/^function aplSame.*$/m)[0],
  section("const ADIGA_FIELDS=","function renderAdiga(){"),
  section("// JEONGSI_CORE_START","// JEONGSI_CORE_END"),
  section("// JEONGSI_STORE_START","// JEONGSI_STORE_END"),
  section("function mergeSusiStudent(","function doImport(")].join("\n");
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(){let id=0;const c=vm.createContext({URL,uid:()=>`synthetic-${++id}`,today:()=>"2026-10-15"});vm.runInContext(source,c);return c;}
function exam(extra={}){return {label:"합성 수능",type:"수능",admissionYear:"2027",date:"2026-11-19",status:"확정",
  source:"합성 성적표",checked:"2026-12-10",scores:{kor:{subject:"화법과 작문",percentile:80},
    math:{subject:"미적분",percentile:90},inq1:{subject:"합성 탐구 A",percentile:70},inq2:{subject:"합성 탐구 B",percentile:90},
    eng:{subject:"영어",grade:2},hist:{subject:"한국사",grade:3}},...extra};}
function rule(extra={},regular={}){return {univ:"가상대학교",major:"합성학과",track:"수능 일반",admissionYear:"2027",
  source:"합성 모집요강",url:"https://example.org/synthetic",checked:"2026-10-15",content:"원장이 확인한 합성 반영식",
  unknown:{preserve:true},regular:{group:"가",mode:"weighted",metric:"percentile",weights:{kor:40,math:40,inq:20},
    inquiry:"mean2",englishMode:"table",historyMode:"table",englishTable:[0,-1,-2,-3,-4,-5,-6,-7,-8],
    historyTable:[0,0,-2,-3,-4,-5,-6,-7,-8],unsupported:"",...regular},...extra};}
function candidate(e,n=rule(),extra={}){return {univ:n.univ,major:n.major,track:n.track,group:n.regular.group,
  admissionYear:e.admissionYear,examId:e.id,ruleSnapshot:n,...extra};}
function fixture(){const c=setup(),s={id:"synthetic-student",consult:{susi:{admissionYear:"2027",gradeScale:"5"}}},e=c.jSaveExam(s,exam());return {c,s,e};}

test("state initialization preserves unrelated consultation fields and rejects destructive shape changes",()=>{
  const c=setup(),s={consult:{susi:{gradeScale:"5"},jeongsi:{custom:"keep",admissionYear:"2028"}}};
  const state=c.jState(s);assert.equal(state.custom,"keep");assert.equal(state.admissionYear,"2028");assert.equal(s.consult.susi.gradeScale,"5");
  assert.equal(c.jState(s),state);assert.deepEqual(plain(state.exams),[]);
  for(const bad of [{consult:"legacy"},{consult:{jeongsi:"legacy"}},{consult:{jeongsi:{history:"legacy"}}}]){
    const before=JSON.stringify(bad);assert.throws(()=>c.jState(bad));assert.equal(JSON.stringify(bad),before);
  }
});
test("exam edits preserve identity, select the exam, record snapshots and never change saved plans",()=>{
  const {c,s,e}=fixture(),state=c.jState(s),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan;
  const history=plain(state.history),snapshot=plain(p),input={...plain(e),scores:plain(e.scores)};
  input.scores.kor.percentile=95;const edited=c.jSaveExam(s,input);
  assert.equal(edited.id,e.id);assert.notEqual(edited.revision,e.revision);assert.equal(state.examId,e.id);assert.equal(state.admissionYear,"2027");
  assert.deepEqual(plain(p),snapshot);assert.deepEqual(plain(state.history.slice(0,2)),history);
  assert.equal(state.history.at(-1).kind,"시험 수정");assert.equal(state.history.at(-1).before.scores.kor.percentile,80);
  assert.equal(state.history.at(-1).after.scores.kor.percentile,95);input.scores.kor.percentile=1;
  assert.equal(edited.scores.kor.percentile,95);edited.scores.kor.percentile=92;assert.equal(state.history.at(-1).after.scores.kor.percentile,95);
});
test("invalid or foreign exam edits are rejected without changing existing records",()=>{
  const {c,s,e}=fixture(),before=JSON.stringify(s);
  assert.throws(()=>c.jSaveExam(s,exam({id:"another-student-exam"})),/시험 기록/);
  assert.throws(()=>c.jSaveExam(s,exam({id:e.id,date:"2026-02-30"})));
  assert.equal(JSON.stringify(s),before);
});
test("changing an exam admission year is allowed only before any plan is linked",()=>{
  const {c,s,e}=fixture(),state=c.jState(s),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan;
  for(const status of ["후보","지원안","제외"]){
    c.jSetPlan(s,p.id,{status,reason:"합성 판단"},n);
    const before=JSON.stringify(s),snapshot=plain(p.examSnapshot),history=plain(state.history);
    assert.throws(()=>c.jSaveExam(s,{...plain(e),admissionYear:"2028"}),/연결된 지원안이 있어 모집학년도 변경은 새 시험으로 등록하세요/);
    assert.equal(JSON.stringify(s),before);assert.deepEqual(plain(p.examSnapshot),snapshot);assert.deepEqual(plain(state.history),history);
  }
  const unlinked=c.jSaveExam(s,exam({label:"지원안 없는 시험"})),priorHistory=plain(state.history);
  const changed=c.jSaveExam(s,{...plain(unlinked),admissionYear:"2028"});
  assert.equal(changed.id,unlinked.id);assert.equal(changed.admissionYear,"2028");assert.equal(state.admissionYear,"2028");
  assert.deepEqual(plain(state.history.slice(0,-1)),priorHistory);assert.equal(state.history.at(-1).before.admissionYear,"2027");
  assert.equal(state.history.at(-1).after.admissionYear,"2028");assert.equal(p.examSnapshot.admissionYear,"2027");
});
test("candidate identity separates year, exam, track and group while repeats preserve judgment",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan;
  c.jSetPlan(s,p.id,{status:"지원안",reason:"원문 검토 완료"},n);
  const before=JSON.stringify(s),repeated=c.jSavePlan(s,candidate(e,n,{univ:"가상대",reason:"덮어쓰기 금지"}));
  assert.equal(repeated.plan,p);assert.equal(repeated.created,false);assert.equal(JSON.stringify(s),before);
  assert.equal(c.jSavePlan(s,candidate(e,rule({track:"수능 특별"}))).created,true);
  assert.equal(c.jSavePlan(s,candidate(e,rule({}, {group:"나"}))).created,true);
  const second=c.jSaveExam(s,exam({label:"합성 모평",type:"모평"}));assert.equal(c.jSavePlan(s,candidate(second,n)).created,true);
  const next=c.jSaveExam(s,exam({admissionYear:"2028"}));assert.equal(c.jSavePlan(s,candidate(next,rule({admissionYear:"2028"}))).created,true);
  assert.equal(c.jState(s).plans.length,5);
});
test("candidate evidence must match student exam, year, university, major, track and group",()=>{
  const {c,s,e}=fixture(),before=JSON.stringify(s);
  for(const change of [{examId:"other-student"},{admissionYear:"2028"},{univ:"다른대학교"},{major:"다른학과"},
    {track:"다른전형"},{group:"나"},{group:"미확인"},{ruleSnapshot:null}])assert.throws(()=>c.jSavePlan(s,candidate(e,rule(),change)));
  assert.equal(JSON.stringify(s),before);
});
test("stored snapshots deeply isolate scores, note fields, weights, tables and calculated results",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan,state=c.jState(s),entry=state.history.at(-1);
  assert.equal(p.resultSnapshot.score,81);n.unknown.preserve=false;n.regular.weights.kor=100;n.regular.englishTable[1]=999;e.scores.kor.percentile=1;
  assert.equal(p.ruleSnapshot.unknown.preserve,true);assert.equal(p.ruleSnapshot.regular.weights.kor,40);
  assert.equal(p.ruleSnapshot.regular.englishTable[1],-1);assert.equal(p.examSnapshot.scores.kor.percentile,80);
  p.ruleSnapshot.regular.historyTable[2]=999;p.resultSnapshot.parts.push("modified");
  assert.equal(entry.after.ruleSnapshot.regular.historyTable[2],-2);assert.ok(!entry.after.resultSnapshot.parts.includes("modified"));
});
test("pending scores and manual rules can be retained as candidates without deriving a score",()=>{
  const {c,s}=fixture(),e=c.jSaveExam(s,exam({scores:{kor:{subject:"합성 국어",grade:1}}})),n=rule({}, {mode:"manual"});
  const p=c.jSavePlan(s,candidate(e,n)).plan;
  assert.equal(p.status,"후보");assert.equal(p.resultSnapshot.score,null);assert.ok(p.resultSnapshot.missing.length>0);
  assert.ok(p.resultSnapshot.limitations.some(t=>t.includes("내신")));
});
test("stale exam or rule blocks support until explicit recalculation; old histories remain intact",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan,state=c.jState(s);
  assert.equal(c.jIsStale(p,e,n),false);const reordered=Object.fromEntries(Object.entries(n).reverse());assert.equal(c.jIsStale(p,e,reordered),false);
  c.jSetPlan(s,p.id,{status:"지원안",reason:"최초 검토"},n);
  const old=plain(p),oldHistory=plain(state.history),edited=c.jSaveExam(s,{...plain(e),label:"수정 합성 시험"});
  assert.equal(c.jIsStale(p,edited,n),true);assert.throws(()=>c.jSetPlan(s,p.id,{status:"지원안",reason:"새 판단"},n),/재계산/);
  assert.throws(()=>c.jRefreshPlan(s,p.id,n,""),/사유/);const newNote=rule({content:"새 반영 근거"});
  c.jRefreshPlan(s,p.id,newNote,"성적·원문 변경 확인");assert.equal(p.status,"후보");assert.equal(p.reason,"성적·원문 변경 확인");
  assert.equal(c.jIsStale(p,edited,newNote),false);assert.equal(c.jIsStale(p,edited,n),true);
  assert.deepEqual(plain(state.history.slice(0,oldHistory.length)),oldHistory);
  assert.deepEqual(plain(state.history.at(-1).before),old);assert.equal(state.history.at(-1).kind,"근거 재계산");
  c.jSetPlan(s,p.id,{status:"지원안",reason:"수정 후 재확인"},newNote);assert.equal(p.status,"지원안");
});
test("support selection replaces only the same year, exam and group and records both transitions",()=>{
  const {c,s,e}=fixture(),a=rule(),b=rule({univ:"두번째대학교"}),pa=c.jSavePlan(s,candidate(e,a)).plan,pb=c.jSavePlan(s,candidate(e,b)).plan;
  const otherGroup=rule({}, {group:"나"}),pg=c.jSavePlan(s,candidate(e,otherGroup)).plan;
  const e2=c.jSaveExam(s,exam({label:"별도 시험"})),pe=c.jSavePlan(s,candidate(e2,a)).plan;
  c.jSetPlan(s,pa.id,{status:"지원안",reason:"첫 판단"},a);c.jSetPlan(s,pg.id,{status:"지원안",reason:"나군 판단"},otherGroup);
  c.jSetPlan(s,pe.id,{status:"지원안",reason:"별도 시험 판단"},a);c.jSetPlan(s,pb.id,{status:"지원안",reason:"대안 선택"},b);
  assert.equal(pa.status,"후보");assert.equal(pa.reason,"첫 판단");assert.equal(pb.status,"지원안");assert.equal(pg.status,"지원안");assert.equal(pe.status,"지원안");
  const history=c.jState(s).history;assert.equal(history.at(-2).kind,"후보 전환");assert.equal(history.at(-2).before.status,"지원안");assert.equal(history.at(-1).kind,"지원안 지정");
});
test("status changes require reasons and fresh evidence, exclusion is reversible, students stay separate",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan,state=c.jState(s),before=JSON.stringify(s);
  for(const change of [{status:"지원안",reason:""},{status:"제외",reason:""},{status:"invalid",reason:"x"}])assert.throws(()=>c.jSetPlan(s,p.id,change,n));
  assert.throws(()=>c.jSetPlan(s,p.id,{status:"지원안",reason:"메모"}),/재계산/);assert.equal(JSON.stringify(s),before);
  c.jSetPlan(s,p.id,{status:"제외",reason:"원문 조건 불일치"});c.jSetPlan(s,p.id,{status:"후보",reason:"추가 검토"});
  assert.equal(p.status,"후보");assert.equal(state.history.at(-2).kind,"제외");assert.equal(state.history.at(-1).kind,"후보 전환");
  const other={id:"second-synthetic"};assert.throws(()=>c.jSavePlan(other,candidate(e,n)),/학생의 시험/);
  assert.throws(()=>c.jSetPlan(other,p.id,{status:"후보"}),/지원 후보/);assert.equal(c.jState(other).plans.length,0);
});
test("backup merging preserves current settings and same-ID rows, imports new rows and has no shared aliases",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan;
  const incoming=plain(s);incoming.consult.susi.gradeScale="9";incoming.consult.jeongsi.admissionYear="2028";
  incoming.consult.jeongsi.exams[0].label="must not replace";incoming.consult.jeongsi.plans[0].reason="must not replace";
  incoming.consult.jeongsi.exams.push({...plain(e),id:"imported-exam"});
  incoming.consult.jeongsi.plans.push({...plain(p),id:"imported-plan",examId:"imported-exam"});
  incoming.consult.jeongsi.history.push({kind:"legacy history",before:null,after:null});
  s.apply=[{id:"susi-one",univ:"합성대",major:"학과",track:"교과",admissionYear:"2027",memo:"preserve"}];incoming.apply=plain(s.apply);incoming.apply[0].memo="replace";
  const before=JSON.stringify(s),merged=c.mergeSusiStudent(s,incoming),state=merged.consult.jeongsi;
  assert.equal(state.admissionYear,"2027");assert.equal(state.exams.length,2);assert.equal(state.plans.length,2);
  assert.equal(state.exams[0].label,e.label);assert.equal(state.plans[0].reason,"");assert.equal(merged.consult.susi.gradeScale,"5");assert.equal(merged.apply[0].memo,"preserve");
  assert.ok(state.history.at(-1).id);assert.equal(JSON.stringify(s),before);incoming.consult.jeongsi.exams[1].label="after import";
  assert.notEqual(state.exams[1].label,"after import");assert.deepEqual(plain(JSON.parse(JSON.stringify(merged))),plain(merged));
});
test("imported duplicate support becomes a candidate with before-and-after history, preserving existing support",()=>{
  const {c,s,e}=fixture(),n=rule(),p=c.jSavePlan(s,candidate(e,n)).plan;c.jSetPlan(s,p.id,{status:"지원안",reason:"기존 판단"},n);
  const incoming={consult:{jeongsi:{plans:[{...plain(p),id:"imported-other-plan",univ:"다른대학교",reason:"가져온 판단"}],history:[],exams:[]}}};
  const merged=c.mergeSusiStudent(s,incoming).consult.jeongsi;
  assert.equal(merged.plans[0].status,"지원안");assert.equal(merged.plans[1].status,"후보");assert.equal(merged.plans[1].reason,"가져온 판단");
  assert.equal(merged.history.at(-1).before.status,"지원안");assert.equal(merged.history.at(-1).after.status,"후보");
  assert.equal(incoming.consult.jeongsi.plans[0].status,"지원안");
});
