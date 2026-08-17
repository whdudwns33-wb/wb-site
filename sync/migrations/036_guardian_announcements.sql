-- 보호자 포털 공지: 관리자 작성·게시·종료, 보호자는 자기 대상의 활성 공지만 읽는다.
CREATE TABLE IF NOT EXISTS guardian_announcements (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  announcement_id    TEXT    NOT NULL,
  title              TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  body               TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  publish_date       TEXT    NOT NULL CHECK (
    COALESCE(length(publish_date) = 10 AND strftime('%Y-%m-%d', publish_date) = publish_date, 0) = 1
  ),
  expires_date       TEXT    NOT NULL CHECK (
    COALESCE(length(expires_date) = 10 AND strftime('%Y-%m-%d', expires_date) = expires_date, 0) = 1
    AND expires_date >= publish_date
  ),
  target_type        TEXT    NOT NULL CHECK (target_type IN ('all','students')),
  target_students    TEXT    NOT NULL CHECK (
    CASE WHEN json_valid(target_students) THEN
      json_type(target_students) = 'array'
      AND (
        (target_type = 'all' AND json_array_length(target_students) = 0)
        OR (target_type = 'students' AND json_array_length(target_students) BETWEEN 1 AND 200)
      )
    ELSE 0 END
  ),
  status             TEXT    NOT NULL CHECK (status IN ('draft','published','ended')),
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT    NOT NULL,
  PRIMARY KEY (app, announcement_id)
);
CREATE INDEX IF NOT EXISTS idx_guardian_announcements_active
  ON guardian_announcements(app, status, publish_date, expires_date);
CREATE INDEX IF NOT EXISTS idx_guardian_announcements_updated
  ON guardian_announcements(app, updated_at);

CREATE TABLE IF NOT EXISTS guardian_announcement_events (
  app                TEXT    NOT NULL CHECK (app = 'task'),
  event_id           TEXT    NOT NULL,
  announcement_id    TEXT    NOT NULL,
  revision           INTEGER NOT NULL CHECK (revision >= 1),
  event_type         TEXT    NOT NULL CHECK (event_type IN ('created','updated','published','ended')),
  status             TEXT    NOT NULL CHECK (status IN ('draft','published','ended')),
  title              TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  body               TEXT    NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  publish_date       TEXT    NOT NULL CHECK (
    COALESCE(length(publish_date) = 10 AND strftime('%Y-%m-%d', publish_date) = publish_date, 0) = 1
  ),
  expires_date       TEXT    NOT NULL CHECK (
    COALESCE(length(expires_date) = 10 AND strftime('%Y-%m-%d', expires_date) = expires_date, 0) = 1
    AND expires_date >= publish_date
  ),
  target_type        TEXT    NOT NULL CHECK (target_type IN ('all','students')),
  target_students    TEXT    NOT NULL CHECK (
    CASE WHEN json_valid(target_students) THEN
      json_type(target_students) = 'array'
      AND (
        (target_type = 'all' AND json_array_length(target_students) = 0)
        OR (target_type = 'students' AND json_array_length(target_students) BETWEEN 1 AND 200)
      )
    ELSE 0 END
  ),
  created_at         INTEGER NOT NULL,
  created_by         TEXT    NOT NULL,
  PRIMARY KEY (app, event_id),
  UNIQUE (app, announcement_id, revision),
  FOREIGN KEY (app, announcement_id) REFERENCES guardian_announcements(app, announcement_id),
  CHECK (
    (event_type IN ('created','updated') AND status = 'draft')
    OR (event_type = 'published' AND status = 'published')
    OR (event_type = 'ended' AND status = 'ended')
  )
);

CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_targets_insert
BEFORE INSERT ON guardian_announcements
WHEN CASE WHEN json_valid(NEW.target_students) THEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.target_students) target
    WHERE target.type <> 'object'
      OR json_type(target.value, '$.id') <> 'text'
      OR length(json_extract(target.value, '$.id')) NOT BETWEEN 1 AND 128
      OR json_extract(target.value, '$.id') GLOB '*[^A-Za-z0-9_-]*'
      OR json_type(target.value, '$.identityHash') <> 'text'
      OR length(json_extract(target.value, '$.identityHash')) <> 64
      OR json_extract(target.value, '$.identityHash') GLOB '*[^a-f0-9]*'
      OR (SELECT COUNT(*) FROM json_each(target.value)) <> 2
  ) OR (
    SELECT COUNT(*) <> COUNT(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.target_students)
  )
ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_TARGET_INVALID');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_targets_update
BEFORE UPDATE ON guardian_announcements
WHEN CASE WHEN json_valid(NEW.target_students) THEN
  EXISTS (
    SELECT 1 FROM json_each(NEW.target_students) target
    WHERE target.type <> 'object'
      OR json_type(target.value, '$.id') <> 'text'
      OR length(json_extract(target.value, '$.id')) NOT BETWEEN 1 AND 128
      OR json_extract(target.value, '$.id') GLOB '*[^A-Za-z0-9_-]*'
      OR json_type(target.value, '$.identityHash') <> 'text'
      OR length(json_extract(target.value, '$.identityHash')) <> 64
      OR json_extract(target.value, '$.identityHash') GLOB '*[^a-f0-9]*'
      OR (SELECT COUNT(*) FROM json_each(target.value)) <> 2
  ) OR (
    SELECT COUNT(*) <> COUNT(DISTINCT json_extract(value, '$.id')) FROM json_each(NEW.target_students)
  )
ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_TARGET_INVALID');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_update
BEFORE UPDATE ON guardian_announcements
WHEN NEW.announcement_id IS NOT OLD.announcement_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision <> OLD.revision + 1
  OR NEW.updated_at <= OLD.updated_at
  OR NOT (
    (OLD.status = 'draft' AND NEW.status IN ('draft','published'))
    OR (OLD.status = 'published' AND NEW.status = 'ended')
  )
  OR (
    (NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
      OR NEW.publish_date IS NOT OLD.publish_date OR NEW.expires_date IS NOT OLD.expires_date
      OR NEW.target_type IS NOT OLD.target_type
      OR NEW.target_students IS NOT OLD.target_students)
    AND NOT (OLD.status = 'draft' AND NEW.status = 'draft')
  )
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_INVALID_TRANSITION');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcements_no_delete
BEFORE DELETE ON guardian_announcements
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcement_events_no_update
BEFORE UPDATE ON guardian_announcement_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_EVENT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_guardian_announcement_events_no_delete
BEFORE DELETE ON guardian_announcement_events
BEGIN
  SELECT RAISE(ABORT, 'GUARDIAN_ANNOUNCEMENT_EVENT_APPEND_ONLY');
END;
