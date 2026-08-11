-- 학부모 알림톡 수신자를 이름이 아닌 private_rosters의 stable studentId로 결합한다.
-- 기존 guardian_contacts는 자동 이관하지 않는다. 동명이인·개명 가능성이 있어 이름만으로
-- studentId를 추정하면 오발송 위험이 있으므로, 원장이 원생 ID를 선택해 다시 등록해야 한다.
CREATE TABLE IF NOT EXISTS guardian_contacts_by_student (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  student_id   TEXT    NOT NULL,
  student_name TEXT    NOT NULL,
  phone        TEXT,
  consent      INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT,
  PRIMARY KEY (app, student_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_contacts_by_student_name
  ON guardian_contacts_by_student(app, student_name);

-- 기존 피드백/발송 행은 NULL로 남겨 fail-closed 한다. 새 제출만 task.studentId를 저장하며,
-- 운영자가 이름으로 과거 행을 임의 보정하지 않는다.
ALTER TABLE feedback_requests ADD COLUMN student_id TEXT;
ALTER TABLE parent_feedback_sends ADD COLUMN student_id TEXT;
