-- 004 — 크롬 확장이 보낸 표 캡처(기획서 v1.1 §5 "크롬 확장 프로그램"). 직원이 로그인한 화면에서 클릭한 표의
-- 머리글과 행을 그대로 둔다 — 학생 이름이 들어 있어 D1 에만 산다. 전화·이메일·주민번호 패턴은 저장 전에 가린다(desk-api).
-- 프로그램마다 최근 30건만 남긴다. 반영(applied_*)은 수행 스탬프로 옮긴 기록.
CREATE TABLE IF NOT EXISTS desk_captures (
  id          TEXT    PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  program     TEXT    NOT NULL CHECK (length(program) BETWEEN 1 AND 20),
  host        TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  header      TEXT    NOT NULL,
  rows        TEXT    NOT NULL,
  row_count   INTEGER NOT NULL CHECK (row_count >= 0),
  captured_at INTEGER NOT NULL CHECK (captured_at > 0),
  created_by  TEXT    NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  applied_at  INTEGER,
  applied_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_desk_captures_program ON desk_captures(program, captured_at);
