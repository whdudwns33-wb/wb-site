import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from './worker-core.js';
import {
  handleGuardianAnnouncements,
  listActiveGuardianAnnouncements
} from './guardian-announcements.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/036_guardian_announcements.sql', import.meta.url), 'utf8');

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
  constructor(withMigration = true) {
    this.database = new DatabaseSync(':memory:');
    if (withMigration) this.database.exec(schema);
    else {
      const marker = schema.indexOf('-- 보호자 공지는 관리자만 작성·게시·종료');
      this.database.exec(schema.slice(0, marker));
    }
  }
  prepare(sql) { return new Statement(this.database, sql); }
  batch(statements) { return Promise.resolve(statements.map(statement => statement.run())); }
}

const manager = { scope: 'all', id: 'manager-a', role: 'manager' };
const own = { scope: 'own', id: 'teacher-a' };
const json = (body, status) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' }
});

async function call(db, payload, auth = manager) {
  const response = await handleGuardianAnnouncements({ DB: db }, 'task',
    { app: 'task', ...payload }, 'https://worker.example', auth, json);
  return { status: response.status, body: await response.json() };
}

async function workerCall(db, payload) {
  const response = await worker.fetch(new Request('https://worker.example/parent-portal', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://whdudwns33-wb.github.io' },
    body: JSON.stringify({ app: 'task', ...payload })
  }), { DB: db, TASK_ADMIN_SECRET: 'director-secret' });
  return { status: response.status, body: await response.json() };
}

function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 60 * 60 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function seedRoster(db) {
  const month = kstDate().slice(0, 7);
  const student = (id, name, start = month, end = '') => ({ id, name, grade: '초2', teacher: '담당',
    subject: '독해', start, end, reason: '', teacherIds: ['teacher-a'] });
  const roster = { roster: { updated: kstDate(), baseline: month, students: [
    student('student-a', '학생A'), student('student-b', '학생B'), student('student-c', '학생C'),
    student('student-ended', '종료학생', '2020-01', month)
  ] }, bookStudents: [] };
  db.prepare('INSERT INTO private_rosters(app,data,updated_at) VALUES(?,?,?)')
    .bind('task', JSON.stringify(roster), Date.now()).run();
}

function draft(id, overrides = {}) {
  return {
    action: 'announcement_save', announcementId: id, expectedRevision: 0,
    title: '학원 공지', body: '공개 안내 내용입니다.',
    publishDate: kstDate(), expiresDate: kstDate(7),
    targetType: 'all', studentIds: [], ...overrides
  };
}

async function saveAndPublish(db, id, overrides = {}) {
  const saved = await call(db, draft(id, overrides));
  assert.equal(saved.status, 200);
  const published = await call(db, {
    action: 'announcement_publish', announcementId: id,
    expectedRevision: saved.body.announcement.revision
  });
  assert.equal(published.status, 200);
  return published.body.announcement;
}

test('036 migration과 신규 schema의 공지 객체가 같고 additive다', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM/i);
  const fresh = new DatabaseSync(':memory:');
  const upgraded = new DatabaseSync(':memory:');
  fresh.exec(schema);
  const marker = schema.indexOf('-- 보호자 공지는 관리자만 작성·게시·종료');
  assert.ok(marker > 0);
  upgraded.exec(schema.slice(0, marker));
  upgraded.exec(migration);
  const objects = database => database.prepare(
    "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
  ).all().filter(row => /guardian_announcement/.test(row.name)).map(row => ({ ...row,
    sql: row.sql.replace(/IF NOT EXISTS\s*/gi, '').replace(/\s+/g, ' ').trim()
  }));
  assert.deepEqual(objects(upgraded), objects(fresh));
});

test('관리자 scope all만 목록·작성·게시·종료할 수 있고 migration 누락은 503이다', async () => {
  const db = new TestD1(); seedRoster(db);
  assert.equal((await call(db, { action: 'announcement_list' }, null)).status, 403);
  assert.equal((await call(db, draft('notice-auth'), own)).status, 403);
  assert.equal((await call(db, { action: 'announcement_list' })).status, 200);

  const missing = new TestD1(false); seedRoster(missing);
  const result = await call(missing, { action: 'announcement_list' });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'ANNOUNCEMENTS_NOT_READY');
});

test('Worker authenticated action 경유에서도 원장 인증 공지만 허용한다', async () => {
  const db = new TestD1(); seedRoster(db);
  assert.equal((await workerCall(db, { action: 'announcement_list' })).status, 403);
  assert.equal((await workerCall(db, {
    auth: { mode: 'admin', secret: 'wrong' }, action: 'announcement_list'
  })).status, 403);
  assert.equal((await workerCall(db, {
    auth: { mode: 'admin', secret: 'director-secret' }, action: 'announcement_list'
  })).status, 200);
  const saved = await workerCall(db, {
    auth: { mode: 'admin', secret: 'director-secret' }, ...draft('notice-worker')
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.announcement.status, 'draft');
});

test('작성→수정→게시→종료는 CAS이며 모든 revision event가 append-only로 남는다', async () => {
  const db = new TestD1(); seedRoster(db);
  const created = await call(db, draft('notice-life'));
  assert.equal(created.status, 200);
  assert.equal(created.body.announcement.revision, 1);
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, 'student-a')).announcements.length, 0);

  const updated = await call(db, draft('notice-life', {
    expectedRevision: 1, title: '수정 공지'
  }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.announcement.revision, 2);
  const stale = await call(db, draft('notice-life', {
    expectedRevision: 1, title: '오래된 화면의 수정'
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'STALE_REVISION');

  const published = await call(db, {
    action: 'announcement_publish', announcementId: 'notice-life', expectedRevision: 2
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.announcement.status, 'published');
  const retry = await call(db, {
    action: 'announcement_publish', announcementId: 'notice-life', expectedRevision: 2
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal((await call(db, draft('notice-life', {
    expectedRevision: 3, title: '게시 후 변조'
  }))).status, 409);

  const ended = await call(db, {
    action: 'announcement_end', announcementId: 'notice-life', expectedRevision: 3
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.announcement.status, 'ended');
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, 'student-a')).announcements.length, 0);
  assert.deepEqual(db.database.prepare(
    "SELECT revision,event_type FROM guardian_announcement_events WHERE announcement_id='notice-life' ORDER BY revision"
  ).all().map(row => ({ ...row })), [
    { revision: 1, event_type: 'created' },
    { revision: 2, event_type: 'updated' },
    { revision: 3, event_type: 'published' },
    { revision: 4, event_type: 'ended' }
  ]);
  assert.throws(() => db.database.exec(
    "UPDATE guardian_announcement_events SET created_by='other' WHERE announcement_id='notice-life'"
  ), /GUARDIAN_ANNOUNCEMENT_EVENT_APPEND_ONLY/);
  assert.throws(() => db.database.exec(
    "DELETE FROM guardian_announcements WHERE announcement_id='notice-life'"
  ), /GUARDIAN_ANNOUNCEMENT_APPEND_ONLY/);
});

test('활성 공지는 공개 날짜와 verified studentId로만 필터링하며 타학생 대상·관리 필드는 노출하지 않는다', async () => {
  const db = new TestD1(); seedRoster(db);
  await saveAndPublish(db, 'notice-all');
  await saveAndPublish(db, 'notice-a', {
    targetType: 'students', studentIds: ['student-a'], title: 'A 전용'
  });
  await saveAndPublish(db, 'notice-b', {
    targetType: 'students', studentIds: ['student-b'], title: 'B 전용'
  });
  await saveAndPublish(db, 'notice-future', {
    publishDate: kstDate(1), expiresDate: kstDate(2), title: '미래 공지'
  });

  const a = await listActiveGuardianAnnouncements({ DB: db }, 'student-a');
  const b = await listActiveGuardianAnnouncements({ DB: db }, 'student-b');
  assert.deepEqual(a.announcements.map(row => row.title).sort(), ['A 전용', '학원 공지']);
  assert.deepEqual(b.announcements.map(row => row.title).sort(), ['B 전용', '학원 공지']);
  for (const row of [...a.announcements, ...b.announcements]) {
    assert.deepEqual(Object.keys(row).sort(),
      ['body', 'expiresDate', 'publishDate', 'title'].sort());
    assert.equal('announcementId' in row, false);
    assert.equal('studentIds' in row, false);
    assert.equal('targetType' in row, false);
    assert.equal('revision' in row, false);
    assert.equal('updatedBy' in row, false);
  }
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, 'student-c')).announcements.length, 1,
    'all 공지만 보이고 다른 학생 전용 공지는 보이지 않아야 한다');
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, '../student-a')).code,
    'ANNOUNCEMENT_STUDENT_INVALID');
});

test('특정 대상은 현재 active roster stable ID만 받고 빈값·중복·첨부 등 확장 입력을 fail-closed 한다', async () => {
  const db = new TestD1(); seedRoster(db);
  assert.equal((await call(db, draft('notice-empty', {
    targetType: 'students', studentIds: []
  }))).status, 400);
  assert.equal((await call(db, draft('notice-duplicate', {
    targetType: 'students', studentIds: ['student-a', 'student-a']
  }))).status, 400);
  const ended = await call(db, draft('notice-ended', {
    targetType: 'students', studentIds: ['student-ended']
  }));
  assert.equal(ended.status, 409);
  assert.equal(ended.body.code, 'STUDENT_NOT_FOUND');
  const missing = await call(db, draft('notice-missing', {
    targetType: 'students', studentIds: ['student-missing']
  }));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'STUDENT_NOT_FOUND');
  assert.equal((await call(db, { ...draft('notice-attachment'), attachment: 'secret.pdf' })).status, 400);
  assert.equal((await call(db, draft('notice-dates', {
    publishDate: kstDate(2), expiresDate: kstDate(1)
  }))).status, 400);
  assert.equal((await call(db, draft('notice-body', { body: 'x'.repeat(2001) }))).status, 400);
});

test('특정 대상은 지정 당시 id+이름 identity snapshot과 현재 명단이 같을 때만 보인다', async () => {
  const db = new TestD1(); seedRoster(db);
  await saveAndPublish(db, 'notice-identity', {
    targetType: 'students', studentIds: ['student-a'], title: 'A 본인 공지'
  });
  const stored = db.database.prepare(
    "SELECT target_students FROM guardian_announcements WHERE announcement_id='notice-identity'"
  ).get();
  const targets = JSON.parse(stored.target_students);
  assert.equal(targets[0].id, 'student-a');
  assert.match(targets[0].identityHash, /^[a-f0-9]{64}$/);
  const eventTargets = db.database.prepare(
    "SELECT target_students FROM guardian_announcement_events WHERE announcement_id='notice-identity' AND event_type='published'"
  ).get();
  assert.equal(eventTargets.target_students, stored.target_students);
  const listed = await call(db, { action: 'announcement_list' });
  assert.deepEqual(listed.body.announcements[0].studentIds, ['student-a']);
  assert.doesNotMatch(JSON.stringify(listed.body), /identityHash/);
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, 'student-a')).announcements.length, 1);

  const row = db.database.prepare("SELECT data FROM private_rosters WHERE app='task'").get();
  const document = JSON.parse(row.data);
  document.roster.students.find(student => student.id === 'student-a').name = '동일 ID 새 학생';
  db.database.prepare("UPDATE private_rosters SET data=?,updated_at=updated_at+1 WHERE app='task'")
    .run(JSON.stringify(document));
  assert.equal((await listActiveGuardianAnnouncements({ DB: db }, 'student-a')).announcements.length, 0,
    '같은 ID라도 현재 학생 identity가 달라지면 오래된 지정 공지를 숨겨야 한다');
});

test('학생 identity가 바뀐 지정 공지는 게시 직전 차단하고 다시 저장해야 한다', async () => {
  const db = new TestD1(); seedRoster(db);
  const saved = await call(db, draft('notice-reconfirm', {
    targetType: 'students', studentIds: ['student-a']
  }));
  assert.equal(saved.status, 200);
  const row = db.database.prepare("SELECT data FROM private_rosters WHERE app='task'").get();
  const document = JSON.parse(row.data);
  document.roster.students.find(student => student.id === 'student-a').name = '학생A 수정';
  db.database.prepare("UPDATE private_rosters SET data=?,updated_at=updated_at+1 WHERE app='task'")
    .run(JSON.stringify(document));

  const blocked = await call(db, {
    action: 'announcement_publish', announcementId: 'notice-reconfirm', expectedRevision: 1
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'TARGET_RECONFIRM_REQUIRED');
  assert.equal(db.database.prepare(
    "SELECT status FROM guardian_announcements WHERE announcement_id='notice-reconfirm'"
  ).get().status, 'draft');
  assert.equal(db.database.prepare(
    "SELECT COUNT(*) count FROM guardian_announcement_events WHERE announcement_id='notice-reconfirm'"
  ).get().count, 1);

  const refreshed = await call(db, draft('notice-reconfirm', {
    expectedRevision: 1, targetType: 'students', studentIds: ['student-a']
  }));
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.announcement.revision, 2);
  const published = await call(db, {
    action: 'announcement_publish', announcementId: 'notice-reconfirm', expectedRevision: 2
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.announcement.status, 'published');
});

test('DB 제약도 잘못된 대상 ID와 게시 후 내용 변경을 거부한다', () => {
  const db = new TestD1();
  const base = ['task', 'notice-db', '제목', '본문', kstDate(), kstDate(1)];
  assert.throws(() => db.database.prepare(
    "INSERT INTO guardian_announcements(app,announcement_id,title,body,publish_date,expires_date,target_type," +
    "target_students,status,revision,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,'students',?,'draft',1,1,1,'director')"
  ).run(...base, JSON.stringify([{ id: '../student', identityHash: 'a'.repeat(64) }])),
  /GUARDIAN_ANNOUNCEMENT_TARGET_INVALID/);
  db.database.prepare(
    "INSERT INTO guardian_announcements(app,announcement_id,title,body,publish_date,expires_date,target_type," +
    "target_students,status,revision,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,'all','[]','draft',1,1,1,'director')"
  ).run(...base);
  db.database.exec(
    "UPDATE guardian_announcements SET status='published',revision=2,updated_at=2 WHERE announcement_id='notice-db'"
  );
  assert.throws(() => db.database.exec(
    "UPDATE guardian_announcements SET title='변조',status='ended',revision=3,updated_at=3 WHERE announcement_id='notice-db'"
  ), /GUARDIAN_ANNOUNCEMENT_INVALID_TRANSITION/);
});
