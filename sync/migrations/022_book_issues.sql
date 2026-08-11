-- 학생별 교재 출고·인계 이력. 원생 이름·연락처는 저장하지 않는다.
-- private_rosters.bookStudents의 stable assignment/student/book ID가 정본이며,
-- student_identity_hash는 같은 studentId가 다른 이름으로 재사용되는 것을 차단한다.
CREATE TABLE IF NOT EXISTS book_issues (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  assignment_id         TEXT    NOT NULL,
  student_id            TEXT    NOT NULL,
  book_id               TEXT    NOT NULL,
  student_identity_hash TEXT    NOT NULL CHECK (length(student_identity_hash) = 64),
  status                TEXT    NOT NULL CHECK (status IN ('prepared','issued','handed','cancelled')),
  cycle                 INTEGER NOT NULL CHECK (cycle >= 1),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  prepared_at           INTEGER,
  prepared_by           TEXT,
  issued_at             INTEGER,
  issued_by             TEXT,
  handed_at             INTEGER,
  handed_by             TEXT,
  cancelled_at          INTEGER,
  cancelled_by          TEXT,
  cancel_reason         TEXT,
  reissue_reason        TEXT,
  history               TEXT    NOT NULL CHECK (json_valid(history)),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (app, assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_book_issues_status
  ON book_issues(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_issues_student
  ON book_issues(app, student_id, updated_at);
