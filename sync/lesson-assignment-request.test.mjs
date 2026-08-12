import assert from 'node:assert/strict';
import test from 'node:test';
import { handleLessonAssignmentRequest, handleLessonAssignmentReview } from './lesson-assignment-request.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class DB {
  constructor() {
    this.rows = new Map();
    this.staff = new Map([['teacher-1', { deleted: false }]]);
    this.rosterAt = 10;
    this.roster = { roster: { students: [{ id: 'student-1', name: '학생', grade: '초4', teacherIds: [] }] }, bookStudents: [] };
  }
  prepare(sql) {
    const db = this;
    return { args: [], bind(...args) { this.args = args; return this; },
      async first() {
        if (sql.startsWith('SELECT * FROM lesson_assignment_requests')) return db.rows.get(this.args[1]) || null;
        if (sql.startsWith('SELECT data FROM staff')) { const value = db.staff.get(this.args[1]); return value ? { data: JSON.stringify(value) } : null; }
        if (sql.startsWith('SELECT data,updated_at FROM private_rosters')) return { data: JSON.stringify(db.roster), updated_at: db.rosterAt };
        throw new Error('first ' + sql);
      },
      async all() {
        if (!sql.startsWith('SELECT * FROM lesson_assignment_requests')) throw new Error('all ' + sql);
        const values = [...db.rows.values()].filter(row => sql.includes('staff_id=?') ? row.staff_id === this.args[1] : true);
        return { results: values };
      },
      async run() {
        if (sql.startsWith('INSERT INTO lesson_assignment_requests')) {
          const [app,key,staffId,name,grade,studentId,createdAt,updatedAt] = this.args;
          db.rows.set(key, { app, request_key:key, staff_id:staffId, student_name:name, grade, student_id:studentId, revision:1, status:'approval_waiting', created_at:createdAt, updated_at:updatedAt, reviewed_at:null, reviewed_by:null, review_note:null });
          return { meta:{changes:1} };
        }
        if (sql.startsWith("UPDATE lesson_assignment_requests SET status='rejected'")) {
          const [updatedAt,reviewedAt,by,note,app,key,rev] = this.args, row=db.rows.get(key);
          if (!row || row.revision!==rev || row.status!=='approval_waiting') return {meta:{changes:0}};
          Object.assign(row,{status:'rejected',updated_at:updatedAt,reviewed_at:reviewedAt,reviewed_by:by,review_note:note}); return {meta:{changes:1}};
        }
        if (sql.startsWith('UPDATE private_rosters')) {
          const [data,updatedAt,app,expected] = this.args;
          if (expected!==db.rosterAt) return {meta:{changes:0}};
          db.roster=JSON.parse(data); db.rosterAt=updatedAt; return {meta:{changes:1}};
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

test('teacher request is private and director approval assigns stable student id', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', { action:'submit', studentName:'학생', grade:'초4' }, '*', own, json));
  assert.equal(submitted.ok, true);
  const repeated = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', { action:'submit', studentName:'학생', grade:'초4' }, '*', own, json));
  assert.equal(repeated.idempotent, true);
  const approved = await body(await handleLessonAssignmentReview({ DB: db }, 'task', { action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1' }, '*', all, json));
  assert.equal(approved.ok, true);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, ['teacher-1']);
});

test('approval refuses a student identity different from the request', async () => {
  const db = new DB();
  const submitted = await body(await handleLessonAssignmentRequest({ DB: db }, 'task', { action:'submit', studentName:'다른 학생', grade:'초4' }, '*', own, json));
  const response = await handleLessonAssignmentReview({ DB: db }, 'task', { action:'approve', requestKey:submitted.request.requestKey, revision:1, studentId:'student-1' }, '*', all, json);
  assert.equal(response.status, 409);
  assert.deepEqual(db.roster.roster.students[0].teacherIds, []);
});
