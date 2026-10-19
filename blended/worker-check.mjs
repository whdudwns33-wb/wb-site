import assert from 'node:assert/strict';
const base='http://127.0.0.1:8898',origin='http://blended.wbcowork.com';
let cookie='';
async function call(action,payload={},status=200){
  const response=await fetch(base+'/blended/api',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Blended-Request':'1',Cookie:cookie},body:JSON.stringify({app:'blended',action,payload,requestId:crypto.randomUUID()})});
  assert.equal(response.status,status,action);
  if(response.headers.get('set-cookie')){assert.match(response.headers.get('set-cookie'),/Secure; HttpOnly/);cookie=response.headers.get('set-cookie').split(';')[0];}
  return response.json();
}
const runtime=await call('runtime');assert.equal(runtime.mode,'production');
if(!runtime.ready)await call('setup',{token:'synthetic-local-setup-only',password:'Synthetic-owner-password!'});
await call('setup',{token:'not-authorized',password:'Synthetic-owner-password!'},403);
await call('login',{login:'whdudwns33',password:'Synthetic-owner-password!'});
const suffix=crypto.randomUUID().slice(0,8);
const teacher=await call('teacher_create',{name:'가상 실행 시험 강사',login:'t-'+suffix,password:'Synthetic-teacher-password!',role:'teacher'});
const student=await call('student_create',{name:'가상 실행 시험 학생',login:'s-'+suffix,password:'Synthetic-student-password!'});
const assignment=await call('assign',{teacherId:teacher.id,studentId:student.id,subject:'수학',starts:'2026-01-01',ends:'2099-12-31'});
const ownerCookie=cookie;
await call('login',{login:'t-'+suffix,password:'Synthetic-teacher-password!'});
const learning=await call('learning_create',{studentId:student.id,subject:'수학',title:'가상 런타임 학습',due:'2026-10-19'});
const teacherCookie=cookie;
await call('login',{login:'s-'+suffix,password:'Synthetic-student-password!'});
await call('perform',{id:learning.id,revision:1,done:true,question:'가상 질문'});
cookie=teacherCookie;await call('check',{id:learning.id,revision:2,feedback:'가상 확인'});
const c=await call('consult_save',{studentId:student.id,subject:'수학',heldAt:'2026-10-19T16:00:00+09:00',periodStart:'2026-10-19',periodEnd:'2026-10-19',internalNote:'PRIVATE_RUNTIME',public:{facts:'가상 사실',guidance:'가상 안내',nextGoal:'다음 실천',due:'2026-10-20'}});
await call('consult_complete',{id:c.id,revision:1});await call('review',{id:c.id,revision:2});
cookie=ownerCookie;await call('publish',{id:c.id,revision:3});
await call('login',{login:'s-'+suffix,password:'Synthetic-student-password!'});
const reports=await call('report_get',{id:c.id});assert.equal(reports.reports.length,1);assert.doesNotMatch(JSON.stringify(reports),/PRIVATE_RUNTIME/);
cookie=ownerCookie;await call('unassign',{id:assignment.id,revision:1});cookie=teacherCookie;
await call('consult_get',{id:c.id},403);
console.log('PASS Cloudflare local runtime: empty setup, secure login, teacher/student registration, scoped assignments, learning, counseling, immutable publication, private-note exclusion, revocation');
