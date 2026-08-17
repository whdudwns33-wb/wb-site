-- 새 주문의 학생 정체성을 생성 시점에 봉인한다. 과거 주문은 자동 이관하지 않는다.
CREATE TABLE IF NOT EXISTS book_order_student_snapshots (
  app                   TEXT    NOT NULL CHECK (app = 'task'),
  task_id               TEXT    NOT NULL CHECK (
    length(task_id) BETWEEN 12 AND 124 AND task_id GLOB 'ord_*'
    AND task_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  item_index            INTEGER NOT NULL CHECK (item_index >= 0),
  owner_id              TEXT    NOT NULL CHECK (
    owner_id = '' OR (length(owner_id) BETWEEN 1 AND 128 AND owner_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  book_id               TEXT    NOT NULL CHECK (
    length(book_id) BETWEEN 1 AND 128 AND book_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  public_title          TEXT    NOT NULL CHECK (public_title = '주문 교재'),
  student_id            TEXT    NOT NULL CHECK (
    length(student_id) BETWEEN 1 AND 128 AND student_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  student_identity_hash TEXT    NOT NULL CHECK (
    length(student_identity_hash) = 64 AND student_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  student_set_hash      TEXT    NOT NULL CHECK (
    length(student_set_hash) = 64 AND student_set_hash NOT GLOB '*[^a-f0-9]*'
  ),
  item_identity_hash    TEXT    NOT NULL CHECK (
    length(item_identity_hash) = 64 AND item_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  task_identity_hash    TEXT    NOT NULL CHECK (
    length(task_identity_hash) = 64 AND task_identity_hash NOT GLOB '*[^a-f0-9]*'
  ),
  expected_item_count   INTEGER NOT NULL CHECK (expected_item_count BETWEEN 1 AND 50),
  expected_row_count    INTEGER NOT NULL CHECK (expected_row_count BETWEEN 1 AND 200),
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (app, task_id, item_index, student_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_student_snapshots_student
  ON book_order_student_snapshots(app, student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_book_order_student_snapshots_task
  ON book_order_student_snapshots(app, task_id, item_index);

-- 같은 학생·같은 교재의 미완료 주문을 DB 수준에서 하나로 제한한다.
CREATE TABLE IF NOT EXISTS book_order_active_targets (
  app        TEXT    NOT NULL CHECK (app = 'task'),
  book_id    TEXT    NOT NULL,
  student_id TEXT    NOT NULL,
  task_id    TEXT    NOT NULL,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  created_at INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (app, task_id, item_index, student_id)
);
CREATE INDEX IF NOT EXISTS idx_book_order_active_targets_task
  ON book_order_active_targets(app, task_id, item_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_order_one_active_target
  ON book_order_active_targets(app, book_id, student_id) WHERE active=1;

CREATE TRIGGER IF NOT EXISTS trg_book_order_active_targets_no_delete
BEFORE DELETE ON book_order_active_targets
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ACTIVE_TARGET_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_active_targets_release_only
BEFORE UPDATE ON book_order_active_targets
WHEN NOT (
  OLD.active=1 AND NEW.active=0
  AND NEW.app IS OLD.app AND NEW.book_id IS OLD.book_id AND NEW.student_id IS OLD.student_id
  AND NEW.task_id IS OLD.task_id AND NEW.item_index IS OLD.item_index AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ACTIVE_TARGET_APPEND_ONLY');
END;

CREATE TABLE IF NOT EXISTS book_order_cancellations (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  task_id      TEXT    NOT NULL,
  cancelled_at INTEGER NOT NULL,
  PRIMARY KEY (app, task_id)
);

CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshots_no_update
BEFORE UPDATE ON book_order_student_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SNAPSHOT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshots_no_delete
BEFORE DELETE ON book_order_student_snapshots
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SNAPSHOT_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_snapshot_activate
AFTER INSERT ON book_order_student_snapshots
BEGIN
  INSERT INTO book_order_active_targets(app,book_id,student_id,task_id,item_index,created_at,active)
  VALUES(NEW.app,NEW.book_id,NEW.student_id,NEW.task_id,NEW.item_index,NEW.created_at,1);
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_fulfillment_deactivate_insert
AFTER INSERT ON book_order_fulfillments
WHEN NEW.status IN ('student_handed','academy_registered')
  AND json_valid(NEW.student_ids)
  AND (SELECT COUNT(*) FROM book_order_student_snapshots snapshot
       WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
         AND snapshot.book_id=NEW.book_id) = json_array_length(NEW.student_ids)
  AND NOT EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
      AND snapshot.book_id=NEW.book_id
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.student_ids) student WHERE student.value=snapshot.student_id)
  )
BEGIN
  UPDATE book_order_active_targets SET active=0
  WHERE app=NEW.app AND task_id=NEW.task_id AND item_index=NEW.item_index AND active=1;
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_fulfillment_deactivate_update
AFTER UPDATE OF status ON book_order_fulfillments
WHEN NEW.status IN ('student_handed','academy_registered')
  AND OLD.status NOT IN ('student_handed','academy_registered')
  AND json_valid(NEW.student_ids)
  AND (SELECT COUNT(*) FROM book_order_student_snapshots snapshot
       WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
         AND snapshot.book_id=NEW.book_id) = json_array_length(NEW.student_ids)
  AND NOT EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id AND snapshot.item_index=NEW.item_index
      AND snapshot.book_id=NEW.book_id
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.student_ids) student WHERE student.value=snapshot.student_id)
  )
BEGIN
  UPDATE book_order_active_targets SET active=0
  WHERE app=NEW.app AND task_id=NEW.task_id AND item_index=NEW.item_index AND active=1;
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_cancellations_no_update
BEFORE UPDATE ON book_order_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_CANCELLATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_cancellations_no_delete
BEFORE DELETE ON book_order_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_CANCELLATION_APPEND_ONLY');
END;

-- 봉인된 주문은 전용 /book-order cancel이 남기는 정형 전환 외에는 바꿀 수 없다.
CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_update
BEFORE UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=OLD.app AND snapshot.task_id=OLD.id
  )
  AND NOT (
    COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
    AND json_extract(NEW.data, '$.deleted') = 1
    AND json_extract(NEW.data, '$.orderCancelledAt') = NEW.updated_at
    AND json_remove(NEW.data, '$.deleted', '$.updatedAt', '$.lastEditBy', '$.orderCancelledAt')
        = json_remove(OLD.data, '$.deleted', '$.updatedAt', '$.lastEditBy', '$.orderCancelledAt')
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SEALED');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_cancel_busy
BEFORE UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=OLD.app AND snapshot.task_id=OLD.id
  )
  AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  AND json_extract(NEW.data, '$.deleted') = 1
  AND (
    EXISTS (
      SELECT 1 FROM book_order_dispatch_lock dispatch
      WHERE dispatch.app=OLD.app AND dispatch.owner NOT LIKE 'cancel_%'
        AND dispatch.lease_until > CAST(json_extract(NEW.data, '$.orderCancelledAt') AS INTEGER)
    )
    OR EXISTS (
      SELECT 1 FROM book_order_sends send
      LEFT JOIN book_order_batch_items item
        ON item.app=send.app AND item.send_id=send.send_id
      WHERE send.app=OLD.app
        AND (item.task_id=OLD.id OR (send.task_id=OLD.id AND send.task_id LIKE 'ord_%'))
        AND send.status IN ('reserved','dispatching','accepted','unknown')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_SEND_ACTIVE');
END;
CREATE TRIGGER IF NOT EXISTS trg_book_order_sealed_task_cancel
AFTER UPDATE OF data ON tasks
WHEN EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.id
  )
  AND COALESCE(json_extract(OLD.data, '$.deleted'), 0) = 0
  AND json_extract(NEW.data, '$.deleted') = 1
BEGIN
  INSERT INTO book_order_cancellations(app, task_id, cancelled_at)
  VALUES(
    NEW.app,
    NEW.id,
    CAST(json_extract(NEW.data, '$.orderCancelledAt') AS INTEGER)
  );
  UPDATE book_order_active_targets SET active=0 WHERE app=NEW.app AND task_id=NEW.id AND active=1;
END;

-- 생성과 명단 수정이 엇갈려도 봉인된 학생 ID/이름/재원 상태가 바뀌지 않게 DB에서 직렬화한다.
-- 학생 전달 후에도 아카플로우 등록까지는 같은 정체성을 유지해야 한다.
CREATE TRIGGER IF NOT EXISTS trg_book_order_roster_identity_update
BEFORE UPDATE OF data ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_fulfillments fulfillment
      WHERE fulfillment.app=snapshot.app AND fulfillment.task_id=snapshot.task_id
        AND fulfillment.item_index=snapshot.item_index AND fulfillment.book_id=snapshot.book_id
        AND fulfillment.status='academy_registered' AND json_valid(fulfillment.student_ids)
        AND (SELECT COUNT(*) FROM book_order_student_snapshots expected
             WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
               AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id)
            = json_array_length(fulfillment.student_ids)
        AND NOT EXISTS (
          SELECT 1 FROM book_order_student_snapshots expected
          WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
            AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fulfillment.student_ids) selected
              WHERE selected.value=expected.student_id
            )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(OLD.data, '$.roster.students') old_student
      JOIN json_each(NEW.data, '$.roster.students') new_student
        ON CAST(json_extract(new_student.value, '$.id') AS TEXT)=snapshot.student_id
      WHERE CAST(json_extract(old_student.value, '$.id') AS TEXT)=snapshot.student_id
        AND CAST(json_extract(new_student.value, '$.name') AS TEXT)
            = CAST(json_extract(old_student.value, '$.name') AS TEXT)
        AND (
          (
            CAST(json_extract(new_student.value, '$.start') AS TEXT) <= strftime('%Y-%m','now','+9 hours')
            AND (
              COALESCE(CAST(json_extract(new_student.value, '$.end') AS TEXT),'')=''
              OR CAST(json_extract(new_student.value, '$.end') AS TEXT) > strftime('%Y-%m','now','+9 hours')
            )
          )
          OR (
            CAST(json_extract(new_student.value, '$.start') AS TEXT)
                = CAST(json_extract(old_student.value, '$.start') AS TEXT)
            AND COALESCE(CAST(json_extract(new_student.value, '$.end') AS TEXT),'')
                = COALESCE(CAST(json_extract(old_student.value, '$.end') AS TEXT),'')
          )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_BOOK_ORDER_CONFLICT');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_roster_identity_delete
BEFORE DELETE ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_fulfillments fulfillment
      WHERE fulfillment.app=snapshot.app AND fulfillment.task_id=snapshot.task_id
        AND fulfillment.item_index=snapshot.item_index AND fulfillment.book_id=snapshot.book_id
        AND fulfillment.status='academy_registered' AND json_valid(fulfillment.student_ids)
        AND (SELECT COUNT(*) FROM book_order_student_snapshots expected
             WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
               AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id)
            = json_array_length(fulfillment.student_ids)
        AND NOT EXISTS (
          SELECT 1 FROM book_order_student_snapshots expected
          WHERE expected.app=snapshot.app AND expected.task_id=snapshot.task_id
            AND expected.item_index=snapshot.item_index AND expected.book_id=snapshot.book_id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(fulfillment.student_ids) selected
              WHERE selected.value=expected.student_id
            )
        )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_BOOK_ORDER_CONFLICT');
END;
