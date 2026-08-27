import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { buildLessonTask, handleLessonCreate } from './lesson-create.js';
import { handleLessonChangeRequest, handleLessonChangeReview } from './lesson-change-request.js';
import { handleSessionPack } from './session-pack.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});
const admin = { scope: 'all', role: 'admin' };
const own = id => ({ scope: 'own', id, role: 'staff' });
const kstToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(schema);
    this.beforeBatch = null;
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      hook(this.database);
    }
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

function rawLesson() {
  return {
    studentId: '12345678', studentName: '회차학생', grade: '중2', subject: '수학', className: '',
    lessonRole: '수학', lessonHours: '2T', scheduleText: '',
    scheduleSlots: [{ days: [1, 3], startTime: '18:00', endTime: '19:50', lessonHours: '2T' }],
    scheduleStatus: 'normal', start: '2026-08-01', materials: '교재', onlineProgram: '없음',
    homework: '없음', studentTraits: '특이사항 없음', goal: '기초 완성', parentRequest: '없음',
    adminRequest: '없음'
  };
}

async function seed() {
  const db = new TestD1();
  const now = 1_777_000_000_000;
  for (const [id, name] of [['teacher-a', '가선생'], ['teacher-b', '나선생']]) {
    db.prepare('INSERT INTO staff(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
      .bind('task', id, id, JSON.stringify({ id, name, deleted: false }), now, now).run();
  }
  const task = await buildLessonTask(rawLesson(), 'teacher-a', 'manager', now);
  db.prepare('INSERT INTO tasks(app,id,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id, 'teacher-a', JSON.stringify(task), task.updatedAt, task.updatedAt).run();
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)').bind('task', JSON.stringify({
    roster: { updated: '2026-08-27', baseline: '2026-08', students: [{
      id: '12345678', name: '회차학생', grade: '중2', teacher: '', teacherIds: [], subject: '수학',
      subjects: ['수학'], start: '2026-01', end: '', reason: ''
    }] }, bookStudents: []
  }), now).run();
  return { db, task };
}

async function packCall(db, body, auth = admin) {
  const response = await handleSessionPack({ DB: db }, 'task', body, '*', auth, json);
  return { status: response.status, body: await response.json() };
}

async function createPackWithUsage(db, task) {
  const created = await packCall(db, {
    action: 'create', studentId: '12345678', lessonTaskId: task.id, totalSessions: 8,
    validFrom: '2026-08-01', expiresOn: '2026-12-31', deductionPolicy: 'recommended_v1'
  });
  assert.equal(created.status, 200);
  const adjusted = await packCall(db, {
    action: 'adjust', packId: created.body.pack.packId, revision: created.body.pack.revision,
    delta: 2, sourceKey: 'initial-credit-use', reasonCode: 'manual_credit'
  });
  assert.equal(adjusted.status, 200);
  return adjusted.body.pack;
}

function packRow(db, packId) {
  return db.database.prepare("SELECT * FROM session_packs WHERE app='task' AND pack_id=?").get(packId);
}

function usageRows(db, packId) {
  return db.database.prepare(
    "SELECT entry_id,pack_id,source_type,source_ref,attendance_event,delta,reason_code,actor_id,created_at " +
    "FROM session_pack_usage WHERE app='task' AND pack_id=? ORDER BY entry_id"
  ).all(packId);
}

async function consumptionGroup(taskId, date) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('task\n' + taskId + '\n' + date));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'mc_' + hex.slice(0, 48);
}

test('direct lesson transfer moves the active pack and preserves its ledger, balance, and new-owner use', async () => {
  const { db, task } = await seed();
  const beforePack = await createPackWithUsage(db, task);
  const beforeRow = packRow(db, beforePack.packId);
  const beforeUsage = usageRows(db, beforePack.packId);

  const response = await handleLessonCreate({ DB: db }, 'task', {
    staffId: 'teacher-b', sourceTaskId: task.id, expectedRevision: 1, lesson: rawLesson()
  }, '*', admin, json);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.task.staffId, 'teacher-b');

  const moved = packRow(db, beforePack.packId);
  assert.equal(moved.pack_id, beforeRow.pack_id);
  assert.equal(moved.task_owner, 'teacher-b');
  assert.equal(moved.lesson_assignment_key, result.task.lessonAssignmentKey);
  assert.notEqual(moved.task_identity_hash, beforeRow.task_identity_hash);
  assert.equal(moved.revision, beforeRow.revision + 1);
  assert.deepEqual(usageRows(db, beforePack.packId), beforeUsage);
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) AS count FROM session_pack_transfer_guards WHERE app='task' AND pack_id=?"
  ).get(beforePack.packId).count, 1);
  assert.throws(() => db.database.prepare(
    "UPDATE session_pack_transfer_guards SET previous_changes=0 WHERE app='task' AND pack_id=?"
  ).run(beforePack.packId), /SESSION_PACK_TRANSFER_GUARD_APPEND_ONLY/);

  const oldList = await packCall(db, { action: 'list' }, own('teacher-a'));
  const newList = await packCall(db, { action: 'list' }, own('teacher-b'));
  assert.equal(oldList.body.packs.length, 0);
  assert.equal(newList.body.packs.length, 1);
  assert.equal(newList.body.packs[0].remainingSessions, 6);

  const date = '2026-08-31';
  db.prepare('INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES(?,?,?,?,?,?)')
    .bind('task', task.id + '|' + date, 'teacher-b', JSON.stringify({ taskId: task.id, date, att: 'P' }),
      Date.now(), Date.now()).run();
  const used = await packCall(db, {
    action: 'record', packId: beforePack.packId, revision: moved.revision, sourceType: 'regular',
    sourceKey: task.id + '|' + date, consumptionGroupId: await consumptionGroup(task.id, date)
  }, own('teacher-b'));
  assert.equal(used.status, 200);
  assert.equal(used.body.pack.remainingSessions, 5);
  assert.equal(usageRows(db, beforePack.packId).length, beforeUsage.length + 1);
});

test('approved teacher-assignment request transfers the same active pack without rewriting usage', async () => {
  const { db, task } = await seed();
  const beforePack = await createPackWithUsage(db, task);
  const beforeRow = packRow(db, beforePack.packId);
  const beforeUsage = usageRows(db, beforePack.packId);

  const submittedResponse = await handleLessonChangeRequest({ DB: db }, 'task', {
    action: 'submit', taskId: task.id,
    changes: { operation: 'teacher_assignment', effectiveDate: kstToday() }, note: '담당 변경'
  }, '*', own('teacher-a'), json);
  assert.equal(submittedResponse.status, 200);
  const submitted = await submittedResponse.json();
  const approvedResponse = await handleLessonChangeReview({ DB: db }, 'task', {
    action: 'approve', requestKey: submitted.request.requestKey,
    revision: submitted.request.revision, selectedStaffId: 'teacher-b'
  }, '*', admin, json);
  assert.equal(approvedResponse.status, 200);

  const taskRow = db.database.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id=?").get(task.id);
  const movedTask = JSON.parse(taskRow.data);
  const movedPack = packRow(db, beforePack.packId);
  assert.equal(taskRow.owner, 'teacher-b');
  assert.equal(movedTask.staffId, 'teacher-b');
  assert.notEqual(movedTask.lessonAssignmentKey, task.lessonAssignmentKey);
  assert.equal(movedPack.pack_id, beforeRow.pack_id);
  assert.equal(movedPack.task_owner, 'teacher-b');
  assert.equal(movedPack.lesson_assignment_key, movedTask.lessonAssignmentKey);
  assert.notEqual(movedPack.task_identity_hash, beforeRow.task_identity_hash);
  assert.equal(movedPack.revision, beforeRow.revision + 1);
  assert.deepEqual(usageRows(db, beforePack.packId), beforeUsage);
  const newList = await packCall(db, { action: 'list' }, own('teacher-b'));
  assert.equal(newList.body.packs[0].remainingSessions, 6);
});

for (const race of ['task', 'pack']) {
  test(race + ' CAS conflict rolls the other half of a direct transfer back', async () => {
    const { db, task } = await seed();
    const beforePack = await createPackWithUsage(db, task);
    const beforeRow = packRow(db, beforePack.packId);
    db.beforeBatch = database => {
      if (race === 'pack') {
        database.prepare(
          "UPDATE session_packs SET revision=revision+1,updated_at=updated_at+1,updated_by='concurrent' " +
          "WHERE app='task' AND pack_id=?"
        ).run(beforePack.packId);
      } else {
        const row = database.prepare("SELECT data,updated_at FROM tasks WHERE app='task' AND id=?").get(task.id);
        const data = JSON.parse(row.data);
        data.updatedAt = Number(row.updated_at) + 1;
        database.prepare("UPDATE tasks SET data=?,updated_at=updated_at+1,srv_at=srv_at+1 WHERE app='task' AND id=?")
          .run(JSON.stringify(data), task.id);
      }
    };

    const response = await handleLessonCreate({ DB: db }, 'task', {
      staffId: 'teacher-b', sourceTaskId: task.id, expectedRevision: 1, lesson: rawLesson()
    }, '*', admin, json);
    assert.equal(response.status, 409);
    const taskAfter = db.database.prepare("SELECT owner,data FROM tasks WHERE app='task' AND id=?").get(task.id);
    const packAfter = packRow(db, beforePack.packId);
    assert.equal(taskAfter.owner, 'teacher-a');
    assert.equal(JSON.parse(taskAfter.data).staffId, 'teacher-a');
    assert.equal(packAfter.task_owner, 'teacher-a');
    assert.equal(packAfter.lesson_assignment_key, beforeRow.lesson_assignment_key);
    assert.equal(packAfter.task_identity_hash, beforeRow.task_identity_hash);
    assert.equal(db.database.prepare(
      "SELECT COUNT(*) AS count FROM session_pack_transfer_guards WHERE app='task'"
    ).get().count, 0, '실패 batch에는 감사 guard도 남지 않는다');
  });
}
