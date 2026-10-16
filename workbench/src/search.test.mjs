import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Public application functions with synthetic records only; no private files or browser storage.
const html=readFileSync(new URL("./app.html",import.meta.url),"utf8");
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const source=[html.match(/^const esc=.*$/m)[0],html.match(/^const jCopy=.*$/m)[0],
  section("function allIpRows(){","/* 진학 실적 요약 문자열"),
  section("const CUM9=","function classify("),html.match(/^function parseCut.*$/m)[0],
  section("function searchOpenUniv(","/* ═══════════ 진학 가능권"),
  section("function ipDetail(key){","/* 진학사식 반원 게이지"),
  section("function susiCut(r){","function susiAssess(")].join("\n");
const plain=value=>JSON.parse(JSON.stringify(value));
const row=(extra={})=>({univ:"합성대학교",major:"합성학과",track:"교과 일반",year:"2026",cut50:"3.2",cut70:"",rate:"0",region:"합성지역",pct:"",source:"합성 원문",...extra});
function fixture(rows=[],schools=[]){
  const elements=new Map(),c={db:{},BULK:{ip:[],hs:schools},view:{},window:{__bulkStatus:"done"},saved:0,renders:0,
    save(){c.saved++;vm.runInContext("_IPG=null",c);},render(){c.renders++;c.renderSearch();},toast(message){c.message=message;},hsMetHtml:()=>"",
    modal(markup){c.modalHtml=markup;},closeModal(){},go(page){c.view.page=page;},
    $:selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:"",value:""});return elements.get(selector);}};
  vm.createContext(c);vm.runInContext(source,c);
  const all=c.allIpRows;c.allIpRows=()=>all().concat(rows);
  return {c,rows,main:()=>c.$("#main").innerHTML};
}
function showUniversity(c,univ="합성대학교"){c.view.sUniv=c.uniNorm(univ);c.renderSearch();}
const decode=value=>value.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
function event(c,code,value=""){
  c.syntheticValue=value;vm.runInContext("(function(){"+decode(code)+"}).call({value:syntheticValue})",c);delete c.syntheticValue;
}
function inputQuery(c,markup,value){const code=markup.match(/id="sq"[^>]*oninput="([^"]+)"/)?.[1];assert.ok(code);event(c,code,value);}

test("search DB addition preserves the original 50-percent metric, provenance, zero values and unknown fields",()=>{
  const original=row({url:"https://example.org/synthetic",checked:"2026-10-16",gradeScale:"9",pct:0,rate:0,extra:{flags:["preserve"]},bulk:true});
  const before=JSON.stringify(original),{c,main}=fixture([original]);showUniversity(c);
  event(c,main().match(/onclick="(addBulkToIpdb\(0\))"/)[1]);
  assert.equal(c.saved,1);assert.equal(c.db.ipdb.length,1);
  const copied=c.db.ipdb[0],expected=plain(original);delete expected.bulk;
  assert.deepEqual(plain(copied),expected);assert.equal(c.susiCut(copied).metric,"50%컷");
  copied.extra.flags.push("copy only");assert.equal(JSON.stringify(original),before);
});

test("source lookup follows the displayed year and contributing record instead of combining separate rows",()=>{
  const ignored=row({year:"2026",cut50:"",cut70:"",source:"no grade"}),chosen=row({year:"2026",cut50:"2.9",cut70:"3.4",source:"chosen original",url:"https://example.org/chosen"});
  const {c}=fixture([row({year:"2025",cut50:"1.5"}),ignored,chosen]);showUniversity(c);c.addBulkToIpdb(0);
  assert.deepEqual(plain(c.db.ipdb[0]),chosen);assert.equal(c.susiCut(c.db.ipdb[0]).metric,"70%컷");
});

test("regular-admission addition preserves the percentile year and original fields",()=>{
  const chosen=row({track:"수능 일반",year:"2027",cut50:"",cut70:"",pct:"91.5",rate:0,source:"percentile original"});
  const {c}=fixture([row({track:"수능 일반",year:"2026",cut70:"3.1"}),chosen]);showUniversity(c);c.addBulkToIpdb(0);
  assert.deepEqual(plain(c.db.ipdb[0]),chosen);assert.equal(c.db.ipdb[0].pct,"91.5");assert.equal(c.db.ipdb[0].cut70,"");
});

test("a zero-only regular percentile remains searchable and copyable while empty percentiles remain missing",()=>{
  for(const pct of [0,"0"]){
    const {c,main}=fixture();c.BULK.ip.push(["합성대학교","합성학과","수능 일반",2026,"","",0,"합성지역",pct]);
    c.renderSearch();assert.equal(c.view.sUnivShown.length,1);c.searchOpenUniv(0);
    assert.match(main(),/백분위 0/);assert.equal(c.ipGroups()[0].pct,0);c.addBulkToIpdb(0);
    assert.equal(c.db.ipdb[0].pct,pct);assert.equal(c.db.ipdb[0].cut70,"");assert.equal(c.saved,1);
  }
  for(const pct of ["",null,undefined]){
    const {c}=fixture([row({track:"수능 일반",cut50:"",cut70:"",pct})]);c.renderSearch();
    assert.equal(c.ipGroups()[0].pct,null);assert.equal(c.view.sUnivShown.length,0);assert.equal(c.saved,0);
  }
});

test("repeated additions and existing manual records never overwrite original notes or metadata",()=>{
  const original=row({extra:{memo:"original manual note"}}),{c}=fixture([original]);showUniversity(c);c.addBulkToIpdb(0);
  c.db.ipdb[0].extra.memo="director edit";const before=JSON.stringify(c.db);c.addBulkToIpdb(0);
  assert.equal(c.saved,1);assert.equal(JSON.stringify(c.db),before);assert.match(c.message,/기존 입력은 유지/);
});

test("invalid or disappeared selections do not create an empty database or write partial records",()=>{
  const {c,rows}=fixture([row()]);showUniversity(c);const before=JSON.stringify(c.db);
  c.addBulkToIpdb(999);rows.length=0;c.addBulkToIpdb(0);
  assert.equal(c.saved,0);assert.equal(JSON.stringify(c.db),before);assert.match(c.message,/원본 입결/);
});

test("quoted and hostile university, department and track labels remain text through all search actions",()=>{
  const original=row({univ:"합성'대 <img src=x onerror=bad()>",major:'합성"학과',track:"교과 '전형"}),{c,main}=fixture([original]);
  c.renderSearch();assert.ok(!main().includes("<img src=x"));
  event(c,main().match(/onclick="(searchOpenUniv\(0\))"/)[1]);assert.equal(c.view.sUniv,original.univ);
  event(c,main().match(/onclick="(searchToggleGroup\(0\))"/)[1]);assert.equal(c.view.sKey,c.view.sGroupsShown[0].key);
  event(c,main().match(/onclick="(addBulkToIpdb\(0\))"/)[1]);assert.deepEqual(plain(c.db.ipdb[0]),original);
  for(const match of main().matchAll(/\bon(?:click|change|input|submit)="([^"]*)"/g))new vm.Script(decode(match[1]));
});

test("school search uses indexes for quoted names and avoids duplicate additions",()=>{
  const name="합성'고 <img src=x onerror=bad()>",{c,main}=fixture([],[[name,"일반고","합성'지역","합성구","공립",""]]);
  c.view.searchTab="hs";c.renderSearch();assert.ok(!main().includes("<img src=x"));
  event(c,main().match(/onclick="(addBulkToHsdb\(0\))"/)[1]);assert.equal(c.db.hsdb[0].name,name);assert.equal(c.db.hsdb[0].region,"합성'지역 합성구");
  const before=JSON.stringify(c.db);c.addBulkToHsdb(0);assert.equal(JSON.stringify(c.db),before);assert.equal(c.saved,1);
});

test("typed university queries survive track and region filters and reset pagination",()=>{
  const {c,main}=fixture([row(),row({univ:"다른대학교",major:"다른학과"})]);c.view.sUPage=3;c.view.sDPage=2;c.renderSearch();
  inputQuery(c,main(),"합성학과");assert.equal(c.view.sUPage,0);assert.equal(c.view.sDPage,0);
  event(c,main().match(/onclick="(view\.sTrack='교과';[^"]+)"/)[1]);
  assert.match(main(),/id="sq" value="합성학과"/);assert.equal(c.view.sUnivShown.length,1);
  event(c,main().match(/onchange="(view\.sRegion=[^"]+)"/)[1],"합성지역");
  assert.match(main(),/id="sq" value="합성학과"/);assert.equal(c.view.sUnivShown[0],"합성대");assert.equal(c.saved,0);
});

test("typed school queries survive school-level and regional filter changes",()=>{
  const {c,main}=fixture([],[["합성고","일반고","합성도","합성구","공립",""]]);c.view.searchTab="hs";c.renderSearch();
  inputQuery(c,main(),"합성");event(c,main().match(/onchange="(view\.sLevel=[^"]+)"/)[1],"고");
  event(c,main().match(/onchange="(view\.sSido=[^"]+)"/)[1],"합성도");
  assert.match(main(),/id="sq" value="합성"/);assert.equal(c.view.sHsShown.length,1);assert.equal(c.saved,0);
});

test("paginated department indexes copy the visible row and a tab change clears stale indexes",()=>{
  const rows=Array.from({length:125},(_,i)=>row({major:"합성학과"+String(i).padStart(3,"0")})),{c}=fixture(rows);
  c.view.sDPage=1;showUniversity(c);assert.equal(c.view.sGroupsShown.length,5);const selected=c.view.sGroupsShown[0].major;
  c.addBulkToIpdb(0);assert.equal(c.db.ipdb[0].major,selected);assert.equal(selected,"합성학과120");
  c.view.searchTab="hs";c.renderSearch();const before=JSON.stringify(c.db);c.addBulkToIpdb(0);
  assert.equal(JSON.stringify(c.db),before);assert.equal(c.saved,1);
});

test("detail keeps a 50-percent-only result out of the 70-percent column without changing shared calculations",()=>{
  const {c}=fixture([row()]),group=c.ipGroups()[0],before=JSON.stringify(group);
  assert.equal(group.years["2026"],3.2);c.ipDetail(group.key);
  assert.match(c.modalHtml,/<td>2026<\/td><td>—<\/td>\s*<td>3\.2<\/td>/);
  assert.ok(c.modalHtml.includes("50%컷을 70%컷으로 대체하지 않습니다"));
  assert.equal(JSON.stringify(group),before);assert.equal(c.saved,0);
});

test("detail displays each original metric including zero and missing values rather than a derived fallback",()=>{
  const rows=[row({year:"2025",cut50:"2.70",cut70:"3.40",pct:"",rate:0}),row({year:"2026",cut50:"",cut70:"",pct:0,rate:""})];
  const {c}=fixture(rows),before=JSON.stringify(rows);c.ipDetail(c.ipGroups()[0].key);
  assert.match(c.modalHtml,/<td>2025<\/td><td>3\.40<\/td>\s*<td>2\.70<\/td><td>—<\/td><td>0<\/td>/);
  assert.match(c.modalHtml,/<td>2026<\/td><td>—<\/td>\s*<td>—<\/td><td>0<\/td><td>—<\/td>/);
  assert.equal(JSON.stringify(rows),before);assert.equal(c.saved,0);
});

test("detail navigation safely carries quoted labels back to search and mock applications",()=>{
  const original=row({univ:"합성'대",major:'합성"학과',year:'2026<img src=x onerror=bad()>'}),{c}=fixture([original]);
  c.ipDetail(c.ipGroups()[0].key);assert.ok(!c.modalHtml.includes("<img src=x"));
  const handlers=[...c.modalHtml.matchAll(/onclick="([^"]+)"/g)].map(x=>x[1]);
  event(c,handlers.find(x=>x.includes("view.mkSel=")));assert.equal(c.view.mkSel,original.univ+"|"+original.major);assert.equal(c.view.page,"mock");
  event(c,handlers.find(x=>x.includes("view.sUniv=")));assert.equal(c.view.sUniv,original.univ);assert.equal(c.view.page,"search");
  assert.equal(c.saved,0);
});
