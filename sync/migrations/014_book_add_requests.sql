-- 교재 DB(textbooks.json)는 저장소의 정적 파일이라 앱에서 직접 고칠 수 없다.
-- 여기서는 그 자리를 메운다: 선생님이 "이 교재를 새로 추가해 주세요"를 신청하면(request),
-- 원장이 검토(review)해 승인해야 교재 목록에 실제로 나타난다. 원장이 직접 신청하면
-- 검토 없이 바로 승인 상태로 등록된다(book-add-request.js에서 처리).
-- 같은 사람이 같은 이름을 다시 신청하면 새 행이 아니라 같은 행을 revision만 올려서 갱신한다.
CREATE TABLE IF NOT EXISTS book_add_requests (
  app          TEXT    NOT NULL,
  request_key  TEXT    NOT NULL,
  book_id      TEXT    NOT NULL,          -- 승인되면 클라이언트가 교재 목록에 병합할 때 쓰는 id (ADD 접두)
  owner        TEXT    NOT NULL,          -- 신청한 직원(staffId) 또는 'director'
  title        TEXT    NOT NULL,
  subject      TEXT,
  level        TEXT,
  vendor_name  TEXT,
  units        TEXT    NOT NULL DEFAULT '[]',  -- JSON. [{name, sections:[...]}]
  note         TEXT,
  content_hash TEXT    NOT NULL,          -- subject·level·vendor·units·note 해시 — 같은 내용 재신청 감지용
  revision     INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL CHECK (status IN (
    'approval_waiting',
    'approved',
    'rejected',
    'cancelled'
  )),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  reviewed_at  INTEGER,
  reviewed_by  TEXT,
  review_note  TEXT,
  PRIMARY KEY (app, request_key)
);
CREATE INDEX IF NOT EXISTS idx_book_add_requests_owner
  ON book_add_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_add_requests_status
  ON book_add_requests(app, status, updated_at);
