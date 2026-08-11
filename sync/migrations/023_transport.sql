-- 차량 운행 설정과 날짜별 승·하차 원장.
-- 주소·전화번호·보호자 정보는 저장하지 않는다.
CREATE TABLE IF NOT EXISTS transport_configs (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  data       TEXT    NOT NULL CHECK (
    json_valid(data) AND length(CAST(data AS BLOB)) <= 524288
  ),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NOT NULL,
  PRIMARY KEY (app)
);

CREATE TABLE IF NOT EXISTS transport_states (
  app         TEXT    NOT NULL CHECK (app = 'task'),
  date        TEXT    NOT NULL,
  route_id    TEXT    NOT NULL,
  student_id  TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('scheduled','boarded','dropped','absent')),
  revision    INTEGER NOT NULL CHECK (revision >= 1),
  boarded_at  INTEGER,
  boarded_by  TEXT,
  dropped_at  INTEGER,
  dropped_by  TEXT,
  absent_at   INTEGER,
  absent_by   TEXT,
  history     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(history)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (app, date, route_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_transport_states_day
  ON transport_states(app, date, status, route_id);
CREATE INDEX IF NOT EXISTS idx_transport_states_student
  ON transport_states(app, student_id, date);
CREATE INDEX IF NOT EXISTS idx_transport_states_unresolved
  ON transport_states(app, status, date, updated_at);
