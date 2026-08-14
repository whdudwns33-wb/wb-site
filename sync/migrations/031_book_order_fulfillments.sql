-- 주문 교재의 선생님 수령 → 학생 배부 → 아카등록 진행 원장.
-- 학생 이름이나 연락처는 저장하지 않고, 주문 task 안의 stable studentId만 대조한다.
CREATE TABLE IF NOT EXISTS book_order_fulfillments (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  task_id               TEXT    NOT NULL,
  item_index            INTEGER NOT NULL CHECK (item_index >= 0),
  book_id               TEXT    NOT NULL,
  student_ids           TEXT    NOT NULL CHECK (json_valid(student_ids)),
  status                TEXT    NOT NULL CHECK (status IN ('teacher_received','student_handed','academy_registered')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  teacher_received_at   INTEGER,
  teacher_received_by   TEXT,
  student_handed_at     INTEGER,
  student_handed_by     TEXT,
  academy_registered_at INTEGER,
  academy_registered_by TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (app, task_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_book_order_fulfillments_status
  ON book_order_fulfillments(app, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_order_fulfillments_task
  ON book_order_fulfillments(app, task_id, updated_at);
