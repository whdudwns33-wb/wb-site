PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS environment (app TEXT PRIMARY KEY CHECK(app='blended'));
INSERT OR IGNORE INTO environment(app) VALUES ('blended');
CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, login TEXT UNIQUE COLLATE NOCASE NOT NULL, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','teacher','student','guardian')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), password TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, external_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
 id TEXT PRIMARY KEY REFERENCES users(id), name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 external_id TEXT UNIQUE, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS assignments (
 id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES users(id), student_id TEXT NOT NULL REFERENCES students(id),
 subject TEXT NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, actor TEXT NOT NULL REFERENCES users(id),
 UNIQUE(teacher_id,student_id,subject,starts,ends), CHECK(starts<=ends)
);
CREATE TABLE IF NOT EXISTS guardians (
 user_id TEXT NOT NULL REFERENCES users(id), student_id TEXT NOT NULL REFERENCES students(id),
 consent INTEGER NOT NULL DEFAULT 1, contact_revision INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(user_id,student_id)
);
CREATE TABLE IF NOT EXISTS learning (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), subject TEXT NOT NULL,
 title TEXT NOT NULL, due TEXT NOT NULL, link_key TEXT NOT NULL DEFAULT '',
 self_done INTEGER NOT NULL DEFAULT 0, question TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '',
 checked INTEGER NOT NULL DEFAULT 0, checked_by TEXT REFERENCES users(id),
 source_consultation TEXT UNIQUE, actor TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consultations (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), subject TEXT NOT NULL,
 held_at TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
 author TEXT NOT NULL REFERENCES users(id), public_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','complete')),
 report_status TEXT NOT NULL DEFAULT 'draft' CHECK(report_status IN ('draft','review','published','withdrawn')),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, CHECK(period_start<=period_end)
);
CREATE TABLE IF NOT EXISTS internal_notes (
 consultation_id TEXT PRIMARY KEY REFERENCES consultations(id), note TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_versions (
 id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL REFERENCES consultations(id), version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('published','withdrawn')), snapshot TEXT,
 reason TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(consultation_id,version)
);
CREATE TRIGGER IF NOT EXISTS immutable_report_update BEFORE UPDATE ON report_versions BEGIN SELECT RAISE(ABORT,'immutable report'); END;
CREATE TRIGGER IF NOT EXISTS immutable_report_delete BEFORE DELETE ON report_versions BEGIN SELECT RAISE(ABORT,'immutable report'); END;
CREATE TABLE IF NOT EXISTS receipts (
 user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, object_id TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS planner_records (
 kind TEXT NOT NULL CHECK(kind IN ('staff','tasks','checks')), key TEXT NOT NULL,
 student_id TEXT NOT NULL REFERENCES students(id), data TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, actor TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(kind,key)
);
CREATE INDEX IF NOT EXISTS planner_student ON planner_records(student_id);
CREATE TABLE IF NOT EXISTS academy_tickets (
 hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
 student_id TEXT NOT NULL REFERENCES students(id), role TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS planner_questions (
 id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), subject TEXT NOT NULL,
 data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
