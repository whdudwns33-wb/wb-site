CREATE TABLE IF NOT EXISTS makeup_completion_links (
  app TEXT NOT NULL CHECK (app='task'),
  pending_case_id TEXT NOT NULL,
  completed_case_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (app,pending_case_id),
  UNIQUE (app,completed_case_id)
);
CREATE INDEX IF NOT EXISTS idx_makeup_completion_links_student
  ON makeup_completion_links(app,student_id,created_at);

