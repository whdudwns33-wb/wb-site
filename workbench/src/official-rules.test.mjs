import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Read-only audit, checked 2026-10-27. Published examples are not 2027 student scores.
// JBNU 2027 regular guide, printed pp.40–46 (PDF pp.42–48):
// https://enter.jbnu.ac.kr (2026-09-01 regular admission guide).
// JBNU 2027 early guide, p.53: https://enter.jbnu.ac.kr (2026-08-13 revision).
// DNUE 2027 regular guide, p.12 (PDF p.16):
// https://dnue.ac.kr/ipsi/CMS/Board/Board.do?board_seq=18732&mCode=MN029&mgr_seq=273&mode=view
// Chosun 2027 university-submitted disclosure (final guide still needs checking):
// https://www.adiga.kr/ucp/uvt/uni/univDetailSelection.do?menuId=PCUVTINF2000&searchSyr=2027&unvCd=0000172
const html=readFileSync(new URL('./app.html',import.meta.url),'utf8');
const section=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);};
let auditDate='2026-12-15';
const c=vm.createContext({URL,today:()=>auditDate});
vm.runInContext([html.match(/^function uniNorm.*$/m)[0],
  section('const FIELD_KW=','const SPECIAL_KW='),
  section('const ADIGA_FIELDS=','function renderAdiga(){'),
  section('const APL_KINDS=','/* ═══════════ 월간 캘린더'),
  section('function susiKey(','function susiStudent('),
  section('// JEONGSI_CORE_START','// JEONGSI_CORE_END')].join('\n'),c);
const round=value=>Math.round((value+Number.EPSILON)*100)/100;
const exam=()=>({label:'공개 산식 검증용 합성 성적',type:'수능',admissionYear:'2027',date:'2026-11-19',status:'확정',source:'합성 성적 — 실제 학생 아님',checked:'2026-10-27',
  scores:{kor:{subject:'화법과 작문',standard:104,percentile:80},math:{subject:'확률과 통계',standard:100,percentile:90},
    inq1:{subject:'생활과 윤리',standard:53,percentile:70},inq2:{subject:'사회·문화',standard:57,percentile:90},eng:{subject:'영어',grade:3},hist:{subject:'한국사',grade:2}}});
const rule=(extra={})=>({univ:'전북대학교',major:'인문계열 검증용',track:'수능 일반',admissionYear:'2027',source:'2027학년도 정시 모집요강 p.40–46',url:'https://enter.jbnu.ac.kr/',checked:'2026-10-27',content:'공개 원문 산식의 지원 범위만 확인',
  regular:{group:'가',mode:'weighted',metric:'standard',weights:{kor:40,math:30,inq:30},inquiry:'mean2',englishMode:'table',historyMode:'table',englishTable:[30,27,24,18,12,9,6,3,0],historyTable:[5,5,5,5,5,4,3,2,1],unsupported:'',...extra}});

const examples=[
  ['인문계열',104,1,100,.75,54.352,57.111,1.5,24,5,291.60],
  ['공학계열1',91,.75,104,1,59.2394,68.1615,1.5,27,4,298.80],
  ['수학교육과',120,.75,135,1.25,59.185,66.208,1,27,5,353.45],
  ['과학교육학부',120,.5,135,1,58.750,66.208,2,27,5,351.96],
  ['수의예과',126,.75,128,1,59.427,67.396,1.5,27,5,349.62],
  ['체육교육과',118,2,115,1.5,61.196,64.620,3,18,5,620.22],
  ['스포츠과학과',100,2.4,0,0,48.667,42.194,3.2,14.4,2.4,402.18],
];
for(const [name,k,kWeight,m,mWeight,t1,t2,tWeight,english,history,expected] of examples){
  test(`JBNU published example arithmetic matches: ${name}`,()=>{
    assert.equal(round(k*kWeight+m*mWeight+(t1+t2)/2*tWeight+english+history),expected);
  });
}
test('JBNU percentage-only input is not its official 500-point converted score',()=>{
  assert.equal(round(c.jCalc(exam(),rule()).score),117.10);
  assert.notEqual(round(c.jCalc(exam(),rule()).score),291.60);
  const held=c.jCalc(exam(),rule({mode:'manual',unsupported:'탐구 변환표준점수·모집단위 배율·가산점 배율 미지원'}));
  assert.equal(held.score,null);assert.ok(held.missing.some(x=>x.includes('미지원')));
});
test('DNUE formula requires national maximum standard scores, not raw standard-score weights',()=>{
  // Hypothetical denominator values; not the unpublished 2027 national maxima.
  const reference=120/150*300+130/160*300+60/80*100+65/85*100+195;
  assert.equal(round(reference),830.22);
  const held=c.jCalc(exam(),{...rule({mode:'manual',unsupported:'전국 최고 표준점수 분모·영어 20%·1000점 환산·면접 미지원'}),univ:'대구교육대학교'});
  assert.equal(held.score,null);
});
test('Chosun English weighting cannot be entered as national-language/math/inquiry weights summing to 75',()=>{
  const note={...rule({metric:'percentile',weights:{kor:25,math:30,inq:20},inquiry:'best1'}),univ:'조선대학교'};
  assert.throws(()=>c.jRule(note),/합은 100/);
  note.regular.mode='manual';note.regular.unsupported='영어 25%·800점 환산·응시조건·학폭 감점 확인 필요';
  assert.equal(c.jCalc(exam(),note).score,null);
});
test('same average grade can produce different JBNU school-record scores',()=>{
  // All grade 5 versus equal-credit grades 3 and 7: arithmetic mean is 5 in both.
  assert.equal(round(930+70*7.8/9.8),985.71);
  assert.equal(round(930+70*((8.8+4.6)/2)/9.8),977.86);
  const group={univ:'전북대학교',major:'검증학과',track:'학생부교과',region:'',records:[{year:'2026',cut70:5,gradeScale:'9'}]};
  const p={admissionYear:'2027',gradeScale:'9',gradeAverage:'5',gradeLabel:'합성 단순 평균',kind:'전체',field:'전체',region:'',query:''};
  const result=c.susiAssess(group,p,[]);
  assert.equal(result.diff,0);assert.match(result.comparison,/대학 환산 아님/);
  assert.ok(result.limitations.some(x=>x.includes('자동 적용하지 않음')));
  assert.equal(c.susiAssess(group,{...p,gradeScale:'5'},[]).diff,null);
});
test('JBNU minimum sum supports required math and truncated inquiry but is not a full eligibility check',()=>{
  const condition={status:'present',on:true,areas:['국','수','영','탐'],n:2,sum:8,must:'수',tam:'1',hist:9};
  const grades={국:3,수:4,영:5,탐1:4,탐2:5,한:2};
  assert.equal(c.minCheck(condition,grades).sum,7);
  assert.equal(c.minCheck(condition,{...grades,한:''}).state,'nodata');
  assert.equal(c.aplTam({탐1:2,탐2:3},'2t'),2);
  // Selected subject requirements and science-based threshold relaxation remain manual.
});
function jbnuFixture(index=0){
  const [,k,,m,,t1,t2]=examples[index],profiles=['humanities','natural','mathEducation','scienceEducation','medical','physicalEducation','sports'];
  const profile=profiles[index],science=[1,3,4,6].includes(index),bonus=[1,2,3,4].includes(index);
  const e=exam();e.scores.kor.standard=k;e.scores.math.standard=m;
  e.scores.math.subject=[1,2,3,4].includes(index)?'미적분':'확률과 통계';
  e.scores.eng.grade=[3,2,2,2,2,4,4][index];e.scores.hist.grade=[2,6,3,3,1,1,7][index];
  e.scores.inq1.subject=science?'화학Ⅰ':'생활과 윤리';e.scores.inq2.subject=science||index===2?'생명과학Ⅰ':'사회·문화';
  const n=rule();n.regular={group:index>=5?'나':'가',mode:'jbnu2027',profile,unitConfirmed:true,unsupported:'',
    conversion:{status:'official',admissionYear:'2027',published:'2026-12-14',checked:'2026-12-15',source:'테스트용 가상 미래 표 — 실제 2027 변환표 아님',url:'https://enter.jbnu.ac.kr/test-fixture',bonusApplied:bonus,
      rows:[{subject:e.scores.inq1.subject,kind:science?'과학':'사회',percentile:e.scores.inq1.percentile,value:t1},
        {subject:e.scores.inq2.subject,kind:science||index===2?'과학':'사회',percentile:e.scores.inq2.percentile,value:t2}]}};
  return {e,n};
}
for(let i=0;i<examples.length;i++)test(`JBNU engine matches published example with simulated future table: ${examples[i][0]}`,()=>{
  const {e,n}=jbnuFixture(i),before=JSON.stringify({e,n}),r=c.jCalc(e,n);
  assert.deepEqual(Array.from(r.missing),[]);assert.equal(r.score,examples[i][10]);assert.equal(r.method,'jbnu2027');
  assert.equal(JSON.stringify({e,n}),before);assert.ok(r.parts.some(x=>x.includes('중복 가산'))===false||n.regular.conversion.bonusApplied);
});
test('JBNU unpublished, wrong-year, premature and future-dated tables never calculate or fall back to actual inquiry standard scores',()=>{
  for(const changes of [{status:'unpublished'},{admissionYear:'2026'},{published:'2026-12-10'},{published:'2026-12-16'},
    {checked:''},{checked:'2026-12-13'},{checked:'2026-12-16'},{source:''},{url:'https://example.org/fake'},
    {url:'https://user:pass@enter.jbnu.ac.kr/table'},{rows:[]}] ){
    const {e,n}=jbnuFixture();Object.assign(n.regular.conversion,changes);const result=c.jCalc(e,n);
    assert.equal(result.score,null);assert.equal(result.parts.length,0);assert.ok(result.missing.length>0);
  }
  auditDate='2026-10-27';try{assert.equal(c.jCalc(jbnuFixture().e,jbnuFixture().n).score,null);}finally{auditDate='2026-12-15';}
});
test('JBNU conversion lookup requires exact subject and percentile, rejects duplicate or malformed rows, and preserves zero',()=>{
  for(const field of ['subject','percentile']){const {e,n}=jbnuFixture();e.scores.inq1[field]=field==='subject'?'다른과목':71;assert.equal(c.jCalc(e,n).score,null);}
  for(const rows of ['이름,과학,80','이름,기타,80,60','이름,과학,101,60','이름,과학,80,NaN']){const {n}=jbnuFixture();n.regular.conversion.rows=rows;assert.throws(()=>c.jRule(n));}
  const {e,n}=jbnuFixture();n.regular.conversion.rows.push({...n.regular.conversion.rows[0]});assert.throws(()=>c.jRule(n),/중복/);
  n.regular.conversion.rows.pop();n.regular.conversion.rows[0].value=0;assert.ok(Number.isFinite(c.jCalc(e,n).score));
  n.regular.conversion.rows=n.regular.conversion.rows.map(x=>[x.subject,x.kind,x.percentile,x.value].join(',')).join('\n');assert.ok(Number.isFinite(c.jCalc(e,n).score));
});
test('JBNU science bonus is applied once only and sports grade bonuses scale by 0.8',()=>{
  const {e,n}=jbnuFixture(1),target=c.jCalc(e,n).score;
  n.regular.conversion.bonusApplied=false;for(const row of n.regular.conversion.rows)row.value/=1.1;
  assert.equal(c.jCalc(e,n).score,target);
  n.regular.conversion.bonusApplied=true;assert.notEqual(c.jCalc(e,n).score,target);
  const sports=jbnuFixture(6),r=c.jCalc(sports.e,sports.n);assert.equal(r.score,402.18);assert.ok(r.parts.some(x=>x.includes('14.4')));
  const human=jbnuFixture(0);human.n.regular.conversion.bonusApplied=true;assert.equal(c.jCalc(human.e,human.n).score,null);
});
test('JBNU selection, identity, mandatory grades and selected subjects remain explicit trust boundaries',()=>{
  const {n}=jbnuFixture();for(const changes of [{univ:'다른대학교'},{admissionYear:'2028'}])assert.throws(()=>c.jRule({...n,...changes}));
  for(const changes of [{group:'다'},{profile:'unknown'}])assert.throws(()=>c.jRule({...n,regular:{...n.regular,...changes}}));
  for(const field of ['eng','hist']){const {e,n}=jbnuFixture();e.scores[field].grade='';assert.equal(c.jCalc(e,n).score,null);}
  const unconfirmed=jbnuFixture();unconfirmed.n.regular.unitConfirmed=false;assert.equal(c.jCalc(unconfirmed.e,unconfirmed.n).score,null);
  const medical=jbnuFixture(4);medical.e.scores.math.subject='확률과 통계';assert.equal(c.jCalc(medical.e,medical.n).score,null);
  const science=jbnuFixture(3);science.n.regular.conversion.rows[0].kind='사회';assert.equal(c.jCalc(science.e,science.n).score,null);
  const sports=jbnuFixture(6);sports.e.scores.math={};assert.equal(c.jCalc(sports.e,sports.n).score,402.18);
});
test('JBNU sparse rows, invalid subject categories and ambiguous bonus metadata cannot yield scores',()=>{
  for(const rows of [new Array(2),[null],[[]],[{subject:'생활과 윤리',kind:'과학',percentile:70,value:60}]]){
    const {e,n}=jbnuFixture();n.regular.conversion.rows=rows;assert.equal(c.jCalc(e,n).score,null);assert.throws(()=>c.jRule(n));
  }
  for(const bonusApplied of [undefined,null]){const {e,n}=jbnuFixture();n.regular.conversion.bonusApplied=bonusApplied;assert.equal(c.jCalc(e,n).score,null);}
  const {e,n}=jbnuFixture();n.regular.conversion.bonusApplied='true';assert.equal(c.jCalc(e,n).score,null);
});
