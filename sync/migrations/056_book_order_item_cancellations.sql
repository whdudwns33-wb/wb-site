-- 056: 1단계 주문대기 교재를 묶음 주문 안에서도 품목별로 안전하게 취소한다.
-- 원 주문과 학생 정체성 snapshot은 보존하고 취소 원장만 append-only로 추가한다.
CREATE TABLE IF NOT EXISTS book_order_item_cancellations (
  app          TEXT    NOT NULL CHECK (app = 'task'),
  task_id      TEXT    NOT NULL,
  item_index   INTEGER NOT NULL CHECK (item_index >= 0),
  book_id      TEXT    NOT NULL,
  cancelled_at INTEGER NOT NULL CHECK (cancelled_at > 0),
  cancelled_by TEXT    NOT NULL CHECK (cancelled_by IN ('admin','manager','staff')),
  PRIMARY KEY (app, task_id, item_index)
);
CREATE INDEX IF NOT EXISTS idx_book_order_item_cancellations_book
  ON book_order_item_cancellations(app, book_id, cancelled_at);

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_cancellations_guard
BEFORE INSERT ON book_order_item_cancellations
WHEN NOT (
  EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id
      AND snapshot.item_index=NEW.item_index AND snapshot.book_id=NEW.book_id
  )
  AND EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.app=NEW.app AND task.id=NEW.task_id
      AND COALESCE(json_extract(task.data, '$.deleted'), 0)=0
      AND json_extract(task.data, '$.orderDelivery') IN ('scheduled_batch_v1','manual_online_v1')
      AND json_type(task.data, '$.orderItems[' || NEW.item_index || ']')='object'
      AND CAST(json_extract(task.data, '$.orderItems[' || NEW.item_index || '].bookId') AS TEXT)=NEW.book_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM book_order_cancellations cancellation
    WHERE cancellation.app=NEW.app AND cancellation.task_id=NEW.task_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM book_order_fulfillments fulfillment
    WHERE fulfillment.app=NEW.app AND fulfillment.task_id=NEW.task_id
      AND fulfillment.item_index=NEW.item_index
  )
  AND NOT EXISTS (
    SELECT 1 FROM book_order_sends send
    LEFT JOIN book_order_batch_items item
      ON item.app=send.app AND item.send_id=send.send_id
    WHERE send.app=NEW.app AND (send.task_id=NEW.task_id OR item.task_id=NEW.task_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM book_order_dispatch_lock dispatch
    WHERE dispatch.app=NEW.app AND dispatch.owner NOT GLOB 'cancel_item_*'
      AND dispatch.lease_until > NEW.cancelled_at
  )
)
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_CANCEL_NOT_WAITING');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_cancellations_release
AFTER INSERT ON book_order_item_cancellations
BEGIN
  UPDATE book_order_active_targets SET active=0
  WHERE app=NEW.app AND task_id=NEW.task_id AND item_index=NEW.item_index AND active=1;
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_cancellations_no_update
BEFORE UPDATE ON book_order_item_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_CANCELLATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_book_order_item_cancellations_no_delete
BEFORE DELETE ON book_order_item_cancellations
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_ITEM_CANCELLATION_APPEND_ONLY');
END;

-- 취소된 품목의 학생만 명단 identity lock에서 제외한다. 같은 학생에게 다른 활성 품목이
-- 남아 있으면 그 snapshot이 계속 변경을 차단한다.
DROP TRIGGER IF EXISTS trg_book_order_roster_identity_update;
CREATE TRIGGER trg_book_order_roster_identity_update
BEFORE UPDATE OF data ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_item_cancellations item_cancellation
      WHERE item_cancellation.app=snapshot.app AND item_cancellation.task_id=snapshot.task_id
        AND item_cancellation.item_index=snapshot.item_index
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

DROP TRIGGER IF EXISTS trg_book_order_roster_identity_delete;
CREATE TRIGGER trg_book_order_roster_identity_delete
BEFORE DELETE ON private_rosters
WHEN OLD.app='task' AND EXISTS (
  SELECT 1 FROM book_order_student_snapshots snapshot
  WHERE snapshot.app=OLD.app
    AND NOT EXISTS (
      SELECT 1 FROM book_order_cancellations cancellation
      WHERE cancellation.app=snapshot.app AND cancellation.task_id=snapshot.task_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM book_order_item_cancellations item_cancellation
      WHERE item_cancellation.app=snapshot.app AND item_cancellation.task_id=snapshot.task_id
        AND item_cancellation.item_index=snapshot.item_index
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
