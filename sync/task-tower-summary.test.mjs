import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.js';

// 합성 전용. 운영 키를 읽거나 발급하지 않는다.
const KEY = 'wbt_ct_' + 'x'.repeat(43);
const OLD_KEY = 'test-only-old-read-key-01234567890123456789';
const NOW = Date.parse('2026-11-18T00:30:00+09:00');
class D1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    this.reads = [];
  }
  prepare(sql) {
    assert.match(sql, /^SELECT /, '요약은 읽기만 허용');
    this.reads.push(sql);
    const statement = this.db.prepare(sql);
    let args = [];
    return { bind(...values) { args = values; return this; },
      first() { return statement.get(...args) || null; },
      all() { return { results: statement.all(...args) }; } };
  }
}
function fixture() {
  const DB = new D1();
  DB.db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .run('task', JSON.stringify({roster:{updated:'2026-11-18',baseline:'2026-11',students:[]},bookStudents:[]}), 1);
  return { DB, TASK_TOWER_READ_SECRET: KEY, TASK_MCP_READ_SECRET: OLD_KEY,
    TASK_ADMIN_SECRET: OLD_KEY, ALLOW_ORIGIN: 'https://pages.example' };
}
async function call(env, {token = KEY, method = 'GET', headers = {}, query = '', path = '/api/tower/summary'} = {}) {
  const request = new Request('https://worker.example' + path + query, {
    method, headers: {...headers, ...(token ? {Authorization:'Bearer ' + token} : {})}
  });
  const original = Date.now;
  Date.now = () => NOW;
  try { return await worker.fetch(request, env, {}); }
  finally { Date.now = original; }
}
function task(env, id, extra = {}, check = {blocked:true}, date = '2026-11-18') {
  const value = {id,staffId:'teacher',title:'합성 업무',repeat:'daily',start:'2026-01-01',...extra};
  env.DB.db.prepare('INSERT OR IGNORE INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,1,1)')
    .run('task',value.staffId,value.staffId,JSON.stringify({id:value.staffId,name:'합성 직원'}));
  env.DB.db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,1,1)')
    .run('task',id,value.staffId,JSON.stringify(value));
  if (check) env.DB.db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,1,1)')
    .run('task',id+'|'+date,value.staffId,JSON.stringify({taskId:id,date,...check}));
}
function event(env, id, {date='2026-11-18',actor='teacher',kind='message'} = {}) {
  if (kind === 'presence') env.DB.db.prepare('INSERT INTO center_chat_presence VALUES(?,?,?,?,?,?,?,?)')
    .run('task',date,'student-a','arrived',1,1,actor,'합성 직원');
  env.DB.db.prepare('INSERT INTO center_chat_events(app,kind,item_id,event_date,actor_staff_id,actor_name,body,student_id,status,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1)')
    .run('task',kind,(kind==='message'?'ccm_':'cpe_')+id,date,actor,'합성 직원',kind==='message'?'PRIVATE_SENTINEL':null,
      kind==='message'?null:'student-a',kind==='message'?null:'arrived',kind==='message'?null:1);
}

test('키 미설정·누락·오류·기존 키·세션만 요청은 모두 401, DB 접근 없음', async () => {
  for (const options of [{token:''},{token:'wrong'},{token:OLD_KEY},{token:'a'.repeat(64)},
    {token:'',headers:{Cookie:'session=synthetic'}}]) {
    const env = fixture(); const response = await call(env,options);
    assert.equal(response.status,401); assert.equal(env.DB.reads.length,0);
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  const env = fixture(); delete env.TASK_TOWER_READ_SECRET;
  assert.equal((await call(env)).status,401); assert.equal(env.DB.reads.length,0);
});
test('전용 키 200, 고정 봉투·세 정수만 반환하고 실제 빈 자료는 0', async () => {
  const response = await call(fixture()); assert.equal(response.status,200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(),['version','source','timezone','generatedAt','asOf','counts'].sort());
  assert.equal(body.version,1); assert.equal(body.source,'wb-task'); assert.equal(body.timezone,'Asia/Seoul');
  assert.equal(body.generatedAt,'2026-11-18T00:30:00.000+09:00'); assert.equal(body.asOf,body.generatedAt);
  assert.deepEqual(body.counts,{center_unread:0,makeup_pending:0,blocked:0});
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
});
test('Origin·쿼리 거절, GET 이외에는 쓰지 않는다', async () => {
  const env = fixture();
  assert.equal((await call(env,{headers:{Origin:'https://pages.example'}})).status,403);
  assert.equal((await call(env,{query:'?staffId=someone'})).status,400);
  for (const method of ['POST','PUT','DELETE','HEAD','OPTIONS']) assert.equal((await call(env,{method})).status,405);
  assert.equal(env.DB.reads.length,0);
});
test('대표 미확인: 읽음 이후 타인 메시지 전체 기간 + 오늘 등원 알림, 본인·지난 알림 제외', async () => {
  const env = fixture(); event(env,'read0001');
  env.DB.db.prepare('INSERT INTO center_chat_reads VALUES(?,?,?,?,?)').run('task','director',1,'ccm_read0001',1);
  event(env,'oldmsg01',{date:'2020-01-01'}); event(env,'today001',{kind:'presence'});
  event(env,'oldpres1',{kind:'presence',date:'2026-11-17'}); event(env,'self0001',{actor:'director'});
  const body = await (await call(env)).json(); assert.equal(body.counts.center_unread,2);
  assert.ok(!JSON.stringify(body).includes('PRIVATE_SENTINEL'));
  assert.ok(Object.values(body.counts).every(value => Number.isSafeInteger(value) || value===null));
});
test('막힘: KST 오늘·활성 직원·예정 업무만, 주문·삭제·지난 날짜 제외, 완료보다 막힘 우선', async () => {
  const env = fixture(); task(env,'active',{}, {blocked:true,done:true});
  task(env,'book',{title:'[주문] 합성'}); task(env,'deleted',{deleted:true});
  task(env,'past',{}, {blocked:true},'2026-11-17'); task(env,'future',{start:'2026-11-19'});
  task(env,'done',{}, {done:true}); task(env,'offday',{repeat:'days',days:[2]});
  task(env,'inactive',{staffId:'inactive'});
  env.DB.db.prepare("UPDATE staff SET data=? WHERE id='inactive'").run(JSON.stringify({id:'inactive',deleted:true}));
  task(env,'slots',{repeat:'days',days:[2],scheduleSlots:[{days:[3],validFrom:'2026-11-18'}]});
  assert.equal((await (await call(env)).json()).counts.blocked,2);
});
test('자료 없음·손상·DB 오류는 null, 마지막 수정이 오래됐어도 현재 읽은 정상 자료는 유효', async () => {
  const env = fixture(); task(env,'old-but-active');
  env.DB.db.exec('DROP TABLE center_chat_events; DELETE FROM private_rosters;');
  const body = await (await call(env)).json();
  assert.deepEqual(body.counts,{center_unread:null,makeup_pending:null,blocked:1});
  assert.equal(body.asOf,'2026-11-18T00:30:00.000+09:00');
  const failed = fixture(); failed.DB.prepare = () => {throw new Error('PRIVATE_DATABASE_SENTINEL');};
  const response = await call(failed); assert.equal(response.status,200);
  assert.deepEqual((await response.json()).counts,{center_unread:null,makeup_pending:null,blocked:null});
});
test('CT 키는 기존 MCP·관리 API 키로 대체되지 않는다', async () => {
  const env = fixture();
  const response = await call(env,{path:'/task-export',method:'POST'});
  assert.equal(response.status,401); assert.equal(env.DB.reads.length,0);
});

function makeupFixture() {
  const env = fixture();
  env.DB.db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").run(JSON.stringify({
    roster:{updated:'2026-11-18',baseline:'2026-11',students:[
      {id:'student-a',name:'합성 학생',grade:'중1',teacher:'합성 직원',subject:'영어',
        start:'2026-01',end:'',reason:'',teacherIds:['teacher']}
    ]},bookStudents:[]
  }));
  task(env,'source',{studentId:'student-a',taskKind:'lesson_instruction',subject:'영어'},null);
  return env;
}
function makeup(env, id, {status='review_pending', source='source', date='2026-11-01', att=''} = {}) {
  const confirmed = status === 'confirmed' || status === 'completed';
  env.DB.db.prepare('INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,consumption_group_id,status,revision,confirmed_start_at,confirmed_end_at,confirmed_staff_id,completed_at,completed_by,cancelled_at,cancelled_by,history,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,\'[]\',1,1)')
    .run('task',id,'student-a',source,date,'teacher','group-'+id,status,
      confirmed?date+'T18:00:00+09:00':null,confirmed?date+'T19:00:00+09:00':null,confirmed?'teacher':null,
      status==='completed'?1:null,status==='completed'?'teacher':null,status==='cancelled'?1:null,status==='cancelled'?'teacher':null);
  if (status === 'confirmed') task(env,'makeup_lesson_'+id,{studentId:'student-a',taskKind:'lesson_instruction',
    lessonInstanceType:'makeup',makeupCaseId:id,makeupSourceTaskId:source,makeupSourceDate:date,
    start:date,end:date,repeat:'once'},att?{att}:null,date);
}
test('보강 필요: 검토·검토완료·보호자 대기·확정 후 결석 포함, 예정·완료·취소 제외', async () => {
  const env = makeupFixture();
  for (const [i,status,att] of [[1,'review_pending',''],[2,'reviewed',''],[3,'awaiting_parent',''],
    [4,'confirmed','A'],[5,'confirmed','P'],[6,'completed','P'],[7,'cancelled','']])
    makeup(env,'case'+i,{status,att,date:'2026-11-0'+i});
  // 현재 명단/원 수업을 잃은 건 및 회차제·클리닉 필요 건은 화면 목록과 같이 제외한다.
  makeup(env,'orphan',{source:'missing-source',date:'2026-11-08'});
  task(env,'clinic',{studentId:'student-a',taskKind:'lesson_instruction',subject:'클리닉'},null);
  makeup(env,'clinic',{source:'clinic',date:'2026-11-09'});
  const response = await call(env); assert.equal(response.status,200);
  const body = await response.json(); assert.equal(body.counts.makeup_pending,4);
  assert.ok(!/합성 학생|합성 직원|student-a|source|case1/.test(JSON.stringify(body.counts)));
});
test('보강 집계는 화면 목록 상한 500건에서 잘리지 않는다', async () => {
  const env = makeupFixture();
  for (let i=0;i<501;i++) makeup(env,'bulk'+i,{date:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10)});
  assert.equal((await (await call(env)).json()).counts.makeup_pending,501);
});
test('형식이 맞지만 다른 전용 키·기존 키와 같은 설정은 401', async () => {
  const env = fixture();
  assert.equal((await call(env,{token:'wbt_ct_'+'y'.repeat(43)})).status,401);
  env.TASK_MCP_READ_SECRET = KEY;
  assert.equal((await call(env)).status,401); assert.equal(env.DB.reads.length,0);
});
test('비정기 주말은 예약이 있는 오늘만 막힘에 포함하며 지난 날짜 자료와 구별한다', async () => {
  const env = fixture();
  const flex = {weekendAttendanceMode:'flexible',weekendFlexibleFrom:'2026-01-01',
    weekendAllowedDays:[6],weekendPlans:[{date:'2026-11-21'}],repeat:'days',days:[6]};
  task(env,'reserved',flex,{blocked:true},'2026-11-21');
  task(env,'not-reserved',{...flex,weekendPlans:[]},{blocked:true},'2026-11-21');
  const { handleTaskTowerSummary } = await import('./task-tower-summary.js');
  const original = Date.now; Date.now = () => Date.parse('2026-11-21T00:10:00+09:00');
  try {
    const response = await handleTaskTowerSummary(new Request('https://worker.example/api/tower/summary',
      {headers:{Authorization:'Bearer '+KEY}}),env);
    const body = await response.json(); assert.equal(body.counts.blocked,1);
    assert.equal(body.asOf,'2026-11-21T00:10:00.000+09:00');
  } finally {Date.now = original;}
});
