-- 보강 전달사항은 일정 revision과 분리해 확인만으로 일정/보호자 응답이 무효화되지 않는다.
CREATE TABLE IF NOT EXISTS makeup_instructions (
  app TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  instruction_text TEXT NOT NULL,
  author_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  history TEXT NOT NULL DEFAULT '[]',
  ack_version INTEGER NOT NULL DEFAULT 0,
  ack_staff_id TEXT NOT NULL DEFAULT '',
  ack_assignment TEXT NOT NULL DEFAULT '',
  ack_at INTEGER,
  PRIMARY KEY(app, case_id)
);
