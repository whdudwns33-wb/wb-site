-- 아카플로우 학생번호와 WB stable studentId의 비공개 불변 연결.
-- 담당 강사명은 5계정 운영 때문에 식별값으로 저장하지 않는다.
CREATE TABLE IF NOT EXISTS acaflow_student_links (
  app                 TEXT    NOT NULL CHECK (app = 'task'),
  external_student_no TEXT    NOT NULL CHECK (
    length(external_student_no) BETWEEN 1 AND 128
    AND external_student_no NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  student_id          TEXT    NOT NULL,
  linked_at           INTEGER NOT NULL,
  linked_by           TEXT    NOT NULL,
  PRIMARY KEY (app, external_student_no),
  UNIQUE (app, student_id)
);
CREATE INDEX IF NOT EXISTS idx_acaflow_student_links_student
  ON acaflow_student_links(app, student_id);
