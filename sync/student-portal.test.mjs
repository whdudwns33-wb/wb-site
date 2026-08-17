import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { handleStudentPortal } from './student-portal.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration038 = fs.readFileSync(new URL('./migrations/038_student_portal.sql', import.meta.url), 'utf8');
const migration039 = fs.readFileSync(new URL('./migrations/039_student_portal_scope_v2.sql', import.meta.url), 'utf8');
const migration040 = fs.readFileSync(new URL('./migrations/040_student_lesson_self_checks.sql', import.meta.url), 'utf8');
const portalProbe = fs.readFileSync(new URL('./portal-release-probe.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor(databaseSchema = schema) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(databaseSchema);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

const env = db => ({ DB: db, WB_STUDENT_PORTAL_BASE_URL: 'https://student.academy.example/' });
const admin = { scope: 'all' };

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function call(db, body, auth = null, cookie = '', bindings = {}) {
  const request = new Request('https://academy.example/student-portal', {
    method: 'POST', headers: cookie ? { cookie } : {}
  });
  const response = await handleStudentPortal({ ...env(db), ...bindings }, 'task', { app: 'task', ...body },
    'https://academy.example', auth,
    (payload, status, origin) => new Response(JSON.stringify(payload), {
      status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': origin }
    }), request);
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') || '' };
}

function dates() {
  const shifted = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return { date: shifted.toISOString().slice(0, 10), month: shifted.toISOString().slice(0, 7),
    weekday: shifted.getUTCDay() };
}

async function seed(db, options = {}) {
  const now = Date.now();
  const { date, month, weekday } = dates();
  const document = { roster: { updated: date, baseline: month, students: [
    { id: 'student-a', name: '학생A', grade: '초2', teacher: '담당A', subject: '독해', start: month, end: '',
      reason: '', teacherIds: ['staff-a'], memo: '학생 내부 메모' },
    { id: 'student-b', name: '학생B', grade: '초3', teacher: '담당B', subject: '수학', start: month, end: '',
      reason: '', teacherIds: ['staff-b'] },
    { id: 'student-old', name: '종료학생', grade: '초4', teacher: '담당A', subject: '독해', start: '2025-01',
      end: month, reason: '퇴원 사유', teacherIds: ['staff-a'] }
  ] }, bookStudents: [{
    id: 'assignment-a', studentId: 'student-a', name: '학생A', teacher: '담당A', bookId: 'book-a', at: '',
    perWeek: 2, goal: '', teacherIds: ['staff-a']
  }] };
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(document), now).run();
  for (const [id, name] of [['staff-a', '담당A'], ['staff-b', '담당B']]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
  }
  const task = {
    id: 'lesson-a', staffId: 'staff-a', studentId: 'student-a', studentName: '학생A', grade: '초2',
    subject: '독해', className: '기초반', taskKind: 'lesson_instruction', scheduleStatus: 'confirmed', deleted: false,
    scheduleSlots: [{ days: [weekday], startTime: '16:00', endTime: '17:00' }],
    studentTraits: '내부 특성', parentRequest: '학부모 내부 요청', guide: '교사용 내부 지시'
  };
  const other = { ...task, id: 'lesson-b', staffId: 'staff-b', studentId: 'student-b', studentName: '학생B',
    subject: '수학', className: '심화반', scheduleSlots: [{ days: [weekday], startTime: '18:00', endTime: '19:00' }] };
  for (const row of [[task, 'staff-a'], [other, 'staff-b']]) {
    db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', row[0].id, row[1], JSON.stringify(row[0]), now, now).run();
  }
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'lesson-a|' + date, 'staff-a', JSON.stringify({
      taskId: 'lesson-a', date, att: 'P', steps: {
        'lesson-a-standard-step-1': true, 'lesson-a-standard-step-2': true
      }, note: '오늘 내부 메모', blocked: '내부 차단 사유'
    }), now, now).run();

  const transport = { baseAddress: '학원 내부 주소', vehicles: [{ id: 'vehicle-a', name: '8호차', plate: '9002', capacity: 11 }],
    routes: [{ id: 'route-a', name: '학생 집 노선', active: true, direction: 'pickup', days: [weekday], startTime: '15:00',
      vehicleId: 'vehicle-a', driverId: 'staff-a', stops: [
        { id: 'stop-a', name: '집 앞', address: '학생 비공개 주소', time: '15:20', studentIds: ['student-a'] },
        { id: 'stop-b', name: '학생B 집', address: '학생B 주소', time: '15:30', studentIds: ['student-b'] }
      ] }] };
  db.prepare('INSERT INTO transport_configs(app,data,updated_at,updated_by) VALUES(?,?,?,?)')
    .bind('task', JSON.stringify(transport), now, 'director').run();
  db.prepare(
    'INSERT INTO transport_states(app,date,route_id,student_id,status,revision,boarded_at,boarded_by,history,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', date, 'route-a', 'student-a', 'boarded', 1, now, 'staff-a',
    JSON.stringify([{ event: 'boarded', note: '기사 내부 메모' }]), now).run();

  const studentHash = await sha256Hex('student-id\nstudent-a');
  const taskHash = await sha256Hex(['lesson-task', task.id, 'staff-a', task.studentId, task.id].join('\n'));
  const publicationStatus = options.publicationStatus === 'withdrawn' ? 'withdrawn' : 'published';
  const publicationDate = /^\d{4}-\d{2}-\d{2}$/.test(options.publicationDate || '') ? options.publicationDate : date;
  const studentVisible = options.studentVisible == null ? 1 : options.studentVisible ? 1 : 0;
  db.prepare(
    'INSERT INTO guardian_lesson_publications(app,publication_id,source_task_id,task_owner,student_id,' +
    'student_identity_hash,task_identity_hash,lesson_date,status,public_homework,public_readiness,student_visible,' +
    'revision,updated_at,updated_by) ' +
    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,'staff-a')"
  ).bind('task', 'publication-a', 'lesson-a', 'staff-a', 'student-a', studentHash, taskHash, publicationDate,
    publicationStatus, publicationStatus === 'published' ? '공개 숙제' : '',
    publicationStatus === 'published' ? '연필 준비' : '', publicationStatus === 'published' ? studentVisible : 0, now).run();
  db.prepare(
    'INSERT INTO book_issues(app,assignment_id,student_id,book_id,student_identity_hash,status,cycle,revision,' +
    'prepared_at,prepared_by,history,created_at,updated_at) VALUES(?,?,?,?,?,\'prepared\',1,1,?,?,\'[]\',?,?)'
  ).bind('task', 'assignment-a', 'student-a', 'book-a', await sha256Hex('student-a\n학생A'), now, 'staff-a', now, now).run();

  db.prepare(
    'INSERT INTO feedback_requests(app,request_key,task_id,owner,feedback_date,feedback_type,template_version,' +
    'body,body_hash,student_id,student_name,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'sent\',?,?)'
  ).bind('task', 'feedback-parent-only', 'lesson-a', 'staff-a', date, 'daily', 'v1',
    '학부모에게만 보낸 비밀 피드백', 'hash', 'student-a', '학생A', now, now).run();
  db.prepare(
    'INSERT INTO guardian_requests(app,request_id,student_id,client_request_id,request_type,status,revision,created_at,updated_at) ' +
    "VALUES(?,?,?,?,?,'open',1,?,?)"
  ).bind('task', 'guardian-request-a', 'student-a', 'guardian_request_0001', 'consultation', now, now).run();
  db.prepare(
    'INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?)'
  ).bind('task', 'student-a', '학생A', '01012345678', 1, now, 'director').run();
  return { date, now };
}

async function connect(db, studentId = 'student-a') {
  const enabled = await call(db, {
    action: 'access_set', studentId, enabled: true, consentConfirmed: true, scopeVersion: 3, expectedUpdatedAt: 0
  }, admin);
  assert.equal(enabled.status, 200);
  const invited = await call(db, { action: 'invite', studentId }, admin);
  assert.equal(invited.status, 200);
  const exchanged = await call(db, { action: 'exchange', code: invited.body.code });
  assert.equal(exchanged.status, 200);
  return { code: invited.body.code, cookie: exchanged.cookie.split(';')[0] };
}

async function legacyV1Invite(db) {
  const now = Date.now();
  const code = '1'.repeat(48);
  const studentIdentityHash = await sha256Hex('student-a\n학생A');
  const guardianIdentityHash = await sha256Hex(['student-a', '학생a', '01012345678'].join('\u001f'));
  const codeHash = 'sha256:' + await sha256Hex(code);
  db.prepare(
    'INSERT INTO student_portal_access(app,student_id,enabled,student_identity_hash,guardian_identity_hash,' +
    'scope_version,accepted_at,updated_at,updated_by,effective_scope_version) VALUES(?,?,?,?,?,1,?,?,?,1)'
  ).bind('task', 'student-a', 1, studentIdentityHash, guardianIdentityHash, now, now, 'director').run();
  db.prepare(
    'INSERT INTO student_portal_codes(app,code_hash,student_id,student_identity_hash,guardian_identity_hash,' +
    'scope_version,access_updated_at,created_at,expires_at,consumed_at,revoked,issued_by,claim_id,' +
    'effective_scope_version) VALUES(?,?,?,?,?,1,?,?,?,NULL,0,?,NULL,1)'
  ).bind('task', codeHash, 'student-a', studentIdentityHash, guardianIdentityHash,
    now, now, now + 60 * 60 * 1000, 'director').run();
  return { code, updatedAt: now };
}

async function legacyV2Invite(db, expectedUpdatedAt) {
  const now = Math.max(Date.now(), Number(expectedUpdatedAt) + 1);
  const code = '2'.repeat(48);
  const access = db.prepare(
    'SELECT student_identity_hash,guardian_identity_hash FROM student_portal_access WHERE app=? AND student_id=?'
  ).bind('task', 'student-a').first();
  db.prepare(
    'UPDATE student_portal_access SET effective_scope_version=2,scope_confirmed_at=?,self_check_enabled=0,' +
    'self_check_confirmed_at=NULL,accepted_at=?,updated_at=? WHERE app=? AND student_id=? AND updated_at=?'
  ).bind(now, now, now, 'task', 'student-a', expectedUpdatedAt).run();
  const codeHash = 'sha256:' + await sha256Hex(code);
  db.prepare(
    'INSERT INTO student_portal_codes(app,code_hash,student_id,student_identity_hash,guardian_identity_hash,' +
    'scope_version,access_updated_at,created_at,expires_at,consumed_at,revoked,issued_by,claim_id,' +
    'effective_scope_version,self_check_enabled) VALUES(?,?,?,?,?,1,?,?,?,NULL,0,?,NULL,2,0)'
  ).bind('task', codeHash, 'student-a', access.student_identity_hash, access.guardian_identity_hash,
    now, now, now + 60 * 60 * 1000, 'director').run();
  return { code, updatedAt: now };
}

test('038·039·040 migration은 데이터를 지우지 않고 신규 schema의 학생 포털 객체와 같다', () => {
  assert.doesNotMatch(migration038, /DROP\s+TABLE|DELETE\s+FROM/i);
  assert.doesNotMatch(migration039, /DROP\s+TABLE|DELETE\s+FROM/i);
  assert.doesNotMatch(migration040, /DROP\s+TABLE|DELETE\s+FROM/i);
  const fresh = new DatabaseSync(':memory:'); fresh.exec(schema);
  const upgraded = new DatabaseSync(':memory:');
  const marker = schema.indexOf('-- 학생 웹앱은 보호자 인증과 분리된');
  assert.ok(marker > 0);
  const pre038 = schema.slice(0, marker)
    .replace(/^\s*student_visible\s+INTEGER[^\n]*\n/gm, '');
  upgraded.exec(pre038); upgraded.exec(migration038); upgraded.exec(migration039); upgraded.exec(migration040);
  const objects = database => database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND " +
    "(name LIKE 'student_portal_%' OR name LIKE 'idx_student_portal_%' OR name LIKE 'trg_student_portal_%' " +
    "OR name LIKE 'student_lesson_self_check%' OR name LIKE 'idx_student_lesson_self_check%' " +
    "OR name LIKE 'trg_student_lesson_self_check%') ORDER BY name"
  ).all().map(row => ({ ...row, sql: row.sql.replace(/IF NOT EXISTS\s*/gi, '').replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(objects(upgraded), objects(fresh));
  for (const table of ['student_portal_access', 'student_portal_codes', 'student_portal_sessions']) {
    const columns = fresh.prepare('PRAGMA table_info(' + table + ')').all();
    assert.equal(columns.some(row => /phone|contact|address/i.test(row.name)), false);
    const legacyScope = columns.find(row => row.name === 'scope_version');
    const effectiveScope = columns.find(row => row.name === 'effective_scope_version');
    assert.ok(legacyScope);
    assert.equal(legacyScope.dflt_value == null || String(legacyScope.dflt_value) === '1', true);
    assert.equal(String(effectiveScope && effectiveScope.dflt_value), '1');
    assert.equal(String(columns.find(row => row.name === 'self_check_enabled').dflt_value), '0');
  }
  for (const table of ['guardian_lesson_publications', 'guardian_lesson_publication_events']) {
    assert.deepEqual(upgraded.prepare('PRAGMA table_info(' + table + ')').all(),
      fresh.prepare('PRAGMA table_info(' + table + ')').all());
    const studentVisible = fresh.prepare('PRAGMA table_info(' + table + ')').all()
      .find(row => row.name === 'student_visible');
    assert.equal(String(studentVisible && studentVisible.dflt_value), '0');
  }
  assert.throws(() => fresh.prepare(
    'INSERT INTO student_portal_access(app,student_id,enabled,student_identity_hash,guardian_identity_hash,' +
    'scope_version,accepted_at,updated_at,updated_by,effective_scope_version) VALUES(?,?,?,?,?,1,NULL,?,?,2)'
  ).run('task', 'student-x', 1, 'a'.repeat(64), 'b'.repeat(64), Date.now(), 'director'), /CHECK constraint/);

  const beforeRerun = objects(upgraded);
  assert.throws(() => upgraded.exec('BEGIN;' + migration040 + 'COMMIT;'), /duplicate column/i);
  if (upgraded.isTransaction) upgraded.exec('ROLLBACK');
  assert.deepEqual(objects(upgraded), beforeRerun);
});

test('배포 probe는 040 미적용·완전 적용·부분 적용을 서로 구분한다', () => {
  const marker = schema.indexOf('-- 학생 웹앱은 보호자 인증과 분리된');
  const pre038 = schema.slice(0, marker).replace(/^\s*student_visible\s+INTEGER[^\n]*\n/gm, '');
  const readProbe = database => new Map(portalProbe.split(';').map(statement => statement.trim()).filter(Boolean)
    .map(statement => database.prepare(statement).get())
    .map(row => [row.check_name, [Number(row.found), Number(row.expected)]]));

  const before040 = new DatabaseSync(':memory:');
  before040.exec(pre038); before040.exec(migration038); before040.exec(migration039);
  let result = readProbe(before040);
  assert.deepEqual(result.get('migration_040_objects'), [0, 15]);
  assert.deepEqual(result.get('migration_040_columns'), [0, 4]);

  const complete = new DatabaseSync(':memory:'); complete.exec(schema);
  result = readProbe(complete);
  assert.deepEqual(result.get('migration_040_objects'), [15, 15]);
  assert.deepEqual(result.get('migration_040_columns'), [4, 4]);

  before040.exec(
    'ALTER TABLE student_portal_access ADD COLUMN self_check_enabled INTEGER NOT NULL DEFAULT 0 ' +
    'CHECK (self_check_enabled IN (0,1))'
  );
  result = readProbe(before040);
  assert.deepEqual(result.get('migration_040_objects'), [0, 15]);
  assert.deepEqual(result.get('migration_040_columns'), [1, 4]);
  assert.throws(() => before040.exec(migration040), /duplicate column/i);
});

test('040 부분 적용 DB와 학생 앱 base URL 미설정은 raw 오류 대신 명확히 차단한다', async () => {
  const db = new TestD1(); await seed(db);
  db.database.exec('DROP TABLE student_portal_sessions');
  const notReady = await call(db, { action: 'access_list' }, admin);
  assert.equal(notReady.status, 503);
  assert.equal(notReady.body.code, 'STUDENT_PORTAL_NOT_READY');

  const marker = schema.indexOf('-- 학생 웹앱은 보호자 인증과 분리된');
  const pre038 = schema.slice(0, marker).replace(/^\s*student_visible\s+INTEGER[^\n]*\n/gm, '');
  const partial = new TestD1(pre038 + migration038);
  await seed(partial);
  partial.database.exec(
    'ALTER TABLE student_portal_access ADD COLUMN effective_scope_version INTEGER NOT NULL DEFAULT 1 ' +
    'CHECK (effective_scope_version IN (1,2))'
  );
  const partialResponse = await call(partial, { action: 'access_list' }, admin);
  assert.equal(partialResponse.status, 503);
  assert.equal(partialResponse.body.code, 'STUDENT_PORTAL_NOT_READY');

  const missingMismatchGuard = new TestD1(); await seed(missingMismatchGuard);
  missingMismatchGuard.database.exec('DROP TRIGGER trg_student_portal_access_scope_mismatch');
  const missingGuardResponse = await call(missingMismatchGuard, { action: 'access_list' }, admin);
  assert.equal(missingGuardResponse.status, 503);
  assert.equal(missingGuardResponse.body.code, 'STUDENT_PORTAL_NOT_READY');

  for (const trigger of ['trg_student_lesson_self_checks_update_guard',
    'trg_student_lesson_self_checks_no_delete']) {
    const damaged = new TestD1(); await seed(damaged);
    damaged.database.exec('DROP TRIGGER ' + trigger);
    const response = await call(damaged, { action: 'access_list' }, admin);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'STUDENT_PORTAL_NOT_READY');
  }

  const configured = new TestD1(); await seed(configured);
  const enabled = await call(configured, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  }, admin);
  assert.equal(enabled.status, 200);
  const missingUrl = await call(configured, { action: 'invite', studentId: 'student-a' }, admin, '', {
    WB_STUDENT_PORTAL_BASE_URL: ''
  });
  assert.equal(missingUrl.status, 503);
  assert.equal(missingUrl.body.code, 'STUDENT_PORTAL_NOT_CONFIGURED');
  assert.equal(configured.prepare('SELECT COUNT(*) count FROM student_portal_codes').first().count, 0);
});

test('관리자만 현재 재원 stable studentId의 이용 허용·초대·미리보기를 관리한다', async () => {
  const db = new TestD1(); await seed(db);
  assert.equal((await call(db, { action: 'access_list' })).status, 403);
  assert.equal((await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  })).status, 403);
  assert.equal((await call(db, {
    action: 'access_set', studentId: 'student-old', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  }, admin)).status, 409);
  assert.equal((await call(db, { action: 'invite', studentId: 'student-a' }, admin)).status, 409);
  assert.equal((await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, scopeVersion: 3, expectedUpdatedAt: 0
  }, admin)).body.code, 'CONSENT_REQUIRED');
  assert.equal((await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true, expectedUpdatedAt: 0
  }, admin)).body.code, 'SCOPE_VERSION_REQUIRED');
  const enabled = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  }, admin);
  assert.equal(enabled.status, 200);
  assert.equal((await call(db, { action: 'preview', studentId: 'student-a' }, admin)).status, 200);
  const list = await call(db, { action: 'access_list' }, admin);
  assert.equal(list.body.requiredScopeVersion, 3);
  assert.deepEqual(list.body.access.map(row => [row.studentId, row.enabled]), [['student-a', true]]);
});

test('구 Worker는 v3 access에 v2 코드·세션을 만들 수 없고 이용 해지 시 scope가 v1로 닫힌다', async () => {
  const db = new TestD1(); await seed(db);
  const enabled = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  }, admin);
  assert.equal(enabled.status, 200);
  const access = db.prepare(
    'SELECT student_identity_hash,guardian_identity_hash,updated_at FROM student_portal_access WHERE student_id=?'
  ).bind('student-a').first();
  const now = Date.now();
  assert.throws(() => db.prepare(
    'INSERT INTO student_portal_codes(app,code_hash,student_id,student_identity_hash,guardian_identity_hash,' +
    'scope_version,access_updated_at,created_at,expires_at,revoked,issued_by,effective_scope_version) ' +
    'VALUES(?,?,?,?,?,1,?,?,?,0,?,2)'
  ).bind('task', 'sha256:' + 'a'.repeat(64), 'student-a', access.student_identity_hash,
    access.guardian_identity_hash, access.updated_at, now, now + 1000, 'director').run(),
  /STUDENT_PORTAL_CODE_SELF_CHECK_SCOPE_MISMATCH/);
  assert.throws(() => db.prepare(
    'INSERT INTO student_portal_sessions(app,token_hash,student_id,student_identity_hash,guardian_identity_hash,' +
    'scope_version,access_updated_at,created_at,expires_at,last_seen_at,revoked,effective_scope_version) ' +
    'VALUES(?,?,?,?,?,1,?,?,?,?,0,2)'
  ).bind('task', 'sha256:' + 'b'.repeat(64), 'student-a', access.student_identity_hash,
    access.guardian_identity_hash, access.updated_at, now, now + 1000, now).run(),
  /STUDENT_PORTAL_SESSION_SELF_CHECK_SCOPE_MISMATCH/);

  db.prepare(
    'UPDATE student_portal_access SET accepted_at=updated_at+1,updated_at=updated_at+1 ' +
    'WHERE app=? AND student_id=?'
  ).bind('task', 'student-a').run();
  const downgraded = db.prepare(
    'SELECT effective_scope_version,scope_confirmed_at,self_check_enabled,self_check_confirmed_at ' +
    'FROM student_portal_access WHERE student_id=?'
  ).bind('student-a').first();
  assert.equal(downgraded.effective_scope_version, 1);
  assert.equal(downgraded.scope_confirmed_at, null);
  assert.equal(downgraded.self_check_enabled, 0);
  assert.equal(downgraded.self_check_confirmed_at, null);
  const list = await call(db, { action: 'access_list' }, admin);
  assert.equal(list.body.access[0].enabled, false);
  assert.equal(list.body.access[0].needsScopeReconsent, true);
  assert.equal((await call(db, { action: 'invite', studentId: 'student-a' }, admin)).body.code,
    'STUDENT_SCOPE_RECONSENT_REQUIRED');

  db.prepare(
    'UPDATE student_portal_access SET enabled=0,student_identity_hash=NULL,guardian_identity_hash=NULL,' +
    'scope_version=1,accepted_at=NULL,updated_at=updated_at+1,updated_by=? WHERE app=? AND student_id=?'
  ).bind('director', 'task', 'student-a').run();
  assert.equal(db.prepare(
    'SELECT effective_scope_version FROM student_portal_access WHERE student_id=?'
  ).bind('student-a').first().effective_scope_version, 1);
});

test('관리자 미리보기는 세션·코드·동의를 만들지 않고 실제 학생 view와 같은 DTO를 반환한다', async () => {
  const db = new TestD1(); await seed(db);
  const beforeChanges = db.prepare('SELECT total_changes() changes').first().changes;
  const preview = await call(db, { action: 'preview', studentId: 'student-a' }, admin);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.capabilities, { externalLearning: true, selfCheck: true });
  assert.equal(preview.cookie, '');
  assert.equal(db.prepare('SELECT total_changes() changes').first().changes, beforeChanges);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM student_portal_access').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM student_portal_codes').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM student_portal_sessions').first().count, 0);

  const connected = await connect(db);
  const view = await call(db, { action: 'view' }, null, connected.cookie);
  const withoutGeneratedAt = body => {
    const copy = structuredClone(body);
    delete copy.generatedAt;
    return copy;
  };
  assert.deepEqual(withoutGeneratedAt(preview.body), withoutGeneratedAt(view.body));
});

test('기존 v1·v2 세션은 종전 DTO를 유지하고 v3 재동의 뒤에만 자기 체크를 받는다', async () => {
  const db = new TestD1(); await seed(db);
  const legacy = await legacyV1Invite(db);
  const list = await call(db, { action: 'access_list' }, admin);
  assert.equal(list.body.requiredScopeVersion, 3);
  assert.deepEqual(list.body.access.map(row => ({
    enabled: row.enabled, scopeVersion: row.scopeVersion, needsScopeReconsent: row.needsScopeReconsent
  })), [{ enabled: false, scopeVersion: 1, needsScopeReconsent: true }]);
  const inviteBlocked = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
  assert.equal(inviteBlocked.status, 409);
  assert.equal(inviteBlocked.body.code, 'STUDENT_SCOPE_RECONSENT_REQUIRED');
  const cachedClient = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    expectedUpdatedAt: legacy.updatedAt
  }, admin);
  assert.equal(cachedClient.status, 409);
  assert.equal(cachedClient.body.code, 'SCOPE_VERSION_REQUIRED');
  assert.equal(db.prepare('SELECT revoked FROM student_portal_codes').first().revoked, 0);

  const exchanged = await call(db, { action: 'exchange', code: legacy.code });
  assert.equal(exchanged.status, 200);
  const legacyCookie = exchanged.cookie.split(';')[0];
  const legacyView = await call(db, { action: 'view' }, null, legacyCookie);
  assert.equal(legacyView.status, 200);
  assert.deepEqual(legacyView.body.capabilities, { externalLearning: false });
  assert.ok(legacyView.body.today.lessons.length);
  assert.ok(legacyView.body.schedule.length);
  assert.ok(legacyView.body.publicLessons.length);
  assert.ok(legacyView.body.bookStatus.length);

  const v2 = await legacyV2Invite(db, legacy.updatedAt);
  assert.equal(db.prepare('SELECT revoked FROM student_portal_sessions').first().revoked, 1);
  assert.equal((await call(db, { action: 'view' }, null, legacyCookie)).status, 401);

  const v2Exchange = await call(db, { action: 'exchange', code: v2.code });
  const v2View = await call(db, { action: 'view' }, null, v2Exchange.cookie.split(';')[0]);
  assert.deepEqual(v2View.body.capabilities, { externalLearning: true });
  assert.equal('activityId' in v2View.body.publicLessons[0], false);
  const v2Write = await call(db, {
    action: 'self_check_set', activityId: 'publication-a', publicationRevision: 1,
    response: 'completed', expectedRevision: 0
  }, null, v2Exchange.cookie.split(';')[0]);
  assert.equal(v2Write.status, 409);
  assert.equal(v2Write.body.code, 'STUDENT_SCOPE_RECONSENT_REQUIRED');
  const v2List = await call(db, { action: 'access_list' }, admin);
  assert.equal(v2List.body.access[0].scopeVersion, 2);
  assert.equal(v2List.body.access[0].needsScopeReconsent, true);
  assert.equal((await call(db, { action: 'view' }, null, v2Exchange.cookie.split(';')[0])).status, 200);

  const upgraded = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: v2.updatedAt
  }, admin);
  assert.equal(upgraded.status, 200);
  assert.equal((await call(db, { action: 'view' }, null, v2Exchange.cookie.split(';')[0])).status, 401);
  const v3Invite = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
  const v3Exchange = await call(db, { action: 'exchange', code: v3Invite.body.code });
  const v3View = await call(db, { action: 'view' }, null, v3Exchange.cookie.split(';')[0]);
  assert.deepEqual(v3View.body.capabilities, { externalLearning: true, selfCheck: true });
  assert.equal(v3View.body.publicLessons[0].selfCheck.revision, 0);
  const seals = db.prepare(
    'SELECT scope_version,effective_scope_version,self_check_enabled FROM student_portal_sessions ORDER BY created_at'
  ).all().results;
  assert.deepEqual(seals.map(row => [row.scope_version, row.effective_scope_version, row.self_check_enabled]),
    [[1, 1, 0], [1, 2, 0], [1, 2, 1]]);
});

test('기존 보호자 공개 기록은 학생 비공개가 기본이고 명시 공개와 철회를 정확히 따른다', async () => {
  const legacy = new TestD1(); await seed(legacy, { studentVisible: false });
  const hidden = await call(legacy, { action: 'preview', studentId: 'student-a' }, admin);
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body.publicLessons, []);

  const explicit = new TestD1(); await seed(explicit, { studentVisible: true });
  const visible = await call(explicit, { action: 'preview', studentId: 'student-a' }, admin);
  assert.equal(visible.body.publicLessons.length, 1);

  const withdrawnDb = new TestD1(); await seed(withdrawnDb, { publicationStatus: 'withdrawn' });
  const withdrawn = await call(withdrawnDb, { action: 'preview', studentId: 'student-a' }, admin);
  assert.deepEqual(withdrawn.body.publicLessons, []);
});

test('학생 최근 공개 기록은 KST 오늘을 포함한 최근 14일만 보인다', async () => {
  const kstDate = delta => new Date(Date.now() + 9 * 60 * 60 * 1000 + delta * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const boundary = new TestD1(); await seed(boundary, { studentVisible: true, publicationDate: kstDate(-14) });
  const visible = await call(boundary, { action: 'preview', studentId: 'student-a' }, admin);
  assert.equal(visible.body.publicLessons.length, 1);

  const stale = new TestD1(); await seed(stale, { studentVisible: true, publicationDate: kstDate(-15) });
  const hidden = await call(stale, { action: 'preview', studentId: 'student-a' }, admin);
  assert.deepEqual(hidden.body.publicLessons, []);
});

test('1회 코드 교환은 보호자 cookie와 분리된 HttpOnly 90일 학생 세션만 만든다', async () => {
  const db = new TestD1(); await seed(db);
  const auth = await connect(db);
  assert.match(auth.cookie, /^__Host-wb_student_session=[a-f0-9]{48}$/);
  const fullCookie = (await call(db, { action: 'invite', studentId: 'student-a' }, admin));
  assert.equal(fullCookie.status, 200);
  assert.equal(fullCookie.body.baseUrl, 'https://student.academy.example/');
  const stored = db.prepare('SELECT code_hash FROM student_portal_codes WHERE consumed_at IS NULL').first();
  assert.match(stored.code_hash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(stored.code_hash, fullCookie.body.code);
  const activeSession = await call(db, { action: 'exchange', code: fullCookie.body.code }, null, auth.cookie);
  assert.equal(activeSession.status, 409);
  assert.equal(activeSession.body.code, 'SESSION_ALREADY_ACTIVE');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM student_portal_codes WHERE consumed_at IS NULL').first().count, 1);
  const used = await call(db, { action: 'exchange', code: auth.code });
  assert.equal(used.status, 410);
  assert.equal((await call(db, { action: 'view' }, null, '__Host-wb_parent_session=' + auth.cookie.split('=')[1])).status, 401);
  const session = db.prepare('SELECT created_at,expires_at FROM student_portal_sessions').first();
  assert.equal(session.expires_at - session.created_at, 90 * 24 * 60 * 60 * 1000);
});

test('학생 DTO는 오늘·시간표·공개 숙제·안전한 교재 상태만 담고 내부·보호자 데이터는 제외한다', async () => {
  const db = new TestD1(); const seeded = await seed(db); const auth = await connect(db);
  const view = await call(db, { action: 'view' }, null, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(Object.keys(view.body).sort(),
    ['bookStatus', 'capabilities', 'generatedAt', 'ok', 'publicLessons', 'schedule', 'student', 'today'].sort());
  assert.deepEqual(view.body.capabilities, { externalLearning: true, selfCheck: true });
  assert.equal(view.body.student.name, '학생A');
  assert.equal(view.body.today.date, seeded.date);
  assert.deepEqual(view.body.today.lessons[0], {
    subject: '독해', className: '기초반', teacherName: '담당A', timeLabel: '16:00–17:00',
    attendance: 'P', completedSteps: 2, totalSteps: 5, completed: false
  });
  assert.deepEqual(view.body.today.transport, [{
    direction: 'pickup', scheduledTime: '15:20', status: 'boarded', statusAt: seeded.now
  }]);
  assert.deepEqual(view.body.publicLessons[0], {
    lessonDate: seeded.date, subject: '독해', className: '기초반', teacherName: '담당A',
    publicHomework: '공개 숙제', publicReadiness: '연필 준비', updatedAt: seeded.now,
    activityId: 'publication-a', publicationRevision: 1,
    selfCheck: { response: '', reviewStatus: '', revision: 0, updatedAt: null, confirmedAt: null,
      finalCompleted: false }
  });
  assert.deepEqual(view.body.bookStatus, [{
    kind: 'distribution', title: '배정 교재', stage: 'preparing', label: '교재 준비 중', updatedAt: seeded.now
  }]);
  const raw = JSON.stringify(view.body);
  assert.doesNotMatch(raw, /01012345678|학생B|student-a|lesson-a|route-a|stop-a|staff-a|9002|학생 비공개 주소/);
  assert.doesNotMatch(raw, /내부 특성|학부모 내부 요청|교사용 내부 지시|오늘 내부 메모|내부 차단 사유|기사 내부 메모/);
  assert.doesNotMatch(raw, /학부모에게만 보낸 비밀 피드백|guardian-request-a|consultation/);
  assert.doesNotMatch(raw, /https?:\/\//i);
  assert.doesNotMatch(raw, /[a-f0-9]{64}/i);
  for (const forbidden of ['feedback', 'guardianRequests', 'makeups', 'sessionPacks', 'announcements', 'onboarding']) {
    assert.equal(forbidden in view.body, false);
  }
});

test('이용 철회·명단 이름 변경은 코드와 세션을 폐기하고 새 identity 연결을 요구한다', async () => {
  const db = new TestD1(); await seed(db); const auth = await connect(db);
  const access = db.prepare("SELECT updated_at FROM student_portal_access WHERE student_id='student-a'").first();
  const disabled = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: false, expectedUpdatedAt: access.updated_at
  }, admin);
  assert.equal(disabled.status, 200);
  assert.equal(db.prepare('SELECT revoked FROM student_portal_sessions').first().revoked, 1);
  assert.equal((await call(db, { action: 'view' }, null, auth.cookie)).status, 401);

  const reenabled = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: disabled.body.access.updatedAt
  }, admin);
  assert.equal(reenabled.status, 200);
  const invited = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
  const connected = await call(db, { action: 'exchange', code: invited.body.code });
  assert.equal(connected.status, 200);
  const row = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const document = JSON.parse(row.data); document.roster.students[0].name = '학생A개명';
  document.bookStudents[0].name = '학생A개명';
  db.prepare("UPDATE private_rosters SET data=?,updated_at=updated_at+1 WHERE app='task'")
    .bind(JSON.stringify(document)).run();
  assert.equal(db.prepare("SELECT revoked FROM student_portal_sessions ORDER BY created_at DESC LIMIT 1").first().revoked, 1);
  assert.equal((await call(db, { action: 'invite', studentId: 'student-a' }, admin)).status, 409);
  db.prepare("UPDATE guardian_contacts_by_student SET student_name=?,updated_at=updated_at+1 WHERE app='task' AND student_id='student-a'")
    .bind('학생A개명').run();
  const refreshed = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: reenabled.body.access.updatedAt
  }, admin);
  assert.equal(refreshed.status, 200);
  const finalInvite = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
  const finalSession = await call(db, { action: 'exchange', code: finalInvite.body.code });
  assert.equal(finalSession.status, 200);
  db.prepare("UPDATE guardian_contacts_by_student SET phone=?,updated_at=updated_at+1 WHERE app='task' AND student_id='student-a'")
    .bind('01087654321').run();
  assert.equal(db.prepare("SELECT revoked FROM student_portal_sessions ORDER BY created_at DESC LIMIT 1").first().revoked, 1);
});

test('네 번째 기기 연결 뒤 활성 학생 세션은 최신 세 개뿐이고 동일 코드는 동시에 한 번만 교환된다', async () => {
  const db = new TestD1(); await seed(db);
  const enabled = await call(db, {
    action: 'access_set', studentId: 'student-a', enabled: true, consentConfirmed: true,
    scopeVersion: 3, expectedUpdatedAt: 0
  }, admin);
  assert.equal(enabled.status, 200);
  for (let index = 0; index < 4; index += 1) {
    const invite = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
    assert.equal((await call(db, { action: 'exchange', code: invite.body.code })).status, 200);
  }
  assert.equal(db.prepare("SELECT COUNT(*) count FROM student_portal_sessions WHERE revoked=0").first().count, 3);
  const invite = await call(db, { action: 'invite', studentId: 'student-a' }, admin);
  const results = await Promise.all([
    call(db, { action: 'exchange', code: invite.body.code }),
    call(db, { action: 'exchange', code: invite.body.code })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
});

test('학생 공개 동작은 허용 키 외 이름·연락처·메모 주입을 거부하고 logout은 세션을 해지한다', async () => {
  const db = new TestD1(); await seed(db); const auth = await connect(db);
  assert.equal((await call(db, { action: 'view', phone: '01000000000' }, null, auth.cookie)).status, 400);
  assert.equal((await call(db, { action: 'exchange', code: auth.code, studentName: '학생B' })).status, 400);
  const loggedOut = await call(db, { action: 'logout' }, null, auth.cookie);
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.cookie, /__Host-wb_student_session=;/);
  assert.match(loggedOut.cookie, /HttpOnly/);
  assert.match(loggedOut.cookie, /Secure/);
  assert.match(loggedOut.cookie, /SameSite=Strict/);
  assert.equal((await call(db, { action: 'view' }, null, auth.cookie)).status, 401);
});

test('학생 자기 체크는 오늘 공개 카드와 세션 학생으로만 저장되고 담당 확인 뒤에만 최종 완료된다', async () => {
  const db = new TestD1(); const seeded = await seed(db); const auth = await connect(db);
  const beforeCheck = db.prepare("SELECT data FROM checks WHERE app='task' AND k=?")
    .bind('lesson-a|' + seeded.date).first().data;
  const view = await call(db, { action: 'view' }, null, auth.cookie);
  const activity = view.body.publicLessons[0];
  assert.equal(activity.activityId, 'publication-a');
  assert.equal(activity.selfCheck.revision, 0);

  const submitted = await call(db, {
    action: 'self_check_set', activityId: activity.activityId,
    publicationRevision: activity.publicationRevision, response: 'help_needed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.deepEqual(submitted.body.selfCheck.reviewStatus, 'pending');
  assert.equal(submitted.body.selfCheck.finalCompleted, false);
  assert.equal(submitted.body.selfCheck.revision, 1);

  const retry = await call(db, {
    action: 'self_check_set', activityId: activity.activityId,
    publicationRevision: activity.publicationRevision, response: 'help_needed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM student_lesson_self_check_events").first().count, 1);

  const rootList = await call(db, { action: 'self_check_list', lessonDate: seeded.date }, admin);
  assert.equal(rootList.status, 403);
  const otherList = await call(db, { action: 'self_check_list', lessonDate: seeded.date },
    { scope: 'own', id: 'staff-b' });
  assert.equal(otherList.status, 200);
  assert.deepEqual(otherList.body.selfChecks, []);
  const ownerList = await call(db, { action: 'self_check_list', lessonDate: seeded.date },
    { scope: 'own', id: 'staff-a' });
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.body.selfChecks[0].taskId, 'lesson-a');
  assert.equal(ownerList.body.selfChecks[0].response, 'help_needed');
  assert.equal('studentId' in ownerList.body.selfChecks[0], false);

  const forbidden = await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 1
  }, { scope: 'own', id: 'staff-b' });
  assert.equal(forbidden.status, 403);
  const acknowledged = await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 1
  }, { scope: 'all', role: 'manager', id: 'staff-a' });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.selfCheck.reviewStatus, 'confirmed');
  assert.equal(acknowledged.body.selfCheck.finalCompleted, false);
  assert.equal(acknowledged.body.selfCheck.revision, 2);
  const confirmedRetry = await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 1
  }, { scope: 'own', id: 'staff-a' });
  assert.equal(confirmedRetry.status, 200);
  assert.equal(confirmedRetry.body.idempotent, true);

  const completed = await call(db, {
    action: 'self_check_set', activityId: activity.activityId,
    publicationRevision: activity.publicationRevision, response: 'completed', expectedRevision: 2
  }, null, auth.cookie);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.selfCheck.reviewStatus, 'pending');
  assert.equal(completed.body.selfCheck.finalCompleted, false);
  const finalized = await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 3
  }, { scope: 'own', id: 'staff-a' });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.selfCheck.reviewStatus, 'confirmed');
  assert.equal(finalized.body.selfCheck.finalCompleted, true);
  const cannotReopen = await call(db, {
    action: 'self_check_set', activityId: activity.activityId,
    publicationRevision: activity.publicationRevision, response: 'help_needed', expectedRevision: 4
  }, null, auth.cookie);
  assert.equal(cannotReopen.status, 409);
  assert.equal(cannotReopen.body.code, 'SELF_CHECK_FINALIZED');
  assert.throws(() => db.prepare(
    "UPDATE student_lesson_self_checks SET response='help_needed',revision=revision+1," +
    'responded_at=updated_at+1,confirmed_at=NULL,confirmed_by=NULL,updated_at=updated_at+1 ' +
    "WHERE app='task' AND publication_id='publication-a'"
  ).run(), /STUDENT_SELF_CHECK_INVALID_TRANSITION/);
  assert.deepEqual(db.prepare("SELECT event_type,response,actor_type,actor_id FROM student_lesson_self_check_events " +
    'ORDER BY revision').all().results.map(row => ({ ...row })), [
    { event_type: 'student_set', response: 'help_needed', actor_type: 'student', actor_id: 'student-a' },
    { event_type: 'teacher_confirmed', response: 'help_needed', actor_type: 'staff', actor_id: 'staff-a' },
    { event_type: 'student_set', response: 'completed', actor_type: 'student', actor_id: 'student-a' },
    { event_type: 'teacher_confirmed', response: 'completed', actor_type: 'staff', actor_id: 'staff-a' }
  ]);
  assert.equal(db.prepare("SELECT data FROM checks WHERE app='task' AND k=?")
    .bind('lesson-a|' + seeded.date).first().data, beforeCheck);
});

test('자기 체크는 v3·오늘·현재 공개 revision을 요구하고 stale·임의 학생·추가 입력을 거부한다', async () => {
  const db = new TestD1(); const seeded = await seed(db); const auth = await connect(db);
  const activity = (await call(db, { action: 'view' }, null, auth.cookie)).body.publicLessons[0];
  assert.equal((await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'done', expectedRevision: 0
  }, null, auth.cookie)).status, 400);
  assert.equal((await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'completed', expectedRevision: 0, studentId: 'student-b'
  }, null, auth.cookie)).status, 400);
  assert.equal((await call(db, {
    action: 'self_check_set', activityId: 'publication-b', publicationRevision: 1,
    response: 'completed', expectedRevision: 0
  }, null, auth.cookie)).status, 409);

  const submitted = await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'completed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(submitted.status, 200);
  const staleDifferent = await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'help_needed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(staleDifferent.status, 409);
  assert.equal(staleDifferent.body.code, 'SELF_CHECK_REVISION_CONFLICT');
  assert.equal((await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 1
  }, { scope: 'own', id: 'staff-a' })).status, 200);

  db.prepare(
    "UPDATE guardian_lesson_publications SET public_homework=?,revision=revision+1,updated_at=updated_at+1 " +
    "WHERE app='task' AND publication_id=?"
  ).bind('새 공개 숙제', activity.activityId).run();
  const oldRevision = await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'completed', expectedRevision: 1
  }, null, auth.cookie);
  assert.equal(oldRevision.status, 409);
  const refreshed = await call(db, { action: 'view' }, null, auth.cookie);
  assert.equal(refreshed.body.publicLessons[0].publicationRevision, 2);
  assert.equal(refreshed.body.publicLessons[0].selfCheck.revision, 0);
  const resubmitted = await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 2,
    response: 'completed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(resubmitted.status, 200);
  assert.equal(resubmitted.body.selfCheck.revision, 3);
  assert.equal((await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 3
  }, { scope: 'own', id: 'staff-a' })).status, 200);

  db.prepare(
    "UPDATE guardian_lesson_publications SET status='withdrawn',public_homework='',public_readiness=''," +
    "student_visible=0,revision=revision+1,updated_at=updated_at+1 WHERE app='task' AND publication_id=?"
  ).bind(activity.activityId).run();
  assert.equal((await call(db, {
    action: 'self_check_confirm', activityId: activity.activityId, expectedRevision: 2
  }, { scope: 'own', id: 'staff-a' })).status, 403);
  assert.equal((await call(db, { action: 'self_check_list', lessonDate: seeded.date },
    { scope: 'own', id: 'staff-a' })).body.selfChecks.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM student_lesson_self_check_events").first().count, 4);
});

test('손상된 current 학생 identity는 다른 학생 세션으로 덮어쓰거나 event 없이 변경하지 않는다', async () => {
  const db = new TestD1(); const seeded = await seed(db); const auth = await connect(db);
  const wrongIdentityHash = await sha256Hex('student-id\nstudent-b');
  db.prepare(
    'INSERT INTO student_lesson_self_checks(app,publication_id,publication_revision,student_id,' +
    'student_identity_hash,response,revision,responded_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', 'publication-a', 1, 'student-b', wrongIdentityHash, 'help_needed', 1,
    seeded.now, seeded.now, seeded.now).run();

  const result = await call(db, {
    action: 'self_check_set', activityId: 'publication-a', publicationRevision: 1,
    response: 'completed', expectedRevision: 0
  }, null, auth.cookie);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'SELF_CHECK_REVISION_CONFLICT');
  assert.deepEqual({ ...db.prepare(
    "SELECT student_id,student_identity_hash,response,revision FROM student_lesson_self_checks WHERE app='task'"
  ).first() }, {
    student_id: 'student-b', student_identity_hash: wrongIdentityHash, response: 'help_needed', revision: 1
  });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM student_lesson_self_check_events').first().count, 0);
});

test('자기 체크 DB는 24시간 30회 상한과 current 전이·event 불변성을 직접 강제한다', async () => {
  const db = new TestD1(); await seed(db); const auth = await connect(db);
  const activity = (await call(db, { action: 'view' }, null, auth.cookie)).body.publicLessons[0];
  let revision = 0;
  for (let index = 0; index < 30; index += 1) {
    const response = index % 2 ? 'completed' : 'help_needed';
    const saved = await call(db, {
      action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
      response, expectedRevision: revision
    }, null, auth.cookie);
    assert.equal(saved.status, 200);
    revision = saved.body.selfCheck.revision;
  }
  const limited = await call(db, {
    action: 'self_check_set', activityId: activity.activityId, publicationRevision: 1,
    response: 'help_needed', expectedRevision: revision
  }, null, auth.cookie);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'SELF_CHECK_RATE_LIMIT');
  assert.equal(db.prepare("SELECT revision FROM student_lesson_self_checks").first().revision, 30);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM student_lesson_self_check_events").first().count, 30);

  assert.throws(() => db.prepare(
    "UPDATE student_lesson_self_checks SET revision=revision+2,updated_at=updated_at+1 WHERE app='task'"
  ).run(), /STUDENT_SELF_CHECK_INVALID_TRANSITION/);
  assert.throws(() => db.prepare(
    "UPDATE student_lesson_self_checks SET student_id='student-b',revision=revision+1,updated_at=updated_at+1 " +
    "WHERE app='task'"
  ).run(), /STUDENT_SELF_CHECK_INVALID_TRANSITION/);
  assert.throws(() => db.prepare("DELETE FROM student_lesson_self_checks WHERE app='task'").run(),
    /STUDENT_SELF_CHECK_HISTORY_REQUIRED/);
  assert.throws(() => db.prepare(
    "UPDATE student_lesson_self_check_events SET actor_id='staff-b' WHERE app='task'"
  ).run(), /STUDENT_SELF_CHECK_EVENT_APPEND_ONLY/);
  assert.throws(() => db.prepare("DELETE FROM student_lesson_self_check_events WHERE app='task'").run(),
    /STUDENT_SELF_CHECK_EVENT_APPEND_ONLY/);
});
