-- 046_app_data_generations.sql
-- 운영 데이터 초기화 뒤 구형 브라우저 캐시가 삭제된 학생·수업을 다시 올리지 못하게 한다.

CREATE TABLE IF NOT EXISTS app_data_generations (
  app TEXT PRIMARY KEY CHECK (app IN ('task', 'consult')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO app_data_generations(app, generation, updated_at) VALUES
  ('task', 0, 0),
  ('consult', 0, 0);
