import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Public code with synthetic records only; no real student, storage, browser or network.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const source=[html.match(/^function uniNorm.*$/m)[0],html.match(/^const APL_AREAS=.*$/m)[0],
  section("const ADIGA_FIELDS=","function renderAdiga(){"),section("function aplTam(","function minText("),
  section("// JEONGSI_CORE_START","// JEONGSI_CORE_END"),section("// JEONGSI_STORE_START","// JEONGSI_STORE_END"),
  section("// REPORT_CORE_START","// REPORT_CORE_END")].join("\n");
const plain=v=>JSON.parse(JSON.stringify(v));
function setup(){
  const c=vm.createContext({URL,db:{adiga:[]},today:()=>{throw Error("수집 중 현재 시각 생성 금지");}});
  vm.runInContext(source,c);c.jSerial=vm.runInContext("jSerial",c);
  for(const key of ["jCalc","jState","aplList","ipsiMyPct","mkPct"])c[key]=()=>{throw Error("보고서 수집 중 호출 금지: "+key);};
  return c;
}
function note(extra={}){return {univ:"가상대학교",major:"가상학과",track:"학생부교과",admissionYear:"2027",resultYear:"2026",
  source:"합성 모집요강",checked:"2026-10-15",url:"https://example.org/synthetic",content:"합성 근거 메모",...extra};}
function regularNote(extra={}){return note({track:"수능 일반",regular:{group:"가",mode:"weighted",metric:"percentile",
  weights:{kor:100,math:0,inq:0},inquiry:"mean2",englishMode:"none",historyMode:"none",englishTable:[],historyTable:[],unsupported:""},...extra});}
function exam(id="exam-a",year="2027"){return {id,revision:"revision-1",label:"합성 "+id,type:"수능",admissionYear:year,
  date:"2026-11-19",status:"확정",source:"합성 시험 성적표",checked:"2026-12-10",scores:{kor:{subject:"가상 국어",percentile:0,grade:9},
    math:{subject:"가상 수학",grade:9},eng:{subject:"영어",grade:9},inq1:{subject:"가상 탐구 A",grade:9},
    inq2:{subject:"가상 탐구 B",grade:9},hist:{subject:"한국사",grade:9}}};}
function card(n,extra={}){return {id:"susi-a",univ:n.univ,major:n.major,track:n.track,admissionYear:n.admissionYear,status:"준비",
  min:{status:"present",on:true,areas:["국","수"],n:2,sum:4,tam:"1"},evidence:{note:plain(n),dbYear:"2026",metric:"70%컷",cut:0,
    source:"합성 입결",checked:"2026-10-15",url:"https://example.org/results"},
  consultation:{gradeScale:"9",gradeAverage:"3",gradeLabel:"합성 학기",eligibility:"met",decisionReason:"검토 메모",limitations:[]},...extra};}
function fixture(){
  const c=setup(),n=note(),r=regularNote(),e=c.jExam(exam()),other=c.jExam(exam("exam-b")),next=c.jExam(exam("exam-next","2028"));
  const p=(x,note=r,id=x.id)=>({id:"plan-"+id,revision:"plan-rev",univ:note.univ,major:note.major,track:note.track,
    admissionYear:x.admissionYear,examId:x.id,group:note.regular.group,status:"지원안",reason:"합성 선택 사유",
    examSnapshot:plain(x),ruleSnapshot:plain(c.jRule(note)),resultSnapshot:{score:0,formula:"저장 당시 식",parts:["저장 당시 계산"],missing:[],limitations:["저장 당시 제약"]}});
  const s={id:"student-a",name:"합성 학생 A",grade:"고3",school:"합성 학교",mockRef:{exam:"별도 최저 기준",국:1,수:1},
    apply:[card(n),card(n,{id:"legacy",admissionYear:""}),card(n,{id:"old",admissionYear:"2026"})],
    consult:{susi:{admissionYear:"2027",gradeScale:"9",gradeAverage:"3",gradeLabel:"합성 학기",custom:"keep"},
      susiDecisions:{[JSON.stringify(["가상대","가상학과","학생부교과","2027"])]:{excluded:true,reason:"선택년도 제외",checked:"2026-10-15",custom:{keep:true}},
        [JSON.stringify(["다른대","다른학과","논술","2027"])]:{excluded:false,reason:"검토 메모 유지",checked:"2026-10-14"},
        [JSON.stringify(["과거대","과거학과","교과","2026"])]:{excluded:true,reason:"타년도 제외",checked:"2026-10-15"}},
      jeongsi:{exams:[e,other,next],plans:[p(e),p(other),p(next,regularNote({admissionYear:"2028"}))],history:[]}}};
  const notes=[n,r,regularNote({admissionYear:"2028"})];c.db.adiga=notes;return {c,s,n,r,e,other,notes};
}

test("report isolates the selected student, admission year, exam and legacy groups",()=>{
  const {c,s,notes}=fixture(),data=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes);
  assert.equal(data.student.id,"student-a");assert.equal(data.exam.id,"exam-a");assert.equal(data.admissionYear,"2027");
  assert.equal(data.susi.cards.length,1);assert.equal(data.susi.legacyCards.length,1);assert.equal(data.susi.otherYearCount,1);
  assert.equal(data.jeongsi.plans.length,1);assert.equal(data.jeongsi.plans[0].plan.examId,"exam-a");
  assert.equal(data.jeongsi.otherExamPlans.length,1);assert.equal(data.jeongsi.otherExamPlans[0].plan.examId,"exam-b");
  assert.equal(data.jeongsi.otherYearCount,1);assert.equal(data.susi.input.custom,"keep");
  const other={id:"student-b",name:"합성 학생 B",consult:{jeongsi:{exams:[exam("foreign-exam")],plans:[]}}};
  assert.throws(()=>c.rptCollect(other,{admissionYear:"2027",examId:"exam-a"},notes),/이 학생/);
  assert.throws(()=>c.rptCollect(s,{admissionYear:"2027",examId:"foreign-exam"},notes),/이 학생/);
  assert.throws(()=>c.rptCollect(s,{admissionYear:"2027",examId:"exam-next"},notes),/학년도/);
  assert.throws(()=>c.rptCollect(s,{admissionYear:"27",examId:""},notes),/학년도/);
});
test("empty exam selection is susi-only and keeps same-year other-exam plans separate",()=>{
  const {c,s,notes}=fixture(),d=c.rptCollect(s,{admissionYear:"2027",examId:""},notes);
  assert.equal(d.exam,null);assert.equal(d.jeongsi.plans.length,0);assert.equal(d.jeongsi.otherExamPlans.length,2);
  assert.ok(d.limitations.some(x=>x.includes("정시 시험을 선택하지 않았습니다")));
});

test("course plans use the latest matching admission year and keep earlier report snapshots",()=>{
  const {c,s,notes}=fixture(),selection={admissionYear:"2027",examId:""};
  assert.equal(c.rptCollect(s,selection,notes).coursePlanText,"");
  s.consult.coursePlans=[{admissionYear:"2027",reportText:"첫 설계"},{admissionYear:"2028",reportText:"다른 학년도"}];
  const before=JSON.stringify(s),saved=c.rptCollect(s,selection,notes);
  assert.equal(saved.coursePlanText,"첫 설계");assert.equal(JSON.stringify(s),before);
  s.consult.coursePlans.push({admissionYear:"2027",reportText:"새 설계"});
  assert.equal(c.rptCollect(s,selection,notes).coursePlanText,"새 설계");
  assert.equal(saved.coursePlanText,"첫 설계");
  assert.equal(c.rptCollect(s,{admissionYear:"2028",examId:""},notes).coursePlanText,"다른 학년도");
});
test("collection is deterministic, timestamp-free and deeply independent without mutating inputs",()=>{
  const {c,s,notes}=fixture(),before=JSON.stringify({s,notes}),selection={admissionYear:"2027",examId:"exam-a"};
  const a=c.rptCollect(s,selection,notes),b=c.rptCollect(s,selection,notes);
  assert.equal(c.jSerial(a),c.jSerial(b));assert.equal(JSON.stringify({s,notes}),before);
  assert.equal(Object.hasOwn(a,"createdAt"),false);assert.equal(Object.hasOwn(a,"notes"),false);
  a.susi.cards[0].card.evidence.note.content="changed";a.susi.input.custom="changed";
  a.jeongsi.plans[0].plan.examSnapshot.scores.kor.percentile=99;a.sourceState.jeongsiSources[0].currentNote.source="changed";
  assert.equal(JSON.stringify({s,notes}),before);
  s.consult.reports=[{createdAt:"different-time",data:{privateDraft:"not included"}}];
  assert.equal(c.jSerial(c.rptCollect(s,selection,notes)),c.jSerial(b));
});
test("decisions preserve excluded and non-excluded memos, unknown keys and exact-year filtering",()=>{
  const {c,s,notes}=fixture();s.consult.susiDecisions["bad-json"]={excluded:true,reason:"손상 키"};
  s.consult.susiDecisions[JSON.stringify(["대학","학과","전형"]) ]={excluded:false,reason:"불완전 키"};
  const d=c.rptCollect(s,{admissionYear:"2027",examId:""},notes);
  assert.equal(d.susi.decisions.length,2);assert.equal(d.susi.decisions[0].excluded,true);
  assert.equal(d.susi.decisions[0].custom.keep,true);assert.equal(d.susi.decisions[1].excluded,false);
  assert.equal(d.susi.decisions[1].reason,"검토 메모 유지");assert.ok(!JSON.stringify(d.susi.decisions).includes("타년도 제외"));
  assert.ok(d.missing.some(x=>x.includes("식별 형식")));assert.equal(s.consult.susiDecisions["bad-json"].reason,"손상 키");
});
test("susi provenance and target changes flag missing or stale while keeping original snapshots",()=>{
  const {c,s,notes}=fixture(),a=s.apply[0];a.evidence.note.source="";a.evidence.note.checked="invalid";
  a.evidence.note.url="javascript:bad()";a.evidence.note.resultYear="";a.evidence.reviewRequired=true;a.track="다른 전형";
  const before=JSON.stringify(a),entry=c.rptCollect(s,{admissionYear:"2027",examId:""},notes).susi.cards[0];
  assert.equal(entry.stale,true);for(const word of ["출처 미확인","확인일 미확인","원문 주소 미확인","결과학년도 미확인","불일치"])
    assert.ok(entry.missing.some(x=>x.includes(word)),word);
  assert.equal(entry.card.evidence.note.url,"javascript:bad()");assert.equal(JSON.stringify(a),before);
});
test("susi snapshot grades remain unchanged when current input changes or disappears",()=>{
  const {c,s,notes}=fixture();s.consult.susi.gradeAverage="4";
  let d=c.rptCollect(s,{admissionYear:"2027",examId:""},notes);assert.equal(d.susi.cards[0].stale,true);
  assert.equal(d.susi.cards[0].card.consultation.gradeAverage,"3");assert.equal(d.susi.input.gradeAverage,"4");
  delete s.consult.susi;d=c.rptCollect(s,{admissionYear:"2027",examId:""},notes);
  assert.equal(d.susi.input,null);assert.equal(d.susi.cards[0].stale,true);
});
test("susi excludes regular notes and source state detects another change after already stale",()=>{
  const {c,s,notes}=fixture(),selection={admissionYear:"2027",examId:"exam-a"};
  notes[0]={...notes[0],source:"first change"};notes[1]={...notes[1],source:"first regular change"};
  const a=c.rptCollect(s,selection,notes);assert.equal(a.susi.cards[0].stale,true);assert.equal(a.jeongsi.plans[0].stale,true);
  notes[0].source="second change";notes[1].source="second regular change";
  const b=c.rptCollect(s,selection,notes);assert.notEqual(c.jSerial(a),c.jSerial(b));
  const wrong=regularNote({track:"학생부교과",checked:"2026-10-16"});
  const onlyRegular=c.rptCollect(s,selection,[wrong,notes[1]]);
  assert.equal(onlyRegular.sourceState.susiNotes[0],null);
  assert.ok(onlyRegular.susi.cards[0].missing.some(x=>x.includes("연결 가능한 수시 근거 없음")));
});
test("minimum comparison uses separately stored mockRef, never selected actual exam grades",()=>{
  const {c,s,notes}=fixture(),d=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes);
  assert.equal(d.exam.scores.kor.grade,9);assert.equal(d.susi.minimumRef.국,1);assert.equal(d.susi.minimumRef.exam,"별도 최저 기준");
  assert.equal(d.susi.cards[0].minimumResult.state,"ok");assert.equal(d.susi.cards[0].minimumResult.sum,2);
  assert.ok(d.limitations.some(x=>x.includes("mockRef")&&x.includes("선택한 실제 정시 시험과 연결된 성적이 아니")));
  s.mockRef.국=10;assert.equal(c.rptCollect(s,{admissionYear:"2027",examId:""},notes).susi.cards[0].minimumResult.state,"bad");
});
test("legacy absent minimum stays unknown; only explicit none means no minimum",()=>{
  const {c,s,notes}=fixture();
  for(const value of [undefined,{on:false},{on:true,areas:["국"],n:1,sum:3},{status:"unknown",on:false}]){
    s.apply[0].min=value;const before=JSON.stringify(s.apply[0]),d=c.rptCollect(s,{admissionYear:"2027",examId:""},notes);
    assert.equal(d.susi.cards[0].minimumResult.state,"unknown");assert.equal(JSON.stringify(s.apply[0]),before);
  }
  s.apply[0].min={status:"present",on:false};assert.equal(c.rptCollect(s,{admissionYear:"2027",examId:""},notes).susi.cards[0].minimumResult.state,"bad");
  s.apply[0].min={status:"none",on:false};assert.equal(c.rptCollect(s,{admissionYear:"2027",examId:""},notes).susi.cards[0].minimumResult.state,"na");
});
test("saved regular score zero and calculation-pending results stay unchanged without recalculation",()=>{
  const {c,s,notes}=fixture();s.consult.jeongsi.plans[1].resultSnapshot={score:null,formula:"미지원 원문",parts:[],missing:["선택과목 가산점 미지원"],limitations:[]};
  const d=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes);
  assert.equal(d.jeongsi.plans[0].plan.resultSnapshot.score,0);assert.equal(d.jeongsi.plans[0].stale,false);
  assert.equal(d.jeongsi.otherExamPlans[0].plan.resultSnapshot.score,null);
  assert.ok(d.jeongsi.otherExamPlans[0].missing.includes("선택과목 가산점 미지원"));
  assert.ok(!d.jeongsi.plans[0].missing.some(x=>x.includes("참고점수 계산 보류")));
});
test("current exam or exact-group rule changes mark stale and retain saved exam and formula",()=>{
  const {c,s,notes}=fixture();s.consult.jeongsi.exams[0].revision="new-revision";
  const d=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes),entry=d.jeongsi.plans[0];
  assert.equal(entry.stale,true);assert.equal(entry.plan.examSnapshot.revision,"revision-1");
  assert.equal(entry.plan.resultSnapshot.formula,"저장 당시 식");
  notes[1]={...notes[1],regular:{...notes[1].regular,group:"나"}};
  const noMatch=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes);
  assert.equal(noMatch.sourceState.jeongsiSources[0].currentNote,null);
  assert.ok(noMatch.jeongsi.plans[0].missing.some(x=>x.includes("연결 가능한 정시 근거 없음")));
});
test("blank actual score fields may be collected but missing source, check and subjects are explicit",()=>{
  const {c,s,notes}=fixture();s.consult.jeongsi.exams[0]=c.jExam({...exam(),source:"",checked:"",scores:{},status:"가채점"});
  const d=c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes);
  assert.equal(d.exam.scores.kor.raw,"");assert.equal(d.exam.scores.kor.percentile,"");
  for(const word of ["성적 출처 미확인","성적 확인일 미확인","국어 과목명 미입력","국어 실제 성적 미입력"])
    assert.ok(d.missing.some(x=>x.includes(word)),word);
  assert.ok(d.limitations.some(x=>x.includes("가채점")));
});
test("damaged arrays or object structures stop collection and leave the input untouched",()=>{
  const changes=[s=>s.apply={},s=>s.apply=[null],s=>s.apply[0].evidence=[],s=>s.apply[0].min.areas={},
    s=>s.consult.susi=[],s=>s.consult.susiDecisions=[],s=>s.consult.jeongsi.plans={},
    s=>s.consult.jeongsi.exams[0].scores=[],s=>s.consult.jeongsi.exams[0].scores.kor="bad",
    s=>s.consult.jeongsi.plans[0].resultSnapshot.missing="bad",s=>s.mockRef=[]];
  for(const change of changes){const {c,s,notes}=fixture();change(s);const before=JSON.stringify(s);
    assert.throws(()=>c.rptCollect(s,{admissionYear:"2027",examId:"exam-a"},notes));assert.equal(JSON.stringify(s),before);}
  const {c,s}=fixture();assert.throws(()=>c.rptCollect(s,{admissionYear:"2027",examId:""},{}));
  assert.throws(()=>c.rptCollect(s,{admissionYear:"2027",examId:""},[null]));
});
