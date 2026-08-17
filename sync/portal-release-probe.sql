-- 보호자·학생 앱 배포 전후에 사용하는 읽기 전용 구조 검사.
-- found와 expected가 다르면 migration이나 Worker를 진행하지 않는다.

WITH expected(type, name) AS (VALUES
  ('table','tasks'),
  ('table','private_rosters'),
  ('table','guardian_contacts_by_student'),
  ('table','guardian_lesson_publications'),
  ('table','guardian_lesson_publication_events'),
  ('table','book_order_dispatch_lock'),
  ('table','book_order_sends'),
  ('table','book_order_batch_items'),
  ('table','book_order_fulfillments')
)
SELECT 'prerequisite_tables' AS check_name, COUNT(schema.name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN sqlite_master schema ON schema.type=expected.type AND schema.name=expected.name;

WITH expected(type, name) AS (VALUES
  ('table','guardian_announcements'),
  ('table','guardian_announcement_events'),
  ('index','idx_guardian_announcements_active'),
  ('index','idx_guardian_announcements_updated'),
  ('trigger','trg_guardian_announcements_targets_insert'),
  ('trigger','trg_guardian_announcements_targets_update'),
  ('trigger','trg_guardian_announcements_update'),
  ('trigger','trg_guardian_announcements_no_delete'),
  ('trigger','trg_guardian_announcement_events_no_update'),
  ('trigger','trg_guardian_announcement_events_no_delete')
)
SELECT 'migration_036_objects' AS check_name, COUNT(schema.name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN sqlite_master schema ON schema.type=expected.type AND schema.name=expected.name;

WITH expected(type, name) AS (VALUES
  ('table','book_order_student_snapshots'),
  ('table','book_order_active_targets'),
  ('table','book_order_cancellations'),
  ('index','idx_book_order_student_snapshots_student'),
  ('index','idx_book_order_student_snapshots_task'),
  ('index','idx_book_order_active_targets_task'),
  ('index','idx_book_order_one_active_target'),
  ('trigger','trg_book_order_active_targets_no_delete'),
  ('trigger','trg_book_order_active_targets_release_only'),
  ('trigger','trg_book_order_snapshots_no_update'),
  ('trigger','trg_book_order_snapshots_no_delete'),
  ('trigger','trg_book_order_snapshot_activate'),
  ('trigger','trg_book_order_fulfillment_deactivate_insert'),
  ('trigger','trg_book_order_fulfillment_deactivate_update'),
  ('trigger','trg_book_order_cancellations_no_update'),
  ('trigger','trg_book_order_cancellations_no_delete'),
  ('trigger','trg_book_order_sealed_task_update'),
  ('trigger','trg_book_order_sealed_task_cancel_busy'),
  ('trigger','trg_book_order_sealed_task_cancel'),
  ('trigger','trg_book_order_roster_identity_update'),
  ('trigger','trg_book_order_roster_identity_delete')
)
SELECT 'migration_037_objects' AS check_name, COUNT(schema.name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN sqlite_master schema ON schema.type=expected.type AND schema.name=expected.name;

WITH expected(type, name) AS (VALUES
  ('table','student_portal_access'),
  ('table','student_portal_codes'),
  ('table','student_portal_sessions'),
  ('index','idx_student_portal_codes_student'),
  ('index','idx_student_portal_sessions_student'),
  ('trigger','trg_student_portal_access_revoke'),
  ('trigger','trg_student_portal_roster_identity_update'),
  ('trigger','trg_student_portal_roster_delete'),
  ('trigger','trg_student_portal_guardian_identity_update'),
  ('trigger','trg_student_portal_guardian_identity_delete')
)
SELECT 'migration_038_objects' AS check_name, COUNT(schema.name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN sqlite_master schema ON schema.type=expected.type AND schema.name=expected.name;

WITH expected(table_name, column_name) AS (VALUES
  ('guardian_lesson_publications','student_visible'),
  ('guardian_lesson_publication_events','student_visible')
), found(table_name, column_name) AS (
  SELECT 'guardian_lesson_publications', name FROM pragma_table_info('guardian_lesson_publications')
  UNION ALL
  SELECT 'guardian_lesson_publication_events', name FROM pragma_table_info('guardian_lesson_publication_events')
)
SELECT 'migration_038_columns' AS check_name, COUNT(found.column_name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN found ON found.table_name=expected.table_name AND found.column_name=expected.column_name;

-- 039는 구 Worker용 scope_version=1 열을 유지하고 실제 v1·v2 동의 범위 열을 추가한다.
-- 세 테이블이나 범위 보호 trigger 중 일부만 바뀌면 Worker를 배포하지 않는다.
WITH expected(type, name) AS (VALUES
  ('trigger','trg_student_portal_code_scope_insert'),
  ('trigger','trg_student_portal_session_scope_insert'),
  ('trigger','trg_student_portal_access_disable_scope'),
  ('trigger','trg_student_portal_access_scope_mismatch')
)
SELECT 'migration_039_objects' AS check_name, COUNT(schema.name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN sqlite_master schema ON schema.type=expected.type AND schema.name=expected.name;

WITH expected(table_name, column_name) AS (VALUES
  ('student_portal_access','effective_scope_version'),
  ('student_portal_access','scope_confirmed_at'),
  ('student_portal_codes','effective_scope_version'),
  ('student_portal_sessions','effective_scope_version')
), found(table_name, column_name) AS (
  SELECT 'student_portal_access', name FROM pragma_table_info('student_portal_access')
  UNION ALL
  SELECT 'student_portal_codes', name FROM pragma_table_info('student_portal_codes')
  UNION ALL
  SELECT 'student_portal_sessions', name FROM pragma_table_info('student_portal_sessions')
)
SELECT 'migration_039_columns' AS check_name, COUNT(found.column_name) AS found, COUNT(*) AS expected
FROM expected
LEFT JOIN found ON found.table_name=expected.table_name AND found.column_name=expected.column_name;
