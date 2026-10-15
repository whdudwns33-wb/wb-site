import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Synthetic records only; the app's private seed and bulk files are never loaded.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){
  const a=html.indexOf(start),b=html.indexOf(end,a);
  assert.ok(a>=0&&b>a,`Missing source section: ${start}`);
  return html.slice(a,b);
}
const source=[html.match(/^const esc=.*$/m)[0],html.match(/^function uniNorm.*$/m)[0],
  section("const ADIGA_FIELDS=","/* ═══════════ 프롬프트 조립기"),
  section("function copyAdmStrategy(){","function renderLab(){")].join("\n");
function fixture(notes=[],student={}){
  const elements=new Map(),ctx={URL,db:{adiga:notes,students:[]},view:{},saved:0,copied:"",
    today:()=>"2026-10-15",stu:()=>student,stuContext:()=>"합성 학생 정보",
    susiSummaryText:()=>"내신: 9등급제 2.3 / 근거: 합성 성적표 / 지원안 상태: 준비",
    toast:()=>{},save:()=>ctx.saved++,copy:text=>ctx.copied=text,
    $:selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:"",textContent:"",attributes:{},
      setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},focus(){this.focused=true;}});
      return elements.get(selector);}};
  vm.createContext(ctx);vm.runInContext(source,ctx);return ctx;
}
const note=(extra={})=>({univ:"가상대학교",major:"가상학과",track:"가상전형",admissionYear:"2027",
  resultYear:"2026",source:"합성 원문",checked:"2026-10-14",url:"https://example.org/admission",
  content:"합성 상담 메모",...extra});
const target={univ:"가상대",major:"가상학과",track:"가상전형",admissionYear:"2027"};

test("all inline scripts parse without executing application data",()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test("matching requires exact university, department, track and target admission year",()=>{
  const c=fixture();assert.equal(c.adigaMatches(note(),target),true);
  for(const change of [{univ:"가상대 제2캠퍼스"},{major:"다른학과"},{track:"다른전형"},{admissionYear:"2026"},{admissionYear:""}])
    assert.equal(c.adigaMatches(note(change),target),false);
  assert.equal(c.adigaMatches(note(),{univ:"가상대",admissionYear:"2027"}),false);
  assert.equal(c.adigaMatches(note({major:"",track:""}),target),true);
  assert.equal(c.adigaMatches(null,target),false);
});
test("matching notes rank by specificity then verified date without mutating storage",()=>{
  const common=note({major:"",track:"",checked:"2026-10-15"}),older=note({checked:"2026-10-01"}),
    recent=note({checked:"2026-10-14"}),unverified=note({checked:"not a date"});
  const notes=[common,older,unverified,recent],c=fixture(notes),sorted=c.adigaFor(target);
  assert.equal(sorted[0],recent);assert.equal(sorted[1],older);assert.equal(sorted[2],unverified);assert.equal(sorted[3],common);
  assert.equal(notes[0],common);
});
test("metadata distinguishes admission and results, zero seats and unknown verification",()=>{
  const c=fixture(),text=c.adigaMetaText(note({seats:0,gradeScale:"9",source:"",checked:"",date:"2020-01-01",
    kind:"교과",eligibility:"확인 필요",evaluation:"합성 반영방법",minimum:"미적용 확인"}));
  for(const value of ["모집학년도: 2027","입결 결과학년도: 2026","출처: 미확인","원문 확인일: 미확인",
    "모집인원: 0","9등급제","전형 유형: 교과","지원자격: 확인 필요","반영·평가방법: 합성 반영방법","수능최저: 미적용 확인"])
    assert.ok(text.includes(value),value);
  assert.ok(!text.includes("2020-01-01"));
});
test("URL boundaries reject executable, credential-bearing and malformed addresses",()=>{
  const c=fixture();
  for(const url of ["javascript:alert(1)","data:text/html,x","//example.org/a","https://user:pass@example.org",
    "https://user@example.org","https://example.org/a b","https://example.org\\@evil.test","https://example.org\n/a","https://"]){
    assert.equal(c.adigaUrl(url),"",url);assert.ok(!c.adigaLinkHtml({url}).includes("<a "),url);
    assert.equal(c.adigaNote(null,note({url})).field,"url");
  }
  assert.equal(c.adigaUrl("https://example.org/a?x=1&y=2"),"https://example.org/a?x=1&y=2");
  const link=c.adigaLinkHtml({url:"http://example.org/a?x=1&y=2"});
  assert.ok(link.includes("&amp;"));assert.ok(link.includes('rel="noopener noreferrer"'));assert.ok(link.includes("원문 열기"));
});
test("new values validate real dates, years and seats while preserving zero",()=>{
  const c=fixture();
  for(const [key,value] of [["admissionYear","27"],["resultYear","2026.5"],["checked","2026-02-29"],
    ["checked","2026-13-01"],["seats","-1"],["seats","1.5"],["gradeScale","7"]])
    assert.equal(c.adigaNote(null,note({[key]:value})).field,key);
  assert.equal(c.adigaDate("2024-02-29"),true);
  assert.equal(c.adigaNote(null,note({seats:0})).note.seats,"0");
  assert.equal(c.adigaNote(null,note({checked:"",source:""})).note.checked,"");
});
test("editing legacy records preserves date, unknown keys and unchanged malformed fields",()=>{
  const c=fixture(),legacy=note({checked:"과거 기록",resultYear:"미상",url:"javascript:legacy()",seats:0,
    date:"2020-01-01",legacy:{untouched:true}}),draft={...legacy,content:"수정 메모"};
  const result=c.adigaNote(legacy,draft);assert.equal(result.error,undefined);
  assert.equal(result.note.date,legacy.date);assert.equal(result.note.legacy,legacy.legacy);
  assert.equal(result.note.checked,"과거 기록");assert.equal(result.note.resultYear,"미상");assert.equal(result.note.seats,0);
  assert.equal(legacy.content,"합성 상담 메모");assert.ok(!c.adigaLinkHtml(result.note).includes("<a "));
  assert.equal(c.adigaNote(legacy,{...draft,checked:"bad new date"}).field,"checked");
});
test("note edit uses existing save flow and an invalid draft does not write",()=>{
  const old=note({date:"2020-01-01",unknown:"keep"}),c=fixture([old]);c.openAdiga(0);
  c.view.adigaDraft.source="수정 출처";c.view.adigaDraft.checked="2026-10-15";c.addAdiga();
  assert.equal(c.saved,1);assert.equal(c.db.adiga.length,1);assert.equal(c.db.adiga[0].unknown,"keep");
  assert.equal(c.db.adiga[0].date,"2020-01-01");assert.equal(c.db.adiga[0].source,"수정 출처");
  c.view.adigaDraft=note({url:"javascript:bad()"});c.addAdiga();
  assert.equal(c.saved,1);assert.equal(c.db.adiga.length,1);assert.equal(c.$("#ad_url").attributes["aria-invalid"],"true");
  assert.ok(c.$("#adiga_error").textContent.includes("http"));
});
test("candidate draft creates a new note even after another note was open for edit",()=>{
  const old=note(),c=fixture([old]);c.openAdiga(0);
  c.view.adigaDraft=note({major:"새학과",content:"새 메모"});c.renderAdiga();c.addAdiga();
  assert.equal(c.db.adiga.length,2);assert.equal(c.db.adiga[1],old);assert.equal(c.db.adiga[0].major,"새학과");
  assert.equal(c.saved,1);
});
test("render keeps explicit field labels, unknown metadata and safe links",()=>{
  const c=fixture([note({source:"",checked:"",url:"javascript:bad()",content:"<img src=x>"})]);c.renderAdiga();
  const rendered=c.$("#main").innerHTML;
  assert.ok(rendered.includes('label for="ad_admissionYear"'));assert.ok(rendered.includes('role="alert"'));
  assert.ok(rendered.includes("출처 미확인"));assert.ok(rendered.includes("&lt;img src=x&gt;"));
  assert.ok(!rendered.includes('href="javascript:'));assert.ok(!rendered.includes("copyAdigaCollect"));
});
test("strategy includes current-year support-card notes and excludes cross-year and cross-major notes",()=>{
  const student={name:"합성 학생",grade:"고3",consult:{susi:{admissionYear:"2027"}},
    univs:[{univ:"가상대",major:"가상학과",track:"가상전형"}],
    apply:[{univ:"새대학교",major:"새학과",track:"새전형",admissionYear:"2027"}]};
  const c=fixture([note({content:"현재년도메모"}),note({admissionYear:"2026",content:"제외이전년도"}),
    note({major:"다른학과",content:"제외다른학과"}),note({univ:"새대",major:"새학과",track:"새전형",content:"지원카드메모"})],student);
  c.copyAdmStrategy();assert.ok(c.copied.includes("현재년도메모"));assert.ok(c.copied.includes("지원카드메모"));
  assert.ok(c.copied.includes("[저장된 수시상담]"));assert.ok(c.copied.includes("9등급제 2.3"));
  assert.ok(c.copied.includes("출처: 합성 원문"));assert.ok(!c.copied.includes("제외이전년도"));assert.ok(!c.copied.includes("제외다른학과"));
});
test("strategy with no selected admission year does not pick dated or undated notes",()=>{
  const c=fixture([note({content:"연도있는자동메모"}),note({admissionYear:"",content:"연도없는자동메모"})],
    {name:"합성 학생",grade:"고3",univs:[{univ:"가상대",major:"가상학과",track:"가상전형"}]});
  c.copyAdmStrategy();assert.ok(c.copied.includes("모집학년도 미설정"));
  assert.ok(!c.copied.includes("연도있는자동메모"));assert.ok(!c.copied.includes("연도없는자동메모"));
});
