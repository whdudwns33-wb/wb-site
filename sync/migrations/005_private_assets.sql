-- Additive and idempotent: 기존 동기화 데이터는 변경하지 않는다.
CREATE TABLE IF NOT EXISTS private_assets (
  app          TEXT    NOT NULL,
  asset_key    TEXT    NOT NULL,
  data         TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  content_hash TEXT    NOT NULL,
  PRIMARY KEY (app, asset_key)
);
