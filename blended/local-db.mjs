import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { passwordHash,now,today } from './api.mjs';

export function openDatabase(filename = ':memory:') {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=3000;');
  // shortcut: 이 스키마는 격리된 로컬 DB 전용, 운영 연결 승인 때 버전별 마이그레이션으로 전환한다.
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}
export function seedDemo(db) {
  if (db.prepare('SELECT count(*) n FROM users').get().n) return;
  const users = [
    ['owner', '가상 원장', 'owner'], ['admin', '가상 관리자', 'admin'],
    ['teacher-a', '가상 강사 A', 'teacher'], ['teacher-b', '가상 강사 B', 'teacher'],
    ['student-a', '가상 학생 A', 'student'], ['student-b', '가상 학생 B', 'student'],
    ['guardian-a', '가상 보호자 A', 'guardian'], ['guardian-b', '가상 보호자 B', 'guardian']
  ];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [id, name, role] of users) db.prepare('INSERT INTO users(id,login,name,role,password,created_at) VALUES(?,?,?,?,?,?)').run(id,id,name,role,passwordHash(`Demo-${id}-2026!`),now());
    for (const suffix of ['a','b']) {
      db.prepare('INSERT INTO students(id,name) VALUES(?,?)').run(`student-${suffix}`,`가상 학생 ${suffix.toUpperCase()}`);
      db.prepare('INSERT INTO guardians(user_id,student_id) VALUES(?,?)').run(`guardian-${suffix}`,`student-${suffix}`);
      db.prepare('INSERT INTO assignments(id,teacher_id,student_id,subject,starts,ends,actor) VALUES(?,?,?,?,?,?,?)').run(`assignment-${suffix}`,`teacher-${suffix}`,`student-${suffix}`,suffix === 'a' ? '수학' : '영어','2026-01-01','2099-12-31','owner');
      db.prepare('INSERT INTO learning(id,student_id,subject,title,due,link_key,actor,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(`learning-${suffix}`,`student-${suffix}`,suffix === 'a' ? '수학' : '영어',suffix === 'a' ? '분수의 나눗셈 · 개념 3쪽 정리' : '예문 5개 읽고 표현 정리',today(),suffix === 'a' ? 'metamath_student' : '',`teacher-${suffix}`,now());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

