-- 002 — 문서 저장소를 desk_documents 로 옮긴다 (기획서 v1.1: cards·plans·apps·manuals 컬렉션 추가).
-- 왜 새 표인가: 001 의 desk_docs 는 collection 에 CHECK(5개 고정)가 있고 SQLite 는 CHECK 를 바꿀 수 없다.
-- 컬렉션 허용 목록은 desk-api.mjs(COLLECTIONS)가 유일한 쓰기 주체로서 검사하므로 표에는 두지 않는다 —
-- 다음 컬렉션이 생겨도 마이그레이션 없이 코드만 바꾸면 된다.
-- 멱등: CREATE IF NOT EXISTS + INSERT OR IGNORE(이미 옮긴 행은 건드리지 않음). 옛 desk_docs 는 지우지 않고 남긴다 —
-- 매 배포마다 전체 마이그레이션을 다시 적용하는 규칙(desk/README.md)에서 DROP 은 안전하지 않기 때문.
CREATE TABLE IF NOT EXISTS desk_documents (
  collection TEXT    NOT NULL CHECK (length(collection) BETWEEN 1 AND 40),
  id         TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 160),
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by TEXT    NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_desk_documents_updated ON desk_documents(collection, updated_at);
INSERT OR IGNORE INTO desk_documents (collection, id, data, updated_at, updated_by, deleted)
  SELECT collection, id, data, updated_at, updated_by, deleted FROM desk_docs;
