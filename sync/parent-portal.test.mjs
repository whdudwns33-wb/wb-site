import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import { issueGuardianPortalInvite } from './parent-portal.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/027_parent_portal.sql', import.meta.url), 'utf8');
const scopeMigration = fs.readFileSync(new URL('./migrations/034_parent_portal_scope.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes || 0) } }; }
}
class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.database.exec('DROP TABLE IF EXISTS guardian_portal_responses; DROP TABLE IF EXISTS guardian_portal_sessions; ' +
      'DROP TABLE IF EXISTS guardian_portal_codes; DROP TABLE IF EXISTS guardian_portal_access;');
    this.database.exec(migration);
    this.database.exec(scopeMigration);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const env = db => ({ DB: db, TASK_ADMIN_SECRET: 'director-secret', CONSULT_ADMIN_SECRET: 'consult-secret' });

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function call(db, body, cookie = '', origin = 'https://worker.example') {
  const response = await worker.fetch(new Request('https://worker.example/parent-portal', {
    method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ app: 'task', ...body })
  }), env(db));
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') || '' };
}

function seed(db) {
  const now = Date.now();
  const month = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const roster = { roster: { updated: month + '-01', baseline: month, students: [
    { id: 'student-a', name: '학생A', grade: '초2', start: month, end: '', teacherIds: ['staff-a'], memo: '외부 비공개' },
    { id: 'student-b', name: '학생B', grade: '초3', start: month, end: '', teacherIds: ['staff-b'] }
  ] }, bookStudents: [] };
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster), now).run();
  db.prepare('INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)')
    .bind('task', 'student-a', '학생A', '01012345678', 1, now, 'director').run();
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'staff-a', 'staff-a', JSON.stringify({ id: 'staff-a', name: '담당A', deleted: false }), now, now).run();
  const task = {
    id: 'lesson-a', staffId: 'staff-a', studentId: 'student-a', studentName: '학생A', grade: '초2',
    subject: '독해', className: '기초반', taskKind: 'lesson_instruction', scheduleStatus: 'confirmed', deleted: false,
    scheduleSlots: [{ days: [2, 4], startTime: '16:00', endTime: '17:00' }],
    studentTraits: '내부 특성', parentRequest: '내부 요청', guide: '내부 수업지시'
  };
  const other = { ...task, id: 'lesson-b', studentId: 'student-b', studentName: '학생B' };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'staff-a', JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', other.id, 'staff-b', JSON.stringify(other), now, now).run();
}

function seedToday(db) {
  const now = Date.now();
  const shifted = new Date(now + 9 * 60 * 60 * 1000);
  const date = shifted.toISOString().slice(0, 10);
  const weekday = shifted.getUTCDay();
  const taskRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  task.scheduleSlots = [{ days: [weekday], startTime: '16:00', endTime: '17:00' }];
  db.prepare("UPDATE tasks SET data=?,updated_at=?,srv_at=? WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify(task), now + 1, now + 1).run();
  const steps = {
    'lesson-a-standard-step-1': true,
    'lesson-a-standard-step-2': true
  };
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', 'lesson-a|' + date, 'staff-a', JSON.stringify({
      taskId: 'lesson-a', date, att: 'P', steps,
      note: '보호자에게 숨길 당일 내부 메모', blocked: '내부 차단 사유'
    }), now, now).run();
  const config = {
    baseAddress: '외부 비공개 학원 주소',
    vehicles: [{ id: 'vehicle-a', name: '8호차', plate: '9002', capacity: 11 }],
    routes: [{
      id: 'route-a', name: '학생 이름이 들어갈 수 있는 내부 노선명', active: true,
      direction: 'pickup', days: [weekday], startTime: '15:00',
      vehicleId: 'vehicle-a', driverId: 'staff-a',
      stops: [
        { id: 'stop-a', name: '외부 비공개 정류장명', address: '외부 비공개 정류장 주소',
          time: '15:20', studentIds: ['student-a'] },
        { id: 'stop-b', name: '학생B 집 앞', address: '학생B 주소', time: '15:30', studentIds: ['student-b'] }
      ]
    }]
  };
  db.prepare('INSERT INTO transport_configs(app,data,updated_at,updated_by) VALUES(?,?,?,?)')
    .bind('task', JSON.stringify(config), now, 'director').run();
  db.prepare(
    'INSERT INTO transport_states(app,date,route_id,student_id,status,revision,boarded_at,boarded_by,' +
    'history,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', date, 'route-a', 'student-a', 'boarded', 1, now, 'staff-a',
    JSON.stringify([{ event: 'boarded', note: '외부 비공개 운행 메모' }]), now).run();
  return { date, now };
}

function seedAwaitingMakeup(db, caseId = 'mu_parent_case') {
  const now = Date.now();
  const sourceDate = caseId.includes('confirm') ? '2026-08-11' : '2026-08-10';
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,proposed_start_at,proposed_end_at,proposed_staff_id,' +
    'notification_needed,notification_event,notification_event_revision,history,created_at,updated_at) ' +
    "VALUES(?,?,?,?,?,?,?,'awaiting_parent',3,?,?,?,1,'proposal',3,?,?,?)"
  ).bind('task', caseId, 'student-a', 'lesson-a', sourceDate, 'staff-a', 'mc_' + caseId,
    '2026-08-20T16:00:00+09:00', '2026-08-20T17:00:00+09:00', 'staff-a',
    JSON.stringify([]), now, now).run();
  return caseId;
}

async function connected(db) {
  const current = db.prepare("SELECT updated_at FROM guardian_portal_access WHERE student_id='student-a'").first();
  const allowed = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: current ? Number(current.updated_at) : 0 }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(allowed.status, 200);
  const invited = await call(db, { auth: admin, action: 'invite', studentId: 'student-a' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(invited.status, 200);
  assert.match(invited.body.code, /^[a-f0-9]{48}$/);
  assert.equal('studentId' in invited.body, false);
  const exchanged = await call(db, { action: 'exchange', code: invited.body.code });
  assert.equal(exchanged.status, 200);
  assert.equal('token' in exchanged.body, false);
  assert.match(exchanged.cookie, /__Host-wb_parent_session=[a-f0-9]{48}/);
  assert.match(exchanged.cookie, /HttpOnly/);
  assert.match(exchanged.cookie, /Secure/);
  assert.match(exchanged.cookie, /SameSite=Strict/);
  return { code: invited.body.code, cookie: exchanged.cookie.split(';')[0] };
}

test('신규 schema와 운영 027→034 적용 결과의 보호자 공개 동의 구조가 같다', () => {
  const fresh = new DatabaseSync(':memory:');
  const upgraded = new DatabaseSync(':memory:');
  fresh.exec(schema);
  const marker = schema.indexOf('-- 보호자 웹앱 초대·세션·정형 응답.');
  upgraded.exec(schema.slice(0, marker));
  upgraded.exec(migration);
  upgraded.exec(scopeMigration);
  const columns = database => database.prepare('PRAGMA table_info(guardian_portal_access)').all()
    .map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
  assert.deepEqual(columns(upgraded), columns(fresh));
  const trigger = database => database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_guardian_portal_access_revoke'"
  ).get().sql.replace(/IF NOT EXISTS\s*/i, '').replace(/\s+/g, ' ').trim();
  assert.equal(trigger(upgraded), trigger(fresh));
});

test('원장만 동의·연락처가 준비된 stable 학생 초대를 발급한다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { action: 'invite', studentId: 'student-a' })).status, 403);
  assert.equal((await call(db, { auth: admin, action: 'invite', studentId: 'student-b' })).status, 409);
  assert.equal((await call(db, { auth: admin, action: 'invite', studentId: 'student-a' })).status, 409,
    '보호자 앱 동의는 피드백 발송 동의와 별도로 받아야 한다');
  assert.equal((await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true, scopeVersion: 2, expectedUpdatedAt: 0 }, '', 'https://whdudwns33-wb.github.io')).status, 200);
  const invite = await call(db, { auth: admin, action: 'invite', studentId: 'student-a' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(invite.status, 200);
  const stored = db.prepare('SELECT code_hash FROM guardian_portal_codes').first().code_hash;
  assert.match(stored, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(stored, invite.body.code);
});

test('직원 초대 API와 내부 발송 helper가 같은 24시간·기존 unused revoke 계약을 사용한다', async () => {
  const db = new TestD1(); seed(db);
  const allowed = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true, scopeVersion: 2, expectedUpdatedAt: 0
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(allowed.status, 200);
  const now = Date.now();
  const internal = await issueGuardianPortalInvite({ DB: db }, {
    studentId: 'student-a', issuedBy: 'director', now
  });
  assert.equal(internal.ok, true);
  assert.match(internal.code, /^[a-f0-9]{48}$/);
  assert.equal(internal.expiresAt, now + 24 * 60 * 60 * 1000);

  const staff = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(staff.status, 200);
  assert.notEqual(staff.body.code, internal.code);
  const codes = db.prepare('SELECT code_hash,revoked FROM guardian_portal_codes').all().results;
  assert.equal(codes.length, 2);
  assert.deepEqual(codes.map(row => row.revoked).sort(), [0, 1]);
  assert.equal(JSON.stringify(codes).includes(internal.code), false);
});

test('초대 코드는 한 번만 교환되고 세션은 해당 학생 공개 정보만 본다', async () => {
  const db = new TestD1(); seed(db);
  const auth = await connected(db);
  const reused = await call(db, { action: 'exchange', code: auth.code });
  assert.equal(reused.status, 410);
  assert.equal(reused.body.code, 'LINK_USED');

  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.equal(Number.isFinite(view.body.generatedAt), true);
  assert.equal(view.body.student.name, '학생A');
  assert.equal(view.body.schedule.length, 1);
  assert.equal(view.body.schedule[0].teacherName, '담당A');
  const raw = JSON.stringify(view.body);
  assert.doesNotMatch(raw, /01012345678|외부 비공개|내부 특성|내부 요청|내부 수업지시|학생B/);
});

test('공개 범위 v2에서만 오늘 수업 진행과 최소 차량 확인을 stable 학생 ID로 본다', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const auth = await connected(db);
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.capabilities, { today: true, scopeVersion: 2, requiredScopeVersion: 2 });
  assert.equal(view.body.today.date, today.date);
  assert.equal(view.body.today.lessons.length, 1);
  assert.deepEqual(view.body.today.lessons[0], {
    subject: '독해', className: '기초반', teacherName: '담당A', timeLabel: '16:00–17:00',
    attendance: 'P', completedSteps: 2, totalSteps: 5, completed: false
  });
  assert.deepEqual(view.body.today.transport, [{
    direction: 'pickup', scheduledTime: '15:20', status: 'boarded', statusAt: today.now
  }]);
  assert.equal(view.body.summary.todayLessons, 1);
  assert.equal(view.body.summary.todayCompleted, 0);
  const raw = JSON.stringify(view.body);
  assert.doesNotMatch(raw, /01012345678|당일 내부 메모|내부 차단 사유|외부 비공개|학생B|9002|route-a|stop-a|staff-a|운행 메모/);

  db.prepare("UPDATE checks SET owner='staff-b' WHERE app='task' AND k=?").bind('lesson-a|' + today.date).run();
  const wrongOwner = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(wrongOwner.status, 200);
  assert.equal(wrongOwner.body.today.lessons[0].attendance, '');
  assert.equal(wrongOwner.body.today.lessons[0].completedSteps, 0);

  const staleTaskRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const staleTask = JSON.parse(staleTaskRow.data);
  staleTask.staffId = 'staff-b';
  db.prepare("UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify(staleTask)).run();
  const staleAssignment = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(staleAssignment.body.today.lessons.length, 0);
  assert.equal(staleAssignment.body.schedule.length, 0,
    '오늘 수업과 주간 시간표가 같은 현재 assignment 검증을 사용한다');
});

test('같은 보호자 전화번호의 형제도 학생별 동의·초대 없이 자동 결합하지 않는다', async () => {
  const db = new TestD1(); seed(db);
  db.prepare(
    'INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?)'
  ).bind('task', 'student-b', '학생B', '01012345678', 1, Date.now(), 'director').run();
  const a = await connected(db);
  const allowedB = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-b', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: 0
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(allowedB.status, 200);
  const inviteB = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-b'
  }, '', 'https://whdudwns33-wb.github.io');
  const exchangedB = await call(db, { action: 'exchange', code: inviteB.body.code });
  const bCookie = exchangedB.cookie.split(';')[0];
  const viewA = await call(db, { action: 'view' }, a.cookie);
  const viewB = await call(db, { action: 'view' }, bCookie);
  assert.equal(viewA.body.student.name, '학생A');
  assert.equal(viewB.body.student.name, '학생B');
  assert.doesNotMatch(JSON.stringify(viewA.body), /학생B/);
  assert.doesNotMatch(JSON.stringify(viewB.body), /학생A/);
});

test('기존 v1 연결은 기존 정보만 유지하고 v2 재동의 뒤 새 세션에서만 오늘 현황을 연다', async () => {
  const db = new TestD1(); seed(db); seedToday(db);
  const initial = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: 0
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(initial.status, 200);
  db.prepare(
    "UPDATE guardian_portal_access SET scope_version=1,updated_at=updated_at+1 WHERE app='task' AND student_id='student-a'"
  ).run();
  const revision = db.prepare(
    "SELECT updated_at FROM guardian_portal_access WHERE app='task' AND student_id='student-a'"
  ).first().updated_at;

  const directInvite = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(directInvite.status, 409);
  assert.equal(directInvite.body.code, 'PORTAL_CONSENT_VERSION_REQUIRED');

  const legacyInvite = await issueGuardianPortalInvite({ DB: db }, {
    studentId: 'student-a', issuedBy: 'director', requiredScopeVersion: 1
  });
  assert.equal(legacyInvite.ok, true);
  const legacyExchange = await call(db, { action: 'exchange', code: legacyInvite.code });
  const legacyCookie = legacyExchange.cookie.split(';')[0];
  const legacyView = await call(db, { action: 'view' }, legacyCookie);
  assert.equal(legacyView.status, 200);
  assert.deepEqual(legacyView.body.capabilities, { today: false, scopeVersion: 1, requiredScopeVersion: 2 });
  assert.equal('today' in legacyView.body, false);
  assert.equal('todayLessons' in legacyView.body.summary, false);
  assert.equal(legacyView.body.schedule.length, 1);

  const listed = await call(db, { auth: admin, action: 'access_list' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(listed.body.access[0].enabled, false);
  assert.equal(listed.body.access[0].needsScopeReconsent, true);
  assert.equal((await call(db, { action: 'view' }, legacyCookie)).status, 200,
    '목적 범위 재동의 안내만으로 기존 v1 세션을 강제 종료하지 않는다');

  const oldClient = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true, expectedUpdatedAt: revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(oldClient.status, 409);
  assert.equal(oldClient.body.code, 'PORTAL_CONSENT_VERSION_REQUIRED');
  assert.equal(db.prepare("SELECT scope_version FROM guardian_portal_access WHERE student_id='student-a'").first().scope_version, 1);

  const upgraded = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.body.access.scopeVersion, 2);
  assert.equal((await call(db, { action: 'view' }, legacyCookie)).status, 401);
});

test('만료·로그아웃 세션은 다시 사용할 수 없다', async () => {
  const db = new TestD1(); seed(db);
  let auth = await connected(db);
  assert.equal((await call(db, { action: 'logout' }, auth.cookie)).status, 200);
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);

  auth = await connected(db);
  db.prepare('UPDATE guardian_portal_sessions SET expires_at=0').run();
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);
});

test('같은 학생의 유효한 cookie로 새 CTA를 열면 코드만 소비하고 세션을 늘리지 않는다', async () => {
  const db = new TestD1(); seed(db);
  const auth = await connected(db);
  assert.equal(db.prepare("SELECT count(*) n FROM guardian_portal_sessions WHERE revoked=0").first().n, 1);
  const invited = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(invited.status, 200);
  const reused = await call(db, { action: 'exchange', code: invited.body.code }, auth.cookie);
  assert.equal(reused.status, 200);
  assert.equal(reused.body.reusedSession, true);
  assert.equal(reused.cookie, '');
  assert.equal(db.prepare("SELECT count(*) n FROM guardian_portal_sessions WHERE revoked=0").first().n, 1);
  assert.equal(db.prepare(
    'SELECT consumed_at IS NOT NULL AS consumed FROM guardian_portal_codes WHERE revoked=0 ORDER BY created_at DESC LIMIT 1'
  ).first().consumed, 1);
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 200);
});

test('보호자 앱 동의를 철회하면 초대와 활성 세션을 함께 해지한다', async () => {
  const db = new TestD1(); seed(db);
  const auth = await connected(db);
  const current = db.prepare("SELECT updated_at FROM guardian_portal_access WHERE student_id='student-a'").first();
  const disabled = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: false,
    expectedUpdatedAt: current.updated_at }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(disabled.status, 200);
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);
  assert.equal(db.prepare('SELECT revoked FROM guardian_portal_sessions').first().revoked, 1);
});

test('동일한 이용 동의 저장은 idempotent이고, 해제는 명단·연락처 없이도 CAS로 성공한다', async () => {
  const db = new TestD1(); seed(db);
  const auth = await connected(db);
  const before = db.prepare(
    "SELECT enabled,accepted_at,updated_at FROM guardian_portal_access WHERE student_id='student-a'"
  ).first();
  const same = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: before.updated_at
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(same.status, 200);
  assert.equal(same.body.idempotent, true);
  assert.equal(same.body.access.updatedAt, before.updated_at);
  assert.equal(same.body.access.acceptedAt, before.accepted_at);
  assert.equal(db.prepare('SELECT revoked FROM guardian_portal_sessions').first().revoked, 0);

  db.prepare("DELETE FROM guardian_contacts_by_student WHERE app='task' AND student_id='student-a'").run();
  db.prepare("DELETE FROM private_rosters WHERE app='task'").run();
  const disabled = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: false,
    expectedUpdatedAt: before.updated_at
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.access.enabled, false);
  assert.equal(db.prepare('SELECT revoked FROM guardian_portal_sessions').first().revoked, 1);
});

test('보호자 전화가 바뀌면 기존 동의를 승계하지 않고 재동의 후에만 초대한다', async () => {
  const db = new TestD1(); seed(db);
  const auth = await connected(db);
  const staleInvite = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(staleInvite.status, 200);
  const codeCountBefore = db.prepare('SELECT COUNT(*) count FROM guardian_portal_codes').first().count;
  const accessBefore = db.prepare(
    "SELECT guardian_identity_hash,updated_at FROM guardian_portal_access WHERE student_id='student-a'"
  ).first();
  assert.match(accessBefore.guardian_identity_hash, /^[a-f0-9]{64}$/);

  db.prepare(
    "UPDATE guardian_contacts_by_student SET phone='01099998888',updated_at=updated_at+1 " +
    "WHERE app='task' AND student_id='student-a'"
  ).run();
  const listed = await call(db, { auth: admin, action: 'access_list' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.access[0].enabled, false);
  assert.equal(listed.body.access[0].needsReconsent, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM guardian_portal_sessions WHERE revoked=0").first().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM guardian_portal_codes WHERE revoked=0").first().n, 0);
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);
  assert.equal((await call(db, { action: 'exchange', code: staleInvite.body.code })).status, 410);

  const blocked = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'PORTAL_RECONSENT_REQUIRED');
  const internalBlocked = await issueGuardianPortalInvite({ DB: db }, {
    studentId: 'student-a', issuedBy: 'director'
  });
  assert.equal(internalBlocked.ok, false);
  assert.equal(internalBlocked.errorCode, 'PORTAL_RECONSENT_REQUIRED');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_codes').first().count, codeCountBefore,
    '연락처 변경 후에는 새 code를 발급하지 않는다');

  const renewed = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: accessBefore.updated_at
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.idempotent, undefined);
  assert.equal(renewed.body.access.needsReconsent, false);
  const accessAfter = db.prepare(
    "SELECT guardian_identity_hash,updated_at FROM guardian_portal_access WHERE student_id='student-a'"
  ).first();
  assert.notEqual(accessAfter.guardian_identity_hash, accessBefore.guardian_identity_hash);
  assert.equal(accessAfter.updated_at > accessBefore.updated_at, true);
  const relisted = await call(db, { auth: admin, action: 'access_list' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(relisted.body.access[0].enabled, true);
  assert.equal(relisted.body.access[0].needsReconsent, false);
  const freshInvite = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(freshInvite.status, 200);
  assert.match(freshInvite.body.code, /^[a-f0-9]{48}$/);
});

test('공개 보호자 동작은 Worker same-origin에서만 허용한다', async () => {
  const db = new TestD1(); seed(db);
  const denied = await call(db, { action: 'view' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(denied.status, 403);
});

test('보호자 연락처나 동의 revision이 바뀌면 기존 세션을 폐기한다', async () => {
  const db = new TestD1(); seed(db);
  let auth = await connected(db);
  db.prepare("UPDATE guardian_contacts_by_student SET phone='01099998888',updated_at=updated_at+1 WHERE student_id='student-a'").run();
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);
  assert.equal(db.prepare('SELECT revoked FROM guardian_portal_sessions').first().revoked, 1);

  db.prepare("UPDATE guardian_contacts_by_student SET phone='01012345678',updated_at=updated_at+1 WHERE student_id='student-a'").run();
  const access = db.prepare("SELECT updated_at FROM guardian_portal_access WHERE student_id='student-a'").first();
  const toggled = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: access.updated_at }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(toggled.status, 200);
  assert.equal((await call(db, { action: 'view' }, auth.cookie)).status, 401);
});

test('동의 저장은 CAS이고 네 번째 교환 뒤 활성 세션은 세 개뿐이다', async () => {
  const db = new TestD1(); seed(db);
  const first = await connected(db);
  const revision = db.prepare("SELECT updated_at FROM guardian_portal_access WHERE student_id='student-a'").first().updated_at;
  const stale = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: false,
    expectedUpdatedAt: revision - 1 }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(stale.status, 409);

  const cookies = [first.cookie];
  for (let i = 0; i < 3; i++) {
    const invite = await call(db, { auth: admin, action: 'invite', studentId: 'student-a' }, '', 'https://whdudwns33-wb.github.io');
    const exchanged = await call(db, { action: 'exchange', code: invite.body.code });
    assert.equal(exchanged.status, 200);
    cookies.push(exchanged.cookie.split(';')[0]);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM guardian_portal_sessions WHERE revoked=0").first().n, 3);
  assert.equal((await call(db, { action: 'view' }, cookies[0])).status, 401);
  assert.equal((await call(db, { action: 'view' }, cookies[3])).status, 200);
});

test('같은 1회 코드를 동시에 교환해도 세션은 하나만 생긴다', async () => {
  const db = new TestD1(); seed(db);
  const allowed = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: 0 }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(allowed.status, 200);
  const invited = await call(db, { auth: admin, action: 'invite', studentId: 'student-a' }, '', 'https://whdudwns33-wb.github.io');
  const results = await Promise.all([
    call(db, { action: 'exchange', code: invited.body.code }),
    call(db, { action: 'exchange', code: invited.body.code })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 410]);
  assert.equal(db.prepare("SELECT count(*) n FROM guardian_portal_sessions WHERE revoked=0").first().n, 1);
});

test('보호자 응답과 관리자 확정은 어느 쪽이 먼저여도 동시에 성립하지 않는다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const firstCase = seedAwaitingMakeup(db, 'mu_decline_first');
  const declined = await call(db, { action: 'respond', caseId: firstCase, revision: 3, response: 'decline' }, auth.cookie);
  assert.equal(declined.status, 200);
  assert.throws(() => db.prepare(
    "UPDATE makeup_cases SET status='confirmed',revision=4,confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE app='task' AND case_id=?"
  ).bind(firstCase).run(), /PARENT_DECLINED/);

  const secondCase = seedAwaitingMakeup(db, 'mu_confirm_first');
  db.prepare(
    "UPDATE makeup_cases SET status='confirmed',revision=4,confirmed_start_at=proposed_start_at," +
    "confirmed_end_at=proposed_end_at,confirmed_staff_id=proposed_staff_id WHERE app='task' AND case_id=?"
  ).bind(secondCase).run();
  assert.throws(() => db.prepare(
    'INSERT INTO guardian_portal_responses(app,response_id,student_id,object_type,object_id,revision,response,created_at) ' +
    'VALUES(?,?,?,?,?,?,?,?)'
  ).bind('task', 'gpr_stale', 'student-a', 'makeup', secondCase, 3, 'decline', Date.now()).run(), /PARENT_RESPONSE_STALE/);
});

test('운영 migration이 빠지면 빈 현황으로 숨기지 않고 준비 중으로 막는다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  db.database.exec('DROP TABLE session_pack_usage');
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 503);
  assert.equal(view.body.code, 'OPERATIONS_NOT_READY');
});

test('활성 회차권도 현재 수업 assignment identity와 담당이 일치할 때만 보호자에게 노출한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const now = Date.now();
  const taskRow = db.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  const studentHash = await sha256Hex('student-id\nstudent-a');
  const taskHash = await sha256Hex([
    'lesson-task', task.id, taskRow.owner, task.studentId,
    task.lessonAssignmentKey || task.lessonDedupeKey || task.id
  ].join('\n'));
  db.prepare(
    'INSERT INTO session_packs(app,pack_id,student_id,lesson_task_id,task_owner,lesson_assignment_key,' +
    'student_identity_hash,task_identity_hash,total_sessions,valid_from,expires_on,deduction_policy,status,revision,' +
    "created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,'recommended_v1','active',1,?,?,?,?)"
  ).bind('task', 'sp_parent', 'student-a', 'lesson-a', 'staff-a',
    task.lessonAssignmentKey || task.lessonDedupeKey || task.id, studentHash, taskHash,
    8, '2026-08-01', '2026-08-31', now, 'director', now, 'director').run();

  let view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.equal(view.body.sessionPacks.length, 1);
  assert.equal(view.body.sessionPacks[0].remaining, 8);

  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify({ ...task, lessonAssignmentKey: 'assignment-v2' })).run();
  view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.sessionPacks, [], 'assignmentKey가 바뀌 stale pack은 숨긴다');

  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  const rosterRow = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const roster = JSON.parse(rosterRow.data);
  roster.roster.students.find(student => student.id === 'student-a').teacherIds = [];
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(roster)).run();
  view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.sessionPacks, [], '현재 담당자 연결이 끊긴 pack도 숨긴다');
  assert.equal(view.body.summary.sessionRemaining, 0);
});

test('보호자 시간표는 오늘 유효한 task와 slot만 공개한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const now = Date.now();
  const expired = { id: 'lesson-expired', staffId: 'staff-a', studentId: 'student-a', studentName: '학생A',
    subject: '과거수업', className: '과거반', taskKind: 'lesson_instruction', scheduleStatus: 'confirmed',
    start: '2020-01-01', end: '2020-12-31', deleted: false,
    scheduleSlots: [{ days: [1], startTime: '10:00', endTime: '11:00' }] };
  const futureSlot = { ...expired, id: 'lesson-future-slot', subject: '미래수업', end: '',
    scheduleSlots: [{ days: [1], startTime: '12:00', endTime: '13:00', validFrom: '2999-01-01' }] };
  for (const task of [expired, futureSlot]) db.prepare(
    'INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)'
  ).bind('task', task.id, 'staff-a', JSON.stringify(task), now, now).run();
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.schedule.map(row => row.subject), ['독해']);
});

test('클라이언트가 전화·이름·메시지를 주입할 수 없다', async () => {
  const db = new TestD1(); seed(db);
  const injected = await call(db, {
    auth: admin, action: 'invite', studentId: 'student-a', phone: '01099998888'
  });
  assert.equal(injected.status, 400);
});
