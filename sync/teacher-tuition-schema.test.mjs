import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = fs.readFileSync(new URL('./migrations/057_teacher_requests_tuition_alerts.sql', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const tables = [
  'teacher_live_requests', 'teacher_live_request_receipt_events',
  'tuition_generation_alerts', 'tuition_generation_alert_confirmations'
];

test('057 migration is additive and schema.sql contains the same append-only ledgers', () => {
  assert.doesNotMatch(migration, /(?:^|\n)\s*(?:DROP\b|DELETE\s+FROM\b|ALTER\s+TABLE\b)/i);
  for (const table of tables) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const source of [migration, schema]) {
    assert.match(source, /TEACHER_LIVE_REQUEST_APPEND_ONLY/);
    assert.match(source, /TEACHER_LIVE_REQUEST_RECEIPT_APPEND_ONLY/);
    assert.match(source, /TUITION_ALERT_APPEND_ONLY/);
    assert.match(source, /TUITION_CONFIRMATION_APPEND_ONLY/);
    assert.doesNotMatch(source.slice(source.indexOf('CREATE TABLE IF NOT EXISTS teacher_live_requests')),
      /student_name|teacher_name|recipient_name|phone|contact/i);
  }
});

test('057 migration executes from an empty database and enforces immutable rows', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON;\n' + migration);
  assert.deepEqual(database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?,?,?) ORDER BY name"
  ).all(...tables).map(row => row.name), tables.slice().sort());

  database.prepare(
    'INSERT INTO teacher_live_requests(app,request_id,lesson_task_id,lesson_date,student_id,sender_staff_id,recipient_admin_id,body,created_at) ' +
    "VALUES('task','tlr_test_001','lesson-a','2026-08-28','student-a','teacher-a','director','확인 요청',1)"
  ).run();
  assert.throws(() => database.prepare("UPDATE teacher_live_requests SET body='변경'").run(), /APPEND_ONLY/);

  const alertId = 'tga_' + 'a'.repeat(52);
  database.prepare(
    'INSERT INTO tuition_generation_alerts(app,alert_id,student_id,cycle_start_date,threshold_count,trigger_task_id,trigger_date,created_at) ' +
    "VALUES('task',?,'student-a','2026-08-01',3,'lesson-a','2026-08-28',1)"
  ).run(alertId);
  assert.throws(() => database.prepare('DELETE FROM tuition_generation_alerts').run(), /APPEND_ONLY/);
});
