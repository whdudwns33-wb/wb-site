-- 기존 출결 원장과 분리한다. 하루 한 학생 한 요청이며 등원 상태가 생기면 자동 종결한다.
CREATE TABLE IF NOT EXISTS center_chat_missing (
 app TEXT NOT NULL CHECK(app='task'), request_date TEXT NOT NULL,
 student_id TEXT NOT NULL, request_id TEXT NOT NULL,
 student_name TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
 created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','handling','resolved')),
 handler_id TEXT NOT NULL DEFAULT '', handler_name TEXT NOT NULL DEFAULT '', handled_at INTEGER,
 resolved_at INTEGER, PRIMARY KEY(app,request_date,student_id), UNIQUE(app,request_id)
);
CREATE TRIGGER IF NOT EXISTS center_chat_missing_message AFTER INSERT ON center_chat_missing
BEGIN
 INSERT INTO center_chat_events(app,kind,item_id,event_date,actor_staff_id,actor_name,body,created_at)
 VALUES(NEW.app,'message',NEW.request_id,NEW.request_date,NEW.actor_id,NEW.actor_name,
 NEW.student_name || ' 학생이 아직 등원하지 않았습니다.',NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS center_chat_missing_resolve_insert AFTER INSERT ON center_chat_presence
BEGIN
 UPDATE center_chat_missing SET state='resolved',resolved_at=NEW.updated_at
 WHERE app=NEW.app AND request_date=NEW.presence_date AND student_id=NEW.student_id AND state<>'resolved';
END;
CREATE TRIGGER IF NOT EXISTS center_chat_missing_resolve_update AFTER UPDATE ON center_chat_presence
BEGIN
 UPDATE center_chat_missing SET state='resolved',resolved_at=NEW.updated_at
 WHERE app=NEW.app AND request_date=NEW.presence_date AND student_id=NEW.student_id AND state<>'resolved';
END;
