import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { openDatabase,seedDemo } from './local-db.mjs';
import { createApi,today } from './api.mjs';
import { plannerAssets } from './planner-build.mjs';

test('원본 화면을 재사용하며 기존 저장소·인증 초기화를 실행하지 않는다',()=>{
  const assets=plannerAssets();new vm.Script(assets['planner.js']);
  assert.ok(assets['planner.js'].includes('function studyPlannerCard('));
  for(const name of ['viewToday','viewWeek','viewRoadmap','viewAcademic','viewIngang','viewStudy'])assert.ok(assets['planner.js'].includes('function '+name+'('));
  assert.ok(!assets['planner.js'].includes('https://wb-sync.whdudwns33.workers.dev'));
  assert.ok(!assets['planner.js'].includes('\nload();\n'));
  assert.ok(!assets['index.html'].includes('<script>'));
  assert.ok(assets['index.html'].includes('/blended/navigation.js'));
});

test('플래너 저장·권한·연결·충돌·리포트·질문 경계를 가상 자료로 확인',async t=>{
  const db=openDatabase();seedDemo(db);t.after(()=>db.close());const api=createApi(db),tokens={};
  const call=(u,action,payload={},requestId=randomUUID())=>api.handle({app:'blended',action,payload,requestId},tokens[u]);
  for(const u of ['owner','admin','teacher-a','teacher-b','student-a','student-b','guardian-a'])tokens[u]=call('','login',{login:u,password:`Demo-${u}-2026!`}).sessionToken;
  const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
  const rows=u=>call(u,'planner_state').rows;
  const find=(u,table,key)=>rows(u).find(r=>r.table===table && r.key===key);
  const save=(u,changes,id)=>call(u,'planner_save',{changes},id);
  const task=(id,sid='student-a',subject='math',origin='admin')=>({table:'tasks',key:id,revision:0,data:{id,staffId:sid,title:'가상 '+id,studySubject:subject,origin,repeat:'once',start:today(),end:'',steps:[],updatedAt:1}});
  const check=(key,patch={})=>({table:'checks',key,revision:0,data:{taskId:key.split('|')[0],date:key.split('|')[1],done:false,updatedAt:2,...patch}});
  await t.test('담당 학생·과목·보호자 접근과 서버 검증',()=>{
    save('owner',[task('math-task'),task('english-private','student-a','english'),task('other-student','student-b','math')]);
    assert.ok(find('teacher-a','tasks','math-task'));assert.ok(!find('teacher-a','tasks','english-private'));assert.ok(!find('teacher-a','tasks','other-student'));
    save('owner',[task('other-private','student-a','other')]);call('owner','assign',{teacherId:'teacher-b',studentId:'student-a',subject:'독서',starts:'2026-01-01',ends:'2099-12-31'});
    assert.ok(!find('teacher-b','tasks','other-private'),'임의 과목명을 기타 권한으로 바꾸지 않음');
    rejects(()=>call('guardian-a','planner_state'),'ROLE');
    rejects(()=>save('teacher-a',[task('forbidden','student-a','english')]),'SCOPE');
    rejects(()=>save('student-a',[task('forge','student-a','math','admin')]),'ROLE');
    rejects(()=>save('student-a',[task('cross','student-b','math','staff')]),'SCOPE');
    const forge=task('link-forge','student-a','math','staff');forge.data._blendedId='learning-b';rejects(()=>save('student-a',[forge]),'REFERENCE');
    const raw=JSON.parse('{"__proto__":{"polluted":true}}');const r=task('polluted');r.data.steps=raw;rejects(()=>save('owner',[r]),'INPUT');
  });
  await t.test('원본 학생 체크 → 강사 확인, 상담 약속과 양방향 공유',()=>{
    const key='math-task|'+today();save('student-a',[check(key,{done:true,note:'질문'})]);
    let r=find('teacher-a','checks',key);r.data.checked=true;r.data.feedback='풀이 확인';save('teacher-a',[r]);
    r=find('student-a','checks',key);assert.equal(r.data.checked,true);r.data.done=false;save('student-a',[r]);assert.equal(find('teacher-a','checks',key).data.checked,false);
    const linkedKey='blend-learning-a|'+today();r=find('student-a','checks',linkedKey);r.data.done=true;r.data.note='약속 질문';save('student-a',[r]);
    assert.equal(call('teacher-a','state').learning.find(l=>l.id==='learning-a').self_done,1);
    const l=call('teacher-a','state').learning.find(l=>l.id==='learning-a');call('teacher-a','check',{id:l.id,revision:l.revision,feedback:'약속 확인'});
    assert.equal(find('student-a','checks',linkedKey).data.checked,true);
    r=find('student-a','checks',linkedKey);r.data.feedback='조작';rejects(()=>save('student-a',[r]),'ROLE');
    const summary=call('teacher-a','summary',{studentId:'student-a',subject:'수학',start:today(),end:today()}).summary;
    assert.equal(summary.total,2);assert.equal(summary.checked,1);
  });
  await t.test('충돌은 전체 취소, 같은 저장 재시도는 중복 생성하지 않음',()=>{
    const stale=find('owner','tasks','math-task'),fresh=structuredClone(stale);fresh.data.title='새 제목';save('owner',[fresh]);
    stale.data.title='오래된 제목';rejects(()=>save('owner',[task('rolled-back'),stale]),'CONFLICT');assert.equal(find('owner','tasks','rolled-back'),undefined);
    const changes=[task('retry-task')],id=randomUUID();save('owner',changes,id);assert.equal(save('owner',changes,id).replayed,true);
    assert.equal(find('owner','tasks','retry-task').revision,1);
  });
  await t.test('다과목 인강은 과목별로 보이고 다른 과목 자료는 저장 시 보존',()=>{
    const key='__ing__student-a|all';save('owner',[check(key,{courses:[{id:'m',name:'수학 강좌',studySubject:'math',lectures:[]},{id:'e',name:'비공개 영어',studySubject:'english',lectures:[]}]})]);
    let r=find('teacher-a','checks',key);assert.equal(r.data.courses.length,1);r.data.courses[0].name='수학 수정';save('teacher-a',[r]);
    assert.equal(find('owner','checks',key).data.courses.find(c=>c.id==='e').name,'비공개 영어');
    r=find('teacher-a','checks',key);r.data.courses.push({id:'fake',studySubject:'english'});rejects(()=>save('teacher-a',[r]),'SCOPE');
    const profile=find('teacher-a','staff','student-a');profile.data.studyRoadmap={targetSchool:'가상 학교',items:[{id:'rm',subject:'math',book:'가상 교재'}]};save('teacher-a',[profile]);
    assert.equal(find('owner','staff','student-a').data.studyRoadmap.items.length,1);
  });
  await t.test('주간·월간 발행본은 원장만 새 버전으로 저장',()=>{
    const r=task('period-report');Object.assign(r.data,{kind:'report_snapshot',reportType:'week',periodKey:today(),seriesKey:'week:student-a:'+today(),reportRevision:1,reportStatus:'published',snapshot:{student:{id:'student-a'},summary:{total:1,internalNote:'PRIVATE_IN_SNAPSHOT'},internalNote:'PRIVATE_IN_SNAPSHOT'}});
    rejects(()=>save('teacher-a',[r]),'ROLE');save('owner',[r]);
    let stored=find('owner','tasks','period-report');stored.data.title='변조';rejects(()=>save('owner',[stored]),'IMMUTABLE');
    assert.ok(!find('teacher-a','tasks','period-report'));assert.ok(find('student-a','tasks','period-report'));
    assert.equal(call('guardian-a','planner_reports').reports.length,1);assert.doesNotMatch(JSON.stringify(call('guardian-a','planner_reports')),/PRIVATE_IN_SNAPSHOT/);
    assert.equal(call('student-b','planner_reports').reports.length,0);
    const withdrawn=structuredClone(r);withdrawn.key='period-withdrawn';Object.assign(withdrawn.data,{id:withdrawn.key,reportRevision:2,reportStatus:'withdrawn',snapshot:null});save('owner',[withdrawn]);
    assert.equal(call('guardian-a','planner_reports').reports.length,0);assert.ok(!find('student-a','tasks','period-report'));
  });
  await t.test('상담 약속 이월은 원본 내용·학생을 보존하고 잘못된 날짜와 답변 위조를 거부',()=>{
    const source=find('student-a','tasks','blend-learning-a').data,from=today(),id='daily-carry-'+source.id+'-'+from;
    const data={...source,id,origin:'staff',dailyCarryFrom:source.id+'|'+from,dailyCarryRootId:source.id,dailyCarrySourceDate:from,carrySourceOrigin:source.origin,start:new Date(Date.parse(from)+86400000).toISOString().slice(0,10)};
    save('student-a',[{table:'tasks',key:id,revision:0,data}]);assert.equal(find('student-a','tasks',id).data._blendedId,undefined);
    const changed=find('student-a','tasks',id);changed.data.title='원본 지시 변조';rejects(()=>save('student-a',[changed]),'REFERENCE');
    const bad=task('bad-date');bad.data.start='2026-02-31';rejects(()=>save('owner',[bad]),'INPUT');
    rejects(()=>save('student-a',[check('__ingnote__student-a|m:1',{answer:'강사 사칭'})]),'ROLE');
  });
  await t.test('학생 질문은 담당 과목 강사가 답변하고 해제 즉시 접근 중단',()=>{
    const q=call('student-a','planner_question',{action:'submit_question',subject:'math',clientRequestId:randomUUID(),bodyText:'가상 수학 질문'});
    assert.equal(call('teacher-a','planner_questions').submissions.length,1);assert.equal(call('teacher-b','planner_questions').submissions.length,0);
    rejects(()=>call('teacher-b','planner_question',{action:'answer',id:q.id,revision:1,answerText:'부정 접근'}),'SCOPE');
    call('teacher-a','planner_question',{action:'answer',id:q.id,revision:1,answerText:'가상 답변'});
    assert.equal(call('student-a','planner_questions').submissions[0].answerText,'가상 답변');
    const a=call('owner','state').assignments.find(a=>a.id==='assignment-a');call('owner','unassign',{id:a.id,revision:a.revision});
    assert.equal(rows('teacher-a').length,0);
    rejects(()=>save('teacher-a',[task('after-revoke')]),'SCOPE');
  });
});
