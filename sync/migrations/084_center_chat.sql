-- 모든 업무지시서 직원이 함께 쓰는 센터 소통 피드와 당일 등원 상태.
-- 이름은 인증된 현재 직원/원생 명단에서만 가져오며 명단의 연락처·메모·검사정보는 복사하지 않는다.

CREATE TABLE IF NOT EXISTS center_chat_events (
  feed_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  app             TEXT    NOT NULL CHECK (app = 'task'),
  kind            TEXT    NOT NULL CHECK (kind IN ('message','presence')),
  item_id         TEXT    NOT NULL CHECK (length(item_id) BETWEEN 8 AND 80),
  event_date      TEXT    NOT NULL CHECK (
    event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  actor_staff_id  TEXT    NOT NULL CHECK (
    length(actor_staff_id) BETWEEN 1 AND 128
    AND actor_staff_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  actor_name      TEXT    NOT NULL CHECK (length(trim(actor_name)) BETWEEN 1 AND 80),
  body            TEXT,
  student_id      TEXT,
  status          TEXT,
  revision        INTEGER,
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  UNIQUE (app, item_id),
  CHECK (
    (
      kind = 'message'
      AND item_id GLOB 'ccm_[A-Za-z0-9_-]*'
      AND substr(item_id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND body IS NOT NULL AND length(trim(body)) BETWEEN 1 AND 1000
      AND student_id IS NULL AND status IS NULL AND revision IS NULL
    )
    OR
    (
      kind = 'presence'
      AND item_id GLOB 'cpe_[A-Za-z0-9_-]*'
      AND substr(item_id,5) NOT GLOB '*[^A-Za-z0-9_-]*'
      AND body IS NULL
      AND length(student_id) BETWEEN 1 AND 128
      AND student_id NOT GLOB '*[^A-Za-z0-9_-]*'
      AND status IN ('arrived','left','absent')
      AND revision >= 1
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_center_chat_events_recent
  ON center_chat_events(app, feed_seq DESC);
CREATE INDEX IF NOT EXISTS idx_center_chat_events_today
  ON center_chat_events(app, event_date, feed_seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_center_chat_presence_event_revision
  ON center_chat_events(app, event_date, student_id, revision)
  WHERE kind = 'presence';

CREATE TABLE IF NOT EXISTS center_chat_presence (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  presence_date         TEXT    NOT NULL CHECK (
    presence_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  student_id            TEXT    NOT NULL CHECK (
    length(student_id) BETWEEN 1 AND 128
    AND student_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  status                TEXT    NOT NULL CHECK (status IN ('arrived','left','absent')),
  revision              INTEGER NOT NULL CHECK (revision >= 1),
  updated_at            INTEGER NOT NULL CHECK (updated_at > 0),
  updated_by_staff_id   TEXT    NOT NULL CHECK (
    length(updated_by_staff_id) BETWEEN 1 AND 128
    AND updated_by_staff_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  updated_by_name       TEXT    NOT NULL CHECK (length(trim(updated_by_name)) BETWEEN 1 AND 80),
  PRIMARY KEY (app, presence_date, student_id)
);

CREATE INDEX IF NOT EXISTS idx_center_chat_presence_day
  ON center_chat_presence(app, presence_date, updated_at DESC);

CREATE TABLE IF NOT EXISTS center_chat_reads (
  app                    TEXT    NOT NULL CHECK (app = 'task'),
  reader_staff_id        TEXT    NOT NULL CHECK (
    length(reader_staff_id) BETWEEN 1 AND 128
    AND reader_staff_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  read_through_feed_seq  INTEGER NOT NULL CHECK (read_through_feed_seq >= 1),
  read_through_item_id   TEXT    NOT NULL CHECK (length(read_through_item_id) BETWEEN 8 AND 80),
  updated_at             INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (app, reader_staff_id)
);

CREATE INDEX IF NOT EXISTS idx_center_chat_reads_marker
  ON center_chat_reads(app, read_through_feed_seq);

CREATE TRIGGER IF NOT EXISTS trg_center_chat_events_presence_matches_current
BEFORE INSERT ON center_chat_events
WHEN NEW.kind = 'presence' AND NOT EXISTS (
  SELECT 1 FROM center_chat_presence current
  WHERE current.app = NEW.app
    AND current.presence_date = NEW.event_date
    AND current.student_id = NEW.student_id
    AND current.status = NEW.status
    AND current.revision = NEW.revision
    AND current.updated_at = NEW.created_at
    AND current.updated_by_staff_id = NEW.actor_staff_id
    AND current.updated_by_name = NEW.actor_name
)
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_PRESENCE_EVENT_STATE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_events_no_update
BEFORE UPDATE ON center_chat_events
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_events_no_delete
BEFORE DELETE ON center_chat_events
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_EVENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_presence_first_revision
BEFORE INSERT ON center_chat_presence
WHEN NEW.revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_PRESENCE_REVISION_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_presence_revision
BEFORE UPDATE ON center_chat_presence
WHEN NEW.app IS NOT OLD.app
  OR NEW.presence_date IS NOT OLD.presence_date
  OR NEW.student_id IS NOT OLD.student_id
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_PRESENCE_REVISION_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_presence_no_delete
BEFORE DELETE ON center_chat_presence
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_PRESENCE_NO_DELETE');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_reads_target_insert
BEFORE INSERT ON center_chat_reads
WHEN NOT EXISTS (
  SELECT 1 FROM center_chat_events event
  WHERE event.app = NEW.app
    AND event.feed_seq = NEW.read_through_feed_seq
    AND event.item_id = NEW.read_through_item_id
)
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_READ_TARGET_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_reads_monotonic
BEFORE UPDATE ON center_chat_reads
WHEN NEW.app IS NOT OLD.app
  OR NEW.reader_staff_id IS NOT OLD.reader_staff_id
  OR NEW.read_through_feed_seq <= OLD.read_through_feed_seq
  OR NEW.updated_at < OLD.updated_at
  OR NOT EXISTS (
    SELECT 1 FROM center_chat_events event
    WHERE event.app = NEW.app
      AND event.feed_seq = NEW.read_through_feed_seq
      AND event.item_id = NEW.read_through_item_id
  )
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_READ_MARKER_INVALID');
END;

CREATE TRIGGER IF NOT EXISTS trg_center_chat_reads_no_delete
BEFORE DELETE ON center_chat_reads
BEGIN
  SELECT RAISE(ABORT, 'CENTER_CHAT_READ_NO_DELETE');
END;
