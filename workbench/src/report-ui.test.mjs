import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Synthetic VM UI checks; no real browser, student records, clipboard or storage.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,`Missing ${start}`);return html.slice(a,b);}
const source=[html.match(/^const esc=.*$/m)[0],html.match(/^function uniNorm.*$/m)[0],
  section("const ADIGA_FIELDS=","function renderAdiga(){"),section("const APL_KINDS=","/* ═══════════ 월간 캘린더"),
  ...["JEONGSI_CORE","JEONGSI_STORE","JEONGSI_UI","REPORT_CORE","REPORT_STORE","REPORT_UI"].map(name=>section(`// ${name}_START`,`// ${name}_END`))].join("\n");
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(){
  let id=0;const elements=new Map(),c={URL,db:{students:[],adiga:[]},view:{},saveCalls:0,renderCalls:0,copies:[],
    uid:()=>`synthetic-${++id}`,today:()=>"2026-10-15",allIpRows:()=>[],
    save:()=>{c.saveCalls++;if(c.failSave)throw Error("synthetic storage quota");},render:()=>c.renderCalls++,
    copy:text=>c.copies.push(text),toast:message=>{c.message=message;},go:page=>{c.view.page=page;},
    $:key=>{if(!elements.has(key))elements.set(key,{innerHTML:"",value:""});return elements.get(key);}};
  vm.createContext(c);vm.runInContext(source,c);
  return c;
}
function exam(extra={}){return {label:"합성 원본 시험",type:"수능",admissionYear:"2027",date:"2026-11-19",status:"확정",source:"합성 성적표",checked:"2026-12-10",
  scores:{kor:{subject:"합성 국어",raw:0,standard:120,percentile:80,grade:3},math:{subject:"합성 수학",percentile:90},
    inq1:{subject:"합성 탐구 A",percentile:70},inq2:{subject:"합성 탐구 B",percentile:90},eng:{subject:"영어",grade:2},hist:{subject:"한국사",grade:3}},...extra};}
function rule(){return {univ:"가상대학교",major:"합성학과",track:"수능 일반",admissionYear:"2027",source:"합성 원문",checked:"2026-10-15",
  url:"https://example.org/synthetic",content:"저장 당시 반영식",regular:{group:"가",mode:"weighted",metric:"percentile",weights:{kor:40,math:40,inq:20},
    inquiry:"mean2",englishMode:"none",historyMode:"none",englishTable:[],historyTable:[],unsupported:""}};}
function fixture(options={}){
  const c=setup(),s={id:"synthetic-one",name:"합성 학생 하나",grade:"고3",school:"합성고",consult:{susi:{admissionYear:"2027",gradeScale:"9",gradeAverage:"3",gradeLabel:"합성 내신"}},
    apply:[{id:"legacy-card",univ:"합성교과대",major:"합성학과",track:"학생부교과",admissionYear:"2027",min:{on:false},memo:"기존 지원 카드"}]};
  const second={id:"synthetic-two",name:"합성 학생 둘",grade:"고3",consult:{susi:{admissionYear:"2028",gradeScale:"5",gradeAverage:"2",gradeLabel:"별도 내신"}}};
  c.db.students.push(s,second);const n=rule();c.db.adiga.push(n);const input=exam();
  if(options.zero)for(const key of ["kor","math","inq1","inq2"])input.scores[key].percentile=0;
  const e=c.jSaveExam(s,input),p=c.jSavePlan(s,{univ:n.univ,major:n.major,track:n.track,group:"가",admissionYear:"2027",examId:e.id,ruleSnapshot:n}).plan;
  c.openReport(s.id,"2027",e.id);return {c,s,second,n,e,p,main:()=>{c.renderReport();return c.$("#main").innerHTML;}};
}
function build(c){c.rptBuild();assert.equal(c.view.rptError,"");assert.ok(c.view.rptData);}
function cleared(c){assert.equal(c.view.rptData,null);for(const key of ["rptSavedId","rptError","rptTitle","rptConclusion","rptNextActions"])assert.equal(c.view[key],"");}

test("changing student, admission year or exam clears preview and judgment fields without touching records",()=>{
  const {c,s,second,e}=fixture(),before=JSON.stringify(c.db);
  build(c);c.view.rptConclusion="old judgment";c.view.rptNextActions="old action";c.rptChooseExam("");cleared(c);assert.equal(c.view.rptExamId,"");
  build(c);c.rptChooseYear("2028");cleared(c);assert.equal(c.view.rptYear,"2028");assert.equal(c.view.rptExamId,"");
  build(c);c.rptChooseStudent(second.id);cleared(c);assert.equal(c.view.rptYear,"2028");assert.equal(c.rptStudent(),second);
  build(c);assert.equal(c.view.rptData.student.id,second.id);assert.equal(c.view.rptData.exam,null);
  c.openReport(s.id,"2027",e.id);cleared(c);assert.equal(c.view.page,"report");assert.equal(c.view.rptExamId,e.id);
  assert.equal(JSON.stringify(c.db),before);
});
test("build and save select an immutable report, and an explicit new report adds a separate version",()=>{
  const {c,s,main}=fixture(),before=plain(s);build(c);c.view.rptTitle=" 합성 보고서 ";c.view.rptConclusion="첫 판단";c.view.rptNextActions="다음 상담";
  c.rptSaveCurrent();assert.equal(c.view.rptError,"");assert.equal(c.saveCalls,1);assert.equal(s.consult.reports.length,1);
  const first=s.consult.reports[0],firstBytes=JSON.stringify(first);assert.equal(c.view.rptSavedId,first.id);assert.equal(first.title,"합성 보고서");
  assert.equal(first.conclusion,"첫 판단");assert.equal(first.nextActions,"다음 상담");assert.match(main(),/저장 당시 보고서/);
  assert.deepEqual(plain(s.consult.jeongsi),before.consult.jeongsi);assert.deepEqual(plain(s.apply),before.apply);
  c.rptNewFromSaved();assert.equal(c.view.rptSavedId,"");assert.ok(c.view.rptData);c.view.rptTitle="새 버전";c.rptSaveCurrent();
  assert.equal(s.consult.reports.length,2);assert.notEqual(s.consult.reports[1].id,first.id);assert.equal(JSON.stringify(first),firstBytes);
});
test("changed source blocks both preview save and copy, including direct handler calls",()=>{
  const {c,s,n,main}=fixture();build(c);n.source="변경된 현재 출처";const before=JSON.stringify(s);
  const rendered=main();assert.match(rendered,/상담 기록이 변경/);
  assert.match(rendered,/<button[^>]*disabled[^>]*onclick="rptSaveCurrent\(\)"/);
  assert.match(rendered,/<button[^>]*disabled[^>]*onclick="rptCopyCurrent\(\)"/);
  c.rptCopyCurrent();assert.equal(c.copies.length,0);assert.match(c.view.rptError,/기록이 변경/);
  c.rptSaveCurrent();assert.equal(c.saveCalls,0);assert.equal(JSON.stringify(s),before);assert.match(c.view.rptError,/기록이 변경/);
  build(c);c.rptSaveCurrent();assert.equal(s.consult.reports.length,1);
});
test("saved report copy stays stable after source changes and selecting it restores its original scope",()=>{
  const {c,s,e,n}=fixture();build(c);c.view.rptConclusion="저장 당시 판단";c.rptSaveCurrent();
  const saved=s.consult.reports[0];c.rptCopyCurrent();const firstText=c.copies.at(-1),savedBytes=JSON.stringify(saved);
  c.jSaveExam(s,{...plain(e),label:"수정된 현재 시험"});n.source="새 원문";s.school="바뀐 학교";
  c.rptChooseYear("2028");c.rptChooseSaved(saved.id);assert.equal(c.view.rptYear,"2027");assert.equal(c.view.rptExamId,e.id);
  c.rptCopyCurrent();assert.equal(c.copies.at(-1),firstText);assert.equal(JSON.stringify(saved),savedBytes);
  c.rptNewFromSaved();assert.equal(c.view.rptSavedId,"");assert.equal(c.view.rptData.exam.label,"수정된 현재 시험");
  assert.equal(c.view.rptData.student.school,"바뀐 학교");assert.equal(JSON.stringify(saved),savedBytes);
});
test("storage failure rolls back only the new report and preserves existing records and optional field shape",()=>{
  for(const kind of ["existing","first-with-consult","first-without-consult"]){
    const {c,s,main}=fixture();
    if(kind==="existing"){build(c);c.rptSaveCurrent();c.rptNewFromSaved();}
    else if(kind==="first-without-consult"){delete s.consult;s.apply=[];c.view.rptExamId="";build(c);}
    else build(c);
    const before=JSON.stringify(s),priorReports=s.consult?.reports; c.failSave=true;c.rptSaveCurrent();
    assert.equal(JSON.stringify(s),before,kind);assert.equal(s.consult?.reports,priorReports);assert.equal(c.view.rptSavedId,"");
    assert.match(c.view.rptError,/새 보고서는 저장되지 않았고 기존 기록은 유지/);assert.match(main(),/기기 저장에 실패/);
  }
});
test("HTML renders hostile text as text and never creates executable or credential-bearing links",()=>{
  const {c,s,p,main}=fixture(),attack='<img src=x onerror="bad()">';s.name=attack;s.apply[0].univ=attack;
  s.apply[0].evidence={note:{univ:attack,major:"합성학과",track:"학생부교과",admissionYear:"2027",content:"</textarea><script>bad()</script>",url:"javascript:bad()"},url:"https://user:secret@example.org/private"};
  p.ruleSnapshot.url="javascript:bad()";build(c);c.view.rptTitle='" onfocus="bad()';c.view.rptConclusion="</textarea><script>bad()</script>";
  const rendered=main();assert.ok(!rendered.includes("<img src=x"));assert.ok(!rendered.includes("<script>bad()"));
  assert.ok(rendered.includes("&lt;img src=x onerror=&quot;bad()&quot;&gt;"));assert.ok(rendered.includes("&lt;/textarea&gt;&lt;script&gt;bad()&lt;/script&gt;"));
  assert.ok(!/href="(?:javascript:|https:\/\/user:secret)/i.test(rendered));assert.ok(rendered.includes("&quot; onfocus=&quot;bad()"));
});
test("zero results remain visible and legacy minimums remain unknown instead of silently confirmed",()=>{
  const {c,main}=fixture({zero:true});build(c);const data=c.view.rptData;
  assert.equal(data.jeongsi.plans[0].plan.resultSnapshot.score,0);assert.equal(data.susi.cards[0].minimumResult.state,"unknown");
  const text=c.rptText(data,c.rptCurrent()),card=c.rptCardText(data.susi.cards[0]);
  assert.match(text,/0 · 입력 반영식 참고점수/);assert.match(text,/원점수 0/);assert.match(card,/수능최저 미확인/);assert.ok(!card.includes("최저 없음"));
  assert.match(main(),/0 · 입력 반영식 참고점수/);
});
test("on-screen sections and copied body use the same content and omit comparison-only source state",()=>{
  const {c,n,main}=fixture();n.content="SOURCE_STATE_ONLY_SYNTHETIC";build(c);
  c.view.rptConclusion="본문의 종합 판단";c.view.rptNextActions="본문의 후속 계획";
  const data=c.view.rptData,sections=c.rptSections(data),text=c.rptText(data,c.rptCurrent()),rendered=main();
  const escape=vm.runInContext("esc",c);
  for(const part of sections){assert.ok(text.includes(`[${part.title}]\n${part.text}`),part.title);assert.ok(rendered.includes(escape(part.text)),part.title);}
  assert.ok(text.includes("본문의 종합 판단"));assert.ok(text.includes("본문의 후속 계획"));
  assert.ok(JSON.stringify(data.sourceState).includes("SOURCE_STATE_ONLY_SYNTHETIC"));assert.ok(!text.includes("SOURCE_STATE_ONLY_SYNTHETIC"));assert.ok(!rendered.includes("SOURCE_STATE_ONLY_SYNTHETIC"));
  c.rptCopyCurrent();assert.equal(c.copies.at(-1),text);
});
test("invalid selections or empty titles show an error and never persist a partial report",()=>{
  const {c,s,main}=fixture(),before=JSON.stringify(s);c.rptChooseYear("27");c.rptBuild();
  assert.match(c.view.rptError,/모집학년도/);assert.equal(c.view.rptData,null);assert.match(main(),/모집학년도/);
  c.rptChooseYear("2027");c.rptChooseExam("foreign-exam");c.rptBuild();assert.match(c.view.rptError,/시험/);assert.equal(c.view.rptData,null);
  c.rptChooseExam("");build(c);c.view.rptTitle=" ";c.rptSaveCurrent();assert.match(c.view.rptError,/제목/);
  assert.equal(c.saveCalls,0);assert.equal(JSON.stringify(s),before);
});
