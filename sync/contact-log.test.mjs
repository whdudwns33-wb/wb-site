import assert from 'node:assert/strict';
import test from 'node:test';

import { handleContactLog } from './contact-log.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, ' ').trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  first() { return this.db.first(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class FakeDB {
  constructor() {
    this.tasks = new Map();
    this.staff = new Map([['teacher-1', { name: '담당교사', deleted: false }]]);
    this.checks = new Map();
    this.roster = {
      roster: { students: [
        { id: 'student-a', name: '학생A', teacherIds: ['teacher-1'] },
        { id: 'student-b', name: '학생B', teacherIds: ['teacher-2'] }
      ] },
      bookStudents: []
    };
  }
  prepare(sql) { return new Statement(this, sql); }
  seedTask(data, owner = data.staffId) {
    this.tasks.set(data.id, { owner, data: JSON.stringify(data) });
  }
  async first(sql, args) {
    if (sql.startsWith('SELECT owner,data FROM tasks')) return this.tasks.get(String(args[1])) || null;
    if (sql.startsWith('SELECT data FROM private_rosters')) {
      return this.roster ? { data: JSON.stringify(this.roster) } : null;
    }
    if (sql.startsWith('SELECT data FROM staff')) {
      const staff = this.staff.get(String(args[1]));
      return staff ? { data: JSON.stringify(staff) } : null;
    }
    if (sql.startsWith('SELECT owner,data,updated_at FROM checks')) {
      const row = this.checks.get(String(args[1]));
      return row ? { owner: row.owner, data: row.data, updated_at: row.updatedAt } : null;
    }
    throw new Error('Unhandled first SQL: ' + sql);
  }
  async run(sql, args) {
    if (sql.startsWith('INSERT OR IGNORE INTO checks')) {
      const [, key, owner, data, updatedAt, srvAt] = args;
      if (this.checks.has(String(key))) return { meta: { changes: 0 } };
      this.checks.set(String(key), { owner, data, updatedAt, srvAt });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE checks SET')) {
      const [owner, data, updatedAt, srvAt, , key, expectedUpdatedAt] = args;
      const current = this.checks.get(String(key));
      if (!current || Number(current.updatedAt) !== Number(expectedUpdatedAt)) return { meta: { changes: 0 } };
      this.checks.set(String(key), { owner, data, updatedAt, srvAt });
      return { meta: { changes: 1 } };
    }
    throw new Error('Unhandled run SQL: ' + sql);
  }
}

const auth = { scope: 'own', id: 'teacher-1' };
const lesson = (id = 'lesson-1', overrides = {}) => ({
  id,
  staffId: 'teacher-1',
  origin: 'manager',
  title: '[수업] 학생A — 수학',
  taskKind: 'lesson_instruction',
  studentId: 'student-a',
  studentName: '학생A',
  deleted: false,
  ...overrides
});

async function save(db, overrides = {}, requestAuth = auth) {
  const response = await handleContactLog(db ? { DB: db } : {}, 'task', {
    action: 'save', sourceTaskId: 'lesson-1', type: 'call', note: '진도 안내', ...overrides
  }, '*', requestAuth, json);
  return { status: response.status, body: await response.json() };
}

test('assigned teacher contact is server-authored in a separate check row', async () => {
  const db = new FakeDB();
  db.seedTask(lesson());
  db.checks.set('lesson-1|2026-08-14', { owner: 'teacher-1',
    data: JSON.stringify({ taskId: 'lesson-1', done: true, steps: { explain: true } }) });

  const result = await save(db, { studentId: 'forged-student', by: 'forged-name', date: '2000-01-01' });
  assert.equal(result.status, 200);
  assert.match(result.body.key, /^__contact__[a-f0-9]{40}\|\d{4}-\d{2}-\d{2}$/);
  assert.equal(result.body.record.contact.studentId, 'student-a');
  assert.equal(result.body.record.contact.sourceTaskId, 'lesson-1');
  assert.equal(result.body.record.contact.byStaffId, 'teacher-1');
  assert.equal(result.body.record.contact.by, '담당교사');
  assert.equal(result.body.record.contact.note, '진도 안내');
  assert.equal(Object.hasOwn(result.body.record, 'done'), false);
  assert.equal(Object.hasOwn(result.body.record, 'steps'), false);
  assert.deepEqual(JSON.parse(db.checks.get('lesson-1|2026-08-14').data).steps, { explain: true });
});

test('same actor and student update one daily contact key across lesson tasks', async () => {
  const db = new FakeDB();
  db.seedTask(lesson());
  db.seedTask(lesson('lesson-2', { title: '[수업] 학생A — 영어' }));
  const first = await save(db);
  const second = await save(db, { sourceTaskId: 'lesson-2', type: 'msg', note: '숙제 안내',
    expectedUpdatedAt: first.body.record.updatedAt });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.key, second.body.key);
  assert.equal(db.checks.size, 1);
  assert.equal(JSON.parse(db.checks.get(second.body.key).data).contact.sourceTaskId, 'lesson-2');
});

test('manager may record a roster contact directly without creating a duplicate lesson path', async () => {
  const db = new FakeDB();
  db.staff.set('manager-1', { name: '관리자', deleted: false });
  const managerAuth = { scope: 'all', id: 'manager-1', role: 'manager' };
  const direct = await save(db, { sourceTaskId: '', studentId: 'student-a' }, managerAuth);
  assert.equal(direct.status, 200);
  assert.equal(direct.body.record.contact.studentId, 'student-a');
  assert.equal(direct.body.record.contact.sourceTaskId, '');
  assert.equal(direct.body.record.contact.byStaffId, 'manager-1');
  assert.equal(direct.body.record.contact.by, '관리자');

  db.seedTask(lesson());
  const fromLesson = await save(db, {
    expectedUpdatedAt: direct.body.record.updatedAt,
    type: 'msg'
  }, managerAuth);
  assert.equal(fromLesson.status, 200);
  assert.equal(fromLesson.body.key, direct.body.key);
  assert.equal(db.checks.size, 1);

  const missing = await save(db, { sourceTaskId: '', studentId: 'missing' }, managerAuth);
  assert.equal(missing.status, 422);
});

test('stale device cannot overwrite a newer daily contact', async () => {
  const db = new FakeDB();
  db.seedTask(lesson());
  const first = await save(db);
  const second = await save(db, { type: 'msg', note: '최신 메모',
    expectedUpdatedAt: first.body.record.updatedAt });
  const stale = await save(db, { type: 'meet', note: '오래 열린 기기',
    expectedUpdatedAt: first.body.record.updatedAt });
  assert.equal(second.status, 200);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONTACT_STALE');
  assert.equal(stale.body.current.record.contact.note, '최신 메모');
  assert.equal(JSON.parse(db.checks.get(second.body.key).data).contact.note, '최신 메모');
});

test('legacy lesson without studentId resolves one exact assigned roster student', async () => {
  const db = new FakeDB();
  db.seedTask(lesson('lesson-1', { taskKind: undefined, studentId: undefined,
    studentName: undefined, title: '[수업] 학생A (초4) — 수학' }));
  const result = await save(db);
  assert.equal(result.status, 200);
  assert.equal(result.body.record.contact.studentId, 'student-a');
});

test('non-lesson, other teacher, and unassigned student fail without auth-style 403', async () => {
  const cases = [
    { task: lesson('lesson-1', { title: '일반 업무', taskKind: undefined }) },
    { task: lesson(), owner: 'teacher-2' },
    { task: lesson('lesson-1', { studentId: 'student-b', studentName: '학생B' }) },
    { task: lesson('lesson-1', { studentId: 'removed-student', studentName: '학생A' }) }
  ];
  for (const item of cases) {
    const db = new FakeDB();
    db.seedTask(item.task, item.owner || 'teacher-1');
    const result = await save(db);
    assert.equal(result.status, 422);
    assert.equal(db.checks.size, 0);
  }
});

test('ambiguous legacy student and multiline or oversized notes are rejected', async () => {
  const db = new FakeDB();
  db.roster.roster.students.push({ id: 'student-c', name: '학생A', teacherIds: ['teacher-1'] });
  db.seedTask(lesson('lesson-1', { taskKind: undefined, studentId: undefined,
    studentName: undefined, title: '[수업] 학생A — 수학' }));
  assert.equal((await save(db)).status, 422);

  const clean = new FakeDB();
  clean.seedTask(lesson());
  assert.equal((await save(clean, { note: '첫 줄\n둘째 줄' })).status, 422);
  assert.equal((await save(clean, { note: '가'.repeat(201) })).status, 422);
  assert.equal(clean.checks.size, 0);
});
