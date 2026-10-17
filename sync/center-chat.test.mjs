import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleCenterChat } from './center-chat.js';

const MIGRATION_SQL = readFileSync(new URL('./migrations/084_center_chat.sql', import.meta.url), 'utf8');
const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const MISSING_SQL = readFileSync(new URL('./migrations/085_center_chat_missing.sql', import.meta.url), 'utf8');
const BASE_SQL = `
PRAGMA foreign_keys=ON;
CREATE TABLE staff (
  app TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, data TEXT NOT NULL,
  updated_at INTEGER NOT NULL, srv_at INTEGER NOT NULL, PRIMARY KEY(app,id)
);
CREATE TABLE private_rosters (
  app TEXT NOT NULL PRIMARY KEY CHECK(app='task'), data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE task_write_cas_guards (
  app TEXT NOT NULL CHECK(app='task'), guard_id TEXT NOT NULL, operation TEXT NOT NULL,
  previous_changes INTEGER NOT NULL CHECK(previous_changes=1), created_at INTEGER NOT NULL,
  PRIMARY KEY(app,guard_id)
);
CREATE TRIGGER task_write_cas_guard BEFORE INSERT ON task_write_cas_guards
WHEN NEW.previous_changes<>1 BEGIN SELECT RAISE(ABORT,'TASK_WRITE_CAS_CONFLICT'); END;
CREATE TRIGGER task_write_cas_guard_no_update BEFORE UPDATE ON task_write_cas_guards
BEGIN SELECT RAISE(ABORT,'TASK_WRITE_CAS_GUARD_APPEND_ONLY'); END;
CREATE TRIGGER task_write_cas_guard_no_delete BEFORE DELETE ON task_write_cas_guards
BEGIN SELECT RAISE(ABORT,'TASK_WRITE_CAS_GUARD_APPEND_ONLY'); END;
`;

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
  constructor(ready = true) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(BASE_SQL);
    if (ready) { this.database.exec(MIGRATION_SQL); this.database.exec(MISSING_SQL); }
    this.prepareHook = null;
  }
  hookOnce(matcher, action) { this.prepareHook = { matcher, action }; }
  prepare(sql) {
    if (this.prepareHook && this.prepareHook.matcher.test(sql)) {
      const hook = this.prepareHook;
      this.prepareHook = null;
      hook.action(this.database);
    }
    return new Statement(this.database, sql);
  }
  batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}

const person = id => ({ scope: 'own', id });
const manager = id => ({ scope: 'all', id, role: 'manager' });
const director = { scope: 'all' };
const json = (body, status) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const fixedNow = Date.parse('2026-10-17T15:00:00+09:00');

async function atNow(value, action) {
  const original = Date.now;
  Date.now = () => value;
  try { return await action(); } finally { Date.now = original; }
}

async function atNowSequence(values, action) {
  const original = Date.now;
  let callIndex = 0;
  Date.now = () => values[Math.min(callIndex++, values.length - 1)];
  try { return await action(); } finally { Date.now = original; }
}

function putStaff(db, id, name, overrides = {}) {
  db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', id, id, JSON.stringify({
      id, name, deleted: false, phone: '010-9999-9999', memo: '직원 내부 메모', ...overrides
    }), fixedNow, fixedNow).run();
}

function putRoster(db) {
  const data = {
    roster: {
      updated: '2026-10-17', baseline: '2026-01', students: [
        { id: 'student-active', name: '재원 학생', grade: '초4', start: '2026-09', end: '', reason: '',
          subject: '수학', phoneMother: '010-1111-2222', memo: '검사 결과 내부 기록' },
        { id: 'student-future', name: '예정 학생', grade: '초5', start: '2026-11', end: '', reason: '', subject: '영어' },
        { id: 'student-ended', name: '종료 학생', grade: '초6', start: '2026-01', end: '2026-10', reason: '', subject: '국어' },
        { id: 'student-paused', name: '휴원 학생', grade: '중1', start: '2026-01', end: '',
          reason: '휴원 2026-10-01 · 내부 사유', subject: '수학' }
      ]
    },
    bookStudents: []
  };
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(data), fixedNow).run();
}

function seed(db) {
  putStaff(db, 'teacher-a', '김 선생');
  putStaff(db, 'teacher-b', '이 선생');
  putStaff(db, 'manager-a', '관리 선생');
  putStaff(db, 'teacher-deleted', '퇴사자', { deleted: true });
  putRoster(db);
}

async function call(db, payload, auth = person('teacher-a'), app = 'task') {
  const response = await handleCenterChat({ DB: db, TASK_MANAGER_STAFF_IDS: 'manager-a' }, app, { app, ...payload },
    'https://worker.example', auth, json);
  return { status: response.status, body: await response.json() };
}

function message(id, body = '센터 전달 내용') {
  return { action: 'send', messageId: id, body };
}

test('미등원은 학생·날짜당 한 알림이며 관리자 확인 후 등원으로 자동 종결한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const request = { action: 'missing', studentId: 'student-active', requestId: 'ccm_missing1' };
    assert.equal((await call(db, request)).status, 200);
    assert.equal((await call(db, { ...request, requestId: 'ccm_missing2' }, person('teacher-b'))).status, 200);
    let result = await call(db, { action: 'list' }, manager('manager-a'));
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].body, '재원 학생 학생이 아직 등원하지 않았습니다.');
    assert.equal(result.body.presence.length, 0);
    assert.equal(result.body.canHandleMissing, true);
    const handle = { action: 'missing_handle', studentId: request.studentId, requestId: request.requestId };
    assert.equal((await call(db, handle)).status, 403);
    assert.equal((await call(db, handle, manager('manager-a'))).body.missing.handlerName, '관리 선생');
    assert.equal((await call(db, handle, director)).body.missing.handlerName, '관리 선생');
    assert.equal((await call(db, presence('cpe_arrival1', 'arrived', 0))).status, 200);
    result = await call(db, { action: 'list' });
    assert.equal(result.body.missing[0].state, 'resolved');
    assert.equal((await call(db, request)).status, 409);
    assert.equal(result.body.items.length, 2);
    assert.equal(result.body.canHandleMissing, false);
  });
});

test('결석·하원도 요청 종결, 이미 상태가 있는 학생은 미등원 재알림 금지', async () => {
  await atNow(fixedNow, async () => {
    for (const status of ['absent', 'left']) {
      const db = new TestD1(); seed(db);
      const request = { action: 'missing', studentId: 'student-active', requestId: 'ccm_missing1' };
      await call(db, request);
      await call(db, presence('cpe_resolve1', status, 0));
      assert.equal((await call(db, { action: 'list' })).body.missing[0].state, 'resolved');
      assert.equal((await call(db, request)).status, 409);
    }
    const db = new TestD1(); seed(db);
    await call(db, presence('cpe_arrival1', 'arrived', 0));
    assert.equal((await call(db, { action: 'missing', studentId: 'student-active', requestId: 'ccm_missing1' })).status, 409);
    assert.equal((await call(db, { action: 'list' })).body.items.length, 1);
  });
});

test('미등원은 당일만 표시하고 퇴원생·변경된 직원은 기록하지 않는다', async () => {
  const db = new TestD1(); seed(db);
  await atNow(fixedNow, async () => {
    assert.equal((await call(db, { action: 'missing', studentId: 'student-ended', requestId: 'ccm_missing1' })).status, 409);
    await call(db, { action: 'missing', studentId: 'student-active', requestId: 'ccm_missing1' });
  });
  await atNow(fixedNow + 86400000, async () => {
    assert.deepEqual((await call(db, { action: 'list' })).body.missing, []);
    assert.equal((await call(db, { action: 'missing', studentId: 'student-active', requestId: 'ccm_missing2' })).status, 200);
  });
  assert.doesNotThrow(() => db.database.exec(MISSING_SQL));
  assert.ok(SCHEMA_SQL.replace(/\r\n/g, '\n').includes(MISSING_SQL.replace(/\r\n/g, '\n').trim()));
});

function presence(id, status, expectedRevision, studentId = 'student-active') {
  return { action: 'presence', eventId: id, studentId, status, expectedRevision };
}

test('list는 서버 KST 날짜와 현재 재원생 최소 필드만 반환한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const result = await call(db, { action: 'list' });
    assert.equal(result.status, 200);
    assert.equal(result.body.date, '2026-10-17');
    assert.deepEqual(result.body.actor, { id: 'teacher-a', name: '김 선생' });
    assert.deepEqual(result.body.students, [{ id: 'student-active', name: '재원 학생', grade: '초4' }]);
    assert.deepEqual(result.body.presence, []);
    assert.deepEqual(result.body.items, []);
    assert.equal(result.body.lastItemId, '');
    assert.equal(result.body.unreadCount, 0);
    assert.doesNotMatch(JSON.stringify(result.body), /010-|내부 메모|검사 결과|subject|phone|memo/);

    const byDirector = await call(db, { action: 'list' }, director);
    assert.deepEqual(byDirector.body.actor, { id: 'director', name: '원장님' });
    const byManager = await call(db, { action: 'list' }, manager('manager-a'));
    assert.deepEqual(byManager.body.actor, { id: 'manager-a', name: '관리 선생' });
  });
});

test('메시지는 NFKC 정규화·서버 작성자·서버 시각으로 멱등 저장한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const first = await call(db, message('ccm_message_001', '  ＡＢ  \r\n\r\n\r\n확인  '));
    assert.equal(first.status, 200);
    assert.equal(first.body.idempotent, false);
    assert.deepEqual(first.body.message, {
      kind: 'message', id: 'ccm_message_001', messageId: 'ccm_message_001',
      messageDate: '2026-10-17', body: 'AB\n\n확인', actorId: 'teacher-a',
      actorName: '김 선생', createdAt: fixedNow
    });
    const retry = await call(db, message('ccm_message_001', '  ＡＢ  \r\n\r\n\r\n확인  '));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent, true);
    assert.equal(db.database.prepare("SELECT COUNT(*) count FROM center_chat_events WHERE kind='message'").get().count, 1);

    const collision = await call(db, message('ccm_message_001', '다른 내용'));
    assert.equal(collision.status, 409);
    assert.equal(collision.body.code, 'CENTER_CHAT_MESSAGE_ID_CONFLICT');
    assert.equal((await call(db, message('bad id'))).status, 400);
    assert.equal((await call(db, message('ccm_message_002', '가'.repeat(1001)))).status, 400);
    assert.equal((await call(db, message('ccm_message_003', '   '))).status, 400);
  });
});

test('미확인은 다른 직원의 피드 항목만 세고 read는 지정 항목까지만 단조 증가한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    await call(db, message('ccm_message_001', '첫 메시지'), person('teacher-a'));
    await call(db, message('ccm_message_002', '둘째 메시지'), person('teacher-b'));
    const own = await call(db, { action: 'list' }, person('teacher-b'));
    assert.equal(own.body.unreadCount, 1);
    assert.equal(own.body.lastItemId, 'ccm_message_002');
    assert.deepEqual(own.body.items.map(item => [item.kind, item.id]), [
      ['message', 'ccm_message_001'], ['message', 'ccm_message_002']
    ]);

    const readFirst = await call(db, { action: 'read', itemId: 'ccm_message_001' }, person('teacher-b'));
    assert.equal(readFirst.status, 200);
    assert.equal(readFirst.body.unreadCount, 0);
    assert.equal(readFirst.body.lastItemId, 'ccm_message_001');
    const readLatest = await call(db, { action: 'read', itemId: 'ccm_message_002' }, person('teacher-b'));
    assert.equal(readLatest.body.lastItemId, 'ccm_message_002');
    const backwards = await call(db, { action: 'read', itemId: 'ccm_message_001' }, person('teacher-b'));
    assert.equal(backwards.body.idempotent, true);
    assert.equal(backwards.body.lastItemId, 'ccm_message_002');

    await call(db, message('ccm_message_003', '셋째 메시지'), person('teacher-a'));
    assert.equal((await call(db, { action: 'list' }, person('teacher-b'))).body.unreadCount, 1);
    assert.equal((await call(db, { action: 'read', itemId: 'ccm_missing_001' }, person('teacher-b'))).status, 404);
  });
});

test('최신 100건 밖의 미확인은 별도 개수로 알려 자동 확인 손실을 막는다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const insert = db.database.prepare(
      'INSERT INTO center_chat_events ' +
      '(app,kind,item_id,event_date,actor_staff_id,actor_name,body,student_id,status,revision,created_at) ' +
      "VALUES('task','message',?,'2026-10-17','teacher-a','김 선생',?,NULL,NULL,NULL,?)"
    );
    for (let index = 0; index < 105; index++) {
      insert.run('ccm_hidden_' + String(index).padStart(4, '0'), '메시지 ' + index, fixedNow + index);
    }
    const listed = await call(db, { action: 'list' }, person('teacher-b'));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 100);
    assert.equal(listed.body.unreadCount, 105);
    assert.equal(listed.body.hiddenUnreadCount, 5);
  });
});

test('등원 상태는 현재 재원 stable ID와 expectedRevision으로만 바꾸고 이벤트는 멱등 보존한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const arrived = await call(db, presence('cpe_presence_001', 'arrived', 0));
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.idempotent, false);
    assert.deepEqual(arrived.body.presence, {
      studentId: 'student-active', status: 'arrived', revision: 1, updatedAt: fixedNow,
      actorId: 'teacher-a', actorName: '김 선생'
    });
    assert.deepEqual({
      kind: arrived.body.event.kind, id: arrived.body.event.id, eventId: arrived.body.event.eventId,
      studentId: arrived.body.event.studentId, status: arrived.body.event.status,
      revision: arrived.body.event.revision, actorId: arrived.body.event.actorId
    }, {
      kind: 'presence', id: 'cpe_presence_001', eventId: 'cpe_presence_001',
      studentId: 'student-active', status: 'arrived', revision: 1, actorId: 'teacher-a'
    });
    assert.equal((await call(db, presence('cpe_presence_001', 'arrived', 0))).body.idempotent, true);

    const ownAfterPresence = await call(db, { action: 'list' }, person('teacher-a'));
    assert.equal(ownAfterPresence.body.unreadCount, 0);
    const otherAfterPresence = await call(db, { action: 'list' }, person('teacher-b'));
    assert.equal(otherAfterPresence.body.unreadCount, 1);
    assert.equal(otherAfterPresence.body.lastItemId, 'cpe_presence_001');
    const otherReadPresence = await call(db,
      { action: 'read', itemId: 'cpe_presence_001' }, person('teacher-b'));
    assert.equal(otherReadPresence.body.unreadCount, 0);
    assert.equal(otherReadPresence.body.lastItemId, 'cpe_presence_001');

    const left = await atNow(fixedNow + 1, () =>
      call(db, presence('cpe_presence_002', 'left', 1), person('teacher-b')));
    assert.equal(left.status, 200);
    assert.equal(left.body.presence.revision, 2);
    assert.equal(left.body.presence.actorName, '이 선생');

    const stale = await atNow(fixedNow + 2, () =>
      call(db, presence('cpe_presence_003', 'absent', 1)));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'CENTER_CHAT_PRESENCE_REVISION_CONFLICT');
    assert.equal(stale.body.current.revision, 2);
    const reused = await call(db, presence('cpe_presence_001', 'left', 0));
    assert.equal(reused.status, 409);
    assert.equal(reused.body.code, 'CENTER_CHAT_EVENT_ID_CONFLICT');
    assert.equal((await call(db, presence('cpe_presence_004', 'arrived', 0, 'student-future'))).status, 409);
    assert.equal((await call(db, presence('cpe_presence_005', 'unknown', 0))).status, 400);

    const listed = await call(db, { action: 'list' });
    assert.deepEqual(listed.body.presence.map(item => [item.studentId, item.status, item.revision]),
      [['student-active', 'left', 2]]);
    assert.deepEqual(listed.body.items.map(item => [item.kind, item.id]), [
      ['presence', 'cpe_presence_001'], ['presence', 'cpe_presence_002']
    ]);
    assert.equal(listed.body.unreadCount, 1);
    assert.equal(listed.body.lastItemId, 'cpe_presence_002');
    const readPresence = await call(db, { action: 'read', itemId: 'cpe_presence_002' });
    assert.equal(readPresence.body.unreadCount, 0);
    assert.equal(readPresence.body.lastItemId, 'cpe_presence_002');
  });
});

test('관리자 점검 세션은 대상 교사가 아니라 allowlist 관리자를 actor로 기록한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const inspection = { scope: 'own', id: 'teacher-a', inspection: true,
      managerId: 'manager-a', sourceStaffId: 'teacher-a' };
    const sent = await call(db, message('ccm_inspection_001'), inspection);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.message.actorId, 'manager-a');
    assert.equal(sent.body.message.actorName, '관리 선생');
    const arrived = await call(db, presence('cpe_inspection_001', 'arrived', 0), inspection);
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.event.actorId, 'manager-a');
    const read = await call(db, { action: 'read', itemId: 'cpe_inspection_001' }, inspection);
    assert.equal(read.status, 200);
    assert.deepEqual(db.database.prepare(
      'SELECT DISTINCT actor_staff_id FROM center_chat_events ORDER BY actor_staff_id'
    ).all().map(row => row.actor_staff_id), ['manager-a']);
    assert.deepEqual(db.database.prepare(
      'SELECT reader_staff_id FROM center_chat_reads ORDER BY reader_staff_id'
    ).all().map(row => row.reader_staff_id), ['manager-a']);

    const forged = { ...inspection, managerId: 'teacher-b' };
    assert.equal((await call(db, message('ccm_inspection_002'), forged)).status, 403);
    assert.equal((await call(db, message('ccm_forged_all_001'),
      { scope: 'all', id: 'teacher-a', role: 'manager' })).status, 403);
  });
});

test('원장은 메시지·등원·읽기를 director actor로 기록한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    const sent = await call(db, message('ccm_director_001'), director);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.message.actorId, 'director');
    const arrived = await call(db, presence('cpe_director_001', 'arrived', 0), director);
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.event.actorId, 'director');
    const read = await call(db, { action: 'read', itemId: 'cpe_director_001' }, director);
    assert.equal(read.status, 200);
    assert.deepEqual(db.database.prepare(
      'SELECT DISTINCT actor_staff_id FROM center_chat_events ORDER BY actor_staff_id'
    ).all().map(row => row.actor_staff_id), ['director']);
    assert.deepEqual(db.database.prepare(
      'SELECT reader_staff_id FROM center_chat_reads ORDER BY reader_staff_id'
    ).all().map(row => row.reader_staff_id), ['director']);
  });
});

test('자정 직전 요청은 날짜와 시각을 한 번에 고정하고 자정 뒤 exact retry도 멱등이다', async () => {
  const beforeMidnight = Date.parse('2026-10-17T23:59:59.999+09:00');
  const afterMidnight = Date.parse('2026-10-18T00:00:00.001+09:00');
  const db = new TestD1(); seed(db);

  const sent = await atNowSequence([beforeMidnight, afterMidnight], () =>
    call(db, message('ccm_midnight_001', '자정 경계 메시지')));
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.messageDate, '2026-10-17');
  assert.equal(sent.body.message.createdAt, beforeMidnight);
  const arrived = await atNowSequence([beforeMidnight, afterMidnight], () =>
    call(db, presence('cpe_midnight_001', 'arrived', 0)));
  assert.equal(arrived.status, 200);
  assert.equal(arrived.body.event.createdAt, beforeMidnight);
  assert.equal(arrived.body.presence.updatedAt, beforeMidnight);

  const messageRetry = await atNow(afterMidnight, () =>
    call(db, message('ccm_midnight_001', '자정 경계 메시지')));
  assert.equal(messageRetry.status, 200);
  assert.equal(messageRetry.body.idempotent, true);
  assert.equal(messageRetry.body.message.messageDate, '2026-10-17');
  const presenceRetry = await atNow(afterMidnight, () =>
    call(db, presence('cpe_midnight_001', 'arrived', 0)));
  assert.equal(presenceRetry.status, 200);
  assert.equal(presenceRetry.body.idempotent, true);
  assert.equal(presenceRetry.body.presence.updatedAt, beforeMidnight);
  assert.equal(db.database.prepare(
    "SELECT event_date FROM center_chat_events WHERE item_id='cpe_midnight_001'"
  ).get().event_date, '2026-10-17');
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM center_chat_events').get().count, 2);
});

test('자정 뒤 presence 경합 exact retry도 기존 이벤트 날짜의 current를 반환한다', async () => {
  const beforeMidnight = Date.parse('2026-10-17T23:59:59.999+09:00');
  const afterMidnight = Date.parse('2026-10-18T00:00:00.001+09:00');
  const db = new TestD1(); seed(db);
  db.hookOnce(/^INSERT INTO center_chat_events/, database => {
    database.prepare(
      'INSERT INTO center_chat_presence ' +
      '(app,presence_date,student_id,status,revision,updated_at,updated_by_staff_id,updated_by_name) ' +
      'VALUES(?,?,?,?,?,?,?,?)'
    ).run('task', '2026-10-17', 'student-active', 'arrived', 1, beforeMidnight, 'teacher-a', '김 선생');
    database.prepare(
      'INSERT INTO center_chat_events ' +
      '(app,kind,item_id,event_date,actor_staff_id,actor_name,body,student_id,status,revision,created_at) ' +
      "VALUES(?,'presence',?,?,?,?,NULL,?,?,?,?)"
    ).run('task', 'cpe_midnight_race_001', '2026-10-17', 'teacher-a', '김 선생',
      'student-active', 'arrived', 1, beforeMidnight);
  });

  const retry = await atNow(afterMidnight, () =>
    call(db, presence('cpe_midnight_race_001', 'arrived', 0)));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.event.createdAt, beforeMidnight);
  assert.equal(retry.body.presence.updatedAt, beforeMidnight);
  assert.equal(db.database.prepare('SELECT COUNT(*) count FROM center_chat_presence').get().count, 1);
});

test('실제 write 직전 직원·roster snapshot 변경과 presence CAS 경합은 부분 저장 없이 거부한다', async () => {
  await atNow(fixedNow, async () => {
    const actorDb = new TestD1(); seed(actorDb);
    actorDb.hookOnce(/^INSERT OR IGNORE INTO center_chat_events/, database => {
      const row = database.prepare("SELECT data FROM staff WHERE app='task' AND id='teacher-a'").get();
      const data = JSON.parse(row.data); data.name = '변경 선생';
      database.prepare("UPDATE staff SET data=? WHERE app='task' AND id='teacher-a'").run(JSON.stringify(data));
    });
    const actorChanged = await call(actorDb, message('ccm_actor_race_001'));
    assert.equal(actorChanged.status, 409);
    assert.equal(actorChanged.body.code, 'CENTER_CHAT_ACTOR_CHANGED');
    assert.equal(actorDb.database.prepare('SELECT COUNT(*) count FROM center_chat_events').get().count, 0);

    const rosterDb = new TestD1(); seed(rosterDb);
    rosterDb.hookOnce(/^INSERT OR IGNORE INTO center_chat_presence/, database => {
      const row = database.prepare("SELECT data FROM private_rosters WHERE app='task'").get();
      const document = JSON.parse(row.data);
      document.roster.students.find(student => student.id === 'student-active').end = '2026-10';
      database.prepare("UPDATE private_rosters SET data=?,updated_at=updated_at+1 WHERE app='task'")
        .run(JSON.stringify(document));
    });
    const rosterChanged = await call(rosterDb, presence('cpe_roster_race_001', 'arrived', 0));
    assert.equal(rosterChanged.status, 409);
    assert.equal(rosterDb.database.prepare('SELECT COUNT(*) count FROM center_chat_presence').get().count, 0);
    assert.equal(rosterDb.database.prepare('SELECT COUNT(*) count FROM center_chat_events').get().count, 0);
    assert.equal(rosterDb.database.prepare('SELECT COUNT(*) count FROM task_write_cas_guards').get().count, 0);

    const casDb = new TestD1(); seed(casDb);
    await call(casDb, presence('cpe_cas_race_001', 'arrived', 0));
    casDb.hookOnce(/^UPDATE center_chat_presence SET/, database => {
      database.prepare("UPDATE center_chat_presence SET status='absent',revision=2,updated_at=updated_at+1 " +
        "WHERE app='task' AND student_id='student-active'").run();
    });
    const raced = await atNow(fixedNow + 2, () =>
      call(casDb, presence('cpe_cas_race_002', 'left', 1), person('teacher-b')));
    assert.equal(raced.status, 409);
    assert.equal(raced.body.current.revision, 2);
    assert.equal(casDb.database.prepare(
      "SELECT COUNT(*) count FROM center_chat_events WHERE item_id='cpe_cas_race_002'"
    ).get().count, 0);
    assert.equal(casDb.database.prepare('SELECT COUNT(*) count FROM task_write_cas_guards').get().count, 1);
  });
});

test('이전 날짜 메시지는 유지하지만 등원 current와 event는 오늘 것만 list한다', async () => {
  const yesterday = fixedNow - 86400000;
  const db = new TestD1(); seed(db);
  await atNow(yesterday, async () => {
    await call(db, message('ccm_yesterday_001', '어제 전달'));
    await call(db, presence('cpe_yesterday_001', 'arrived', 0));
  });
  await atNow(fixedNow, async () => {
    await call(db, message('ccm_today_001', '오늘 전달'), person('teacher-b'));
    const listed = await call(db, { action: 'list' });
    assert.deepEqual(listed.body.items.map(item => [item.kind, item.id]), [
      ['message', 'ccm_yesterday_001'], ['message', 'ccm_today_001']
    ]);
    assert.deepEqual(listed.body.presence, []);
    assert.equal(listed.body.lastItemId, 'ccm_today_001');
  });
});

test('메시지·등원 이벤트는 append-only이고 current/read 불변식을 DB가 강제한다', async () => {
  await atNow(fixedNow, async () => {
    const db = new TestD1(); seed(db);
    await call(db, message('ccm_message_001'));
    await call(db, presence('cpe_presence_001', 'arrived', 0));
    await call(db, { action: 'read', itemId: 'ccm_message_001' });
    assert.throws(() => db.database.prepare(
      "UPDATE center_chat_events SET body='변조' WHERE item_id='ccm_message_001'"
    ).run(), /APPEND_ONLY/);
    assert.throws(() => db.database.prepare(
      "DELETE FROM center_chat_events WHERE item_id='cpe_presence_001'"
    ).run(), /APPEND_ONLY/);
    assert.throws(() => db.database.prepare(
      "UPDATE center_chat_presence SET revision=revision+2,updated_at=updated_at+1"
    ).run(), /REVISION_INVALID/);
    assert.throws(() => db.database.prepare(
      "UPDATE center_chat_reads SET read_through_feed_seq=0"
    ).run(), /CHECK constraint|READ_MARKER_INVALID/);
  });
});

test('비 task·퇴사자·미준비 테이블은 fail-closed이고 Worker 라우트가 연결된다', async () => {
  const db = new TestD1(); seed(db);
  assert.equal((await call(db, { action: 'list' }, person('teacher-a'), 'consult')).status, 400);
  assert.equal((await call(db, { action: 'list' }, person('teacher-deleted'))).status, 403);
  assert.equal((await call(db, { action: 'unknown' })).status, 400);
  const missing = new TestD1(false); seed(missing);
  const unavailable = await call(missing, { action: 'list' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'CENTER_CHAT_NOT_READY');

  const worker = readFileSync(new URL('./worker-core.js', import.meta.url), 'utf8');
  assert.match(worker, /import \{ handleCenterChat \} from '\.\/center-chat\.js'/);
  assert.match(worker, /url\.pathname === '\/center-chat'/);
  assert.match(worker, /handleCenterChat\(env, app, body, okOrigin, auth, json\)/);
});

test('084 migration은 비파괴·재적용 가능하고 schema.sql과 같은 정의를 유지한다', () => {
  assert.doesNotMatch(MIGRATION_SQL, /\b(?:DROP|DELETE\s+FROM|ALTER\s+TABLE)\b/i);
  const normalizedMigration = MIGRATION_SQL.replace(/\r\n/g, '\n').trim();
  const normalizedSchema = SCHEMA_SQL.replace(/\r\n/g, '\n');
  assert.ok(normalizedSchema.includes(normalizedMigration));

  const database = new DatabaseSync(':memory:');
  database.exec(BASE_SQL);
  database.exec(MIGRATION_SQL);
  assert.doesNotThrow(() => database.exec(MIGRATION_SQL));
});
