import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Public source and synthetic data only; exercise the real save/import/export functions.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing ${start}`);return html.slice(a,b);}
const source=[html.match(/^function uniNorm.*$/m)[0],
  section("const ADIGA_FIELDS=","function renderAdiga(){"),
  section("function susiKey(","function susiStudent("),
  section("const APL_KINDS=","/* ═══════════ 월간 캘린더"),
  section("// JEONGSI_CORE_START","// JEONGSI_CORE_END"),
  section("// JEONGSI_STORE_START","// JEONGSI_STORE_END"),
  section("// REPORT_CORE_START","// REPORT_CORE_END"),
  section("// REPORT_STORE_START","// REPORT_STORE_END"),
  section("function exportJson()","/* ═══════════ 렌더 루트")].join("\n");
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(){
  let id=0;const c={URL,uid:()=>`synthetic-${++id}`,today:()=>"2026-10-15",db:{students:[],adiga:[],meta:{}},view:{},saveCount:0,
    save:next=>{c.saveCount++;if(next)c.db=next;},render(){},renderSide(){},closeModal(){},toast:message=>{c.message=message;},
    $:()=>({files:[{}]}),saveFile:(name,data)=>{c.exported=data;},
    FileReader:class{readAsText(){this.result=c.imported;this.onload();}}};
  vm.createContext(c);vm.runInContext(source,c);return c;
}
function exam(){return {label:"합성 실제 시험",type:"수능",admissionYear:"2027",date:"2026-11-19",status:"확정",
  source:"합성 성적표",checked:"2026-12-10",scores:{kor:{subject:"합성 국어",percentile:80},math:{subject:"합성 수학",percentile:90},
    inq1:{subject:"합성 탐구 A",percentile:70},inq2:{subject:"합성 탐구 B",percentile:90},eng:{grade:2},hist:{grade:3}}};}
function rule(){return {univ:"가상대학교",major:"합성학과",track:"수능 일반",admissionYear:"2027",source:"합성 모집요강",
  checked:"2026-10-15",url:"https://example.org/synthetic",content:"합성 반영식",regular:{group:"가",mode:"weighted",metric:"percentile",
    weights:{kor:40,math:40,inq:20},inquiry:"mean2",englishMode:"none",historyMode:"none",englishTable:[],historyTable:[],unsupported:""}};}
function fixture(){
  const c=setup(),s={id:"synthetic-student",name:"합성 학생",grade:"고3",school:"합성고",consult:{susi:{admissionYear:"2027",gradeScale:"9",gradeAverage:"3",gradeLabel:"합성 내신"}},apply:[]};
  const n=rule(),e=c.jSaveExam(s,exam());c.db.students.push(s);c.db.adiga.push(n);
  const p=c.jSavePlan(s,{univ:n.univ,major:n.major,track:n.track,group:"가",admissionYear:"2027",examId:e.id,ruleSnapshot:n}).plan;
  const draft=()=>({title:" 합성 상담 보고서 ",conclusion:" 원장 판단 ",nextActions:" 후속 상담 ",data:c.rptCollect(s,{admissionYear:"2027",examId:e.id},c.db.adiga)});
  return {c,s,n,e,p,draft};
}

test("saving appends independent report versions without altering earlier reports or calling global save",()=>{
  const {c,s,draft}=fixture(),input=draft(),first=c.rptSave(s,input,c.db.adiga),firstBytes=JSON.stringify(first);
  assert.equal(first.title,"합성 상담 보고서");assert.equal(first.conclusion,"원장 판단");assert.equal(first.nextActions,"후속 상담");
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));assert.equal(c.saveCount,0);
  input.data.student.name="changed draft";input.conclusion="changed conclusion";assert.equal(JSON.stringify(first),firstBytes);
  const second=c.rptSave(s,draft(),c.db.adiga);assert.notEqual(second.id,first.id);assert.equal(s.consult.reports.length,2);
  assert.equal(s.consult.reports[0],first);assert.equal(JSON.stringify(first),firstBytes);assert.notEqual(second.data,first.data);
  s.name="changed source";s.consult.jeongsi.exams[0].scores.kor.percentile=1;assert.equal(JSON.stringify(first),firstBytes);
});
test("owner, year, required title, notes and plain-text fields validate before any mutation",()=>{
  const {c,s,draft}=fixture(),before=JSON.stringify(s);
  const foreign=draft();foreign.data.student.id="other-student";
  const badYear=draft();badYear.data.admissionYear="27";
  const foreignExam=draft();foreignExam.data.exam.id="other-student-exam";
  for(const input of [{...draft(),title:" "},{...draft(),conclusion:{}},{...draft(),nextActions:[]},foreign,badYear,foreignExam])assert.throws(()=>c.rptSave(s,input,c.db.adiga));
  assert.throws(()=>c.rptSave(s,draft()));assert.equal(JSON.stringify(s),before);assert.equal(c.saveCount,0);
  const valid=draft();delete valid.conclusion;delete valid.nextActions;const saved=c.rptSave(s,valid,c.db.adiga);
  assert.equal(saved.conclusion,"");assert.equal(saved.nextActions,"");
});
test("a changed student, exam, plan judgment, or university note invalidates a preview",()=>{
  for(const change of [f=>{f.s.school="새 합성학교";},f=>{f.c.jSaveExam(f.s,{...plain(f.e),label:"변경 시험"});},
    f=>{f.c.jSetPlan(f.s,f.p.id,{status:"제외",reason:"변경 판단"});},f=>{f.n.source="변경 모집요강";}]){
    const f=fixture(),input=f.draft();change(f);const before=JSON.stringify(f.s);
    assert.throws(()=>f.c.rptSave(f.s,input,f.c.db.adiga),/기록이 변경/);assert.equal(JSON.stringify(f.s),before);
    assert.equal(f.s.consult.reports,undefined);
  }
});
test("susi-only report selection stays distinct from an exam-selected report",()=>{
  const {c,s,draft}=fixture(),input=draft();input.data=c.rptCollect(s,{admissionYear:"2027",examId:""},c.db.adiga);
  const saved=c.rptSave(s,input,c.db.adiga);assert.equal(saved.data.exam,null);
  assert.equal(saved.data.admissionYear,"2027");assert.equal(s.consult.reports.length,1);
});
test("another source change invalidates a preview that already contains a stale-evidence warning",()=>{
  const {c,s,n,draft}=fixture();n.source="첫 번째 원문 변경";const input=draft();
  assert.equal(input.data.jeongsi.plans[0].stale,true);n.source="두 번째 원문 변경";const before=JSON.stringify(s);
  assert.throws(()=>c.rptSave(s,input,c.db.adiga),/기록이 변경/);assert.equal(JSON.stringify(s),before);
});
test("same-ID conflicts preserve both reports and repeated conflict imports add nothing",()=>{
  const {c,s,draft}=fixture(),original=c.rptSave(s,draft(),c.db.adiga),current=[original],incoming=plain(original);
  incoming.conclusion="다른 기기의 판단";incoming.data.student.school="다른 합성학교";
  const before=JSON.stringify(current),merged=c.rptMergeReports(current,[incoming]);
  assert.equal(merged.length,2);assert.equal(merged[0],original);assert.equal(JSON.stringify(current),before);
  assert.notEqual(merged[1].id,original.id);assert.equal(merged[1].importedFromId,original.id);assert.equal(merged[1].conclusion,"다른 기기의 판단");
  const repeated=c.rptMergeReports(merged,[incoming,plain(original),plain(merged[1])]);assert.equal(repeated.length,2);
  const stripped=plain(merged[1]);delete stripped.importedFromId;assert.equal(c.rptMergeReports(merged,[stripped]).length,2);
  incoming.data.student.school="changed import";assert.notEqual(merged[1].data.student.school,"changed import");
  const newVersion={...plain(original),id:"different-explicit-version"};assert.equal(c.rptMergeReports(merged,[newVersion]).length,3);
});
test("malformed report lists fail without replacing current reports or student settings",()=>{
  const {c,s,draft}=fixture(),saved=c.rptSave(s,draft(),c.db.adiga),before=JSON.stringify(s);
  for(const bad of [{},"bad",[null],[{title:"bad",data:[]}],[{title:"",data:{}}]]){
    assert.throws(()=>c.rptMergeReports([saved],bad));assert.throws(()=>c.mergeSusiStudent(s,{consult:{reports:bad}}));
    assert.equal(JSON.stringify(s),before);
  }
  const malformed=plain(s);malformed.consult.reports={legacy:"keep"};const malformedBefore=JSON.stringify(malformed);
  assert.throws(()=>c.rptSave(malformed,{...draft(),data:c.rptCollect(malformed,{admissionYear:"2027",examId:""},c.db.adiga)},c.db.adiga));
  assert.equal(JSON.stringify(malformed),malformedBefore);
});
test("actual merge import protects current reports and counseling while retaining conflicting and new versions",()=>{
  const {c,s,draft}=fixture(),first=c.rptSave(s,draft(),c.db.adiga),incoming=plain(s);
  incoming.consult.reports[0].conclusion="가져온 별도 판단";incoming.consult.susi.gradeScale="5";
  incoming.consult.jeongsi.exams[0].label="overwrite forbidden";incoming.consult.reports.push({...plain(first),id:"import-new-report",title:"다른 보고서"});
  const priorExam=JSON.stringify(s.consult.jeongsi.exams[0]),priorReport=JSON.stringify(first);
  c.imported=JSON.stringify({students:[incoming]});c.doImport();const merged=c.db.students[0];
  assert.equal(merged.consult.reports.length,3);assert.equal(JSON.stringify(merged.consult.reports[0]),priorReport);
  assert.equal(merged.consult.susi.gradeScale,"9");assert.equal(JSON.stringify(merged.consult.jeongsi.exams[0]),priorExam);
  c.doImport();assert.equal(c.db.students[0].consult.reports.length,3);assert.match(c.message,/가져오기 완료/);
});
test("real export and full restore preserve nested report snapshots and existing susi/jeongsi data",()=>{
  const {c,s,draft}=fixture();c.rptSave(s,draft(),c.db.adiga);c.rptSave(s,{...draft(),title:"두 번째 버전"},c.db.adiga);
  const before=plain(s.consult);c.exportJson();const exported=JSON.parse(c.exported);
  assert.deepEqual(exported.students[0].consult,before);c.db.students=[];c.imported=c.exported;c.doRestore();
  assert.deepEqual(plain(c.db.students[0].consult),before);assert.equal(c.db.students[0].consult.reports.length,2);
  assert.match(c.message,/전체 복원 완료/);
});
