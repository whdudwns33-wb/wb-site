import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

import worker from './worker-core.js';
import { attemptParentFeedbackSend, parentFeedbackV2CommentBudget } from './parent-feedback-send.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration016 = fs.readFileSync(new URL('./migrations/016_parent_feedback_send.sql', import.meta.url), 'utf8');
const migration017 = fs.readFileSync(new URL('./migrations/017_feedback_structured_fields.sql', import.meta.url), 'utf8');
const migration021 = fs.readFileSync(new URL('./migrations/021_parent_feedback_student_ids.sql', import.meta.url), 'utf8');
const migration051 = fs.readFileSync(new URL('./migrations/051_feedback_template_v2.sql', import.meta.url), 'utf8');

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
  constructor() { this.database = new DatabaseSync(':memory:'); this.database.exec(schema); }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { return statements.map(s => s.run()); }
}

const admin = { mode: 'admin', secret: 'director-secret' };
const person = (id, token) => ({ mode: 'person', id, token });

const fullEnvBase = {
  TASK_ADMIN_SECRET: 'director-secret',
  CONSULT_ADMIN_SECRET: 'consult-secret',
  WB_PARENT_FEEDBACK_SEND_ENABLED: 'true',
  SOLAPI_KAKAO_API_KEY: 'test-kakao-key',
  SOLAPI_KAKAO_API_SECRET: 'test-kakao-secret',
  SOLAPI_KAKAO_PF_ID: 'PF_TEST_0001',
  SOLAPI_KAKAO_TEMPLATE_ID: 'TPL_TEST_0001',
  SOLAPI_KAKAO_FEEDBACK_TEMPLATE_ID_V2: 'TPL_TEST_V2_0001',
  SOLAPI_SENDER_NUMBER: '0212345678'
};

function acceptedResponse(index = 1) {
  return new Response(JSON.stringify({
    groupInfo: { groupId: 'GROUP_' + index },
    messageList: [{ messageId: 'MSG_' + index, statusCode: '2000' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function withFetch(stub, action) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await action(); } finally { globalThis.fetch = original; }
}

async function call(db, body, envPatch = {}) {
  const response = await worker.fetch(new Request('https://worker.example/parent-feedback-send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'task', ...body })
  }), { DB: db, ...fullEnvBase, ...envPatch });
  return { status: response.status, body: await response.json() };
}

const seededStaff = new WeakSet();
function ensureKimStaff(db) {
  if (seededStaff.has(db)) return;
  seededStaff.add(db);
  const now = Date.now();
  db.prepare("INSERT INTO staff (app,id,owner,data,updated_at,srv_at) VALUES ('task','S-kim','S-kim',?,?,?)")
    .bind(JSON.stringify({ id: 'S-kim', name: '김남기', deleted: false }), now, now).run();
  db.prepare("INSERT INTO tokens (app,token,staff_id,created_at,revoked) VALUES ('task','tok-kim','S-kim',?,0)").bind(now).run();
}

/** 항목별 변수가 채워진 피드백 요청 하나와, 그게 가리키는 지시서를 심는다.
 *  기본 status는 'content_approved_send_blocked' — 아직(자동발송이든 재시도든) 못 나간 상태를 흉내낸다. */
function seedFeedback(db, overrides = {}) {
  ensureKimStaff(db);
  const now = Date.now();
  const studentId = overrides.studentId === undefined ? 'student-test' : overrides.studentId;
  const templateVersion = overrides.templateVersion || 'v1';
  const task = {
    id: 'task-1', staffId: 'S-kim', title: '[정규] 테스트학생(중2) — 국어 독해',
    taskKind: 'lesson_instruction', studentId, studentName: '테스트학생', subject: '국어', deleted: false
  };
  db.prepare('INSERT INTO tasks (app,id,owner,data,updated_at,srv_at) VALUES (?,?,?,?,?,?)')
    .bind('task', task.id, task.staffId, JSON.stringify(task), now, now).run();

  const requestKey = overrides.requestKey || 'fbr_test0000000000000000000000000000000000000000';
  const fields = {
    teacherName: '김남기', studentName: '테스트학생', contentText: '독해 지문 3개 풀이',
    subjectText: '국어', homeworkText: '어휘 10개 복습',
    commentText: '근거를 찾아 설명하는 태도가 인상적이었습니다.',
    plusText: '오답을 스스로 설명함', minusText: '어휘',
    ...overrides.fields
  };
  if (studentId) {
    const roster = {
      roster: {
        updated: '2026-08-09', baseline: '2026-08',
        students: [{
          id: studentId, name: fields.studentName, grade: '중2', teacher: '김남기', subject: '국어',
          start: '2026-08', end: '', reason: '', teacherIds: ['S-kim']
        }]
      },
      bookStudents: []
    };
    db.prepare(
      "INSERT INTO private_rosters(app,data,updated_at) VALUES('task',?,?) " +
      'ON CONFLICT(app) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at'
    ).bind(JSON.stringify(roster), now).run();
  }
  db.prepare(
    'INSERT INTO feedback_requests (app,request_key,task_id,owner,feedback_date,feedback_type,template_version,' +
    'body,body_hash,teacher_name,student_id,student_name,content_text,subject_text,homework_text,comment_text,' +
    'plus_text,minus_text,revision,status,created_at,updated_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)'
  ).bind('task', requestKey, task.id, 'S-kim', '2026-08-09', 'class_feedback', templateVersion,
    '오늘 테스트학생 수업 잘 마쳤습니다.', 'x'.repeat(64),
    fields.teacherName, studentId || null, fields.studentName, fields.contentText,
    fields.subjectText, fields.homeworkText, fields.commentText, fields.plusText, fields.minusText,
    overrides.status || 'content_approved_send_blocked', now, now).run();
  return { requestKey, taskId: task.id, studentId, studentName: fields.studentName };
}

function registerGuardian(db, studentName, { studentId = 'student-test', phone = '01012345678', consent = 1 } = {}) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO guardian_contacts_by_student ' +
    '(app,student_id,student_name,phone,consent,updated_at,updated_by) VALUES (?,?,?,?,?,?,?)'
  ).bind('task', studentId, studentName, phone, consent, now, 'director').run();
}

test('schema and migrations use stable student ids, and the send ledger itself stores no phone or message body', () => {
  for (const sql of [schema, migration016]) {
    const match = sql.match(/CREATE TABLE IF NOT EXISTS parent_feedback_sends\s*\([\s\S]*?\);/);
    assert.ok(match, 'parent_feedback_sends 테이블 정의를 찾을 수 없습니다');
    assert.doesNotMatch(match[0], /phone|message_body/i, '발송 이력 테이블에는 전화번호나 문자 본문을 남기지 않는다(해시만)');
  }
  assert.doesNotMatch(migration017, /DROP TABLE|DELETE FROM/i);
  assert.match(migration017, /ALTER TABLE feedback_requests ADD COLUMN teacher_name/);
  assert.doesNotMatch(migration021, /DROP TABLE|DELETE FROM/i);
  assert.match(migration021, /CREATE TABLE IF NOT EXISTS guardian_contacts_by_student/);
  assert.match(migration021, /ALTER TABLE feedback_requests ADD COLUMN student_id/);
  assert.match(migration021, /ALTER TABLE parent_feedback_sends ADD COLUMN student_id/);
  assert.doesNotMatch(migration051, /DROP TABLE|DELETE FROM|UPDATE feedback_requests/i);
  assert.match(migration051, /ALTER TABLE feedback_requests ADD COLUMN comment_text/);
});

test('client cannot specify phone, recipient, message, or studentName — request rejected before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    for (const bad of [{ phone: '01000000000' }, { message: 'hi' }, { to: '010' }, { studentName: 'x' }]) {
      const r = await call(db, { auth: admin, requestKey, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });
  assert.equal(fetches, 0);
});

test('send is disabled by default even with valid credentials unless the explicit switch is on', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey }, { WB_PARENT_FEEDBACK_SEND_ENABLED: 'false' });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'SEND_DISABLED');
  });
  assert.equal(fetches, 0);
});

test('global guardian pause overrides an enabled feedback delivery switch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey }, {
      ...fullEnvBase, WB_PARENT_FEEDBACK_SEND_ENABLED: 'true', WB_GUARDIAN_CONTACT_ENABLED: 'false'
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'SEND_DISABLED');
  });
  assert.equal(fetches, 0);
});

test('global guardian pause permits only an exact stable studentId allowlist match', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey }, {
      WB_GUARDIAN_CONTACT_ENABLED: 'false',
      WB_GUARDIAN_CONTACT_STUDENT_IDS: 'student-other,student-test'
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'sent');
  });
  assert.equal(fetches, 1);
});

test('only the director can trigger a manual retry, not the submitting teacher', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  const r = await call(db, { auth: person('S-kim', 'tok-kim'), requestKey });
  assert.equal(r.status, 403);
});

test('cancelled requests cannot be (re)sent', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db, { status: 'cancelled' });
  registerGuardian(db, '테스트학생');
  const r = await call(db, { auth: admin, requestKey });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CANCELLED');
});

test('rows missing structured fields (legacy data) are blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db, { fields: { contentText: '', plusText: '', minusText: '' } });
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.code, 'FIELDS_INCOMPLETE');
  });
  assert.equal(fetches, 0);
});

test('no guardian contact registered at all is blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.code, 'GUARDIAN_NOT_REGISTERED');
  });
  assert.equal(fetches, 0);
});

test('phone registered but consent off is blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생', { consent: 0 });
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.code, 'GUARDIAN_CONSENT_MISSING');
  });
  assert.equal(fetches, 0);
});

test('legacy name-only guardian row is never used as a recipient', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  const now = Date.now();
  db.prepare(
    'INSERT INTO guardian_contacts(app,student_name,phone,consent,updated_at,updated_by) VALUES (?,?,?,?,?,?)'
  ).bind('task', '테스트학생', '01099998888', 1, now, 'legacy').run();
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.code, 'GUARDIAN_NOT_REGISTERED');
  });
  assert.equal(fetches, 0, '이름만 같은 과거 연락처는 수신자로 추정하지 않는다');
});

test('studentId/name or current owner mismatch is blocked before guardian lookup and fetch', async () => {
  for (const mismatch of ['name', 'owner']) {
    const db = new TestD1();
    const { requestKey } = seedFeedback(db);
    registerGuardian(db, '테스트학생');
    if (mismatch === 'name') {
      const row = db.prepare("SELECT data FROM private_rosters WHERE app='task'").first();
      const document = JSON.parse(row.data);
      document.roster.students[0].name = '다른학생';
      db.prepare("UPDATE private_rosters SET data=? WHERE app='task'").bind(JSON.stringify(document)).run();
    } else {
      const row = db.prepare("SELECT data FROM tasks WHERE app='task' AND id='task-1'").first();
      const task = JSON.parse(row.data);
      task.staffId = 'S-other';
      db.prepare("UPDATE tasks SET data=? WHERE app='task' AND id='task-1'").bind(JSON.stringify(task)).run();
    }
    let fetches = 0;
    await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
      const r = await call(db, { auth: admin, requestKey });
      assert.equal(r.body.code, mismatch === 'name' ? 'STUDENT_IDENTITY_MISMATCH' : 'STUDENT_OWNER_MISMATCH');
    });
    assert.equal(fetches, 0, mismatch);
  }
});

test('guardian contact student-name snapshot must match the current verified roster identity', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  db.prepare(
    "UPDATE guardian_contacts_by_student SET student_name='동명이인학생' WHERE app='task' AND student_id='student-test'"
  ).run();
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'GUARDIAN_IDENTITY_MISMATCH');
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM parent_feedback_sends').first().count, 0);
  const feedback = db.prepare(
    'SELECT review_note FROM feedback_requests WHERE app=? AND request_key=?'
  ).bind('task', requestKey).first();
  assert.match(feedback.review_note, /원생 명단.*보호자 연락처.*다시 저장/);
});

test('fields totalling over 900 characters are blocked before any fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db, { fields: { contentText: '가'.repeat(850) } });
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.code, 'MESSAGE_TOO_LONG');
  });
  assert.equal(fetches, 0);
});

test('happy path: registered+consented guardian → sends a Kakao AlimTalk with the structured variables', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let sentPayload = null;
  let sentMessage = null;
  await withFetch(async (url, init) => {
    sentPayload = JSON.parse(init.body);
    sentMessage = sentPayload.messages[0];
    return acceptedResponse();
  }, async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'sent');
  });
  assert.equal(sentMessage.to, '01012345678');
  assert.equal(sentMessage.type, 'ATA', '카카오 알림톡(ATA)으로 나가야 한다 — SMS/LMS가 아니다');
  assert.equal(sentMessage.kakaoOptions.pfId, 'PF_TEST_0001');
  assert.equal(sentMessage.kakaoOptions.templateId, 'TPL_TEST_0001');
  assert.equal(sentMessage.kakaoOptions.disableSms, true, '카카오로만 나가야 한다 — SMS로 조용히 대체 발송하지 않는다');
  assert.equal(sentMessage.kakaoOptions.variables['#{선생님}'], '김남기');
  assert.equal(sentMessage.kakaoOptions.variables['#{학생명}'], '테스트학생');
  assert.equal(sentMessage.kakaoOptions.variables['#{학습내용}'], '독해 지문 3개 풀이');
  assert.equal(sentMessage.kakaoOptions.variables['#{잘한점}'], '오답을 스스로 설명함');
  assert.equal(sentMessage.kakaoOptions.variables['#{보완점}'], '어휘');
  assert.deepEqual(Object.keys(sentMessage.kakaoOptions.variables).sort(),
    ['#{보완점}', '#{선생님}', '#{잘한점}', '#{학생명}', '#{학습내용}'].sort());
  assert.equal(sentPayload.strict, true);
  assert.equal(sentPayload.allowDuplicates, false);
  assert.equal(sentPayload.showMessageList, true);

  const row = db.prepare("SELECT status FROM feedback_requests WHERE request_key=?").bind(requestKey).first();
  assert.equal(row.status, 'sent', '발송 성공 후 feedback_requests 상태가 sent로 바뀐다');
});

test('v2 sends the requested six variables through its separate approved template id', async () => {
  const db = new TestD1();
  const requestedSubject = '국어 독해 · 비문학';
  const { requestKey } = seedFeedback(db, {
    templateVersion: 'v2', fields: { subjectText: requestedSubject }
  });
  registerGuardian(db, '테스트학생');
  let sentMessage = null;
  await withFetch(async (url, init) => {
    sentMessage = JSON.parse(init.body).messages[0];
    return acceptedResponse();
  }, async () => {
    const result = await call(db, { auth: admin, requestKey });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'sent');
  });
  assert.equal(sentMessage.kakaoOptions.templateId, 'TPL_TEST_V2_0001');
  assert.deepEqual(sentMessage.kakaoOptions.variables, {
    '#{학생명}': '테스트학생', '#{일시}': '2026년 8월 9일', '#{과목}': requestedSubject,
    '#{수업내용진도}': '독해 지문 3개 풀이', '#{과제}': '어휘 10개 복습',
    '#{코멘트}': '근거를 찾아 설명하는 태도가 인상적이었습니다.'
  });
});

test('v2 comment budget counts every approved-template blank line', () => {
  const fields = {
    studentName: '가'.repeat(40), dateText: '나'.repeat(20), subjectText: '다'.repeat(80),
    contentText: '라'.repeat(250), homeworkText: '마'.repeat(250), commentText: ''
  };
  const fixedText = '안녕하세요, WB 웩슬러브레인센터(독해력학원) 입니다.\n\n' +
    ' 학생의 오늘 수업 피드백을 정리해 보내드립니다.\n\n' +
    '- 일시 : \n\n- 과목 : \n\n- 수업내용 · 진도 : \n\n- 과제 : \n\n- 코멘트 : \n\n' +
    '문의 사항이 있으시면 학원으로 연락부탁드립니다. 감사합니다.';
  const used = fixedText.length + fields.studentName.length + fields.dateText.length +
    fields.subjectText.length + fields.contentText.length + fields.homeworkText.length;
  assert.equal(parentFeedbackV2CommentBudget(fields), Math.max(0, Math.min(600, 900 - used)));
});

test('resending the same content is idempotent — no second fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    await call(db, { auth: admin, requestKey });
  });
  assert.equal(fetches, 1);

  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const again = await call(db, { auth: admin, requestKey });
    assert.equal(again.status, 200);
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.code, 'ALREADY_SENT');
  });
  assert.equal(fetches, 1, '이미 보낸 건은 다시 발송하지 않는다');
});

test('rejected provider response keeps feedback_requests blocked, not marked sent', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  await withFetch(async () => new Response(JSON.stringify({
    groupInfo: { groupId: 'G1' }, messageList: [{ messageId: 'M1', statusCode: '9999' }]
  }), { status: 200, headers: { 'content-type': 'application/json' } }), async () => {
    const r = await call(db, { auth: admin, requestKey });
    assert.equal(r.body.status, 'content_approved_send_blocked');
  });
  const row = db.prepare("SELECT status, review_note FROM feedback_requests WHERE request_key=?").bind(requestKey).first();
  assert.equal(row.status, 'content_approved_send_blocked', '거절된 발송은 문구 상태를 sent로 바꾸지 않는다');
  assert.match(row.review_note, /거절/, '거절 사유가 review_note에 남는다');
});

test('HTTP 200 registration failure is rejected from failedMessageList and is never retried automatically', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      groupInfo: { groupId: 'GROUP_FAILED' },
      failedMessageList: [{ messageId: 'MSG_FAILED', statusCode: '1011' }],
      messageList: []
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    const first = await call(db, { auth: admin, requestKey });
    assert.equal(first.body.code, 'SOLAPI_STATUS_1011');
    assert.equal(first.body.status, 'content_approved_send_blocked');
    const again = await call(db, { auth: admin, requestKey });
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.status, 'rejected');
  });
  assert.equal(fetches, 1);
  const ledger = db.prepare(
    'SELECT status, provider_status_code, safe_error_code FROM parent_feedback_sends WHERE feedback_request_key=?'
  ).bind(requestKey).first();
  assert.equal(ledger.status, 'rejected');
  assert.equal(ledger.provider_status_code, '1011');
  assert.equal(ledger.safe_error_code, 'SOLAPI_STATUS_1011');
});

test('unknown provider outcome is marked as verify-before-retry and a repeat call makes no fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    throw new Error('network down');
  }, async () => {
    const first = await call(db, { auth: admin, requestKey });
    assert.equal(first.body.code, 'SOLAPI_NETWORK');
    const again = await call(db, { auth: admin, requestKey });
    assert.equal(again.body.idempotent, true);
    assert.equal(again.body.status, 'unknown');
  });
  assert.equal(fetches, 1);
  const request = db.prepare('SELECT status,review_note FROM feedback_requests WHERE request_key=?').bind(requestKey).first();
  assert.equal(request.status, 'content_approved_send_blocked');
  assert.match(request.review_note, /^접수 여부 확인 필요/);
  assert.match(request.review_note, /재발송 금지/);
});

test('unknown prior attempt blocks a new idempotency key after guardian phone changes', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    throw new Error('network uncertainty');
  }, async () => {
    const first = await call(db, { auth: admin, requestKey });
    assert.equal(first.status, 202);
    assert.equal(first.body.code, 'SOLAPI_NETWORK');

    db.prepare(
      "UPDATE guardian_contacts_by_student SET phone='01087654321' WHERE app='task' AND student_id='student-test'"
    ).run();
    const changedPhone = await call(db, { auth: admin, requestKey });
    assert.equal(changedPhone.status, 202);
    assert.equal(changedPhone.body.code, 'PRIOR_SEND_UNCERTAIN');
    assert.equal(changedPhone.body.idempotent, true);
  });
  assert.equal(fetches, 1, '번호 변경으로 새 멱등키가 생겨도 이전 unknown 확인 전에는 호출하지 않는다');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM parent_feedback_sends').first().count, 1);
});

test('unknown prior attempt blocks a changed revision of the same feedback request', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  await withFetch(async () => {
    fetches += 1;
    throw new Error('network uncertainty');
  }, async () => {
    const first = await call(db, { auth: admin, requestKey });
    assert.equal(first.status, 202);
    db.prepare(
      "UPDATE feedback_requests SET revision=revision+1, content_text='수정된 학습 내용', " +
      "body_hash=? WHERE app='task' AND request_key=?"
    ).bind('y'.repeat(64), requestKey).run();
    const changedRevision = await call(db, { auth: admin, requestKey });
    assert.equal(changedRevision.status, 202);
    assert.equal(changedRevision.body.code, 'PRIOR_SEND_UNCERTAIN');
    assert.equal(changedRevision.body.idempotent, true);
  });
  assert.equal(fetches, 1, 'revision과 본문 해시가 달라도 이전 unknown 확인 전에는 호출하지 않는다');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM parent_feedback_sends').first().count, 1);
});

test('dispatching prior attempt blocks changed phone and revision without another fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  const now = Date.now();
  db.prepare(
    'INSERT INTO parent_feedback_sends ' +
    '(app,send_id,idempotency_key,feedback_request_key,student_id,student_name,message_hash,status,' +
    'created_at,dispatch_started_at,updated_at) VALUES (?,?,?,?,?,?,?,\'dispatching\',?,?,?)'
  ).bind(
    'task', 'pfs_inflight', 'z'.repeat(64), requestKey, 'student-test', '테스트학생',
    'a'.repeat(64), now, now, now
  ).run();
  db.prepare(
    "UPDATE guardian_contacts_by_student SET phone='01087654321' WHERE app='task' AND student_id='student-test'"
  ).run();
  db.prepare(
    "UPDATE feedback_requests SET revision=revision+1, content_text='수정된 학습 내용' " +
    "WHERE app='task' AND request_key=?"
  ).bind(requestKey).run();
  let fetches = 0;
  await withFetch(async () => { fetches += 1; return acceptedResponse(); }, async () => {
    const result = await call(db, { auth: admin, requestKey });
    assert.equal(result.status, 202);
    assert.equal(result.body.code, 'PRIOR_SEND_UNCERTAIN');
  });
  assert.equal(fetches, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM parent_feedback_sends').first().count, 1);
});

test('concurrent different phone, content hash, and revision atomically permit exactly one provider fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  const base = db.prepare(
    'SELECT * FROM feedback_requests WHERE app=? AND request_key=?'
  ).bind('task', requestKey).first();
  const revised = {
    ...base,
    revision: Number(base.revision) + 1,
    content_text: '동시에 수정된 학습 내용',
    body_hash: 'b'.repeat(64)
  };

  const originalPrepare = db.prepare.bind(db);
  let guardianReads = 0;
  let releaseGuardianReads;
  const bothGuardianReads = new Promise(resolve => { releaseGuardianReads = resolve; });
  db.prepare = sql => {
    const statement = originalPrepare(sql);
    if (String(sql).startsWith('SELECT student_name, phone, consent FROM guardian_contacts_by_student')) {
      const originalFirst = statement.first.bind(statement);
      statement.first = async () => {
        const index = guardianReads;
        guardianReads += 1;
        if (guardianReads === 2) releaseGuardianReads();
        await bothGuardianReads;
        const row = originalFirst();
        return { ...row, phone: index === 0 ? '01012345678' : '01087654321' };
      };
    }
    return statement;
  };

  let fetches = 0;
  let sentPhone = '';
  try {
    const results = await withFetch(async (url, options) => {
      fetches += 1;
      sentPhone = JSON.parse(options.body).messages[0].to;
      return acceptedResponse();
    }, () => Promise.all([
      attemptParentFeedbackSend({ DB: db, ...fullEnvBase }, 'task', base),
      attemptParentFeedbackSend({ DB: db, ...fullEnvBase }, 'task', revised)
    ]));
    assert.deepEqual(results.map(result => result.status).sort(), ['sent', 'unknown']);
    assert.equal(results.find(result => result.status === 'unknown').code, 'PRIOR_SEND_UNCERTAIN');
  } finally {
    db.prepare = originalPrepare;
  }
  assert.equal(guardianReads, 2, '두 요청 모두 서로 다른 수신번호를 계산한 뒤 원자 INSERT에서 경쟁한다');
  assert.equal(fetches, 1);
  assert.ok(['01012345678', '01087654321'].includes(sentPhone));
  assert.equal(originalPrepare(
    'SELECT COUNT(*) AS count FROM parent_feedback_sends WHERE feedback_request_key=?'
  ).bind(requestKey).first().count, 1);
});

test('ledger reservation and dispatch transition are one atomic insert before provider fetch', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  const originalPrepare = db.prepare.bind(db);
  let separateDispatchUpdates = 0;
  db.prepare = sql => {
    if (/UPDATE parent_feedback_sends SET status='dispatching'/i.test(String(sql))) {
      separateDispatchUpdates += 1;
    }
    return originalPrepare(sql);
  };
  await withFetch(async () => {
    const row = originalPrepare(
      'SELECT status,created_at,dispatch_started_at FROM parent_feedback_sends WHERE feedback_request_key=?'
    ).bind(requestKey).first();
    assert.equal(row.status, 'dispatching');
    assert.equal(Number(row.dispatch_started_at), Number(row.created_at));
    assert.ok(Number(row.dispatch_started_at) > 0);
    assert.equal(originalPrepare(
      "SELECT COUNT(*) AS count FROM parent_feedback_sends WHERE status='reserved'"
    ).first().count, 0);
    return acceptedResponse();
  }, async () => {
    const result = await call(db, { auth: admin, requestKey });
    assert.equal(result.status, 200);
  });
  assert.equal(separateDispatchUpdates, 0, 'reserved 행 생성 뒤 별도 dispatching 전환을 하지 않는다');
});

test('timeout covers a hanging Solapi response body and repeat remains idempotent', async () => {
  const db = new TestD1();
  const { requestKey } = seedFeedback(db);
  registerGuardian(db, '테스트학생');
  let fetches = 0;
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 8000 ? 5 : delay, ...args);
  try {
    await withFetch(async (url, options) => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        text() {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
      };
    }, async () => {
      const first = await call(db, { auth: admin, requestKey });
      assert.equal(first.status, 202);
      assert.equal(first.body.code, 'SOLAPI_TIMEOUT');
      const again = await call(db, { auth: admin, requestKey });
      assert.equal(again.status, 202);
      assert.equal(again.body.idempotent, true);
      assert.equal(again.body.status, 'unknown');
    });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
  assert.equal(fetches, 1);
});

test('provider HTTP errors retain only a safe code; 4xx is rejected and 5xx is unknown', async () => {
  for (const [httpStatus, expectedHttp, expectedLedger] of [[400, 502, 'rejected'], [503, 202, 'unknown']]) {
    const db = new TestD1();
    const { requestKey } = seedFeedback(db);
    registerGuardian(db, '테스트학생');
    const r = await withFetch(async () => new Response(JSON.stringify({
      errorCode: 'InvalidTemplate<script>',
      errorMessage: 'recipient 01099998888 secret abcdefghijklmnopqrstuvwxyz123456'
    }), { status: httpStatus }), () => call(db, { auth: admin, requestKey }));
    assert.equal(r.status, expectedHttp);
    assert.equal(r.body.code, 'SOLAPI_HTTP_' + httpStatus + '_INVALIDTEMPLATESCRIPT');
    assert.doesNotMatch(JSON.stringify(r.body), /01099998888|abcdefghijklmnopqrstuvwxyz123456/);
    const ledger = db.prepare(
      'SELECT status,safe_error_code FROM parent_feedback_sends WHERE feedback_request_key=?'
    ).bind(requestKey).first();
    assert.equal(ledger.status, expectedLedger);
  }
});

test('consult app cannot use this feature', async () => {
  const db = new TestD1();
  const response = await worker.fetch(new Request('https://worker.example/parent-feedback-send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'consult', auth: { mode: 'admin', secret: 'consult-secret' }, requestKey: 'fbr_x' })
  }), { DB: db, ...fullEnvBase });
  assert.equal(response.status, 400);
});
