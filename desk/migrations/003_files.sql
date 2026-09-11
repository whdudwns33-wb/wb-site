-- 003 — 작은 파일 저장소(매뉴얼 사진). 저장소·정적 자산에 두지 않는 그림은 여기(D1 BLOB)에만 산다.
-- 크기 상한(400KB)·mime 허용 목록·권한(올리기·지우기는 원장, 보기는 인증)은 desk-api.mjs 가 본다.
-- 클라이언트가 올리기 전에 긴 변 1000px·JPEG 로 줄이므로 보통 한 장 60~150KB 다.
CREATE TABLE IF NOT EXISTS desk_files (
  id         TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  kind       TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 20),
  mime       TEXT    NOT NULL CHECK (length(mime) BETWEEN 1 AND 40),
  size       INTEGER NOT NULL CHECK (size > 0),
  data       BLOB    NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128)
);
CREATE INDEX IF NOT EXISTS idx_desk_files_kind ON desk_files(kind, created_at);
