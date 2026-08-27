-- 아카등록 완료된 일반 주문 교재의 공용 카탈로그.
-- 주문·학생·연락처 식별자는 보관하지 않고 교재 메타데이터와 검색 검증 결과만 남긴다.
CREATE TABLE IF NOT EXISTS completed_book_catalog (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  catalog_id            TEXT    NOT NULL CHECK (
    length(catalog_id) BETWEEN 1 AND 128 AND catalog_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  title                 TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  normalized_title      TEXT    NOT NULL CHECK (length(normalized_title) BETWEEN 1 AND 160),
  publisher_name        TEXT    NOT NULL CHECK (length(publisher_name) <= 100),
  normalized_publisher  TEXT    NOT NULL CHECK (length(normalized_publisher) <= 100),
  selected_publisher_name       TEXT NOT NULL CHECK (length(selected_publisher_name) <= 100),
  selected_normalized_title     TEXT NOT NULL CHECK (length(selected_normalized_title) BETWEEN 1 AND 160),
  selected_normalized_publisher TEXT NOT NULL CHECK (length(selected_normalized_publisher) <= 100),
  vendor_name           TEXT    NOT NULL CHECK (length(vendor_name) BETWEEN 1 AND 100),
  completed_at          INTEGER NOT NULL CHECK (completed_at > 0),
  verification_status   TEXT    NOT NULL CHECK (verification_status IN (
    'pending',
    'verified',
    'fallback_search_disabled',
    'fallback_ai_unavailable',
    'fallback_ai_error',
    'fallback_mismatch',
    'fallback_no_source',
    'fallback_insufficient_evidence',
    'legacy_fallback'
  )),
  source_urls           TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(source_urls) AND json_type(source_urls) = 'array'),
  verified_at           INTEGER,
  revision              INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 1000000),
  review_method         TEXT    NOT NULL DEFAULT 'none' CHECK (review_method IN ('none','web_search','admin','legacy')),
  reviewed_at           INTEGER CHECK (reviewed_at IS NULL OR reviewed_at > 0),
  reviewed_by           TEXT    CHECK (reviewed_by IS NULL OR (
    length(reviewed_by) BETWEEN 1 AND 128 AND reviewed_by NOT GLOB '*[^A-Za-z0-9_-]*'
  )),
  created_at            INTEGER NOT NULL CHECK (created_at > 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (verified_at IS NULL OR verified_at >= completed_at),
  CHECK (verification_status <> 'verified' OR (verified_at IS NOT NULL AND length(publisher_name) > 0)),
  CHECK (verification_status <> 'verified' OR review_method <> 'web_search' OR json_array_length(source_urls) > 0),
  CHECK ((review_method = 'admin') = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CHECK (
    (review_method = 'none' AND verification_status IN ('pending','fallback_search_disabled','fallback_ai_unavailable')) OR
    (review_method = 'web_search' AND verification_status IN (
      'verified','fallback_ai_error','fallback_mismatch','fallback_no_source','fallback_insufficient_evidence'
    )) OR
    (review_method = 'admin' AND verification_status = 'verified') OR
    (review_method = 'legacy' AND verification_status = 'legacy_fallback')
  ),
  PRIMARY KEY (app, catalog_id),
  UNIQUE (app, normalized_publisher, normalized_title),
  UNIQUE (app, selected_normalized_publisher, selected_normalized_title)
);
CREATE INDEX IF NOT EXISTS idx_completed_book_catalog_completed
  ON completed_book_catalog(app, completed_at DESC);

-- 관리자가 검색 실패 후보를 확정한 이력. 교재 메타데이터와 직원 감사 ID만 보관한다.
CREATE TABLE IF NOT EXISTS completed_book_catalog_review_events (
  app             TEXT    NOT NULL CHECK (app = 'task'),
  event_id        TEXT    NOT NULL CHECK (
    length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  catalog_id      TEXT    NOT NULL CHECK (
    length(catalog_id) BETWEEN 1 AND 128 AND catalog_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  from_status     TEXT    NOT NULL CHECK (from_status IN (
    'fallback_search_disabled','fallback_ai_unavailable','fallback_ai_error','fallback_mismatch',
    'fallback_no_source','fallback_insufficient_evidence','legacy_fallback'
  )),
  from_revision   INTEGER NOT NULL CHECK (from_revision BETWEEN 0 AND 999999),
  to_revision     INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
  title           TEXT    NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  publisher_name  TEXT    NOT NULL CHECK (length(publisher_name) BETWEEN 1 AND 100),
  reviewed_by     TEXT    NOT NULL CHECK (
    length(reviewed_by) BETWEEN 1 AND 128 AND reviewed_by NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  reviewed_at     INTEGER NOT NULL CHECK (reviewed_at > 0),
  PRIMARY KEY (app, event_id),
  UNIQUE (app, catalog_id, to_revision)
);
CREATE INDEX IF NOT EXISTS idx_completed_book_catalog_reviews
  ON completed_book_catalog_review_events(app, catalog_id, reviewed_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_completed_book_catalog_review_insert
BEFORE INSERT ON completed_book_catalog_review_events
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM completed_book_catalog catalog
    WHERE catalog.app=NEW.app AND catalog.catalog_id=NEW.catalog_id
      AND catalog.verification_status=NEW.from_status AND catalog.revision=NEW.from_revision
      AND catalog.verification_status NOT IN ('pending','verified')
  ) THEN RAISE(ABORT, 'COMPLETED_BOOK_CATALOG_REVIEW_STALE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_completed_book_catalog_review_no_update
BEFORE UPDATE ON completed_book_catalog_review_events
BEGIN
  SELECT RAISE(ABORT, 'COMPLETED_BOOK_CATALOG_REVIEW_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_completed_book_catalog_review_no_delete
BEFORE DELETE ON completed_book_catalog_review_events
BEGIN
  SELECT RAISE(ABORT, 'COMPLETED_BOOK_CATALOG_REVIEW_APPEND_ONLY');
END;

-- 검색 결과 또는 관리자 검토만 revision을 하나 올려 최종 상태로 바꿀 수 있다.
CREATE TRIGGER IF NOT EXISTS trg_completed_book_catalog_update
BEFORE UPDATE ON completed_book_catalog
BEGIN
  SELECT CASE WHEN
    NEW.app <> OLD.app OR NEW.catalog_id <> OLD.catalog_id OR NEW.vendor_name <> OLD.vendor_name OR
    NEW.selected_publisher_name <> OLD.selected_publisher_name OR
    NEW.selected_normalized_title <> OLD.selected_normalized_title OR
    NEW.selected_normalized_publisher <> OLD.selected_normalized_publisher OR
    NEW.completed_at <> OLD.completed_at OR NEW.created_at <> OLD.created_at OR
    NEW.revision <> OLD.revision + 1 OR OLD.verification_status = 'verified' OR
    NEW.verification_status = 'pending' OR NEW.verified_at IS NULL OR
    ((NEW.title <> OLD.title OR NEW.normalized_title <> OLD.normalized_title OR
      NEW.publisher_name <> OLD.publisher_name OR NEW.normalized_publisher <> OLD.normalized_publisher) AND
      NEW.verification_status <> 'verified') OR
    NEW.updated_at < OLD.updated_at OR NOT (
      (OLD.verification_status = 'pending' AND NEW.review_method = 'web_search' AND
        NEW.verification_status IN (
          'verified','fallback_ai_error','fallback_mismatch','fallback_no_source','fallback_insufficient_evidence'
        ) AND NEW.reviewed_at IS NULL AND NEW.reviewed_by IS NULL) OR
      (OLD.verification_status NOT IN ('pending','verified') AND NEW.verification_status = 'verified' AND
        NEW.review_method = 'admin' AND NEW.reviewed_at IS NOT NULL AND NEW.reviewed_by IS NOT NULL AND
        NEW.source_urls = OLD.source_urls AND EXISTS (
          SELECT 1 FROM completed_book_catalog_review_events event
          WHERE event.app=NEW.app AND event.catalog_id=NEW.catalog_id
            AND event.from_status=OLD.verification_status AND event.from_revision=OLD.revision
            AND event.to_revision=NEW.revision AND event.title=NEW.title
            AND event.publisher_name=NEW.publisher_name AND event.reviewed_by=NEW.reviewed_by
            AND event.reviewed_at=NEW.reviewed_at
        ))
    )
  THEN RAISE(ABORT, 'COMPLETED_BOOK_CATALOG_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_completed_book_catalog_no_delete
BEFORE DELETE ON completed_book_catalog
BEGIN
  SELECT RAISE(ABORT, 'COMPLETED_BOOK_CATALOG_APPEND_ONLY');
END;

-- 이미 아카등록 완료된 과거 일반 주문도 검색 호출 없이 입력값 기준으로 한 번만 보강한다.
INSERT OR IGNORE INTO completed_book_catalog(
  app,catalog_id,title,normalized_title,publisher_name,normalized_publisher,selected_publisher_name,
  selected_normalized_title,selected_normalized_publisher,vendor_name,
  completed_at,verification_status,source_urls,verified_at,revision,review_method,reviewed_at,reviewed_by,
  created_at,updated_at
)
SELECT
  fulfillment.app,
  CAST(json_extract(order_item.value,'$.bookId') AS TEXT),
  trim(CAST(json_extract(order_item.value,'$.title') AS TEXT)),
  lower(trim(replace(replace(replace(CAST(json_extract(order_item.value,'$.title') AS TEXT),char(9),' '),char(10),' '),char(13),' '))),
  CASE WHEN json_type(order_item.value,'$.publisherName') IS NOT NULL
    THEN trim(COALESCE(CAST(json_extract(order_item.value,'$.publisherName') AS TEXT),''))
    ELSE '' END,
  lower(CASE WHEN json_type(order_item.value,'$.publisherName') IS NOT NULL
    THEN trim(COALESCE(CAST(json_extract(order_item.value,'$.publisherName') AS TEXT),''))
    ELSE '' END),
  CASE WHEN json_type(order_item.value,'$.publisherName') IS NOT NULL
    THEN trim(COALESCE(CAST(json_extract(order_item.value,'$.publisherName') AS TEXT),''))
    ELSE '' END,
  lower(trim(replace(replace(replace(CAST(json_extract(order_item.value,'$.title') AS TEXT),char(9),' '),char(10),' '),char(13),' '))),
  lower(CASE WHEN json_type(order_item.value,'$.publisherName') IS NOT NULL
    THEN trim(COALESCE(CAST(json_extract(order_item.value,'$.publisherName') AS TEXT),''))
    ELSE '' END),
  trim(CAST(json_extract(task.data,'$.orderVendor') AS TEXT)),
  fulfillment.academy_registered_at,
  'legacy_fallback',
  '[]',
  NULL,
  0,
  'legacy',
  NULL,
  NULL,
  fulfillment.academy_registered_at,
  fulfillment.academy_registered_at
FROM book_order_fulfillments fulfillment
JOIN tasks task ON task.app=fulfillment.app AND task.id=fulfillment.task_id
JOIN json_each(task.data,'$.orderItems') order_item ON CAST(order_item.key AS INTEGER)=fulfillment.item_index
WHERE fulfillment.app='task'
  AND fulfillment.status='academy_registered'
  AND fulfillment.academy_registered_at IS NOT NULL
  AND json_extract(task.data,'$.orderDelivery') IN ('scheduled_batch_v1','manual_online_v1')
  AND COALESCE(json_extract(task.data,'$.deleted'),0)=0
  AND length(CAST(json_extract(order_item.value,'$.bookId') AS TEXT)) BETWEEN 1 AND 128
  AND CAST(json_extract(order_item.value,'$.bookId') AS TEXT) NOT GLOB '*[^A-Za-z0-9_-]*'
  AND length(trim(CAST(json_extract(order_item.value,'$.title') AS TEXT))) BETWEEN 1 AND 160
  AND length(trim(CAST(json_extract(task.data,'$.orderVendor') AS TEXT))) BETWEEN 1 AND 100
ORDER BY fulfillment.academy_registered_at,fulfillment.task_id,fulfillment.item_index;
