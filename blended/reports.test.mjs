import test from 'node:test';import assert from 'node:assert/strict';
import {openDatabase,seedDemo} from './local-db.mjs';import {createApi} from './api.mjs';
import {defaultLayout,validateLayout,designerLayout} from './report-layout.mjs';import {reportModel,pdfInputs,sampleSnapshot} from './report-model.mjs';
test('공개 차트·양식 입력 검증·원장 전용·409·발행 당시 양식 보존',()=>{
 const db=openDatabase();seedDemo(db);const api=createApi(db),tokens={};
 const call=(who,action,payload={})=>api.handle({app:'blended',action,payload,requestId:crypto.randomUUID()},tokens[who]);
 try{
  for(const id of ['owner','admin','teacher-a','teacher-b','student-a','guardian-a'])tokens[id]=api.handle({app:'blended',action:'login',payload:{login:id,password:`Demo-${id}-2026!`}}).sessionToken;
  assert.deepEqual(validateLayout(defaultLayout()),defaultLayout());
  const custom=defaultLayout();custom.pdfmeVersion='6.2.6';custom.schemas[0].push({...custom.schemas[0][0],name:'원장이 추가한 문구',content:'학원 안내',position:{x:16,y:245}});const normalized=designerLayout(custom);assert.ok(normalized.schemas[0].at(-1).name.startsWith('label_'));assert.equal(normalized.schemas[0].at(-1).readOnly,true);assert.ok(!Object.hasOwn(normalized,'pdfmeVersion'));
  for(const change of [t=>t.schemas[0].pop()&&t.schemas[0].shift(),t=>t.basePdf='https://evil.test/file.pdf',t=>t.schemas[0][3].content='data:image/svg+xml;base64,aaaa',t=>t.schemas[0][0].fontName='remote',t=>t.schemas[0][0].position.x=999,t=>t.schemas[0][0].readOnly=true,t=>t.schemas[0][0].name='internalNote']){const t=defaultLayout();change(t);assert.throws(()=>validateLayout(t),e=>e.status===400);}
  const template=defaultLayout();template.schemas[0][0].fontSize=22;
  for(const id of ['admin','teacher-a','student-a','guardian-a'])assert.throws(()=>call(id,'report_layout_save',{template,revision:0}),e=>e.status===403);
  assert.equal(call('owner','report_layout_save',{template,revision:0}).revision,1);assert.throws(()=>call('owner','report_layout_save',{template,revision:0}),e=>e.status===409);
  const c=call('teacher-a','consult_save',{studentId:'student-a',subject:'수학',heldAt:'2026-10-20T16:00:00+09:00',periodStart:'2026-10-01',periodEnd:'2026-10-31',public:sampleSnapshot().public,internalNote:'PRIVATE_NEVER_CHART_OR_PDF'});
  assert.ok(!JSON.stringify(call('teacher-a','report_preview',{id:c.id})).includes('PRIVATE_NEVER'));assert.throws(()=>call('teacher-b','report_preview',{id:c.id}),e=>e.status===403);assert.throws(()=>call('student-a','report_preview',{id:c.id}),e=>e.status===403);
  call('teacher-a','consult_complete',{id:c.id,revision:1});call('teacher-a','review',{id:c.id,revision:2});call('owner','publish',{id:c.id,revision:3});
  const before=call('guardian-a','report_get',{id:c.id}).reports[0].snapshot;assert.equal(before.layout.schemas[0][0].fontSize,22);
  call('owner','report_layout_save',{template:defaultLayout(),revision:1});assert.deepEqual(call('guardian-a','report_get',{id:c.id}).reports[0].snapshot,before);
  const model=reportModel(before);assert.ok(!JSON.stringify(pdfInputs(model,'')).includes('PRIVATE_NEVER'));assert.equal(model.metrics[2].label,'강사 확인');
  assert.equal(reportModel({summary:{},student:{},public:{}}).hasRecords,false);
  const period=reportModel({summary:{done:3,total:5},student:{},days:[{date:'2026-10-12',total:2,done:1}],subjects:{math:{total:5,done:3}}},'planner');assert.equal(period.metrics.length,2);assert.equal(period.subjects[0].name,'수학');assert.equal(period.days.length,1);
 }finally{db.close();}
});
