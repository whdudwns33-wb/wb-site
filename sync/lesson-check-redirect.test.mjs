import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';


const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('./migrations/068_lesson_check_key_redirects.sql', import.meta.url), 'utf8');

test('068 migration is additive, contains no private lesson content, and is mirrored in schema', () => {
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|student_name|phone|note|memo/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS lesson_check_key_redirects/);
  assert.match(migration, /RAISE\(IGNORE\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS lesson_check_key_redirects/);
  assert.match(schema, /trg_checks_ignore_moved_lesson_key_insert/);
});

test('moved old keys cannot be recreated while the new and unrelated checks remain writable', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const oldKey = 'lesson-old|2026-09-05';
  const newKey = 'lesson-new|2026-09-05';
  db.prepare(
    "INSERT INTO lesson_check_key_redirects(app,old_key,new_key,old_updated_at,created_at,created_by) VALUES('task',?,?,?,?,?)"
  ).run(oldKey, newKey, 100, 200, 'director');

  const moved = db.prepare(
    "INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,?)"
  ).run(oldKey, 'teacher-a', JSON.stringify({ taskId: 'lesson-old', date: '2026-09-05', updatedAt: 300 }), 300, 300);
  assert.equal(Number(moved.changes), 0);

  const insert = db.prepare(
    "INSERT INTO checks(app,k,owner,data,updated_at,srv_at) VALUES('task',?,?,?,?,?)"
  );
  assert.equal(Number(insert.run(newKey, 'teacher-a', JSON.stringify({ taskId: 'lesson-new', date: '2026-09-05', updatedAt: 300 }), 300, 300).changes), 1);
  assert.equal(Number(insert.run('lesson-other|2026-09-05', 'teacher-a', JSON.stringify({ taskId: 'lesson-other', date: '2026-09-05', updatedAt: 300 }), 300, 300).changes), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM checks WHERE app='task'").get().count, 2);
  assert.throws(() => db.prepare(
    "UPDATE lesson_check_key_redirects SET created_by='other' WHERE app='task' AND old_key=?"
  ).run(oldKey), /APPEND_ONLY/);
  assert.throws(() => db.prepare(
    "DELETE FROM lesson_check_key_redirects WHERE app='task' AND old_key=?"
  ).run(oldKey), /APPEND_ONLY/);
});
