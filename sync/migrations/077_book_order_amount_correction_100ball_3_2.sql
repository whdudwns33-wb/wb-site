-- 학생배부 완료된 100발100중 영어 3-2 중간고사 주문의 1회성 금액 정정.
-- 원 주문 JSON과 학생·교재 연결은 보존하고, 불변 정정 원장에만 14,400원→16,000원을 기록한다.
INSERT OR IGNORE INTO book_order_item_price_corrections(
  app,task_id,item_index,previous_unit_price,corrected_unit_price,reason_code,created_at,created_by
)
SELECT t.app,t.id,CAST(item.key AS INTEGER),
       CAST(json_extract(item.value,'$.unitPrice') AS INTEGER),16000,'director_amount_correction',
       CAST(strftime('%s','now') AS INTEGER) * 1000,'director'
FROM tasks t
JOIN json_each(json_extract(t.data,'$.orderItems')) item
JOIN book_order_fulfillments f
  ON f.app=t.app AND f.task_id=t.id AND f.item_index=CAST(item.key AS INTEGER)
WHERE t.app='task'
  AND CAST(json_extract(item.value,'$.unitPrice') AS INTEGER)=14400
  AND replace(replace(replace(replace(replace(json_extract(item.value,'$.title'),' ',''),'·',''),'-',''),'–',''),'—','')
      ='100발100중영어32중간고사천재정사열중3'
  AND f.status IN ('student_handed','academy_registered');
