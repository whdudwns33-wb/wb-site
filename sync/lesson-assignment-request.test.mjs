import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { handleLessonAssignmentRequest, handleLessonAssignmentReview } from './lesson-assignment-request.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class DB {
  constructor() {
    this.rows = new Map();
    this.tasks = new Map();
    this.staff = new Map([['teacher-1', { id: 'teacher-1', name: '선생님', deleted: false }]]);
    this.rosterAt = 10;
    this.beforeBatch = null;
    this.lastChanges = null;
    this.roster = { roster: { updated: '2026-08-20', students: [{
      id: 'student-1', name: '학생', school: 'WB초', grade: '초4', subject: '수학', subjects: ['수학'],
      teacher: '', teacherIds: [], start: '2026-08', end: '', phoneMother: '010-0000-1234'
    }] }, bookStudents: [] };
  }
  prepare(sql) {
    const db = this;
    return { args: [], bind(...args) { this.args = args; return this; },
      async first() {
        if (sql.startsWith('SELECT * FROM lesson_assignment_requests')) return db.rows.get(this.args[1]) || null;
        if (sql.startsWith('SELECT data FROM staff')) { const value = db.staff.get(this.args[1]); return value ? { data: JSON.stringify(value) } : null; }
        if (sql.startsWith('SELECT data,updated_at FROM private_rosters')) return { data: JSON.stringify(db.roster), updated_at: db.rosterAt };
        if (sql.startsWith('SELECT data,updated_at FROM tasks')) return db.tasks.get(this.args[1]) || null;
        throw new Error('first ' + sql);
      },
      async all() {
        if (sql.startsWith('SELECT id,owner,data FROM tasks')) {
          const owner = String(this.args[1]);
          return { results: [...db.tasks.entries()].filter(([, row]) => row.owner === owner)
            .map(([id, row]) => ({ id, owner: row.owner, data: row.data })) };
        }
        if (!sql.startsWith('SELECT * FROM lesson_assignment_requests')) throw new Error('all ' + sql);
        const values = [...db.rows.values()].filter(row => sql.includes('staff_id=?') ? row.staff_id === this.args[1] : true);
        return { results: values };
      },
      async run() {
        if (sql.startsWith('INSERT INTO lesson_assignment_requests')) {
          const missing = sql.includes("NULL,1,'approval_waiting'");
          const [app,key,staffId,name,grade] = this.args;
          const studentId = missing ? null : this.args[5];
          const createdAt = missing ? this.args[5] : this.args[6];
          const updatedAt = missing ? this.args[6] : this.args[7];
          const requestData = missing ? this.args[7] : this.args[8];
          db.rows.set(key, { app, request_key:key, staff_id:staffId, student_name:name, grade, student_id:studentId,
            revision:1, status:'approval_waiting', created_at:createdAt, updated_at:updatedAt, reviewed_at:null,
            reviewed_by:null, review_note:null, request_data:requestData });
          return { meta:{changes:1} };
        }
        if (sql.startsWith("UPDATE lesson_assignment_requests SET status='cancelled'")) {
          const [updatedAt,app,key,rev] = this.args, row=db.rows.get(key);
          if (!row || row.revision!==rev || row.status!=='approval_waiting') return {meta:{changes:0}};
          Object.assign(row,{status:'cancelled',revision:row.revision+1,updated_at:updatedAt}); return {meta:{changes:1}};
        }
        if (sql.startsWith("UPDATE lesson_assignment_requests SET status='rejected'")) {
          const [updatedAt,reviewedAt,by,note,app,key,rev] = this.args, row=db.rows.get(key);
          if (!row || row.revision!==rev || row.status!=='approval_waiting') return {meta:{changes:0}};
          Object.assign(row,{status:'rejected',updated_at:updatedAt,reviewed_at:reviewedAt,reviewed_by:by,review_note:note}); return {meta:{changes:1}};
        }
        if (sql.startsWith('UPDATE lesson_assignment_requests SET student_name=')) {
          const modern = sql.includes('student_id=?');
          const [name,grade] = this.args;
          const studentId = modern ? this.args[2] : null;
          const requestData = modern ? this.args[3] : this.args[2];
          const updatedAt = modern ? this.args[4] : this.args[3];
          const key = modern ? this.args[6] : this.args[5];
          const rev = modern ? this.args[7] : this.args[6];
          const row = db.rows.get(key);
          if (!row || row.revision!==rev) return {meta:{changes:0}};
          Object.assign(row,{student_name:name,grade,student_id:studentId,request_data:requestData,revision:row.revision+1,
            status:'approval_waiting',updated_at:updatedAt,reviewed_at:null,reviewed_by:null,review_note:null}); return {meta:{changes:1}};
        }
        if (sql.startsWith('UPDATE private_rosters')) {
          const [data,updatedAt,app,expected] = this.args;
          if (expected!==db.rosterAt) return {meta:{changes:0}};
          db.roster=JSON.parse(data); db.rosterAt=updatedAt; return {meta:{changes:1}};
        }
        if (sql.startsWith('INSERT INTO tasks')) {
          const [app,id,owner,data,updatedAt] = this.args;
          if (db.tasks.has(id)) throw new Error('task conflict');
          db.tasks.set(id,{data,updated_at:updatedAt,owner,app}); return {meta:{changes:1}};
        }
        if (sql.startsWith('UPDATE tasks SET')) {
          const [data,updatedAt,srvAt,app,id,owner,expected] = this.args, row=db.tasks.get(id);
          if (!row || row.updated_at!==expected) return {meta:{changes:0}};
          db.tasks.set(id,{data,updated_at:updatedAt,owner,app}); return {meta:{changes:1}};
        }
        if (sql.startsWith("UPDATE lesson_assignment_requests SET status='approved'")) {
          const [studentId,updatedAt,reviewedAt,by,app,key,rev]=this.args,row=db.rows.get(key);
          if (!row || row.revision!==rev || row.status!=='approval_waiting') return {meta:{changes:0}};
          Object.assign(row,{student_id:studentId,status:'approved',updated_at:updatedAt,reviewed_at:reviewedAt,reviewed_by:by,review_note:null}); return {meta:{changes:1}};
        }
        if (sql.startsWith('INSERT INTO task_write_cas_guards')) {
          if (db.lastChanges !== 1) throw new Error('TASK_WRITE_CAS_CONFLICT');
          return { meta: { changes: 1 } };
        }
        throw new Error('run ' + sql);
      }
    };
  }
  async batch(statements) {
    if (this.beforeBatch) {
      const beforeBatch = this.beforeBatch;
      this.beforeBatch = null;
      beforeBatch(this);
    }
    const rowsSnapshot = new Map([...this.rows].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
    const tasksSnapshot = new Map([...this.tasks].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]));
    const rosterSnapshot = JSON.parse(JSON.stringify(this.roster));
    const rosterAtSnapshot = this.rosterAt;
    const results = [];
    try {
      for (const statement of statements) {
        const result = await statement.run();
        this.lastChanges = Number(result && result.meta && result.meta.changes || 0);
        results.push(result);
      }
      return results;
    } catch (error) {
      this.rows = rowsSnapshot;
      this.tasks = tasksSnapshot;
      this.roster = rosterSnapshot;
      this.rosterAt = rosterAtSnapshot;
      throw error;
    }
  }
}

async function body(response) { return response.json(); }
const own = { scope: 'own', id: 'teacher-1', role: 'staff' };
const all = { scope: 'all', id: 'manager-1', role: 'manager' };
const request = {
  action:'submit', studentId:'student-1', subjects:['클리닉'], startDate:'2026-08-25', reason:'클리닉 수업 배정',
  scheduleSlots:[
    {days:[1,3],startTime:'16:00',endTime:'17:50',lessonHours:'2T'},
    {days:[5],startTime:'19:00',endTime:'19:50',lessonHours:'1T'}
  ]
};

test('047 migration adds request details and replaces name-only pending uniqueness', () => {
  const migration = fs.readFileSync(path.join(import.meta.dirname, 'migrations', '047_lesson_assignment_details.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN request_data TEXT/);
  assert.match(migration, /staff_id, student_id/);
  assert.match(migration, /student_id IS NOT NULL/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/);
  assert.match(schema, /request_data TEXT/);
  assert.match(schema, /idx_lesson_assignment_requests_open_student/);
});

test('teacher receives active studentId candidates without full guardian contacts', async () => {
  const db = new DB();
  db.roster.roster.students[0].firstClassDate = '2026-09-05';
  db.roster.roster.students.push({ ...db.roster.roster.students[0], id:'student-2', teacherIds:[], phoneMother:'010-9999-5678' });
  const listed = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', { action:'list' }, '*', own, json));
  assert.equal(listed.candidates.length, 2);
  assert.equal(listed.candidates[0].id, 'student-1');
  assert.equal(listed.candidates[0].assigned, false);
  assert.equal(listed.candidates[0].firstClassDate, '2026-09-05');
  assert.equal(listed.candidates[0].teacherIds, undefined);
  assert.equal(listed.candidates[0].phoneMother, undefined);
  assert.match(listed.candidates[0].contactHint, /^\d{4}$/);
  assert.doesNotMatch(JSON.stringify(listed), /010-0000-1234/);
});

test('teacher requests and later approval cannot predate the latest roster first class date', async () => {
  const db = new DB();
  db.roster.roster.students[0].firstClassDate = '2026-09-05';
  const early = await handleLessonAssignmentRequest({ DB: db }, 'task', {
    ...request, startDate:'2026-09-04'
  }, '*', own, json);
  assert.equal(early.status, 400);
  assert.match((await body(early)).error, /첫 수업 시작일 2026-09-05 이후/);
  assert.equal(db.rows.size, 0);

  db.roster.roster.students[0].firstClassDate = '2026-08-20';
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', {
    ...request, startDate:'2026-09-01'
  }, '*', own, json));
  assert.equal(submitted.ok, true);
  db.roster.roster.students[0].firstClassDate = '2026-09-05';
  const approval = await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1'
  }, '*', all, json);
  assert.equal(approval.status, 409);
  assert.match((await body(approval)).error, /첫 수업 시작일 2026-09-05 이후/);
  assert.equal(db.tasks.size, 0);
  assert.equal(db.rows.get(submitted.request.requestKey).status, 'approval_waiting');
});

test('modern approval assigns the stable student and creates the requested lesson', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', request, '*', own, json));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.request.studentId, 'student-1');
  assert.deepEqual(submitted.request.details.subjects, ['클리닉']);
  assert.equal(submitted.request.details.lessonHours, '');
  assert.deepEqual(submitted.request.details.scheduleSlots.map(slot => slot.lessonHours), ['2T', '1T']);
  const approved = await body(await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1'
  }, '*', all, json));
  assert.equal(approved.ok, true);
  assert.equal(approved.task.studentId, 'student-1');
  assert.equal(approved.task.staffId, 'teacher-1');
  assert.equal(approved.task.subject, '클리닉');
  assert.equal(approved.task.lessonHours, '');
  assert.deepEqual(approved.task.scheduleSlots[0].days, [1,3]);
  assert.deepEqual(approved.task.scheduleSlots.map(slot => slot.lessonHours), ['2T', '1T']);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, [], '승인은 legacy main-teacher 목록을 쓰지 않는다');
  assert.equal(db.tasks.size, 1);
});

test('teacher assignment request rejects missing or invalid hours on any confirmed time', async () => {
  for (const lessonHours of ['', '50분', '1.6T']) {
    const db = new DB();
    const response = await handleLessonAssignmentRequest({ DB: db }, 'task', {
      ...request,
      scheduleSlots: request.scheduleSlots.map((slot, index) => index ? slot : { ...slot, lessonHours })
    }, '*', own, json);
    assert.equal(response.status, 400, lessonHours || 'empty');
    assert.equal(db.rows.size, 0);
  }
});

test('legacy roster assignment does not block a new subject, but an exact lesson duplicate does', async () => {
  const db = new DB();
  db.roster.roster.students[0].teacherIds = ['teacher-1'];
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', request, '*', own, json));
  assert.equal(submitted.ok, true);
  const approved = await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1'
  }, '*', all, json);
  assert.equal(approved.status, 200);
  const duplicate = await handleLessonAssignmentRequest({ DB: db }, 'task', request, '*', own, json);
  assert.equal(duplicate.status, 409);
  assert.equal(db.tasks.size, 1);
});

test('a request CAS race rolls back roster and lesson writes in assignment approval', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({DB:db},'task',{...request,action:'submit'},'*',own,json));
  const requestKey = submitted.request.requestKey;
  db.beforeBatch = database => {
    const row = database.rows.get(requestKey);
    row.revision = 2;
    row.updated_at += 1;
  };
  const reviewed = await handleLessonAssignmentReview({DB:db},'task',{
    action:'approve',requestKey,revision:1,studentId:'student-1'
  },'*',all,json);
  assert.equal(reviewed.status, 409);
  assert.equal(db.rows.get(requestKey).revision, 2);
  assert.equal(db.rows.get(requestKey).status, 'approval_waiting');
  assert.equal(db.tasks.size, 0);
  assert.deepEqual(db.roster.roster.students[0].subjects, ['수학']);
  assert.equal(db.rosterAt, 10);
});

test('missing-roster request stores school but never creates a student automatically', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', {
    action:'submit_missing', studentName:'새학생', school:'WB중', grade:'중1', reason:'명단에 보이지 않음'
  }, '*', own, json));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.request.studentId, '');
  assert.deepEqual(submitted.request.missing, { school:'WB중', reason:'명단에 보이지 않음' });
  assert.equal(db.roster.roster.students.length, 1);
});

test('missing-roster approval links the selected stable student without creating a lesson or main teacher', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', {
    action:'submit_missing', studentName:'새학생', school:'WB중', grade:'중1', reason:'명단에 보이지 않음'
  }, '*', own, json));
  const mismatch = await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1'
  }, '*', all, json);
  assert.equal(mismatch.status, 409);
  assert.equal((await body(mismatch)).code, 'IDENTITY_CONFIRM_REQUIRED');

  const approved = await body(await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1',
    confirmIdentityMismatch:true
  }, '*', all, json));
  assert.equal(approved.ok, true);
  assert.equal(approved.linkOnly, true);
  assert.equal(approved.task, null);
  assert.equal(approved.request.studentId, 'student-1');
  assert.equal(approved.request.status, 'approved');
  assert.equal(db.tasks.size, 0);
  assert.equal(db.rosterAt, 10, '연결 전용 승인은 원생 문서를 다시 쓰지 않는다');
  assert.deepEqual(db.roster.roster.students[0].teacherIds, []);
  assert.deepEqual(db.roster.roster.students[0].subjects, ['수학']);
});

test('legacy request still requires explicit identity confirmation', async () => {
  const db = new DB();
  db.rows.set('lar_legacy', { app:'task',request_key:'lar_legacy',staff_id:'teacher-1',student_name:'다른 학생',grade:'초4',
    student_id:null,revision:1,status:'approval_waiting',created_at:1,updated_at:1,reviewed_at:null,reviewed_by:null,review_note:null,request_data:null });
  const response = await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:'lar_legacy', revision:1, studentId:'student-1'
  }, '*', all, json);
  assert.equal(response.status, 409);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, []);
});

test('an older stable-student request without lesson hours cannot silently approve only the link', async () => {
  const db = new DB();
  db.rows.set('lar_old_modern', { app:'task',request_key:'lar_old_modern',staff_id:'teacher-1',student_name:'가학생',grade:'초4',
    student_id:'student-1',revision:1,status:'approval_waiting',created_at:1,updated_at:1,reviewed_at:null,reviewed_by:null,review_note:null,
    request_data:JSON.stringify({ subjects:['수학'], startDate:'2026-08-25', scheduleSlots:[{days:[1],startTime:'16:00',endTime:'17:00'}] }) });
  const response = await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:'lar_old_modern', revision:1
  }, '*', all, json);
  assert.equal(response.status, 409);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, []);
  assert.equal(db.tasks.size, 0);
});
