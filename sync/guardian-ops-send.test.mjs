import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { guardianOpsContract, handleGuardianOpsSend } from './guardian-ops-send.js';
import { handleParentPortal } from './parent-portal.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration025 = fs.readFileSync(new URL('./migrations/025_makeup.sql', import.meta.url), 'utf8');
const migration026 = fs.readFileSync(new URL('./migrations/026_session_packs.sql', import.meta.url), 'utf8');
const migration027 = fs.readFileSync(new URL('./migrations/027_parent_portal.sql', import.meta.url), 'utf8');
const migration028 = fs.readFileSync(new URL('./migrations/028_guardian_ops_notifications.sql', import.meta.url), 'utf8');
const migration034 = fs.readFileSync(new URL('./migrations/034_parent_portal_scope.sql', import.meta.url), 'utf8');
const schemaBeforeParentPortal = schema.slice(0, schema.indexOf('-- 보호자 웹앱 초대·세션·정형 응답.'));

class D1Statement {
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
    this.database.exec(schemaBeforeParentPortal);
    this.database.exec(migration025);
    this.database.exec(migration026);
    this.database.exec(migration027);
    this.database.exec(migration034);
    this.database.exec(migration028);
  }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { return statements.map(statement => statement.run()); }
}

const authBody = { mode: 'admin', secret: 'director-secret' };
const resolvedAuth = { scope: 'all', role: 'admin' };
const envBase = {
  WB_GUARDIAN_OPS_SEND_ENABLED: 'true',
  SOLAPI_KAKAO_API_KEY: 'test-key',
  SOLAPI_KAKAO_API_SECRET: 'test-secret',
  SOLAPI_KAKAO_PF_ID: 'PF_TEST',
  SOLAPI_KAKAO_MAKEUP_PROPOSAL_APPROVED_TEMPLATE_ID: 'TPL_MU_PROPOSE',
  SOLAPI_KAKAO_MAKEUP_CONFIRMED_APPROVED_TEMPLATE_ID: 'TPL_MU_CONFIRM',
  SOLAPI_KAKAO_MAKEUP_CANCELLED_APPROVED_TEMPLATE_ID: 'TPL_MU_CANCEL',
  SOLAPI_KAKAO_SESSION_BALANCE_APPROVED_TEMPLATE_ID: 'TPL_SESSION',
  SOLAPI_SENDER_NUMBER: '0212345678',
  WB_PARENT_PORTAL_BASE_URL: 'https://academy.example/parent/'
};

function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function call(db, body, envPatch = {}, auth = resolvedAuth) {
  const response = await handleGuardianOpsSend(
    { DB: db, ...envBase, ...envPatch }, 'task', { app: 'task', auth: authBody, ...body },
    'https://academy.example', auth, json
  );
  return { status: response.status, body: await response.json() };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function seedBase(db, { studentName = '테스트학생', contactName = studentName, oldFeedbackConsent = 1 } = {}) {
  const now = Date.now();
  const staff = { id: 'S-kim', name: '김남기', deleted: false };
  const task = {
    id: 'lesson-1', staffId: 'S-kim', studentId: 'student-1', studentName,
    taskKind: 'lesson_instruction', lessonFormVersion: 1, subject: '독해', className: '중등반',
    repeat: 'days', days: [2, 4], start: '2026-08-01', end: '2026-12-31', deleted: false
  };
  const roster = { roster: { updated: '2026-08-11', baseline: '2026-08', students: [{
    id: 'student-1', name: studentName, grade: '중2', teacher: '김남기', subject: '독해',
    teacherIds: ['S-kim'], start: '2026-08', end: '', reason: ''
  }] }, bookStudents: [] };
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', staff.id, staff.id, JSON.stringify(staff), now, now).run();
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, staff.id, JSON.stringify(task), now, now).run();
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster), now).run();
  db.prepare(
    'INSERT INTO guardian_contacts_by_student(app,student_id,student_name,phone,consent,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?,?)'
  ).bind('task', 'student-1', contactName, '01012345678', oldFeedbackConsent, now, 'director').run();
  db.prepare(
    'INSERT INTO guardian_portal_access(app,student_id,enabled,guardian_identity_hash,updated_at,updated_by) ' +
    'VALUES(?,?,?,?,?,?)'
  ).bind('task', 'student-1', 1, portalIdentityHash('student-1', studentName, '01012345678'), now, 'director').run();
  return { now, task };
}

function seedMakeup(db, eventType = 'makeup_proposal') {
  const states = {
    makeup_proposal: ['awaiting_parent', 'proposal'],
    makeup_confirmed: ['confirmed', 'confirmed'],
    makeup_cancelled: ['cancelled', 'cancelled']
  };
  const [status, event] = states[eventType];
  const now = Date.now();
  db.prepare(
    'INSERT INTO makeup_cases(app,case_id,student_id,source_task_id,source_date,source_teacher_id,' +
    'consumption_group_id,status,revision,proposed_start_at,proposed_end_at,proposed_staff_id,' +
    'confirmed_start_at,confirmed_end_at,confirmed_staff_id,completed_at,completed_by,cancelled_at,cancelled_by,' +
    'reason,notification_needed,notification_event,notification_event_revision,history,created_at,updated_at) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    'task', 'mu_case1', 'student-1', 'lesson-1', '2026-08-11', 'S-kim', 'mc_case1', status, 2,
    '2026-08-18T18:00:00+09:00', '2026-08-18T19:00:00+09:00', 'S-kim',
    eventType === 'makeup_proposal' ? null : '2026-08-18T18:00:00+09:00',
    eventType === 'makeup_proposal' ? null : '2026-08-18T19:00:00+09:00',
    eventType === 'makeup_proposal' ? null : 'S-kim',
    null, null, eventType === 'makeup_cancelled' ? now : null,
    eventType === 'makeup_cancelled' ? 'director' : null,
    eventType === 'makeup_cancelled' ? '일정 변경' : null,
    1, event, 2, '[]', now, now
  ).run();
}

function identityHash(studentId = 'student-1', name = '테스트학생', phone = '01012345678') {
  return createHash('sha256').update([
    studentId, String(name).normalize('NFKC').trim(), String(phone).replace(/[\s()-]/g, '')
  ].join('\u001f')).digest('hex');
}

function portalIdentityHash(studentId = 'student-1', name = '테스트학생', phone = '01012345678') {
  return createHash('sha256').update([
    studentId, String(name).normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('ko-KR'),
    String(phone).replace(/[\s()-]/g, '')
  ].join('\u001f')).digest('hex');
}

function setConsent(db, scope, consent = 1, name = '테스트학생', phone = '01012345678') {
  const now = Date.now();
  db.prepare(
    'INSERT INTO guardian_ops_notification_consents' +
    '(app,student_id,scope,consent,guardian_identity_hash,updated_at,updated_by) VALUES(?,?,?,?,?,?,?)'
  ).bind('task', 'student-1', scope, consent, identityHash('student-1', name, phone), now, 'director').run();
  return now;
}

async function seedSession(db, {
  status = 'active', validFrom = seoulDate(-10), expiresOn = seoulDate(20), used = 3
} = {}) {
  const task = JSON.parse(db.prepare("SELECT data FROM tasks WHERE app='task' AND id='lesson-1'").first().data);
  const now = Date.now();
  const studentHash = await sha256Hex('student-id\nstudent-1');
  const taskHash = await sha256Hex(['lesson-task', task.id, 'S-kim', task.studentId, task.id].join('\n'));
  db.prepare(
    'INSERT INTO session_packs(app,pack_id,student_id,lesson_task_id,task_owner,lesson_assignment_key,' +
    'student_identity_hash,task_identity_hash,total_sessions,valid_from,expires_on,deduction_policy,status,revision,' +
    "created_at,created_by,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,'recommended_v1',?,1,?,?,?,?)"
  ).bind('task', 'sp_pack1', 'student-1', 'lesson-1', 'S-kim', task.id, studentHash, taskHash, 8,
    validFrom, expiresOn, status, now, 'director', now, 'director').run();
  if (used == null) return;
  db.prepare(
    'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
    'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) ' +
    "VALUES('task','su_used','sp_pack1',1,'adjustment','initial-use',NULL,'manual_adjustment',3,NULL,'manual_charge','director',?)"
  ).bind(now + 1).run();
}

function acceptedResponse(index = 1) {
  return new Response(JSON.stringify({
    groupInfo: { groupId: 'GROUP_' + index },
    messageList: [{ messageId: 'MSG_' + index, statusCode: '2000' }]
  }), { status: 200 });
}

function seoulDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

async function withFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('contract reports the exact worker route and fail-closed environment names', () => {
  assert.equal(guardianOpsContract.route, '/guardian-ops-send');
  assert.equal(guardianOpsContract.handler, 'handleGuardianOpsSend');
  assert.equal(guardianOpsContract.enabledEnv, 'WB_GUARDIAN_OPS_SEND_ENABLED');
  assert.equal(guardianOpsContract.parentPortalBaseUrlEnv, 'WB_PARENT_PORTAL_BASE_URL');
  assert.deepEqual(Object.keys(guardianOpsContract.templateEnv).sort(), [...[
    'makeup_proposal', 'makeup_confirmed', 'makeup_cancelled', 'session_balance'
  ]].sort());
});

test('old feedback consent is never reused; ops consent is stable-ID and scope specific', async () => {
  const db = new TestD1();
  seedBase(db, { oldFeedbackConsent: 1 });
  seedMakeup(db);
  const preview = await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.blocker, 'OPS_CONSENT_MISSING');
  const blocked = await call(db, {
    action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'OPS_CONSENT_MISSING');

  const enabled = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true, expectedUpdatedAt: 0
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.consent.scope, 'makeup');
  const rows = await call(db, { action: 'consent_list' });
  assert.equal(rows.body.consents.length, 1);
  assert.equal(rows.body.consents[0].consent, true);
  assert.equal(rows.body.consents.some(row => row.scope === 'session'), false);
});

test('consent enable fails closed when saved guardian name does not match current roster stable ID', async () => {
  const db = new TestD1();
  seedBase(db, { contactName: '다른학생' });
  const result = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true, expectedUpdatedAt: 0
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'GUARDIAN_NOT_READY');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_consents').first().count, 0);
});

test('consent is bound to stable ID, NFKC roster name, and current phone without exposing the hash', async () => {
  const db = new TestD1();
  const decomposedName = '\u1100\u1161 학생';
  seedBase(db, { studentName: decomposedName });
  seedMakeup(db);
  const enabled = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true, expectedUpdatedAt: 0
  });
  assert.equal(enabled.status, 200);
  const firstRevision = enabled.body.consent.updatedAt;
  const stored = db.prepare(
    "SELECT guardian_identity_hash FROM guardian_ops_notification_consents WHERE student_id='student-1' AND scope='makeup'"
  ).first();
  assert.equal(stored.guardian_identity_hash, identityHash('student-1', decomposedName, '01012345678'));
  assert.match(stored.guardian_identity_hash, /^[0-9a-f]{64}$/);

  db.prepare(
    "UPDATE guardian_contacts_by_student SET phone='01087654321',updated_at=updated_at+1 " +
    "WHERE app='task' AND student_id='student-1'"
  ).run();
  const listed = await call(db, { action: 'consent_list' });
  assert.deepEqual(listed.body.consents[0], {
    studentId: 'student-1', scope: 'makeup', consent: false, needsReconsent: true,
    updatedAt: firstRevision, updatedBy: 'director'
  });
  assert.equal(JSON.stringify(listed.body).includes('01087654321'), false);
  assert.equal(JSON.stringify(listed.body).includes('guardian_identity_hash'), false);
  const preview = await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(preview.body.preview.ready, false);
  assert.equal(preview.body.preview.blocker, 'OPS_CONSENT_IDENTITY_MISMATCH');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const blocked = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'OPS_CONSENT_IDENTITY_MISMATCH');
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 0);

  const renewed = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true,
    expectedUpdatedAt: firstRevision
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.consent.needsReconsent, false);
  assert.ok(renewed.body.consent.updatedAt > firstRevision);
  assert.equal(db.prepare(
    "SELECT guardian_identity_hash FROM guardian_ops_notification_consents WHERE student_id='student-1' AND scope='makeup'"
  ).first().guardian_identity_hash, identityHash('student-1', decomposedName, '01087654321'));
  const portalBlocked = await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(portalBlocked.body.preview.ready, false);
  assert.equal(portalBlocked.body.preview.blocker, 'PORTAL_RECONSENT_REQUIRED');
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const blocked = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'PORTAL_RECONSENT_REQUIRED');
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 0);
});

test('consent_set requires CAS, keeps idempotent revisions, and permits stable-ID withdrawal without roster/contact', async () => {
  const db = new TestD1();
  seedBase(db);
  const missingCas = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true
  });
  assert.equal(missingCas.status, 400);
  assert.equal(missingCas.body.code, 'CONSENT_INVALID');

  const first = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true, expectedUpdatedAt: 0
  });
  const revision = first.body.consent.updatedAt;
  const same = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: true,
    expectedUpdatedAt: revision
  });
  assert.equal(same.body.idempotent, true);
  assert.equal(same.body.consent.updatedAt, revision);

  const stale = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: false, expectedUpdatedAt: 0
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONSENT_REVISION_CONFLICT');
  assert.equal(stale.body.current.updatedAt, revision);
  assert.equal(stale.body.current.consent, true);
  assert.equal('guardianIdentityHash' in stale.body.current, false);

  db.prepare("DELETE FROM guardian_contacts_by_student WHERE app='task' AND student_id='student-1'").run();
  db.prepare("DELETE FROM private_rosters WHERE app='task'").run();
  const withdrawn = await call(db, {
    action: 'consent_set', studentId: 'student-1', scope: 'makeup', consent: false,
    expectedUpdatedAt: revision
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.consent.consent, false);
  assert.ok(withdrawn.body.consent.updatedAt > revision);

  const emptyDb = new TestD1();
  const firstWithdrawal = await call(emptyDb, {
    action: 'consent_set', studentId: 'student-orphan', scope: 'session', consent: false,
    expectedUpdatedAt: 0
  });
  assert.equal(firstWithdrawal.status, 200);
  assert.equal(firstWithdrawal.body.consent.consent, false);
  assert.match(emptyDb.prepare(
    "SELECT guardian_identity_hash FROM guardian_ops_notification_consents WHERE student_id='student-orphan'"
  ).first().guardian_identity_hash, /^[0-9a-f]{64}$/);
});

test('proposal preview is built from DB only and uses a fixed portal base URL without an invite code', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 0);
  const result = await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.preview.ready, true);
  assert.deepEqual(result.body.preview.variables, {
    '#{학생명}': '테스트학생', '#{원수업일}': '2026-08-11', '#{보강일시}': '2026-08-18 18:00–19:00',
    '#{담당선생님}': '김남기', '#{보호자앱URL}': 'https://academy.example/parent/'
  });
  assert.equal(result.body.preview.variables['#{보호자앱URL}'].includes('?'), false);
  assert.equal(result.body.preview.variables['#{보호자앱URL}'].includes('#'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 0,
    '미리보기는 1회용 secret을 생성하지 않는다');
  const forbidden = await call(db, {
    action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2,
    phone: '01099999999'
  });
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.body.code, 'REQUEST_FIELD_FORBIDDEN');
});

test('proposal is blocked until guardian portal access is explicitly enabled', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  db.prepare(
    "UPDATE guardian_portal_access SET enabled=0 WHERE app='task' AND student_id='student-1'"
  ).run();
  const preview = await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview.ready, false);
  assert.equal(preview.body.preview.blocker, 'PORTAL_ACCESS_MISSING');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const result = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'PORTAL_ACCESS_MISSING');
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 0);
});

test('accepted ATA uses strict and disableSms, then the same target is idempotent', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  let fetches = 0;
  let payload;
  let firstBody;
  await withFetch(async (url, options) => {
    fetches += 1;
    payload = JSON.parse(options.body);
    return acceptedResponse(fetches);
  }, async () => {
    const first = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'accepted');
    firstBody = first.body;
    const second = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent, true);
  });
  assert.equal(fetches, 1);
  assert.equal(payload.strict, true);
  assert.equal(payload.allowDuplicates, false);
  assert.equal(payload.messages[0].type, 'ATA');
  assert.equal(payload.messages[0].kakaoOptions.disableSms, true);
  assert.equal(payload.messages[0].kakaoOptions.templateId, 'TPL_MU_PROPOSE');
  const portalLink = new URL(payload.messages[0].kakaoOptions.variables['#{보호자앱URL}']);
  const oneTimeCode = new URLSearchParams(portalLink.hash.slice(1)).get('code');
  assert.equal(portalLink.origin + portalLink.pathname, 'https://academy.example/parent/');
  assert.equal(portalLink.search, '');
  assert.match(oneTimeCode, /^[a-f0-9]{48}$/);
  assert.equal(portalLink.hash.includes('student'), false);
  assert.equal('text' in payload.messages[0], false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 1);
  assert.equal(db.prepare('SELECT status FROM guardian_ops_notification_send_events').first().status, 'accepted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 1,
    '접수 완료 후 동일 요청은 새 code를 발급하지 않는다');
  const stored = db.prepare('SELECT code_hash FROM guardian_portal_codes').first().code_hash;
  assert.notEqual(stored, oneTimeCode);
  const sendLedger = db.prepare('SELECT * FROM guardian_ops_notification_sends').first();
  assert.equal(JSON.stringify(sendLedger).includes(oneTimeCode), false);
  assert.equal(JSON.stringify(firstBody).includes(oneTimeCode), false);
  assert.equal(JSON.stringify(firstBody).includes('academy.example/parent'), false);
  const stableVariables = {
    ...payload.messages[0].kakaoOptions.variables,
    '#{보호자앱URL}': 'https://academy.example/parent/'
  };
  assert.equal(sendLedger.variables_hash, await sha256Hex(JSON.stringify(stableVariables)),
    'idempotency/ledger hash는 secret code가 없는 stable 변수로 계산한다');

  const exchanged = await handleParentPortal(
    { DB: db }, 'task', { app: 'task', action: 'exchange', code: oneTimeCode },
    'https://academy.example', null, json,
    new Request('https://academy.example/parent-portal', {
      method: 'POST', headers: { origin: 'https://academy.example' }
    })
  );
  assert.equal(exchanged.status, 200, '기존 cookie가 없어도 fragment의 1회용 code로 세션을 연다');
  assert.match(exchanged.headers.get('set-cookie') || '', /__Host-wb_parent_session=/);
});

test('two concurrent requests for the same event/revision reserve once and fetch once', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  let consentReads = 0;
  let releaseConsentReads;
  const bothConsentReads = new Promise(resolve => { releaseConsentReads = resolve; });
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('SELECT consent,guardian_identity_hash FROM guardian_ops_notification_consents')) {
      const originalFirst = statement.first.bind(statement);
      statement.first = async () => {
        if (consentReads < 2) {
          consentReads += 1;
          if (consentReads === 2) releaseConsentReads();
          await bothConsentReads;
        }
        return originalFirst();
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    const results = await withFetch(async () => {
      fetches += 1;
      return acceptedResponse(fetches);
    }, () => Promise.all([
      call(db, { action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2 }),
      call(db, { action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2 })
    ]));
    assert.equal(results.some(result => result.body.status === 'accepted'), true);
    assert.equal(results.every(result => result.status === 200 || result.status === 202), true);
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(consentReads >= 2, true);
  assert.equal(fetches, 1);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 1);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 1);
});

test('reservation atomically requires the preflight guardian identity hash', async () => {
  const source = fs.readFileSync(new URL('./guardian-ops-send.js', import.meta.url), 'utf8');
  assert.match(source,
    /current_consent\.consent=1 AND current_consent\.guardian_identity_hash=\?/);
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  let changed = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        if (!changed) {
          originalPrepare(
            "UPDATE guardian_ops_notification_consents SET guardian_identity_hash='" + 'f'.repeat(64) + "' " +
            "WHERE app='task' AND student_id='student-1' AND scope='makeup'"
          ).run();
          changed = true;
        }
        return originalRun();
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'OPS_CONSENT_IDENTITY_MISMATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(changed, true);
  assert.equal(fetches, 0);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 0);
});

test('consent withdrawal between reservation and dispatch records rejected and performs zero provider fetches', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  let withdrew = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        if (Number(result.meta.changes) === 1) {
          originalPrepare(
            "UPDATE guardian_ops_notification_consents SET consent=0 WHERE app='task' AND student_id='student-1' AND scope='makeup'"
          ).run();
          withdrew = true;
        }
        return result;
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.status, 'rejected');
      assert.equal(result.body.code, 'OPS_CONSENT_REVOKED_BEFORE_DISPATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(withdrew, true);
  assert.equal(fetches, 0);
  const outcome = originalPrepare(
    'SELECT status,safe_error_code FROM guardian_ops_notification_send_events'
  ).first();
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.safe_error_code, 'OPS_CONSENT_REVOKED_BEFORE_DISPATCH');
});

test('guardian identity change after reservation blocks provider fetch and invite issuance', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        if (Number(result.meta.changes) === 1) {
          originalPrepare(
            "UPDATE guardian_contacts_by_student SET phone='01087654321',updated_at=updated_at+1 " +
            "WHERE app='task' AND student_id='student-1'"
          ).run();
        }
        return result;
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'GUARDIAN_PHONE_CHANGED_BEFORE_DISPATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(fetches, 0);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 0);
});

test('guardian portal access scope/revision change after reservation blocks provider fetch and invite issuance', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        if (Number(result.meta.changes) === 1) {
          originalPrepare(
            "UPDATE guardian_portal_access SET scope_version=2,updated_at=updated_at+1,updated_by='other-manager' " +
            "WHERE app='task' AND student_id='student-1'"
          ).run();
        }
        return result;
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'PORTAL_ACCESS_REVOKED_BEFORE_DISPATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(fetches, 0);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 0);
});

test('makeup cancellation after reservation is rejected before invite/provider dispatch', async () => {
  const source = fs.readFileSync(new URL('./guardian-ops-send.js', import.meta.url), 'utf8');
  assert.match(source, /current_source\.notification_event_revision=\?/);
  assert.match(source, /revalidateAuthoritativeSource/);
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalPrepare = db.prepare.bind(db);
  let changed = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        if (!changed && Number(result.meta.changes) === 1) {
          originalPrepare(
            "UPDATE makeup_cases SET status='cancelled',revision=3,cancelled_at=?,cancelled_by='director'," +
            "reason='schedule_unavailable',notification_event='cancelled',notification_event_revision=3,updated_at=? " +
            "WHERE app='task' AND case_id='mu_case1'"
          ).bind(Date.now(), Date.now()).run();
          changed = true;
        }
        return result;
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.status, 'rejected');
      assert.equal(result.body.code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(changed, true);
  assert.equal(fetches, 0);
  assert.equal(originalPrepare('SELECT COUNT(*) AS count FROM guardian_portal_codes').first().count, 0);
  const outcome = originalPrepare(
    'SELECT status,safe_error_code FROM guardian_ops_notification_send_events'
  ).first();
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.safe_error_code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
});

test('makeup re-proposal during invite issuance revokes the unused code and fetches zero times', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const originalBatch = db.batch.bind(db);
  let changed = false;
  db.batch = statements => {
    const results = originalBatch(statements);
    if (!changed && statements.some(statement => String(statement.sql).startsWith('INSERT INTO guardian_portal_codes'))) {
      db.prepare(
        "UPDATE makeup_cases SET revision=3,proposed_start_at='2026-08-19T18:00:00+09:00'," +
        "proposed_end_at='2026-08-19T19:00:00+09:00',notification_event='proposal'," +
        "notification_event_revision=3,updated_at=? WHERE app='task' AND case_id='mu_case1'"
      ).bind(Date.now()).run();
      changed = true;
    }
    return results;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
    });
  } finally {
    db.batch = originalBatch;
  }
  assert.equal(changed, true);
  assert.equal(fetches, 0);
  const code = db.prepare('SELECT revoked,consumed_at FROM guardian_portal_codes').first();
  assert.equal(code.revoked, 1);
  assert.equal(code.consumed_at, null);
  assert.equal(db.prepare(
    'SELECT safe_error_code FROM guardian_ops_notification_send_events'
  ).first().safe_error_code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
});

test('session usage after reservation changes revision/balance and blocks provider dispatch', async () => {
  const source = fs.readFileSync(new URL('./guardian-ops-send.js', import.meta.url), 'utf8');
  assert.match(source, /current_source\.revision=\?/);
  assert.match(source, /COALESCE\(SUM\(current_usage\.delta\),0\)/);
  const db = new TestD1();
  seedBase(db); await seedSession(db); setConsent(db, 'session');
  const originalPrepare = db.prepare.bind(db);
  let changed = false;
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('INSERT INTO guardian_ops_notification_sends ')) {
      const originalRun = statement.run.bind(statement);
      statement.run = () => {
        const result = originalRun();
        if (!changed && Number(result.meta.changes) === 1) {
          originalPrepare(
            'INSERT INTO session_pack_usage(app,entry_id,pack_id,expected_revision,source_type,source_ref,source_date,' +
            'attendance_event,delta,consumption_group_id,reason_code,actor_id,created_at) ' +
            "VALUES('task','su_race','sp_pack1',2,'adjustment','race-use',NULL,'manual_adjustment',1,NULL," +
            "'manual_charge','director',?)"
          ).bind(Date.now() + 2).run();
          changed = true;
        }
        return result;
      };
    }
    return statement;
  };
  let fetches = 0;
  try {
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const result = await call(db, {
        action: 'send', eventType: 'session_balance', sourceId: 'sp_pack1', revision: 2
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.status, 'rejected');
      assert.equal(result.body.code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
    });
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(changed, true);
  assert.equal(fetches, 0);
  assert.equal(originalPrepare("SELECT revision FROM session_packs WHERE pack_id='sp_pack1'").first().revision, 3);
  assert.equal(originalPrepare(
    'SELECT safe_error_code FROM guardian_ops_notification_send_events'
  ).first().safe_error_code, 'SOURCE_CHANGED_BEFORE_DISPATCH');
});

test('unknown blocks the entire revision/event even after phone and authoritative variables change', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; throw new Error('network uncertain'); }, async () => {
    const first = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'unknown');
    db.prepare("UPDATE guardian_contacts_by_student SET phone='01087654321' WHERE app='task' AND student_id='student-1'").run();
    db.prepare(
      "UPDATE makeup_cases SET proposed_start_at='2026-08-18T19:00:00+09:00'," +
      "proposed_end_at='2026-08-18T20:00:00+09:00' WHERE app='task' AND case_id='mu_case1'"
    ).run();
    const second = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(second.status, 202);
    assert.equal(second.body.code, 'PRIOR_SEND_UNCERTAIN');
    assert.equal(second.body.idempotent, true);
  });
  assert.equal(fetches, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 1);
});

test('the provider timeout remains active while the response body is being read', () => {
  const source = fs.readFileSync(new URL('./guardian-ops-send.js', import.meta.url), 'utf8');
  assert.match(source,
    /const timeout = setTimeout\(\(\) => controller\.abort\(\), SOLAPI_TIMEOUT_MS\);[\s\S]*?response = await fetch\([\s\S]*?raw = await response\.text\(\);[\s\S]*?} catch \(error\) \{[\s\S]*?clearTimeout\(timeout\);/);
});

test('only a definitive rejection permits a safe next attempt for the same revision/event key', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  let fetches = 0;
  const inviteCodes = [];
  await withFetch(async (url, options) => {
    fetches += 1;
    const payload = JSON.parse(options.body);
    const portalUrl = new URL(payload.messages[0].kakaoOptions.variables['#{보호자앱URL}']);
    inviteCodes.push(new URLSearchParams(portalUrl.hash.slice(1)).get('code'));
    return fetches === 1
      ? new Response(JSON.stringify({ errorCode: 'TemplateRejected' }), { status: 400 })
      : acceptedResponse(fetches);
  }, async () => {
    const rejected = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(rejected.status, 502);
    assert.equal(rejected.body.status, 'rejected');
    const retried = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.status, 'accepted');
  });
  assert.equal(fetches, 2);
  assert.equal(new Set(inviteCodes).size, 2, '거절된 재시도는 새 1회용 code를 발급한다');
  assert.deepEqual(db.prepare(
    'SELECT revoked FROM guardian_portal_codes ORDER BY created_at,code_hash'
  ).all().results.map(row => row.revoked).sort(), [0, 1]);
  assert.deepEqual(db.prepare(
    'SELECT attempt_no FROM guardian_ops_notification_sends ORDER BY attempt_no'
  ).all().results.map(row => row.attempt_no), [1, 2]);
  assert.deepEqual(db.prepare(
    'SELECT status FROM guardian_ops_notification_send_events ORDER BY created_at,ledger_event_id'
  ).all().results.map(row => row.status).sort(), ['accepted', 'rejected']);
});

test('session message exposes only total/used/remaining/validity variables', async () => {
  const db = new TestD1();
  seedBase(db); await seedSession(db); setConsent(db, 'session');
  const result = await call(db, {
    action: 'preview', eventType: 'session_balance', sourceId: 'sp_pack1', revision: 2
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.preview.ready, true);
  assert.deepEqual(Object.keys(result.body.preview.variables).sort(), [
    '#{전체횟수}', '#{사용횟수}', '#{잔여횟수}', '#{유효기간}'
  ].sort());
  assert.equal(result.body.preview.variables['#{전체횟수}'], '8');
  assert.equal(result.body.preview.variables['#{사용횟수}'], '3');
  assert.equal(result.body.preview.variables['#{잔여횟수}'], '5');
  assert.equal(JSON.stringify(result.body.preview.variables).includes('01012345678'), false);
});

test('session balance preview/send reject closed, not-yet-valid, and expired packs before provider fetch', async () => {
  const scenarios = [
    { seed: { status: 'closed', used: null }, revision: 1, code: 'SESSION_PACK_NOT_ACTIVE' },
    { seed: { validFrom: seoulDate(1), expiresOn: seoulDate(20) }, revision: 2,
      code: 'SESSION_PACK_OUTSIDE_VALIDITY' },
    { seed: { validFrom: seoulDate(-20), expiresOn: seoulDate(-1) }, revision: 2,
      code: 'SESSION_PACK_OUTSIDE_VALIDITY' }
  ];
  for (const scenario of scenarios) {
    const db = new TestD1();
    seedBase(db); await seedSession(db, scenario.seed); setConsent(db, 'session');
    const preview = await call(db, {
      action: 'preview', eventType: 'session_balance', sourceId: 'sp_pack1', revision: scenario.revision
    });
    assert.equal(preview.status, 409);
    assert.equal(preview.body.code, scenario.code);
    let fetches = 0;
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const sent = await call(db, {
        action: 'send', eventType: 'session_balance', sourceId: 'sp_pack1', revision: scenario.revision
      });
      assert.equal(sent.status, 409);
      assert.equal(sent.body.code, scenario.code);
    });
    assert.equal(fetches, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM guardian_ops_notification_sends').first().count, 0);
  }
});

test('API responses and errors never expose the guardian phone number', async () => {
  const db = new TestD1();
  seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  const responses = [];
  responses.push(await call(db, { action: 'consent_list' }));
  responses.push(await call(db, {
    action: 'preview', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  }));
  responses.push(await call(db, {
    action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  }, { WB_GUARDIAN_OPS_SEND_ENABLED: 'false' }));
  for (const response of responses) {
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('01012345678'), false);
    assert.equal(/"(?:phone|to|recipient)"/i.test(serialized), false);
  }
});

test('gate is fail-closed and rolling 24-hour send reservations are capped at 150', async () => {
  const disabledDb = new TestD1();
  seedBase(disabledDb); seedMakeup(disabledDb); setConsent(disabledDb, 'makeup');
  const disabled = await call(disabledDb, {
    action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
  }, { WB_GUARDIAN_OPS_SEND_ENABLED: 'false' });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.code, 'SEND_DISABLED');

  const db = new TestD1();
  const { now } = seedBase(db); seedMakeup(db); setConsent(db, 'makeup');
  for (let index = 0; index < 150; index += 1) {
    db.prepare(
      'INSERT INTO guardian_ops_notification_sends(app,send_id,idempotency_key,event_type,source_id,source_revision,' +
      'student_id,variables_hash,template_id,attempt_no,created_at,created_by) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind('task', 'gos_seed_' + index, String(index).padStart(64, '0'), 'session_balance', 'sp_seed_' + index, 1,
      'student-1', 'b'.repeat(64), 'TPL_SESSION', 1, now, 'director').run();
  }
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const limited = await call(db, {
      action: 'send', eventType: 'makeup_proposal', sourceId: 'mu_case1', revision: 2
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'DAILY_SEND_LIMIT');
  });
  assert.equal(fetches, 0);
});

test('send and outcome tables reject update/delete so the ledger remains append-only', () => {
  const db = new TestD1();
  const now = Date.now();
  const consentColumns = db.prepare("PRAGMA table_info('guardian_ops_notification_consents')")
    .all().results.map(row => row.name);
  const sendColumns = db.prepare("PRAGMA table_info('guardian_ops_notification_sends')")
    .all().results.map(row => row.name);
  assert.equal(consentColumns.includes('student_name'), false);
  assert.equal(sendColumns.includes('student_name'), false);
  assert.equal(consentColumns.includes('guardian_identity_hash'), true);
  db.prepare(
    'INSERT INTO guardian_ops_notification_sends(app,send_id,idempotency_key,event_type,source_id,source_revision,' +
    'student_id,variables_hash,template_id,attempt_no,created_at,created_by) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind('task', 'gos_immutable', 'c'.repeat(64), 'session_balance', 'sp_one', 1, 'student-1',
    'e'.repeat(64), 'TPL_SESSION', 1, now, 'director').run();
  db.prepare(
    'INSERT INTO guardian_ops_notification_send_events(app,ledger_event_id,send_id,status,created_at) VALUES(?,?,?,?,?)'
  ).bind('task', 'goe_immutable', 'gos_immutable', 'unknown', now).run();
  assert.throws(() => db.prepare(
    "UPDATE guardian_ops_notification_sends SET template_id='TPL_CHANGED' WHERE app='task' AND send_id='gos_immutable'"
  ).run(), /GUARDIAN_OPS_SEND_LEDGER_APPEND_ONLY/);
  assert.throws(() => db.prepare(
    "DELETE FROM guardian_ops_notification_send_events WHERE app='task' AND ledger_event_id='goe_immutable'"
  ).run(), /GUARDIAN_OPS_EVENT_LEDGER_APPEND_ONLY/);
});
