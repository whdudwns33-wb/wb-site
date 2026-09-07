import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import { handleParentPortal, issueGuardianPortalInvite, publicSchedule, publicToday } from './parent-portal.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/027_parent_portal.sql', import.meta.url), 'utf8');
const scopeMigration = fs.readFileSync(new URL('./migrations/034_parent_portal_scope.sql', import.meta.url), 'utf8');
const phase2Migration = fs.readFileSync(new URL('./migrations/035_parent_portal_phase2.sql', import.meta.url), 'utf8');
const studentPortalMigration = fs.readFileSync(new URL('./migrations/038_student_portal.sql', import.meta.url), 'utf8');

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
    this.database.exec(phase2Migration);
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

async function directCall(db, body, auth) {
  const response = await handleParentPortal(env(db), 'task', { app: 'task', ...body },
    'https://whdudwns33-wb.github.io', auth,
    (payload, status) => new Response(JSON.stringify(payload), {
      status, headers: { 'content-type': 'application/json' }
    }), new Request('https://worker.example/parent-portal'));
  return { status: response.status, body: await response.json() };
}

function pauseFirstTwoReads(db, sqlNeedle) {
  const originalPrepare = db.prepare.bind(db);
  let waiting = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).includes(sqlNeedle)) {
      const originalFirst = statement.first.bind(statement);
      statement.first = async () => {
        const row = originalFirst();
        if (waiting < 2) {
          waiting += 1;
          if (waiting === 2) release();
          await gate;
        }
        return row;
      };
    }
    return statement;
  };
  return () => { db.prepare = originalPrepare; };
}

function seed(db) {
  const now = Date.now();
  const month = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const roster = { roster: { updated: month + '-01', baseline: month, students: [
    { id: 'student-a', name: '학생A', grade: '초2', teacher: '담당A', subject: '독해', start: month, end: '',
      reason: '', teacherIds: ['staff-a'], memo: '외부 비공개' },
    { id: 'student-b', name: '학생B', grade: '초3', teacher: '담당B', subject: '독해', start: month, end: '',
      reason: '', teacherIds: ['staff-b'] }
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

async function seedGuardianBookIssue(db) {
  const row = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
  const document = JSON.parse(row.data);
  document.bookStudents.push({
    id: 'assignment-parent', studentId: 'student-a', name: '학생A', teacher: '담당A',
    bookId: 'book-parent', at: '', perWeek: 2, goal: '', teacherIds: ['staff-a']
  });
  db.prepare("UPDATE private_rosters SET data=?,updated_at=updated_at+1 WHERE app='task'")
    .bind(JSON.stringify(document)).run();
  const now = Date.now();
  db.prepare(
    'INSERT INTO book_issues(app,assignment_id,student_id,book_id,student_identity_hash,status,cycle,revision,' +
    'prepared_at,prepared_by,issued_at,issued_by,history,created_at,updated_at) VALUES(?,?,?,?,?,' +
    "'issued',1,2,?,?,?,?,'[]',?,?)"
  ).bind('task', 'assignment-parent', 'student-a', 'book-parent', await sha256Hex('student-a\n학생A'),
    now - 1000, 'staff-a', now, 'staff-a', now - 1000, now).run();
}

function seedAwaitingMakeup(db, caseId = 'mu_parent_case', history = [], sourceDateOverride = '') {
  const now = Date.now();
  const sourceDate = sourceDateOverride || (caseId.includes('confirm') ? '2026-08-11' : '2026-08-10');
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,proposed_start_at,proposed_end_at,proposed_staff_id,' +
    'notification_needed,notification_event,notification_event_revision,history,created_at,updated_at) ' +
    "VALUES(?,?,?,?,?,?,?,'awaiting_parent',3,?,?,?,1,'proposal',3,?,?,?)"
  ).bind('task', caseId, 'student-a', 'lesson-a', sourceDate, 'staff-a', 'mc_' + caseId,
    '2026-08-20T16:00:00+09:00', '2026-08-20T17:00:00+09:00', 'staff-a',
    JSON.stringify(history), now, now).run();
  return caseId;
}

async function seedPublicLesson(db, lessonDate, suffix) {
  const taskRow = db.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  task.scheduleSlots = [{ days: [0, 1, 2, 3, 4, 5, 6], startTime: '16:00', endTime: '17:00' }];
  db.prepare("UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify(task)).run();
  const studentHash = await sha256Hex('student-id\nstudent-a');
  const taskHash = await sha256Hex(['lesson-task', task.id, taskRow.owner, task.studentId,
    task.lessonAssignmentKey || task.lessonDedupeKey || task.id].join('\n'));
  const now = Date.now();
  db.prepare(
    'INSERT INTO guardian_lesson_publications(app,publication_id,source_task_id,task_owner,student_id,' +
    'student_identity_hash,task_identity_hash,lesson_date,status,public_homework,public_readiness,revision,updated_at,updated_by) ' +
    "VALUES(?,?,?,?,?,?,?,?,'published',?,?,1,?,'staff-a')"
  ).bind('task', 'glp_boundary_' + suffix, 'lesson-a', 'staff-a', 'student-a', studentHash, taskHash,
    lessonDate, '공개 숙제 ' + suffix, '연필', now).run();
}

async function connected(db) {
  const current = db.prepare("SELECT updated_at FROM guardian_portal_access WHERE student_id='student-a'").first();
  const allowed = await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 4, expectedUpdatedAt: current ? Number(current.updated_at) : 0 }, '', 'https://whdudwns33-wb.github.io');
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

test('global guardian pause blocks non-allowlisted teacher homework storage and parent access', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const disabledEnv = { ...env(db), WB_GUARDIAN_CONTACT_ENABLED: 'false' };
  const invoke = async (action, body = {}, auth = null) => {
    const response = await handleParentPortal(disabledEnv, 'task', { app: 'task', action, ...body },
      'https://whdudwns33-wb.github.io', auth,
      (payload, status) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
      new Request('https://worker.example/parent-portal'));
    return { status: response.status, body: await response.json() };
  };
  const stored = await invoke('publication_set', {
    taskId: 'lesson-a', lessonDate: today.date, publicHomework: '연산 2쪽', publicReadiness: '연필',
    published: true, studentVisible: false, expectedRevision: 0
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(stored.status, 403);
  assert.equal(stored.body.code, 'GUARDIAN_DELIVERY_NOT_ALLOWED');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM guardian_lesson_publications WHERE student_id='student-a'").first().count, 0);
  const access = await invoke('access_set', {
    studentId: 'student-a', enabled: true, scopeVersion: 4, expectedUpdatedAt: 0
  }, { scope: 'all' });
  assert.equal(access.status, 403);
  assert.equal(access.body.code, 'GUARDIAN_DELIVERY_NOT_ALLOWED');
  const invite = await invoke('invite', { studentId: 'student-a' }, { scope: 'all' });
  assert.equal(invite.status, 403);
  assert.equal(invite.body.code, 'GUARDIAN_DELIVERY_NOT_ALLOWED');
  const preview = await invoke('preview', { studentId: 'student-a' }, { scope: 'all' });
  assert.equal(preview.status, 403);
  assert.equal(preview.body.code, 'GUARDIAN_DELIVERY_NOT_ALLOWED');
});

test('selective guardian mode exposes and permits only exact stable studentId matches', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const selectiveEnv = {
    ...env(db), WB_GUARDIAN_CONTACT_ENABLED: 'false',
    WB_GUARDIAN_CONTACT_STUDENT_IDS: 'student-a'
  };
  const invoke = async (action, body = {}, auth = null) => {
    const response = await handleParentPortal(selectiveEnv, 'task', { app: 'task', action, ...body },
      'https://whdudwns33-wb.github.io', auth,
      (payload, status) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }),
      new Request('https://worker.example/parent-portal'));
    return { status: response.status, body: await response.json() };
  };
  const list = await invoke('access_list', {}, { scope: 'all' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.deliveryEnabledStudentIds, ['student-a']);

  const stored = await invoke('publication_set', {
    taskId: 'lesson-a', lessonDate: today.date, publicHomework: '연산 2쪽', publicReadiness: '연필',
    published: true, studentVisible: false, expectedRevision: 0
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.publication.studentId, undefined);

  const denied = await invoke('access_set', {
    studentId: 'student-b', enabled: true, scopeVersion: 4, expectedUpdatedAt: 0
  }, { scope: 'all' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'GUARDIAN_DELIVERY_NOT_ALLOWED');

  const allowed = await invoke('access_set', {
    studentId: 'student-a', enabled: true, scopeVersion: 4, expectedUpdatedAt: 0
  }, { scope: 'all' });
  assert.equal(allowed.status, 200);
  const invited = await invoke('invite', { studentId: 'student-a' }, { scope: 'all' });
  assert.equal(invited.status, 200);
  assert.match(invited.body.code, /^[a-f0-9]{48}$/);
  assert.equal((await invoke('preview', { studentId: 'student-a' }, { scope: 'all' })).status, 200);
  assert.equal((await invoke('invite', { studentId: 'student-b' }, { scope: 'all' })).status, 403);
});

test('신규 schema와 운영 027→035 적용 결과의 보호자 공개 구조가 같다', () => {
  const fresh = new DatabaseSync(':memory:');
  const upgraded = new DatabaseSync(':memory:');
  fresh.exec(schema);
  const marker = schema.indexOf('-- 보호자 웹앱 초대·세션·정형 응답.');
  upgraded.exec(schema.slice(0, marker));
  upgraded.exec(migration);
  upgraded.exec(scopeMigration);
  upgraded.exec(phase2Migration);
  upgraded.exec(studentPortalMigration);
  const columns = database => database.prepare('PRAGMA table_info(guardian_portal_access)').all()
    .map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
  assert.deepEqual(columns(upgraded), columns(fresh));
  const trigger = database => database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_guardian_portal_access_revoke'"
  ).get().sql.replace(/IF NOT EXISTS\s*/i, '').replace(/\s+/g, ' ').trim();
  assert.equal(trigger(upgraded), trigger(fresh));
  for (const table of ['guardian_lesson_publications', 'guardian_lesson_publication_events',
    'guardian_requests', 'guardian_request_events']) {
    assert.deepEqual(upgraded.prepare('PRAGMA table_info(' + table + ')').all(),
      fresh.prepare('PRAGMA table_info(' + table + ')').all());
  }
  const phase2Objects = database => database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
  ).all().filter(row => /^(guardian_lesson_|guardian_request|idx_guardian_lesson|idx_guardian_requests|trg_guardian_lesson|trg_guardian_request|trg_guardian_portal_responses_no_)/
    .test(row.name)).map(row => ({ ...row,
      sql: row.sql.replace(/IF NOT EXISTS\s*/gi, '').replace(/\s+/g, ' ').trim() }));
  assert.deepEqual(phase2Objects(upgraded), phase2Objects(fresh));
});

test('원장만 동의·연락처가 준비된 stable 학생 초대를 발급한다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { action: 'invite', studentId: 'student-a' })).status, 403);
  assert.equal((await call(db, { auth: admin, action: 'invite', studentId: 'student-b' })).status, 409);
  assert.equal((await call(db, { auth: admin, action: 'invite', studentId: 'student-a' })).status, 409,
    '보호자 앱 동의는 피드백 발송 동의와 별도로 받아야 한다');
  assert.equal((await call(db, { auth: admin, action: 'access_set', studentId: 'student-a', enabled: true, scopeVersion: 4, expectedUpdatedAt: 0 }, '', 'https://whdudwns33-wb.github.io')).status, 200);
  const invite = await call(db, { auth: admin, action: 'invite', studentId: 'student-a' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(invite.status, 200);
  const stored = db.prepare('SELECT code_hash FROM guardian_portal_codes').first().code_hash;
  assert.match(stored, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(stored, invite.body.code);
});

test('직원 초대 API와 내부 발송 helper가 같은 24시간·기존 unused revoke 계약을 사용한다', async () => {
  const db = new TestD1(); seed(db);
  const allowed = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true, scopeVersion: 4, expectedUpdatedAt: 0
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

test('공개 범위 v4에서도 v2 오늘 수업 진행과 최소 차량 확인을 stable 학생 ID로 본다', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const auth = await connected(db);
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.capabilities, { today: true, publicLessons: true, guardianRequests: true,
    bookStatus: true, announcements: true, scopeVersion: 4, requiredScopeVersion: 4 });
  assert.equal(view.body.today.date, today.date);
  assert.equal(view.body.today.lessons.length, 1);
  assert.match(view.body.today.lessons[0].lessonRef, /^lr_[a-f0-9]{32}$/);
  const { lessonRef, ...lesson } = view.body.today.lessons[0];
  assert.deepEqual(lesson, {
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

  const earlyRow = db.prepare("SELECT data FROM checks WHERE app='task' AND k=?").bind('lesson-a|' + today.date).first();
  const earlyCheck = JSON.parse(earlyRow.data);
  earlyCheck.att = 'E';
  db.prepare("UPDATE checks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND k=?")
    .bind(JSON.stringify(earlyCheck), 'lesson-a|' + today.date).run();
  const earlyLeave = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(earlyLeave.body.today.lessons[0].attendance, 'E');

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

test('비정기 주말 수업은 적용일 이후 exact 실제 방문이 있는 날만 실제 시간으로 공개한다', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.parse('2026-08-29T12:30:00+09:00');
  const date = '2026-08-29';
  const taskRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  Object.assign(task, {
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [6], weekendMonthlyTarget: 2,
    weekendFlexibleFrom: '2026-08-01',
    scheduleSlots: [{ days: [0], startTime: '16:00', endTime: '17:00' }]
  });
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();

  let today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.deepEqual(today.lessons, [], '참고 시간표와 무관하게 실제 방문이 없으면 공개하지 않는다');

  const checkInAt = Date.parse('2026-08-29T10:30:00+09:00');
  db.prepare(
    'INSERT INTO weekend_actual_visits(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,' +
    'check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) ' +
    "VALUES(?,?,?,?,?,?,?,NULL,'cancelled',1,?,?,?,?)"
  ).bind('task', 'wv_' + 'a'.repeat(32), 'student-a', 'lesson-a', 'staff-a', date,
    checkInAt, checkInAt, checkInAt, 'staff-a', 'staff-a').run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.deepEqual(today.lessons, [], '취소된 실제 방문은 수업 근거가 아니다');

  db.prepare(
    "UPDATE weekend_actual_visits SET status='active',revision=2,updated_at=updated_at+1 " +
    "WHERE app='task' AND visit_id=?"
  ).bind('wv_' + 'a'.repeat(32)).run();
  task.weekendFlexibleFrom = '2026-08-30';
  task.scheduleSlots = [{ days: [6], startTime: '16:00', endTime: '17:00' }];
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.equal(today.lessons.length, 1, '비정기 적용 시작일 전에는 기존 정기 시간표를 유지한다');
  assert.equal(today.lessons[0].timeLabel, '16:00–17:00');
  assert.equal((await publicSchedule(env(db), { id: 'student-a' }, now)).length, 1,
    '전환 전에는 보호자의 정규 시간표도 유지한다');

  task.weekendFlexibleFrom = '2026-08-01';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.equal(today.lessons.length, 1);
  assert.equal(today.lessons[0].timeLabel, '10:30–등원 중');
  assert.deepEqual(await publicSchedule(env(db), { id: 'student-a' }, now), [],
    '전환 후 참고 시간표를 확정된 정규 시간표처럼 공개하지 않는다');
  assert.match(today.lessons[0].lessonRef, /^lr_[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(today.lessons), /student-a|lesson-a|staff-a/,
    'stable ID는 보호자 응답에 노출하지 않는다');

  const checkOutAt = Date.parse('2026-08-29T12:05:00+09:00');
  db.prepare(
    "UPDATE weekend_actual_visits SET check_out_at=?,status='completed',revision=3,updated_at=updated_at+1 " +
    "WHERE app='task' AND visit_id=?"
  ).bind(checkOutAt, 'wv_' + 'a'.repeat(32)).run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.equal(today.lessons[0].timeLabel, '10:30–12:05');

  const secondCheckInAt = Date.parse('2026-08-29T12:20:00+09:00');
  db.prepare(
    'INSERT INTO weekend_actual_visits(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,visit_sequence,' +
    'check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) ' +
    "VALUES(?,?,?,?,?,?,2,?,NULL,'active',1,?,?,?,?)"
  ).bind('task', 'wv_' + 'b'.repeat(32), 'student-a', 'lesson-a', 'staff-a', date,
    secondCheckInAt, secondCheckInAt, secondCheckInAt, 'staff-a', 'staff-a').run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.equal(today.lessons[0].timeLabel, '12:20–등원 중',
    '같은 날 다시 등원하면 보호자 화면도 활성 방문을 결정적으로 선택한다');
});

test('비정기 수업은 위조된 평일 방문 행이 있어도 보호자 오늘 수업으로 공개하지 않는다', async () => {
  const db = new TestD1(); seed(db);
  const date = '2026-08-31';
  const now = Date.parse(date + 'T12:30:00+09:00');
  const taskRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  Object.assign(task, {
    weekendAttendanceMode: 'flexible', weekendAllowedDays: [0, 6], weekendMonthlyTarget: null,
    weekendFlexibleFrom: '2026-08-01',
    scheduleSlots: [{ days: [1], startTime: '16:00', endTime: '17:00' }]
  });
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  const checkInAt = Date.parse(date + 'T10:30:00+09:00');
  db.prepare(
    'INSERT INTO weekend_actual_visits(app,visit_id,student_id,lesson_task_id,staff_id,visit_date,' +
    'check_in_at,check_out_at,status,revision,created_at,updated_at,created_by,updated_by) ' +
    "VALUES(?,?,?,?,?,?,?,?, 'completed',1,?,?,?,?)"
  ).bind('task', 'wv_' + 'b'.repeat(32), 'student-a', 'lesson-a', 'staff-a', date,
    checkInAt, checkInAt + 3600000, checkInAt, checkInAt, 'staff-a', 'staff-a').run();
  const today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.deepEqual(today.lessons, []);
});

test('주말 실제 방문 테이블이 준비되지 않아도 정기 수업은 유지하고 비정기 수업은 fail-closed 한다', async () => {
  const db = new TestD1(); seed(db);
  const now = Date.parse('2026-08-29T12:30:00+09:00');
  const taskRow = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-a'").first();
  const task = JSON.parse(taskRow.data);
  task.scheduleSlots = [{ days: [6], startTime: '16:00', endTime: '17:00' }];
  task.weekendAttendanceMode = 'flexible';
  task.weekendFlexibleFrom = '2026-08-01';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  db.database.exec('DROP TABLE weekend_actual_visit_events; DROP TABLE weekend_actual_visits;');

  let today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.deepEqual(today.lessons, [], '근거 테이블이 없으면 비정기 수업을 추정 공개하지 않는다');

  task.weekendAttendanceMode = 'fixed';
  task.weekendFlexibleFrom = '';
  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'").bind(JSON.stringify(task)).run();
  today = await publicToday(env(db), { id: 'student-a' }, now);
  assert.equal(today.lessons.length, 1);
  assert.equal(today.lessons[0].timeLabel, '16:00–17:00');
});

test('v4 실제 화면과 관리자 미리보기는 같은 공지·검증된 교재 상태만 공개한다', async () => {
  const db = new TestD1(); seed(db); await seedGuardianBookIssue(db);
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const saved = await call(db, {
    auth: admin, action: 'announcement_save', announcementId: 'notice-parent', expectedRevision: 0,
    title: '방학 운영 안내', body: '다음 주 운영 시간을 확인해 주세요.',
    publishDate: date, expiresDate: date, targetType: 'students', studentIds: ['student-a']
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(saved.status, 200);
  const published = await call(db, {
    auth: admin, action: 'announcement_publish', announcementId: 'notice-parent',
    expectedRevision: saved.body.announcement.revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(published.status, 200);

  const auth = await connected(db);
  const view = await call(db, { action: 'view' }, auth.cookie);
  const preview = await call(db, {
    auth: admin, action: 'preview', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(view.status, 200);
  assert.equal(preview.status, 200);
  assert.deepEqual(view.body.announcements, preview.body.announcements);
  assert.deepEqual(view.body.bookStatus, preview.body.bookStatus);
  assert.deepEqual(view.body.announcements, [{
    title: '방학 운영 안내', body: '다음 주 운영 시간을 확인해 주세요.',
    publishDate: date, expiresDate: date
  }]);
  assert.deepEqual(view.body.bookStatus.map(row => [row.kind, row.title, row.stage, row.label]), [
    ['distribution', '배정 교재', 'ready_for_handoff', '학생 전달 준비']
  ]);
  const raw = JSON.stringify({ announcements: view.body.announcements, bookStatus: view.body.bookStatus });
  assert.doesNotMatch(raw, /student-a|assignment-parent|book-parent|staff-a|announcementId|studentIds|targetType|updatedBy|provider|vendor/);
});

test('담당 수업의 오늘 공개 숙제·준비물만 전용 projection에 CAS 저장하고 철회 이력을 남긴다', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const rootBlocked = await call(db, {
    auth: admin, action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '2쪽', publicReadiness: '연필', published: true, expectedRevision: 0
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(rootBlocked.status, 403);
  assert.equal((await call(db, {
    auth: admin, action: 'publication_list', lessonDate: today.date
  }, '', 'https://whdudwns33-wb.github.io')).status, 403);
  const wrongOwner = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '2쪽', publicReadiness: '연필', published: true, expectedRevision: 0
  }, { scope: 'own', id: 'staff-b', role: 'staff' });
  assert.equal(wrongOwner.status, 403);
  const managerOther = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '2쪽', publicReadiness: '연필', published: true, expectedRevision: 0
  }, { scope: 'all', id: 'staff-b', role: 'manager' });
  assert.equal(managerOther.status, 403);

  const published = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '  2쪽\u0000\r\n문제 풀기  ', publicReadiness: ' 연필 ', published: true,
    studentVisible: true, expectedRevision: 0
  }, { scope: 'all', id: 'staff-a', role: 'manager' });
  assert.equal(published.status, 200);
  assert.equal(published.body.publication.publicHomework, '2쪽\n문제 풀기');
  assert.equal(published.body.publication.studentVisible, true);
  assert.equal(published.body.publication.revision, 1);
  assert.equal(db.prepare('SELECT updated_by FROM guardian_lesson_publications').first().updated_by, 'staff-a');
  const lostResponseRetry = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '2쪽\n문제 풀기', publicReadiness: '연필', published: true, expectedRevision: 0
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(lostResponseRetry.status, 200);
  assert.equal(lostResponseRetry.body.idempotent, true);
  assert.equal(lostResponseRetry.body.publication.studentVisible, true,
    '구형 client가 studentVisible을 생략해도 기존 학생 공개 선택을 보존한다');

  const listed = await directCall(db, { action: 'publication_list', lessonDate: today.date },
    { scope: 'all', id: 'staff-a', role: 'manager' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.publications.length, 1);
  assert.equal(listed.body.publications[0].taskId, 'lesson-a');
  const repeated = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '2쪽\n문제 풀기', publicReadiness: '연필', published: true, expectedRevision: 1
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(repeated.body.idempotent, true);
  const stale = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '바뀐 숙제', publicReadiness: '', published: true, expectedRevision: 0
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_REVISION');
  const tomorrow = new Date(Date.parse(today.date + 'T00:00:00.000Z') + 86400000).toISOString().slice(0, 10);
  assert.equal((await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: tomorrow,
    publicHomework: '미리 공개', publicReadiness: '', published: true, expectedRevision: 0
  }, { scope: 'own', id: 'staff-a', role: 'staff' })).status, 409);

  const auth = await connected(db);
  let view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.body.publicLessons.length, 1);
  assert.equal(view.body.publicLessons[0].publicHomework, '2쪽\n문제 풀기');
  assert.equal(view.body.publicLessons[0].lessonRef, view.body.today.lessons[0].lessonRef);
  assert.doesNotMatch(JSON.stringify(view.body), /내부 수업지시|내부 특성|내부 요청/);

  const withdrawn = await directCall(db, {
    action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '', publicReadiness: '', published: false, expectedRevision: 1
  }, { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.publication.status, 'withdrawn');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_lesson_publication_events').first().count, 2);
  view = await call(db, { action: 'view' }, auth.cookie);
  assert.deepEqual(view.body.publicLessons, []);
  assert.throws(() => db.prepare('UPDATE guardian_lesson_publication_events SET created_by=?').bind('x').run(),
    /GUARDIAN_PUBLICATION_EVENT_APPEND_ONLY/);
  assert.throws(() => db.prepare('DELETE FROM guardian_lesson_publications').run(),
    /GUARDIAN_PUBLICATION_APPEND_ONLY/);
});

test('관리자 공개 준비 목록은 간소화된 stable 학생·담당자 조건만 서버 정본으로 진단한다', async () => {
  const db = new TestD1();
  seed(db);
  const now = Date.now();
  const broken = {
    id: 'lesson-missing', title: '[수업] 연결 확인 필요', staffId: 'staff-a',
    taskKind: 'lesson_instruction', lessonFormVersion: 1, studentName: '이름만 있는 학생',
    grade: '초4', scheduleStatus: 'needs_review', scheduleText: '시간 미정', scheduleSlots: [],
    start: new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10), deleted: false, updatedAt: now
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', broken.id, 'staff-a', JSON.stringify(broken), now, now).run();

  const result = await call(db, {
    auth: admin, action: 'publication_readiness_list'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(result.status, 200);
  const ready = result.body.lessons.find(row => row.taskId === 'lesson-a');
  assert.equal(ready.ready, true);
  const missing = result.body.lessons.find(row => row.taskId === broken.id);
  assert.equal(missing.ready, false);
  assert.deepEqual(new Set(missing.reasons.map(reason => reason.field)), new Set(['studentId']));
  assert.ok(missing.reasons.some(reason => reason.code === 'student_id_missing'));
  assert.equal(missing.reasons.some(reason => /^schedule_/.test(reason.code)), false);
  assert.equal(result.body.missingCount, 2, 'staff-b 저장 수업의 담당 불일치도 함께 진단한다');
  assert.equal(result.body.readyCount, 1);

  const staffBlocked = await directCall(db, { action: 'publication_readiness_list' },
    { scope: 'own', id: 'staff-a', role: 'staff' });
  assert.equal(staffBlocked.status, 403);
});

test('공개 숙제는 오늘 기준 14일 경계까지만 보이고 종료·미래·오래된 행은 숨긴다', async () => {
  const now = Date.now();
  const dateAgo = days => new Date(now + 9 * 60 * 60 * 1000 - days * 86400000).toISOString().slice(0, 10);
  const visibleDb = new TestD1(); seed(visibleDb); await seedPublicLesson(visibleDb, dateAgo(14), '14');
  const visibleAuth = await connected(visibleDb);
  assert.equal((await call(visibleDb, { action: 'view' }, visibleAuth.cookie)).body.publicLessons.length, 1);

  const staleDb = new TestD1(); seed(staleDb); await seedPublicLesson(staleDb, dateAgo(15), '15');
  const staleAuth = await connected(staleDb);
  assert.deepEqual((await call(staleDb, { action: 'view' }, staleAuth.cookie)).body.publicLessons, []);
});

test('동일 공개 내용을 두 기기가 동시에 저장해도 projection과 event는 한 건이고 둘 다 성공한다', async () => {
  const db = new TestD1(); seed(db); const today = seedToday(db);
  const restoreReads = pauseFirstTwoReads(db,
    'SELECT * FROM guardian_lesson_publications WHERE app=? AND task_identity_hash=? AND lesson_date=? LIMIT 1');
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  const payload = { action: 'publication_set', taskId: 'lesson-a', lessonDate: today.date,
    publicHomework: '동시 숙제', publicReadiness: '교재', published: true, expectedRevision: 0 };
  let results;
  try {
    results = await Promise.all([
      directCall(db, payload, { scope: 'own', id: 'staff-a', role: 'staff' }),
      directCall(db, payload, { scope: 'own', id: 'staff-a', role: 'staff' })
    ]);
  } finally {
    restoreReads();
    Date.now = originalNow;
  }
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(results.filter(result => result.body.idempotent).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_lesson_publications').first().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_lesson_publication_events').first().count, 1);
});

test('보호자 정형 요청은 세션 학생만 사용하고 open 중복·재시도·CAS·감사 이력을 안전하게 처리한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const injected = await call(db, {
    action: 'submit_request', requestType: 'consultation', clientRequestId: 'request_injected_01', note: '전화해 주세요'
  }, auth.cookie);
  assert.equal(injected.status, 400);
  assert.equal((await call(db, {
    action: 'submit_request', requestType: 'absence', clientRequestId: 'request_absence_001'
  }, auth.cookie)).status, 400);

  const [first, concurrentDuplicate] = await Promise.all([
    call(db, { action: 'submit_request', requestType: 'consultation', clientRequestId: 'request_consult_001' }, auth.cookie),
    call(db, { action: 'submit_request', requestType: 'consultation', clientRequestId: 'request_consult_002' }, auth.cookie)
  ]);
  assert.equal(first.status, 200);
  assert.equal(concurrentDuplicate.status, 200);
  assert.equal(first.body.request.requestId, concurrentDuplicate.body.request.requestId);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM guardian_requests WHERE status='open'").first().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_request_events').first().count, 1);
  const actor = db.prepare('SELECT created_by FROM guardian_request_events').first().created_by;
  assert.match(actor, /^gsr_[a-f0-9]{32}$/);
  assert.notEqual(actor, 'guardian');

  const retried = await call(db, {
    action: 'submit_request', requestType: 'consultation', clientRequestId: 'request_consult_001'
  }, auth.cookie);
  assert.equal(retried.body.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_requests').first().count, 1);
  const crossOrigin = await call(db, {
    action: 'submit_request', requestType: 'schedule_check', clientRequestId: 'request_schedule_01'
  }, auth.cookie, 'https://whdudwns33-wb.github.io');
  assert.equal(crossOrigin.status, 403);

  const listed = await call(db, { auth: admin, action: 'request_list' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.requests.length, 1);
  assert.equal(listed.body.requests[0].studentId, 'student-a');
  assert.equal(listed.body.requests[0].studentName, '학생A');
  assert.equal((await directCall(db, { action: 'request_list' },
    { scope: 'own', id: 'staff-a', role: 'staff' })).status, 403);

  const stale = await call(db, {
    auth: admin, action: 'request_resolve', requestId: first.body.request.requestId,
    resolution: 'resolved', expectedRevision: 2
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(stale.status, 409);
  const resolved = await call(db, {
    auth: admin, action: 'request_resolve', requestId: first.body.request.requestId,
    resolution: 'resolved', expectedRevision: 1
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.request.status, 'resolved');
  const repeatedResolve = await call(db, {
    auth: admin, action: 'request_resolve', requestId: first.body.request.requestId,
    resolution: 'resolved', expectedRevision: 1
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(repeatedResolve.body.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_request_events').first().count, 2);
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.body.guardianRequests[0].status, 'resolved');
  assert.equal('studentId' in view.body.guardianRequests[0], false);
  assert.throws(() => db.prepare('UPDATE guardian_request_events SET created_by=?').bind('x').run(),
    /GUARDIAN_REQUEST_EVENT_APPEND_ONLY/);
  assert.throws(() => db.prepare('DELETE FROM guardian_requests').run(), /GUARDIAN_REQUEST_APPEND_ONLY/);
});

test('보호자 요청은 해결된 요청을 포함해 학생별 24시간 5건으로 제한한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  for (let index = 0; index < 5; index++) {
    const submitted = await call(db, {
      action: 'submit_request', requestType: 'schedule_check',
      clientRequestId: 'request_rate_' + String(index).padStart(6, '0')
    }, auth.cookie);
    assert.equal(submitted.status, 200);
    if (index < 4) {
      const resolved = await call(db, {
        auth: admin, action: 'request_resolve', requestId: submitted.body.request.requestId,
        resolution: 'resolved', expectedRevision: 1
      }, '', 'https://whdudwns33-wb.github.io');
      assert.equal(resolved.status, 200);
    }
  }
  const duplicateOpen = await call(db, {
    action: 'submit_request', requestType: 'schedule_check', clientRequestId: 'request_rate_888888'
  }, auth.cookie);
  assert.equal(duplicateOpen.status, 200);
  assert.equal(duplicateOpen.body.duplicateOpen, true);
  const limited = await call(db, {
    action: 'submit_request', requestType: 'info_correction', clientRequestId: 'request_rate_999999'
  }, auth.cookie);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_requests').first().count, 5);
});

test('같은 관리자가 두 기기에서 동시에 같은 요청을 완료해도 CAS event는 한 번이고 둘 다 성공한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const submitted = await call(db, {
    action: 'submit_request', requestType: 'info_correction', clientRequestId: 'request_resolve_race_01'
  }, auth.cookie);
  assert.equal(submitted.status, 200);
  const restoreReads = pauseFirstTwoReads(db,
    'SELECT * FROM guardian_requests WHERE app=? AND request_id=? LIMIT 1');
  const originalNow = Date.now;
  const fixedNow = originalNow();
  Date.now = () => fixedNow;
  const payload = { action: 'request_resolve', requestId: submitted.body.request.requestId,
    resolution: 'resolved', expectedRevision: 1 };
  const manager = { scope: 'all', id: 'manager-a', role: 'manager' };
  let results;
  try {
    results = await Promise.all([directCall(db, payload, manager), directCall(db, payload, manager)]);
  } finally {
    restoreReads();
    Date.now = originalNow;
  }
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  assert.equal(results.filter(result => result.body.idempotent).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM guardian_request_events WHERE event_type='resolved'").first().count, 1);
  assert.equal(db.prepare('SELECT status FROM guardian_requests').first().status, 'resolved');
});

test('보호자 요청 이력 20건에는 오래된 open 요청을 해결 이력보다 우선 포함한다', async () => {
  const db = new TestD1(); seed(db); const auth = await connected(db);
  const base = Date.now() - 50 * 86400000;
  db.prepare(
    "INSERT INTO guardian_requests(app,request_id,student_id,client_request_id,request_type,status,revision," +
    "created_at,updated_at,resolved_at,resolved_by) VALUES('task','grq_priority_open','student-a'," +
    "'client_priority_open','consultation','open',1,?,?,NULL,NULL)"
  ).bind(base, base).run();
  for (let index = 0; index < 20; index++) {
    const at = base + (index + 1) * 2 * 86400000;
    db.prepare(
      'INSERT INTO guardian_requests(app,request_id,student_id,client_request_id,request_type,status,revision,' +
      "created_at,updated_at,resolved_at,resolved_by) VALUES('task',?, 'student-a',?,'schedule_check','resolved',2,?,?,?,'director')"
    ).bind('grq_priority_' + index, 'client_priority_' + String(index).padStart(3, '0'), at, at, at).run();
  }
  const view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.equal(view.body.guardianRequests.length, 20);
  assert.equal(view.body.guardianRequests[0].requestId, 'grq_priority_open');
  assert.equal(view.body.summary.guardianRequestOpen, 1);
});

test('관리자 미리보기는 동의·초대·보호자 세션 없이 같은 공개 정보만 읽는다', async () => {
  const db = new TestD1(); seed(db); seedToday(db);
  const taskOrigin = 'https://whdudwns33-wb.github.io';
  assert.equal((await call(db, { action: 'preview', studentId: 'student-a' }, '', taskOrigin)).status, 403);
  const own = await handleParentPortal(env(db), 'task', {
    app: 'task', action: 'preview', auth: { mode: 'person' }, studentId: 'student-a'
  }, taskOrigin, { scope: 'own', id: 'staff-a' }, (payload, status) => new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' }
  }), new Request('https://worker.example/parent-portal'));
  assert.equal(own.status, 403);
  assert.equal((await call(db, {
    auth: admin, action: 'preview', studentId: 'student-a', phone: '01000000000'
  }, '', taskOrigin)).status, 400);
  assert.equal((await call(db, {
    auth: admin, action: 'preview', studentId: 'not safe!'
  }, '', taskOrigin)).status, 400);
  assert.equal((await call(db, {
    auth: admin, action: 'preview', studentId: 'student-missing'
  }, '', taskOrigin)).status, 409);
  db.prepare("DELETE FROM guardian_contacts_by_student WHERE app='task' AND student_id='student-a'").run();
  const changesBeforePreview = db.prepare('SELECT total_changes() count').first().count;

  const preview = await call(db, {
    auth: admin, action: 'preview', studentId: 'student-a'
  }, '', taskOrigin);
  assert.equal(preview.status, 200);
  assert.equal(preview.cookie, '');
  assert.deepEqual(preview.body.capabilities, { today: true, publicLessons: true, guardianRequests: true,
    bookStatus: true, announcements: true, scopeVersion: 4, requiredScopeVersion: 4 });
  assert.equal(preview.body.student.name, '학생A');
  assert.equal(preview.body.today.lessons.length, 1);
  assert.equal(preview.body.today.transport.length, 1);
  assert.doesNotMatch(JSON.stringify(preview.body),
    /01012345678|외부 비공개|내부 특성|내부 요청|내부 수업지시|학생B|9002|route-a|stop-a|staff-a/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_access').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_codes').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_sessions').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_responses').first().count, 0);
  assert.equal(db.prepare('SELECT total_changes() count').first().count, changesBeforePreview,
    '반복 미리보기는 어떤 운영 테이블에도 쓰지 않는다');
  const repeated = await call(db, { auth: admin, action: 'preview', studentId: 'student-a' }, '', taskOrigin);
  assert.equal(repeated.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_access').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_codes').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_sessions').first().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM guardian_portal_responses').first().count, 0);

  const now = Date.now();
  db.prepare('INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)')
    .bind('task', 'student-a', '학생A', '01012345678', 1, now, 'director').run();
  const connectedSession = await connected(db);
  const view = await call(db, { action: 'view' }, connectedSession.cookie);
  const comparable = value => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.generatedAt;
    return copy;
  };
  assert.deepEqual(comparable(preview.body), comparable(view.body));
});

test('보호자 보강 DTO는 첫 생성 이력으로만 유형을 증명하고 생성자 정보는 공개하지 않는다', async () => {
  const db = new TestD1(); seed(db);
  seedAwaitingMakeup(db, 'mu_origin_absence', [
    { action: 'create_from_absence', actorId: 'private-absence-creator' }
  ], '2026-08-10');
  seedAwaitingMakeup(db, 'mu_origin_manual', [
    { action: 'create_manual', reason: 'manual_exam', actorId: 'private-manual-creator', actorScope: 'own' }
  ], '2026-08-11');
  seedAwaitingMakeup(db, 'mu_origin_unknown', [
    { action: 'review', actorId: 'private-reviewer' },
    { action: 'create_manual', reason: 'manual_absence', actorId: 'private-late-creator' }
  ], '2026-08-12');
  seedAwaitingMakeup(db, 'mu_origin_invalid_reason', [
    { action: 'create_manual', reason: 'private-unsafe-reason', actorId: 'private-invalid-creator' }
  ], '2026-08-13');

  const preview = await call(db, {
    auth: admin, action: 'preview', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(preview.status, 200);
  const rows = new Map(preview.body.makeups.map(row => [row.caseId, row]));
  assert.deepEqual(
    { creationType: rows.get('mu_origin_absence').creationType, manualReason: rows.get('mu_origin_absence').manualReason },
    { creationType: 'absence', manualReason: '' }
  );
  assert.deepEqual(
    { creationType: rows.get('mu_origin_manual').creationType, manualReason: rows.get('mu_origin_manual').manualReason },
    { creationType: 'manual', manualReason: 'manual_exam' }
  );
  assert.deepEqual(
    { creationType: rows.get('mu_origin_unknown').creationType, manualReason: rows.get('mu_origin_unknown').manualReason },
    { creationType: 'unknown', manualReason: '' },
    '후속 이력의 create_manual은 생성 근거로 승격하지 않는다'
  );
  assert.deepEqual(
    { creationType: rows.get('mu_origin_invalid_reason').creationType, manualReason: rows.get('mu_origin_invalid_reason').manualReason },
    { creationType: 'manual', manualReason: '' },
    '허용 목록 밖 유형은 보호자에게 전달하지 않는다'
  );
  const raw = JSON.stringify(preview.body.makeups);
  assert.doesNotMatch(raw, /private-|actorId|actorScope|createdBy|createdScope/);
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
    scopeVersion: 4, expectedUpdatedAt: 0
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

test('기존 v2·v3 연결은 원래 기능을 유지하고 v4 재동의 뒤 공지·교재를 연다', async () => {
  const db = new TestD1(); seed(db); seedToday(db);
  const initial = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 4, expectedUpdatedAt: 0
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(initial.status, 200);
  db.prepare(
    "UPDATE guardian_portal_access SET scope_version=2,updated_at=updated_at+1 WHERE app='task' AND student_id='student-a'"
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
    studentId: 'student-a', issuedBy: 'director', requiredScopeVersion: 2
  });
  assert.equal(legacyInvite.ok, true);
  const legacyExchange = await call(db, { action: 'exchange', code: legacyInvite.code });
  const legacyCookie = legacyExchange.cookie.split(';')[0];
  const legacyView = await call(db, { action: 'view' }, legacyCookie);
  assert.equal(legacyView.status, 200);
  assert.deepEqual(legacyView.body.capabilities, { today: true, publicLessons: false, guardianRequests: false,
    bookStatus: false, announcements: false, scopeVersion: 2, requiredScopeVersion: 4 });
  assert.equal(legacyView.body.today.lessons.length, 1);
  assert.equal('publicLessons' in legacyView.body, false);
  assert.equal('guardianRequests' in legacyView.body, false);
  assert.equal('bookStatus' in legacyView.body, false);
  assert.equal('announcements' in legacyView.body, false);
  const blockedRequest = await call(db, {
    action: 'submit_request', requestType: 'consultation', clientRequestId: 'legacy_request_0001'
  }, legacyCookie);
  assert.equal(blockedRequest.status, 409);
  assert.equal(blockedRequest.body.code, 'SCOPE_VERSION_REQUIRED');
  assert.equal(legacyView.body.schedule.length, 1);

  const listed = await call(db, { auth: admin, action: 'access_list' }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(listed.body.access[0].enabled, false);
  assert.equal(listed.body.access[0].needsScopeReconsent, true);
  assert.equal((await call(db, { action: 'view' }, legacyCookie)).status, 200,
    '목적 범위 재동의 안내만으로 기존 v2 세션을 강제 종료하지 않는다');

  const oldClient = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 2, expectedUpdatedAt: revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(oldClient.status, 409);
  assert.equal(oldClient.body.code, 'PORTAL_CONSENT_VERSION_REQUIRED');
  assert.equal(db.prepare("SELECT scope_version FROM guardian_portal_access WHERE student_id='student-a'").first().scope_version, 2);

  const upgradedToV4 = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 4, expectedUpdatedAt: revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(upgradedToV4.status, 200);
  assert.equal(upgradedToV4.body.access.scopeVersion, 4);
  assert.equal((await call(db, { action: 'view' }, legacyCookie)).status, 401);

  db.prepare(
    "UPDATE guardian_portal_access SET scope_version=3,updated_at=updated_at+1 WHERE app='task' AND student_id='student-a'"
  ).run();
  const v3Revision = db.prepare(
    "SELECT updated_at FROM guardian_portal_access WHERE app='task' AND student_id='student-a'"
  ).first().updated_at;
  const v3Invite = await issueGuardianPortalInvite({ DB: db }, {
    studentId: 'student-a', issuedBy: 'director', requiredScopeVersion: 3
  });
  assert.equal(v3Invite.ok, true);
  const v3Exchange = await call(db, { action: 'exchange', code: v3Invite.code });
  const v3Cookie = v3Exchange.cookie.split(';')[0];
  const v3View = await call(db, { action: 'view' }, v3Cookie);
  assert.equal(v3View.status, 200);
  assert.deepEqual(v3View.body.capabilities, {
    today: true, publicLessons: true, guardianRequests: true,
    bookStatus: false, announcements: false, scopeVersion: 3, requiredScopeVersion: 4
  });
  assert.equal('bookStatus' in v3View.body, false);
  assert.equal('announcements' in v3View.body, false);

  const finalUpgrade = await call(db, {
    auth: admin, action: 'access_set', studentId: 'student-a', enabled: true,
    scopeVersion: 4, expectedUpdatedAt: v3Revision
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(finalUpgrade.status, 200);
  assert.equal((await call(db, { action: 'view' }, v3Cookie)).status, 401);
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
    scopeVersion: 4, expectedUpdatedAt: before.updated_at
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
    scopeVersion: 4, expectedUpdatedAt: accessBefore.updated_at
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
  const missingAction = await call(db, {});
  assert.equal(missingAction.status, 400);
  assert.match(missingAction.body.error, /지원하지 않는/);
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
    scopeVersion: 4, expectedUpdatedAt: access.updated_at }, '', 'https://whdudwns33-wb.github.io');
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
    scopeVersion: 4, expectedUpdatedAt: 0 }, '', 'https://whdudwns33-wb.github.io');
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
  assert.throws(() => db.prepare('UPDATE guardian_portal_responses SET response=?').bind('accept').run(),
    /GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY/);
  assert.throws(() => db.prepare('DELETE FROM guardian_portal_responses').run(),
    /GUARDIAN_PORTAL_RESPONSE_APPEND_ONLY/);
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
  const preview = await call(db, {
    auth: admin, action: 'preview', studentId: 'student-a'
  }, '', 'https://whdudwns33-wb.github.io');
  assert.equal(preview.status, 503);
  assert.equal(preview.body.code, 'OPERATIONS_NOT_READY');
});

test('v4 공지·교재 migration이 빠지면 빈 목록으로 오인하지 않고 준비 중으로 막는다', async () => {
  const noticeDb = new TestD1(); seed(noticeDb); const noticeAuth = await connected(noticeDb);
  noticeDb.database.exec('DROP TABLE guardian_announcement_events; DROP TABLE guardian_announcements');
  const noNotice = await call(noticeDb, { action: 'view' }, noticeAuth.cookie);
  assert.equal(noNotice.status, 503);
  assert.equal(noNotice.body.code, 'ANNOUNCEMENTS_NOT_READY');

  const bookDb = new TestD1(); seed(bookDb); const bookAuth = await connected(bookDb);
  bookDb.database.exec('DROP TABLE book_issues');
  const noBook = await call(bookDb, { action: 'view' }, bookAuth.cookie);
  assert.equal(noBook.status, 503);
  assert.equal(noBook.body.code, 'BOOK_STATUS_NOT_READY');
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
  roster.roster.students.find(student => student.id === 'student-a').teacherIds = ['staff-b'];
  db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(roster)).run();
  view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.equal(view.body.sessionPacks.length, 1, 'legacy roster teacherIds는 현재 수업 담당 정본이 아니다');
  assert.equal(view.body.summary.sessionRemaining, 8);

  db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='lesson-a'")
    .bind(JSON.stringify({ ...task, staffId: 'staff-b' })).run();
  view = await call(db, { action: 'view' }, auth.cookie);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.sessionPacks, [], 'task owner와 data.staffId가 어긋난 pack은 숨긴다');
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
