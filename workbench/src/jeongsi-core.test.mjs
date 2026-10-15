import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Only synthetic public-source fixtures; no private seed, bulk data, browser or network.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const c=vm.createContext({URL});
vm.runInContext(section("const ADIGA_FIELDS=","function renderAdiga(){")+"\n"+
  section("// JEONGSI_CORE_START","// JEONGSI_CORE_END"),c);
function exam(extra={}){
  return {id:"synthetic-exam",revision:"rev-one",label:"합성 수능 시험",type:"수능",admissionYear:"2027",
    date:"2026-11-19",status:"확정",source:"합성 성적표",checked:"2026-12-10",
    scores:{kor:{subject:"화법과 작문",percentile:80,standard:120},math:{subject:"미적분",percentile:90,standard:130},
      inq1:{subject:"가상 탐구 A",percentile:70,standard:60},inq2:{subject:"가상 탐구 B",percentile:90,standard:70},
      eng:{subject:"영어",grade:2},hist:{subject:"한국사",grade:3}},...extra};
}
function rule(extra={},regular={}){
  return {univ:"가상대학교",major:"가상학과",track:"수능 일반전형",admissionYear:"2027",source:"합성 모집요강",
    url:"https://example.org/synthetic",checked:"2026-10-15",content:"합성 반영방법: 가중합 뒤 영어·한국사 가감점 합산",
    regular:{group:"가",mode:"weighted",metric:"percentile",weights:{kor:40,math:40,inq:20},inquiry:"mean2",
      englishMode:"table",historyMode:"table",englishTable:[0,-1,-2,-3,-4,-5,-6,-7,-8],
      historyTable:"0,0,-2,-3,-4,-5,-6,-7,-8",unsupported:"",...regular},...extra};
}
function blocked(e,n,text){const r=c.jCalc(e,n);assert.equal(r.score,null);assert.equal(r.parts.length,0);
  if(text)assert.ok(r.missing.some(x=>x.includes(text)),r.missing.join(" / "));return r;}

test("all app inline scripts parse without executing data",()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test("exam normalization preserves blanks, zero and exact identity tokens without deriving scores",()=>{
  const input=exam();input.scores.kor={subject:" 화법과 작문 ",raw:"0",standard:" ",percentile:"0",grade:""};
  const before=JSON.stringify(input),e=c.jExam(input);
  assert.equal(e.id,input.id);assert.equal(e.revision,"rev-one");assert.equal(e.scores.kor.raw,0);
  assert.equal(e.scores.kor.percentile,0);assert.equal(e.scores.kor.standard,"");assert.equal(e.scores.kor.grade,"");
  assert.equal(e.scores.kor.subject,"화법과 작문");assert.equal(JSON.stringify(input),before);
  assert.equal(c.jExam(exam({revision:2})).revision,2);
});
test("exam metadata rejects derived types and invalid dates or statuses",()=>{
  for(const change of [{label:""},{type:"내신 추정"},{admissionYear:"27"},{date:"2026-02-29"},
    {date:""},{status:"예측"},{checked:"2026-13-01"}])assert.throws(()=>c.jExam(exam(change)));
  const e=c.jExam(exam({source:"",checked:"",date:"2024-02-29"}));assert.equal(e.source,"");assert.equal(e.checked,"");
});
test("score boundaries reject nonnumeric, out of range and fractional grades",()=>{
  for(const [key,value] of [["raw",-1],["raw",101],["standard",1001],["percentile",101],
    ["percentile","0x10"],["standard","Infinity"],["grade",0],["grade",10],["grade",1.5]]){
    const e=exam();e.scores.kor[key]=value;assert.throws(()=>c.jExam(e),key+" "+value);
  }
  const e=exam();e.scores.kor={subject:"상한 테스트",raw:100,standard:1000,percentile:100,grade:9};
  assert.equal(c.jExam(e).scores.kor.standard,1000);
});
test("rule normalization retains old metadata and unknown keys, and parses signed tables",()=>{
  const input=rule({date:"2020-01-01",unknown:{keep:true}}, {englishTable:"0,-1,+2,0,0,0,0,0,0"});
  const before=JSON.stringify(input),n=c.jRule(input);
  assert.equal(n.date,"2020-01-01");assert.equal(n.unknown,input.unknown);assert.equal(n.regular.englishTable[2],2);
  assert.equal(n.regular.historyTable[2],-2);assert.equal(JSON.stringify(input),before);
});
test("weighted rule requires group, one metric, explicit weights summing to 100 and supported modes",()=>{
  for(const regular of [{group:"라"},{metric:"mixed"},{inquiry:"sum2"},{weights:{kor:40,math:40,inq:10}},
    {weights:{kor:50,math:50,inq:""}},{weights:{kor:-1,math:101,inq:0}},{englishMode:"weighted"}])
    assert.throws(()=>c.jRule(rule({},regular)));
  for(const extra of [{major:""},{track:""},{admissionYear:"1999"},{url:"javascript:bad()"},{checked:"2026-02-29"}])
    assert.throws(()=>c.jRule(rule(extra)));
});
test("grade tables require nine populated finite numbers, including sparse arrays",()=>{
  for(const englishTable of [[],[0,0],"0,0,0,0,0,0,0,0,",[0,0,0,0,0,0,0,0,Infinity],new Array(9)])
    assert.throws(()=>c.jRule(rule({},{englishTable})));
  assert.equal(c.jRule(rule({},{englishTable:Array(9).fill(0)})).regular.englishTable[8],0);
});
test("mean-two and best-one use the selected metric, then add signed grade adjustments",()=>{
  const mean=c.jCalc(exam(),rule()),best=c.jCalc(exam(),rule({},{inquiry:"best1"}));
  assert.equal(mean.score,81);assert.equal(best.score,83);assert.equal(mean.missing.length,0);
  assert.ok(mean.parts.some(p=>p.includes("영어 2등급 가감점 -1")));
  assert.ok(mean.parts.some(p=>p.includes("한국사 3등급 가감점 -2")));
  assert.ok(mean.formula.includes("2과목 평균"));assert.ok(mean.limitations.some(p=>p.includes("입력 반영식 참고점수")));
  const standard=c.jCalc(exam(),rule({},{metric:"standard"}));assert.equal(standard.score,110);
});
test("zero scores and explicit zero adjustments remain calculable",()=>{
  const e=exam();for(const key of ["kor","math","inq1","inq2"])e.scores[key].percentile=0;
  const n=rule({},{englishTable:Array(9).fill(0),historyTable:Array(9).fill(0)}),r=c.jCalc(e,n);
  assert.equal(r.score,0);assert.equal(r.missing.length,0);assert.ok(r.parts.some(p=>p.includes("가감점 +0")));
});
test("missing score never falls back to standard score, raw score or grades",()=>{
  const e=exam();e.scores.kor={subject:"화법과 작문",raw:99,standard:140,grade:1};blocked(e,rule(),"국어 백분위");
  const other=exam();other.scores.kor.standard="";blocked(other,rule({},{metric:"standard"}),"국어 표준점수");
});
test("both named inquiry results are required even for best-one; zero-weight subjects are ignored",()=>{
  const e=exam();e.scores.inq2.percentile="";blocked(e,rule({},{inquiry:"best1"}),"탐구2 백분위");
  e.scores.inq2.percentile=90;e.scores.inq1.subject="";blocked(e,rule(),"탐구1 선택과목명");
  e.scores.inq1.subject=e.scores.inq2.subject;blocked(e,rule(),"과목명이 같습니다");
  const sparse=exam({scores:{kor:{subject:"화법과 작문",percentile:80}}});
  const r=c.jCalc(sparse,rule({},{weights:{kor:100,math:0,inq:0},englishMode:"none",historyMode:"none"}));
  assert.equal(r.score,80);
});
test("missing or invalid provenance and different admission years block calculation",()=>{
  for(const extra of [{source:""},{checked:""},{admissionYear:"2026"}])blocked(exam(extra),rule());
  for(const extra of [{source:""},{checked:""},{url:""},{url:"https://user:pass@example.org"},{checked:"bad-date"}])
    blocked(exam(),rule(extra));
});
test("unknown English or history treatment, missing grade, manual mode and unsupported formulas block all results",()=>{
  for(const regular of [{englishMode:"unknown"},{historyMode:"unknown"},{mode:"manual"},
    {unsupported:"선택과목 5% 가산"},{unsupported:"변환표준점수 적용"}])blocked(exam(),rule({},regular));
  const e=exam();e.scores.eng.grade="";blocked(e,rule(),"영어 등급");
  const h=exam();h.scores.hist.grade="";blocked(h,rule(),"한국사 등급");
  const manual=c.jRule(rule({}, {mode:"manual",weights:{kor:"",math:"",inq:""},metric:"",inquiry:""}));
  assert.equal(manual.regular.weights.kor,"");blocked(exam(),manual,"수동 확인");
});
test("preliminary and mock results retain explicit limits and never become admission predictions",()=>{
  const r=c.jCalc(exam({type:"모평",status:"가채점"}),rule());assert.equal(r.score,81);
  assert.ok(r.limitations.some(x=>x.includes("가채점")));assert.ok(r.limitations.some(x=>x.includes("실제 수능 결과가 아닙니다")));
  assert.ok(r.limitations.some(x=>x.includes("내신 등급에서 환산하지 않습니다")));
});
test("invalid input and unsafe arithmetic return missing reasons without partial scores",()=>{
  blocked(null,null);blocked(exam(),rule({},{englishTable:Array(9).fill(Number.MAX_SAFE_INTEGER),historyTable:Array(9).fill(Number.MAX_SAFE_INTEGER)}),"수치 범위");
});
