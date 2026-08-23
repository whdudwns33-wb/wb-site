-- consult 영어·수학 PDF 결과지. 파일 본문은 private R2에만 저장한다.
CREATE TABLE IF NOT EXISTS consult_result_sheets (
  app          TEXT NOT NULL CHECK (app = 'consult'),
  result_id    TEXT NOT NULL CHECK (
    result_id GLOB 'crs_[0-9a-f]*' AND substr(result_id,5) NOT GLOB '*[^0-9a-f]*' AND length(result_id) = 36
  ),
  owner        TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 128),
  subject      TEXT NOT NULL CHECK (subject IN ('english','math')),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  result_date  TEXT NOT NULL CHECK (result_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  object_key   TEXT NOT NULL UNIQUE CHECK (object_key GLOB 'consult-results/*.pdf'),
  media_bytes  INTEGER NOT NULL CHECK (media_bytes BETWEEN 1 AND 10485760),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision     INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at   INTEGER NOT NULL CHECK (created_at > 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= created_at),
  uploaded_by  TEXT NOT NULL CHECK (length(uploaded_by) BETWEEN 1 AND 128),
  PRIMARY KEY (app, result_id)
);

CREATE INDEX IF NOT EXISTS idx_consult_result_sheets_owner
  ON consult_result_sheets(app, owner, status, result_date DESC, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_consult_result_sheets_update_guard
BEFORE UPDATE ON consult_result_sheets
WHEN NEW.app <> OLD.app
  OR NEW.result_id <> OLD.result_id
  OR NEW.owner <> OLD.owner
  OR NEW.subject <> OLD.subject
  OR NEW.title <> OLD.title
  OR NEW.result_date <> OLD.result_date
  OR NEW.object_key <> OLD.object_key
  OR NEW.media_bytes <> OLD.media_bytes
  OR NEW.created_at <> OLD.created_at
  OR NEW.uploaded_by <> OLD.uploaded_by
  OR NOT (OLD.status = 'active' AND NEW.status = 'archived')
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_RESULT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_consult_result_sheets_no_delete
BEFORE DELETE ON consult_result_sheets
BEGIN
  SELECT RAISE(ABORT, 'CONSULT_RESULT_NO_DELETE');
END;
