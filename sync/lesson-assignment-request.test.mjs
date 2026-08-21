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
        throw new Error('run ' + sql);
      }
    };
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}

async function body(response) { return response.json(); }
const own = { scope: 'own', id: 'teacher-1', role: 'staff' };
const all = { scope: 'all', id: 'manager-1', role: 'manager' };
const request = {
  action:'submit', studentId:'student-1', subjects:['클리닉'], startDate:'2026-08-25', reason:'클리닉 수업 배정',
  scheduleSlots:[{days:[1,3],startTime:'16:00',endTime:'17:00'}]
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
  db.roster.roster.students.push({ ...db.roster.roster.students[0], id:'student-2', teacherIds:[], phoneMother:'010-9999-5678' });
  const listed = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', { action:'list' }, '*', own, json));
  assert.equal(listed.candidates.length, 2);
  assert.equal(listed.candidates[0].id, 'student-1');
  assert.equal(listed.candidates[0].phoneMother, undefined);
  assert.match(listed.candidates[0].contactHint, /^\d{4}$/);
  assert.doesNotMatch(JSON.stringify(listed), /010-0000-1234/);
});

test('modern approval assigns the stable student and creates the requested lesson', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', request, '*', own, json));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.request.studentId, 'student-1');
  assert.deepEqual(submitted.request.details.subjects, ['클리닉']);
  const approved = await body(await handleLessonAssignmentReview({ DB: db }, 'task', {
    action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1'
  }, '*', all, json));
  assert.equal(approved.ok, true);
  assert.equal(approved.task.studentId, 'student-1');
  assert.equal(approved.task.staffId, 'teacher-1');
  assert.equal(approved.task.subject, '클리닉');
  assert.deepEqual(approved.task.scheduleSlots[0].days, [1,3]);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, ['teacher-1']);
  assert.equal(db.tasks.size, 1);
});

test('a teacher cannot request an already assigned student', async () => {
  const db = new DB();
  db.roster.roster.students[0].teacherIds = ['teacher-1'];
  const response = await handleLessonAssignmentRequest({ DB: db }, 'task', request, '*', own, json);
  assert.equal(response.status, 409);
  assert.equal(db.rows.size, 0);
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
