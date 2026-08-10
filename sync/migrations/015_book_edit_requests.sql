-- 기존 교재(textbooks.json 정적 항목이든, book_add_requests로 승인 등록된 항목이든) 수정 신청.
-- 정적 파일은 앱에서 직접 못 고치므로, 여기서도 book_add_requests와 같은 방식을 쓴다:
-- 선생님이 "이렇게 고쳐 주세요"를 신청하면(request), 원장이 검토(review)해 승인해야
-- 실제 목록에 반영된다(클라이언트가 승인된 수정을 읽어와 해당 책 위에 덮어씌운다).
-- 원장이 직접 신청하면 검토 없이 바로 승인 상태로 등록된다.
-- 한 책(book_id)당 열려 있는 신청은 하나뿐 — 다시 제출하면 같은 행을 revision만 올려서 갱신한다.
CREATE TABLE IF NOT EXISTS book_edit_requests (
  app          TEXT    NOT NULL,
  request_key  TEXT    NOT NULL,
  book_id      TEXT    NOT NULL,          -- 수정 대상 교재 id (기존 BK.. 또는 승인된 ADD.. id)
  owner        TEXT    NOT NULL,          -- 신청한 직원(staffId) 또는 'director'
  title        TEXT    NOT NULL,          -- 최종 상태 스냅샷 — 항상 값이 있어야 함(교재명은 비울 수 없음)
  subject      TEXT,
  level        TEXT,
  vendor_name  TEXT,
  units        TEXT    NOT NULL DEFAULT '[]',  -- JSON. [{name, sections:[...]}]
  note         TEXT,
  content_hash TEXT    NOT NULL,
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
  PRIMARY KEY (app, request_key),
  UNIQUE (app, book_id)
);
CREATE INDEX IF NOT EXISTS idx_book_edit_requests_owner
  ON book_edit_requests(app, owner, updated_at);
CREATE INDEX IF NOT EXISTS idx_book_edit_requests_status
  ON book_edit_requests(app, status, updated_at);
