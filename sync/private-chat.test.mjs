import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.js';
import { deriveStaffPinHash } from './staff-work-login.js';
import { resolveManagerInspectionAuth } from './staff-work-login.js';

const migration = readFileSync(new URL('./migrations/087_private_chat.sql', import.meta.url), 'utf8');
class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class TestD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE staff(app TEXT,id TEXT,data TEXT,PRIMARY KEY(app,id));
      CREATE TABLE tokens(app TEXT,token TEXT,staff_id TEXT,created_at INTEGER,revoked INTEGER);
      CREATE TABLE app_data_generations(app TEXT PRIMARY KEY,generation INTEGER);
      CREATE TABLE checks(app TEXT,k TEXT,owner TEXT,data TEXT,updated_at INTEGER,srv_at INTEGER,PRIMARY KEY(app,k));
      INSERT INTO app_data_generations VALUES('task',1);`);
    this.db.exec(readFileSync(new URL('./migrations/073_staff_work_login.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('./migrations/075_manager_inspection_sessions.sql', import.meta.url), 'utf8'));
    this.db.exec(migration);
  }
  prepare(sql) {
    if (this.hook?.pattern.test(sql)) { const hook = this.hook; this.hook = null; hook.run(this.db); }
    return new Statement(this.db, sql);
  }
}
const pin = '3847';
const wrongPin = '2058';
const now = Date.parse('2030-01-02T10:00:00+09:00');
let clock = now;
let nextRequest = 0;
async function fixture(run) {
  const originalNow = Date.now, originalFetch = globalThis.fetch;
  clock = now; Date.now = () => clock;
  let outgoing = 0;
  globalThis.fetch = async () => { outgoing++; throw new Error('EXTERNAL_REQUEST_FORBIDDEN'); };
  const DB = new TestD1();
  const env = { DB, WB_PRIVATE_CHAT_ENABLED: 'true', WB_PRIVATE_CHAT_ORGANIZATION_ID: 'synthetic-org-1',
    WB_PRIVATE_CHAT_STAFF_IDS: 'A,B,C,M2,M3,T2', WB_PRIVATE_CHAT_ADMIN_STAFF_IDS:'B,M2,M3', WB_STAFF_PIN_PEPPER: 'synthetic-only-'.repeat(4), TASK_MANAGER_STAFF_IDS_CONFIG: 'C',TASK_ADMIN_SECRET:crypto.randomUUID() };
  const tokens = new Map();
  let preservedChecks=[], preservedWork=[];
  const preserveAttendance=()=>{
    preservedChecks=DB.db.prepare('SELECT * FROM checks ORDER BY app,k').all();
    preservedWork=DB.db.prepare('SELECT * FROM staff_work_sessions ORDER BY app,token_hash').all();
  };
  try {
    for (const id of ['A','B','C','M2','M3','T2','outside']) {
      const token = crypto.randomUUID(); tokens.set(id, token);
      DB.db.prepare('INSERT INTO staff VALUES(?,?,?)').run('task', id, JSON.stringify({ id, name: '가상 직원 ' + id }));
      DB.db.prepare('INSERT INTO tokens VALUES(?,?,?,?,0)').run('task', token, id, clock);
      const salt = 'ab'.repeat(16), hash = await deriveStaffPinHash(pin, salt, env.WB_STAFF_PIN_PEPPER);
      DB.db.prepare('INSERT INTO staff_private_profiles(app,staff_id,pin_salt,pin_hash,updated_at) VALUES(?,?,?,?,?)')
        .run('task', id, salt, hash, clock);
    }
    const auth = id => ({ mode: 'person', id, token: tokens.get(id) });
    const call = async (id, action, extra = {}, target = env) => {
      const body = { app: 'task', auth: auth(id), action, ...extra };
      const response = await worker.fetch(new Request('http://localhost/private-chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      }), target, {});
      return { status: response.status, data: await response.json() };
    };
    const login = async (id, target = env) => {
      const response = await call(id, 'confirm', { pin }, target);
      assert.equal(response.status, 200);
      assert.equal(typeof response.data.privateSession, 'string');
      return response.data.privateSession;
    };
    const open = async (id, privateSession, recipientId) => {
      const response = await call(id, 'open', { privateSession, recipientId });
      assert.equal(response.status, 200);
      return response.data.room.id;
    };
    const send = async (id, privateSession, roomId, body = '가상 안내', requestId = 'pcm_test_' + (++nextRequest)) =>
      call(id, 'send', { privateSession, roomId, body, requestId });
    await run({ env, DB, auth, call, login, open, send, tokens, preserveAttendance });
    assert.equal(outgoing, 0, 'no external fetch or fallback');
    assert.equal(JSON.stringify(DB.db.prepare('SELECT * FROM checks ORDER BY app,k').all())===JSON.stringify(preservedChecks),true,'attendance unchanged');
    assert.equal(JSON.stringify(DB.db.prepare('SELECT * FROM staff_work_sessions ORDER BY app,token_hash').all())===JSON.stringify(preservedWork),true,'work sessions unchanged');
    assert.equal(DB.db.prepare('SELECT SUM(failed_attempts+locked_until+attempt_revision) n FROM staff_private_profiles').get().n, 0,
      'business login counters unchanged');
  } finally { DB.db.close(); Date.now = originalNow; globalThis.fetch = originalFetch; }
}

// v0.2: 기존 A-B 성공 회귀의 B만 명시 메신저 관리자다. A-T2 교사 쌍은 아래 legacy 거부로 보존한다.
test('teacher and explicit messenger admin exchange, page, count and acknowledge; no attendance side effects', () => fixture(async f => {
  const a = await f.login('A'), b = await f.login('B');
  const room = await f.open('A', a, 'B');
  assert.equal(await f.open('B', b, 'A'), room);
  assert.equal((await f.send('A', a, room)).status, 200);
  const items = await f.call('B', 'messages', { privateSession: b, roomId: room });
  assert.equal(items.data.messages.length, 1);
  assert.equal(items.data.messages[0].senderId, 'A');
  assert.equal((await f.call('B', 'unread', { privateSession: b })).data.unreadCount, 1);
  assert.equal((await f.call('A', 'messages', { privateSession: a, roomId: room })).data.messages[0].readByPeer, false);
  assert.equal((await f.call('A', 'read', { privateSession: a, roomId: room, sequences: [1], readerId: 'B' })).status, 400);
  assert.equal((await f.call('B', 'read', { privateSession: b, roomId: room, sequences: [2] })).status, 400);
  assert.equal((await f.call('B', 'read', { privateSession: b, roomId: room, sequences: [1] })).status, 200);
  assert.equal((await f.call('A', 'messages', { privateSession: a, roomId: room })).data.messages[0].readByPeer, true);
  assert.equal((await f.call('B', 'unread', { privateSession: b })).data.unreadCount, 0);
}));

test('every private route denies invalid, shared, inspection, non-task and cross-person authentication', () => fixture(async f => {
  const a = await f.login('A');
  for (const action of ['status','confirm','directory','rooms','unread','open','messages','send','read','touch','logout']) {
    for (const auth of [null, { mode: 'admin', secret: f.env.TASK_ADMIN_SECRET }, { mode: 'manager_inspection' },
      { ...f.auth('A'), id: 'B' }, { ...f.auth('A'), token: crypto.randomUUID() }]) {
      const response = await f.call('A', action, { auth, privateSession: a, pin, recipientId: 'B' });
      assert.notEqual(response.status, 200, action);
      assert.equal('rooms' in response.data || 'messages' in response.data || 'unreadCount' in response.data, false);
    }
    assert.notEqual((await f.call('A', action, { app: 'consult', privateSession: a, pin })).status, 200);
  }
  assert.notEqual((await f.call('outside', 'confirm', { pin })).status, 200);
}));

test('manager all-scope and forged sender selection do not bypass participation', () => fixture(async f => {
  const a = await f.login('A'), c = await f.login('C');
  const room = await f.open('A', a, 'B');
  for (const action of ['messages','send','read']) {
    const denied = await f.call('C', action, { privateSession: c, roomId: room, sequences: [1],
      senderId: 'A', staffId: 'B', body: '가상 안내', requestId: 'pcm_forged' });
    assert.equal(denied.status, 404);
    assert.equal('room' in denied.data || 'messages' in denied.data, false);
  }
  assert.equal((await f.call('C', 'rooms', { privateSession: c })).data.rooms.length, 0);
  assert.equal((await f.call('C', 'unread', { privateSession: c })).data.unreadCount, 0);
  assert.equal((await f.call('A', 'send', { privateSession: a, roomId: room, body: '가상 안내', requestId: 'pcm_sender', senderId: 'C', staffId: 'C' })).status, 200);
  assert.equal(f.DB.db.prepare('SELECT sender_id FROM private_chat_messages').get().sender_id, 'A');
}));

test('separate trusted organizations with identical staff strings cannot replay a session or room', () => fixture(async f => {
  const a = await f.login('A'), room = await f.open('A', a, 'B');
  await f.send('A', a, room);
  const other = { ...f.env, WB_PRIVATE_CHAT_ORGANIZATION_ID: 'synthetic-org-2' };
  for (const action of ['directory','rooms','unread','open','messages','send','read']) {
    assert.equal((await f.call('A', action, { privateSession: a, roomId: room, recipientId: 'B', organizationId: 'synthetic-org-1' }, other)).status, 401);
  }
  const second = await f.login('A', other);
  assert.equal((await f.call('A', 'rooms', { privateSession: second }, other)).data.rooms.length, 0);
  assert.equal((await f.call('A', 'messages', { privateSession: second, roomId: room }, other)).status, 404);
  assert.equal((await f.call('A', 'rooms', { privateSession: a, organizationId: 'synthetic-org-2' })).data.rooms.length, 1);
}));

test('private confirmation checks exactly this person PIN, rate limits separately and fails closed when unconfigured', () => fixture(async f => {
  const salt = 'cd'.repeat(16), differentHash = await deriveStaffPinHash(wrongPin, salt, f.env.WB_STAFF_PIN_PEPPER);
  f.DB.db.prepare('UPDATE staff_private_profiles SET pin_hash=?,pin_salt=? WHERE staff_id=?').run(differentHash, salt, 'B');
  for (let i=0;i<5;i++) assert.equal((await f.call('A', 'confirm', { pin: wrongPin })).status, 401);
  assert.equal((await f.call('A', 'confirm', { pin })).status, 429);
  clock += 5 * 60 * 1000;
  await f.login('A');
  assert.equal((await f.call('B', 'confirm', { pin: wrongPin })).status, 200);
  f.DB.db.prepare('UPDATE staff_private_profiles SET pin_hash=? WHERE staff_id=?').run('', 'A');
  assert.equal((await f.call('A', 'confirm', { pin })).status, 401);
  assert.equal((await f.call('C', 'status', {}, { ...f.env, WB_PRIVATE_CHAT_ENABLED: undefined })).status, 404);
  assert.equal((await f.call('C', 'status', {}, { ...f.env, WB_PRIVATE_CHAT_ORGANIZATION_ID: '' })).status, 503);
}));

test('idle polling never renews confirmation; user activity, absolute limit and logout are enforced', () => fixture(async f => {
  const a = await f.login('A');
  clock += 9 * 60 * 1000;
  assert.equal((await f.call('A', 'rooms', { privateSession: a })).status, 200);
  clock += 60 * 1000;
  assert.equal((await f.call('A', 'rooms', { privateSession: a })).status, 401);
  const renewed = await f.login('A');
  for(let i=0;i<53;i++) { clock += 9 * 60 * 1000; assert.equal((await f.call('A', 'touch', { privateSession: renewed })).status, 200); }
  clock += 3 * 60 * 1000;
  assert.equal((await f.call('A', 'touch', { privateSession: renewed })).status, 401);
  const final = await f.login('A');
  assert.equal((await f.call('A', 'logout', { privateSession: final })).status, 200);
  assert.equal((await f.call('A', 'rooms', { privateSession: final })).status, 401);
}));

test('bearer revocation, deletion, profile revision, data generation and device switch lock every private route', () => fixture(async f => {
  for (const change of ['revoke','delete','revision','generation','device']) {
    const a = await f.login('A');
    const restore = f.DB.db.prepare('SELECT data FROM staff WHERE id=?').get('A').data;
    if(change === 'revoke') f.DB.db.exec("UPDATE tokens SET revoked=1 WHERE staff_id='A'");
    if(change === 'delete') f.DB.db.exec("UPDATE staff SET data=json_set(data,'$.deleted',1) WHERE id='A'");
    if(change === 'revision') f.DB.db.exec("UPDATE staff_private_profiles SET credential_revision=credential_revision+1 WHERE staff_id='A'");
    if(change === 'generation') f.DB.db.exec("UPDATE app_data_generations SET generation=generation+1");
    const override = change === 'device' ? { auth: { ...f.auth('A'), token: crypto.randomUUID() } } : {};
    for(const action of ['directory','rooms','unread','open','messages','send','read','touch']) {
      assert.equal((await f.call('A', action, { privateSession:a, recipientId:'B', ...override })).status, 401);
    }
    f.DB.db.exec("UPDATE tokens SET revoked=0 WHERE staff_id='A'");
    f.DB.db.prepare('UPDATE staff SET data=? WHERE id=?').run(restore, 'A');
  }
}));

test('concurrent pair creation and retries are unique; request id cannot move to another recipient or body', () => fixture(async f => {
  const a = await f.login('A'), b = await f.login('B');
  const ids = await Promise.all([f.open('A',a,'B'),f.open('B',b,'A'),f.open('A',a,'B')]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_rooms').get().n,1);
  const results = await Promise.all([f.send('A',a,ids[0],'가상 안내','pcm_duplicate'),f.send('A',a,ids[0],'가상 안내','pcm_duplicate')]);
  assert.equal(results.every(row=>row.status===200),true);
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_messages').get().n,1);
  assert.equal((await f.send('A',a,ids[0],'다른 가상 안내','pcm_duplicate')).status,409);
  const other = await f.open('A',a,'M2');
  assert.equal((await f.send('A',a,other,'가상 안내','pcm_duplicate')).status,409);
}));

test('pagination and monotone receipts stay in the authorized room; text stays inert and no URL is fetched', () => fixture(async f => {
  const a = await f.login('A'), b = await f.login('B'), room = await f.open('A',a,'B');
  for(let i=0;i<52;i++) assert.equal((await f.send('A',a,room)).status,200);
  const text = '<img src=x onerror=alert(1)>\nhttps://example.invalid/?a=1&b=2#가상';
  assert.equal((await f.send('A',a,room,text)).status,200);
  const newest = await f.call('B','messages',{privateSession:b,roomId:room});
  assert.equal(newest.data.messages.length,50);
  const older = await f.call('B','messages',{privateSession:b,roomId:room,before:newest.data.before});
  assert.equal(older.data.messages.length,3);
  assert.equal(newest.data.messages.at(-1).body===text,true);
  assert.equal((await f.call('B','read',{privateSession:b,roomId:room,sequences:[53]})).status,200);
  assert.equal((await f.call('B','read',{privateSession:b,roomId:room,sequences:[1]})).status,200);
  assert.equal((await f.call('A','messages',{privateSession:a,roomId:room})).data.messages.at(-1).readByPeer,true);
  assert.equal((await f.call('B','unread',{privateSession:b})).data.unreadCount,51);
  assert.throws(()=>f.DB.db.exec('UPDATE private_chat_messages SET body=body'));
  assert.throws(()=>f.DB.db.exec('DELETE FROM private_chat_messages'));
  f.DB.db.exec(migration);
}));

test('hashed parent expiry is the session ceiling while legacy bearer does not acquire an invented TTL', () => fixture(async f => {
  const raw = f.tokens.get('A');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
  f.DB.db.prepare('UPDATE tokens SET token=?,created_at=? WHERE staff_id=?').run('sha256:'+hash,clock-90*86400000+1000,'A');
  const response = await f.call('A','confirm',{pin});
  assert.equal(response.status,200);
  assert.equal(response.data.expiresAt,clock+1000);
  clock+=1000;
  assert.equal((await f.call('A','rooms',{privateSession:response.data.privateSession})).status,401);
}));

test('authorization changes immediately before a write cannot create a message or receipt', () => fixture(async f => {
  const a=await f.login('A'), b=await f.login('B'), room=await f.open('A',a,'B');
  await f.send('A',a,room);
  f.DB.hook={pattern:/INSERT OR IGNORE INTO private_chat_messages/,run(db){db.exec("UPDATE tokens SET revoked=1 WHERE staff_id='A'");}};
  assert.notEqual((await f.send('A',a,room)).status,200);
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_messages').get().n,1);
  f.DB.db.exec("UPDATE tokens SET revoked=0 WHERE staff_id='A'");
  f.DB.hook={pattern:/INSERT OR IGNORE INTO private_chat_reads/,run(db){db.exec("UPDATE staff SET data=json_set(data,'$.deleted',1) WHERE id='A'");}};
  assert.notEqual((await f.call('B','read',{privateSession:b,roomId:room,sequences:[1]})).status,200);
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_reads').get().n,0);
}));

test('existing work-login requirement is retained and private auth never synthesizes a clock-in', () => fixture(async f => {
  f.DB.db.exec("UPDATE staff_private_profiles SET login_enabled=1 WHERE staff_id='A'");
  const guarded={...f.env,WB_STAFF_WORK_LOGIN_ENABLED:'true'};
  assert.equal((await f.call('A','confirm',{pin},guarded)).data.code,'STAFF_WORK_LOGIN_REQUIRED');
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_sessions').get().n,0);
  // 새 인증으로 기존 업무 로그인 요구를 완화하지 않는다. 원장은 비대상 profile도 직접 PIN 확인한다.
  assert.equal((await f.call('C','confirm',{pin},guarded)).status,200);
}));

test('missing private confirmation and disabled/deleted recipients fail closed without leaking counts', () => fixture(async f => {
  for(const action of ['directory','rooms','unread','open','messages','send','read','touch','logout'])
    assert.equal((await f.call('A',action,{recipientId:'B'})).status,401);
  const a=await f.login('A');
  f.DB.db.exec("UPDATE staff SET data=json_set(data,'$.deleted',1) WHERE id='B'");
  assert.equal((await f.call('A','open',{privateSession:a,recipientId:'B'})).status,404);
  const dir=await f.call('A','directory',{privateSession:a});
  assert.equal(dir.data.directory.some(row=>row.id==='B'),false);
}));

test('proposal migration is additive, idempotent and mirrored in canonical local schema',()=>{
  const schema=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
  assert.equal(schema.includes(migration.trim()),true);
  assert.doesNotMatch(migration,/\b(?:DROP|ALTER|DELETE|UPDATE)\s+(?:TABLE\s+)?(?:staff|checks|tokens)\b/i);
});

test('existing attendance and work rows stay byte-identical and private unlock obeys the earlier work expiry',()=>fixture(async f=>{
  const work=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
  f.DB.db.exec("UPDATE staff_private_profiles SET login_enabled=1 WHERE staff_id='A'");
  f.DB.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run('task','__att__A|2030-01-02','A',JSON.stringify({taskId:'__att__A',date:'2030-01-02',done:true,at:clock-1000}),clock,clock);
  f.DB.db.prepare('INSERT INTO staff_work_sessions VALUES(?,?,?,?,?,?,?,?,?,0)').run('task',await hash(work),'A',await hash(f.tokens.get('A')),'2030-01-02',1,1,clock,clock+2000);
  f.preserveAttendance();
  const env={...f.env,WB_STAFF_WORK_LOGIN_ENABLED:'true'};
  const auth={...f.auth('A'),workSession:work};
  const response=await f.call('A','confirm',{pin,auth},env);
  assert.equal(response.status,200);assert.equal(response.data.expiresAt,clock+2000);
  clock+=2000;
  const expired=await f.call('A','rooms',{auth,privateSession:response.data.privateSession},env);
  assert.equal(expired.data.code,'STAFF_WORK_LOGIN_REQUIRED');assert.equal('rooms' in expired.data,false);
}));

test('a valid manager inspection session cannot reuse either the teacher or manager private identity',()=>fixture(async f=>{
  const a=await f.login('A'), c=await f.login('C');
  const raw=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw))),b=>b.toString(16).padStart(2,'0')).join('');
  f.DB.db.prepare('INSERT INTO manager_inspection_sessions VALUES(?,?,?,?,?,?,?,0)').run('task',hash,'C','A','synthetic-device-binding',clock,clock+3600000);
  const auth={mode:'manager_inspection',id:'A',managerId:'C',token:raw};
  const verified=await resolveManagerInspectionAuth(f.env,'task',auth,new Set(['C']));
  assert.equal(verified.inspection,true);assert.equal(verified.id,'A');assert.equal(verified.managerId,'C');
  for(const privateSession of [a,c])for(const action of ['status','confirm','directory','rooms','unread','open','messages','send','read','touch','logout'])
    assert.equal((await f.call('A',action,{auth,privateSession,pin,recipientId:'B'})).status,401);
}));

const privateHash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
async function workFixture(f) {
  const raw=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const s1=raw(), s2=raw(), s1Hash=await privateHash(s1);
  f.DB.db.prepare('INSERT INTO checks VALUES(?,?,?,?,?,?)').run('task','__att__A|2030-01-02','A',
    JSON.stringify({taskId:'__att__A',date:'2030-01-02',done:true,at:clock-1000}),clock,clock);
  for(const work of [s1,s2]) f.DB.db.prepare('INSERT INTO staff_work_sessions VALUES(?,?,?,?,?,?,?,?,?,0)').run(
    'task',await privateHash(work),'A',await privateHash(f.tokens.get('A')),'2030-01-02',1,1,clock,clock+3600000);
  f.preserveAttendance();
  const auth={...f.auth('A'),workSession:s1};
  const login=await f.call('A','confirm',{pin,auth});
  assert.equal(login.status,200);
  assert.equal(f.DB.db.prepare('SELECT parent_work_hash FROM private_chat_sessions').get().parent_work_hash===s1Hash,true);
  return {auth,s2,s1Hash,privateSession:login.data.privateSession};
}

test('B1 original S1 is required after issue: omission and valid S2 cannot conceal its revocation with the work gate off',()=>fixture(async f=>{
  const w=await workFixture(f);
  assert.equal((await f.call('A','rooms',w)).status,200);
  assert.equal((await f.call('A','rooms',{privateSession:w.privateSession,auth:{...w.auth,workSession:w.s2}})).status,401);
  f.DB.db.prepare('UPDATE staff_work_sessions SET revoked=1 WHERE token_hash=?').run(w.s1Hash);
  f.preserveAttendance();
  for(const auth of [f.auth('A'),{...w.auth,workSession:w.s2},w.auth]) {
    for(const action of ['status','directory','rooms','unread','open','messages','send','read','touch','logout']) {
      const response=await f.call('A',action,{auth,privateSession:w.privateSession,recipientId:'B'});
      assert.equal(response.status,401); assert.equal(response.data.authScope,'private_chat');
      assert.equal('rooms' in response.data,false);
    }
  }
  // 원래 독립 경로는 출근/근무세션 생성 없이 계속 허용한다.
  assert.equal((await f.call('A','confirm',{pin})).status,200);
}));

test('B1 bound S1 rechecks expiry, person, device, work date, credential, generation and open attendance',async()=>{
  const mutations=[
    db=>db.prepare('UPDATE staff_work_sessions SET expires_at=?').run(clock),
    db=>db.exec("UPDATE staff_work_sessions SET staff_id='B'"),
    db=>db.exec("UPDATE staff_work_sessions SET device_hash='synthetic-other-device'"),
    db=>db.exec("UPDATE staff_work_sessions SET work_date='2030-01-01'"),
    db=>db.exec('UPDATE staff_work_sessions SET credential_revision=2'),
    db=>db.exec('UPDATE staff_work_sessions SET data_generation=2'),
    db=>db.exec("UPDATE checks SET data=json_set(data,'$.out',updated_at+1)"),
    db=>db.exec("UPDATE checks SET owner='B'")
  ];
  for(const mutate of mutations) await fixture(async f=>{
    const w=await workFixture(f); mutate(f.DB.db); f.preserveAttendance();
    assert.equal((await f.call('A','rooms',w)).status,401);
    assert.equal((await f.call('A','confirm',{pin,auth:w.auth})).status,401);
  });
});

test('B1 atomic write guards reject S1 revocation between authorization and confirm/open/send/read/touch writes',async()=>{
  for(const action of ['confirm','open','send','read','touch']) await fixture(async f=>{
    const w=await workFixture(f), b=await f.login('B');
    const room=(await f.call('A','open',{...w,recipientId:'B'})).data.room.id;
    await f.send('B',b,room);
    const table={confirm:'sessions',open:'rooms',send:'messages',read:'reads',touch:'sessions'}[action];
    const before=f.DB.db.prepare('SELECT * FROM private_chat_'+table).all();
    if(action==='touch') clock+=30000;
    const pattern={confirm:/INSERT INTO private_chat_sessions/,open:/INSERT OR IGNORE INTO private_chat_rooms/,
      send:/INSERT OR IGNORE INTO private_chat_messages/,read:/INSERT OR IGNORE INTO private_chat_reads/,touch:/UPDATE private_chat_sessions SET last_user_at/}[action];
    f.DB.hook={pattern,run(db){db.prepare('UPDATE staff_work_sessions SET revoked=1 WHERE token_hash=?').run(w.s1Hash);f.preserveAttendance();}};
    const response=await f.call('A',action,{...w,pin,recipientId:'M2',roomId:room,body:'합성 경합',requestId:'pcm_race_test',sequences:[1]});
    assert.equal(response.status,401);
    assert.equal(JSON.stringify(f.DB.db.prepare('SELECT * FROM private_chat_'+table).all())===JSON.stringify(before),true,'no protected write after original parent revocation');
  });
});

test('C1 private-domain errors are marked while genuine parent bearer rejection is not',()=>fixture(async f=>{
  const incorrect=await f.call('A','confirm',{pin:wrongPin});
  assert.equal(incorrect.status,401);assert.equal(incorrect.data.authScope,'private_chat');
  const a=await f.login('A');
  f.DB.db.exec('UPDATE private_chat_sessions SET revoked=1');
  assert.equal((await f.call('A','rooms',{privateSession:a})).data.authScope,'private_chat');
  f.DB.db.exec("UPDATE tokens SET revoked=1 WHERE staff_id='A'");
  const rejected=await f.call('A','rooms',{privateSession:a});
  assert.equal(rejected.status,401);assert.equal(rejected.data.code,'PERSON_AUTH_REJECTED');
  assert.equal('authScope' in rejected.data,false);
}));


test('v0.2 three-admin and teacher matrix uses explicit task IDs only, not global all-scope or client role',()=>fixture(async f=>{
  const ids=['A','T2','C','B','M2','M3'], admins=['B','M2','M3'];
  const sessions={};for(const id of ids)sessions[id]=await f.login(id);
  for(const id of ids){
    const expected=ids.filter(peer=>peer!==id&&(admins.includes(id)||admins.includes(peer))).sort();
    const directory=await f.call(id,'directory',{privateSession:sessions[id]});
    assert.deepEqual(directory.data.directory.map(x=>x.id).sort(),expected);
    for(const peer of ids){
      const result=await f.call(id,'open',{privateSession:sessions[id],recipientId:peer,role:'manager',isAdmin:true,scope:'all',staffId:'B',targetId:'B',organizationId:'fake'});
      const allowed=expected.includes(peer);assert.equal(result.status,allowed?200:404,id+'->'+peer);
      if(!allowed){assert.equal(result.data.authScope,'private_chat');assert.equal('room' in result.data,false);}
    }
  }
  const b=sessions.B,m=sessions.M2,room=await f.open('B',b,'M2');
  assert.equal((await f.send('B',b,room)).status,200);
  assert.equal((await f.send('M2',m,room)).status,200);
  assert.equal((await f.call('M2','unread',{privateSession:m})).data.unreadCount,1);
  assert.equal((await f.call('M2','read',{privateSession:m,roomId:room,sequences:[1,2]})).status,200);
  assert.equal((await f.call('M2','unread',{privateSession:m})).data.unreadCount,0);
  // 제3 관리자도 비참여 방의 본문·전송·읽음 권한은 없다.
  for(const action of ['messages','send','read'])assert.equal((await f.call('M3',action,{privateSession:sessions.M3,roomId:room,body:'合成',requestId:'pcm_third_admin',sequences:[1]})).status,404);
  assert.equal((await f.call('M3','rooms',{privateSession:sessions.M3})).data.rooms.some(x=>x.id===room),false);
}));

test('v0.2 legacy teacher room stays stored but cannot leak either direction, body, receipts or unread counts',()=>fixture(async f=>{
  const db=f.DB.db,room='pcr_legacy_teachers';
  db.prepare('INSERT INTO private_chat_rooms VALUES(?,?,?,?,?)').run(f.env.WB_PRIVATE_CHAT_ORGANIZATION_ID,room,'A','T2',clock);
  db.prepare('INSERT INTO private_chat_messages VALUES(?,?,?,?,?,?,?)').run(f.env.WB_PRIVATE_CHAT_ORGANIZATION_ID,room,1,'pcm_legacy_seed','A','합성 비공개 옛본문',clock);
  const before=JSON.stringify(db.prepare('SELECT * FROM private_chat_rooms').all()),messageBefore=JSON.stringify(db.prepare('SELECT * FROM private_chat_messages').all());
  for(const [id,peer] of [['A','T2'],['T2','A']]){
    const session=await f.login(id);
    for(const action of ['open','messages','send','read']){
      const r=await f.call(id,action,{privateSession:session,recipientId:peer,roomId:room,role:'manager',isAdmin:true,auth:{...f.auth(id),scope:'all',role:'manager'},body:'합성 위조',requestId:'pcm_legacy_forged',sequences:[1]});
      assert.equal(r.status,404,action);assert.equal(r.data.authScope,'private_chat');
      assert.equal('room' in r.data||'messages' in r.data||'unreadCount' in r.data,false);
    }
    for(const action of ['rooms','unread']){const r=await f.call(id,action,{privateSession:session});assert.deepEqual(r.data.rooms,[]);assert.equal(r.data.unreadCount,0);}
    assert.equal((await f.call(id,'directory',{privateSession:session})).data.directory.some(x=>x.id===peer),false);
    assert.equal((await f.call(id,'status',{privateSession:session})).status,200);
    assert.equal((await f.call(id,'touch',{privateSession:session})).status,200);
    assert.equal((await f.call(id,'logout',{privateSession:session})).status,200);
  }
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM private_chat_rooms').all()),before);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM private_chat_messages').all()),messageBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM private_chat_reads').get().n,0);
}));

test('v0.2 missing or malformed explicit admin config fails every action closed in the private domain without writes',()=>fixture(async f=>{
  const a=await f.login('A'),room=await f.open('A',a,'B');
  for(const value of [undefined,'',' ','B,','B,,M2','B,B','not an ID',42]){
    const env={...f.env,WB_PRIVATE_CHAT_ADMIN_STAFF_IDS:value};
    const before=JSON.stringify(f.DB.db.prepare('SELECT * FROM private_chat_sessions').all());
    for(const action of ['status','confirm','directory','rooms','unread','open','messages','send','read','touch','logout']){
      const r=await f.call('A',action,{privateSession:a,pin,recipientId:'B',roomId:room,sequences:[1],body:'합성',requestId:'pcm_bad_config'},env);
      assert.equal(r.status,503,action);assert.equal(r.data.code,'PRIVATE_CHAT_NOT_CONFIGURED');assert.equal(r.data.authScope,'private_chat');
      assert.equal('room' in r.data||'messages' in r.data||'unreadCount' in r.data,false);
    }
    assert.equal(JSON.stringify(f.DB.db.prepare('SELECT * FROM private_chat_sessions').all()),before);
  }
}));

test('v0.2 role removal invalidates every old session action, fresh teacher pair denied; reordering is not a role change',()=>fixture(async f=>{
  const a=await f.login('A'),b=await f.login('B'),room=await f.open('A',a,'B');await f.send('A',a,room);
  f.env.WB_PRIVATE_CHAT_ADMIN_STAFF_IDS='M3,M2,B';
  assert.equal((await f.call('A','status',{privateSession:a})).status,200);
  f.env.WB_PRIVATE_CHAT_ADMIN_STAFF_IDS='M2,M3';
  const before=f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_messages').get().n;
  for(const [id,session] of [['A',a],['B',b]])for(const action of ['status','directory','rooms','unread','open','messages','send','read','touch','logout']){
    const r=await f.call(id,action,{privateSession:session,recipientId:id==='A'?'B':'A',roomId:room,sequences:[1],body:'합성',requestId:'pcm_removed_admin'});
    assert.equal(r.status,401,action);assert.equal(r.data.authScope,'private_chat');
  }
  const fresh=await f.login('A');
  assert.equal((await f.call('A','directory',{privateSession:fresh})).data.directory.some(x=>x.id==='B'),false);
  assert.equal((await f.call('A','open',{privateSession:fresh,recipientId:'B'})).status,404);
  assert.equal((await f.call('A','messages',{privateSession:fresh,roomId:room})).status,404);
  assert.equal((await f.call('A','unread',{privateSession:fresh})).data.unreadCount,0);
  assert.equal(f.DB.db.prepare('SELECT COUNT(*) n FROM private_chat_messages').get().n,before);
}));

test('v0.2 explicit admin list cannot expand active WB private allowlist or identify unknown/cross-app staff',()=>fixture(async f=>{
  const env={...f.env,WB_PRIVATE_CHAT_ADMIN_STAFF_IDS:'outside,unknown'};
  assert.equal((await f.call('outside','confirm',{pin},env)).status,401);
  assert.notEqual((await f.call('unknown','confirm',{pin},env)).status,200);
  const a=await f.login('A',env);
  assert.deepEqual((await f.call('A','directory',{privateSession:a},env)).data.directory,[]);
  for(const id of ['outside','unknown','B'])assert.equal((await f.call('A','open',{privateSession:a,recipientId:id},env)).status,404);
  const valid=await f.login('A'),room=await f.open('A',valid,'B');await f.send('A',valid,room);
  f.DB.db.exec("UPDATE staff SET data=json_set(data,'$.deleted',1) WHERE id='B'");
  assert.equal((await f.call('A','directory',{privateSession:valid})).data.directory.some(x=>x.id==='B'),false);
  assert.deepEqual((await f.call('A','rooms',{privateSession:valid})).data.rooms,[]);
  assert.equal((await f.call('A','unread',{privateSession:valid})).data.unreadCount,0);
  for(const action of ['open','messages','send','read'])assert.equal((await f.call('A',action,{privateSession:valid,recipientId:'B',roomId:room,body:'합성',requestId:'pcm_inactive_peer',sequences:[1]})).status,404);
  f.DB.db.exec("UPDATE staff SET app='consult' WHERE id='B'");
  assert.equal((await f.call('A','open',{privateSession:valid,recipientId:'B'})).status,404);
}));
