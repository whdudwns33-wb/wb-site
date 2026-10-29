import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Real storage and import functions, synthetic data and no filesystem writes.
const html=readFileSync(new URL('./app.html',import.meta.url),'utf8');
function section(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
const source=[section('function load(){','function stu(){'),
  section('// COURSE_PLAN_CORE_START','// COURSE_PLAN_CORE_END'),
  section('// CARE_CORE_START','// CARE_CORE_END'),
  section('// JEONGSI_CORE_START','// JEONGSI_CORE_END'),section('// JEONGSI_STORE_START','// JEONGSI_STORE_END'),
  section('// REPORT_STORE_START','// REPORT_STORE_END'),section('const ADIGA_FIELDS=','function renderAdiga(){'),
  section('function exportJson(){','/* ═══════════ 렌더 루트'),section('function allIpRows(){','/* 대학·학과·전형 그룹')].join('\n');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
  let id=0;const initial={students:[{id:'one',name:'합성 학생 A',apply:[],consult:{susi:{admissionYear:'2027',gradeScale:'9',gradeAverage:'3'}}}],adiga:[],meta:{}};
  const elements=new Map();const c={db:clone(initial),_savedDb:JSON.stringify(initial),LS:'synthetic',_IPG:null,_MKM:null,BULK:{ip:[]},URL,
    stored:JSON.stringify(initial),fail:false,uid:()=>`new-${++id}`,today:()=>'2026-10-15',toast:m=>c.message=m,
    render(){},renderSide(){},closeModal(){},view:{page:'report'},saveFile:(name,data)=>c.exported=data,
    aplSame:(a,b)=>a.univ===b.univ&&a.major===b.major&&a.track===b.track&&a.admissionYear===b.admissionYear,
    $:key=>{if(!elements.has(key))elements.set(key,{files:[{}],innerHTML:''});return elements.get(key);},
    FileReader:class{readAsText(){this.result=c.imported;this.onload();}},
    localStorage:{getItem:()=>c.stored,setItem:(key,value)=>{if(c.fail)throw Error('synthetic quota');c.stored=value;}}};
  vm.createContext(c);vm.runInContext(source,c);return c;
}

test('failed writes restore the last persisted records and retry does not retain a phantom change',()=>{
  const c=fixture(),before=c.stored;c.db.students[0].consult.susi.gradeAverage='4';c.fail=true;
  assert.throws(()=>c.save(),/기기 저장/);assert.equal(c.stored,before);assert.equal(JSON.stringify(c.db),before);
  c.db.students[0].consult.susi.gradeAverage='4';c.fail=false;c.save();
  assert.equal(JSON.parse(c.stored).students[0].consult.susi.gradeAverage,'4');assert.equal(c._savedDb,c.stored);
});

test('real backup merge preserves both course-plan histories and repeated conflicts do not duplicate',()=>{
 const c=fixture(),student=c.db.students[0],old={...c.cpBlank(student),id:'plan-one',reportText:'기존 설계'};
 student.consult.coursePlans=[old];c.save();const first=JSON.stringify(old);
 const incoming=clone(student);incoming.consult.coursePlans=[{...old,reportText:'다른 기기 설계'},{...old,id:'plan-two',reportText:'신규 설계'}];
 c.imported=JSON.stringify({students:[incoming]});c.doImport();
 const rows=c.db.students[0].consult.coursePlans;assert.equal(rows.length,3);assert.equal(JSON.stringify(rows[0]),first);assert.equal(rows[1].importedFromId,'plan-one');
 c.doImport();assert.equal(c.db.students[0].consult.coursePlans.length,3);
 const before=c.stored;c.fail=true;incoming.consult.coursePlans.push({...old,id:'plan-three'});c.imported=JSON.stringify({students:[incoming]});c.doImport();assert.equal(c.stored,before);assert.equal(JSON.stringify(c.db),before);
});

test('care sessions survive export, restore and repeated real merges without losing existing records',()=>{
 const c=fixture();c.csToday=()=> '2026-10-29';const p={...c.csBlank(),title:'합성 상담',date:'2026-10-28',status:'완료',summary:'상담 요약'};
 c.csSaveSession(c.db.students[0],p);const original=JSON.parse(c.stored);c.exportJson();const backup=c.exported;
 c.imported=backup;c.doRestore();assert.equal(c.db.students[0].consult.care.sessions[0].summary,'상담 요약');
 const incoming=clone(original);incoming.students[0].consult.care.sessions[0].summary='다른 기기 요약';c.imported=JSON.stringify(incoming);c.doImport();c.doImport();
 assert.equal(c.db.students[0].consult.care.sessions.length,2);assert.equal(c.csLatest(c.db.students[0])[0].summary,'상담 요약');
 assert.deepEqual(clone(c.db.students[0].consult.susi),original.students[0].consult.susi);
 const before=c.stored;incoming.students[0].consult.care.sessions={broken:true};c.imported=JSON.stringify(incoming);c.doRestore();assert.equal(c.stored,before);
});
test('failed real exam and support writes preserve records and history across a retry',()=>{
  const c=fixture();
  const draft={label:'합성 시험',type:'수능',status:'가채점',date:'2026-11-19',admissionYear:'2027',scores:{kor:{raw:0}}};
  c.jSaveExam(c.db.students[0],draft);c.fail=true;assert.throws(()=>c.save());
  assert.equal(c.db.students[0].consult.jeongsi,undefined);
  c.fail=false;const e=c.jSaveExam(c.db.students[0],draft);c.save();
  assert.equal(c.db.students[0].consult.jeongsi.exams.length,1);assert.equal(c.db.students[0].consult.jeongsi.history.length,1);
  const z=c.db.students[0].consult.jeongsi;z.plans.push({id:'plan',examId:e.id,admissionYear:'2027',group:'가',status:'후보',reason:'기존 판단'});c.save();
  const before=c.stored;z.plans[0].status='지원안';z.history.push({id:'phantom'});c.fail=true;assert.throws(()=>c.save());
  assert.equal(JSON.stringify(c.db),before);assert.equal(c.stored,before);
});
test('a staged replacement is installed only when persistence succeeds',()=>{
  const c=fixture(),before=c.stored,next=clone(c.db);next.students.push({id:'two',name:'합성 학생 B'});
  c.fail=true;assert.throws(()=>c.save(next));assert.equal(JSON.stringify(c.db),before);assert.equal(c.stored,before);
  c.fail=false;c.save(next);assert.equal(c.db.students.length,2);assert.equal(JSON.stringify(c.db),c.stored);
});

test('initial storage failure explains the interruption and preserves the last saved records',()=>{
  const c=fixture(),before=c.stored;c.db.meta.seedDbV3=true;c.fail=true;
  assert.throws(()=>c.saveInitial(),/기기 저장/);
  assert.equal(c.stored,before);assert.equal(JSON.stringify(c.db),before);
  assert.match(c.$('#main').innerHTML,/비밀번호 확인은 완료/);assert.match(c.$('#main').innerHTML,/기존 상담 기록은 유지/);
});
test('damaged or inaccessible storage is never treated as an empty database',()=>{
  for(const raw of ['{broken','null','{"students":{}}','']){
    const c=fixture();c.stored=raw;assert.throws(()=>c.load(),/원본 보호/);assert.equal(c.stored,raw);assert.match(c.$('#main').innerHTML,/덮어쓰지/);
  }
  const c=fixture();c.localStorage.getItem=()=>{throw Error('blocked');};assert.throws(()=>c.load());
  c.localStorage.getItem=()=>null;assert.deepEqual(clone(c.load().students),[]);
});
test('invalid later import rows cannot partially overwrite earlier student records',()=>{
  const c=fixture(),before=c.stored;
  c.imported=JSON.stringify({students:[{id:'one',name:'합성 학생 A',school:'덮어쓰면 안 됨'},{id:'two',name:'합성 학생 B',consult:{reports:{broken:true}}}]});
  c.doImport();assert.match(c.message,/가져오기 실패/);assert.equal(JSON.stringify(c.db),before);assert.equal(c.stored,before);
  c.imported=JSON.stringify({students:[{id:'one',name:'합성 학생 A',school:'덮어쓰면 안 됨'},{id:'three',name:'동명 합성'}]});
  c.db.students.push({id:'x',name:'동명 합성'},{id:'y',name:'동명 합성'});c.save();const ambiguous=c.stored;
  c.doImport();assert.match(c.message,/동명 학생/);assert.equal(JSON.stringify(c.db),ambiguous);assert.equal(c.stored,ambiguous);
});
test('failed restore and merge preserve both storage and the active view',()=>{
  for(const action of ['doRestore','doImport']){
    const c=fixture(),before=c.stored;c.fail=true;c.imported=JSON.stringify({students:[{id:'two',name:'합성 학생 B'}]});c[action]();
    assert.match(c.message,/실패/);assert.equal(JSON.stringify(c.db),before);assert.equal(c.stored,before);assert.equal(c.view.page,'report');
  }
});
test('broken shared lists or report bodies are rejected before restore and merge can replace records',()=>{
  for(const action of ['doRestore','doImport'])for(const bad of [
    {adiga:{broken:true}},
    {ipdb:[null]},
    {students:[{id:'two',name:'합성 학생 B',consult:{reports:[{id:'r',title:'손상된 합성 보고서',data:{}}]}}]}
  ]){
    const c=fixture(),before=c.stored;c.imported=JSON.stringify({students:[{id:'two',name:'합성 학생 B'}],...bad});c[action]();
    assert.match(c.message,/실패/);assert.equal(c.stored,before);assert.equal(JSON.stringify(c.db),before);
  }
});
test('student identity is matched before name and duplicate IDs are rejected atomically',()=>{
  const c=fixture();c.db.students.push({id:'two',name:'합성 학생 A',school:'보존'});c.save();
  c.imported=JSON.stringify({students:[{id:'two',name:'합성 학생 A',school:'같은 학생 수정'}]});c.doImport();
  assert.equal(c.db.students[0].school,undefined);assert.equal(c.db.students[1].school,'같은 학생 수정');
  const before=c.stored;c.imported=JSON.stringify({students:[{id:'x',name:'가상 A'},{id:'x',name:'가상 B'}]});c.doImport();
  assert.match(c.message,/중복/);assert.equal(c.stored,before);
});
test('backup export remains available even when the last-export date cannot be saved',()=>{
  const c=fixture(),before=c.stored;c.fail=true;c.exportJson();
  assert.deepEqual(JSON.parse(c.exported).students,JSON.parse(before).students);assert.equal(c.stored,before);assert.equal(JSON.stringify(c.db),before);
  assert.match(c.message,/내보내기/);
});
test('real input row adapters preserve zero percentiles and distinguish missing values',()=>{
  const c=fixture();c.db.ipdb=[{univ:'합성 A',pct:0},{univ:'합성 B',pct:null}];c.BULK.ip=[['합성 C','학과','수능',2026,'','','','',0],['합성 D','학과','수능',2026]];
  assert.deepEqual(Array.from(c.allIpRows(),r=>r.pct),[0,'',0,'']);
});
