import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import worker from './worker-core.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/042_consult_guardian_portal.sql', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('./consult-guardian.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
const portalSource = fs.readFileSync(new URL('../parent/consult-guardian/index.html', import.meta.url), 'utf8');
const ADMIN_ORIGIN = 'https://whdudwns33-wb.github.io';
const WORKER_ORIGIN = 'https://worker.example';
const admin = { mode: 'admin', secret: 'consult-secret' };

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.database.prepare(this.sql).get(...this.args) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function env(db) {
  return {
    DB: db, ALLOW_ORIGIN: ADMIN_ORIGIN,
    CONSULT_ADMIN_SECRET: 'consult-secret', TASK_ADMIN_SECRET: 'task-secret'
  };
}

async function call(db, body, { origin = ADMIN_ORIGIN, cookie = '', path = '/consult-guardian' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin != null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const response = await worker.fetch(new Request(WORKER_ORIGIN + path, {
    method: 'POST', headers, body: JSON.stringify(body)
  }), env(db));
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}

function cookieOf(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

function seedStaff(db, id, overrides = {}, updatedAt = Date.now() - 10_000) {
  const data = { id, name: id === 'student-a' ? '가학생' : id, deleted: false, ...overrides };
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, id, JSON.stringify(data), updatedAt, updatedAt).run();
}

function reportSnapshot(overrides = {}) {
  return {
    periodType: 'month', periodKey: '2026-08', periodStart: '2026-08-01', periodEnd: '2026-08-31',
    asOf: Date.now(), isPartial: false,
    student: { id: 'student-a', name: '옛 이름', privateUrl: 'https://private.example/student' },
    summary: { done: 8, total: 10, pct: 80, blocked: 1, studySecs: 7200, goalDays: 4, secret: 'summary-secret' },
    subjects: { math: { label: '위조 과목명', done: 5, total: 6, studySecs: 5000, note: 'subject-secret' } },
    rows: [{ taskId: 'private-task', date: '2026-08-18', title: '수학 복습 https://secret.example/x',
      subject: 'math', origin: 'admin', status: 'done', photo: 'private-photo', question: 'private-question' }],
    days: [{ date: '2026-08-18', done: 2, total: 3, studySecs: 3600, note: 'day-secret' }],
    elapsedDays: 18, dailyGoalMin: 60, reflection: '꾸준히 했다 https://secret.example/reflection',
    directorNote: '원장 피드백 https://secret.example/director', nextFocus: '수학 집중',
    note: 'root-note-secret', settings: { token: 'settings-secret' }, url: 'https://secret.example/root',
    ...overrides
  };
}

function seedReport(db, id, studentId, {
  type = 'month', key = '2026-08', revision = 1, status = 'published', updatedAt = Date.now() - 5000,
  snapshot = reportSnapshot()
} = {}) {
  const start = type === 'month' ? key + '-01' : key;
  const end = type === 'month' ? key + '-31' : '2026-08-23';
  const task = {
    id, staffId: studentId, kind: 'report_snapshot', origin: 'admin', deleted: false,
    reportType: type, periodKey: key, periodStart: start, periodEnd: end,
    reportRevision: revision, reportStatus: status, snapshot: status === 'published' ? snapshot : null,
    publishedAt: updatedAt, createdAt: updatedAt, updatedAt
  };
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('consult', id, studentId, JSON.stringify(task), updatedAt, updatedAt).run();
}

async function enable(db, staffId = 'student-a', expectedUpdatedAt = 0) {
  return call(db, {
    app: 'consult', auth: admin, action: 'access_set', staffId,
    enabled: true, consentConfirmed: true, expectedUpdatedAt
  });
}

async function invite(db, staffId = 'student-a') {
  return call(db, { app: 'consult', auth: admin, action: 'invite', staffId });
}

async function exchange(db, code, cookie = '') {
  return call(db, { app: 'consult', action: 'exchange', code }, { origin: WORKER_ORIGIN, cookie });
}

test('schema and routing are additive, consult-only, scope-versioned, and independent from task parent portal', () => {
  for (const sql of [schema, migration]) {
    for (const table of ['consult_guardian_access', 'consult_guardian_codes', 'consult_guardian_sessions',
      'consult_guardian_acknowledgements']) assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
    assert.match(sql, /CHECK \(app = 'consult'\)/);
    assert.match(sql, /scope_version\s+INTEGER NOT NULL CHECK \(scope_version >= 1\)/);
    assert.match(sql, /trg_consult_guardian_session_max_three/);
    assert.match(sql, /trg_consult_guardian_report_no_update/);
    assert.match(sql, /trg_consult_guardian_report_no_delete/);
    assert.doesNotMatch(sql, /DROP\s+TABLE|DELETE\s+FROM/i);
  }
  assert.match(source, /CONSULT_GUARDIAN_SCOPE_VERSION = 2/);
  assert.match(source, /__Host-wb_consult_guardian/);
  assert.match(coreSource, /handleConsultGuardian/);
  assert.match(coreSource, /url\.pathname === '\/consult-guardian'/);
  assert.match(coreSource, /url\.pathname === '\/parent-portal'/);
  const db = new TestD1();
  assert.throws(() => db.prepare(
    'INSERT INTO consult_guardian_access(app,staff_id,enabled,identity_revision,scope_version,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)'
  ).bind('task', 'x', 0, 'a'.repeat(64), 1, 1, 'director').run(), /CHECK constraint/i);
});

test('all-only admin actions validate active student ids, exclude owner/manager accounts, and use CAS consent', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  seedStaff(db, 'owner-a', { owner: true });
  seedStaff(db, 'manager-a', { manager: true });
  seedStaff(db, 'deleted-a', { deleted: true });

  let result = await call(db, { app: 'consult', action: 'access_list' });
  assert.equal(result.status, 403);
  result = await call(db, { app: 'consult', auth: admin, action: 'access_list' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.accesses.map(row => row.staffId), ['student-a']);
  assert.equal(result.body.accesses[0].enabled, false);

  result = await call(db, {
    app: 'consult', auth: admin, action: 'access_set', staffId: 'student-a', enabled: true, expectedUpdatedAt: 0
  });
  assert.equal(result.status, 400, 'explicit consent confirmation is required');
  result = await enable(db);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.access.enabled, true);
  assert.equal(result.body.access.activeSessions, 0);

  const stale = await enable(db, 'student-a', 0);
  assert.equal(stale.status, 409);
  for (const id of ['owner-a', 'manager-a', 'deleted-a']) {
    const blocked = await enable(db, id);
    assert.equal(blocked.status, 409, id + ' cannot receive guardian access');
  }
  const taskApp = await call(db, {
    app: 'task', auth: { mode: 'admin', secret: 'task-secret' }, action: 'access_set',
    staffId: 'student-a', enabled: true, consentConfirmed: true, expectedUpdatedAt: 0
  });
  assert.equal(taskApp.status, 400);
});

test('public actions require exact same origin and exchange a 24h one-time code for a strict HttpOnly 90d cookie', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  await enable(db);
  const issuedAt = Date.now();
  const issued = await invite(db);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.match(issued.body.code, /^[a-f0-9]{48}$/);
  assert.equal(issued.body.link, WORKER_ORIGIN + '/consult-guardian/#code=' + issued.body.code);
  assert.ok(issued.body.expiresAt >= issuedAt + 24 * 60 * 60 * 1000 - 1000);

  let result = await call(db, { app: 'consult', action: 'exchange', code: issued.body.code });
  assert.equal(result.status, 403, 'the allowed admin Pages origin is not the public cookie origin');
  result = await call(db, { app: 'consult', action: 'exchange', code: issued.body.code }, { origin: null });
  assert.equal(result.status, 403);
  result = await exchange(db, issued.body.code);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const setCookie = result.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-wb_consult_guardian=[a-f0-9]{48};/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=7776000/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  assert.equal(result.body.student.name, '가학생');

  const sessionCount = db.database.prepare(
    "SELECT COUNT(*) AS count FROM consult_guardian_sessions WHERE app='consult'"
  ).get().count;
  const reusedWithCookie = await exchange(db, issued.body.code, cookieOf(result));
  assert.equal(reusedWithCookie.status, 200, JSON.stringify(reusedWithCookie.body));
  assert.equal(reusedWithCookie.body.student.name, '가학생');
  assert.equal(reusedWithCookie.headers.get('set-cookie'), null, 'the existing cookie must be reused');
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) AS count FROM consult_guardian_sessions WHERE app='consult'"
  ).get().count, sessionCount, 'opening the same link again must not create another session');

  const reused = await exchange(db, issued.body.code);
  assert.equal(reused.status, 410);
  assert.equal(reused.body.code, 'LINK_USED');
  const view = await call(db, { app: 'consult', action: 'view' }, {
    origin: WORKER_ORIGIN, cookie: cookieOf(result)
  });
  assert.equal(view.status, 200);
});

test('an invite for another student keeps an explicit session conflict and does not consume the invite', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  seedStaff(db, 'student-b');
  await enable(db, 'student-a');
  await enable(db, 'student-b');
  const firstInvite = await invite(db, 'student-a');
  const connected = await exchange(db, firstInvite.body.code);
  const otherInvite = await invite(db, 'student-b');

  const conflict = await exchange(db, otherInvite.body.code, cookieOf(connected));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'SESSION_CONFLICT');
  assert.match(conflict.body.error, /현재 연결을 해제/);
  assert.equal(db.database.prepare(
    "SELECT consumed_at FROM consult_guardian_codes WHERE app='consult' AND staff_id='student-b'"
  ).get().consumed_at, null);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) AS count FROM consult_guardian_sessions WHERE app='consult'"
  ).get().count, 1);
});

test('guardian portal teaches the review flow and acknowledges only from report detail', () => {
  const cardSource = portalSource.slice(portalSource.indexOf('function reportCard'), portalSource.indexOf('function resultCard'));
  const detailSource = portalSource.slice(portalSource.indexOf('function reportDetail'), portalSource.indexOf('function render'));
  assert.doesNotMatch(cardSource, /data-ack=/);
  assert.match(detailSource, /data-ack=/);
  assert.match(detailSource, /내용을 확인했습니다/);
  for (const text of ['상세 보기', '내용 확인', '수행률', '완료한 비율', '일일 보고는 학생이 보내는 문자', '주간·월간 리포트']) {
    assert.match(portalSource, new RegExp(text));
  }
  assert.match(portalSource, /id="logoutButton"[^>]*>이 기기 연결 해제</);
  assert.match(portalSource, /confirm\([^)]*새 초대 링크/);
  assert.match(portalSource, /if\(code&&isEmbeddedBrowser\(\)&&!allowEmbeddedExchange\)\{\s*showConnectionChoice\(\);return/);
  assert.match(portalSource, /if\(error\.code==='SESSION_CONFLICT'\)\{showSessionConflict\(error\.message\);return\}/);
  assert.match(portalSource, /data-switch/);
  assert.match(portalSource, /data-current/);
});

test('preview/view expose only the latest published report whitelist and hide a latest withdrawn series', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  seedStaff(db, 'student-b');
  seedReport(db, 'month-private-task', 'student-a');
  seedReport(db, 'week-r1-private', 'student-a', {
    type: 'week', key: '2026-08-17', revision: 1, updatedAt: Date.now() - 4000,
    snapshot: reportSnapshot({ periodType: 'week', periodKey: '2026-08-17', periodStart: '2026-08-17', periodEnd: '2026-08-23' })
  });
  seedReport(db, 'week-r2-private', 'student-a', {
    type: 'week', key: '2026-08-17', revision: 2, status: 'withdrawn', updatedAt: Date.now() - 3000
  });
  seedReport(db, 'other-student-private', 'student-b');

  const preview = await call(db, { app: 'consult', auth: admin, action: 'preview', staffId: 'student-a' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.student.name, '가학생');
  assert.equal(preview.body.student.id, undefined);
  assert.equal(preview.body.reports.length, 1);
  const report = preview.body.reports[0];
  assert.match(report.id, /^cgr_[a-f0-9]{48}$/);
  assert.equal(report.reportType, 'month');
  assert.equal(report.reportRevision, 1);
  assert.equal(report.snapshot.periodType, 'month');
  assert.equal(report.snapshot.student.name, '가학생');
  assert.equal(report.snapshot.student.id, undefined);
  assert.equal(report.snapshot.subjects.math.label, '수학');
  assert.equal(report.snapshot.rows[0].title, '수학 복습');
  assert.equal(report.snapshot.rows[0].taskId, undefined);
  assert.equal(report.snapshot.rows[0].origin, undefined);
  assert.equal(report.snapshot.directorNote, '원장 피드백');
  const publicJson = JSON.stringify(preview.body);
  for (const secret of [
    'student-a', 'student-b', 'month-private-task', 'private-task', 'private-photo', 'private-question',
    'summary-secret', 'subject-secret', 'day-secret', 'root-note-secret', 'settings-secret', 'https://', 'private.example'
  ]) assert.ok(!publicJson.includes(secret), 'guardian DTO leaked ' + secret);
  for (const forbiddenKey of ['taskId', 'origin', 'url', 'settings', 'photo', 'question']) {
    assert.ok(!publicJson.includes('"' + forbiddenKey + '"'), 'guardian DTO leaked key ' + forbiddenKey);
  }
});

test('ack is scoped to the exact current report revision and idempotently returns the refreshed view', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  seedReport(db, 'month-r1-private', 'student-a');
  await enable(db);
  const issued = await invite(db);
  const connected = await exchange(db, issued.body.code);
  const cookie = cookieOf(connected);
  const report = connected.body.reports[0];

  let result = await call(db, {
    app: 'consult', action: 'ack', reportId: report.id, reportRevision: report.reportRevision + 1
  }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(result.status, 409);
  result = await call(db, {
    app: 'consult', action: 'ack', reportId: report.id, reportRevision: report.reportRevision
  }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const acknowledgedAt = result.body.reports[0].acknowledgedAt;
  assert.ok(acknowledgedAt > 0);

  result = await call(db, {
    app: 'consult', action: 'ack', reportId: report.id, reportRevision: report.reportRevision
  }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.reports[0].acknowledgedAt, acknowledgedAt);
  assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM consult_guardian_acknowledgements').get().count, 1);

  seedReport(db, 'month-r2-private', 'student-a', { revision: 2, status: 'withdrawn', updatedAt: Date.now() + 1000 });
  result = await call(db, {
    app: 'consult', action: 'ack', reportId: report.id, reportRevision: report.reportRevision
  }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(result.status, 409);
  const view = await call(db, { app: 'consult', action: 'view' }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.reports, []);
});

test('only three active sessions survive and access/identity revisions revoke immediately without unrelated churn', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  const enabled = await enable(db);
  const accessUpdatedAt = enabled.body.access.updatedAt;
  const cookies = [];
  for (let index = 0; index < 4; index++) {
    const issued = await invite(db);
    const connected = await exchange(db, issued.body.code);
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    cookies.push(cookieOf(connected));
  }
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) AS count FROM consult_guardian_sessions WHERE app='consult' AND revoked=0"
  ).get().count, 3);
  let active = 0;
  for (const cookie of cookies) {
    const view = await call(db, { app: 'consult', action: 'view' }, { origin: WORKER_ORIGIN, cookie });
    if (view.status === 200) active++;
  }
  assert.equal(active, 3);

  const row = db.database.prepare("SELECT data,updated_at FROM staff WHERE app='consult' AND id='student-a'").get();
  const unchangedIdentity = { ...JSON.parse(row.data), color: 'blue' };
  db.database.prepare("UPDATE staff SET data=?,updated_at=updated_at+1 WHERE app='consult' AND id='student-a'")
    .run(JSON.stringify(unchangedIdentity));
  const stillValid = await call(db, { app: 'consult', action: 'view' }, { origin: WORKER_ORIGIN, cookie: cookies.at(-1) });
  assert.equal(stillValid.status, 200, 'non-identity student metadata must not revoke the portal');

  db.database.prepare("UPDATE staff SET data=?,updated_at=updated_at+1 WHERE app='consult' AND id='student-a'")
    .run(JSON.stringify({ ...unchangedIdentity, name: '새 이름' }));
  const identityRevoked = await call(db, { app: 'consult', action: 'view' }, {
    origin: WORKER_ORIGIN, cookie: cookies.at(-1)
  });
  assert.equal(identityRevoked.status, 401);
  const access = await call(db, { app: 'consult', auth: admin, action: 'access_list' });
  assert.equal(access.body.accesses[0].enabled, false);
  assert.ok(access.body.accesses[0].updatedAt > accessUpdatedAt);

  db.database.prepare("UPDATE staff SET data=?,updated_at=updated_at+1 WHERE app='consult' AND id='student-a'")
    .run(JSON.stringify(unchangedIdentity));
  const reverted = await call(db, { app: 'consult', auth: admin, action: 'access_list' });
  assert.equal(reverted.body.accesses[0].enabled, false,
    'returning to the old identity must not revive the old consent');
  const blockedInvite = await invite(db);
  assert.equal(blockedInvite.status, 409);
  assert.equal(blockedInvite.body.code, 'ACCESS_REQUIRED');

  const refreshed = await enable(db, 'student-a', reverted.body.accesses[0].updatedAt);
  assert.equal(refreshed.status, 200);
  const nextInvite = await invite(db);
  const nextSession = await exchange(db, nextInvite.body.code);
  const disabled = await call(db, {
    app: 'consult', auth: admin, action: 'access_set', staffId: 'student-a', enabled: false,
    consentConfirmed: false, expectedUpdatedAt: refreshed.body.access.updatedAt
  });
  assert.equal(disabled.status, 200);
  const afterDisable = await call(db, { app: 'consult', action: 'view' }, {
    origin: WORKER_ORIGIN, cookie: cookieOf(nextSession)
  });
  assert.equal(afterDisable.status, 401);
});

test('published report revisions are append-only after a guardian can acknowledge them', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  seedReport(db, 'month-r1-private', 'student-a');
  await enable(db);
  const issued = await invite(db);
  const connected = await exchange(db, issued.body.code);
  const report = connected.body.reports[0];
  const acknowledged = await call(db, {
    app: 'consult', action: 'ack', reportId: report.id, reportRevision: report.reportRevision
  }, { origin: WORKER_ORIGIN, cookie: cookieOf(connected) });
  assert.equal(acknowledged.status, 200);

  const row = db.database.prepare(
    "SELECT data FROM tasks WHERE app='consult' AND id='month-r1-private'"
  ).get();
  const changed = { ...JSON.parse(row.data), snapshot: reportSnapshot({
    rows: [{ date: '2026-08-18', title: '확인 뒤 바뀐 내용', subject: 'math', status: 'done' }]
  }) };
  assert.throws(() => db.database.prepare(
    "UPDATE tasks SET data=?,updated_at=updated_at+1 WHERE app='consult' AND id='month-r1-private'"
  ).run(JSON.stringify(changed)), /CONSULT_GUARDIAN_REPORT_IMMUTABLE/);
  assert.throws(() => db.database.prepare(
    "UPDATE tasks SET owner='student-b' WHERE app='consult' AND id='month-r1-private'"
  ).run(), /CONSULT_GUARDIAN_REPORT_IMMUTABLE/);
  assert.throws(() => db.database.prepare(
    "DELETE FROM tasks WHERE app='consult' AND id='month-r1-private'"
  ).run(), /CONSULT_GUARDIAN_REPORT_IMMUTABLE/);

  const same = db.database.prepare(
    "UPDATE tasks SET updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='consult' AND id='month-r1-private'"
  ).run();
  assert.equal(Number(same.changes), 1, 'an identical retry may advance sync timestamps');
  const view = await call(db, { app: 'consult', action: 'view' }, {
    origin: WORKER_ORIGIN, cookie: cookieOf(connected)
  });
  assert.equal(view.status, 200);
  assert.equal(view.body.reports[0].acknowledgedAt, acknowledged.body.reports[0].acknowledgedAt);
  assert.ok(!JSON.stringify(view.body).includes('확인 뒤 바뀐 내용'));
});

test('logout revokes only the current hashed session and clears the strict cookie', async () => {
  const db = new TestD1();
  seedStaff(db, 'student-a');
  await enable(db);
  const issued = await invite(db);
  const connected = await exchange(db, issued.body.code);
  const cookie = cookieOf(connected);
  const loggedOut = await call(db, { app: 'consult', action: 'logout' }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get('set-cookie'), /^__Host-wb_consult_guardian=; Path=\/; Max-Age=0;/);
  const view = await call(db, { app: 'consult', action: 'view' }, { origin: WORKER_ORIGIN, cookie });
  assert.equal(view.status, 401);
  const stored = db.database.prepare('SELECT token_hash FROM consult_guardian_sessions').get();
  assert.match(stored.token_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!stored.token_hash.includes(cookie.split('=')[1]));
});
