-- 2단계 주문취소: 원 주문·발송 기록은 유지하고 학생별 취소 원장을 확장한다.
DROP TRIGGER IF EXISTS trg_book_order_received_student_cancellations_guard;
CREATE TRIGGER IF NOT EXISTS trg_book_order_received_student_cancellations_guard
BEFORE INSERT ON book_order_received_student_cancellations
WHEN NOT (
  EXISTS (
    SELECT 1 FROM book_order_student_snapshots snapshot
    WHERE snapshot.app=NEW.app AND snapshot.task_id=NEW.task_id
      AND snapshot.item_index=NEW.item_index AND snapshot.book_id=NEW.book_id
      AND snapshot.student_id=NEW.student_id
  )
  AND EXISTS (
    SELECT 1 FROM tasks task
    WHERE task.app=NEW.app AND task.id=NEW.task_id
      AND COALESCE(json_extract(task.data, '$.deleted'), 0)=0
      AND json_type(task.data, '$.orderItems[' || NEW.item_index || ']')='object'
      AND CAST(json_extract(task.data, '$.orderItems[' || NEW.item_index || '].bookId') AS TEXT)=NEW.book_id
  )
  AND (EXISTS (
    SELECT 1 FROM book_order_fulfillments fulfillment
    WHERE fulfillment.app=NEW.app AND fulfillment.task_id=NEW.task_id
      AND fulfillment.item_index=NEW.item_index AND fulfillment.book_id=NEW.book_id
      AND fulfillment.status='teacher_received'
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.app=NEW.app AND t.id=NEW.task_id
        AND json_extract(t.data,'$.orderDelivery') IN ('bound_print_v1','internal_book_v1'))
  ) OR (
    NOT EXISTS (SELECT 1 FROM book_order_fulfillments f WHERE f.app=NEW.app AND f.task_id=NEW.task_id AND f.item_index=NEW.item_index)
    AND NEW.reason LIKE '[총판 취소 확인 완료] %'
    AND EXISTS (
      SELECT 1 FROM book_order_sends s WHERE s.app=NEW.app
        AND (s.task_id=NEW.task_id OR EXISTS (SELECT 1 FROM book_order_batch_items b WHERE b.app=s.app AND b.send_id=s.send_id AND b.task_id=NEW.task_id))
        AND (s.safe_error_code='MANUAL_PHONE_ORDERED' OR (s.status='accepted' AND COALESCE(s.provider_status_code,'') IN ('','4000')))
        AND NOT EXISTS (SELECT 1 FROM book_order_sends newer WHERE newer.app=s.app AND newer.created_at>s.created_at
          AND (newer.task_id=NEW.task_id OR EXISTS (SELECT 1 FROM book_order_batch_items nb WHERE nb.app=newer.app AND nb.send_id=newer.send_id AND nb.task_id=NEW.task_id)))
    )
  ))
  AND NOT EXISTS (
    SELECT 1 FROM book_order_cancellations cancellation
    WHERE cancellation.app=NEW.app AND cancellation.task_id=NEW.task_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM book_order_item_cancellations item_cancellation
    WHERE item_cancellation.app=NEW.app AND item_cancellation.task_id=NEW.task_id
      AND item_cancellation.item_index=NEW.item_index
  )
)
BEGIN
  SELECT RAISE(ABORT, 'BOOK_ORDER_RECEIVED_STUDENT_CANCEL_NOT_ALLOWED');
END;

