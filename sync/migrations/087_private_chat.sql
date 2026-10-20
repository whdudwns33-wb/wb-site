-- 제안 전용: 운영 적용/기능 활성화는 별도 승인한다. 기존 업무·출결 테이블은 변경하지 않는다.
CREATE TABLE IF NOT EXISTS private_chat_sessions (
  organization_id TEXT NOT NULL, token_hash TEXT NOT NULL, staff_id TEXT NOT NULL,
  device_hash TEXT NOT NULL, staff_hash TEXT NOT NULL, credential_revision INTEGER NOT NULL,
  data_generation INTEGER NOT NULL, config_hash TEXT NOT NULL, parent_work_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, last_user_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
  PRIMARY KEY(organization_id,token_hash)
);
CREATE TABLE IF NOT EXISTS private_chat_attempts (
  organization_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(organization_id,staff_id)
);
CREATE TABLE IF NOT EXISTS private_chat_rooms (
  organization_id TEXT NOT NULL, id TEXT NOT NULL,
  participant_low TEXT NOT NULL, participant_high TEXT NOT NULL,
  created_at INTEGER NOT NULL, CHECK(participant_low < participant_high),
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,participant_low,participant_high)
);
CREATE TABLE IF NOT EXISTS private_chat_messages (
  organization_id TEXT NOT NULL, room_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
  request_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  created_at INTEGER NOT NULL, PRIMARY KEY(organization_id,room_id,sequence),
  UNIQUE(organization_id,sender_id,request_id),
  FOREIGN KEY(organization_id,room_id) REFERENCES private_chat_rooms(organization_id,id)
);
CREATE TABLE IF NOT EXISTS private_chat_reads (
  organization_id TEXT NOT NULL, room_id TEXT NOT NULL, reader_id TEXT NOT NULL,
  message_sequence INTEGER NOT NULL CHECK(message_sequence>0), read_at INTEGER NOT NULL,
  PRIMARY KEY(organization_id,room_id,reader_id,message_sequence),
  FOREIGN KEY(organization_id,room_id) REFERENCES private_chat_rooms(organization_id,id)
);
CREATE TRIGGER IF NOT EXISTS private_chat_room_immutable BEFORE UPDATE ON private_chat_rooms
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_ROOM_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_message_member BEFORE INSERT ON private_chat_messages
WHEN NOT EXISTS(SELECT 1 FROM private_chat_rooms r WHERE r.organization_id=NEW.organization_id
  AND r.id=NEW.room_id AND NEW.sender_id IN(r.participant_low,r.participant_high))
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_PARTICIPANT_REQUIRED'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_message_immutable BEFORE UPDATE ON private_chat_messages
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_message_no_delete BEFORE DELETE ON private_chat_messages
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_read_member BEFORE INSERT ON private_chat_reads
WHEN NOT EXISTS(SELECT 1 FROM private_chat_rooms r JOIN private_chat_messages m
  ON m.organization_id=r.organization_id AND m.room_id=r.id
  WHERE r.organization_id=NEW.organization_id AND r.id=NEW.room_id
  AND NEW.reader_id IN(r.participant_low,r.participant_high) AND m.sequence=NEW.message_sequence)
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_READ_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_read_immutable BEFORE UPDATE ON private_chat_reads
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_READ_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS private_chat_read_no_delete BEFORE DELETE ON private_chat_reads
BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_READ_IMMUTABLE'); END;
