import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Synthetic in-memory UI regression only. No browser storage, private data or network.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const source=[html.match(/^const esc=.*$/m)[0],html.match(/^function uniNorm.*$/m)[0],html.match(/^function susiKey.*$/m)[0],
  section("const ADIGA_FIELDS=","function renderAdiga(){"),section("// JEONGSI_CORE_START","// JEONGSI_CORE_END"),
  section("// JEONGSI_STORE_START","// JEONGSI_STORE_END"),section("// JEONGSI_UI_START","// JEONGSI_UI_END")].join("\n");
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(notes=[],rows=[]){
  let id=0;const elements=new Map(),student={id:"synthetic-student",name:"합성 학생",grade:"고3",consult:{}};
  const c={URL,db:{students:[student],adiga:notes},view:{jStuId:student.id},saveCount:0,renderCount:0,
    uid:()=>`synthetic-${++id}`,today:()=>"2026-10-15",allIpRows:()=>rows,toast:()=>{},
    save:()=>c.saveCount++,render:()=>{c.renderCount++;c.renderJeongsi();},
    $:key=>{if(!elements.has(key))elements.set(key,{innerHTML:"",textContent:"",value:"",focus(){}});return elements.get(key);},
    ipsiMyPct:()=>{throw Error("내신 추정 호출 금지");},mkPct:()=>{throw Error("내신 추정 호출 금지");}};
  vm.createContext(c);vm.runInContext(source,c);return {c,s:student,main:()=>c.$("#main").innerHTML};
}
function exam(extra={}){return {label:"합성 원본 시험",type:"수능",admissionYear:"2027",date:"2026-11-19",status:"확정",
  source:"합성 성적표",checked:"2026-12-10",scores:{kor:{subject:"가상 국어",raw:"",percentile:80},
    math:{subject:"가상 수학",percentile:90},inq1:{subject:"가상 탐구 A",percentile:70},inq2:{subject:"가상 탐구 B",percentile:90},
    eng:{subject:"영어",grade:2},hist:{subject:"한국사",grade:3}},...extra};}
function rule(extra={},regular={}){return {univ:"가상대학교",major:"가상학과",track:"수능 일반",admissionYear:"2027",
  source:"합성 원문",url:"https://example.org/synthetic",checked:"2026-10-15",content:"합성 반영식 설명",
  regular:{group:"가",mode:"weighted",metric:"percentile",weights:{kor:40,math:40,inq:20},inquiry:"mean2",
    englishMode:"none",historyMode:"none",englishTable:[],historyTable:[],unsupported:"",...regular},...extra};}
function plan(c,s,e,n){return c.jSavePlan(s,{univ:n.univ,major:n.major,track:n.track,admissionYear:e.admissionYear,
  group:n.regular.group,examId:e.id,ruleSnapshot:n}).plan;}
function inputEvent(c,markup,id,value){
  const element=markup.match(new RegExp('<(?:input|select|textarea)\\b[^>]*\\bid="'+id+'"[^>]*>'))?.[0];
  const handler=element?.match(/\bon(?:input|change)="([^"]+)"/)?.[1];assert.ok(handler,`Missing input handler: ${id}`);
  c.syntheticInputValue=value;vm.runInContext('(function(){'+handler+'}).call({value:syntheticInputValue})',c);delete c.syntheticInputValue;
}

test("exam input handlers retain unsaved metadata and scores across tab rendering without editing the stored exam",()=>{
  const {c,s,main}=fixture([rule()]),e=c.jSaveExam(s,exam()),before=JSON.stringify(s);c.view.jTab="exam";c.renderJeongsi();
  const form=main(),renderCount=c.renderCount;
  for(const [key,value] of Object.entries({label:"아직 저장하지 않은 시험명",type:"모평",status:"가채점",date:"2026-09-01",admissionYear:"2028",source:"수정 중인 출처",checked:"2026-10-16"}))inputEvent(c,form,"je_"+key,value);
  for(const [key,value] of Object.entries({subject:"수정 중인 과목",raw:"0",standard:"",percentile:"91",grade:"2"}))inputEvent(c,form,"je_kor_"+key,value);
  assert.equal(c.renderCount,renderCount);assert.equal(c.saveCount,0);assert.equal(JSON.stringify(s),before);
  assert.equal(c.view.jExamDraft.id,e.id);assert.equal(c.view.jExamDraft.scores.kor.percentile,"91");
  c.view.jTab="candidates";c.render();c.view.jTab="exam";c.render();
  assert.match(main(),/id="je_label"[^>]*value="아직 저장하지 않은 시험명"/);
  assert.match(main(),/id="je_kor_percentile"[^>]*value="91"/);assert.match(main(),/id="je_kor_standard"[^>]*value=""/);
  assert.match(main(),/<option selected>모평<\/option>/);assert.match(main(),/<option selected>가채점<\/option>/);
  assert.equal(JSON.stringify(s),before);
});
test("a first exam draft keeps zero and blank values when there is no saved exam",()=>{
  const {c,s,main}=fixture();c.renderJeongsi();const before=JSON.stringify(s),form=main();
  inputEvent(c,form,"je_label","첫 시험 초안");inputEvent(c,form,"je_kor_raw","0");inputEvent(c,form,"je_kor_grade","");c.render();
  assert.equal(c.view.jExamDraft.id,undefined);assert.equal(c.jState(s).exams.length,0);assert.equal(JSON.stringify(s),before);
  assert.match(main(),/id="je_label"[^>]*value="첫 시험 초안"/);assert.match(main(),/id="je_kor_raw"[^>]*value="0"/);
  assert.match(main(),/id="je_kor_grade"[^>]*value=""/);assert.equal(c.saveCount,0);
});
test("rule input handlers retain nested changes across compare and filter rendering while protecting the shared note",()=>{
  const n=rule({custom:{preserved:true}}),{c,s,main}=fixture([n]);c.jSaveExam(s,exam());c.renderJeongsi();c.jOpenRule(0);
  const form=main(),before=JSON.stringify(c.db),renderCount=c.renderCount;
  for(const [key,value] of Object.entries({univ:"수정 중 대학",major:"수정 중 학과",track:"수정 중 전형",admissionYear:"2028",resultYear:"2027",source:"수정 중 출처",checked:"2026-10-16",url:"https://example.org/draft",content:"저장 전 반영 메모"}))inputEvent(c,form,"jr_"+key,value);
  for(const [key,value] of Object.entries({group:"나",mode:"manual",metric:"standard",inquiry:"best1",englishMode:"table",historyMode:"none",englishTable:"0,0,-1,-2,-3,-4,-5,-6,-7",historyTable:"",unsupported:"미지원 변환표"}))inputEvent(c,form,"jr_"+key,value);
  for(const [key,value] of Object.entries({kor:"0",math:"40",inq:"60"}))inputEvent(c,form,"jr_w_"+key,value);
  assert.equal(c.renderCount,renderCount);assert.equal(c.saveCount,0);assert.equal(JSON.stringify(c.db),before);
  assert.equal(c.view.jRuleDraft.custom.preserved,true);assert.equal(c.view.jRuleDraft.regular.weights.kor,"0");assert.equal(c.view.jRuleDraft.regular.group,"나");
  c.jToggleCompare(0,true);c.$("#j_query").value="가상";c.$("#j_group").value="";c.jApplyFilter();
  assert.match(main(),/id="jr_source"[^>]*value="수정 중 출처"/);assert.ok(main().includes("저장 전 반영 메모"));
  assert.match(main(),/id="jr_w_kor"[^>]*value="0"/);assert.match(main(),/id="jr_englishTable"[^>]*value="0,0,-1,-2,-3,-4,-5,-6,-7"/);
  assert.match(main(),/<option value="나" selected>나군<\/option>/);assert.ok(main().includes("미지원 변환표"));assert.equal(JSON.stringify(c.db),before);
});

test("same university, major, track and year create distinct group candidates and group-exact rules",()=>{
  const ga=rule({checked:"2026-10-01"}),na=rule({checked:"2026-10-15"},{group:"나"}),{c}=fixture([ga,na]);
  const groups=c.jGroups("2027");assert.equal(groups.length,2);assert.notEqual(groups[0].key,groups[1].key);
  assert.deepEqual(Array.from(groups,g=>g.group).sort(),["가","나"]);
  for(const [group,n] of [["가",ga],["나",na]]){
    const g=groups.find(g=>g.group===group);assert.equal(g.note,n);assert.equal(c.jRuleFor(g),n);
  }
  assert.equal(c.jRuleFor({...groups[0],group:"다"}),null);
});
test("candidate notes from another admission year and future DB rows are excluded",()=>{
  const current=rule(),old=rule({univ:"지난년도대",admissionYear:"2026"}),future=rule({univ:"다음년도대",admissionYear:"2028"});
  const {c}=fixture([current,old,future],[{univ:"미래자료대",major:"가상학과",track:"수능 일반",year:2028}]);
  const groups=c.jGroups("2027");assert.equal(groups.length,1);assert.equal(groups[0].note,current);
  assert.equal(c.jRuleFor({...groups[0],admissionYear:"2028"}),null);
});
test("clearing exam selection hides results while preserving that exam's comparison selection",()=>{
  const {c,s,main}=fixture([rule()]),e=c.jSaveExam(s,exam());c.view.jTab="candidates";
  c.view.jExamDraft=plain(e);c.view.jRuleDraft=rule();c.renderJeongsi();c.jToggleCompare(0,true);
  const keys=Array.from(c.jCompareKeys(s,e));assert.equal(keys.length,1);
  assert.ok(main().includes("합성 원본 시험 기준 후보"));
  c.jChooseExam("");assert.equal(c.jState(s).examId,"");assert.equal(c.jActiveExam(s),null);
  assert.equal(c.view.jExamDraft,null);assert.equal(c.view.jRuleDraft,null);assert.deepEqual(Array.from(c.jCompareKeys(s,e)),keys);
  assert.equal(c.view.jTab,"exam");assert.equal(c.jState(s).exams.length,1);assert.equal(c.saveCount,1);
  assert.ok(!main().includes("합성 원본 시험 기준 후보"));
  assert.match(main(),/id="je_label"[^>]*value=""/);
  const selected=main().match(/<select id="j_exam"[\s\S]*?<\/select>/)[0];
  assert.ok(!/<option[^>]*\bselected\b/.test(selected));
  c.jChooseExam(e.id);c.view.jTab="candidates";c.render();assert.match(main(),/비교 선택 1\/6/);
});

test("comparison selections isolate student, year and exam, survive navigation, and do not save or edit plans",()=>{
  const notes=Array.from({length:7},(_,i)=>rule({major:"합성학과 "+i})),{c,s,main}=fixture(notes);
  const first=c.jSaveExam(s,exam()),second=c.jSaveExam(s,exam({label:"다른 시험"}));
  const other={id:"other",name:"합성 다른 학생",consult:{}};c.db.students.push(other);
  const otherExam=c.jSaveExam(other,exam());c.jChooseExam(first.id);c.view.jTab="candidates";c.render();
  const before=JSON.stringify(c.db),saves=c.saveCount,history=JSON.stringify(c.jState(s).history);
  for(let i=0;i<7;i++)c.jToggleCompare(i,true);
  assert.equal(c.jCompareKeys(s,first).length,6);assert.match(main(),/비교 선택 6\/6/);
  c.jToggleCompare(0,true);assert.equal(c.jCompareKeys(s,first).length,6);
  c.jToggleCompare(0,false);assert.equal(c.jCompareKeys(s,first).length,5);
  assert.equal(JSON.stringify(c.db),before);assert.equal(c.saveCount,saves);
  c.jChooseExam(second.id);c.view.jTab="candidates";c.render();assert.match(main(),/비교 선택 0\/6/);
  c.jToggleCompare(1,true);assert.equal(c.jCompareKeys(s,second).length,1);
  c.jChooseStudent(other.id);c.view.jTab="candidates";c.render();assert.match(main(),/비교 선택 0\/6/);
  c.jToggleCompare(2,true);assert.equal(c.jCompareKeys(other,otherExam).length,1);
  c.jChooseStudent(s.id);c.jChooseExam(first.id);c.view.jTab="candidates";c.render();assert.match(main(),/비교 선택 5\/6/);
  c.go=()=>c.render();c.openJeongsi(s.id);c.view.jTab="candidates";c.render();assert.match(main(),/비교 선택 5\/6/);
  assert.equal(c.jCompareKeys(s,{...first,admissionYear:"2028"}).length,0);
  c.jClearCompare();assert.equal(c.jCompareKeys(s,first).length,0);
  assert.equal(c.jCompareKeys(s,second).length,1);assert.equal(c.jCompareKeys(other,otherExam).length,1);
  assert.match(main(),/새로고침하면 초기화/);
  assert.equal(c.jState(s).plans.length,0);assert.equal(JSON.stringify(c.jState(s).history),history);
});
test("summary and plan details keep the used exam snapshot and mark subsequent exam changes",()=>{
  const n=rule({},{englishMode:"table",englishTable:[0,0,-1,-2,-3,-4,-5,-6,-7]}),{c,s}=fixture([n]),e=c.jSaveExam(s,exam()),p=plan(c,s,e,n);
  const edited=c.jSaveExam(s,{...plain(e),label:"수정된 현재 시험",scores:{...plain(e.scores),kor:{subject:"가상 국어",percentile:100}}});
  const text=c.jSummaryText(s),saved=c.jSnapshotText(p);
  assert.ok(text.includes("[근거 변경 — 재확인 필요]"));assert.ok(text.includes("수정된 현재 시험"));
  assert.ok(saved.includes("합성 원본 시험"));assert.ok(!saved.includes("수정된 현재 시험"));
  assert.ok(saved.includes("84 · 입력 반영식 참고점수"));assert.equal(p.examSnapshot.scores.kor.percentile,80);
  assert.ok(saved.includes("백분위 80"));assert.ok(saved.includes("국어 40% / 수학 40% / 탐구 20%"));
  assert.ok(saved.includes("1~9등급 가감점: 0, 0, -1, -2, -3, -4, -5, -6, -7"));
  const rendered=c.jRenderPlans(s,edited);assert.ok(rendered.includes("근거 변경 · 재확인 필요"));
  assert.ok(rendered.includes("합성 원본 시험"));assert.ok(rendered.includes("백분위 80"));
});
test("summary excludes other exams and years and does not read inferred grades",()=>{
  const n=rule(),{c,s}=fixture([n]),e=c.jSaveExam(s,exam());plan(c,s,e,n);
  const next=c.jSaveExam(s,exam({label:"다음년도 비선택 시험",admissionYear:"2028"}));
  plan(c,s,next,rule({univ:"다음년도 비선택 대학",admissionYear:"2028"}));
  c.jState(s).examId=e.id;c.jState(s).admissionYear=e.admissionYear;
  for(const key of ["grades","gradeAverage","mockRef","ipsiMyPct","mkPct"])
    Object.defineProperty(s,key,{get(){throw Error("추정·수시 성적을 읽으면 안 됨: "+key);}});
  Object.defineProperty(s.consult,"susi",{get(){throw Error("수시 상담을 읽으면 안 됨");}});
  const text=c.jSummaryText(s);assert.ok(text.includes("합성 원본 시험"));
  assert.ok(!text.includes("다음년도 비선택"));assert.ok(text.includes("내신 추정치를 사용하지 않음"));
});
test("changing the matching rule marks a stored summary stale without changing its result",()=>{
  const n=rule(),{c,s}=fixture([n]),e=c.jSaveExam(s,exam()),p=plan(c,s,e,n);
  c.db.adiga[0]=rule({content:"변경된 원문 조건"},{weights:{kor:50,math:30,inq:20}});
  assert.ok(c.jSummaryText(s).includes("[근거 변경 — 재확인 필요]"));
  assert.ok(c.jSnapshotText(p).includes("합성 반영식 설명"));assert.equal(p.resultSnapshot.score,84);
});
test("zero scores and missing values remain distinct in rows, forms and calculated candidate labels",()=>{
  const n=rule({},{weights:{kor:100,math:0,inq:0}}),{c,s}=fixture([n]);
  const e=c.jSaveExam(s,exam({scores:{kor:{subject:"가상 국어",raw:0,standard:"",percentile:0,grade:""}}}));
  assert.equal(c.jScoreText({score:0}),"0 · 입력 반영식 참고점수");assert.equal(c.jScoreText({score:null}),"계산 보류");
  assert.ok(c.jScoreRows(e).includes("원점수 0 / 표준 미입력 / 백분위 0 / 등급 미입력"));
  const form=c.jRenderExam(s,e);assert.match(form,/id="je_kor_percentile"[^>]*value="0"/);
  assert.match(form,/id="je_kor_standard"[^>]*value=""/);
  assert.ok(c.jRenderCandidates(e).includes("0 · 입력 반영식 참고점수"));
});
test("historical DB percentile zero is displayed as zero rather than unknown",()=>{
  for(const [pct,expected] of [[0,"0"],["","미확인"],[null,"미확인"],[undefined,"미확인"]]){
    const n=rule(),{c,s}=fixture([n],[{univ:n.univ,major:n.major,track:n.track,year:2026,pct}]);
    const e=c.jSaveExam(s,exam());assert.ok(c.jRenderCandidates(e).includes("발표 백분위 "+expected));
  }
});
test("malicious labels and memo values are escaped across exam, rule, candidates, plans and history",()=>{
  const payload='\"><img src=x onerror=alert(1)> & <script>bad()</script>';
  const n=rule({univ:"가상대"+payload,major:payload,track:"수능 "+payload,content:payload,source:payload});
  const {c,s,main}=fixture([n]);s.name=payload;s.grade=payload;
  const e=c.jSaveExam(s,exam({label:payload,source:payload})),p=plan(c,s,e,n);
  c.jSetPlan(s,p.id,{status:"제외",reason:payload},n);c.view.jRuleDraft=plain(n);
  const outputs=[c.jRenderExam(s,e),c.jRenderRule(),c.jRenderCandidates(e),c.jRenderPlans(s,e)];
  c.renderJeongsi();outputs.push(main());
  for(const rendered of outputs){assert.ok(!rendered.includes("<img"));assert.ok(!rendered.includes("<script>bad()"));
    assert.ok(rendered.includes("&lt;img"));assert.ok(rendered.includes("&amp;"));}
});
